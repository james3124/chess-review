/**
 * classify.js — shared by the Node server AND the web UI (ES module, browser-safe).
 *
 * Converts raw engine evaluations into chess.com-style move labels.
 * Pure functions: no Node APIs, no DOM.
 *
 * Pipeline:  engine score (cp / mate)  ->  win probability  ->  loss%  ->  label
 */

/* ------------------------------------------------------------------ *
 * Tunables — win-probability thresholds (0..1 shares of the pie).
 * These approximate chess.com's undisclosed values and are the main
 * knob to turn if you want the labels to feel more/less harsh.
 * ------------------------------------------------------------------ */
export const THRESHOLDS = {
  excellent: 0.02,   // "Excellent"
  good: 0.05,        // "Good"
  inaccuracy: 0.10,  // "Inaccuracy"
  mistake: 0.25      // "Mistake"  (above this => Blunder)
};

export const BOOK_PLIES = 14;       // first 14 half-moves are "book territory"
export const BOOK_MAX_LOSS = 0.10;  // book move may only lose this much

/* Chess.com-style label palette (matches their UI colours). */
export const LABELS = {
  book:       { name: 'Book',       color: '#a2887e' },
  brilliant:  { name: 'Brilliant',  color: '#26c2a3' },
  great:      { name: 'Great',      color: '#5c8bb0' },
  best:       { name: 'Best',       color: '#9bcb60' },
  excellent:  { name: 'Excellent',  color: '#96bc4b' },
  good:       { name: 'Good',       color: '#96bc4b' },
  inaccuracy: { name: 'Inaccuracy', color: '#f0c15c' },
  mistake:    { name: 'Mistake',    color: '#e6912c' },
  miss:       { name: 'Miss',       color: '#e6912c' },
  blunder:    { name: 'Blunder',    color: '#ca3431' }
};

/* ------------------------------------------------------------------ *
 * Score -> centipawns, always from WHITE's point of view.
 * Mates are mapped to huge scores so win probability saturates.
 * ------------------------------------------------------------------ */
export const MATE_CP = 100000;

export function toCpWhite(score, sideToMove) {
  let cp;
  if (score.mate != null) {
    // mate > 0  => side to move mates in |mate|
    const n = Math.abs(score.mate);
    cp = score.mate > 0 ? MATE_CP - n : -(MATE_CP - n);
  } else {
    cp = score.cp ?? 0;
  }
  return sideToMove === 'w' ? cp : -cp;
}

/** Win probability for White (0..1). Same sigmoid lichess/chess.com use. */
export function winProbWhite(cpWhite) {
  if (cpWhite >= MATE_CP / 2) return 1;
  if (cpWhite <= -MATE_CP / 2) return 0;
  return 1 / (1 + Math.exp(-0.00368208 * cpWhite));
}

/** Win probability for the mover, before and after the move. */
export function moverWinProbs(cpBeforeWhite, cpAfterWhite, mover) {
  const before = winProbWhite(cpBeforeWhite);
  const after = winProbWhite(cpAfterWhite);
  return {
    before: mover === 'w' ? before : 1 - before,
    after: mover === 'w' ? after : 1 - after
  };
}

/** How much of the win probability the mover threw away, 0..1. */
export function winLoss(mover, cpBeforeWhite, cpAfterWhite) {
  const { before, after } = moverWinProbs(cpBeforeWhite, cpAfterWhite, mover);
  return Math.max(0, before - after);
}

/**
 * Per-move accuracy, the widely quoted chess.com formula.
 * @param lossShare win-probability share lost, 0..1
 */
export function moveAccuracy(lossShare) {
  const pct = Math.min(100, Math.max(0, lossShare)) * 100;
  return Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * pct) - 3.1669));
}

/**
 * Core classifier. One call per played move.
 *
 * @param {object} m
 * @param {number} m.ply                 half-move index, 0-based
 * @param {string} m.san                 played move, SAN
 * @param {string} m.uci                 played move, UCI
 * @param {'w'|'b'} m.mover
 * @param {{cp:number,mate:number|null}} m.scoreBefore  engine score before the move (mover to play)
 * @param {{cp:number,mate:number|null}} m.scoreAfter   engine score after the move
 * @param {{cp:number,mate:number|null,pv:string[]}|null} m.best   best line before the move
 * @param {{cp:number,mate:number|null,pv:string[]}|null} m.second 2nd best line (MultiPV=2)
 * @param {number} m.materialDelta       material (pawns) gained by the played move; negative = given up
 * @param {boolean} m.gameOver           the played move ended the game (mate/draw)
 * @returns {object} classification record
 */
