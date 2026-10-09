/* native-bridge.js — one engine API, two transports:
 *   native  -> the Kotlin EnginePlugin (inside the Android app)
 *   http    -> the Node dev server (browsers, `npm start`)
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

  // @capacitor/core's runtime: registerPlugin() builds a proxy that forwards
  // to the native implementation.
  try {
    const reg = w.Capacitor?.registerPlugin;
    if (reg) {
      const p = reg(PLUGIN);
      if (p) return p;
    }
  } catch { /* runtime not loaded */ }
  return null;
}

const plugin = findPlugin();
const native = !!plugin;

/* Port 3000 is the dev server; anything else means the page is being served
 * by Capacitor (https://localhost) where there is no server. */
const API_BASE = location.port === '3000'
  ? location.origin
  : 'http://localhost:3000';

export const bridgeMode = native ? 'native' : 'http';

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

export const engine = {
  mode: bridgeMode,

  async info() {
    if (native) {
      const info = await plugin.engineInfo();
      return { state: 'ready', ...info };
    }
    const r = await fetch(`${API_BASE}/api/engine`);
    return r.json();
  },

  /**
   * Only resolves once the engine can really search.
   * HTTP: /api/engine replies instantly with state "starting" (the server
   * boots Stockfish in the background), so we poll. Native: engineInfo()
   * blocks until the plugin's own health check passes.
   */
  async waitReady(timeoutMs = 120000) {
    if (native) return plugin.engineInfo();
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const r = await fetch(`${API_BASE}/api/engine`);
      last = await r.json();
      if (last.state === 'ready' || last.state === 'failed') return last;
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new Error('engine still starting after ' + Math.round(timeoutMs / 1000) + 's');
  },

  /** @returns {Promise<{bestMove:string, ponder:string, lines:object}>} */
  async analyze(fen, o = {}) {
    if (native) {
      return fromNative(await plugin.analyzePosition(fen, {
        depth: o.depth || 0,
        movetime: o.movetime || 0
      }));
    }
    let lastErr = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = await fetch(`${API_BASE}/api/eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen, depth: o.depth, movetime: o.movetime })
      });
      if (r.ok) return r.json();
      // 503 = the server is still loading Stockfish's NNUE network: wait for it.
      if (r.status !== 503) throw new Error(`engine HTTP ${r.status}`);
      lastErr = await r.text();
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new Error('engine never became ready: ' + lastErr.slice(0, 80));
  }
};
