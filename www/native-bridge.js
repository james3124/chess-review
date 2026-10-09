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

  /** @returns {Promise<{bestMove:string, ponder:string, lines:object}>} */
  async analyze(fen, o = {}) {
    if (native) {
      return fromNative(await plugin.analyzePosition(fen, {
        depth: o.depth || 0,
        movetime: o.movetime || 0
      }));
    }
    const r = await fetch(`${API_BASE}/api/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, depth: o.depth, movetime: o.movetime })
    });
    if (!r.ok) throw new Error(`engine HTTP ${r.status}`);
    return r.json();
  }
};
