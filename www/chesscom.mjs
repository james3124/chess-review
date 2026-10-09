/**
 * chesscom.mjs — chess.com Public Data API client.
 *
 * Browser-neutral: imported by the WebView (www/) AND by the Node dev
 * server, exactly like classify.js / analyze.mjs.
 *
 * Endpoints used (public, no API key required):
 *   GET /pub/player/{username}
 *   GET /pub/player/{username}/stats
 *   GET /pub/player/{username}/games/archives      -> list of monthly URLs
 *   GET /pub/player/{username}/games/{YYYY}/{MM}   -> games, each with a full PGN
 *
 * IMPORTANT: api.chess.com sits behind Cloudflare, which challenges
 * non-browser User-Agents (a plain curl gets a "Just a moment..." page).
 * Browsers cannot set the User-Agent header, but they don't need to:
 * Chromium's default UA is what passes, so direct fetches from the WebView
 * work. The Node server passes an explicit browser UA via `opts.ua`.
 *
 * `opts.proxy` routes the same paths through our own server, which is used
 * as a fallback when a direct call is blocked, and to enable caching.
 */

import { parseGame } from './lib/pgn.mjs';

const API = 'https://api.chess.com/pub';

/** A desktop-class browser UA; only ever sent from Node (fetch in a browser
 *  refuses to let scripts set this header). */
export const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

async function getJson(path, opts = {}) {
  const headers = { Accept: 'application/json' };
  if (opts.ua) headers['User-Agent'] = opts.ua;

  const base = opts.proxy || API;
  let r;
  try {
    r = await fetch(base + path, { headers, redirect: 'follow' });
  } catch {
    throw Object.assign(new Error('network unreachable'), { offline: true });
  }

  if (r.status === 404) throw Object.assign(new Error('not found on chess.com'), { notFound: true });
  if (r.status === 403 || r.status === 429) {
    throw Object.assign(new Error(`chess.com is rate-limiting us (${r.status})`), { blocked: true });
  }
  if (!r.ok) throw Object.assign(new Error(`chess.com HTTP ${r.status}`), { blocked: true });

  const text = await r.text();
  // Cloudflare returns an HTML challenge with a 200 status.
  if (/just a moment|cf-challenge|challenge-platform|Enable JavaScript and cookies/i.test(text)) {
    throw Object.assign(new Error('chess.com is blocking this request'), { blocked: true });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('unexpected reply from chess.com'), { blocked: true });
  }
}

const MONTH_RE = /\/games\/(\d{4})\/(\d{2})$/;

/** Turn the archives payload into ['2026-10', ...], newest first. */
export function parseArchives(json) {
  return (json.archives || [])
    .map((u) => { const m = u.match(MONTH_RE); return m ? `${m[1]}-${m[2]}` : null; })
    .filter(Boolean)
    .sort()
    .reverse();
}

/**
 * Search a player: profile + the months they have games in.
 * @returns {Promise<{username:string, name:string, avatar:string, url:string,
 *                    country:string, joined:number, months:string[]}>}
 */
export async function searchPlayer(username, opts = {}) {
  const user = String(username || '').trim().replace(/^.*\//, ''); // tolerate pasted URLs
  if (!user || user.length < 2) throw Object.assign(new Error('enter a username'), { invalid: true });

  const [profile, archives] = await Promise.all([
    getJson(`/player/${encodeURIComponent(user)}`, opts),
    getJson(`/player/${encodeURIComponent(user)}/games/archives`, opts)
  ]);

  const months = parseArchives(archives);
  if (!months.length) {
    throw Object.assign(new Error(`no public games for "${profile.username || user}"`), { invalid: true });
  }

  return {
    username: profile.username || user,
    name: profile.name || profile.username || user,
    avatar: profile.avatar || '',
    url: profile.url || `https://www.chess.com/member/${user}`,
    country: (profile.country || '').replace(/^.*\//, ''),
    joined: profile.joined || 0,
    months
  };
}

/** All games in one month, normalised for the UI. */
export async function listGames(username, month, opts = {}) {
  const [yyyy, mm] = String(month).split('-');
  const json = await getJson(`/player/${encodeURIComponent(username)}/games/${yyyy}/${mm}`, opts);
  return (json.games || []).map(normalizeGame).reverse(); // newest first
}

/** chess.com's game object -> what the UI needs. */
export function normalizeGame(g) {
  const pgn = typeof g.pgn === 'string' ? g.pgn : '';
  return {
    uuid: g.uuid || g.url || Math.random().toString(36).slice(2),
    url: g.url || '',
    pgn,
    timeClass: g.time_class || '',
    timeControl: g.time_control || '',
    rated: !!g.rated,
    eco: g.eco || '',
    endTime: (g.end_time || 0) * 1000,
    white: { name: g.white?.username || '?', rating: g.white?.rating || null, result: g.white?.result || '' },
    black: { name: g.black?.username || '?', rating: g.black?.rating || null, result: g.black?.result || '' },
    acc: g.accuracies || null
  };
}

/** Split a PGN into the `{headers, moves}` shape our parser expects. */
export function pgnToChunk(pgn) {
  const headers = [], moves = [];
  for (const raw of String(pgn).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[[^\]]+\]$/.test(line)) headers.push(line);
    else moves.push(line);
  }
  return { headers, moves };
}

/**
 * A chess.com game -> the same `{headers, moves, fens, ok}` shape the PGN
 * pipeline produces, so the existing analysis UI can consume it directly.
 */
export function toParsedGame(game) {
  try {
    return { ok: true, ...parseGame(pgnToChunk(game.pgn)) };
  } catch (err) {
    return { ok: false, error: err.message, headers: {} };
  }
}

/* ------------------------- display helpers ------------------------- */

const TC_LABEL = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', daily: 'Daily' };

export function timeClassLabel(tc) { return TC_LABEL[tc] || (tc || 'Chess'); }

/**
 * chess.com returns `eco` as a URL like
 *   https://www.chess.com/openings/Modern-Defense-Three-Pawns-Attack-3...d6-4.Nf3-Nf6-5.Nc3
 * Show just the opening name: "Modern Defense Three Pawns Attack".
 */
export function ecoLabel(eco) {
  if (!eco) return '';
  if (!eco.startsWith('http')) return eco;
  const tail = eco.split('/openings/')[1] || eco.split('/').pop() || '';
  const words = [];
  for (const part of tail.split('-')) {
    if (/^\d/.test(part)) break; // stop at the trailing move sequence
    if (!part) continue;
    words.push(part);
  }
  return words.join(' ') || tail;
}

export function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

export function gameTitle(g) {
  const w = g.white.rating ? `${g.white.name} (${g.white.rating})` : g.white.name;
  const b = g.black.rating ? `${g.black.name} (${g.black.rating})` : g.black.name;
  return `${w} vs ${b}`;
}

export function gameResult(g) {
  if (g.white.result === 'win') return '1-0';
  if (g.black.result === 'win') return '0-1';
  const s = g.white.result || '';
  if (/agreed|repetition|insufficient|50move|stalemate|timevsinsufficient/.test(s)) return '½-½';
  return s || '*';
}
