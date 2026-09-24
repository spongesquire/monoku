/* Paper & Ink Sudoku — engine
 * Pure ES module, no dependencies. Runs in browser, worker, and node.
 *
 * Exports:
 *   solveCount(grid, limit, rng?) -> number of solutions (capped at limit)
 *   getSolution(grid) -> Uint8Array | null
 *   generateSolvedGrid(rng?) -> Uint8Array
 *   dig(solution, targetClues, rng?) -> Uint8Array (unique-solution puzzle)
 *   grade(puzzle) -> { solved, hardest, hardestTech, score, steps }
 *   nextStep(board) -> step | null        (first logical step from this state)
 *   generate(target) -> { puzzle, solution, label, hardest, clues, attempts }
 *   labelFor(hardest, solved) -> 'Easy'|'Medium'|'Hard'|'Diabolical'
 *   targetSEForSlider(v) -> number        (slider 0..100 -> SE target)
 *   candidatesOf(grid) -> Int16Array      (bitmask per cell, 0 if filled)
 */

export const ALL = 0x1ff;
const POP = new Uint8Array(512);
for (let m = 0; m < 512; m++) {
  let c = 0, x = m;
  while (x) { c += x & 1; x >>= 1; }
  POP[m] = c;
}
const BIT = []; // digit -> bit
for (let d = 0; d <= 9; d++) BIT[d] = 1 << (d - 1);

export const ROW_OF = new Uint8Array(81);
export const COL_OF = new Uint8Array(81);
export const BOX_OF = new Uint8Array(81);
export const PEERS = []; // 20 peer indices per cell
for (let i = 0; i < 81; i++) {
  const r = (i / 9) | 0, c = i % 9;
  ROW_OF[i] = r; COL_OF[i] = c; BOX_OF[i] = ((r / 3) | 0) * 3 + ((c / 3) | 0);
}
for (let i = 0; i < 81; i++) {
  const s = new Set();
  for (let j = 0; j < 81; j++) {
    if (j === i) continue;
    if (ROW_OF[j] === ROW_OF[i] || COL_OF[j] === COL_OF[i] || BOX_OF[j] === BOX_OF[i]) s.add(j);
  }
  PEERS.push([...s]);
}
const HOUSES = []; // 27 houses, each an array of 9 cell indices
for (let r = 0; r < 9; r++) HOUSES.push({ type: 'row', idx: r, cells: [...Array(9)].map((_, c) => r * 9 + c) });
for (let c = 0; c < 9; c++) HOUSES.push({ type: 'col', idx: c, cells: [...Array(9)].map((_, r) => r * 9 + c) });
for (let b = 0; b < 9; b++) {
  const cells = [];
  const r0 = ((b / 3) | 0) * 3, c0 = (b % 3) * 3;
  for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) cells.push(r * 9 + c);
  HOUSES.push({ type: 'box', idx: b, cells });
}
export { HOUSES };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------- counting solver (bitmask + MRV) ---------- */

export function solveCount(grid, limit = 2, rng = null, outSolution = null) {
  const rows = new Uint16Array(9), cols = new Uint16Array(9), boxes = new Uint16Array(9);
  const empties = [];
  for (let i = 0; i < 81; i++) {
    const v = grid[i];
    if (v) {
      const b = BIT[v], r = ROW_OF[i], c = COL_OF[i], bx = BOX_OF[i];
      if ((rows[r] | cols[c] | boxes[bx]) & b) return 0; // invalid givens
      rows[r] |= b; cols[c] |= b; boxes[bx] |= b;
    } else empties.push(i);
  }
  const sol = grid.slice();
  let count = 0;
  const rec = () => {
    if (count >= limit) return;
    let best = -1, bestMask = 0, bestN = 10;
    for (const i of empties) {
      if (sol[i]) continue;
      const mask = ALL & ~(rows[ROW_OF[i]] | cols[COL_OF[i]] | boxes[BOX_OF[i]]);
      const n = POP[mask];
      if (n === 0) return;
      if (n < bestN) { bestN = n; best = i; bestMask = mask; if (n === 1) break; }
    }
    if (best === -1) { count++; if (count === 1 && outSolution) outSolution.set(sol); return; }
    const r = ROW_OF[best], c = COL_OF[best], bx = BOX_OF[best];
    const digits = [];
    for (let d = 1; d <= 9; d++) if (bestMask & BIT[d]) digits.push(d);
    if (rng) shuffle(digits, rng);
    for (const d of digits) {
      const b = BIT[d];
      sol[best] = d; rows[r] |= b; cols[c] |= b; boxes[bx] |= b;
      rec();
      sol[best] = 0; rows[r] &= ~b; cols[c] &= ~b; boxes[bx] &= ~b;
      if (count >= limit) return;
    }
  };
  rec();
  return count;
}

