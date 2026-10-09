/* scripts/build-web.mjs — copy chess.js into www/vendor for the browser bundle */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(ROOT, 'node_modules/chess.js/dist/esm/chess.js');
const destDir = join(ROOT, 'www/vendor');
const dest = join(destDir, 'chess.js');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
const { size } = await stat(dest);
console.log(`vendored chess.js -> www/vendor/chess.js (${(size / 1024).toFixed(1)} kB)`);
