/* app.js — UI controller */
import { Board } from './board.js';
import { parsePgn } from './lib/pgn.mjs';
import { analyzeGame } from './lib/analyze.mjs';
import { Chess } from './vendor/chess.js';
import { LABELS, summarise } from './lib/classify.js';
import { engine as bridge } from './native-bridge.js';
import { chessCom } from './chesscom-bridge.js';
import { gameTitle, gameResult, timeClassLabel, ecoLabel, formatDate, toParsedGame } from './chesscom.mjs';

/* ---------------- dom ---------------- */
const $ = (sel) => document.querySelector(sel);
const ui = {
  welcome: $('#welcome'), picker: $('#picker'), pickerList: $('#picker-list'),
  game: $('#game'), progress: $('#progress'), barFill: $('#bar-fill'),
  progressText: $('#progress-text'), engineBar: $('#engine-bar'),
  gp: $('#game-progress'), gpText: $('#gp-text'), gpFill: $('#gp-fill'),
  moveLabel: $('#move-label'), analysis: $('#analysis'), movelist: $('#movelist'),
  evalFill: $('#evalfill'), evalLabel: $('#evallabel'),
  fileInput: $('#file-input'), pasteDialog: $('#paste-dialog'), pasteText: $('#paste-text'),
  cc: $('#cc'), ccMsg: $('#cc-msg'), ccProfile: $('#cc-profile'), ccMonths: $('#cc-months'),
  ccGames: $('#cc-games'), ccMore: $('#cc-more')
};

