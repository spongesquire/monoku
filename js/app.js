/* Paper Sudoku — app logic (ES module) — branded Monoku */
import {
  generate, generateWithTarget, nextStep,
  ROW_OF, COL_OF, BOX_OF, PEERS,
} from './engine.js';

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const cells = [];
const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

/* ---------- state ---------- */
let given = new Uint8Array(81);
let board = new Uint8Array(81);
let solution = new Uint8Array(81);
let notes = Array.from({ length: 81 }, () => new Set());
let history = [];
let selected = -1;
let selDigit = 0;
let notesMode = false;
let mistakes = 0;
let hintsUsed = 0;
let elapsed = 0;
let timerId = null;
let won = false;
let currentDiff = 'easy';
let currentLabel = 'Easy';
let currentSE = null;
let settings = { theme: 'auto', cleanup: true, advance: true };
let lastTap = { i: -1, t: 0, note: 0 };
let hintPulseTimer = null;

/* ---------- persistence (primary: localStorage, mirror: IndexedDB) ---------- */
const SAVE_KEY = 'monoku_save_v1';
const STATS_KEY = 'monoku_stats_v1';
const SETTINGS_KEY = 'monoku_settings_v1';
const IDB_NAME = 'monoku';
const IDB_STORE = 'saves';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no idb'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, 'save');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { /* mirror is best-effort */ }
}

async function idbGet() {
  try {
    const db = await idbOpen();
    const v = await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get('save');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    return v ?? null;
  } catch (e) { return null; }
}

function snapshot() {
  return {
    given: [...given], board: [...board], solution: [...solution],
    notes: notes.map(s => [...s]),
    history: history.slice(-200).map(h => ({ ...h, notes: [...h.notes] })),
    elapsed, mistakes, hintsUsed,
    currentDiff, currentLabel, currentSE, won,
    savedAt: Date.now(),
  };
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); } catch (e) {}
  idbPut(snapshot()); // async mirror, survives localStorage eviction quirks
}

/* flush before iOS kills the tab — pagehide is the reliable last event */
window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save();
  else if (!$('pauseVeil').hidden && !sheetOpen()) resumeGame();
});

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };

function loadStats() { return load(STATS_KEY) ?? { plays: 0, wins: 0, streak: 0, best: {} }; }
function saveStats(s) { try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {} }

function loadSettings() {
  const s = load(SETTINGS_KEY);
  if (s) settings = { ...settings, ...s };
  applyTheme();
}
function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* ---------- theme ---------- */
function applyTheme() {
  const t = settings.theme;
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  $('themeVal').textContent = t === 'auto' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? '#000000' : '#f6f4ef');
}

/* ---------- board construction ---------- */
function buildBoard() {
  const b = $('board');
  b.innerHTML = '';
  cells.length = 0;
  for (let i = 0; i < 81; i++) {
    const c = document.createElement('button');
    c.className = 'cell';
    c.dataset.i = i;
    c.setAttribute('aria-label', `Row ${ROW_OF[i] + 1} column ${COL_OF[i] + 1}`);
    if (COL_OF[i] === 2 || COL_OF[i] === 5) c.classList.add('b-right');
    if (ROW_OF[i] === 2 || ROW_OF[i] === 5) c.classList.add('b-bottom');
    const ng = document.createElement('div');
    ng.className = 'notes-grid';
    for (let d = 1; d <= 9; d++) {
      const n = document.createElement('span');
      n.className = 'n';
      n.dataset.d = d;
      n.textContent = d;
      ng.appendChild(n);
    }
    c.appendChild(ng);
    const val = document.createElement('span');
    val.className = 'val';
    c.appendChild(val);
    b.appendChild(c);
    cells.push(c);
  }
}

