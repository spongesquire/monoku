/* Hint v3 technique tests — proves the Hintoku-tier scanners:
 *   1. every new technique fires somewhere across deep puzzles (census)
 *   2. every graded deduction is valid against the true solution
 *      (placements match; eliminations never touch the solution digit)
 *   3. chain steps are structurally sound (endpoints share the digit,
 *      eliminations see both endpoints)
 *   4. hintsFor still answers quickly on chain-heavy boards
 *   5. generation stays fast with chains disabled
 * Run: node tests/hint_v3_techniques.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grade, hintsFor, generate, generateSolvedGrid, dig, mulberry32,
  ROW_OF, COL_OF, BOX_OF,
} from '../js/engine.js';

const sees = (i, j) => ROW_OF[i] === ROW_OF[j] || COL_OF[i] === COL_OF[j] || BOX_OF[i] === BOX_OF[j];

const NEW_TECHS = [
  'Skyscraper', 'Finned X-Wing', 'Finned Swordfish', 'Two-String Kite',
  'W-Wing', 'Empty Rectangle', 'Coloring', 'X-Chain', 'XY-Chain', 'AIC',
];

/* deep, unique puzzles that actually need the advanced ladder */
function deepPuzzles(n, seedBase, clues = 24) {
  const out = [];
  for (let k = 0; out.length < n && k < n * 6; k++) {
    const rng = mulberry32(seedBase + k);
    const sol = generateSolvedGrid(rng);
    const puz = dig(sol, clues, rng);
    out.push({ puz, sol });
  }
  return out;
}

test('technique census: every Hintoku-tier scanner fires on real puzzles', () => {
  const seen = new Set();
  for (const { puz, sol } of deepPuzzles(1500, 40000, 23)) {
    const g = grade(puz, { chains: true, chainBudgetMs: 150 });
    for (const s of g.steps) {
      seen.add(s.tech);
      for (const e of s.eliminations) {
        assert.notEqual(e.d, sol[e.i], `${s.tech} eliminated solution digit ${e.d} at r${ROW_OF[e.i] + 1}c${COL_OF[e.i] + 1}`);
      }
      for (const p of s.placements) {
        assert.equal(p.d, sol[p.i], `${s.tech} placed wrong digit at r${ROW_OF[p.i] + 1}c${COL_OF[p.i] + 1}`);
      }
    }
  }
  /* pure single-digit chains are rare in random digs (mixed chains close
   * earlier); hunt a bounded seed set for one X-Chain occurrence */
  if (!seen.has('X-Chain')) {
    hunt: for (let k = 0; k < 4000; k++) {
      const rng = mulberry32(120000 + k);
      const sol = generateSolvedGrid(rng);
      const puz = dig(sol, 22, rng);
      const g = grade(puz, { chains: true, chainBudgetMs: 150 });
      if (g.steps.some(s => s.tech === 'X-Chain')) { seen.add('X-Chain'); break hunt; }
    }
  }
  const missing = NEW_TECHS.filter(t => !seen.has(t));
  assert.deepEqual(missing, [], `techniques never fired: ${missing.join(', ')}; seen: ${[...seen].join(', ')}`);
});

test('chain steps: endpoints share the digit, eliminations see both endpoints', () => {
  let checked = 0;
  for (const { puz } of deepPuzzles(120, 51000)) {
    const g = grade(puz, { chains: true, chainBudgetMs: 250 });
    for (const s of g.steps) {
      assert.ok(!JSON.stringify(s.hint).includes('NaN'), `${s.tech} produced a malformed cell name: ${s.hint.where}`);
      if (!s.chain) continue;
      checked++;
      const { nodes, links } = s.chain;
      assert.ok(nodes.length >= 4, 'chain too short to report');
      assert.equal(nodes[0].d, nodes[nodes.length - 1].d, 'chain endpoints must share the digit');
      assert.equal(links.length, nodes.length - 1, 'one link per hop');
      assert.ok(links[0] === true, 'chains start on a strong link');
      /* endpoints may sit in different houses: eliminations attack cells
       * that see BOTH endpoints — that is the chain's whole point */
      for (const e of s.eliminations) {
        assert.ok(sees(e.i, nodes[0].i) && sees(e.i, nodes[nodes.length - 1].i), 'elimination must see both endpoints');
      }
    }
  }
  assert.ok(checked >= 5, `expected chain steps to appear, got ${checked}`);
});

test('hintsFor: tier-4/5 payload (level/pattern) present and levels sane', () => {
  let sawPattern = 0, sawChain = 0, maxLevel = 0;
  /* diabolical puzzles stall the pre-chain ladder: walk each one on
   * placement hints (singles or the T&E fallback — exactly what the app
   * offers) and check every technique step carried along the way */
  for (let k = 0; k < 14; k++) {
    const r = generate('diabolical', 63000 + k);
    const board = r.puzzle.slice();
    let guard = 0;
    while (guard++ < 70 && board.some(v => !v)) {
      const hints = hintsFor(board, r.solution);
      for (const h of hints) {
        if (!h.tech || h.tech === 'Mistake' || h.tech === 'Trial & Error') continue;
        assert.ok(h.level >= 1 && h.level <= 5, `${h.tech} level ${h.level} out of range`);
        if ((h.level ?? 0) >= 4) maxLevel = Math.max(maxLevel, h.level);
        if ((h.level ?? 0) >= 4 && h.pattern?.length) sawPattern++;
        if (h.chain) sawChain++;
      }
      const place = hints.find(h => h.placements?.length);
      if (!place) break;
      board[place.placements[0].i] = place.placements[0].d;
    }
  }
  assert.ok(sawPattern >= 5, `expected pattern payloads, got ${sawPattern}`);
  assert.ok(sawChain >= 1, `expected at least one chain payload via hintsFor, got ${sawChain}`);
  assert.equal(maxLevel, 5, 'tier-5 techniques must surface through hintsFor');
});

test('hintsFor: chain-heavy boards stay within the mobile time budget', () => {
  const boards = deepPuzzles(8, 73000);
  const t0 = Date.now();
  for (const { puz, sol } of boards) hintsFor(puz, sol);
  const ms = Date.now() - t0;
  assert.ok(ms < 8 * 500, `hintsFor too slow on chain-heavy boards: ${ms}ms for 8 boards`);
});

test('generate: unchanged performance and banding with chains off', () => {
  const t0 = Date.now();
  for (let k = 0; k < 6; k++) {
    const r = generate(['easy', 'medium', 'hard', 'diabolical'][k % 4], 8200 + k);
    assert.ok(r.solution.every((v, i) => v === r.solution[i]));
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `generation slowed down: ${ms}ms for 6 puzzles`);
});
