// What's saved, and how two saved games of a puzzle are put together. Kept apart from the page so the rules can be
// read, and checked, on their own; js/app.js does the reading and writing.
import { LINES, PUZZLES } from './puzzles.js';
import { FARE_PER_TOKEN, fareFor, starsFor } from './rules.js';

export const KEY = 'crosstown.v1';
export const fresh = () => ({ found: [], detours: [], fare: 0, tokens: 0, spent: 0, hint: null, ms: 0, done: false, crossAt: -1, night: false });
export const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
// `erasedAt` is when progress on every line was last erased, in any window (see mergeInto() in app.js). `stars` is each
// puzzle's best stars, as `best` is its best time, kept when it's played again (see bestStars() in app.js).
export const blank = () => ({ options: { clock: false, night: false, line: LINES[0].id }, games: {}, best: {}, stars: {}, erasedAt: 0 });
// A save read into shape: anything missing is filled in, and best times and stars are kept only if they're times and
// stars. (Whether a save can be read at all is the page's to say: see load() in app.js.)
export function shape(raw) {
  const s = blank();
  if (!isObject(raw)) return s;
  const best = isObject(raw.best) ? Object.entries(raw.best).filter(([, t]) => Number.isFinite(t) && t > 0) : [];
  const stars = isObject(raw.stars) ? Object.entries(raw.stars).filter(([, n]) => [1, 2, 3].includes(n)) : [];
  return { options: { ...s.options, ...(isObject(raw.options) ? raw.options : {}) }, games: isObject(raw.games) ? raw.games : {}, best: Object.fromEntries(best),
    stars: Object.fromEntries(stars), erasedAt: Number.isFinite(raw.erasedAt) ? raw.erasedAt : 0 };
}

// A saved game, read against its puzzle, so a damaged save or one from an older layout of the board can't stop
// the page: line numbers the board doesn't have are dropped, and anything else that can't be read starts fresh.
// Each game keeps the letters of the board it was played on (`grid`). If the board has been laid out again since,
// its line numbers would draw lines on the wrong letters, so the puzzle starts fresh; its best time stays. A game
// saved before games kept their letters counts as one on the board as it is now.
export const byId = new Map(PUZZLES.map(p => [p.id, p]));
export function readGame(g, id) {
  const p = byId.get(id);
  if (!isObject(g) || !p) return null;
  if (typeof g.grid === 'string' && g.grid !== p.grid) return null;
  const n = p.lines.length;
  const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);
  const found = Array.isArray(g.found) ? [...new Set(g.found.filter(k => Number.isInteger(k) && k >= 0 && k < n))] : [];
  const h = g.hint;
  // Whole tokens' worth of fare is counted as tokens, as it is when it's earned.
  const fare = count(g.fare) % FARE_PER_TOKEN, tokens = count(g.tokens) + Math.floor(count(g.fare) / FARE_PER_TOKEN);
  const hint = isObject(h) && Number.isInteger(h.line) && h.line >= 0 && h.line < n && !found.includes(h.line) ? { line: h.line, level: h.level > 1 ? 2 : 1 } : null;
  return {
    ...fresh(), ...g, found, hint,
    detours: Array.isArray(g.detours) ? g.detours.filter(d => typeof d === 'string') : [],
    fare, tokens, spent: count(g.spent),
    ms: Number.isFinite(g.ms) && g.ms > 0 ? g.ms : 0,
    done: found.length === n, crossAt: Number.isInteger(g.crossAt) ? g.crossAt : -1, night: g.night === true,
  };
}
export const started = g => !!g && (g.done || g.found.length > 0 || g.detours.length > 0);