/* ---------- rendering ---------- */
function render() {
  const selVal = selected >= 0 ? board[selected] : 0;
  const hlDigit = selDigit || selVal;
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 81; i++) if (board[i]) counts[board[i]]++;

  for (let i = 0; i < 81; i++) {
    const c = cells[i];
    const v = board[i];
    c.classList.toggle('user', !given[i] && !!v);
    c.classList.toggle('error', !!v && !given[i] && v !== solution[i]);
    c.classList.toggle('sel', i === selected);
    /* same-number highlight: any cell whose value equals the armed/selected digit */
    c.classList.toggle('same', !!v && v === hlDigit && i !== selected);
    c.classList.toggle('peer', selected >= 0 && i !== selected && !v && isPeer(i, selected));
    const showNotes = !v && notes[i].size > 0;
    const valEl = c.querySelector('.val');
    valEl.textContent = v || '';
    valEl.style.display = showNotes ? 'none' : '';
    for (const n of c.querySelectorAll('.n')) {
      const d = +n.dataset.d;
      n.classList.toggle('on', showNotes && notes[i].has(d));
      n.classList.toggle('hl', showNotes && notes[i].has(d) && d === hlDigit);
    }
  }
  renderPad(counts);
  const m = $('mistakes');
  m.hidden = mistakes === 0;
  m.textContent = mistakes === 1 ? '1 mistake' : `${mistakes} mistakes`;
}

function isPeer(i, j) {
  return ROW_OF[i] === ROW_OF[j] || COL_OF[i] === COL_OF[j] || BOX_OF[i] === BOX_OF[j];
}

function renderPad(counts) {
  const pad = $('pad');
  pad.innerHTML = '';
  /* per-box presence: dots double as a board map — slot b lights up when
   * digit d is present in box b (mirrors the 3x3 box layout on the board) */
  const boxHas = Array.from({ length: 10 }, () => new Array(9).fill(false));
  for (let i = 0; i < 81; i++) {
    const v = board[i];
    if (v) boxHas[v][BOX_OF[i]] = true;
  }
  for (let d = 1; d <= 9; d++) {
    const k = document.createElement('button');
    k.className = 'pad-key';
    k.dataset.d = d;
    k.setAttribute('aria-label', `Digit ${d}, ${9 - counts[d]} remaining`);
    const num = document.createElement('span');
    num.className = 'pk-num';
    num.textContent = d;
    k.appendChild(num);
    /* 3x3 mini-map of the board's boxes: lit dot = digit present in that
     * box, faint = still needed there. Shows WHERE, not just how many */
    const dots = document.createElement('span');
    dots.className = 'pk-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let b = 0; b < 9; b++) {
      const dot = document.createElement('i');
      if (!boxHas[d][b]) dot.className = 'off';
      dots.appendChild(dot);
    }
    k.appendChild(dots);
    if (selDigit === d) k.classList.add('hl');
    if (counts[d] >= 9) k.classList.add('done');
    k.addEventListener('click', () => onPad(d));
    pad.appendChild(k);
  }
}

/* ---------- selection & input ---------- */
function select(i, keepDigit = false) {
  selected = i;
  if (!keepDigit) selDigit = 0;
  render();
}

function onCellTap(i, noteDigit = 0) {
  if (won) return;
  const now = Date.now();
  if (lastTap.i === i && now - lastTap.t < 320) {
    /* double-tap: promote a guess to an answer.
       If both taps landed on the same note digit, commit that digit.
       If the cell holds exactly one note, commit it. */
    const d = (lastTap.note && lastTap.note === noteDigit) ? noteDigit
      : (lastTap.note || noteDigit) ? 0 : 0;
    lastTap = { i: -1, t: 0, note: 0 };
    if (d) { place(i, d); return; }
    if (!board[i] && notes[i].size === 1) { place(i, [...notes[i]][0]); return; }
    select(i, true);
    return;
  }
  lastTap = { i, t: now, note: noteDigit };

  if (!board[i] && !given[i]) {
    if (selDigit) {
      if (notesMode) toggleNote(i, selDigit);
      else place(i, selDigit);
      return;
    }
  }
  /* tapping a filled cell: select + highlight its digit, keep an armed digit armed */
  select(i, true);
}

function onPad(d) {
  if (won) return;
  if (selected >= 0 && !given[selected]) {
    if (notesMode) toggleNote(selected, d);
    else place(selected, d);
  } else {
    selDigit = selDigit === d ? 0 : d;
    render();
  }
}

