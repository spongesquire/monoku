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
const sees = (i, j) => ROW_OF[i] === ROW_OF[j] || COL_OF[i] === COL_OF[j] || BOX_OF[i] === BOX_OF[j];
const lineName = (type, k) => type === 'row' ? `row ${k + 1}` : `column ${k + 1}`;

/* Hintoku-style difficulty tier 1..5 (1 = basic singles, 5 = chains).
 * Derived from weight when a scanner doesn't state one explicitly. */
const levelForWeight = (w) => w <= 1.6 ? 1 : w <= 2.3 ? 2 : w <= 4.5 ? 3 : w <= 5.7 ? 4 : 5;

function mkStep(tech, weight, placements, eliminations, where, what, why, extra = {}) {
  return {
    tech, weight,
    placements: placements ?? [],
    eliminations: eliminations ?? [],
    /* teaching layer for progressive hints:
     *   region/regionName — where to look (highlighted before any answer)
     *   nudge  — one-line "what this technique is" (level 2)
     *   clue   — directional text that withholds the answer (level 3) */
    region: extra.region ?? [],
    regionName: extra.regionName ?? null,
    nudge: extra.nudge ?? null,
    clue: extra.clue ?? null,
    /* pattern cells forming the technique (soft pulse, distinct from the
     * hard pulse on actionable targets); chain payload for chain draws */
    level: extra.level ?? levelForWeight(weight),
    pattern: extra.pattern ?? null,
    chain: extra.chain ?? null,
    hint: { tech, where, what, why },
  };
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
        `Every house must contain 1–9 exactly once. ${cap(houseName(h))} already has every digit except ${d}, and ${cellName(empty)} is its only empty cell.`,
        {
          region: [...h.cells], regionName: houseName(h),
          nudge: 'Full House — a house with exactly one empty cell. The one missing digit has nowhere else to go.',
          clue: `Look at ${houseName(h)} — one cell is empty. Count which digit is missing.`,
        });
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
          `Every other cell in ${houseName(h)} is blocked for ${d} by a ${d} in its row or column.`,
          {
            region: [...h.cells], regionName: houseName(h),
            nudge: 'Hidden Single — one digit fits in only one cell of a house, because peers block everywhere else.',
            clue: `Scan ${houseName(h)} for a digit that fits in only one spot. ${h.type === 'box' ? 'Check each missing digit against its row and column.' : 'Check each missing digit against the boxes it passes through.'}`,
          });
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
      `Every other digit already appears in ${cellName(i)}'s row, column, or box — only ${d} can go there.`,
      {
        region: [i, ...PEERS[i]], regionName: `${cellName(i)} and its peers`,
        nudge: 'Naked Single — a cell whose candidates (all digits not yet in its row, column, or box) leave exactly one option.',
        clue: `Scan the highlighted cells: one of them has a row, column, and box that together contain all eight other digits — it's down to its last candidate.`,
      });
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
        `Wherever ${d} goes in ${houseName(h)}, it lands in ${lineName} — so no other cell in ${lineName} can be ${d}.`,
        {
          region: [...h.cells], regionName: houseName(h),
          nudge: "Pointing — inside a box, all spots for one digit line up in a single row or column. That line's digit lives in this box, so the rest of the line is blocked.",
          clue: `In ${houseName(h)}, pick a digit and see where it can go. One digit's spots all line up in ${lineName}.`,
        });
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
        `${cap(houseName(h))} must place its ${d} inside box ${bx + 1}, so the rest of that box can't be ${d}.`,
        {
          region: [...h.cells], regionName: houseName(h),
          nudge: "Claiming — the reverse of Pointing: in a row or column, all spots for one digit fall inside a single box. The line's digit lives in that box, so the rest of the box is blocked.",
          clue: `Scan ${houseName(h)}: one digit's possible spots all sit inside box ${bx + 1}. That digit then can't go anywhere else in that box.`,
        });
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
              `Those ${size} ${plural(size, 'cell')} must take the ${size} ${plural(size, 'digit')} {${ds.join(',')}} in some order, so no other cell in ${houseName(h)} can use them.`,
              {
                region: [...h.cells], regionName: houseName(h),
                nudge: `Naked ${size === 2 ? 'Pair' : size === 3 ? 'Triple' : 'Quad'} — ${size} cells in a house whose combined candidates are exactly ${size} digits. Those digits are locked into those cells.`,
                clue: `In ${houseName(h)}, look for ${size === 2 ? 'two cells' : size === 3 ? 'three cells' : 'four cells'} that together use only ${size} digits. Those digits are then spoken for.`,
              });
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
              `Those ${size} ${plural(size, 'digit')} must occupy those ${size} ${plural(size, 'cell')} — every other candidate there is impossible.`,
              {
                region: [...h.cells], regionName: houseName(h),
                nudge: `Hidden ${size === 2 ? 'Pair' : size === 3 ? 'Triple' : 'Quad'} — ${size} digits in a house that fit only in ${size} cells. Those cells are reserved for them.`,
                clue: `In ${houseName(h)}, find ${size} digits that only fit in ${size === 2 ? 'two' : size === 3 ? 'three' : 'four'} cells — those cells can hold nothing else.`,
              });
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
          const regionCells = [];
          for (const k of chosen) for (const i of HOUSES[orient === 0 ? k : 9 + k].cells) regionCells.push(i);
          return mkStep(name, weight, [], elim,
            `Digit ${d} forms a ${name} in ${chosen.map(baseN).join(' and ')} (${[...cover].sort().map(covN).join(' and ')})`,
            `Remove ${d} from ${[...cover].sort().map(covN).join(' and ')} outside the base ${orient === 0 ? 'rows' : 'columns'}`,
            `In each base ${orient === 0 ? 'row' : 'column'}, ${d} can only use the cover ${orient === 0 ? 'columns' : 'rows'} — so those lines' ${d}s belong to the base, and no other cell there can be ${d}.`,
            {
              region: regionCells, regionName: `${chosen.map(baseN).join(' and ')}`,
              nudge: `${name} — a fish: in ${size} parallel lines, digit ${d} is restricted to the same ${size} crossing lines. The digit then can't sit elsewhere on those crossing lines.`,
              clue: `Track digit ${d} across ${chosen.map(baseN).join(' and ')}. Its spots are locked into ${size} crossing lines — what does that block?`,
            });
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
        `The pivot is ${x} or ${y}. If it's ${x}, the ${y}-wing takes ${z}; if it's ${y}, the ${x}-wing takes ${z}. Either way, any cell seeing both pincers can't be ${z}.`,
        {
          region: [p, w1, w2], regionName: `${cellName(p)} and its two wings`,
          nudge: 'XY-Wing — three bivalue cells: a pivot {x,y} and two pincers each sharing one digit with it. Either way the pivot resolves, one pincer takes the spare digit z — so z is blocked in cells seeing both pincers.',
          clue: `Find a two-candidate cell whose two "wings" each share exactly one candidate with it. Whatever the pivot becomes, one wing must take the leftover digit.`,
        });
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
        `The pivot takes one of {${ds.join(',')}}. Whichever it is, ${z} lands in the pivot or a pincer — cells seeing all three can't be ${z}.`,
        {
          region: [p, w1, w2], regionName: `${cellName(p)} and its two wings`,
          nudge: 'XYZ-Wing — like an XY-Wing, but the pivot holds three candidates, one shared with each pincer and one (z) common to all three. z always lands in the trio, so cells seeing all three lose z.',
          clue: `A three-candidate cell with two bivalue wings: the digit shared by all three cells can never sit elsewhere in their sight lines.`,
        });
    }
  }
  return null;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- Hintoku-tier techniques (see docs/hintoku-re-notes.md) ----------
 * Standard published definitions, ordered by difficulty tier:
 *   4: Skyscraper, Finned/Sashimi fish, Two-String Kite, W-Wing, Empty Rectangle
 *   5: Simple Coloring, X-Chain / XY-Chain / AIC (one alternating-link engine)
 * All scanners are pure functions of (vals, cand). */