export function getSolution(grid) {
  const out = new Uint8Array(81);
  const n = solveCount(grid, 1, null, out);
  return n === 1 ? out : null;
}

export function generateSolvedGrid(rng = Math.random) {
  const out = new Uint8Array(81);
  solveCount(new Uint8Array(81), 1, rng, out);
  return out;
}

/* ---------- clue digging (uniqueness-preserving) ---------- */

export function dig(solution, minClues, rng = Math.random) {
  const puz = solution.slice();
  const order = shuffle([...Array(41)].map((_, i) => i), rng);
  let clues = 81;
  for (const i of order) {
    if (clues <= minClues) break;
    const cells = i === 40 ? [40] : [i, 80 - i];
    const saved = cells.map((c) => puz[c]);
    for (const c of cells) puz[c] = 0;
    if (solveCount(puz, 2) === 1) clues -= cells.length;
    else cells.forEach((c, k) => { puz[c] = saved[k]; });
  }
  return puz;
}

/* ---------- candidate computation ---------- */

export function candidatesOf(grid) {
  const rows = new Uint16Array(9), cols = new Uint16Array(9), boxes = new Uint16Array(9);
  for (let i = 0; i < 81; i++) {
    const v = grid[i];
    if (v) { const b = BIT[v]; rows[ROW_OF[i]] |= b; cols[COL_OF[i]] |= b; boxes[BOX_OF[i]] |= b; }
  }
  const cand = new Int16Array(81);
  for (let i = 0; i < 81; i++) {
    if (grid[i]) continue;
    cand[i] = ALL & ~(rows[ROW_OF[i]] | cols[COL_OF[i]] | boxes[BOX_OF[i]]);
  }
  return cand;
}

/* ---------- grader / hint engine ----------
 * Technique ladder with SE-style weights (SudokuExplainer-informed).
 * Each scanner returns a step object or null. Steps carry hint strings:
 *   { tech, weight, placements:[{i,d}], eliminations:[{i,d}], hint:{tech,where,what,why} }
 */

const cellName = (i) => `r${ROW_OF[i] + 1}c${COL_OF[i] + 1}`;
const digitsOf = (mask) => { const a = []; for (let d = 1; d <= 9; d++) if (mask & BIT[d]) a.push(d); return a; };
const houseName = (h) => h.type === 'box' ? `box ${h.idx + 1}` : h.type === 'row' ? `row ${h.idx + 1}` : `column ${h.idx + 1}`;
const plural = (n, s, p) => n === 1 ? s : (p ?? s + 's');

function mkStep(tech, weight, placements, eliminations, where, what, why) {
  return { tech, weight, placements: placements ?? [], eliminations: eliminations ?? [], hint: { tech, where, what, why } };
}

function scanFullHouse(vals, cand) {
  for (const h of HOUSES) {
    let empty = -1, count = 0, mask = 0;
    for (const i of h.cells) {
      if (vals[i]) mask |= BIT[vals[i]];
      else { empty = i; count++; }
    }
    if (count === 1) {
      const d = digitsOf(ALL & ~mask)[0];
      return mkStep('Full House', 1.0, [{ i: empty, d }], [],
        `${cap(houseName(h))} has just one empty cell`,
        `${cellName(empty)} = ${d}`,
        `Every house must contain 1–9 exactly once. ${cap(houseName(h))} already has every digit except ${d}, and ${cellName(empty)} is its only empty cell.`);
    }
  }
  return null;
}

function scanHiddenSingle(vals, cand, boxFirst) {
  const groups = boxFirst ? HOUSES.filter(h => h.type === 'box') : HOUSES.filter(h => h.type !== 'box');
  for (const h of groups) {
    for (let d = 1; d <= 9; d++) {
      const b = BIT[d];
      let spot = -1, n = 0;
      for (const i of h.cells) { if (!vals[i] && (cand[i] & b)) { spot = i; n++; if (n > 1) break; } }
      if (n === 1 && spot >= 0) {
        return mkStep('Hidden Single', boxFirst ? 1.2 : 1.5, [{ i: spot, d }], [],
          `In ${houseName(h)}, digit ${d} fits in only one place`,
          `${cellName(spot)} = ${d}`,
          `Every other cell in ${houseName(h)} is blocked for ${d} by a ${d} in its row or column.`);
      }
    }
  }
  return null;
}

