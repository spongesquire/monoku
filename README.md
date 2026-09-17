# Monoku

A calm, offline-first Sudoku — made for Mon.

## What's inside

- **Real logic difficulty** — puzzles are graded by a SudokuExplainer-style technique
  ladder (singles → locked candidates → subsets → fish → wings), not clue count.
  Easy/Medium/Hard/Diabolical bands, plus a fine-grained slider (SE 1.0–9.0).
- **Guaranteed unique solutions** — every puzzle is uniqueness-checked during
  generation and asserted again before it ships to the board.
- **Teaching hints** — a Hintoku-style progressive hint engine: technique name →
  where → why → show me → place it.
- **Quality of life** — pencil notes with auto-cleanup, double-tap a note to commit,
  same-number highlighting, immediate wrong-entry flagging, undo, timer with
  auto-pause, per-difficulty best times.
- **Offline forever** — service-worker precache + localStorage/IndexedDB saves with
  `storage.persist()`. Once loaded, it works with no internet, across refreshes,
  and across visits. Progress only resets when you start a new puzzle.
- **iOS-native feel** — safe-area insets, `viewport-fit=cover`, standalone-PWA
  viewport handling, tap-highlight suppression, haptics, system font stack,
  zero external assets (icons are generated PNGs, < 4 KB each).

## Run locally

```bash
python -m http.server 8642   # any static server; ES modules need http(s)
# open http://localhost:8642
```

## Test

```bash
npm test    # node:test suite: solver, generator, grader, bands, hints
```

## Deploy

Static site — `vercel --prod` (or any static host). No build step.