/* cells holding digit d per row / per column */
function digitLines(vals, cand, d, byRow) {
  const lines = [[], [], [], [], [], [], [], [], []];
  for (let i = 0; i < 81; i++) {
    if (vals[i] || !(cand[i] & BIT[d])) continue;
    lines[byRow ? ROW_OF[i] : COL_OF[i]].push(i);
  }
  return lines;
}

/* Skyscraper: two parallel lines hold exactly two candidates each for d; the
 * four cells occupy three cross lines (one shared = base, two single = roof).
 * Either roof cell being false forces the other true, so cells seeing both
 * roof cells lose d. */
function scanSkyscraper(vals, cand) {
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (const byRow of [true, false]) {
      const lines = digitLines(vals, cand, d, byRow);
      const pairLines = [];
      for (let k = 0; k < 9; k++) if (lines[k].length === 2) pairLines.push(k);
      for (let x = 0; x < pairLines.length; x++) for (let y = x + 1; y < pairLines.length; y++) {
        const l1 = pairLines[x], l2 = pairLines[y];
        const cells = [...lines[l1], ...lines[l2]];
        const byCross = new Map();
        for (const i of cells) {
          const c = byRow ? COL_OF[i] : ROW_OF[i];
          if (!byCross.has(c)) byCross.set(c, []);
          byCross.get(c).push(i);
        }
        if (byCross.size !== 3) continue;
        let roof1 = -1, roof2 = -1;
        for (const arr of byCross.values()) {
          if (arr.length === 1) { if (roof1 < 0) roof1 = arr[0]; else roof2 = arr[0]; }
        }
        if (roof2 < 0) continue; // need exactly one shared cross line (the base)
        const elim = [];
        for (let i = 0; i < 81; i++) {
          if (vals[i] || !(cand[i] & b) || cells.includes(i)) continue;
          if (sees(i, roof1) && sees(i, roof2)) elim.push({ i, d });
        }
        if (!elim.length) continue;
        const ln = (k) => lineName(byRow ? 'row' : 'col', k);
        return mkStep('Skyscraper', 4.6, [], elim,
          `Digit ${d} in ${ln(l1)} and ${ln(l2)} forms a Skyscraper — roofs ${cellName(roof1)} and ${cellName(roof2)}`,
          `Remove ${d} from cells seeing both roofs`,
          `In both ${ln(l1)} and ${ln(l2)}, ${d} has only two spots, and they share one cross line. If one roof cell is not ${d}, its line's other cell is ${d}, forcing the base — which leaves the other roof as the only ${d} in its line. Either way, one roof is ${d}, so cells seeing both can't be.`,
          {
            region: cells, regionName: `${ln(l1)} and ${ln(l2)}`,
            level: 4, pattern: cells,
            nudge: 'Skyscraper — two parallel lines where a digit has exactly two spots each, aligned so they share one crossing line. The two outer ends (the "roof") can never both be false.',
            clue: `Follow digit ${d} through ${ln(l1)} and ${ln(l2)} — each has exactly two spots, sharing one crossing line. Watch the two unshared ends.`,
          });
      }
    }
  }
  return null;
}