function place(i, d) {
  if (given[i]) return;
  if (board[i] === d) { erase(i); return; } /* tap same digit again to clear */
  pushHistory(i);
  board[i] = d;
  notes[i].clear();
  const correct = d === solution[i];
  if (!correct) {
    mistakes++;
    vibrate([12, 40, 12]);
    flashError(i);
    selected = i;
  } else {
    vibrate(8);
    popDigit(i, d);
    if (settings.cleanup) cleanupNotes(i, d);
    selected = settings.advance ? findNextEmpty(i) : i;
  }
  selDigit = 0;
  checkWin();
  render();
  save(); /* progress persisted on every single move */
}

function toggleNote(i, d) {
  pushHistory(i);
  if (notes[i].has(d)) notes[i].delete(d); else notes[i].add(d);
  vibrate(4);
  selected = i;
  render();
  save();
}

function erase(i) {
  if (i < 0 || given[i]) return;
  if (!board[i] && !notes[i].size) return;
  pushHistory(i);
  board[i] = 0;
  notes[i].clear();
  selected = i;
  render();
  save();
}

function cleanupNotes(i, d) {
  for (const j of PEERS[i]) notes[j].delete(d);
}

function findNextEmpty(from) {
  for (let k = 1; k <= 81; k++) {
    const i = (from + k) % 81;
    if (!board[i]) return i;
  }
  return from;
}

function popDigit(i, d) {
  const el = document.createElement('span');
  el.className = 'pop';
  el.textContent = d;
  cells[i].appendChild(el);
  setTimeout(() => el.remove(), 220);
}

function flashError(i) {
  cells[i].classList.add('flash');
  setTimeout(() => cells[i].classList.remove('flash'), 340);
}

/* ---------- undo ---------- */
function pushHistory(i) {
  history.push({ i, val: board[i], notes: [...notes[i]] });
  if (history.length > 300) history.shift();
}
function undo() {
  const h = history.pop();
  if (!h) return;
  board[h.i] = h.val;
  notes[h.i] = new Set(h.notes);
  selected = h.i;
  render();
  save();
}

/* ---------- timer ---------- */
function startTimer() {
  if (timerId || won) return;
  timerId = setInterval(() => {
    elapsed++;
    renderTimer();
    if (elapsed % 10 === 0) save();
  }, 1000);
}
function stopTimer() { clearInterval(timerId); timerId = null; }
function renderTimer() {
  $('timer').textContent = fmtTime(elapsed);
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function pauseGame() {
  if (!timerId || won) return;
  stopTimer();
  save();
  $('pauseVeil').hidden = false;
}
function resumeGame() {
  $('pauseVeil').hidden = true;
  if (!won && !sheetOpen()) startTimer();
}
function sheetOpen() {
  return ['sheetNew', 'sheetHint', 'sheetWin', 'sheetMenu'].some(id => !$(id).hidden);
}

/* ---------- hints (progressive, Hintoku-style) ---------- */
function requestHint() {
  if (won) return;
  const step = nextStep(board);
  if (!step) {
    showHintSheet({
      hint: {
        tech: 'No logical step found',
        where: 'The board is stuck',
        what: 'This position has no deduction in the technique ladder',
        why: 'There is probably a wrong entry — check the red cells, or undo back to your last confident move.',
      },
      placements: [], eliminations: [],
    });
    return;
  }
  showHintSheet(step);
}

function showHintSheet(step) {
  $('hintTitle').textContent = step.hint.tech;
  $('hintWhere').textContent = step.hint.where;
  $('hintWhat').textContent = step.hint.what;
  $('hintWhy').textContent = step.hint.why;
  const next = $('btnHintNext');
  const targets = [
    ...(step.placements?.[0] ? [step.placements[0].i] : []),
    ...(step.eliminations?.slice(0, 8).map(e => e.i) ?? []),
  ];
  next.textContent = targets.length ? 'Show me where' : 'Got it';
  next.onclick = () => {
    if (targets.length) {
      for (const i of targets) cells[i].classList.add('hint-target');
      clearTimeout(hintPulseTimer);
      hintPulseTimer = setTimeout(() => {
        document.querySelectorAll('.hint-target').forEach(el => el.classList.remove('hint-target'));
      }, 3400);
      next.textContent = step.placements?.length ? 'Place it for me' : 'Apply it';
      next.onclick = () => applyHint(step);
    } else {
      closeSheet('sheetHint');
    }
  };
  openSheet('sheetHint');
}

function applyHint(step) {
  hintsUsed++;
  if (step.placements?.length) {
    const p = step.placements[0];
    pushHistory(p.i);
    board[p.i] = p.d;
    notes[p.i].clear();
    cleanupNotes(p.i, p.d);
    selected = p.i;
    popDigit(p.i, p.d);
  } else if (step.eliminations?.length) {
    for (const e of step.eliminations) notes[e.i].delete(e.d);
  }
  document.querySelectorAll('.hint-target').forEach(el => el.classList.remove('hint-target'));
  closeSheet('sheetHint');
  checkWin();
  render();
  save();
}

/* ---------- win ---------- */
function checkWin() {
  for (let i = 0; i < 81; i++) if (board[i] !== solution[i]) return;
  if (won) return;
  won = true;
  stopTimer();
  save();
  const stats = loadStats();
  stats.plays++;
  stats.wins++;
  stats.streak++;
  const prevBest = stats.best[currentDiff];
  let bestMsg;
  if (!prevBest || elapsed < prevBest) {
    stats.best[currentDiff] = elapsed;
    bestMsg = prevBest ? `New best — previous ${fmtTime(prevBest)}` : 'Benchmark set';
  } else {
    bestMsg = `Best: ${fmtTime(prevBest)}`;
  }
  saveStats(stats);
  updateStatsRow();
  cells.forEach((c, i) => {
    setTimeout(() => c.classList.add('wave'), (ROW_OF[i] + COL_OF[i]) * 55);
  });
  vibrate([10, 60, 10, 60, 30]);
  setTimeout(() => {
    $('winTime').textContent = fmtTime(elapsed);
    $('winDiff').textContent = currentLabel;
    $('winMistakes').textContent = String(mistakes);
    $('winHints').textContent = String(hintsUsed);
    $('winBest').textContent = bestMsg;
    openSheet('sheetWin');
  }, 1100);
}

/* ---------- sheets ---------- */
function openSheet(id) {
  pauseGame();
  $(id).hidden = false;
}
function closeSheet(id) {
  $(id).hidden = true;
  if (!sheetOpen()) resumeGame();
}
function bindOverlayClose(id) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeSheet(id); });
}

