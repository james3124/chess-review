/* app.js — UI controller */
import { Board } from './board.js';
import { parsePgn } from './lib/pgn.mjs';
import { analyzeGame } from './lib/analyze.mjs';
import { Chess } from './vendor/chess.js';
import { LABELS } from './lib/classify.js';
import { engine as bridge } from './native-bridge.js';

/* ---------------- dom ---------------- */
const $ = (sel) => document.querySelector(sel);
const ui = {
  welcome: $('#welcome'), picker: $('#picker'), pickerList: $('#picker-list'),
  game: $('#game'), progress: $('#progress'), barFill: $('#bar-fill'),
  progressText: $('#progress-text'), engineBar: $('#engine-bar'),
  moveLabel: $('#move-label'), analysis: $('#analysis'), movelist: $('#movelist'),
  evalFill: $('#evalfill'), evalLabel: $('#evallabel'),
  fileInput: $('#file-input'), pasteDialog: $('#paste-dialog'), pasteText: $('#paste-text')
};

const S = {
  pgn: null, games: [], idx: 0, game: null, result: null,
  cursor: 0, board: null, abort: null, depth: 14
};
S.board = new Board($('#board'));

/* ---------------- helpers ---------------- */
const short = (label) => ({ inaccuracy: 'inacc', blunder: '??', mistake: '?', miss: 'miss', book: 'book' })[label] || label;

function fmtScore(cp, mate) {
  if (mate != null) return `M${Math.abs(mate)}`;
  if (cp == null) return '0.0';
  return (cp / 100).toFixed(2);
}

function moveLabel(m) {
  return m.label[0].toUpperCase() + m.label.slice(1);
}

/* ---------------- engine bar ---------------- */
async function initEngineBar() {
  const select = document.createElement('select');
  select.id = 'depth-select';
  select.innerHTML = [8, 10, 12, 14, 16, 18].map((d) =>
    `<option value="${d}" ${d === S.depth ? 'selected' : ''}>depth ${d}</option>`).join('');
  select.onchange = () => { S.depth = Number(select.value); };

  try {
    const info = await bridge.info();
    ui.engineBar.className = 'engine-bar ok';
    ui.engineBar.innerHTML = `<span>${bridge.mode === 'native' ? 'built-in' : 'local'} engine: ${info.version || 'Stockfish'}</span>`;
  } catch (err) {
    ui.engineBar.className = 'engine-bar bad';
    ui.engineBar.innerHTML = `<span>engine offline (${err.message}) — start with <code>npm start</code></span>`;
  }
  ui.engineBar.appendChild(select);
}

/* ---------------- loading PGNs ---------------- */
function loadPgn(text) {
  const games = parsePgn(text);
  if (!games.length) return alert('No games found in that PGN.');
  S.pgn = text; S.games = games;
  if (games.length === 1) { startGame(0); return; }

  ui.pickerList.innerHTML = games.map((g, i) => {
    const h = g.headers || {};
    return `<li data-i="${i}"><span>${h.White || 'White'} vs ${h.Black || 'Black'}</span>
            <span class="meta">${h.Result || ''} ${g.ok ? '' : g.error}</span></li>`;
  }).join('');
  ui.pickerList.querySelectorAll('li').forEach((li) =>
    li.onclick = () => startGame(Number(li.dataset.i)));
  show(ui.picker);
}

function show(el) {
  for (const x of [ui.welcome, ui.picker, ui.game, ui.progress]) x.hidden = x !== el;
}

function startGame(i) {
  const g = S.games[i];
  if (!g.ok) return alert('This game could not be parsed: ' + g.error);
  S.idx = i; S.game = g;
  analyse(g);
}