const S = {
  pgn: null, games: [], idx: 0, game: null, result: null,
  cursor: 0, board: null, abort: null, depth: 14, analysing: false
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
let enginePromise = null; // shared: the engine may only be waited on once

/** Loads Stockfish on demand — the engine must NOT start at app startup,
 *  because there is usually no game to analyse yet. */
function engineReady() {
  if (!enginePromise) enginePromise = bridge.waitReady();
  return enginePromise;
}

function initEngineBar() {
  const select = document.createElement('select');
  select.id = 'depth-select';
  select.innerHTML = [8, 10, 12, 14, 16, 18].map((d) =>
    `<option value="${d}" ${d === S.depth ? 'selected' : ''}>depth ${d}</option>`).join('');
  select.onchange = () => { S.depth = Number(select.value); };

  ui.engineBar.className = 'engine-bar idle';
  $('#engine-text').innerHTML = 'engine starts when you open a game';
  $('#engine-depth').appendChild(select);
}

/** Called the moment analysis begins: show the loader + live elapsed time. */
let engineTimer = null, engineT0 = 0;
function showEngineLoading() {
  engineT0 = Date.now();
  ui.engineBar.className = 'engine-bar loading';
  clearInterval(engineTimer);
  engineTimer = setInterval(() => {
    $('#engine-text').innerHTML =
      `starting engine &mdash; loading neural network (${((Date.now() - engineT0) / 1000).toFixed(1)}s)`;
  }, 250);
}

/** Re-renders the engine bar once the shared readiness promise settles. */
async function finishEngineBar() {
  const info = await engineReady();
  clearInterval(engineTimer);
  S.engineInfo = info;
  const secs = ((Date.now() - engineT0) / 1000).toFixed(1);
  if (info.state === 'failed') {
    ui.engineBar.className = 'engine-bar bad';
    $('#engine-text').innerHTML = `engine unavailable (${info.error || 'unknown'})`;
  } else {
    ui.engineBar.className = 'engine-bar ok';
    $('#engine-text').innerHTML =
      `engine ready: <b>${info.version || 'Stockfish'}</b> ` +
      `(${info.threads || '?'} threads &middot; ${info.hash || '?'} MB hash &middot; ${secs}s)`;
  }
  return info;
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
  for (const x of [ui.welcome, ui.picker, ui.game, ui.progress, ui.cc]) x.hidden = x !== el;
}

/* ---------------- chess.com player search ---------------- */
const CC = { user: null, months: [], month: null, games: [], shown: 0, PAGE: 40 };

function ccMsg(text, bad = false) {
  ui.ccMsg.hidden = !text;
  ui.ccMsg.textContent = text;
  ui.ccMsg.className = 'cc-msg' + (bad ? ' bad' : '');
}

function ccReset() {
  ui.ccProfile.hidden = true;
  ui.ccMonths.hidden = true;
  ui.ccGames.hidden = true;
  ui.ccMore.hidden = true;
  ui.ccGames.innerHTML = '';
  CC.user = null; CC.months = []; CC.month = null; CC.games = []; CC.shown = 0;
  ccMsg('');
}

async function ccSearch() {
  const name = $('#cc-user').value.trim();
  ccReset();
  if (!name) { ccMsg('Type a chess.com username first.', true); return; }

  $('#cc-go').disabled = true;
  ccMsg('Searching chess.com…');
  try {
    const info = await chessCom.search(name);
    CC.user = info;
    CC.months = info.months.slice(0, 6); // recent months only

    $('#cc-avatar').src = info.avatar;
    $('#cc-avatar').onerror = () => { $('#cc-avatar').style.visibility = 'hidden'; };
    $('#cc-name').textContent = info.name;
    $('#cc-sub').textContent = [info.country, info.months.length + ' months of games']
      .filter(Boolean).join(' · ');
    $('#cc-link').href = info.url;
    ui.ccProfile.hidden = false;

    renderMonths();
    await ccLoadMonth(CC.months[0]);
  } catch (err) {
    ccMsg(err.notFound || err.invalid
      ? `Couldn't find "${name}" on chess.com — check the spelling, or the profile is private.`
      : `${err.message}. Try again in a moment.`, true);
  } finally {
    $('#cc-go').disabled = false;
  }
}

function renderMonths() {
  ui.ccMonths.innerHTML = CC.months.map((m) =>
    `<button class="cc-month${m === CC.month ? ' active' : ''}" data-m="${m}">${m.replace('-', '/')}</button>`
  ).join('');
  ui.ccMonths.hidden = false;
  ui.ccMonths.querySelectorAll('.cc-month').forEach((b) => {
    b.onclick = () => ccLoadMonth(b.dataset.m);
  });
}

async function ccLoadMonth(month) {
  if (!CC.user || !month) return;
  CC.month = month;
  renderMonths();
  ui.ccGames.hidden = false;
  ui.ccGames.innerHTML = '<div class="cc-note">loading games…</div>';
  ui.ccMore.hidden = true;
  ccMsg('');
  try {
    CC.games = await chessCom.games(CC.user.username, month);
    CC.shown = 0;
    renderGames();
    if (!CC.games.length) ui.ccGames.innerHTML = '<div class="cc-note">No games in this month.</div>';
  } catch (err) {
    ui.ccGames.innerHTML = '';
    ccMsg(`Couldn't load ${month}: ${err.message}`, true);
  }
}

function renderGames() {
  const slice = CC.games.slice(CC.shown, CC.shown + CC.PAGE);
  CC.shown += slice.length;
  ui.ccGames.insertAdjacentHTML('beforeend', slice.map((g) => `
    <div class="cc-game" data-u="${g.uuid}">
      <div class="cc-game-top">
        <span class="cc-players">${esc(gameTitle(g))}</span>
        <span class="cc-tc">${esc(timeClassLabel(g.timeClass))}${g.rated ? '' : ' · casual'}</span>
      </div>
      <div class="cc-game-meta">
        <span class="cc-res">${gameResult(g)}</span>
        <span>${esc(ecoLabel(g.eco))}</span>
        <span>${esc(formatDate(g.endTime))}</span>
        ${g.acc && (g.acc.white || g.acc.black)
          ? `<span title="chess.com's own accuracy">accu ${esc(g.acc.white || '?')}–${esc(g.acc.black || '?')}</span>` : ''}
      </div>
      <div class="cc-game-actions">
        <button class="btn small cc-analyse">Analyse</button>
        ${g.url ? `<a class="btn small ghost" href="${esc(g.url)}" target="_blank" rel="noopener">chess.com</a>` : ''}
      </div>
    </div>`).join(''));

  ui.ccGames.querySelectorAll('.cc-game').forEach((row) => {
    row.querySelector('.cc-analyse').onclick = () => {
      const g = CC.games.find((x) => String(x.uuid) === row.dataset.u);
      if (g) openChessComGame(g);
    };
  });

  ui.ccMore.hidden = CC.shown >= CC.games.length;
}

function openChessComGame(g) {
  const parsed = toParsedGame(g);
  if (!parsed.ok) return ccMsg('That game has no readable moves (' + parsed.error + ').', true);
  S.games = [parsed];
  S.idx = 0;
  openGame(parsed);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startGame(i) {
  openGame(S.games[i]);
}

function openGame(g) {
  if (!g.ok) return alert('This game could not be parsed: ' + (g.error || 'unknown error'));
  S.game = g; S.cursor = 0;

  // Show the game IMMEDIATELY — no engine needed for the board or the moves.
  // Labels are filled in by analyse(), which streams them as they arrive.
  const stubs = g.moves.map((m, k) => ({
    ...m, ply: k, pending: true, label: 'book', loss: 0, accuracy: 0,
    winProbBefore: 0.5, winProbAfter: 0.5,
    scoreBefore: { cp: 0, mate: null }, scoreAfter: { cp: 0, mate: null }, best: null
  }));
  S.result = {
    headers: g.headers,
    moves: stubs,
    fens: g.fens,
    summary: summarise(stubs)
  };
  renderGame(S.result);
  show(ui.game);
  analyse(g);
}

async function analyse(game) {
  S.abort?.abort();
  const ctrl = new AbortController();
  S.abort = ctrl;
  S.analysing = true;
  showProgress('starting engine…', 0);
  showEngineLoading();
  try {
    // A game can be loaded/pasted while Stockfish is still booting: park here
    // (with visible progress) until the engine can really search.
    await engineReady();
  } catch (err) {
    S.analysing = false; hideProgress();
    return alert('Could not start the engine: ' + err.message);
  }
  finishEngineBar(); // updates the engine bar (memoised promise: instant)

  showProgress('engine ready — analysing…', 0);
  try {
    const result = await analyzeGame(bridge, game, {
      depth: S.depth,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.phase !== 'move') {
          showProgress(`evaluating position ${p.ply + 1}/${p.total}`,
            p.total ? (p.ply / p.total) * 100 : 0);
          return;
        }
        showProgress(`analysing move ${p.ply}/${p.total}`, (p.ply / p.total) * 100);
        // splice the freshly classified move into the board we already drew
        S.result.moves[p.ply - 1] = { ...p.record, pending: false };
        renderMoveList(S.result);
        renderCursor();
      }
    });
    S.result = result;
    renderGame(result);
  } catch (err) {
    if (err.message !== 'aborted') alert('Analysis failed: ' + err.message);
  } finally {
    S.analysing = false;
    hideProgress();
  }
}

