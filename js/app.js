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
let hintFloatTimer = null;
let rainTimer = null;

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
/* block pinch-zoom + ctrl-wheel zoom (iOS Safari ignores user-scalable) */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
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
    /* peer highlight runs the full row/col/box — filled cells too, so the
     * lighter line reads as one continuous band; empty peers get the
     * stronger wash (they're the actionable ones) */
    c.classList.toggle('peer', selected >= 0 && i !== selected && isPeer(i, selected));
    c.classList.toggle('empty', !v);
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
  renderMistakes();
}

/* mistakes badge: pops in fully labelled on the first mistake, then
 * collapses to icon+count. Re-expands briefly whenever the count rises. */
let mistakesShown = 0;
let mistakesCollapseTimer = null;
function renderMistakes() {
  const wrap = $('mistakesWrap');
  const badge = $('mistakesBadge');
  if (mistakes === 0) {
    wrap.hidden = true;
    wrap.classList.remove('show', 'collapsed');
    mistakesShown = 0;
    return;
  }
  if (wrap.hidden) {
    wrap.hidden = false;
    requestAnimationFrame(() => wrap.classList.add('show'));
  } else if (!wrap.classList.contains('show')) {
    wrap.classList.add('show');
  }
  $('mistakesCount').textContent = String(mistakes);
  $('mistakesText').textContent = mistakes === 1 ? 'mistake' : 'mistakes';
  if (mistakes > mistakesShown) {
    /* fresh mistake: expand, pop, then settle to the compact chip */
    wrap.classList.remove('collapsed');
    badge.classList.remove('pop');
    void badge.offsetWidth; /* restart animation */
    badge.classList.add('pop');
    clearTimeout(mistakesCollapseTimer);
    mistakesCollapseTimer = setTimeout(() => wrap.classList.add('collapsed'), 1600);
  }
  mistakesShown = mistakes;
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
  /* Notes card occupies the pad's 10th slot (bottom-right on tall phones,
   * giving symmetric 5+5 rows; hidden by CSS on single-row layouts) */
  const nk = document.createElement('button');
  nk.className = 'pad-key pk-notes';
  nk.id = 'padNotes';
  nk.setAttribute('aria-label', 'Pencil notes mode');
  nk.setAttribute('aria-pressed', String(notesMode));
  nk.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16.5 3.5 4 4L8 20l-5 1 1-5Z"/></svg><span class="pk-num">Notes</span>';
  if (notesMode) nk.classList.add('on');
  pad.appendChild(nk);
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
    const wasPlaced = lastTap.placed; /* first tap of this pair placed a digit */
    /* double-tap a small note: promote exactly that guess to an answer */
    if (noteDigit && lastTap.note === noteDigit) {
      lastTap = { i: -1, t: 0, note: 0 };
      place(i, noteDigit);
      return;
    }
    const d = board[i] || given[i];
    lastTap = { i: -1, t: 0, note: 0 };
    /* empty cell holding exactly one note: commit it */
    if (!d && notes[i].size === 1) { place(i, [...notes[i]][0]); return; }
    /* double-tap a number on the board: ARM it — every copy lights up and
     * the next empty cell tapped takes that digit. Toggle again to disarm. */
    if (d && !wasPlaced) {
      selDigit = selDigit === d ? 0 : d;
      vibrate(selDigit ? 8 : 5);
    }
    select(i, selDigit === d);
    return;
  }
  lastTap = { i, t: now, note: noteDigit };

  if (!board[i] && !given[i] && selDigit) {
    /* armed digit + empty cell: place (or pencil) immediately */
    lastTap.placed = true;
    if (notesMode) toggleNote(i, selDigit);
    else place(i, selDigit);
    return;
  }
  /* single tap: select and highlight. An armed digit survives only when the
   * tapped number IS the armed digit — tapping another number deselects it. */
  const v = board[i] || given[i];
  select(i, !!v && selDigit === v);
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
  const entry = pushHistory(i);
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
    entry.scrubbed = { d, cells: cleanupNotes(i, d) };
    selected = settings.advance ? findNextEmpty(i) : i;
  }
  /* rapid sequential entry: keep the armed digit armed after placing so
   * the user can tap cell after cell. Auto-disarm only when all 9 copies
   * of the digit are down (nothing left to place). */
  if (selDigit) {
    let n = 0;
    for (let k = 0; k < 81; k++) if (board[k] === selDigit) n++;
    if (n >= 9) selDigit = 0;
  }
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

