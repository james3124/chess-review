/**
 * engine.mjs — UCI bridge to the bundled Stockfish binary.
 *
 * IMPORTANT (learned the hard way):
 * The Android "universal" builds lazily load their ~109MiB embedded NNUE
 * network asynchronously, AFTER `isready` has already replied. If a `go`
 * command is processed while that load is in flight, the engine returns a
 * fake search:
 *
 *     info depth 1 seldepth 0 multipv 1 score cp 0 nodes 0 ... pv
 *     bestmove a2a3
 *
 * So we do NOT trust `isready`. Instead we (a) wait for the
 * "NNUE evaluation using" banner, and (b) run a dummy `go depth 1` and
 * verify it actually produced nodes + a PV. If it did not, we back off and
 * retry — both at startup and after any suspiciously empty search.
 */

import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a single UCI `info` line into an object. */
export function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  const t = line.split(/\s+/);
  const o = { raw: line };
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'pv') { o.pv = t.slice(i + 1).filter(Boolean); break; }
    if (k === 'score') {
      const v = t[i + 1];
      if (v === 'cp') o.scoreCp = parseInt(t[i + 2], 10);
      else if (v === 'mate') o.scoreMate = parseInt(t[i + 2], 10);
      i += 2;
      continue;
    }
    const v = t[i + 1];
    if (v === undefined) continue;
    o[k] = /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
    i += 1;
  }
  return o;
}

export class UCIEngine {
  /**
   * @param {object} opts
   * @param {string} opts.binary  absolute path to the Stockfish executable
   * @param {number} [opts.threads]
   * @param {number} [opts.hash]  MiB
   * @param {number} [opts.multiPv]
   */
  constructor({ binary, threads = 1, hash = 128, multiPv = 2 }) {
    this.binary = binary;
    this.threads = threads;
    this.hash = hash;
    this.multiPv = multiPv;
    this.proc = null;
    this.healthy = false;
    this.ready = false;
    this.version = null;
    this._log = [];
    this._waiters = [];
    this._collector = null;
  }

  /* ---------------- process plumbing ---------------- */

  _dispatch(line) {
    this._log.push(line);
    if (this._log.length > 500) this._log.splice(0, this._log.length - 500);

    if (this._collector) this._collector.lines.push(line);
    if (line.startsWith('bestmove') && this._collector) {
      const c = this._collector;
      this._collector = null;
      c.resolve(line);
    }

    for (let i = this._waiters.length - 1; i >= 0; i--) {
      const w = this._waiters[i];
      if (w.pred(line)) {
        this._waiters.splice(i, 1);
        if (w.timer) clearTimeout(w.timer);
        w.resolve(line);
      }
    }
  }

  _send(cmd) {
    if (!this.proc || this.proc.exitCode !== null) throw new Error('engine is not running');
    this.proc.stdin.write(cmd + '\n');
  }