// Which of two saved games of a puzzle is the better one to keep: above 0 if `a`, below if `b`, 0 for a tie. A finished
// game beats any unfinished one, then more stars win, then the faster time, then more detours, so a game with detours
// can never take the place of one with more stars. Of two unfinished games, more lines found wins, then more detours.
function ahead(a, b, id) {
  const rank = g => {
    const game = readGame(g, id);
    if (!game) return [0];
    return game.done ? [2, starsFor(game), -Math.round(game.ms), game.detours.length] : [1, game.found.length, game.detours.length];
  };
  const x = rank(a), y = rank(b);
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0);
  return 0;
}
// The game of a puzzle to keep, of two saved in different windows: `a`, `b` or the two put together. Two unfinished
// games are put together, since each may have something the other hasn't: every line and detour either found, every
// token either spent, and the ring or route of the one that spent more. Lines never share stops, so any lines found
// make a board that can be played on. Fare and tokens are counted again from the detours, less the tokens spent. The
// Crosstown counts as found first if it was in either. Otherwise (one is finished, or one was started over since the
// other began: see `restartedAt`) the better game stays whole (see ahead()). A game put together that has nothing `a`
// hasn't is `a` itself.
export function combine(a, b, id) {
  const x = readGame(a, id), y = readGame(b, id);
  if (!x || !y || x.done || y.done || x.restartedAt !== y.restartedAt) return ahead(a, b, id) >= 0 ? a : b;
  const found = [...new Set([...x.found, ...y.found])], detours = [...new Set([...x.detours, ...y.detours])];
  const spent = Math.max(x.spent, y.spent), h = (y.spent > x.spent ? y : x).hint || (y.spent > x.spent ? x : y).hint;
  const hint = h && !found.includes(h.line) ? h : null;
  const same = (p, q) => p.length === q.length && p.every(v => q.includes(v));
  if (same(found, x.found) && same(detours, x.detours) && spent === x.spent && JSON.stringify(hint) === JSON.stringify(x.hint)
    && (x.crossAt === 0 || y.crossAt !== 0)) return a;
  const total = detours.reduce((n, d) => n + fareFor(d), 0);
  return {
    ...x, found, detours, spent, hint,
    tokens: Math.max(0, Math.floor(total / FARE_PER_TOKEN) - spent), fare: total % FARE_PER_TOKEN,
    crossAt: x.crossAt === 0 || y.crossAt === 0 ? 0 : found.indexOf(0),
    ms: Math.max(x.ms, y.ms), done: found.length === byId.get(id).lines.length, night: x.found.length ? x.night : y.night,
  };
}

// ---- progress in a file -----------------------------------------------------------------------------------------
// Progress as it goes into a file (Save progress to a file): every puzzle's game, best time and best stars, by the
// puzzle's id. The options (the clock, night service, the line on show) stay with each browser. The README promises
// that a file saved now keeps loading, so a later version may add to this but never change what's here.
export const APP = 'crosstown';
export const progressOf = doc => ({ app: APP, version: 1, games: doc.games, best: doc.best, stars: doc.stars });
// A file read back, in shape, or null if it isn't Crosstown progress. A game that isn't one is left out.
export function readProgress(raw) {
  if (!isObject(raw) || raw.app !== APP || !isObject(raw.games)) return null;
  const s = shape(raw);
  return { games: Object.fromEntries(Object.entries(s.games).filter(([, g]) => isObject(g))), best: s.best, stars: s.stars };
}
// Two copies of the progress put together with nothing on either side lost: each puzzle keeps the better game, or the
// two put together (see combine()), the faster best time and the more stars. `a` wins a tie, and a puzzle where `a`
// already has the best of everything keeps `a`'s own game, so a copy loaded twice changes nothing the second time.
export function joinProgress(a, b) {
  const out = { games: { ...a.games }, best: { ...a.best }, stars: { ...a.stars } };
  for (const [id, g] of Object.entries(b.games)) out.games[id] = id in out.games ? combine(out.games[id], g, id) : g;
  for (const [id, t] of Object.entries(b.best)) if (!(out.best[id] <= t)) out.best[id] = t;
  for (const [id, n] of Object.entries(b.stars)) if (!(out.stars[id] >= n)) out.stars[id] = n;
  return out;
}
// How many puzzles a copy of the progress has finished: those with stars kept, or a finished game.
export const finishedIn = doc => new Set([...Object.keys(doc.stars), ...Object.keys(doc.games).filter(id => readGame(doc.games[id], id)?.done)]).size;