/* Auto-scrub: placing d removes d from all peer notes (always on - stale
 * notes are worse than no notes). Records removals so undo restores them. */
function cleanupNotes(i, d) {
  const touched = [];
  for (const j of PEERS[i]) {
    if (!board[j] && notes[j].delete(d)) touched.push(j);
  }
  return touched;
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
  /* snapshot + attach any note-scrubs this action performs (filled after
   * the action runs) so a single undo reverts both cell AND peer notes */
  const entry = { i, val: board[i], notes: [...notes[i]], scrubbed: null };
  history.push(entry);
  if (history.length > 300) history.shift();
  return entry;
  if (history.length > 300) history.shift();
}
function undo() {
  const h = history.pop();
  if (!h) return;
  lastTap = { i: -1, t: 0, note: 0 };
  if (h.multi) {
    notes = h.multi.map(a => new Set(a));
    selected = -1;
  } else {
    board[h.i] = h.val;
    notes[h.i] = new Set(h.notes);
    /* restore peer notes this placement had auto-scrubbed */
    if (h.scrubbed) for (const j of h.scrubbed.cells) notes[j].add(h.scrubbed.d);
    selected = h.i;
  }
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
      /* close the sheet FIRST so the board is actually visible, then pulse
       * the target cells and surface a floating pill for the follow-up */
      closeSheet('sheetHint');
      pulseHintTargets(targets);
      showHintFloat(step);
    } else {
      closeSheet('sheetHint');
    }
  };
  openSheet('sheetHint');
}

function pulseHintTargets(targets) {
  for (const i of targets) cells[i].classList.add('hint-target');
  clearTimeout(hintPulseTimer);
  hintPulseTimer = setTimeout(() => {
    document.querySelectorAll('.hint-target').forEach(el => el.classList.remove('hint-target'));
  }, 3400);
}

/* floating pill after "Show me where": offers the final step (place / apply)
 * without covering the board. Sits just above the number pad, auto-hides
 * with the pulse; tap ✕ to dismiss early. */
function showHintFloat(step) {
  const float = $('hintFloat');
  const btn = $('hintFloatAction');
  const isPlace = !!step.placements?.length;
  btn.textContent = isPlace ? 'Place it for me' : 'Apply it';
  /* anchor just above the number pad (fixed positioning, viewport coords) */
  const padTop = $('pad').getBoundingClientRect().top;
  float.style.bottom = `${window.innerHeight - padTop + 10}px`;
  float.hidden = false;
  requestAnimationFrame(() => float.classList.add('show'));
  /* rebind handlers — previous hint's closures must not linger */
  btn.onclick = () => { hideHintFloat(); applyHint(step); };
  $('hintFloatClose').onclick = () => hideHintFloat();
  clearTimeout(hintFloatTimer);
  hintFloatTimer = setTimeout(hideHintFloat, 3400);
}

function hideHintFloat() {
  const float = $('hintFloat');
  clearTimeout(hintFloatTimer);
  if (float.hidden) return;
  float.classList.remove('show');
  /* let the fade-out run before display:none */
  setTimeout(() => { float.hidden = true; }, 260);
}

function applyHint(step) {
  hintsUsed++;
  if (step.placements?.length) {
    const p = step.placements[0];
    const entry = pushHistory(p.i);
    board[p.i] = p.d;
    notes[p.i].clear();
    entry.scrubbed = { d: p.d, cells: cleanupNotes(p.i, p.d) };
    selected = p.i;
    popDigit(p.i, p.d);
  } else if (step.eliminations?.length) {
    for (const e of step.eliminations) notes[e.i].delete(e.d);
  }
  document.querySelectorAll('.hint-target').forEach(el => el.classList.remove('hint-target'));
  hideHintFloat();
  closeSheet('sheetHint');
  checkWin();
  render();
  save();
}


