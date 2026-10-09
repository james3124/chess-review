/* test/debug-engine.mjs — trace raw UCI traffic with timestamps. */
import { spawn } from 'node:child_process';

const BIN = './stockfish/stockfish-android-arm64-universal';
const p = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
p.stdout.setEncoding('utf8');
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    console.log(`[+${((Date.now() - T) / 1000).toFixed(1)}s] << ${l.slice(0, 100)}`);
  }
});
const T = Date.now();
const send = (c) => console.log(`[+${((Date.now() - T) / 1000).toFixed(1)}s] >> ${c}`) || p.stdin.write(c + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send('uci');
await wait(2000);
send('setoption name Threads value 2');
send('setoption name Hash value 128');
send('setoption name MultiPV value 2');
await wait(500);
send('ucinewgame');
await wait(500);
send('position startpos');
await wait(3000);
send('isready');
await wait(1000);
send('go depth 2');
await wait(6000);
console.log('--- done, killing ---');
p.kill('SIGKILL');
