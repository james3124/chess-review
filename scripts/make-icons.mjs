/* scripts/make-icons.mjs — generate the PWA icon PNG (no image deps).
 * Produces a chess.com-style 2x2 checkerboard icon. */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---- minimal PNG writer (RGBA8, no interlace) ---- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- icon pixels: 2x2 checkerboard, rounded corners ---- */
const SIZE = 512;
const LIGHT = [235, 236, 208];  // #ebecd0
const GREEN = [129, 182, 76];   // #81b64c
const DARK = [48, 46, 43];      // #302e2b (background)
const R = 110;                  // corner radius

const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;

    // rounded-square mask
    const dx = Math.max(R - x, x - (SIZE - R), 0);
    const dy = Math.max(R - y, y - (SIZE - R), 0);
    const inSquare = (dx * dx + dy * dy) <= R * R;
    if (!inSquare) { px.set(DARK, i); px[i + 3] = 255; continue; }

    // 2x2 checkerboard
    const c = ((Math.floor(x / (SIZE / 2)) + Math.floor(y / (SIZE / 2))) % 2 === 0) ? LIGHT : GREEN;
    px.set(c, i);
    px[i + 3] = 255;
  }
}

writeFileSync(join(ROOT, 'www/icon-512.png'), encodePng(SIZE, SIZE, px));
console.log(`wrote www/icon-512.png (${SIZE}x${SIZE})`);