/* ---------- recompute: fill every empty cell with all candidates ---------- */
function recomputeNotes() {
  if (won) return;
  pushHistoryMulti();
  const rainCells = [];
  for (let i = 0; i < 81; i++) {
    if (board[i] || given[i]) continue;
    const cand = candidatesFor(i);
    if (!cand.size) continue;
    notes[i] = cand;
    rainCells.push(i);
  }
  /* Arm the shimmer BEFORE render: note spans persist across renders, so
   * setting class + inline delay now means each freshly-shown note is held
   * at opacity 0 by the animation's backwards fill until its stagger slot
   * arrives — one continuous sweep, no flash-then-restart jitter. */
  for (const i of rainCells) {
    const delay = (ROW_OF[i] * 9 + COL_OF[i]) * 5;
    for (const n of cells[i].querySelectorAll('.n')) {
      const had = n.classList.contains('rain');
      n.style.animationDelay = `${delay}ms`;
      n.classList.remove('rain');
      if (had) void n.offsetWidth; /* restart cleanly if a sweep is mid-flight */
      n.classList.add('rain');
      n.addEventListener('animationend', () => {
        n.classList.remove('rain');
        n.style.animationDelay = '';
      }, { once: true });
    }
  }
  render();
  vibrate([6, 30, 6]);
  save();
}

function candidatesFor(i) {
  const used = new Set();
  for (const j of PEERS[i]) if (board[j]) used.add(board[j]);
  const s = new Set();
  for (let d = 1; d <= 9; d++) if (!used.has(d)) s.add(d);
  return s;
}

/* history entry that restores ALL notes at once (coarse but honest undo) */
function pushHistoryMulti() {
  history.push({ i: -1, val: 0, notes: null, multi: notes.map(s => [...s]) });
}


/* ---------- fx: confetti + celebrations (canvas, non-blocking) ---------- */
const fxCanvas = $('fx');
const fx = fxCanvas.getContext('2d');
let fxParts = [];
let fxRunning = false;

function fxResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  fxCanvas.width = innerWidth * dpr;
  fxCanvas.height = innerHeight * dpr;
  fxCanvas.style.width = innerWidth + 'px';
  fxCanvas.style.height = innerHeight + 'px';
  fx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', fxResize);
fxResize();

function fxTick() {
  if (!fxParts.length) { fxRunning = false; fx.clearRect(0, 0, innerWidth, innerHeight); return; }
  fxRunning = true;
  fx.clearRect(0, 0, innerWidth, innerHeight);
  const favg = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
  for (const p of fxParts) {
    p.vy += 0.12 * favg;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.life--;
    fx.save();
    fx.translate(p.x, p.y);
    fx.rotate(p.rot);
    fx.fillStyle = p.color;
    fx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
    fx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    fx.restore();
  }
  fxParts = fxParts.filter(p => p.life > 0 && p.y < innerHeight + 30);
  requestAnimationFrame(fxTick);
}

const PALETTE_CLEAN = ['#f2b705', '#ffd966', '#fff3b0', '#e8a87c', '#ffffff'];
const PALETTE_WIN   = ['#ff6a3d', '#64b7e8', '#9d8df1', '#5fbf77', '#ffd966'];

