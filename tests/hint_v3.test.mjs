/* Hint v3 escalation — proves the Hintoku-style progressive contract:
 *   1. every hint carries the teaching layer: region (where to look),
 *      nudge (what the technique is), clue (direction, no answer)
 *   2. levels 1–3 never leak the answer cell or digit
 *   3. level 4 does contain the placement (it IS the walkthrough)
 *   4. regions are sane: 1..27 cells (full house=9, peers=21, fish<=27)
 *   5. mistake hints keep their fix-first behavior
 * Run: node --test tests/hint_v3.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generate, hintsFor, candidatesOf, grade, ROW_OF, COL_OF,
} from '../js/engine.js';

const cellName = (i) => `r${ROW_OF[i] + 1}c${COL_OF[i] + 1}`;

test('escalation: every clean-board hint has region + nudge + clue', () => {
  for (let k = 0; k < 8; k++) {
    const r = generate(['easy', 'medium', 'hard'][k % 3], 9100 + k);
    const hints = hintsFor(r.puzzle, r.solution);
    assert.ok(hints.length >= 1);
    for (const h of hints) {
      assert.ok(Array.isArray(h.region) && h.region.length >= 1 && h.region.length <= 27,
        `${h.tech}: region has ${h.region?.length} cells`);
      assert.ok(typeof h.nudge === 'string' && h.nudge.length > 10, `${h.tech}: nudge missing`);
      assert.ok(typeof h.clue === 'string' && h.clue.length > 10, `${h.tech}: clue missing`);
    }
  }
});

test('escalation: levels 1-3 text never leaks the answer (placement steps)', () => {
  for (let k = 0; k < 8; k++) {
    const r = generate(['easy', 'medium'][k % 2], 9200 + k);
    for (const h of hintsFor(r.puzzle, r.solution)) {
      const p = h.placements?.[0];
      if (!p) continue;
      const lvl12 = `${h.nudge ?? ''}`;
      assert.ok(!lvl12.includes(`= ${p.d}`), `${h.tech} nudge leaks "= ${p.d}"`);
      // clue may name the region but must not state cell = digit
      assert.ok(!h.clue.includes('= '), `${h.tech} clue leaks an assignment: ${h.clue}`);
      // clue must not name the exact target cell for placement steps
      assert.ok(!h.clue.includes(cellName(p.i)), `${h.tech} clue names the answer cell ${cellName(p.i)}`);
    }
  }
});

test('escalation: level 4 (hint.what) does carry the answer', () => {
  const r = generate('easy', 9300);
  const h = hintsFor(r.puzzle, r.solution).find(x => x.placements?.length);
  const p = h.placements[0];
  assert.ok(h.hint.what.includes(`${cellName(p.i)} = ${p.d}`));
});

test('escalation: T&E fallback also has the teaching layer', () => {
  // diabolical puzzles reach T&E after the ladder stalls; walk until found
  let found = null;
  for (let k = 0; k < 6 && !found; k++) {
    const r = generate('diabolical', 9400 + k);
    const board = r.puzzle.slice();
    let guard = 0;
    while (guard++ < 60) {
      const hints = hintsFor(board, r.solution);
      const h = hints.find(x => x.tech === 'Trial & Error');
      if (h) { found = h; break; }
      const placeable = hints.find(x => x.placements?.length);
      if (!placeable) break;
      board[placeable.placements[0].i] = placeable.placements[0].d;
    }
  }
  if (found) { // diabolical generation may land ladder-solvable; assert only when reached
    assert.ok(found.region.length >= 1 && found.region.length <= 27);
    assert.ok(found.nudge && found.clue);
  }
});

test('escalation: mistake hint unchanged — fix-first, no logic hints', () => {
  const r = generate('easy', 9500);
  const bad = r.puzzle.slice();
  const cand = candidatesOf(bad);
  outer: for (let i = 0; i < 81; i++) {
    if (bad[i]) continue;
    for (let d = 1; d <= 9; d++) {
      if (d !== r.solution[i] && (cand[i] & (1 << (d - 1)))) { bad[i] = d; break outer; }
    }
  }
  const hints = hintsFor(bad, r.solution);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].tech, 'Mistake');
  assert.ok(Array.isArray(hints[0].wrongCells) && hints[0].wrongCells.length === 1);
});

test('escalation: mid-game technique steps keep the teaching layer', () => {
  for (let k = 0; k < 6; k++) {
    const r = generate('hard', 9600 + k);
    const g = grade(r.puzzle);
    const board = r.puzzle.slice();
    // advance past the singles phase to surface technique steps
    let techSeen = 0;
    for (const s of g.steps) {
      for (const p of s.placements) board[p.i] = p.d;
      if (s.eliminations?.length) techSeen++;
      if (techSeen >= 2) break;
    }
    for (const h of hintsFor(board, r.solution)) {
      if (!h.eliminations?.length) continue; // technique (elimination) steps only
      assert.ok(h.region.length >= 1, `${h.tech}: no region mid-game`);
      assert.ok(h.nudge, `${h.tech}: no nudge mid-game`);
      assert.ok(h.clue, `${h.tech}: no clue mid-game`);
    }
  }
});