async function analyse(game) {
  S.abort?.abort();
  const ctrl = new AbortController();
  S.abort = ctrl;
  show(ui.progress);
  ui.barFill.style.width = '0%';
  ui.progressText.textContent = 'starting engine…';
  try {
    const result = await analyzeGame(bridge, game, {
      depth: S.depth,
      signal: ctrl.signal,
      onProgress: (p) => {
        const pct = p.total ? Math.round((p.ply / p.total) * 100) : 0;
        ui.barFill.style.width = pct + '%';
        ui.progressText.textContent = p.phase === 'eval'
          ? `evaluating position ${p.ply + 1}/${p.total} (${pct}%)`
          : `classifying move ${p.ply}/${p.total}`;
      }
    });
    S.result = result; S.cursor = 0;
    renderGame(result);
    show(ui.game);
  } catch (err) {
    if (err.message !== 'aborted') alert('Analysis failed: ' + err.message);
    show(S.games.length > 1 ? ui.picker : ui.welcome);
  }
}

/* ---------------- rendering ---------------- */
function renderGame(r) {
  const h = r.headers;
  $('#name-white').textContent = h.White || 'White';
  $('#name-black').textContent = h.Black || 'Black';
  $('#result').textContent = h.Result || '';
  $('#acc-white').textContent = `${r.summary.white.accuracy}%`;
  $('#acc-black').textContent = `${r.summary.black.accuracy}%`;

  // legend
  $('#legend').innerHTML = Object.entries(LABELS)
    .map(([k, v]) => `<span class="chip" style="background:${v.color}">${v.name}</span>`).join('');

  renderMoveList(r);
  renderCursor();
}

function renderMoveList(r) {
  let html = '<div class="mv-grid">';
  r.moves.forEach((m, i) => {
    if (i % 2 === 0) html += `<div class="mv-num">${i / 2 + 1}.</div>`;
    const L = LABELS[m.label];
    html += `<div class="mv" data-i="${i + 1}">
      <span class="tag" style="background:${L.color}">${short(m.label)}</span>
      <span class="san">${m.san}</span>
      ${m.loss > 0.02 ? `<span class="loss">${(m.loss * 100).toFixed(0)}%</span>` : ''}
    </div>`;
  });
  html += '</div>';
  ui.movelist.innerHTML = html;
  ui.movelist.querySelectorAll('.mv').forEach((el) => {
    el.onclick = () => { S.cursor = Number(el.dataset.i); renderCursor(); };
  });
}

function inCheck(fen) {
  try { const c = new Chess(); c.load(fen, { sloppy: true }); return c.inCheck(); }
  catch { return false; }
}

/** Current position's White-relative eval, from the record of the move just played. */
function whiteEvalAt(cursor) {
  if (cursor === 0) return { cp: 0, mate: null, whiteWin: 0.5 };
  const m = S.result.moves[cursor - 1];
  const cp = m.scoreAfter.cp ?? 0;
  const mate = m.scoreAfter.mate;
  if (mate != null) {
    // mate from the mover's point of view: > 0 = the side to move mates
    const whiteMates = (m.mover === 'w') === (mate > 0);
    return { cp: 0, mate, whiteWin: whiteMates ? 1 : 0 };
  }
  const whiteWin = m.mover === 'w' ? m.winProbAfter : 1 - m.winProbAfter;
  return { cp: m.mover === 'w' ? cp : -cp, mate: null, whiteWin };
}