function scanNakedSingle(vals, cand) {
  for (let i = 0; i < 81; i++) {
    if (vals[i] || POP[cand[i]] !== 1) continue;
    const d = digitsOf(cand[i])[0];
    return mkStep('Naked Single', 2.3, [{ i, d }], [],
      `${cellName(i)} has exactly one candidate left`,
      `${cellName(i)} = ${d}`,
      `Every other digit already appears in ${cellName(i)}'s row, column, or box — only ${d} can go there.`);
  }
  return null;
}

function scanPointing(vals, cand) {
  for (const h of HOUSES) {
    if (h.type !== 'box') continue;
    for (let d = 1; d <= 9; d++) {
      const b = BIT[d];
      const spots = h.cells.filter(i => !vals[i] && (cand[i] & b));
      if (spots.length < 2) continue;
      const rows = new Set(spots.map(i => ROW_OF[i])), cols = new Set(spots.map(i => COL_OF[i]));
      const line = rows.size === 1 ? { t: 'row', v: [...rows][0] } : cols.size === 1 ? { t: 'col', v: [...cols][0] } : null;
      if (!line) continue;
      const lineName = line.t === 'row' ? `row ${line.v + 1}` : `column ${line.v + 1}`;
      const elim = [];
      for (const i of HOUSES[line.t === 'row' ? line.v : 9 + line.v].cells) {
        if (!vals[i] && (cand[i] & b) && BOX_OF[i] !== h.idx) elim.push({ i, d });
      }
      if (!elim.length) continue;
      return mkStep('Pointing', 2.6, [], elim,
        `In ${houseName(h)}, all candidates for ${d} sit in ${lineName}`,
        `Remove ${d} from the rest of ${lineName}`,
        `Wherever ${d} goes in ${houseName(h)}, it lands in ${lineName} — so no other cell in ${lineName} can be ${d}.`);
    }
  }
  return null;
}

function scanClaiming(vals, cand) {
  for (const h of HOUSES) {
    if (h.type === 'box') continue;
    for (let d = 1; d <= 9; d++) {
      const b = BIT[d];
      const spots = h.cells.filter(i => !vals[i] && (cand[i] & b));
      if (spots.length < 2) continue;
      const boxes = new Set(spots.map(i => BOX_OF[i]));
      if (boxes.size !== 1) continue;
      const bx = [...boxes][0];
      const elim = [];
      for (const i of HOUSES[18 + bx].cells) {
        if (!vals[i] && (cand[i] & b) && !h.cells.includes(i)) elim.push({ i, d });
      }
      if (!elim.length) continue;
      return mkStep('Claiming', 2.8, [], elim,
        `In ${houseName(h)}, all candidates for ${d} sit in box ${bx + 1}`,
        `Remove ${d} from the rest of box ${bx + 1}`,
        `${cap(houseName(h))} must place its ${d} inside box ${bx + 1}, so the rest of that box can't be ${d}.`);
    }
  }
  return null;
}

function subsetsInHouse(h, vals, cand, size, naked) {
  const cells = h.cells.filter(i => !vals[i]);
  if (cells.length < size + 1) return null;
  if (naked) {
    // n cells whose union of candidates has size n
    const pick = (start, chosen, union) => {
      if (chosen.length === size) {
        if (POP[union] === size) {
          const elim = [];
          for (const i of h.cells) {
            if (vals[i] || chosen.includes(i)) continue;
            for (const d of digitsOf(cand[i] & union)) elim.push({ i, d });
          }
          if (elim.length) {
            const ds = digitsOf(union);
            return mkStep(`Naked ${size === 2 ? 'Pair' : size === 3 ? 'Triple' : 'Quad'}`, [3.0, 3.6, 5.0][size - 2], [], elim,
              `${chosen.map(cellName).join(' and ')} in ${houseName(h)} hold only {${ds.join(',')}}`,
              `Remove ${ds.join(',')} from the rest of ${houseName(h)}`,
              `Those ${size} ${plural(size, 'cell')} must take the ${size} ${plural(size, 'digit')} {${ds.join(',')}} in some order, so no other cell in ${houseName(h)} can use them.`);
          }
        }
        return null;
      }
      for (let k = start; k < cells.length; k++) {
        const m = cand[cells[k]];
        if (POP[m] > size) continue;
        const r = pick(k + 1, [...chosen, cells[k]], union | m);
        if (r) return r;
      }
      return null;
    };
    return pick(0, [], 0);
  } else {
    // hidden: n digits whose possible cells union has size n
    const spots = {};
    for (let d = 1; d <= 9; d++) {
      const b = BIT[d];
      const s = h.cells.filter(i => !vals[i] && (cand[i] & b));
      if (s.length >= 2 && s.length <= size) spots[d] = s;
    }
    const ds = Object.keys(spots).map(Number);
    const pick = (start, chosen, unionCells, unionMask) => {
      if (chosen.length === size) {
        if (unionCells.size === size) {
          const elim = [];
          for (const i of unionCells) {
            for (const d of digitsOf(cand[i] & ~unionMask)) elim.push({ i, d });
          }
          if (elim.length) {
            const names = [...unionCells].map(cellName).join(' and ');
            return mkStep(`Hidden ${size === 2 ? 'Pair' : size === 3 ? 'Triple' : 'Quad'}`, [3.4, 4.0, 5.4][size - 2], [], elim,
              `In ${houseName(h)}, digits {${chosen.join(',')}} fit only in ${names}`,
              `Keep only {${chosen.join(',')}} in those cells`,
              `Those ${size} ${plural(size, 'digit')} must occupy those ${size} ${plural(size, 'cell')} — every other candidate there is impossible.`);
          }
        }
        return null;
      }
      for (let k = start; k < ds.length; k++) {
        const d = ds[k], s = new Set([...unionCells, ...spots[d]]);
        if (s.size > size) continue;
        const r = pick(k + 1, [...chosen, d], s, unionMask | BIT[d]);
        if (r) return r;
      }
      return null;
    };
    return pick(0, [], new Set(), 0);
  }
}

