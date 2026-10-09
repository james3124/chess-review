/**
 * analyze.mjs — run a parsed game through an engine bridge and classify
 * every move. Browser + Node safe.
 *
 * `engine` is anything exposing `analyze(fen, {depth|movetime})` and
 * returning { bestMove, lines: { 1: {scoreCp, scoreMate, pv, nodes} } }.
 * Both lib/engine.mjs (Node) and the Kotlin EnginePlugin (Android) do this.
 *
 * Efficiency note: each POSITION is evaluated once, not each move twice.
 * fens[k-1] is the "before" and fens[k] the "after" of move k.
 */

import { Chess } from '../vendor/chess.js';
import { classifyMove, summarise, MATE_CP } from './classify.js';

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material (pawns) held by `side` in a FEN. */
export function materialOf(fen, side) {
  let total = 0;
  for (const row of fen.split(' ')[0].split('/')) {
    for (const ch of row) {
      if (!/[pnbrqk]/i.test(ch)) continue;
      const isWhite = ch === ch.toUpperCase();
      if ((side === 'w') !== isWhite) continue;
      total += VALUE[ch.toLowerCase()] || 0;
    }
  }
  return total;
}

/** Change in the mover's material (pawns); negative = material given up. */
function materialDeltaFor(fenBefore, fenAfter, mover) {
  return materialOf(fenAfter, mover) - materialOf(fenBefore, mover);
}

function scoreToObj(l) {
  return { cp: l && l.scoreCp != null ? l.scoreCp : 0, mate: l && l.scoreMate != null ? l.scoreMate : null };
}

/** Convert a UCI move to SAN (readable "best move" hints). */
export function uciToSan(fen, uci) {
  try {
    const c = new Chess();
    c.load(fen, { sloppy: true });
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }, { sloppy: true });
    return m ? m.san : uci;
  } catch {
    return uci;
  }
}

/**
 * If a position is already decided (checkmate / stalemate / draw) there is
 * nothing to search: report the terminal score directly.
 * @returns {{lines:object,bestMove:string}|null}
 */
function terminalResult(fen) {
  let c;
  try {
    c = new Chess();
    c.load(fen, { sloppy: true });
  } catch {
    return null;
  }
  if (!c.isGameOver()) return null;
  if (c.isCheckmate()) {
    // side to move is mated
    return { bestMove: '(none)', lines: { 1: { scoreCp: -MATE_CP, scoreMate: 0, pv: [], nodes: 0 } } };
  }
  return { bestMove: '(draw)', lines: { 1: { scoreCp: 0, scoreMate: null, pv: [], nodes: 0 } } };
}

/**
 * @param {object} engine bridge with analyze()
 * @param {{headers:object, moves:object[], fens:string[]}} game
 * @param {object} o
 * @param {number} [o.depth]
 * @param {number} [o.movetime]
 * @param {(p:object)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function analyzeGame(engine, game, o = {}) {
  const { headers, moves, fens } = game;

  // 1. evaluate every position exactly once
  const evals = new Array(fens.length).fill(null);
  for (let k = 0; k < fens.length; k++) {
    if (o.signal?.aborted) throw new Error('aborted');
    evals[k] = terminalResult(fens[k]) || await engine.analyze(fens[k], { depth: o.depth, movetime: o.movetime });
    o.onProgress?.({ phase: 'eval', ply: k, total: fens.length, fen: fens[k] });
  }

  // 2. classify each move from the evals around it
  const out = [];
  for (let k = 1; k <= moves.length; k++) {
    const mv = moves[k - 1];
    const before = evals[k - 1];
    const after = evals[k];

    const line1 = before.lines[1] || before.lines['1'];
    const line2 = before.lines[2] || before.lines['2'];
    const scoreBefore = scoreToObj(line1);
    const scoreAfter = after ? scoreToObj(after.lines[1]) : { cp: 0, mate: null };
    const gameOver = k === moves.length;

    const rec = classifyMove({
      ply: k - 1,
      san: mv.san,
      uci: mv.uci,
      mover: mv.color,
      scoreBefore,
      scoreAfter,
      best: line1 ? { pv: line1.pv, cp: line1.scoreCp ?? null, mate: line1.scoreMate ?? null } : null,
      second: line2 ? { pv: line2.pv, cp: line2.scoreCp ?? null, mate: line2.scoreMate ?? null } : null,
      materialDelta: materialDeltaFor(fens[k - 1], fens[k], mv.color),
      gameOver
    });

    if (rec.best && line1?.pv) rec.bestSan = uciToSan(fens[k - 1], line1.pv[0]);
    out.push(rec);
    o.onProgress?.({ phase: 'move', ply: k, total: moves.length, san: mv.san, label: rec.label, record: rec });
  }

  return {
    headers,
    moves: out,
    summary: summarise(out),
    fens,
    startFen: fens[0]
  };
}
