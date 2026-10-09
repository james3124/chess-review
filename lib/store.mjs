/**
 * store.mjs — persist finished analyses as JSON under data/.
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

/** Sanitised, unique id for a game: site-round-white-result + short hash. */
function makeId(headers) {
  const base = [headers.Date, headers.White, headers.Black].join(' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let h = 0;
  const s = JSON.stringify(headers) + (headers.Round || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${base || 'game'}-${(h >>> 0).toString(36).slice(0, 6)}`;
}

export async function saveGame(record) {
  if (!existsSync(DATA)) await mkdir(DATA, { recursive: true });
  const id = makeId(record.headers) + '-' + Date.now().toString(36);
  await writeFile(join(DATA, `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}

export async function listGames() {
  if (!existsSync(DATA)) return [];
  const files = (await readdir(DATA)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files.sort().reverse()) {
    try {
      const rec = JSON.parse(await readFile(join(DATA, f), 'utf8'));
      out.push({
        id: rec.id,
        white: rec.headers?.White || 'White',
        black: rec.headers?.Black || 'Black',
        event: rec.headers?.Event || '',
        date: rec.headers?.Date || '',
        result: rec.headers?.Result || '*',
        accuracy: rec.summary
      });
    } catch { /* skip corrupt files */ }
  }
  return out;
}

export async function loadGame(id) {
  const p = join(DATA, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8'));
}

export const paths = { DATA, ROOT };
