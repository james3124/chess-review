/* test/run-sample.mjs — end-to-end analysis of test/sample.pgn */
import { readFile } from 'node:fs/promises';
import { UCIEngine } from '../lib/engine.mjs';
import { parsePgn } from '../www/lib/pgn.mjs';
import { analyzeGame } from '../www/lib/analyze.mjs';

const depth = Number(process.env.DEPTH || 12);
const threads = Number(process.env.THREADS || 1);
const engine = new UCIEngine({ binary: './stockfish/stockfish-android-arm64-universal', threads, hash: 128 });

console.log('starting engine (loads 109MiB NNUE, please wait)...');
await engine.start();
console.log('engine healthy\n');

const text = await readFile(new URL('./sample.pgn', import.meta.url), 'utf8');
const games = parsePgn(text);
console.log(`parsed ${games.length} game(s)`);

for (const g of games) {
  if (!g.ok) { console.log('  parse error:', g.error); continue; }
  console.log(`\n=== ${g.headers.White} vs ${g.headers.Black} (${g.headers.Result}) ===`);
  const t = Date.now();
  const rec = await analyzeGame(engine, g, { depth, onProgress: (p) => {
    if (p.phase === 'move' && p.ply % 5 === 0) process.stdout.write(`  ...${p.ply}/${p.total}\n`);
  }});
  console.log(`analyzed ${rec.moves.length} moves at depth ${depth} in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  let row = '';
  for (const m of rec.moves) {
    row += `${m.san}${m.mover === 'b' ? '=' : '.'}${m.label[0].toUpperCase()}(${(m.loss * 100).toFixed(0)}%) `;
  }
  console.log('\n' + row + '\n');
  for (const side of ['white', 'black']) {
    const s = rec.summary[side];
    console.log(`${side}: acc=${s.accuracy}% labels=${JSON.stringify(s.labels)}`);
  }
}

await engine.stop();
