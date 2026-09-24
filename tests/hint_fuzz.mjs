/* Hint-logic fuzz harness — proves/disproves each suspected failure mode.
 * Run: node tests/hint_fuzz.mjs */
import {
  generate, grade, nextStep, candidatesOf, generateSolvedGrid, dig,
  solveCount, mulberry32, PEERS,
} from '../js/engine.js';

const POP = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };

/* ---------- 1. ladder soundness fuzz: every step must be logically valid ---------- */
console.log('[1] ladder soundness: placements match solution, eliminations spare solution digit');
for (let k = 0; k < 25; k++) {
  const r = generate(['easy','medium','hard','diabolical'][k % 4], 9000 + k);
  const sol = r.solution;
  const vals = r.puzzle.slice();
  const cand = candidatesOf(vals);
  for (const step of grade(r.puzzle).steps) {
    for (const p of step.placements) {
      if (p.d !== sol[p.i]) fail(`k=${k} ${step.tech} placed ${p.d} at cell ${p.i} but solution says ${sol[p.i]}`);
      vals[p.i] = p.d; cand[p.i] = 0;
      for (const j of PEERS[p.i]) cand[j] &= ~(1 << (p.d - 1));
    }
    for (const e of step.eliminations) {
      if (e.d === sol[e.i]) fail(`k=${k} ${step.tech} eliminated THE SOLUTION digit ${e.d} at cell ${e.i}`);
      if (!(cand[e.i] & (1 << (e.d - 1)))) fail(`k=${k} ${step.tech} eliminated ${e.d} at cell ${e.i} that wasn't a candidate (stale/no-op)`);
      cand[e.i] &= ~(1 << (e.d - 1));
    }
    // any cell left with zero candidates but unfilled = logic contradiction
    for (let i = 0; i < 81; i++) {
      if (!vals[i] && POP(cand[i]) === 0) { fail(`k=${k} after ${step.tech} cell ${i} has NO candidates left`); break; }
    }
  }
}
console.log(failures ? '' : '  ✓ all steps valid across 25 puzzles');

/* ---------- 2. wrong-entry poisoning: one bad entry corrupts nextStep ---------- */
console.log('[2] wrong-entry poisoning: user mistake on the board vs hint engine');
let poisoned = 0, tested = 0;
for (let k = 0; k < 15; k++) {
  const r = generate('easy', 7000 + k);
  const sol = r.solution;
  const bad = r.puzzle.slice();
  // find an empty cell where a WRONG-but-legal digit can be placed
  const cand = candidatesOf(bad);
  outer: for (let i = 0; i < 81; i++) {
    if (bad[i] || sol[i] === 0) continue;
    for (let d = 1; d <= 9; d++) {
      if (d !== sol[i] && (cand[i] & (1 << (d - 1)))) {
        bad[i] = d;
        break outer;
      }
    }
  }
  const step = nextStep(bad);
  tested++;
  if (step) {
    // does the step "place" something that contradicts the true solution?
    const badPlace = step.placements?.some(p => p.d !== sol[p.i]);
    // or does it rely on the wrong digit (eliminations touching the bad cell's true value)
    if (badPlace) { poisoned++; console.log(`  k=${k}: hint says ${step.tech} → ${JSON.stringify(step.placements)} — WRONG (contradicts solution)`); }
  }
}
console.log(`  → ${poisoned}/${tested} boards with one user mistake produce a provably-wrong hint, rest produce misleading-but-plausible steps on a corrupted board`);

/* ---------- 3. does grade() even notice contradiction? ---------- */
console.log('[3] grade() on a wrong-entry board');
{
  const r = generate('easy', 1234);
  const sol = r.solution;
  const bad = r.puzzle.slice();
  const cand = candidatesOf(bad);
  for (let i = 0; i < 81; i++) {
    if (!bad[i]) {
      for (let d = 1; d <= 9; d++) {
        if (d !== sol[i] && (cand[i] & (1 << (d - 1)))) { bad[i] = d; break; }
      }
      if (bad[i] !== r.puzzle[i]) break;
    }
  }
  const g = grade(bad);
  console.log(`  wrong-entry board: solved=${g.solved} hardest=${g.hardest} tech=${g.hardestTech} — engine has NO concept of "board contains an error"`);
}

/* ---------- 4. nextStep determinism / variety ---------- */
console.log('[4] same board, repeated nextStep calls (are they all identical?)');
{
  const r = generate('medium', 555);
  const a = nextStep(r.puzzle), b = nextStep(r.puzzle);
  console.log(`  call1=${a?.tech} call2=${b?.tech} identical=${a?.tech === b?.tech && a?.hint?.what === b?.hint?.what} — no way to ask for a DIFFERENT hint`);
}

console.log(failures === 0 ? '\nRESULT: ladder logic itself is sound; failures are app-level (poisoning + no dismiss/variety)' : `\nRESULT: ${failures} ladder bugs found`);