  _waitFor(pred, timeoutMs, what = 'condition') {
    for (const line of this._log) if (pred(line)) return Promise.resolve(line);
    if (this.proc && this.proc.exitCode !== null) {
      return Promise.reject(new Error(`engine exited (code ${this.proc.exitCode}) before ${what}`));
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${what}`));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  /* ---------------- lifecycle ---------------- */

  async start() {
    if (this.ready) return;
    this.proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.setEncoding('utf8');
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        this._dispatch(buf.slice(0, nl).replace(/\r$/, '').trim());
        buf = buf.slice(nl + 1);
      }
    });
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.healthy = false;
      for (const w of this._waiters) w.reject(new Error(`engine exited (code ${code})`));
      this._waiters = [];
      if (this._collector) { this._collector.resolve('bestmove (none)'); this._collector = null; }
    });

    this._send('uci');
    await this._waitFor((l) => l === 'uciok', 30000, 'uciok');
    const idLine = this._log.find((l) => l.startsWith('id name '));
    this.version = idLine ? idLine.slice('id name '.length).trim() : 'Stockfish';

    this._send(`setoption name Threads value ${this.threads}`);
    this._send(`setoption name Hash value ${this.hash}`);
    this._send(`setoption name MultiPV value ${this.multiPv}`);
    this._send('ucinewgame');
    this._send('position startpos');

    // The NNUE banner is only emitted by the first `go` (the ~109MiB
    // embedded net is loaded lazily, not gated by `isready`), so we cannot
    // wait for it here. Instead run a throwaway search and inspect the
    // result: a fake search (0 nodes / empty PV) means the net is still
    // loading, and we simply retry until it is real.
    await this._ensureHealthy();
    this.ready = true;
  }

  /** Run a throwaway search and confirm nodes/pv are real. Retries with backoff. */
  async _ensureHealthy(maxAttempts = 60) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.proc || this.proc.exitCode !== null) throw new Error('engine died during init');
      // A fake search returns instantly; the very first real `go` also pays
      // for the 109MiB NNUE load, so allow a generous per-attempt budget.
      const r = await this._raw('position startpos', 'go depth 2', 60000);
      const line = r.lines['1'] || r.lines[1];
      const nodes = line?.nodes ?? 0;
      const pv = line?.pv || [];
      if (nodes > 5 && pv.length > 0) { this.healthy = true; return true; }
      await sleep(600);
    }
    throw new Error('engine never produced a real search (NNUE load stuck?)');
  }

  async _raw(positionCmd, goCmd, timeoutMs = 120000) {
    const collector = { lines: [], resolve: null };
    this._collector = collector;
    this._send(positionCmd);
    this._send(goCmd);
    const bestmove = await Promise.race([
      new Promise((res) => { collector.resolve = res; }),
      sleep(timeoutMs).then(() => 'bestmove (timeout)')
    ]);
    const parsed = [];
    const best = {};
    for (const l of collector.lines) {
      const o = parseInfoLine(l);
      if (!o) continue;
      parsed.push(o);
      if (o.pv && o.pv.length) best[o.multipv || 1] = o;
    }
    const bm = bestmove.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
    return {
      bestMove: bm ? bm[1] : null,
      ponder: bm && bm[2] ? bm[2] : null,
      lines: best,
      info: parsed,
      rawBestmove: bestmove
    };
  }

  /**
   * Analyse a position.
   * @param {string} fen
   * @param {object} [o]
   * @param {number} [o.depth]
   * @param {number} [o.movetime] ms — used when depth is omitted
   * @returns {Promise<{bestMove:string,ponder:string,lines:object}>}
   */
  async analyze(fen, o = {}) {
    if (!this.ready) throw new Error('engine not started');
    const go = o.depth ? `go depth ${o.depth}` : `go movetime ${o.movetime ?? 300}`;
    let r = await this._raw(`position fen ${fen}`, go);

    // Guard against the failed-search signature (0 nodes / empty PV).
    let guard = 0;
    while (this._looksBroken(r) && guard < 3) {
      guard += 1;
      this.healthy = false;
      await sleep(700);
      try { await this._ensureHealthy(); } catch { /* keep trying the move */ }
      r = await this._raw(`position fen ${fen}`, go);
    }
    if (this._looksBroken(r)) throw new Error(`analysis failed for ${fen}`);
    return r;
  }

  _looksBroken(r) {
    // `bestmove (none)` means checkmate/stalemate: there is nothing to search,
    // so an empty result is correct, not broken.
    if (r.bestMove === '(none)') return false;
    const l1 = r.lines['1'] || r.lines[1];
    if (!l1) return true;
    const nodes = l1.nodes ?? 0;
    const pv = l1.pv || [];
    return !(nodes > 5 && pv.length > 0);
  }

  async stop() {
    try { this._send('quit'); } catch { /* already gone */ }
    await sleep(150);
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL');
    this.ready = false;
  }
}