/* Finned (and sashimi) fish: n base lines; cover = cross lines touched by
 * >=2 base lines; 1–2 leftover cells (fins) must share one box with a cover
 * cell; eliminations live in the fin box only, on cover positions outside
 * the base lines. */
function scanFinnedFish(vals, cand, size) {
  const name = size === 2 ? 'Finned X-Wing' : size === 3 ? 'Finned Swordfish' : 'Finned Jellyfish';
  const weight = [4.8, 5.3, 5.6][size - 2];
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (const byRow of [true, false]) {
      const lines = digitLines(vals, cand, d, byRow);
      const candLines = [];
      for (let k = 0; k < 9; k++) if (lines[k].length >= 2) candLines.push(k);
      if (candLines.length < size) continue;
      const crossOf = (i) => byRow ? COL_OF[i] : ROW_OF[i];
      const pick = (start, chosen) => {
        if (chosen.length === size) {
          const byCross = new Map();
          for (const k of chosen) for (const i of lines[k]) {
            const c = crossOf(i);
            if (!byCross.has(c)) byCross.set(c, []);
            byCross.get(c).push(i);
          }
          const coverPos = [], finCells = [];
          for (const [pos, arr] of byCross) {
            if (arr.length >= 2) coverPos.push(pos);
            else finCells.push(arr[0]);
          }
          if (coverPos.length !== size) return null;
          if (finCells.length < 1 || finCells.length > 2) return null;
          if (finCells.length === 2 && BOX_OF[finCells[0]] !== BOX_OF[finCells[1]]) return null;
          const finBox = BOX_OF[finCells[0]];
          const hasCoverInFinBox = [...byCross.entries()].some(([pos, arr]) => arr.length >= 2 && arr.some(i => BOX_OF[i] === finBox));
          if (!hasCoverInFinBox) return null;
          const baseSet = new Set(chosen);
          const elim = [];
          for (const i of HOUSES[18 + finBox].cells) {
            if (vals[i] || !(cand[i] & b)) continue;
            const li = byRow ? ROW_OF[i] : COL_OF[i];
            if (baseSet.has(li)) continue;
            if (coverPos.includes(crossOf(i))) elim.push({ i, d });
          }
          if (!elim.length) return null;
          const baseCells = [];
          for (const k of chosen) baseCells.push(...lines[k]);
          const ln = (k) => lineName(byRow ? 'row' : 'col', k);
          return mkStep(name, weight, [], elim,
            `${name} on ${d}: base ${chosen.map(ln).join(' and ')} with ${plural(finCells.length, 'fin')} ${finCells.map(cellName).join(' and ')} in box ${finBox + 1}`,
            `Remove ${d} from ${elim.map((e) => cellName(e.i)).join(' and ')} in box ${finBox + 1}`,
            `Ignore the fin${finCells.length === 2 ? 's' : ''} and the ${size} base lines form a fish on ${d}. Then wherever ${d} actually lands in the base lines, it sits in a cover line or in the fin — either way inside box ${finBox + 1} on a cover line. Cells of that box on cover lines, outside the base lines, can never be ${d}.`,
            {
              region: baseCells, regionName: chosen.map(ln).join(' and '),
              level: 4, pattern: [...baseCells, ...finCells],
              nudge: `${name} — a fish whose corner cells ${finCells.length === 1 ? 'has one fin' : 'have two fins'}: extra candidates confined to a single box. The fish still bites inside that box only.`,
              clue: `Track ${d} along ${chosen.map(ln).join(' and ')}. All but ${finCells.length === 1 ? 'one spot' : 'two spots'} fall on ${size} shared crossing lines — the exception${finCells.length === 1 ? '' : 's'} share${finCells.length === 1 ? 's' : ''} one box.`,
            });
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

/* Two-String Kite: strong link in a line (A,B), strong link in B's box to C,
 * strong link in C's cross line to D. A and D can never both be false, so
 * cells seeing both lose d. */
function scanTwoStringKite(vals, cand) {
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (const byRow of [true, false]) {
      const lines = digitLines(vals, cand, d, byRow);
      for (let k = 0; k < 9; k++) {
        if (lines[k].length !== 2) continue;
        for (const [a, bb] of [[0, 1], [1, 0]]) {
          const A = lines[k][a], B = lines[k][bb];
          if (BOX_OF[A] === BOX_OF[B]) continue;
          const boxCells = HOUSES[18 + BOX_OF[B]].cells.filter(i => i !== B && !vals[i] && (cand[i] & b));
          for (const C of boxCells) {
            const crossIdx = byRow ? COL_OF[C] : ROW_OF[C];
            const crossLine = (byRow ? digitLinesPerCol(cand, d, crossIdx) : digitLinesPerRow(cand, d, crossIdx))
              .filter(i => i !== C);
            if (crossLine.length !== 1) continue;
            const D = crossLine[0];
            if (D === A || D === B) continue;
            const elim = [];
            for (let i = 0; i < 81; i++) {
              if (vals[i] || !(cand[i] & b) || i === A || i === B || i === C || i === D) continue;
              if (sees(i, A) && sees(i, D)) elim.push({ i, d });
            }
            if (!elim.length) continue;
            const ln = lineName(byRow ? 'row' : 'col', k);
            return mkStep('Two-String Kite', 5.1, [], elim,
              `Two-String Kite on ${d}: ${cellName(A)}–${cellName(B)} in ${ln}, ${cellName(B)}–${cellName(C)} in box ${BOX_OF[B] + 1}, ${cellName(C)}–${cellName(D)} in ${lineName(byRow ? 'col' : 'row', crossIdx)}`,
              `Remove ${d} from cells seeing both ${cellName(A)} and ${cellName(D)}`,
              `${d} in ${ln} is ${cellName(A)} or ${cellName(B)}. If ${cellName(B)}, the box link puts it at ${cellName(C)}, whose line then forces ${cellName(D)} — so ${cellName(A)} or ${cellName(D)} is ${d}, and cells seeing both lose it.`,
              {
                region: [A, B, C, D], regionName: `the ${d} links through ${ln} and box ${BOX_OF[B] + 1}`,
                level: 4, pattern: [A, B, C, D],
                nudge: 'Two-String Kite — three chained strong links: one in a line, one in a box, one in a crossing line. The two loose ends can never both be false.',
                clue: `Trace ${d} through three strong links: a line pair, a box pair off one end, and a crossing-line pair off that. Eliminate from cells seeing both loose ends.`,
              });
          }
        }
      }
    }
  }
  return null;
}
function digitLinesPerCol(cand, d, col) { const a = []; for (let r = 0; r < 9; r++) { const i = r * 9 + col; if (cand[i] & BIT[d]) a.push(i); } return a; }
function digitLinesPerRow(cand, d, row) { const a = []; for (let c = 0; c < 9; c++) { const i = row * 9 + c; if (cand[i] & BIT[d]) a.push(i); } return a; }

/* W-Wing: two non-peer bivalue cells p,q with the same pair {x,y}; a house
 * where x has exactly two candidates u,v that see p and q respectively.
 * Whatever p is, the strong link forces the other end, so one of p,q is y. */
function scanWWing(vals, cand) {
  const bivalue = [];
  for (let i = 0; i < 81; i++) if (!vals[i] && POP[cand[i]] === 2) bivalue.push(i);
  for (let x = 0; x < bivalue.length; x++) for (let y2 = x + 1; y2 < bivalue.length; y2++) {
    const p = bivalue[x], q = bivalue[y2];
    if (cand[p] !== cand[q] || sees(p, q)) continue;
    const [d1, d2] = digitsOf(cand[p]);
    for (const [s, z] of [[d1, d2], [d2, d1]]) {
      for (const h of HOUSES) {
        const spots = h.cells.filter(i => !vals[i] && (cand[i] & BIT[s]));
        if (spots.length !== 2) continue;
        const [u, v] = spots;
        if (u === p || u === q || v === p || v === q) continue;
        const linked = (sees(u, p) && sees(v, q)) || (sees(u, q) && sees(v, p));
        if (!linked) continue;
        const elim = [];
        for (let i = 0; i < 81; i++) {
          if (vals[i] || i === p || i === q || !(cand[i] & BIT[z])) continue;
          if (sees(i, p) && sees(i, q)) elim.push({ i, d: z });
        }
        if (!elim.length) continue;
        return mkStep('W-Wing', 5.5, [], elim,
          `W-Wing: ${cellName(p)} and ${cellName(q)} both hold {${d1},${d2}}, bridged by ${s} in ${houseName(h)}`,
          `Remove ${z} from cells seeing both ${cellName(p)} and ${cellName(q)}`,
          `If ${cellName(p)} is ${s}, the strong ${s} link in ${houseName(h)} forces ${cellName(q)} to ${z} — and vice versa. One of the pair is always ${z}, so cells seeing both lose ${z}.`,
          {
            region: [p, q, u, v], regionName: `${cellName(p)}, ${cellName(q)} and the ${s} pair in ${houseName(h)}`,
            level: 4, pattern: [p, q, u, v],
            nudge: 'W-Wing — two identical bivalue cells that do not see each other, joined by a strong link on one of their digits. One of the two cells must take the other digit.',
            clue: `Find two cells with the same two candidates that do not see each other, and a house where one of those digits has exactly two spots — one touching each cell.`,
          });
      }
    }
  }
  return null;
}

/* Empty Rectangle: in one box all d-candidates lie on row r or column c.
 * A strong link on d through the row (or column) outside the box then kills
 * d at the crossing of the link's far end and the rectangle's column (row). */
function scanEmptyRectangle(vals, cand) {
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (let bx = 0; bx < 9; bx++) {
      const cells = HOUSES[18 + bx].cells.filter(i => !vals[i] && (cand[i] & b));
      if (cells.length < 2) continue;
      const rows = [...new Set(cells.map(i => ROW_OF[i]))];
      const cols = [...new Set(cells.map(i => COL_OF[i]))];
      if (rows.length <= 1 || cols.length <= 1) continue;
      const rowsMulti = rows.filter(r => cells.filter(i => ROW_OF[i] === r).length > 1);
      const colsMulti = cols.filter(c => cells.filter(i => COL_OF[i] === c).length > 1);
      if (rowsMulti.length > 1 || colsMulti.length > 1) continue;
      for (const r of rows) for (const c of cols) {
        if (cells.some(i => ROW_OF[i] !== r && COL_OF[i] !== c)) continue; // cross at (r,c) covers all
        for (const alongRow of [true, false]) {
          // A walks the cross line (row r or column c) outside the box
          const lineCells = alongRow ? digitLinesPerRow(cand, d, r) : digitLinesPerCol(cand, d, c);
          for (const A of lineCells) {
            if (BOX_OF[A] === bx) continue;
            const perp = alongRow ? digitLinesPerCol(cand, d, COL_OF[A]) : digitLinesPerRow(cand, d, ROW_OF[A]);
            const others = perp.filter(i => i !== A);
            if (others.length !== 1) continue;
            const D = others[0];
            if (BOX_OF[D] === bx) continue;
            const X = alongRow ? ROW_OF[D] * 9 + c : r * 9 + COL_OF[D];
            if (BOX_OF[X] === bx || vals[X] || !(cand[X] & b)) continue;
            const lineDesc = alongRow ? `row ${r + 1}` : `column ${c + 1}`;
            return mkStep('Empty Rectangle', 5.55, [], [{ i: X, d }],
              `Empty Rectangle on ${d} in box ${bx + 1} (cross at r${r + 1}c${c + 1}) with strong link ${cellName(A)}–${cellName(D)}`,
              `Remove ${d} from ${cellName(X)}`,
              `In box ${bx + 1}, every ${d} lies on ${lineDesc} or its crossing line. If ${cellName(A)} is not ${d}, its strong link forces ${cellName(D)} = ${d}, and ${cellName(X)} sees it. If ${cellName(A)} is ${d}, the box's ${d} collapses onto the crossing line — and ${cellName(X)} is on it. Either way ${cellName(X)} can't be ${d}.`,
              {
                region: cells, regionName: `box ${bx + 1}`,
                level: 4, pattern: [...cells, A, D],
                nudge: 'Empty Rectangle — a box where one digit\'s candidates all sit on one row and one column of the box. Joined with a strong link on that row or column, a single far cell gets eliminated.',
                clue: `In one box, a digit\'s spots all lie on a single row plus a single column (a right angle). Find a two-candidate line on that row or column outside the box.`,
              });
          }
        }
      }
    }
  }
  return null;
}

/* Simple Coloring: strong links (only two spots in a house) per digit form a
 * graph; 2-color it. Same-colored cells that see each other prove that color
 * false (wrap); an uncolored candidate seeing both colors is trapped. */
function scanColoring(vals, cand) {
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    const links = new Map(); // cell -> [cells]
    const addLink = (u, v) => {
      if (!links.has(u)) links.set(u, []);
      if (!links.has(v)) links.set(v, []);
      if (!links.get(u).includes(v)) links.get(u).push(v);
      if (!links.get(v).includes(u)) links.get(v).push(u);
    };
    for (const h of HOUSES) {
      const spots = h.cells.filter(i => !vals[i] && (cand[i] & b));
      if (spots.length === 2) addLink(spots[0], spots[1]);
    }
    if (!links.size) continue;
    const color = new Map(); // cell -> 0/1
    for (const start of links.keys()) {
      if (color.has(start)) continue;
      color.set(start, 0);
      const queue = [start], comp = [start];
      while (queue.length) {
        const u = queue.shift();
        for (const v of links.get(u)) {
          if (color.has(v)) continue;
          color.set(v, color.get(u) ^ 1);
          comp.push(v); queue.push(v);
        }
      }
      if (comp.length < 2) continue;
      const classA = comp.filter(i => color.get(i) === 0);
      const classB = comp.filter(i => color.get(i) === 1);
      // color wrap: two same-colored cells see each other -> that color is all false
      for (const cls of [classA, classB]) {
        let wrapped = false;
        for (let x = 0; x < cls.length && !wrapped; x++) for (let y2 = x + 1; y2 < cls.length; y2++) {
          if (sees(cls[x], cls[y2])) { wrapped = true; break; }
        }
        if (wrapped) {
          const elim = cls.map(i => ({ i, d }));
          return mkStep('Coloring', 5.8, [], elim,
            `Simple Colors on ${d}: one color class contradicts itself`,
            `Remove ${d} from every ${wrappedClassCellNames(cls)}`,
            `Strong links chain ${d} through the grid into two alternating colors. Two same-colored cells see each other — they can't both be ${d}, yet the chain says both or neither. So that whole color is false and the other color holds ${d}.`,
            {
              region: comp, regionName: `the ${d} color chain`,
              level: 5, pattern: comp,
              nudge: 'Simple Coloring — every digit with exactly two spots per house forms strong links; chain them into two colors. A color that sees itself is entirely false.',
              clue: `Chain the two-spot links on ${d} into alternating colors. Look for one color whose cells attack each other.`,
            });
        }
      }
      // color trap: uncolored candidate sees both colors
      for (let i = 0; i < 81; i++) {
        if (vals[i] || !(cand[i] & b) || color.has(i)) continue;
        const seesA = classA.some(j => sees(i, j));
        const seesB = classB.some(j => sees(i, j));
        if (seesA && seesB) {
          return mkStep('Coloring', 5.8, [], [{ i, d }],
            `Simple Colors on ${d}: ${cellName(i)} sees both colors`,
            `Remove ${d} from ${cellName(i)}`,
            `The chain makes one color true and the other false — but ${cellName(i)} sees a cell of each color. Whichever color holds ${d}, ${cellName(i)} is attacked, so it can't be ${d}.`,
            {
              region: comp, regionName: `the ${d} color chain`,
              level: 5, pattern: comp,
              nudge: 'Simple Coloring — two-color the strong-link chain of a digit; any outside candidate seeing both colors is eliminated.',
              clue: `Two-color the two-spot links on ${d}. Find a candidate that touches both colors.`,
            });
        }
      }
    }
  }
  return null;
}
function wrappedClassCellNames(cls) { return cls.length <= 3 ? cls.map(cellName).join(' and ') : `${cls.length} cells of that color`; }

/* ---------- alternating-link chain engine (X-Chain / XY-Chain / AIC) ----------
 * Nodes are (cell, digit, parity). From an OFF node the chain follows STRONG
 * links (only two spots of d in a house, or the two digits of a bivalue
 * cell); from an ON node, WEAK links (any shared-house candidate, or the
 * other digit in the same cell). A chain that starts and ends on the same
 * digit proves one endpoint true, eliminating that digit from cells seeing
 * both endpoints. Classified for reporting: single digit -> X-Chain, all
 * bivalue cells -> XY-Chain, otherwise AIC. Budget-guarded: generation runs
 * with chains off; hints give the search a time slice. */
let CHAIN_GUARD = null; // { deadline, expansions }

function scanChains(vals, cand) {
  if (!CHAIN_GUARD) return null;
  // strong partners per (cell,d): house conjugate pairs
  const strong = new Map(); // key i*10+d -> [{i,d}]
  const skey = (i, d) => i * 10 + d;
  const addStrong = (i1, d1, i2, d2) => {
    const k = skey(i1, d1);
    if (!strong.has(k)) strong.set(k, []);
    strong.get(k).push({ i: i2, d: d2 });
  };
  for (let d = 1; d <= 9; d++) {
    const b = BIT[d];
    for (const h of HOUSES) {
      const spots = h.cells.filter(i => !vals[i] && (cand[i] & b));
      if (spots.length === 2) {
        addStrong(spots[0], d, spots[1], d);
        addStrong(spots[1], d, spots[0], d);
      }
    }
  }

  const budgetOk = () => (CHAIN_GUARD.expansions++ & 1023) !== 0 || Date.now() <= CHAIN_GUARD.deadline;

  const classify = (nodes) => {
    const digits = new Set(nodes.map(n => n.d));
    if (digits.size === 1) return { tech: 'X-Chain', weight: 6.0, minNodes: 6 };
    if (nodes.every(n => POP[cand[n.i]] === 2)) return { tech: 'XY-Chain', weight: 6.3, minNodes: 8 };
    return { tech: 'AIC', weight: 6.6, minNodes: 8 };
  };

  /* DFS from (s,d0,false); path holds node keys for cycle pruning.
   * Returns node list (including start) when a closing strong link lands on
   * digit d0 with common-peer eliminations. singleDigit mode restricts
   * links to house conjugates (pure X-Chains) so they aren't shadowed by
   * mixed AICs that close earlier in the search. */
  const findChain = (maxNodes, singleDigit) => {
    for (let s = 0; s < 81; s++) {
      if (vals[s]) continue;
      for (let d0 = 1; d0 <= 9; d0++) {
        if (!(cand[s] & BIT[d0])) continue;
        const path = [{ i: s, d: d0, on: false }];
        const onPath = new Set([skey(s, d0) * 2]);
        const dfs = (idx) => {
          if (!budgetOk()) return null;
          if (path.length >= maxNodes) return null;
          const node = path[idx];
          const nexts = [];
          if (!node.on) {
            // strong: house conjugates, then bivalue flip inside the cell
            for (const t of strong.get(skey(node.i, node.d)) ?? []) nexts.push({ i: t.i, d: t.d, on: true });
            if (!singleDigit && POP[cand[node.i]] === 2) {
              const other = digitsOf(cand[node.i] & ~BIT[node.d])[0];
              nexts.push({ i: node.i, d: other, on: true });
            }
          } else {
            // weak: same digit in peers, other digits in the same cell
            for (const p of PEERS[node.i]) {
              if (!vals[p] && (cand[p] & BIT[node.d])) nexts.push({ i: p, d: node.d, on: false });
            }
            if (!singleDigit) {
              for (const d2 of digitsOf(cand[node.i] & ~BIT[node.d])) nexts.push({ i: node.i, d: d2, on: false });
            }
          }
          for (const nxt of nexts) {
            const key = skey(nxt.i, nxt.d) * 2 + (nxt.on ? 1 : 0);
            if (onPath.has(key)) continue;
            /* closure: the chain proves one endpoint true; endpoints need
             * not see each other — common-peer eliminations are the point.
             * A too-short closure falls through: the node still extends. */
            if (nxt.on && nxt.d === d0 && nxt.i !== s) {
              const nodes = [...path, nxt];
              let minOk = singleDigit ? nodes.length >= 6 : nodes.length >= classify(nodes).minNodes;
              if (minOk) {
                const elim = [];
                for (let i = 0; i < 81; i++) {
                  if (vals[i] || i === s || i === nxt.i || !(cand[i] & BIT[d0])) continue;
                  if (sees(i, s) && sees(i, nxt.i)) elim.push({ i, d: d0 });
                }
                if (elim.length) return { nodes, singleDigit, elim };
              }
            }
            path.push(nxt); onPath.add(key);
            const r = dfs(path.length - 1);
            if (r) return r;
            path.pop(); onPath.delete(key);
          }
          return null;
        };
        const r = dfs(0);
        if (r) return r;
      }
    }
    return null;
  };

  for (const maxNodes of [8, 10, 12, 14, 16]) {
    const r = findChain(maxNodes, true) ?? findChain(maxNodes, false);
    if (r) {
      const { nodes, singleDigit, elim } = r;
      const cls = singleDigit ? { tech: 'X-Chain', weight: 6.0 } : classify(nodes);
      const links = [];
      for (let k = 1; k < nodes.length; k++) links.push(nodes[k].on); // strong arrival = true parity
      const names = nodes.map(n => `${cellName(n.i)}${n.d}`).join(nodes.length > 6 ? ' → ' : ' – ');
      return mkStep(cls.tech, cls.weight, [], elim,
        `${cls.tech}: ${names} (${nodes.length - 1} links on ${nodes[0].d})`,
        `Remove ${nodes[0].d} from ${elim.map((e) => cellName(e.i)).join(' and ')}`,
        `Assume ${cellName(nodes[0].i)} is not ${nodes[0].d}. Each strong link (solid) forces its far end true; each weak link (dashed) forces the next elimination. The chain closes back on ${nodes[0].d} at ${cellName(nodes[nodes.length - 1].i)} — so one end of the chain is ${nodes[0].d}, and every cell seeing both ends loses it.`,
        {
          region: nodes.map(n => n.i), regionName: `the ${cls.tech}`,
          level: 5, pattern: [...new Set(nodes.map(n => n.i))],
          chain: { nodes: nodes.map(n => ({ i: n.i, d: n.d })), links },
          nudge: `${cls.tech} — a chain of alternating strong and weak links. Following it from a false assumption leads to a contradiction unless one specific candidate is true.`,
          clue: `Start from a two-candidate spot and hop: strong link (only two in a house) forces true, weak link (sees it) forces false. Close the loop and eliminate.`,
        });
    }
    if (Date.now() > CHAIN_GUARD.deadline) break;
  }
  return null;
}

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
  (v, c) => scanSkyscraper(v, c),             // 4.6   tier 4
  (v, c) => scanFinnedFish(v, c, 2),          // 4.8   tier 4
  (v, c) => subsetsInHouse2(v, c, 4, true),   // naked quad 5.0
  (v, c) => scanTwoStringKite(v, c),          // 5.1   tier 4
  (v, c) => scanFish(v, c, 4),                // jellyfish 5.2
  (v, c) => scanFinnedFish(v, c, 3),          // 5.3   tier 4
  (v, c) => subsetsInHouse2(v, c, 4, false),  // hidden quad 5.4
  (v, c) => scanWWing(v, c),                  // 5.5   tier 4
  (v, c) => scanEmptyRectangle(v, c),         // 5.55  tier 4
  (v, c) => scanFinnedFish(v, c, 4),          // 5.6   tier 4
  (v, c) => scanColoring(v, c),               // 5.8   tier 5
  (v, c) => scanChains(v, c),                 // 6.0–6.6 tier 5 (X-Chain/XY-Chain/AIC)
];
function subsetsInHouse2(vals, cand, size, naked) {
  for (const h of HOUSES) {
    const r = subsetsInHouse(h, vals, cand, size, naked);
    if (r) return r;
  }
  return null;
}

