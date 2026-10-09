/**
 * server.mjs — dev server: serves the web UI + runs the analysis API.
 *
 * NOTE: inside the Android APK this file is NOT used — the UI talks to the
 * native `EnginePlugin` (Kotlin) instead. This server exists for local
 * development and testing the whole pipeline on a machine.
 */

import express from 'express';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UCIEngine } from './lib/engine.mjs';
import { parsePgn } from './www/lib/pgn.mjs';
import { analyzeGame } from './www/lib/analyze.mjs';
import * as store from './lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 3000);

// Tuned for phones: the 109MiB NNUE net already dominates memory.
const ENGINE_BIN = process.env.ENGINE_BIN || join(ROOT, 'stockfish/stockfish-android-arm64-universal');
const DEFAULT_DEPTH = Number(process.env.DEPTH || 14);
const THREADS = Number(process.env.THREADS || 1);
const HASH = Number(process.env.HASH || 128);

// Tuned for phones: the 109MiB NNUE net already dominates memory.
const engine = new UCIEngine({ binary: ENGINE_BIN, threads: THREADS, hash: HASH, multiPv: 2 });
let engineState = 'idle';          // idle -> starting -> ready | failed
let engineError = null;
let engineStartPromise = null;

/** Starts Stockfish on demand. Opening the app must NOT load the 109MiB
 *  NNUE network when there is no game to analyse yet. */
function ensureEngine() {
  if (engineStartPromise) return engineStartPromise;
  if (engineState === 'ready') return Promise.resolve();
  engineState = 'starting';
  engineStartPromise = engine.start()
    .then(() => { engineState = 'ready'; })
    .catch((err) => {
      engineState = 'failed';
      engineError = err.message;
      engineStartPromise = null; // allow a retry
    });
  return engineStartPromise;
}

const jobs = new Map();

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(join(ROOT, 'www')));

/* ------------------------------------------------------------------ */
/* engine lifecycle                                                    */
/* ------------------------------------------------------------------ */
/** Reports the current state WITHOUT starting the engine (the UI polls this). */
app.get('/api/engine', (req, res) => {
  res.json({
    state: engineState,
    error: engineError,
    version: engine.version || null,
    depth: DEFAULT_DEPTH,
    threads: THREADS,
    hash: HASH,
    binary: ENGINE_BIN,
    engineOk: existsSync(ENGINE_BIN)
  });
});

/**
 * Single-position evaluation. The web UI drives its own analysis loop through
 * this endpoint so it can share the exact code path with the Android app
 * (www/lib/analyze.mjs runs in the WebView there).
 */
app.post('/api/eval', async (req, res) => {
  ensureEngine(); // lazily boots Stockfish on the first request
  if (engineState !== 'ready') return res.status(503).json({ error: `engine not ready (${engineState})` });
  const { fen, depth, movetime } = req.body || {};
  if (!fen) return res.status(400).json({ error: 'missing fen' });
  try {
    res.json(await engine.analyze(fen, { depth, movetime }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Kicks off the lazy engine load (the UI calls this when a game is loaded). */
app.post('/api/engine/warm', (req, res) => {
  ensureEngine();
  res.json({ state: engineState });
});

/* ------------------------------------------------------------------ */
/* chess.com public API proxy (browser UA + cache)                      */
/*                                                                      */
/* A pass-through: the client (www/chesscom.mjs) fetches the same       */
/* paths here that it would fetch from api.chess.com, so only the base  */
/* URL changes. That keeps the raw chess.com JSON shapes intact and the */
/* two transports interchangeable. We add a browser User-Agent (which   */
/* Cloudflare requires and browsers cannot set themselves) and cache.   */
/* ------------------------------------------------------------------ */
import { BROWSER_UA } from './www/chesscom.mjs';

const CC_API = 'https://api.chess.com/pub';
const CC_CACHE_DIR = join(ROOT, 'data/chesscom');

function ccTtlFor(path) {
  if (path.includes('/archives')) return 5 * 60_000;
  if (/\/games\/\d{4}\/\d{2}$/.test(path)) return 30 * 60_000; // a month
  return 30 * 60_000;                                          // player / stats
}

app.get('/api/chesscom/*', async (req, res) => {
  const path = '/' + req.params[0]; // e.g. /player/erik/games/2026/10
  if (!path.startsWith('/player/')) {
    return res.status(404).json({ error: 'unsupported chess.com path' });
  }

  try {
    if (!existsSync(CC_CACHE_DIR)) await mkdir(CC_CACHE_DIR, { recursive: true });
    const file = join(CC_CACHE_DIR, path.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '.json');
    const ttl = ccTtlFor(path);

    if (existsSync(file)) {
      try {
        const hit = JSON.parse(await readFile(file, 'utf8'));
        if (Date.now() - hit.at < ttl) return res.json(hit.data);
      } catch { /* stale/corrupt: refetch */ }
    }

    const upstream = await fetch(CC_API + path, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      redirect: 'follow'
    });
    const body = await upstream.text();

    // Cloudflare answers with an HTML challenge and a 200.
    if (/just a moment|cf-challenge|challenge-platform/i.test(body)) {
      return res.status(502).json({ error: 'chess.com is blocking this request' });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `chess.com HTTP ${upstream.status}` });
    }

    const data = JSON.parse(body);
    await writeFile(file, JSON.stringify({ at: Date.now(), data })).catch(() => {});
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || 'chess.com fetch failed' });
  }
});

