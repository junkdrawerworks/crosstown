// The lines: packs of puzzles you switch between on the list, each with its own flavour and colour. Every puzzle
// starts in one of the files in tools/themes/ as a clue, the Crosstown and a list of theme words.
// `node tools/make-puzzles.mjs` lays them all out and writes js/puzzles.js and js/detours/.
//
// Ids are what progress is saved under, so they are unique across every line and never change once published.
// `color` is one of the map's line colours (l1 to l8, or cross for the ink of the Crosstown) and tints the line's list.
import { THEMES as MAIN } from './themes/main.mjs';
import { THEMES as MARKET } from './themes/market.mjs';
import { THEMES as PARK } from './themes/park.mjs';
import { THEMES as WORKSHOP } from './themes/workshop.mjs';
import { THEMES as THEATER } from './themes/theater.mjs';
import { THEMES as UNIVERSITY } from './themes/university.mjs';
import { THEMES as AIRPORT } from './themes/airport.mjs';

export const LINES = [
  { id: 'main', name: 'Main Line', about: 'A bit of everything', color: 'cross', themes: MAIN },
  { id: 'market', name: 'Market Line', about: 'Food and drink', color: 'l1', themes: MARKET },
  { id: 'park', name: 'Park Line', about: 'Nature and the outdoors', color: 'l3', themes: PARK },
  { id: 'workshop', name: 'Workshop Line', about: 'Making, fixing, wearing and the home', color: 'l4', themes: WORKSHOP },
  { id: 'theater', name: 'Theater Line', about: 'Arts, play and pastimes', color: 'l5', themes: THEATER },
  { id: 'university', name: 'University Line', about: 'Science, history, language and the body', color: 'l2', themes: UNIVERSITY },
  { id: 'airport', name: 'Airport Line', about: 'Places, travel and jobs around town', color: 'l6', themes: AIRPORT },
];

export const THEMES = LINES.flatMap(line => line.themes);
