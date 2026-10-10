/**
 * test/native-bridge-shape.mjs
 *
 * Regression test for an APK-only bug that could not be caught locally:
 * Capacitor plugin methods take ONE data object as their argument, but the
 * native path used to call  plugin.analyzePosition(fen, {depth, movetime}).
 * The call payload then became the bare string `fen`, so
 * call.getString("fen") on the Kotlin side came back null and the plugin
 * rejected with "missing fen" — visible in the app as
 * "Analysis failed: missing fen", and only in the APK.
 *
 * This stubs the Capacitor bridge and asserts the payload shape.
 */
import assert from 'node:assert/strict';

let payload = null;          // what the plugin last received
const calls = { engineInfo: 0 };

globalThis.location = { protocol: 'https:', origin: 'https://localhost' };
globalThis.window = {
  Capacitor: {
    isNativePlatform: () => true,
    Plugins: {
      EnginePlugin: {
        engineInfo: async () => {
          calls.engineInfo += 1;
          return { state: 'ready', version: 'Stockfish 19', threads: 1, hash: 128, binaryPresent: true };
        },
        analyzePosition: async (data) => {
          payload = data;
          return {
            best: 'g1f3', ponder: 'g8f6',
            lines: [
              { multipv: 1, scoreCp: 37, pv: ['g1f3', 'g8f6', 'b1c3'], nodes: 100 },
              { multipv: 2, scoreCp: 21, pv: ['d2d4'], nodes: 100 }
            ]
          };
        }
      }
    }
  }
};

const { engine } = await import('../www/native-bridge.js');

assert.equal(engine.mode, 'native', 'must pick the native transport');

const info = await engine.waitReady();
assert.equal(info.version, 'Stockfish 19', 'engineInfo should reach the plugin');
assert.equal(calls.engineInfo, 1, 'engineInfo called once');

const FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const res = await engine.analyze(FEN, { depth: 14 });

// The payload the Kotlin side reads.
assert.ok(payload, 'plugin received a payload');
assert.equal(payload.fen, FEN, 'payload must carry the FEN');
assert.equal(payload.depth, 14, 'payload must carry the depth');
assert.ok('movetime' in payload, 'payload must carry movetime');

// The normalised result the UI consumes.
assert.equal(res.bestMove, 'g1f3');
assert.equal(res.ponder, 'g8f6');
assert.equal(res.lines[1].scoreCp, 37);
assert.deepEqual(res.lines[1].pv, ['g1f3', 'g8f6', 'b1c3']);
assert.equal(res.lines[2].scoreCp, 21, 'MultiPV line 2 survives');

console.log('native bridge payload shape: OK');
console.log('  fen     :', payload.fen);
console.log('  depth   :', payload.depth);
console.log('  movetime:', payload.movetime);
console.log('  result  :', res.bestMove, JSON.stringify(res.lines[1].pv));