/* ---------- new game ---------- */
let newChoice = { diff: 'easy', useSlider: false, slider: 8 };

function openNewGame() {
  document.querySelectorAll('.diff-card').forEach(c => {
    c.classList.toggle('sel', !newChoice.useSlider && c.dataset.diff === newChoice.diff);
  });
  const btn = $('btnNewStart');
  btn.disabled = false;          // always reset: never trap the user on a stale busy/disabled state
  btn.classList.remove('busy');
  btn.textContent = 'Start';
  updateAdvUI();
  openSheet('sheetNew');
}

function targetSEForSlider(v) {
  const t = Math.min(100, Math.max(0, v)) / 100;
  return +(1.0 * Math.pow(9.0, t)).toFixed(2);
}
function bandForSE(se) {
  if (se < 1.6) return 'Easy';
  if (se < 2.45) return 'Medium';
  if (se < 4.7) return 'Hard';
  return 'Diabolical';
}
function updateAdvUI() {
  const v = newChoice.slider;
  const se = targetSEForSlider(v);
  $('advSlider').value = v;
  $('advBand').textContent = bandForSE(se);
  $('advSe').textContent = `SE ${se.toFixed(1)}`;
  $('advSlider').style.setProperty('--fill', `${v}%`);
}

async function startNewGame() {
  const btn = $('btnNewStart');
  btn.classList.add('busy');
  btn.textContent = 'Generating…';
  await new Promise(r => setTimeout(r, 40)); /* let the sheet repaint before heavy CPU */
  let result = null;
  try {
    result = newChoice.useSlider
      ? generateWithTarget(targetSEForSlider(newChoice.slider))
      : generate(newChoice.diff);
  } catch (e) { /* fall through to retry state */ }
  btn.classList.remove('busy');
  if (!result) {
    btn.disabled = false;
    btn.textContent = 'Failed — tap to retry';
    return;
  }
  btn.textContent = 'Start';
  applyPuzzle(result);
  closeSheet('sheetNew');
}

