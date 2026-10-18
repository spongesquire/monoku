# Hintoku hint system — reverse-engineering notes (for the Monoku port)

Source: `Hintoku.xapk` (v2.1.1, package `cz.hlms.sudokutogether`, label "Hintoku").
Toolchain: XAPK → split APKs; the app is a .NET MAUI Blazor Hybrid app, so all
game logic lives in managed DLLs packed in an **XABA assembly store**
(`libassembly-store.so`, LZ4/XALZ-compressed entries). Extracted with a custom
Node script (`.rea/hintoku/extract.cjs`) implementing the public XALZ/LZ4
format; decompiled with ILSpy (`ilspycmd`). REA was used for artifact
inspection; its Android/JADX path wasn't applicable (no DEX logic, no JDK).

Note: all decompiled material stays under `.rea/` (gitignored). The Monoku port
below is a fresh implementation of the *standard published* techniques in
Monoku's own bitmask style — no Hintoku code, strings, or assets are copied.

## App structure findings

- Hint engine: `SudokuApp.Shared.dll` → `SudokuApp.Shared.Model.Solvers.*`
  (~30 solver classes) + `Move*` model types.
- UI is Blazor; one JS interop file draws **AIC chain arrows** on an SVG layer
  over the board (grouped-node rectangles, solid/dashed arrows) — chains are a
  first-class visual.
- Bundled level DB groups puzzles per technique (json files: `1ls`, `1sl`,
  `1pe`, `2hs`, `3lb`, `3st`, `4xy`, `4ss`, `4ff`, `4kc`, `4er`, `4ww`, `4xw`,
  `5ai`, `5al`, `5co`, `5xc`, `5yc`, `9xx`).

## Technique inventory & difficulty ladder (MoveAlgo + groups)

Difficulty tiers (MoveAlgoGroup.Difficulty):

| Tier | Group | Techniques |
|------|-------|-----------|
| 1 | NC Last Seat | Full House, Hidden Single (box) |
| 2 | NC Scanning / Process of Elimination / Singles | Hidden Single (line), Naked Single, Candidate Elimination |
| 3 | Line-Box / Sets | Pointing, Box Reduction (claiming), Naked/Hidden Pair/Triple/Quad |
| 4 | Pivot Wings / Single-digit | XY-Wing, XYZ-Wing |
| 4 | Skyscraper | Skyscraper |
| 4 | Fish | X-Wing / Swordfish / Jellyfish (complexity = size−1) |
| 4 | Finned Fish | Finned/Sashimi X-Wing / Swordfish / Jellyfish (size 2–4) |
| 4 | Three-Step AIC | Two-String Kite, Crane, Skyscraper-3-Step |
| 4 | Empty Rectangle | Empty Rectangle |
| 4 | W-Wing | W-Wing |
| 5 | Chains | X-Chain, X-Chain GN, XY-Chain, AIC, AIC GN |
| 5 | ALS | ALS-XZ, ALS-2XZ |
| 5 | Coloring | Simple Coloring |

Solver dispatch order = enum order (simplest first); each solver returns ALL
moves found for its technique; first non-empty list wins.

## Key detection semantics (differences worth porting)

- **Skyscraper**: for digit d and orientation (rows or cols as base lines):
  two base lines each with exactly 2 candidates whose 4 cells occupy exactly 3
  cross-lines (one cross-line shared by both base lines = base, the other two
  hold the "roof" cells). Eliminate d from cells seeing BOTH roof cells.
- **Finned fish** (size n=2..4): choose n base lines (≥2 candidates each);
  bucket candidates by cross-line. Cover = cross-lines with ≥2 cells (must be
  exactly n). Fins = 1–2 cross-lines with exactly 1 cell; all fin cells must
  share one box, and ≥1 cover cell must be in that box. Eliminate d inside the
  fin box only: cells not on base lines whose cross position is in the cover
  set. (This formulation covers finned AND sashimi.)
- **Two-String Kite**: line L with exactly 2 candidates A,B (different boxes);
  B's box contains another d-candidate C; C's cross line (perpendicular to L)
  has exactly one other d-candidate D. Eliminate d from cells seeing both A
  and D.
- **Crane**: same but the "middle" strong link is a line instead of a box, and
  the third link is a box.
- **Empty Rectangle**: box where d-candidates all lie on one row r or one col c
  of the box (cross-point (r,c)), with ≥2 candidates and ≤1 row & ≤1 col
  holding >1. For A on the cross line outside the box: if A's perpendicular
  line has exactly one other d-candidate D (strong link), eliminate d at
  X = (D's cross-line-type line) ∩ (cross position), outside the box.
- **W-Wing**: two non-peer bi-value cells with the same pair {x,y}; a house
  where x has exactly 2 candidates u,v that see p resp. q (strong link on x)
  → eliminate y from cells seeing both p and q.
- **Chains (X-Chain / XY-Chain / AIC)**: one DFS engine. Nodes = (cells,
  digit, parity), alternating strong/weak links; strong links = only-two-in-
  house (single digit) or bi-value cell (two digits); weak = shared house same
  digit or same cell other digit; grouped nodes = 2–3 cells in a line
  (GN variants). Depth caps: X-Chain 24, XY-Chain 20, AIC 16. XY-Chain
  restricts nodes to bi-value cells. 30s wall budget, shortest move preferred.
  Eliminations: common peers of chain endpoints when endpoint digit = start
  digit.
- **Simple Coloring**: strong-link graph per digit, 2-coloring; eliminations
  from color traps (uncolored candidate seeing both colors) and color wraps
  (same color sees itself → that color eliminated everywhere).

## Hint presentation (what "Hintoku-style" means in the UI)

1. **Fast help ladder**: Help → shows a move exists → its difficulty tier
   (1–5) → the strategy name → detailed story → "play it". Progressive
   disclosure, one tap each.
2. **Story steps**: every technique emits a multi-step story; each step has
   highlight cells, support cells, and field updates (mark/eliminate) — the
   player can step through the reasoning.
3. **Chain visuals**: AIC chains draw arrows between node cells (solid =
   strong, dashed = weak), with color-coded true/false endpoints.
4. Each technique also has 2 escalating teaser hints ("look at digit X in
   box Y" → more specific) before the full reveal.

## Monoku port decisions

- Keep Monoku's engine architecture (single bitmask ES module, `mkStep`
  where/what/why hints) and its queue-based hint sheet; add:
  - scanners: Skyscraper, Finned Fish (2–4), Two-String Kite, W-Wing, Empty
    Rectangle, Simple Coloring, and one AIC engine classifying its finds as
    X-Chain / XY-Chain / AIC (single-cell nodes first).
  - difficulty `level` (1–5, Hintoku-style) on every step, shown in the sheet
    kicker.
  - `pattern` (support cells) + `chain` (node/link list) payloads on steps so
    the UI can pulse pattern cells and draw chain arrows on the board.
- Ladder order follows Hintoku tiers mapped into Monoku's SE-style weights
  (Skyscraper 4.6, Finned X-Wing 4.8, Kite 5.1, Finned Swordfish 5.3, W-Wing
  5.5, Empty Rectangle 5.55, Finned Jellyfish 5.6, Coloring 5.8, X-Chain 6.0,
  XY-Chain 6.3, AIC 6.6).
- Generation keeps chains disabled (banding + 3s budget unchanged); hints and
  `grade()` run chains with a time/step budget.
