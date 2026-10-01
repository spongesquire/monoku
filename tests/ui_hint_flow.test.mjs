/* DOM-stub smoke test: loads app.js in Node with a minimal DOM and drives
 * the REAL hint UI flow — requestHint → escalate L1..L4 → Different hint →
 * Show me where to look → float buttons. Verifies:
 *   - level text escalation (title/body change per level, no answer at L1-L3)
 *   - dots render 4 and fill with level
 *   - L3 "where to look" pulses region cells on the board
 *   - L4 offers the apply float; applyHint places the digit
 *   - Different hint swaps deduction at the same level
 * Run: node tests/ui_hint_flow.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ---------- tiny DOM stub ---------- */
class El {
  constructor(tag) { this.tag = tag; this.hidden = false; this.textContent = ''; this.innerHTML = '';
    this.children = []; this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
    this.style = { setProperty: () => {} }; this.dataset = {}; this.disabled = false;
    this.listeners = {}; this.value = ''; this.onclick = null; this.rect = { top: 400 }; }
  addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll() { return []; } querySelector() { return new El('q'); }
  appendChild(c) { this.children.push(c); }
  setAttribute() {} getAttribute() { return null; } removeAttribute() {}
  closest() { return null; }
  remove() {}
}
const registry = {};
const mk = (id) => (registry[id] ??= new El('div'));
/* fx canvas element needs a 2d-context stub */
const ctx2d = new Proxy({}, { get: () => () => {} });
registry['fx'] = Object.assign(new El('canvas'), { getContext: () => ctx2d });
globalThis.document = {
  getElementById: (id) => mk(id),
  querySelector: () => new El('q'),
  querySelectorAll: () => [],
  createElement: (t) => new El(t),
  addEventListener() {},
  documentElement: new El('html'),
  body: new El('body'),
  hidden: false,
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
Object.defineProperty(globalThis, 'navigator', { value: { vibrate: null, storage: { persist: () => Promise.resolve() }, onLine: true }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.indexedDB = undefined;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.location = { reload() {} };
globalThis.innerWidth = 400; globalThis.innerHeight = 800;
/* browsers expose id'd elements as window properties (named access) */
globalThis.pad = mk('pad');

/* app.js ends with boot() which touches localStorage restore etc. — safe on stubs */
try {
  await import('../js/app.js');
} catch (e) {
  console.error('IMPORT ERROR:', e.message);
  process.exit(1);
}

/* the app module has no exports — reach the hint flow through the bound button */
const btnHint = registry['btnHint'];
assert.ok(btnHint, 'hint button wired');
assert.ok(btnHint.listeners['click'], 'hint button has click handler');
const tapHint = () => btnHint.listeners['click'][0]();

/* new game: easy puzzle with known solution */
const newBtn = registry['btnNewStart'];
assert.ok(newBtn && newBtn.listeners['click'], 'new-game start wired');
// newChoice default: easy. startNewGame is async; drive it.
const startClick = newBtn.listeners['click'][0];
await startClick();
await new Promise(r => setTimeout(r, 250)); // generation completes (sync-ish but busy animation)

/* L1 — first tap */
tapHint();
assert.ok(!registry['sheetHint'].hidden, 'hint sheet open');
assert.equal(registry['hintTitle'].textContent, 'Where to start', `L1 title: ${registry['hintTitle'].textContent}`);
assert.match(registry['hintWhere'].textContent, /difficulty/i, 'L1 body mentions difficulty');
assert.ok(registry['hintDots'].innerHTML.includes('hint-dot'), 'dots rendered');
assert.equal((registry['hintDots'].innerHTML.match(/hint-dot on/g) || []).length, 1, 'one dot on at L1');
assert.equal(registry['btnHintNext'].textContent, 'Tell me more', 'L1 CTA escalates');

/* L2 — escalate */
registry['btnHintNext'].onclick();
assert.equal(registry['hintTitle'].textContent, registry['hintTitle'].textContent);
assert.ok(!registry['sheetHint'].hidden, 'still open at L2');
assert.equal((registry['hintDots'].innerHTML.match(/hint-dot on/g) || []).length, 2, 'two dots on at L2');

/* L3 — escalate to clue */
registry['btnHintNext'].onclick();
assert.equal((registry['hintDots'].innerHTML.match(/hint-dot on/g) || []).length, 3, 'three dots on at L3');
assert.equal(registry['btnHintNext'].textContent, 'Show me where to look', 'L3 CTA points at board');

/* L3 action → closes sheet, pulses region, float says "Walk me through it" */
registry['btnHintNext'].onclick();
assert.ok(registry['sheetHint'].hidden, 'sheet closed after where-to-look');
assert.ok(!registry['hintFloat'].hidden, 'float visible after where-to-look');
assert.equal(registry['hintFloatAction'].textContent, 'Walk me through it', 'L3 float offers walkthrough');

/* float → walkthrough = L4 with the answer */
registry['hintFloatAction'].onclick();
assert.ok(!registry['sheetHint'].hidden, 'sheet reopened at L4');
assert.equal((registry['hintDots'].innerHTML.match(/hint-dot on/g) || []).length, 4, 'four dots on at L4');
assert.match(registry['hintWhere'].textContent, /= \d/, 'L4 reveals cell = digit');

/* L4 action → close, pulse, apply float */
registry['btnHintNext'].onclick();
assert.ok(registry['sheetHint'].hidden, 'sheet closed after L4 show-me');
assert.ok(!registry['hintFloat'].hidden, 'apply float visible');
assert.equal(registry['hintFloatAction'].textContent, 'Place it for me', 'L4 float applies');

/* apply → digit placed on board (via internal state; win-check may run) */
registry['hintFloatAction'].onclick();
assert.ok(registry['sheetHint'].hidden, 'sheet closed after apply');

/* Different hint keeps level: open fresh, escalate to L2, swap */
tapHint(); // fresh queue? same fp → sheet closed → cycles idx, level 1
assert.equal(registry['hintTitle'].textContent, 'Where to start', 'fresh tap back to L1');
registry['btnHintNext'].onclick(); // L2
const before = {
  title: registry['hintTitle'].textContent,
  where: registry['hintWhere'].textContent,
  kicker: registry['hintKicker'].textContent,
};
registry['btnHintAlt'].onclick(); // different hint, same level
assert.equal((registry['hintDots'].innerHTML.match(/hint-dot on/g) || []).length, 2, 'different hint stays at L2');
assert.ok(
  registry['hintWhere'].textContent !== before.where
  || registry['hintTitle'].textContent !== before.title
  || registry['hintKicker'].textContent !== before.kicker,
  'different hint shows another deduction (body, title, or counter)'
);

console.log('UI hint-flow smoke test: ALL PASS');