function applyPuzzle(result) {
  given = result.puzzle.slice();
  board = result.puzzle.slice();
  solution = result.solution;
  notes = Array.from({ length: 81 }, () => new Set());
  history = [];
  selected = -1;
  selDigit = 0;
  notesMode = false;
  $('btnNotes').setAttribute('aria-pressed', 'false');
  $('btnNotes').classList.remove('on');
  mistakes = 0;
  hintsUsed = 0;
  elapsed = 0;
  won = false;
  currentDiff = newChoice.useSlider ? `se-${targetSEForSlider(newChoice.slider)}` : newChoice.diff;
  currentLabel = result.label;
  currentSE = result.hardest;
  $('diffLabel').textContent = currentLabel;
  /* SE tag only shown for slider-tuned puzzles — hidden on standard bands */
  const seTag = $('diffSe');
  if (newChoice.useSlider) {
    seTag.textContent = `SE ${result.hardest.toFixed(1)}`;
    seTag.hidden = false;
  } else {
    seTag.hidden = true;
  }
  stopTimer();
  renderTimer();
  render();
  save();
  updateStatsRow();
}

function updateStatsRow() {
  const stats = loadStats();
  for (const card of document.querySelectorAll('.diff-card')) {
    const b = stats.best[card.dataset.diff];
    card.querySelector('.dc-stat').textContent = b ? `best ${fmtTime(b)}` : '—';
  }
}

/* ---------- restore (progress survives refresh, offline, and long gaps) ---------- */
async function restoreSave(sd) {
  given = Uint8Array.from(sd.given ?? []);
  board = Uint8Array.from(sd.board ?? []);
  solution = Uint8Array.from(sd.solution ?? []);
  notes = (sd.notes ?? []).map(a => new Set(a));
  history = (sd.history ?? []).map(h => ({ i: h.i, val: h.val, notes: [...(h.notes ?? [])] }));
  elapsed = sd.elapsed | 0;
  mistakes = sd.mistakes | 0;
  hintsUsed = sd.hintsUsed | 0;
  currentDiff = sd.currentDiff ?? 'easy';
  currentLabel = sd.currentLabel ?? 'Easy';
  currentSE = sd.currentSE ?? null;
  won = !!sd.won;
  selected = -1;
  selDigit = 0;
  $('diffLabel').textContent = currentLabel;
  /* SE tag only for slider-tuned puzzles, same rule as applyPuzzle */
  const seTag = $('diffSe');
  if (typeof currentDiff === 'string' && currentDiff.startsWith('se-')) {
    seTag.textContent = currentSE != null ? `SE ${(+currentSE).toFixed(1)}` : '';
    seTag.hidden = currentSE == null;
  } else {
    seTag.hidden = true;
  }
  renderTimer();
  render();
}

/* ---------- menu ---------- */
function openMenu() {
  $('cleanupVal').textContent = settings.cleanup ? 'On' : 'Off';
  $('advanceVal').textContent = settings.advance ? 'On' : 'Off';
  $('themeVal').textContent = settings.theme === 'auto' ? 'Auto' : settings.theme === 'dark' ? 'Dark' : 'Light';
  openSheet('sheetMenu');
}