function scanFish(vals, cand, size) {
  const name = size === 2 ? 'X-Wing' : size === 3 ? 'Swordfish' : 'Jellyfish';
  const weight = [3.2, 3.8, 5.2][size - 2];
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (const orient of [0, 1]) { // 0: base rows cover cols, 1: base cols cover rows
      const lines = [[], [], [], [], [], [], [], [], []];
      for (let i = 0; i < 81; i++) {
        if (vals[i] || !(cand[i] & b)) continue;
        lines[orient === 0 ? ROW_OF[i] : COL_OF[i]].push(orient === 0 ? COL_OF[i] : ROW_OF[i]);
      }
      const candLines = [];
      for (let k = 0; k < 9; k++) if (lines[k].length >= 2 && lines[k].length <= size) candLines.push(k);
      if (candLines.length < size) continue;
      const pick = (start, chosen) => {
        if (chosen.length === size) {
          const cover = new Set();
          chosen.forEach(k => lines[k].forEach(c => cover.add(c)));
          if (cover.size !== size) return null;
          const elim = [];
          for (let i = 0; i < 81; i++) {
            if (vals[i] || !(cand[i] & b)) continue;
            const li = orient === 0 ? ROW_OF[i] : COL_OF[i];
            const ci = orient === 0 ? COL_OF[i] : ROW_OF[i];
            if (!chosen.includes(li) && cover.has(ci)) elim.push({ i, d });
          }
          if (!elim.length) return null;
          const baseN = (n) => orient === 0 ? `row ${n + 1}` : `column ${n + 1}`;
          const covN = (n) => orient === 0 ? `column ${n + 1}` : `row ${n + 1}`;
          return mkStep(name, weight, [], elim,
            `Digit ${d} forms a ${name} in ${chosen.map(baseN).join(' and ')} (${[...cover].sort().map(covN).join(' and ')})`,
            `Remove ${d} from ${[...cover].sort().map(covN).join(' and ')} outside the base ${orient === 0 ? 'rows' : 'columns'}`,
            `In each base ${orient === 0 ? 'row' : 'column'}, ${d} can only use the cover ${orient === 0 ? 'columns' : 'rows'} — so those lines' ${d}s belong to the base, and no other cell there can be ${d}.`);
        }
        for (let k = start; k < candLines.length; k++) {
          const r = pick(k + 1, [...chosen, candLines[k]]);
          if (r) return r;
        }
        return null;
      };
      const r = pick(0, []);
      if (r) return r;
    }
  }
  return null;
}

function scanXYWing(vals, cand) {
  const bivalue = [];
  for (let i = 0; i < 81; i++) if (!vals[i] && POP[cand[i]] === 2) bivalue.push(i);
  for (const p of bivalue) {
    const [x, y] = digitsOf(cand[p]);
    const wings = bivalue.filter(i => i !== p && PEERS[p].includes(i) && POP[cand[i] & ~cand[p]] === 1 && !(cand[i] & BIT[x] && cand[i] & BIT[y]));
    for (let a = 0; a < wings.length; a++) for (let b2 = a + 1; b2 < wings.length; b2++) {
      const w1 = wings[a], w2 = wings[b2];
      const zMask = cand[w1] & cand[w2] & ~cand[p];
      if (POP[zMask] !== 1) continue;
      if ((cand[w1] & BIT[x] ? 1 : 0) + (cand[w2] & BIT[x] ? 1 : 0) !== 1) continue;
      const z = digitsOf(zMask)[0];
      const elim = [];
      for (let i = 0; i < 81; i++) {
        if (vals[i] || i === p || i === w1 || i === w2) continue;
        if (PEERS[w1].includes(i) && PEERS[w2].includes(i) && (cand[i] & BIT[z])) elim.push({ i, d: z });
      }
      if (!elim.length) continue;
      return mkStep('XY-Wing', 4.2, [], elim,
        `XY-Wing with pivot ${cellName(p)} {${x},${y}} and pincers ${cellName(w1)} and ${cellName(w2)}`,
        `Remove ${z} from cells seeing both pincers`,
        `The pivot is ${x} or ${y}. If it's ${x}, the ${y}-wing takes ${z}; if it's ${y}, the ${x}-wing takes ${z}. Either way, any cell seeing both pincers can't be ${z}.`);
    }
  }
  return null;
}

