import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveCount, getSolution, generateSolvedGrid, dig, grade, generate,
  labelFor, mulberry32, candidatesOf, nextStep,
} from '../js/engine.js';

const knownPuzzle = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const parse = (s) => Uint8Array.from([...s].map(ch => ch === '.' || ch === '0' ? 0 : +ch));

test('solver: known puzzle has exactly 1 solution', () => {
  assert.equal(solveCount(parse(knownPuzzle), 2), 1);
  const sol = getSolution(parse(knownPuzzle));
  assert.ok(sol);
  assert.equal([...sol].filter(v => v).length, 81);
});

test('solver: empty grid has many solutions (count>=2)', () => {
  assert.ok(solveCount(new Uint8Array(81), 2) >= 2);
});

test('solver: invalid givens rejected', () => {
  const g = new Uint8Array(81);
  g[0] = 5; g[1] = 5; // same row duplicate
  assert.equal(solveCount(g, 2), 0);
});

test('generateSolvedGrid: valid full grid', () => {
  for (let k = 0; k < 5; k++) {
    const g = generateSolvedGrid(mulberry32(k + 1));
    for (const h of [0, 1, 2]) {
      // rows
      for (let r = 0; r < 9; r++) {
        const seen = new Set(Array.from({ length: 9 }, (_, c) => g[r * 9 + c]));
        assert.equal(seen.size, 9, `row ${r}`);
      }
      for (let c = 0; c < 9; c++) {
        const seen = new Set(Array.from({ length: 9 }, (_, r) => g[r * 9 + c]));
        assert.equal(seen.size, 9, `col ${c}`);
      }
      for (let b = 0; b < 9; b++) {
        const cells = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push(g[(b % 3) * 3 + c + (((b / 3) | 0) * 3 + r) * 9]);
        assert.equal(new Set(cells).size, 9, `box ${b}`);
      }
    }
  }
});

test('dig: uniqueness preserved at multiple depths', () => {
  for (let k = 0; k < 3; k++) {
    const sol = generateSolvedGrid(mulberry32(100 + k));
    for (const minClues of [36, 30, 26]) {
      const puz = dig(sol, minClues, mulberry32(200 + k * 10 + minClues));
      assert.equal(solveCount(puz, 2), 1, `k=${k} minClues=${minClues}`);
      const clues = [...puz].filter(v => v).length;
      // symmetric digging removes pairs; it may stall slightly above the floor
      // while uniqueness still holds — the generator retries with new grids.
      assert.ok(clues <= minClues + 4, `clues=${clues} vs target ${minClues}`);
    }
  }
});

test('grade: known easy puzzle grades as singles only', () => {
  const g = grade(parse(knownPuzzle));
  assert.equal(g.solved, true);
  assert.ok(g.hardest <= 2.3, `hardest=${g.hardest}`);
});

test('grade: each step is logically valid (placement matches candidate)', () => {
  const puz = dig(generateSolvedGrid(mulberry32(7)), 30, mulberry32(8));
  const vals = puz.slice();
  for (const step of grade(puz).steps) {
    for (const p of step.placements) {
      const cand = candidatesOf(vals)[p.i];
      assert.ok(cand & (1 << (p.d - 1)), `step ${step.tech} placed d=${p.d} at ${p.i} not in candidates`);
      vals[p.i] = p.d;
    }
  }
});

test('generate: easy/medium/hard/diabolical bands are distinct and unique-solution', () => {
  for (const diff of ['easy', 'medium', 'hard', 'diabolical']) {
    const r = generate(diff, 42 + diff.length);
    assert.equal(solveCount(r.puzzle, 2), 1, `${diff} unique`);
    assert.ok(r.clues >= 17 && r.clues <= 60, `${diff} clues=${r.clues}`);
    assert.ok(r.solution.every((v, i) => !r.puzzle[i] || r.puzzle[i] === v), `${diff} puzzle ⊆ solution`);
  }
});

test('generate: band ordering easy < medium < hard < diabolical by grade', () => {
  const e = generate('easy', 1);
  const m = generate('medium', 2);
  const h = generate('hard', '3'.charCodeAt(0));
  const d = generate('diabolical', 4);
  assert.ok(e.hardest < m.hardest, `easy ${e.hardest} vs medium ${m.hardest}`);
  assert.ok(m.hardest < h.hardest, `medium ${m.hardest} vs hard ${h.hardest}`);
  // hard must fall to the technique ladder; diabolical must NOT (chains required)
  // or grade deeper than hard if it happens to be ladder-solvable.
  const dg = grade(d.puzzle);
  assert.ok(!dg.solved || dg.hardest > h.hardest,
    `diabolical solved=${dg.solved} hardest=${dg.hardest} vs hard ${h.hardest}`);
});

test('generate: diabolical always gradeable by ladder + brute force, and hard', () => {
  for (let k = 0; k < 2; k++) {
    const r = generate('diabolical', 500 + k);
    const g = grade(r.puzzle);
    // Either solved by deep logic or requires T&E — both acceptable for diabolical
    const ok = (g.solved && g.hardest >= 3.0) || (!g.solved);
    assert.ok(ok, `diabolical k=${k} solved=${g.solved} hardest=${g.hardest}`);
    assert.equal(solveCount(r.puzzle, 2), 1);
  }
});

test('nextStep: returns a valid first step for a fresh puzzle', () => {
  const r = generate('easy', 99);
  const s = nextStep(r.puzzle);
  assert.ok(s);
  assert.ok(s.hint && s.hint.tech && s.hint.why);
});

test('labelFor boundaries', () => {
  assert.equal(labelFor(1.0, true), 'Easy');
  assert.equal(labelFor(1.5, true), 'Easy');
  assert.assign || null;
  assert.equal(labelFor(1.7, true), 'Medium');
  assert.equal(labelFor(2.3, true), 'Medium');
  assert.equal(labelFor(2.6, true), 'Hard');
  assert.equal(labelFor(4.4, true), 'Hard');
  assert.equal(labelFor(4.5, true), 'Expert');
  assert.equal(labelFor(0, false), 'Diabolical');
});

test('hint engine works from mid-game state', () => requestHintMidgame());

function requestHintMidgame() {
  const r = generate('medium', 31337);
  const vals = r.puzzle.slice();
  const steps = grade(vals).steps;
  // apply half the singles, then ask for a hint
  let applied = 0;
  for (const s of steps) {
    for (const p of s.placements) {
      vals[p.i] = p.d; applied++;
      if (applied > 8) return assert.ok(nextStep(vals));
    }
  }
  return assert.ok(nextStep(vals));
}