/* grade(puzzle, opts) — opts.chains (default true) enables the tier-5 chain
 * scanners under a wall-clock budget so callers stay responsive. Generation
 * runs with chains off (banding + 3s budget); hints turn them on. */
export function grade(puzzle, opts = {}) {
  const chainsOn = opts.chains !== false;
  CHAIN_GUARD = chainsOn
    ? { deadline: Date.now() + (opts.chainBudgetMs ?? 140), expansions: 0 }
    : null;
  try {
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
  } finally {
    CHAIN_GUARD = null;
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
      region: wrong.slice(0, 9), regionName: null,
      nudge: null,
      clue: null,
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
        `Every house must contain 1–9 exactly once. ${cap(houseName(h))} already has every digit except ${d}, and ${cellName(empty)} is its only empty cell.`,
        {
          region: [...h.cells], regionName: houseName(h),
          nudge: 'Full House — a house with exactly one empty cell. The one missing digit has nowhere else to go.',
          clue: `Look at ${houseName(h)} — one cell is empty. Count which digit is missing.`,
        }));
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
          `Every other cell in ${houseName(h)} is blocked for ${d} by a ${d} in its row or column.`,
          {
            region: [...h.cells], regionName: houseName(h),
            nudge: 'Hidden Single — one digit fits in only one cell of a house, because peers block everywhere else.',
            clue: `Scan ${houseName(h)} for a digit that fits in only one spot. ${h.type === 'box' ? 'Check each missing digit against its row and column.' : 'Check each missing digit against the boxes it passes through.'}`,
          }));
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
      `Every other digit already appears in ${cellName(i)}'s row, column, or box — only ${d} can go there.`,
      {
        region: [i, ...PEERS[i]], regionName: `${cellName(i)} and its peers`,
        nudge: 'Naked Single — a cell whose candidates (all digits not yet in its row, column, or box) leave exactly one option.',
        clue: `Scan the highlighted cells: one of them has a row, column, and box that together contain all eight other digits — it's down to its last candidate.`,
      }));
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

  /* 3. technique steps — one per difficulty tier (3/4/5), appended after the
   *    singles so cycling reaches them: locked candidates/subsets, then
   *    wings/skyscraper/fish/kite/W-Wing/ER, then coloring/chains. Chains
   *    get their own time slice so a chain-heavy position can't stall the
   *    hint tap. Each is a true statement about the current position. */
  {
    CHAIN_GUARD = { deadline: Date.now() + 250, expansions: 0 };
    const byTier = techniqueStepsByTier(vals, cand);
    CHAIN_GUARD = null;
    for (let step of byTier) {
      if (!step) continue;
      if (notesMasks) {
        const fresh = step.eliminations.filter(e => notesHave(e.i, e.d));
        if (!fresh.length) continue; // fully applied already — don't re-offer
        if (fresh.length < step.eliminations.length) step.eliminations = fresh;
      }
      out.push(step);
    }
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

/* first technique BEYOND singles per tier (3 locked/subsets, 4 wings/fish
 * family, 5 coloring/chains) — stops scanning a tier once it has a step */
function techniqueStepsByTier(vals, cand) {
  const out = [null, null, null]; // index level-3
  let missing = 3;
  for (let k = 4; k < LADDER.length && missing > 0; k++) {
    const s = LADDER[k](vals, cand);
    if (!s) continue;
    const idx = Math.min(2, Math.max(0, (s.level ?? 3) - 3));
    if (!out[idx]) { out[idx] = s; missing--; }
  }
  return out;
}

/* first technique BEYOND singles (any tier) */
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
    `Trying each of ${others.join(', ')} in ${cellName(best)} quickly leads to a contradiction — so ${cellName(best)} = ${d}. Chains and advanced tables would show why; this corner of the puzzle needs them.`,
    {
      region: [best, ...PEERS[best]], regionName: `${cellName(best)} and its peers`,
      nudge: 'No named pattern fits this position — the digit below is proven by contradiction, not a spotable pattern.',
      clue: `Among the highlighted cells, find the one with the fewest candidates. Test each option — all but one collapse fast.`,
    });
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
    const g = grade(puz, { chains: false }); // banding + budget: no chain search
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
    const g = grade(puz, { chains: false }); // banding + budget: no chain search
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