export function classifyMove(m) {
  const { ply, san, uci, mover, scoreBefore, scoreAfter, best, second, materialDelta = 0, gameOver = false } = m;

  const cpBeforeW = toCpWhite(scoreBefore, mover);
  const cpAfterW = toCpWhite(scoreAfter, mover === 'w' ? 'b' : 'w');
  const loss = winLoss(mover, cpBeforeW, cpAfterW);
  const { before, after } = moverWinProbs(cpBeforeW, cpAfterW, mover);

  const playedBest = !!(best && uci === best.pv?.[0]);
  const accuracy = moveAccuracy(loss);

  /* --- base label from the loss buckets --- */
  let label = 'good';
  if (loss <= THRESHOLDS.excellent) label = 'excellent';
  else if (loss <= THRESHOLDS.good) label = 'good';
  else if (loss <= THRESHOLDS.inaccuracy) label = 'inaccuracy';
  else if (loss <= THRESHOLDS.mistake) label = 'mistake';
  else label = 'blunder';

  /* --- overrides, most specific first --- */

  // Booking: opening moves that hold the position.
  if (ply < BOOK_PLIES && loss <= BOOK_MAX_LOSS && after >= 0.45) {
    label = 'book';
  }

  // Mate delivered / found => the best move there is.
  if (gameOver && scoreAfter?.mate != null && scoreAfter.mate <= 0) {
    label = 'best';
  }

  // Missed a win: from a clearly winning position the move gives up ground
  // but stays winning (chess.com's "you should have converted").
  const bestGainCp = best && scoreBefore
    ? toCpWhite(best, mover) - toCpWhite(scoreBefore, mover)
    : 0;
  if (!playedBest && before >= 0.75 && (before - after) >= 0.05 && after >= 0.55) {
    label = 'miss';
  }
  else if (!playedBest && before >= 0.90 && bestGainCp >= 200 && after >= 0.70) {
    label = 'miss';
  }

  // The played move WAS the engine's top choice.
  if (playedBest && !gameOver) {
    const secondLossCp = second && best ? toCpWhite(best, mover) - toCpWhite(second, mover) : 0;
    const secondAfter = second ? winProbWhite(toCpWhite(second, mover)) : 0;
    const secondAfterMover = second ? (mover === 'w' ? secondAfter : 1 - secondAfter) : 0;

    // Only winning move: everything else drops out of a win.
    if (after >= 0.75 && second && (after - secondAfterMover) >= 0.30) label = 'great';
    else label = 'best';
  }

  // Brilliant: engine's top move, a genuine material sacrifice, and still
  // not worse for the mover.
  if (playedBest && materialDelta <= -3 && after >= 0.45 && !gameOver) {
    label = 'brilliant';
  }

  return {
    ply, san, uci, mover, label,
    loss: Math.round(loss * 1e4) / 1e4,
    winProbBefore: Math.round(before * 1e4) / 1e4,
    winProbAfter: Math.round(after * 1e4) / 1e4,
    accuracy: Math.round(accuracy * 10) / 10,
    scoreBefore: { cp: scoreBefore.cp ?? null, mate: scoreBefore.mate ?? null },
    scoreAfter: { cp: scoreAfter.cp ?? null, mate: scoreAfter.mate ?? null },
    best: best ? { uci: best.pv?.[0], pv: best.pv, cp: best.cp ?? null, mate: best.mate ?? null } : null
  };
}

/** Aggregate per-player accuracy + label counts for the report header. */
export function summarise(moves) {
  const blank = () => ({ moves: 0, accuracy: 0, labels: {} });
  const out = { white: blank(), black: blank() };
  for (const m of moves) {
    const side = m.mover === 'w' ? out.white : out.black;
    side.moves += 1;
    side.accuracy += m.accuracy;
    side.labels[m.label] = (side.labels[m.label] || 0) + 1;
  }
  for (const side of [out.white, out.black]) {
    if (side.moves) side.accuracy = Math.round((side.accuracy / side.moves) * 10) / 10;
  }
  return out;
}