function confetti(count, palette) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = document.querySelector('.board').getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    fxParts.push({
      x: rect.left + Math.random() * rect.width,
      y: rect.top + rect.height * (0.15 + Math.random() * 0.5),
      vx: (Math.random() - 0.5) * 3.2,
      vy: -(1.5 + Math.random() * 3.5),
      vr: (Math.random() - 0.5) * 0.25,
      rot: Math.random() * Math.PI,
      w: 5 + Math.random() * 5,
      h: 8 + Math.random() * 7,
      life: 130 + Math.random() * 70,
      color: palette[Math.floor(Math.random() * palette.length)],
    });
  }
  if (!fxRunning) requestAnimationFrame(fxTick);
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
  /* dual celebration: flawless solve gets the golden cascade, a solve
   * with mistakes or hints gets the friendly multi-color party */
  const flawless = mistakes === 0 && hintsUsed === 0;
  if (flawless) {
    cells.forEach((c, i) => {
      setTimeout(() => {
        c.classList.add('gold');
        c.addEventListener('animationend', () => c.classList.remove('gold'), { once: true });
      }, (ROW_OF[i] + COL_OF[i]) * 55 + 120);
    });
    setTimeout(() => confetti(110, PALETTE_CLEAN), 350);
    setTimeout(() => confetti(70, PALETTE_CLEAN), 750);
  } else {
    setTimeout(() => confetti(90, PALETTE_WIN), 300);
    setTimeout(() => confetti(60, PALETTE_WIN), 700);
  }
  vibrate(flawless ? [10, 40, 10, 40, 10, 40, 20] : [10, 60, 10, 60, 30]);
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
  /* deal cascade: stagger every cell by box order */
  const b = $('board');
  b.classList.add('deal');
  cells.forEach((c, i) => {
    c.style.animationDelay = `${(Math.floor(ROW_OF[i] / 3) * 3 + Math.floor(COL_OF[i] / 3)) * 22 + (ROW_OF[i] % 3) * 7 + (COL_OF[i] % 3) * 4}ms`;
  });
  setTimeout(() => {
    b.classList.remove('deal');
    cells.forEach(c => { c.style.animationDelay = ''; });
  }, 1000);
}

function applyPuzzle(result) {
  given = result.puzzle.slice();
  board = result.puzzle.slice();
  solution = result.solution;
  notes = Array.from({ length: 81 }, () => new Set());
  history = [];
  selected = -1;
  selDigit = 0;
  lastTap = { i: -1, t: 0, note: 0 };
  notesMode = false;
  for (const b of [$('btnNotes'), document.getElementById('padNotes')]) {
    if (!b) continue;
    b.setAttribute('aria-pressed', 'false');
    b.classList.remove('on');
  }
  mistakes = 0;
  mistakesShown = 0;
  clearTimeout(mistakesCollapseTimer);
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
  /* restoring mid-game with mistakes: show the compact chip immediately */
  const wrap = $('mistakesWrap');
  if (mistakes > 0) {
    wrap.hidden = false;
    wrap.classList.add('show', 'collapsed');
    $('mistakesCount').textContent = String(mistakes);
    $('mistakesText').textContent = mistakes === 1 ? 'mistake' : 'mistakes';
    mistakesShown = mistakes;
  }
}

/* ---------- menu ---------- */
function openMenu() {
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
  const syncNotesButtons = () => {
    for (const b of [$('btnNotes'), $('padNotes')]) {
      if (!b) continue;
      b.setAttribute('aria-pressed', String(notesMode));
      b.classList.toggle('on', notesMode);
    }
  };
  const toggleNotes = () => {
    notesMode = !notesMode;
    syncNotesButtons();
    vibrate(4);
  };
  $('btnNotes').addEventListener('click', toggleNotes);
  pad.addEventListener('click', (e) => {
    if (e.target.closest('.pk-notes')) toggleNotes();
  });
  $('btnHint').addEventListener('click', requestHint);
  $('miRecompute').addEventListener('click', () => {
    closeSheet('sheetMenu');
    setTimeout(recomputeNotes, 220); /* let the sheet close first */
  });
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

/* ---------- iOS viewport ----------
 * No JS height measurement: visualViewport.height lags behind Safari's
 * live URL-bar animations, and a stale value clips the pad's bottom row
 * (the Notes card). dvh units are recomputed by the engine in real time
 * and never go stale — standalone uses plain 100vh (includes the inset,
 * WebKit bug 254868 workaround). */

/* ---------- boot ---------- */
async function boot() {
  buildBoard();
  loadSettings();
  wire();

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
    /* when a new SW takes over (new deploy), reload once so users are
     * never stuck on a stale mixed-version UI (e.g. old dot logic) */
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
}

boot();
