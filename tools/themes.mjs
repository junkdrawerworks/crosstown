// The lines: packs of puzzles you switch between on the list, each with its own flavour and colour. Every puzzle
// starts in one of the files in tools/themes/ as a clue, the Crosstown and a list of theme words.
// `node tools/make-puzzles.mjs` lays them all out and writes js/puzzles.js and js/detours/.
//
// Ids are what progress is saved under, so they are unique across every line and never change once published.
// `color` is one of the map's line colours (l1 to l8, or cross for the ink of the Crosstown) and tints the line's list.
import { THEMES as MAIN } from './themes/main.mjs';

export const LINES = [
  { id: 'main', name: 'Main Line', about: 'The first 108, a bit of everything', color: 'cross', themes: MAIN },
];

export const THEMES = LINES.flatMap(line => line.themes);
