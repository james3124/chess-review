/**
 * pgn.mjs — PGN parsing (multi-game). Browser + Node safe (no fs).
 */

import { Chess } from 'chess.js';

/** Split a PGN file into raw per-game chunks. */
export function splitPgnGames(text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = null;

  const flush = () => {
    if (cur && (cur.headers.length || cur.moves.length)) chunks.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[[A-Za-z0-9_]+\s+.*\]$/.test(line)) {
      if (cur && cur.moves.length) flush(); // a new game starts
      if (!cur) cur = { headers: [], moves: [] };
      cur.headers.push(line);
    } else if (line) {
      if (!cur) cur = { headers: [], moves: [] };
      cur.moves.push(line);
    }
  }
  flush();
  return chunks;
}

export function parseHeaders(headerLines) {
  const h = {};
  for (const l of headerLines) {
    const m = l.match(/^\[(\w+)\s+"(.*)"\]$/);
    if (m) h[m[1]] = m[2];
  }
  return h;
}

/**
 * Parse one chunk into { headers, moves, fens }.
 * fens[k] is the position BEFORE move index k, so fens[moves.length] is the
 * final position of the game.
 */
export function parseGame(chunk) {
  const headers = parseHeaders(chunk.headers);
  const movetext = chunk.moves.join(' ')
    .replace(/\{[^}]*\}/g, ' ')      // brace comments
    .replace(/;[^\n]*/g, ' ')        // rest-of-line comments
    .replace(/\([^)]*\)/g, ' ')      // variations
    .replace(/\$\d+/g, ' ')          // NAGs
    .replace(/\d+\.(\.\.)?/g, ' ')   // move numbers
    .replace(/[!?]+/g, '')           // annotations
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ')
    .trim();

  if (!movetext) throw new Error('game has no moves');

  const chess = new Chess();
  try {
    // NB: loadPgn() throws on a bad move and returns void.
    chess.loadPgn(movetext, { strict: false });
  } catch (err) {
    throw new Error(`could not parse SAN: ${movetext.slice(0, 80)} (${err.message})`);
  }

  // Replay from the start (or the FEN tag) to capture a FEN before each move.
  const fresh = new Chess();
  if (headers.FEN) {
    try { fresh.load(headers.FEN, { sloppy: true }); } catch { /* startpos */ }
  }
  const history = chess.history({ verbose: true });
  const fens = [fresh.fen()];
  const moves = [];
  for (const h of history) {
    fresh.move({ from: h.from, to: h.to, promotion: h.promotion });
    moves.push({ san: h.san, uci: h.from + h.to + (h.promotion || ''), color: h.color });
    fens.push(fresh.fen());
  }
  return { headers, moves, fens };
}

export function parsePgn(text) {
  return splitPgnGames(text).map((chunk) => {
    try {
      return { ok: true, ...parseGame(chunk) };
    } catch (err) {
      return { ok: false, error: err.message, headers: parseHeaders(chunk.headers) };
    }
  });
}
