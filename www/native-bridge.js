/* native-bridge.js — one engine API, two transports:
 *   native  -> the Kotlin EnginePlugin (inside the Android app)
 *   http    -> the Node dev server, which runs Stockfish for the browser
 *
 * The page may be served from anywhere (npm start on :3000, a static
 * preview on a random port, file://), so instead of assuming where the
 * analysis server lives we probe candidates and remember what worked.
 */

const PLUGIN = 'EnginePlugin';

function findPlugin() {
  const w = window;
  const direct =
    w.Capacitor?.Plugins?.[PLUGIN] ||
    w.CapacitorPlugins?.[PLUGIN] ||
    w.capacitor?.Plugins?.[PLUGIN] ||
    w[PLUGIN];
  if (direct) return direct;
  try {
    const reg = w.Capacitor?.registerPlugin;
    if (reg) { const p = reg(PLUGIN); if (p) return p; }
  } catch { /* runtime not loaded */ }
  return null;
}

const plugin = findPlugin();
const native = !!plugin;

/* ------------------------------------------------------------------ */
/* where is the analysis server?                                       */
/* ------------------------------------------------------------------ */
const LS_KEY = 'chessreview-engine-base';

export function storedBase() {
  try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
}

export function setEngineBase(url) {
  const v = String(url || '').trim().replace(/\/+$/, '');
  try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
}

/** Ordered candidates for the Node server's address. */
export function engineBaseCandidates() {
  const out = [];
  const manual = storedBase();
  if (manual) out.push(manual);
  // Served by our own Node server (any port) — same origin is right then.
  if (location.protocol.startsWith('http') && location.origin !== 'null') out.push(location.origin);
  out.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8080');
  return [...new Set(out)];
}

/** Normalise the Kotlin plugin's payload into the Node engine's shape. */
function fromNative(r) {
  const lines = {};
  for (const l of r.lines || []) lines[l.multipv || 1] = {
    scoreCp: l.scoreCp ?? null,
    scoreMate: l.scoreMate ?? null,
    pv: l.pv || [],
    nodes: l.nodes ?? 0
  };
  return { bestMove: r.best || r.bestMove, ponder: r.ponder || null, lines };
}

/* ------------------------------------------------------------------ */
/* engine                                                              */
/* ------------------------------------------------------------------ */

let activeBase = null; // the candidate that answered

/** Poll one base until the server's engine is ready.
 *  Throws `offline` if that address isn't our API server at all, so the
 *  caller moves on to the next candidate. This matters because a static
 *  preview server (e.g. an editor's live preview) answers `/api/engine`
 *  with a 404 HTML page rather than refusing the connection. */
async function pollBase(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let r;
    try {
      r = await fetch(`${base}/api/engine`);
    } catch {
      throw Object.assign(new Error('unreachable'), { offline: true });
    }
    // Not our server (a static file host answers unknown paths with 404).
    if (r.status === 404 || r.status === 405) {
      throw Object.assign(new Error('no api here'), { offline: true });
    }
    const type = r.headers.get('content-type') || '';
    if (!type.includes('json')) {
      throw Object.assign(new Error('not json'), { offline: true });
    }
    last = await r.json().catch(() => null);
    if (last && (last.state === 'ready' || last.state === 'failed')) return { ...last, base };
    // The server is ours but still loading: kick the lazy engine start.
    if (last && last.state !== 'ready') {
      fetch(`${base}/api/engine/warm`, { method: 'POST' }).catch(() => {});
    }
    await new Promise((res) => setTimeout(res, 700));
  }
  throw Object.assign(new Error(`engine still starting after ${Math.round(timeoutMs / 1000)}s (${base})`), { slow: true });
}

export const engine = {
  mode: native ? 'native' : 'http',
  base: () => activeBase || engineBaseCandidates()[0],

  async info() {
    if (native) return { state: 'ready', ...(await plugin.engineInfo()) };
    const r = await fetch(`${engine.base()}/api/engine`);
    return r.json();
  },

  /**
   * Resolves once the engine can really search.
   * Native: engineInfo() blocks until the plugin's own health check passes.
   * HTTP: probe each candidate server until one answers.
   */
  async waitReady(timeoutMs = 120000) {
    if (native) return { state: 'ready', ...(await plugin.engineInfo()) };

    const bases = engineBaseCandidates();
    const tried = [];
    for (const base of bases) {
      tried.push(base);
      try {
        const info = await pollBase(base, timeoutMs);
        activeBase = base;            // remember the working one
        return info;
      } catch (err) {
        if (err.offline) continue;    // nothing here — try the next candidate
        throw err;                    // reachable but failed/timed out: report it
      }
    }
    throw new Error(
      `can't reach the analysis server (tried ${tried.join(', ')}). ` +
      `Run "npm start" in the project folder, or tap the engine bar to set its address.`
    );
  },

  /** @returns {Promise<{bestMove:string, ponder:string, lines:object}>} */
  async analyze(fen, o = {}) {
    if (native) {
      // Capacitor plugin methods take ONE data object: the first argument IS
      // the call payload, so passing fen separately would put a bare string
      // in the payload and call.getString("fen") would come back null.
      return fromNative(await plugin.analyzePosition({
        fen,
        depth: o.depth || 0,
        movetime: o.movetime || 0
      }));
    }
    const base = activeBase || engine.base();
    let lastErr = '';
    let rediscovered = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const r = await fetch(`${base}/api/eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, depth: o.depth, movetime: o.movetime })
      });
      if (r.ok) return r.json();

      // A 404/HTML reply means the chosen address is not our server.
      if (r.status === 404 || r.status === 405 || !(r.headers.get('content-type') || '').includes('json')) {
        if (rediscovered) break;
        rediscovered = true;
        activeBase = null;
        await engine.waitReady().catch(() => {});   // re-probe the candidates
        return engine.analyze(fen, o);              // retry against the real server
      }
      // 503 = the server is still loading Stockfish's NNUE network: wait.
      if (r.status !== 503) throw new Error(`engine HTTP ${r.status}`);
      lastErr = await r.text();
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new Error('engine never became ready: ' + lastErr.slice(0, 80));
  }
};