function scanXYZWing(vals, cand) {
  const tri = [];
  for (let i = 0; i < 81; i++) if (!vals[i] && POP[cand[i]] === 3) tri.push(i);
  const bivalue = [];
  for (let i = 0; i < 81; i++) if (!vals[i] && POP[cand[i]] === 2) bivalue.push(i);
  for (const p of tri) {
    const ds = digitsOf(cand[p]);
    const wings = bivalue.filter(i => PEERS[p].includes(i) && POP[cand[i] & ~cand[p]] === 1);
    for (let a = 0; a < wings.length; a++) for (let b = a + 1; b < wings.length; b++) {
      const w1 = wings[a], w2 = wings[b];
      const zMask = cand[w1] & cand[w2] & cand[p];
      if (POP[zMask] !== 1) continue;
      if ((cand[w1] | cand[w2] | cand[p]) !== cand[p]) continue;
      const z = digitsOf(zMask)[0];
      const elim = [];
      for (let i = 0; i < 81; i++) {
        if (vals[i] || i === p || i === w1 || i === w2) continue;
        if (PEERS[w1].includes(i) && PEERS[w2].includes(i) && PEERS[p].includes(i) && (cand[i] & BIT[z])) elim.push({ i, d: z });
      }
      if (!elim.length) continue;
      const others = ds.filter(d => d !== z);
      return mkStep('XYZ-Wing', 4.4, [], elim,
        `XYZ-Wing with pivot ${cellName(p)} {${ds.join(',')}} and pincers ${cellName(w1)} and ${cellName(w2)}`,
        `Remove ${z} from cells seeing all three cells`,
        `The pivot takes one of {${ds.join(',')}}. Whichever it is, ${z} lands in the pivot or a pincer — cells seeing all three can't be ${z}.`);
    }
  }
  return null;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const LADDER = [
  (v, c) => scanFullHouse(v, c),
  (v, c) => scanHiddenSingle(v, c, true),
  (v, c) => scanHiddenSingle(v, c, false),
  (v, c) => scanNakedSingle(v, c),
  (v, c) => scanPointing(v, c),
  (v, c) => scanClaiming(v, c),
  (v, c) => subsetsInHouse2(v, c, 2, true),   // naked pair 3.0
  (v, c) => scanFish(v, c, 2),                // x-wing 3.2
  (v, c) => subsetsInHouse2(v, c, 2, false),  // hidden pair 3.4
  (v, c) => subsetsInHouse2(v, c, 3, true),   // naked triple 3.6
  (v, c) => scanFish(v, c, 3),                // swordfish 3.8
  (v, c) => subsetsInHouse2(v, c, 3, false),  // hidden triple 4.0
  (v, c) => scanXYWing(v, c),                 // 4.2
  (v, c) => scanXYZWing(v, c),                // 4.4
  (v, c) => subsetsInHouse2(v, c, 4, true),   // naked quad 5.0
  (v, c) => scanFish(v, c, 4),                // jellyfish 5.2
  (v, c) => subsetsInHouse2(v, c, 4, false),  // hidden quad 5.4
];
function subsetsInHouse2(vals, cand, size, naked) {
  for (const h of HOUSES) {
    const r = subsetsInHouse(h, vals, cand, size, naked);
    if (r) return r;
  }
  return null;
}

export function grade(puzzle) {
  const vals = puzzle.slice();
  const cand = candidatesOf(vals);
  const steps = [];
  let hardest = 0, hardestTech = null, score = 0;
  for (;;) {
    let empty = false;
    for (let i = 0; i < 81; i++) if (!vals[i]) { empty = true; break; }
    if (!empty) return { solved: true, hardest, hardestTech, score, steps };
    let step = null;
    for (const t of LADDER) { step = t(vals, cand); if (step) break; }
    if (!step) return { solved: false, hardest, hardestTech, score, steps };
    steps.push(step);
    score += step.weight;
    if (step.weight > hardest) { hardest = step.weight; hardestTech = step.tech; }
    for (const p of step.placements) {
      const { i, d } = p;
      vals[i] = d; cand[i] = 0;
      for (const j of PEERS[i]) cand[j] &= ~BIT[d];
    }
    for (const e of step.eliminations) cand[e.i] &= ~BIT[e.d];
  }
}

export function nextStep(board) {
  return grade(board).steps[0] ?? null;
}

/* ---------- hint engine v2: honest, multi-step, mistake-aware ----------
 * hintsFor(board, solution) is what the app calls. It returns an ARRAY of
 * candidate hints (all valid from the current position, best first) so the
 * UI can offer "show me a different hint". Ordered:
 *   1. mistake alert      — user entries that contradict the solution
 *   2. all singles        — every Full House / Hidden / Naked Single that
 *                           applies right now (variety, not one fixed hint)
 *   3. first ladder step  — pointing/claiming/subsets/fish/wings
 *   4. T&E fallback       — verified next cell (for chain-heavy positions
 *                           the ladder can't explain; states it plainly)
 * Trailing chained steps (what the chosen deduction unlocks) are attached
 * as `next` for "and then…" context — never shown as the main hint.
 */
export function hintsFor(board, solution, notesMasks = null) {
  const out = [];

  /* 1. wrong user entries poison every deduction — flag them first and
   *    refuse to hint on a corrupted board. */
  const wrong = [];
  for (let i = 0; i < 81; i++) {
    if (board[i] && board[i] !== solution[i]) wrong.push(i);
  }
  if (wrong.length) {
    const names = wrong.map(cellName).join(', ');
    out.push({
      tech: 'Mistake', weight: 0, placements: [], eliminations: [],
      wrongCells: wrong,
      hint: {
        tech: 'Check your entries first',
        where: wrong.length === 1 ? `${cellName(wrong[0])} looks wrong` : `${wrong.length} cells conflict with the solution`,
        what: `${names} ${wrong.length === 1 ? 'doesn\u2019t match' : 'don\u2019t match'} the puzzle\u2019s solution`,
        why: `Hints follow logic from what\u2019s on the board. Clear the red ${wrong.length === 1 ? 'entry' : 'entries'} (or undo) and hints will guide you from a clean position.`,
      },
    });
    return out; // no logic hints on a corrupted board — they'd be nonsense
  }

  const vals = board.slice();
  const cand = candidatesOf(vals);
  /* Notes are used ONLY to filter, never to derive: an elimination the
   * player already applied (it's gone from their notes) must not re-offer.
   * Deriving FROM notes would let incomplete notes fabricate false hints. */
  const notesHave = (i, d) => (notesMasks ? (notesMasks[i] & BIT[d]) !== 0 : true);

  /* 2. all simultaneous singles: full houses, hidden singles, naked singles.
   *    Each is independently true right now — a fresh, different hint per tap. */
  for (const h of HOUSES) {
    let empty = -1, count = 0, mask = 0;
    for (const i of h.cells) {
      if (vals[i]) mask |= BIT[vals[i]];
      else { empty = i; count++; }
    }
    if (count === 1) {
      const d = digitsOf(ALL & ~mask)[0];
      out.push(mkStep('Full House', 1.0, [{ i: empty, d }], [],
        `${cap(houseName(h))} has just one empty cell`,
        `${cellName(empty)} = ${d}`,
        `Every house must contain 1–9 exactly once. ${cap(houseName(h))} already has every digit except ${d}, and ${cellName(empty)} is its only empty cell.`));
    }
  }

  // hidden singles: every house × digit with exactly one spot
  for (const h of HOUSES) {
    for (let d = 1; d <= 9; d++) {
      const b = BIT[d];
      let spot = -1, n = 0;
      for (const i of h.cells) { if (!vals[i] && (cand[i] & b)) { spot = i; n++; if (n > 1) break; } }
      if (n === 1 && spot >= 0) {
        out.push(mkStep('Hidden Single', h.type === 'box' ? 1.2 : 1.5, [{ i: spot, d }], [],
          `In ${houseName(h)}, digit ${d} fits in only one place`,
          `${cellName(spot)} = ${d}`,
          `Every other cell in ${houseName(h)} is blocked for ${d} by a ${d} in its row or column.`));
      }
    }
  }

  // naked singles: every cell with exactly one candidate
  for (let i = 0; i < 81; i++) {
    if (vals[i] || cand[i] === 0 || POP[cand[i]] !== 1) continue;
    const d = digitsOf(cand[i])[0];
    out.push(mkStep('Naked Single', 2.3, [{ i, d }], [],
      `${cellName(i)} has exactly one candidate left`,
      `${cellName(i)} = ${d}`,
      `Every other digit already appears in ${cellName(i)}'s row, column, or box — only ${d} can go there.`));
  }

  /* dedupe: a full house IS a hidden single, and one cell can be found from
   * several houses — same cell+digit is the same hint to the player.
   * Keep the first occurrence (full house → hidden → naked order). */
  {
    const seen = new Set();
    const deduped = [];
    for (const s of out) {
      const p = s.placements[0];
      if (!p) { deduped.push(s); continue; }
      const key = `${p.i}:${p.d}`;
      if (seen.has(key)) continue;
      seen.add(key); deduped.push(s);
    }
    out.length = 0; out.push(...deduped);
  }

  /* chained lookahead for singles: "and then…" — apply the placement,
   * see what it unlocks (next two singles-level steps). Pedagogically
   * this teaches players to spot cascades, and it's cheap to compute. */
  for (const s of out) {
    const vals2 = vals.slice(), cand2 = cand.slice();
    for (const p of s.placements) {
      vals2[p.i] = p.d; cand2[p.i] = 0;
      for (const j of PEERS[p.i]) cand2[j] &= ~BIT[p.d];
    }
    const trail = [];
    for (let k = 0; k < 2; k++) {
      const s2 = firstSingleStep(vals2, cand2);
      if (!s2) break;
      trail.push(s2);
      for (const p of s2.placements) {
        vals2[p.i] = p.d; cand2[p.i] = 0;
        for (const j of PEERS[p.i]) cand2[j] &= ~BIT[p.d];
      }
    }
    if (trail.length) s.next = trail;
  }

  /* 3. one deeper technique step (pointing/claiming/subsets/fish/wings) —
   *    always appended after the singles so cycling can reach it. It is a
   *    true statement about the current position even while singles exist. */
  {
    let step = firstTechniqueStep(vals, cand);
    if (step && notesMasks) {
      const fresh = step.eliminations.filter(e => notesHave(e.i, e.d));
      if (!fresh.length) step = null; // fully applied already — don't re-offer
      else if (fresh.length < step.eliminations.length) step.eliminations = fresh;
    }
    if (step) out.push(step);
  }

  /* 4. T&E fallback: appended whenever the queue still lacks an actionable
   *    placement — the cycle always ends in something the player can DO.
   *    (Chain-heavy positions where no ladder pattern exists at all, or
   *    queues that are elimination-only, which a no-notes player can't act
   *    on.) Proven by contradiction, stated honestly. */
  const hasPlacement = out.some(s => s.placements?.length);
  if (!hasPlacement) {
    const te = trialAndErrorStep(board, solution);
    if (te) {
      te.weight = 0; // educational, not a graded technique
      out.push(te);
    }
  }

  return out;
}

/* first singles-level step from this position (used for trail lookahead) */
function firstSingleStep(vals, cand) {
  for (let k = 0; k < 4; k++) {
    const s = LADDER[k](vals, cand);
    if (s) return s;
  }
  return null;
}

/* first technique BEYOND singles (pointing/claiming/subsets/fish/wings) */
function firstTechniqueStep(vals, cand) {
  for (let k = 4; k < LADDER.length; k++) {
    const s = LADDER[k](vals, cand);
    if (s) return s;
  }
  return null;
}

/* verified trial-&-error step: for the cell the solution fills "next"
 * (fewest candidates), prove each alternative leads to contradiction.
 * Returns a step that places the true digit with an honest explanation. */
function trialAndErrorStep(board, solution) {
  const cand = candidatesOf(board);
  let best = -1, bestN = 10;
  for (let i = 0; i < 81; i++) {
    if (board[i] || cand[i] === 0) continue;
    const n = POP[cand[i]];
    if (n >= 2 && n < bestN) { bestN = n; best = i; if (n === 2) break; }
  }
  if (best === -1) return null;
  const d = solution[best];
  if (!d || !(cand[best] & BIT[d])) return null; // true digit must be a candidate
  const others = digitsOf(cand[best] & ~BIT[d]);
  if (!others.length) return null; // naked single — shouldn't reach here, but be safe
  const proven = others.every((alt) => solveCount(withDigit(board, best, alt), 2) === 0);
  if (!proven) return null; // alternatives not refutable cheaply — no honest hint
  return mkStep('Trial & Error', 0, [{ i: best, d }], [],
    `No simple pattern fits here — but ${cellName(best)} can be proven`,
    `${cellName(best)} = ${d}`,
    `Trying each of ${others.join(', ')} in ${cellName(best)} quickly leads to a contradiction — so ${cellName(best)} = ${d}. Chains and advanced tables would show why; this corner of the puzzle needs them.`);
}

function withDigit(grid, i, d) {
  const g = grid.slice();
  g[i] = d;
  return g;
}

/* ---------- difficulty bands & generation ---------- */

export function labelFor(hardest, solved) {
  if (!solved) return 'Diabolical';
  if (hardest <= 1.5) return 'Easy';
  if (hardest <= 2.3) return 'Medium';
  if (hardest <= 4.4) return 'Hard';
  return 'Expert';
}

export function targetSEForSlider(v) { // v: 0..100
  const t = Math.min(100, Math.max(0, v)) / 100;
  return +(1.0 * Math.pow(9.0, t)).toFixed(2); // log scale 1.0 → 9.0
}

const BANDS = {
  easy:       { target: 1.2, clues: 40 },
  medium:     { target: 2.3, clues: 32 },
  hard:       { target: 3.6, clues: 28 },
  diabolical: { target: 9.0, clues: 23 },
};

function inBand(g, target) {
  if (!g.solved) return target >= 5.5;                 // only diabolical accepts T&E
  if (target >= 5.5) return g.hardest >= 5.0;          // expert zone: any deep logic
  return Math.abs(g.hardest - target) <= 0.75;
}

function bandError(g, target) {
  if (target >= 5.5) {
    // diabolical: must NOT be ladder-solvable, and the ladder should stall deep
    if (!g.solved) return Math.max(0, 3.4 - g.hardest);
    return 90 + Math.max(0, 5.0 - g.hardest); // ladder-solvable: strongly rejected
  }
  if (!g.solved) return 99;
  return Math.abs(g.hardest - target);
}

export function generate(difficulty = 'easy', seed = undefined) {
  const rng = mulberry32(seed ?? (Math.random() * 2 ** 31) | 0);
  const band = BANDS[difficulty] ?? BANDS.easy;
  const target = band.target;
  let cluesTarget = band.clues;
  let best = null, bestErr = Infinity;
  const t0 = Date.now();
  const BUDGET = 3000; // hard wall-clock cap: UI must stay responsive
  for (let attempt = 1; attempt <= 60; attempt++) {
    if (Date.now() - t0 > BUDGET) break;
    const solution = generateSolvedGrid(rng);
    const puz = dig(solution, cluesTarget, rng);
    const g = grade(puz);
    const err = bandError(g, target);
    if (err < bestErr) {
      bestErr = err; best = { puzzle: puz, solution, grade: g };
    }
    if (err <= 0.75) break;              // discrete grading steps: take the in-band hit
    if (g.solved && g.hardest < target - 0.75) cluesTarget = Math.max(22, cluesTarget - 2); // too easy -> dig deeper
    else if (g.solved && g.hardest > target + 0.75) cluesTarget = Math.min(40, cluesTarget + 1); // too hard -> add clues
  }
  if (!best) throw new Error('generation failed');
  const clues = best.puzzle.reduce((n, v) => n + (v ? 1 : 0), 0);
  // Final uniqueness assertion — never ship an ambiguous puzzle
  if (solveCount(best.puzzle, 2) !== 1) throw new Error('uniqueness violation');
  return {
    puzzle: best.puzzle,
    solution: best.solution,
    hardest: best.grade.hardest,
    hardestTech: best.grade.hardestTech,
    label: labelFor(best.grade.hardest, best.grade.solved),
    clues,
  };
}

export function generateWithTarget(seTarget, seed = undefined) {
  const rng = mulberry32(seed ?? (Math.random() * 2 ** 31) | 0);
  let clues = Math.round(44 - (seTarget - 1) / 8 * 21); // 1.0→44 clues, 9.0→23
  let best = null, bestErr = Infinity;
  const t0 = Date.now();
  const BUDGET = 3000;
  for (let attempt = 1; attempt <= 60; attempt++) {
    if (Date.now() - t0 > BUDGET) break;
    const solution = generateSolvedGrid(rng);
    const puz = dig(solution, Math.max(21, clues), rng);
    const g = grade(puz);
    const err = bandError(g, seTarget);
    if (err < bestErr) { bestErr = err; best = { puzzle: puz, solution, grade: g }; }
    if (err <= 0.75) break;
    if (g.solved && g.hardest < seTarget - 0.75) clues = Math.max(21, clues - 2);
  }
  if (!best) throw new Error('generation failed');
  if (solveCount(best.puzzle, 2) !== 1) throw new Error('uniqueness violation');
  const nClues = best.puzzle.reduce((n, v) => n + (v ? 1 : 0), 0);
  return {
    puzzle: best.puzzle,
    solution: best.solution,
    hardest: best.grade.hardest,
    hardestTech: best.grade.hardestTech,
    label: labelFor(best.grade.hardest, best.grade.solved),
    clues: nClues,
  };
}