function renderCursor() {
  const r = S.result;
  const c = S.cursor;
  if (c < 0) c = 0;
  S.cursor = Math.min(c, r.moves.length);

  const fen = r.fens[S.cursor];
  const mv = S.cursor > 0 ? r.moves[S.cursor - 1] : null;
  const arrows = [];
  if (mv && ['blunder', 'mistake', 'miss', 'inaccuracy'].includes(mv.label) && mv.best) {
    arrows.push({ from: mv.uci.slice(0, 2), to: mv.uci.slice(2, 4), color: '#e03030' });
    if (mv.best.uci) arrows.push({ from: mv.best.uci.slice(0, 2), to: mv.best.uci.slice(2, 4), color: '#3f9b3f' });
  }
  S.board.setPosition(fen, { lastMove: mv ? mv.uci : null, arrows, check: inCheck(fen) });

  ui.moveLabel.textContent = mv
    ? `${Math.ceil(S.cursor / 2) || 1}${S.cursor % 2 ? '.' : '...'} ${mv.san}`
    : 'start';

  // eval bar
  const ev = whiteEvalAt(S.cursor);
  ui.evalFill.style.width = `${Math.max(4, Math.min(96, ev.whiteWin * 100))}%`;
  ui.evalLabel.textContent = ev.mate != null ? `mate ${Math.abs(ev.mate)}` : fmtScore(ev.cp, ev.mate);

  // analysis panel
  if (!mv) { ui.analysis.className = 'card analysis'; ui.analysis.innerHTML = '<div class="an-pv">Starting position — select a move to see its review.</div>'; return; }
  const L = LABELS[mv.label];
  const share = (x) => `${Math.round(x * 100)}%`;
  let html = `<div class="an-head">
      <span class="an-badge" style="background:${L.color}">${L.name}</span>
      <span class="an-loss">lost ${share(mv.loss)} of winning chances</span>
    </div>`;
  if (mv.label === 'book') html += `<div class="an-pv">Opening theory — a known book move.</div>`;
  if (mv.best && mv.best.uci !== mv.uci) {
    html += `<div class="an-best">Better was <b>${mv.bestSan || mv.best.uci}</b>
      <span class="an-pv">(${fmtScore(mv.best.cp, mv.best.mate)})</span></div>`;
    if (mv.best.pv?.length > 1) html += `<div class="an-pv">line: ${mv.best.pv.slice(0, 8).join(' ')}</div>`;
  } else if (mv.best) {
    html += `<div class="an-pv">Matches the engine's first choice.</div>`;
    if (mv.best.pv?.length > 1) html += `<div class="an-pv">line: ${mv.best.pv.slice(0, 8).join(' ')}</div>`;
  }
  html += `<div class="an-bars">
      <div class="an-bar"><b>${share(mv.winProbBefore)}</b>before</div>
      <div class="an-bar"><b>${share(mv.winProbAfter)}</b>after</div>
      <div class="an-bar"><b>${mv.accuracy}%</b>accuracy</div>
    </div>`;
  ui.analysis.innerHTML = html;
  ui.analysis.className = 'card analysis has-data';

  // highlight in move list
  ui.movelist.querySelectorAll('.mv').forEach((el) =>
    el.classList.toggle('active', Number(el.dataset.i) === S.cursor));
}

/* ---------------- events ---------------- */
function wire() {
  const pick = () => ui.fileInput.click();
  $('#btn-load').onclick = pick;
  $('#btn-load-2').onclick = pick;
  ui.fileInput.onchange = () => {
    const f = ui.fileInput.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => loadPgn(String(rd.result));
    rd.readAsText(f);
  };

  const openPaste = () => { ui.pasteText.value = ''; ui.pasteDialog.showModal(); };
  $('#btn-paste').onclick = openPaste;
  $('#btn-paste-2').onclick = openPaste;
  $('#paste-cancel').onclick = () => ui.pasteDialog.close();
  $('#paste-ok').onclick = () => {
    const t = ui.pasteText.value.trim();
    ui.pasteDialog.close();
    if (t) loadPgn(t);
  };

  const step = (d) => { S.cursor += d; renderCursor(); };
  $('#nav-first').onclick = () => { S.cursor = 0; renderCursor(); };
  $('#nav-last').onclick = () => { S.cursor = S.result.moves.length; renderCursor(); };
  $('#nav-prev').onclick = () => step(-1);
  $('#nav-next').onclick = () => step(1);
  $('#nav-flip').onclick = () => { S.board.toggleFlip(); renderCursor(); };
  $('#btn-cancel').onclick = () => { S.abort?.abort(); };

  // swipe left/right across the board
  let sx = null;
  $('#board-wrap').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  $('#board-wrap').addEventListener('touchend', (e) => {
    if (sx === null || !S.result) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
    sx = null;
  }, { passive: true });
}

initEngineBar();
wire();

/* PWA: cache the shell so the installed app works offline */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