/* ---------- wiring ---------- */
function wire() {
  $('board').addEventListener('click', (e) => {
    const note = e.target.closest('.n');
    const cell = e.target.closest('.cell');
    if (!cell) return;
    onCellTap(+cell.dataset.i, note ? +note.dataset.d : 0);
  });

  $('btnUndo').addEventListener('click', undo);
  $('btnErase').addEventListener('click', () => erase(selected));
  $('btnNotes').addEventListener('click', () => {
    notesMode = !notesMode;
    $('btnNotes').setAttribute('aria-pressed', String(notesMode));
    $('btnNotes').classList.toggle('on', notesMode);
    vibrate(4);
  });
  $('btnHint').addEventListener('click', requestHint);
  $('btnMenu').addEventListener('click', openMenu);
  $('btnResume').addEventListener('click', resumeGame);

  /* new game sheet */
  $('btnNewCancel').addEventListener('click', () => closeSheet('sheetNew'));
  $('btnNewStart').addEventListener('click', startNewGame);
  document.querySelectorAll('.diff-card').forEach(c => {
    c.addEventListener('click', () => {
      newChoice = { ...newChoice, diff: c.dataset.diff, useSlider: false };
      document.querySelectorAll('.diff-card').forEach(x => x.classList.toggle('sel', x === c));
    });
  });
  $('btnAdvanced').addEventListener('click', () => {
    const p = $('advPanel');
    const opening = p.hidden;
    p.hidden = !opening;
    $('btnAdvanced').setAttribute('aria-expanded', String(opening));
    if (opening) {
      newChoice.useSlider = true;
      document.querySelectorAll('.diff-card').forEach(x => x.classList.remove('sel'));
      updateAdvUI();
    }
  });
  $('advSlider').addEventListener('input', () => {
    newChoice.slider = +$('advSlider').value;
    newChoice.useSlider = true;
    updateAdvUI();
  });

  /* hint / win / menu sheets */
  $('btnHintClose').addEventListener('click', () => closeSheet('sheetHint'));
  $('btnWinClose').addEventListener('click', () => closeSheet('sheetWin'));
  $('btnWinNew').addEventListener('click', () => { closeSheet('sheetWin'); openNewGame(); });
  $('btnMenuClose').addEventListener('click', () => closeSheet('sheetMenu'));
  $('miResume').addEventListener('click', () => closeSheet('sheetMenu'));
  $('miNew').addEventListener('click', () => { closeSheet('sheetMenu'); openNewGame(); });
  $('miTheme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    settings.theme = order[(order.indexOf(settings.theme) + 1) % 3];
    persistSettings();
    applyTheme();
  });
  $('miCleanup').addEventListener('click', () => {
    settings.cleanup = !settings.cleanup;
    persistSettings();
    $('cleanupVal').textContent = settings.cleanup ? 'On' : 'Off';
  });
  $('miAdvance').addEventListener('click', () => {
    settings.advance = !settings.advance;
    persistSettings();
    $('advanceVal').textContent = settings.advance ? 'On' : 'Off';
  });

  for (const id of ['sheetNew', 'sheetHint', 'sheetWin', 'sheetMenu']) bindOverlayClose(id);
}

/* ---------- keyboard (desktop) ---------- */
document.addEventListener('keydown', (e) => {
  if (sheetOpen()) {
    if (e.key === 'Escape') {
      for (const id of ['sheetNew', 'sheetHint', 'sheetWin', 'sheetMenu']) {
        if (!$(id).hidden) { closeSheet(id); break; }
      }
    }
    return;
  }
  const k = e.key;
  if (k >= '1' && k <= '9') { onPad(+k); return; }
  if (k === 'Backspace' || k === 'Delete' || k === '0') { erase(selected); return; }
  if (k === 'n' || k === 'N') { $('btnNotes').click(); return; }
  if (k === 'u' || k === 'U') { undo(); return; }
  if (k === 'h' || k === 'H') { requestHint(); return; }
  if (k.startsWith('Arrow')) {
    e.preventDefault();
    let r = selected < 0 ? 4 : ROW_OF[selected];
    let c = selected < 0 ? 4 : COL_OF[selected];
    if (k === 'ArrowUp') r = (r + 8) % 9;
    if (k === 'ArrowDown') r = (r + 1) % 9;
    if (k === 'ArrowLeft') c = (c + 8) % 9;
    if (k === 'ArrowRight') c = (c + 1) % 9;
    select(r * 9 + c);
  }
});

/* ---------- iOS standalone viewport fix ---------- */
function installViewportFix() {
  const apply = () => {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${h}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', apply);
}

/* ---------- boot ---------- */
async function boot() {
  buildBoard();
  loadSettings();
  wire();
  installViewportFix();

  /* ask for persistent storage so progress survives long gaps (installed PWA) */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}

  /* restore: localStorage first, IndexedDB mirror as fallback — never auto-reset */
  let sd = load(SAVE_KEY);
  if (!sd || !Array.isArray(sd.board) || !sd.board.some(v => v)) {
    sd = await idbGet();
  }
  if (sd && Array.isArray(sd.board) && sd.board.some(v => v)) {
    await restoreSave(sd);
    if (!won && !sheetOpen()) startTimer();
  } else {
    /* first visit ever: nothing to restore, invite a first puzzle */
    render();
    setTimeout(openNewGame, 300);
  }
  updateStatsRow();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
