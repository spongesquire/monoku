/* Hint v2 validation — proves the new hintsFor() contract:
 *   1. never hints on a corrupted board (mistake alert instead)
 *   2. every hint's placement matches the true solution
 *   3. every elimination spares the solution digit
 *   4. cycling yields genuinely different hints (variety)
 *   5. chain-heavy positions get an honest, verified T&E hint
 *   6. full-solve walk: hints always exist until the board is done (or T&E fires)
 * Run: node tests/hint_v2.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generate, hintsFor, candidatesOf, grade, mulberry32, PEERS,
} from '../js/engine.js';

const POP = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };

test('hintsFor: mistake board → single Mistake hint, no logic hints', () => {
  for (let k = 0; k < 10; k++) {
    const r = generate('easy', 3100 + k);
    const bad = r.puzzle.slice();
    const cand = candidatesOf(bad);
    outer: for (let i = 0; i < 81; i++) {
      if (bad[i]) continue;
      for (let d = 1; d <= 9; d++) {
        if (d !== r.solution[i] && (cand[i] & (1 << (d - 1)))) { bad[i] = d; break outer; }
      }
    }
    const hints = hintsFor(bad, r.solution);
    assert.equal(hints.length, 1, `k=${k}: expected exactly the mistake hint`);
    assert.equal(hints[0].tech, 'Mistake');
    assert.deepEqual(hints[0].wrongCells, [bad.findIndex((v, i) => v && v !== r.solution[i])]);
  }
});

test('hintsFor: clean board → every hint valid against the solution', () => {
  for (let k = 0; k < 12; k++) {
    const r = generate(['easy', 'medium', 'hard'][k % 3], 4200 + k);
    for (const h of hintsFor(r.puzzle, r.solution)) {
      for (const p of h.placements ?? []) {
        assert.equal(p.d, r.solution[p.i], `k=${k} ${h.tech} placed ${p.d} at ${p.i}, solution says ${r.solution[p.i]}`);
      }
      for (const e of h.eliminations ?? []) {
        assert.notEqual(e.d, r.solution[e.i], `k=${k} ${h.tech} eliminated solution digit ${e.d} at ${e.i}`);
      }
    }
  }
});

test('hintsFor: mid-game boards (partially solved) stay valid', () => {
  for (let k = 0; k < 8; k++) {
    const r = generate('medium', 5300 + k);
    // play the first N graded steps to reach a realistic mid-game state
    const g = grade(r.puzzle);
    const board = r.puzzle.slice();
    for (const s of g.steps.slice(0, 10 + k * 3)) {
      for (const p of s.placements) board[p.i] = p.d;
    }
    for (const h of hintsFor(board, r.solution)) {
      for (const p of h.placements ?? []) assert.equal(p.d, r.solution[p.i], `${h.tech}`);
      for (const e of h.eliminations ?? []) assert.notEqual(e.d, r.solution[e.i], `${h.tech}`);
    }
  }
});

test('hintsFor: variety — cycling gives different hints on the same board', () => {
  const r = generate('easy', 6400);
  const hints = hintsFor(r.puzzle, r.solution);
  assert.ok(hints.length >= 2, `expected several simultaneous hints, got ${hints.length}`);
  const keys = new Set(hints.map(h => h.hint.what));
  assert.equal(keys.size, hints.length, 'hints should be distinct (deduped by cell+digit)');
});

test('hintsFor: full-solve walk — a valid hint exists at every clean stage', () => {
  for (let k = 0; k < 5; k++) {
    const r = generate(['easy', 'medium', 'hard', 'diabolical'][k], 7300 + k);
    const board = r.puzzle.slice();
    let guard = 0;
    while (board.some(v => !v) && guard++ < 90) {
      const hints = hintsFor(board, r.solution);
      assert.ok(hints.length >= 1, `k=${k} stuck with ${board.filter(v => !v).length} empties`);
      /* play like the app: cycle to an actionable placement (the queue always
       * ends in one — singles, or the verified T&E fallback) */
      const h = hints.find(x => x.placements?.length) ?? hints[0];
      if (h.wrongCells?.length) throw new Error('mistake hint on a clean board');
      const p = h.placements?.[0];
      assert.ok(p, `k=${k} no actionable hint at walk step ${guard} (${hints.map(x => x.tech).join(', ')})`);
      board[p.i] = p.d;
    }
    assert.ok(board.every((v, i) => v === r.solution[i]), `k=${k} walk reached the solution`);
  }
});

test('hintsFor: performance — 20 calls stay snappy (mobile budget)', () => {
  const t0 = Date.now();
  for (let k = 0; k < 20; k++) {
    const r = generate(['easy', 'medium', 'hard', 'diabolical'][k % 4], 8100 + k);
    hintsFor(r.puzzle, r.solution);
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `20 hintsFor calls took ${ms}ms`);
});