function showProgress(text, pct) {
  ui.gp.hidden = false;
  ui.gpText.textContent = text;
  ui.gpFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function hideProgress() { ui.gp.hidden = true; }

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
    const L = m.pending ? null : LABELS[m.label];
    html += `<div class="mv${m.pending ? ' pending' : ''}" data-i="${i + 1}">
      <span class="tag" style="background:${L ? L.color : '#6b6763'}">${m.pending ? '…' : short(m.label)}</span>
      <span class="san">${m.san}</span>
      ${!m.pending && m.loss > 0.02 ? `<span class="loss">${(m.loss * 100).toFixed(0)}%</span>` : ''}
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
  if (mv.pending) {
    ui.analysis.className = 'card analysis has-data';
    ui.analysis.innerHTML = `<div class="an-head">
        <span class="an-badge" style="background:#6b6763">Analysing</span>
        <span class="an-loss">Stockfish is still working through the game&hellip;</span>
      </div>`;
    return;
  }
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
  // The file picker is opened natively by the <label for="file-input"> in
  // index.html. Calling input.click() from JS here as well would open the
  // chooser twice on some WebViews, so we only handle the chosen file.
  ui.fileInput.onchange = () => {
    const f = ui.fileInput.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => loadPgn(String(rd.result));
    rd.onerror = () => alert('Could not read that file: ' + f.name);
    rd.readAsText(f);
  };

  const openPaste = () => { ui.pasteText.value = ''; ui.pasteDialog.showModal(); };
  $('#btn-paste').onclick = openPaste;
  $('#btn-paste-2').onclick = openPaste;

  // chess.com player search
  const openCc = () => { show(ui.cc); $('#cc-user').focus(); };
  $('#btn-cc').onclick = openCc;
  $('#btn-cc-2').onclick = openCc;
  $('#cc-go').onclick = ccSearch;
  $('#cc-load-more').onclick = renderGames;
  $('#cc-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') ccSearch(); });
  $('#cc-user').addEventListener('input', () => ccMsg(''));
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
  $('#btn-cancel').onclick = () => S.abort?.abort();
  $('#gp-cancel').onclick = () => S.abort?.abort();

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