/* ------------------------------------------------------------------ */
/* analysis jobs                                                       */
/* ------------------------------------------------------------------ */
app.post('/api/analyze', async (req, res) => {
  ensureEngine(); // lazily boots Stockfish on the first request
  if (engineState !== 'ready') {
    return res.status(503).json({ error: `engine not ready (${engineState})` });
  }
  const { pgn = '', depth } = req.body || {};
  if (!pgn.trim()) return res.status(400).json({ error: 'empty PGN' });

  const parsed = parsePgn(pgn);
  const idx = Number(req.body.gameIndex || 0);
  const game = parsed[idx];
  if (!game) return res.status(400).json({ error: 'no games found in PGN' });
  if (!game.ok) return res.status(400).json({ error: 'PGN parse error: ' + game.error });

  const id = 'j' + Math.random().toString(36).slice(2, 10);
  const emitter = new EventEmitter();
  jobs.set(id, { emitter, state: 'running', progress: { ply: 0, total: game.fens.length } });

  (async () => {
    try {
      emitter.emit('progress', { phase: 'start', total: game.fens.length });
      const result = await analyzeGame(engine, game, {
        depth: depth || DEFAULT_DEPTH,
        onProgress: (p) => { emitter.emit('progress', p); }
      });
      result.id = id;
      const savedId = await store.saveGame(result);
      jobs.get(id).state = 'done';
      jobs.get(id).result = { id: savedId };
      emitter.emit('done', { id: savedId });
    } catch (err) {
      jobs.get(id).state = 'error';
      jobs.get(id).error = err.message;
      emitter.emit('failed', { error: err.message });
    }
  })();

  res.json({ jobId: id, games: parsed.length, game: parsed.indexOf(game) });
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write(': ok\n\n');

  const onProgress = (p) => send('progress', p);
  const onDone = (d) => { send('done', d); res.end(); };
  const onFail = (e) => { send('failed', e); res.end(); };

  job.emitter.on('progress', onProgress);
  job.emitter.once('done', onDone);
  job.emitter.once('failed', onFail);

  if (job.state === 'done') { send('done', job.result); res.end(); return; }
  if (job.state === 'error') { send('failed', { error: job.error }); res.end(); return; }

  req.on('close', () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('failed', onFail);
  });
});

/* ------------------------------------------------------------------ */
/* stored games                                                        */
/* ------------------------------------------------------------------ */
app.get('/api/games', async (req, res) => {
  res.json(await store.listGames());
});

app.get('/api/games/:id', async (req, res) => {
  const rec = await store.loadGame(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(rec);
});

app.listen(PORT, () => {
  console.log(`chess-review listening on http://localhost:${PORT}`);
  console.log(`engine binary: ${ENGINE_BIN} (${existsSync(ENGINE_BIN) ? 'found' : 'MISSING'})`);
});
