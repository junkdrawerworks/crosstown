// Crosstown: the list of puzzles, the map you trace on, and what's saved between visits.
import { LINES, DETOURS, PUZZLES } from './puzzles.js';
import { W, H, N, row, col, adjacent, spell } from './board.js';
import { MIN_LENGTH, FARE_PER_TOKEN, fareFor, starsFor, clock } from './rules.js';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const el = document.createElementNS(SVG, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
const SITE = 'https://crosstown.junkdrawer.works/';
const single = 'single' in document.documentElement.dataset;   // the one-file copy, shown inside another page
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17.1 6.6 20l1.1-6.1-4.5-4.3 6.1-.8z"/></svg>';

// ---- what's saved -----------------------------------------------------------------------------------------------
// Two windows can be open at once (the installed app and a browser tab, say), so nothing simply writes its own copy
// over the other's. Each write reads what's stored first and changes only what this window changed since its last
// write (see save()), and a write from another window is read in here as it happens (see the storage listener).
const KEY = 'crosstown.v1';
const UNREADABLE = 'crosstown.v1.unreadable';   // a save that couldn't be read, put aside to be got back by hand
const fresh = () => ({ found: [], detours: [], fare: 0, tokens: 0, spent: 0, hint: null, ms: 0, done: false, crossAt: -1, night: false });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const blank = () => ({ options: { clock: false, night: false, line: LINES[0].id }, games: {}, best: {} });
// What's stored, read into shape. Best times are kept only if they're times. A save that can't be read at all, or
// has the wrong shape (its games in a list, say, as a hand edit could leave it), is put aside first (unless one
// already is), before anything can write over it. `putAside` says what went: 'games' when the games couldn't be read.
let putAside = null;
function load() {
  const text = localStorage.getItem(KEY);
  let raw, bad = false;
  try { raw = JSON.parse(text || 'null'); } catch { bad = true; }
  const fits = k => raw[k] === undefined || isObject(raw[k]);
  if (text !== null && !bad && !(isObject(raw) && ['options', 'games', 'best'].every(fits))) bad = true;
  if (bad && localStorage.getItem(UNREADABLE) === null) {
    localStorage.setItem(UNREADABLE, text);
    putAside = isObject(raw) && fits('games') ? 'part' : 'games';
  }
  const s = blank();
  if (!isObject(raw)) return s;
  const best = isObject(raw.best) ? Object.entries(raw.best).filter(([, t]) => Number.isFinite(t) && t > 0) : [];
  return { options: { ...s.options, ...(isObject(raw.options) ? raw.options : {}) }, games: isObject(raw.games) ? raw.games : {}, best: Object.fromEntries(best) };
}
// What this window has changed since its last write: games by id (a game taken out counts too), options by name, and
// whether every game was erased.
const changed = { games: new Set(), options: new Set(), erased: false };
// Whether the browser is keeping anything: not if reading it failed at the start, or the last write failed (storage
// blocked, or full). The list says so (see drawList()).
let readFailed = false, writeFailed = false;
let saved = blank();
try { saved = load(); localStorage.setItem(`${KEY}.check`, '1'); localStorage.removeItem(`${KEY}.check`); } catch { readFailed = true; }
// The games saved couldn't be read when the page opened, so the list starts fresh, and says so (see drawList()).
const startedFresh = putAside === 'games';
const keeping = () => !readFailed && !writeFailed;

// This window's changes, laid over what's stored (`now`). Where both windows have played the same puzzle, the better
// game stays (see ahead()). A game this window took out (Start this puzzle over) goes whatever the other has. The
// faster best time stays.
function mergeInto(now) {
  if (changed.erased) { now.games = {}; now.best = {}; }
  for (const id of changed.games) {
    const mine = saved.games[id];
    if (!mine) delete now.games[id];
    else if (ahead(mine, now.games[id], id) >= 0) now.games[id] = mine;
    const t = saved.best[id];
    if (t && !(now.best[id] <= t)) now.best[id] = t;
  }
  for (const name of changed.options) now.options[name] = saved.options[name];
  return now;
}
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
function save() {
  try {
    const now = mergeInto(load());
    localStorage.setItem(KEY, JSON.stringify(now));
    adopt(now);
    changed.games.clear(); changed.options.clear(); changed.erased = false;
    writeFailed = false;
  } catch { writeFailed = true; /* no storage here: play still works, it just isn't kept */ }
}
// Takes on what's stored as this window's own. The puzzle on screen keeps the game being played, unless another
// window has a better one (see catchUp()).
function adopt(now) {
  saved = now;
  if (cur && started(cur.game) && ahead(cur.game, now.games[cur.p.id], cur.p.id) >= 0) saved.games[cur.p.id] = cur.game;
}
const setOption = (name, value) => { saved.options[name] = value; changed.options.add(name); save(); };
const setGame = (id, game) => { if (game) saved.games[id] = game; else delete saved.games[id]; changed.games.add(id); save(); };

// A saved game, read against its puzzle, so a damaged save or one from an older layout of the board can't stop
// the page: line numbers the board doesn't have are dropped, and anything else that can't be read starts fresh.
// Each game keeps the letters of the board it was played on (`grid`). If the board has been laid out again since,
// its line numbers would draw lines on the wrong letters, so the puzzle starts fresh; its best time stays. A game
// saved before games kept their letters counts as one on the board as it is now.
const byId = new Map(PUZZLES.map(p => [p.id, p]));
const gameFor = id => readGame(saved.games[id], id);
function readGame(g, id) {
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
const started = g => !!g && (g.done || g.found.length > 0 || g.detours.length > 0);

// ---- the lines --------------------------------------------------------------------------------------------------
// The list shows one line at a time; the one last picked is kept with the options. Puzzle numbers count along a line.
const lineOf = id => LINES.find(l => l.id === id);
let line = lineOf(saved.options.line) || LINES[0];
let list = line.puzzles;
const shortName = l => l.name.replace(/ Line$/, '');
// A line's colour, the colour of text on it, and the colour of a finished roundel (a shade deeper on three lines in
// the light palette, so its white number has the contrast text needs).
const tint = l => (l.color === 'cross' ? ['var(--cross)', 'var(--on-cross)', 'var(--cross)'] : [`var(--${l.color})`, 'var(--on-line)', `var(--${l.color}-deep, var(--${l.color}))`]);
function tally(l) {
  let finished = 0, stars = 0, going = 0;
  for (const p of l.puzzles) { const g = gameFor(p.id); if (g?.done) { finished++; stars += starsFor(g); } else if (started(g)) going++; }
  return { finished, stars, going, total: l.puzzles.length };
}
// Shows a line. Only picking one saves it (see pickLine()), so opening the page writes nothing, and a line picked
// in another window isn't kept over by this one.
function setLine(l) {
  line = l; list = l.puzzles;
  const [c, on, deep] = tint(l);
  $('s-list').style.setProperty('--line', c); $('s-list').style.setProperty('--on-line-c', on); $('s-list').style.setProperty('--line-deep', deep);
  detoursOf(l.id);   // fetched ahead, so they're in by the time a puzzle opens
}
const pickLine = l => { setLine(l); setOption('line', l.id); };
// Another line's list, from the top, picked. A screen reader hears which line it is now and how far along, in a moment,
// once the sheet that picked it has closed (the page behind it can't be heard until then).
let listSaid = 0;
function showLine(l) {
  pickLine(l); drawList(); $('s-list').querySelector('.list-scroll').scrollTop = 0;
  const { finished, total } = tally(l), said = $('list-said');
  said.textContent = ''; clearTimeout(listSaid);
  listSaid = setTimeout(() => { said.textContent = `${l.name}, ${finished ? `${finished} of ${total} finished` : `${total} puzzles`}`; }, 100);
}

// Each line's detours come in their own file, loaded the first time one of its puzzles (or the line) is shown.
// Until it's in, a word that isn't an answer waits for it (see wait()). If it can't be loaded (offline with no copy,
// or a weak signal), the next word asks for it again. A file made for other boards than these (`stale`: a new release
// went out since the page opened, and its detours came instead) can't be used, and asking again would bring the same
// file, so words aren't checked against it and the page says once that a new version is out.
const detourSets = new Map();
const STALE = "Can't check detours right now. Reload to play the new version";
let toldNewer = false;
function detoursOf(lineId) {
  let d = detourSets.get(lineId);
  if (d && (!d.failed || d.stale)) return d;
  d = { words: {}, ready: false, failed: false, stale: false };
  d.wait = DETOURS[lineId]().then(m => {
    if (m.FOR === lineOf(lineId).fp) { d.words = m.DETOURS; return; }
    d.failed = d.stale = true;
    if (!toldNewer) { toldNewer = true; toast('A new version of Crosstown is out. Reload to play it', 5000); }
  }, () => { d.failed = true; }).finally(() => { d.ready = true; });
  detourSets.set(lineId, d);
  return d;
}

// ---- the list ---------------------------------------------------------------------------------------------------
function nextUp(from = -1) {
  for (let k = 1; k <= list.length; k++) { const i = (from + k) % list.length; if (!gameFor(list[i].id)?.done) return i; }
  return -1;
}
// The next line along with a puzzle left to play, for when this one is finished.
const nextLine = () => { const at = LINES.indexOf(line); for (let k = 1; k < LINES.length; k++) { const l = LINES[(at + k) % LINES.length]; if (tally(l).finished < l.puzzles.length) return l; } return null; };

function drawList() {
  const route = $('route');
  route.textContent = '';
  let finished = 0, stars = 0, prevDone = false;
  const going = [];
  list.forEach((p, i) => {
    const g = gameFor(p.id);
    const state = g?.done ? 'done' : started(g) ? 'going' : 'todo';
    if (state === 'going') going.push(i);
    const li = document.createElement('li');
    li.className = state + (prevDone ? ' after-done' : '');
    prevDone = state === 'done';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'row';
    const sub = document.createElement('span'); sub.className = 'row-sub';
    if (state === 'done') {
      const n = starsFor(g); finished++; stars += n;
      const st = document.createElement('span'); st.className = 'st'; st.textContent = '★'.repeat(n) + '☆'.repeat(3 - n);
      st.setAttribute('role', 'img'); st.setAttribute('aria-label', `${n} of 3 stars`);   // not "black star, white star
      sub.append(p.name, ' ', st);
      if (saved.options.clock && saved.best[p.id]) sub.append(` ${clock(saved.best[p.id])}`);
    } else if (state === 'going') {
      sub.textContent = `${g.found.length} of ${p.lines.length} lines found`;
    } else {
      sub.textContent = `${p.lines.length} lines`;
    }
    // Night service keeps the clue off the list too, the same as on the sign, until a line is found.
    const dark = saved.options.night && !g?.done && !g?.found.length;
    const clue = document.createElement('span'); clue.className = 'row-clue' + (dark ? ' dark-hours' : ''); clue.textContent = dark ? 'Night service' : p.clue;
    const main = document.createElement('span'); main.className = 'row-main'; main.append(clue, sub);
    const num = document.createElement('span'); num.className = 'roundel'; num.innerHTML = `<span class="sr-only">No. </span>${i + 1}`;   // said as on screen elsewhere
    const go = document.createElement('span'); go.className = 'row-go'; go.setAttribute('aria-hidden', 'true');
    go.textContent = state === 'going' ? 'Resume' : state === 'done' ? 'Map' : '';
    btn.append(num, main, go);
    btn.addEventListener('click', () => fromList(i));
    li.append(btn); route.append(li);
  });
  // The big button plays the next puzzle, or moves on to the next line with one left. With every line finished it goes,
  // rather than staying as a button that does nothing, and the tally gives the whole network's.
  const up = nextUp(), onward = up < 0 ? nextLine() : null, end = up < 0 && !onward;
  $('b-continue').textContent = up >= 0 ? `${started(gameFor(list[up].id)) ? 'Resume' : 'Play'} No. ${up + 1}` : onward ? `On to ${shortName(onward)}` : '';
  $('b-continue').disabled = false;   // off in the page as sent, until this has run
  $('b-continue').hidden = end;
  // Where reading worked and only the writes since have failed (storage full, say), what was saved is still there.
  $('unkept').hidden = keeping();
  $('unkept').textContent = readFailed ? "This browser isn't keeping your progress, so it goes when the page closes."
    : 'This browser has stopped saving, so new progress goes when the page closes.';
  $('tally').classList.toggle('end', end);
  $('aside-note').hidden = !startedFresh;   // the network's tally, in ink where the big button was
  if (end) {
    let all = 0, got = 0;
    for (const l of LINES) { const t = tally(l); all += t.total; got += t.stars; }
    // Broken, where it has to be, between its parts rather than inside one.
    const part = text => { const s = document.createElement('span'); s.className = 'nb'; s.textContent = text; return s; };
    $('tally').textContent = 'Every line finished: ';
    $('tally').append(part(`${all.toLocaleString()} puzzles,`), ' ', part(`${got.toLocaleString()} of ${(all * 3).toLocaleString()} stars`));
  } else $('tally').textContent = finished ? `${finished} of ${list.length} finished, ${stars} of ${list.length * 3} stars` : `${list.length} puzzles`;
  // The big button takes the line in order, so a puzzle under way further down, behind one not yet played, would be
  // lost from sight: the tally ends with a way to the nearest, "· No. 20 under way" (or "· 3 under way, next No. 20").
  const later = going.filter(i => i > up);
  if (up >= 0 && later.length) {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.setAttribute('aria-hidden', 'true');
    const to = document.createElement('button'); to.type = 'button'; to.className = 'tally-link';
    to.textContent = later.length > 1 ? `${later.length} under way, next No. ${later[0] + 1}` : `No. ${later[0] + 1} under way`;
    to.addEventListener('click', () => fromList(later[0]));
    $('tally').append(sep, to);
  }
  route.setAttribute('aria-label', `${line.name} puzzles`);
  route.classList.toggle('finished', finished === list.length);
  $('line-name').textContent = line.name;
  $('line-about').textContent = line.about;
  $('b-line').setAttribute('aria-label', `${line.name}: ${line.about}. Change line`);
}

// The lines sheet: every line with how far along it you are, starting on the one on show. Picking one shows its list
// from the top. The list is drawn before the sheet closes, so focus goes back to a button that names the new line.
function openLines() {
  drawLines();
  openSheet('sheet-lines');
  const now = $('lines').querySelector('[aria-current]');
  now.focus({ preventScroll: true }); now.scrollIntoView({ block: 'center' });
}
function drawLines() {
  const ul = $('lines'), at = [...ul.children].findIndex(li => li.contains(document.activeElement));
  ul.textContent = '';
  let done = 0, all = 0, got = 0;
  for (const l of LINES) {
    const { finished, stars, going, total } = tally(l);
    done += finished; all += total; got += stars;
    const li = document.createElement('li');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'line-row';
    if (l === line) btn.setAttribute('aria-current', 'true');
    const [c] = tint(l);
    const bar = document.createElement('span'); bar.className = 'line-bar'; bar.style.background = c; bar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong'); name.textContent = l.name;
    const about = document.createElement('small'); about.textContent = l.about;
    // The line on show says so in words, as a strip map does, not only by its darker edge (which a hover looks like).
    const here = l === line ? document.createElement('small') : null;
    if (here) { here.className = 'here'; here.textContent = 'You are here'; }
    const prog = document.createElement('span'); prog.className = 'line-prog';
    // "12 of 81 · 30★", or "Finished · 243★" for a whole line, the dot drawn, as the font's own has no width. A puzzle
    // under way on a line with some finished is told to a screen reader; the eye has the list for that.
    const whole = finished === total, stared = `${stars} star${stars === 1 ? '' : 's'}`;
    if (finished) {
      const sep = document.createElement('span'); sep.className = 'sep';
      const st = document.createElement('span'); st.className = 'st'; st.textContent = `${stars}★`;
      prog.append(whole ? 'Finished' : `${finished} of ${total}`, sep, st);
    } else prog.textContent = going ? 'Under way' : `${total} puzzles`;
    const said = whole ? `Finished, ${stared}` : finished ? `${finished} of ${total} finished, ${stared}${going ? `, ${going} under way` : ''}` : going ? 'Under way' : `${total} puzzles`;
    btn.setAttribute('aria-label', `${l.name}: ${l.about}. ${said}`);
    const main = document.createElement('span'); main.className = 'line-main'; main.append(name, ...(here ? [here] : []), about);
    btn.append(bar, main, prog);
    btn.addEventListener('click', () => { if (l !== line) showLine(l); closeSheets(); });
    li.append(btn); ul.append(li);
  }
  // Each line keeps its own progress (unless the browser isn't keeping any), then the count over every line.
  const [d, a, g] = [done, all, got].map(n => n.toLocaleString());
  const count = done === all ? ` All ${a} finished, ${g} stars.` : done ? ` ${d} of ${a} finished${got ? `, ${g} star${got === 1 ? '' : 's'}` : ''}.` : '';
  $('lines-note').textContent = (keeping() ? 'Each line is its own set of puzzles and keeps its own progress.'
    : "Each line is its own set of puzzles. This browser isn't keeping progress, so it goes when the page closes.") + count;
  ul.children[at]?.querySelector('button').focus({ preventScroll: true });   // drawn again while open: focus stays put
}

// ---- one puzzle -------------------------------------------------------------------------------------------------
let cur = null;      // the puzzle on screen: { i, p, words, extra, lineOf, game, waiting }
let sel = [];        // stops in the word being traced
let cursor = -1;     // keyboard position
let drag = null;     // { pointerId, changed, tapLast, joined, blocked: the stop on a found line it ran into, or -1 }
let ticking = 0, since = 0;
const board = $('board');
const layers = {};
const stops = [];

const cx = i => col(i) * 10 + 5, cy = i => row(i) * 10 + 5;
const points = path => path.map(i => `${cx(i)},${cy(i)}`).join(' ');

function buildBoard() {
  board.textContent = '';
  for (const name of ['lines', 'guide', 'trace', 'stops']) { layers[name] = svg('g'); board.append(layers[name]); }
  stops.length = 0;
  for (let i = 0; i < N; i++) {
    const g = svg('g', { class: 'stop' });
    // The dot, a token's ring, and the keyboard's cursor: a ring of its own outside the dot, with the map showing
    // between, so it shows on any stop (a blue one too) and can't be taken for a token's ring.
    g.append(svg('circle', { class: 'dot', cx: cx(i), cy: cy(i), r: 3.75 }), svg('circle', { class: 'ring', cx: cx(i), cy: cy(i), r: 4.45 }),
      svg('circle', { class: 'cur', cx: cx(i), cy: cy(i), r: 4.9 }));
    const t = svg('text', { x: cx(i), y: cy(i) + 1.75 }); t.textContent = cur.p.grid[i];
    g.append(t); layers.stops.append(g); stops.push(g);
  }
}

function drawLine(k, isNew) {
  const line = svg('polyline', { class: `line c${k}${isNew ? ' fresh' : ''}`, points: points(cur.p.lines[k]), pathLength: 1 });
  layers.lines.append(line);
  if (k === 0) layers.lines.append(svg('polyline', { class: `stripe${isNew ? ' fresh' : ''}`, points: points(cur.p.lines[0]), pathLength: 1 }));
}

function paint() {
  const { p, game } = cur;
  const found = new Set(game.found);
  stops.forEach((g, i) => {
    const k = cur.lineOf[i];
    const on = found.has(k);
    const hinted = !on && game.hint && game.hint.line === k;
    g.setAttribute('class', 'stop' + (on ? ` on c${k}` : '') + (sel.includes(i) ? ' sel' : '') + (hinted ? ' hint' : '')
      + (hinted && game.hint.level > 1 && p.lines[k][0] === i ? ' first' : '') + (i === cursor ? ' cursor' : ''));
  });
  layers.trace.textContent = '';
  if (sel.length > 1) layers.trace.append(svg('polyline', { class: 'trace', points: points(sel) }));
  layers.guide.textContent = '';
  if (game.hint && game.hint.level > 1 && !found.has(game.hint.line)) layers.guide.append(svg('polyline', { class: 'guide', points: points(p.lines[game.hint.line]) }));

  const left = p.lines.length - game.found.length;
  $('count').textContent = game.done ? 'All found' : `${game.found.length} of ${p.lines.length} lines`;
  const hidden = saved.options.night && !game.found.length && !game.done;
  $('clue').textContent = hidden ? 'Night service. The clue shows up with your first line.' : p.clue;
  $('clue').classList.toggle('dark-hours', hidden);
  // What the map is described by when it takes the focus, in words of its own rather than the screen's capitals, then
  // the keys: "Market Line, No. 1. Clue: Extra cheese. 0 of 7 lines."
  const n = p.lines.length, stop = t => (/[.?!…]$/.test(t) ? t : `${t}.`);
  $('map-where').textContent = `${cur.line.name}, No. ${cur.i + 1}. ${hidden ? 'Night service.' : stop(`Clue: ${p.clue}`)} ${game.done ? `All ${n} lines found` : `${game.found.length} of ${n} lines`}.`;

  const pips = $('pips'); pips.textContent = '';
  for (let n = 0; n < FARE_PER_TOKEN; n++) { const pip = document.createElement('i'); if (n < game.fare) pip.className = 'full'; pips.append(pip); }
  $('meter').setAttribute('aria-label', `Fare: ${game.fare} of ${FARE_PER_TOKEN}`);
  // A token rings a line's stops, then draws its route. With no tokens the button is off, and while a route shows on a
  // line not yet found it's off too: the route already gives the line away, and another token would ring a different
  // line and lose it. Either way it can still be tapped, to say how to get one or why it's off (see the click below).
  const tok = $('b-token');
  tok.disabled = !left;
  const off = !!left && (!game.tokens || routeFirst(game));
  if (off) tok.setAttribute('aria-disabled', 'true'); else tok.removeAttribute('aria-disabled');
  tok.classList.toggle('ready', !!left && !off);
  $('token-label').textContent = game.tokens ? `Use a token (${game.tokens})` : 'No tokens';
  // The buttons for after a finish wait for the done sheet (see found()).
  const over = game.done && !cur.finishing;
  $('fare').hidden = over; $('after').hidden = !over;
  if (over) { const { n, to } = after(); $('b-next').hidden = n < 0 && !to; $('b-next').textContent = to ? `On to ${shortName(to)}` : 'Next puzzle'; }
}

// The readout, a live region: `heard` is said after the text but not shown (what the chip and the drawn line tell the
// eye, say).
function say(text, kind = '', chip = null, heard = '') {
  const out = $('readout');
  out.className = 'readout' + (kind ? ` ${kind}` : '');
  out.textContent = '';
  if (chip !== null) { const dot = document.createElement('span'); dot.className = 'chip'; dot.style.background = chip ? `var(--l${chip})` : 'var(--cross)'; out.append(dot); }
  out.append(text);
  if (heard) { const s = document.createElement('span'); s.className = 'sr-only'; s.textContent = heard; out.append(s); }
  if (kind.includes('nope')) { out.style.animation = 'none'; void out.offsetWidth; out.style.animation = ''; }
}
// A word built by taps (or the keyboard) isn't sent until its last letter is tapped again, so until then it shows
// muted, unlike a word that's been found, and says how to send it: "KEYS · tap S again", or with the keys, "Enter
// again on S". A word being dragged is sent as the finger lifts, and shows as usual.
function showTrace(keys = false) {
  const word = sel.length ? spell(cur.p.grid, sel) : '';
  if (sel.length < 2 || drag?.changed) { say(word); return; }
  say(word, 'pending');
  const part = (cls, text = '') => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
  const sep = part('sep'), last = word.at(-1);
  sep.setAttribute('aria-hidden', 'true');
  $('readout').append(sep, part('sr-only', ', '), part('send', keys ? `Enter again on ${last}` : `tap ${last} again`));
}

// The bar names the line and the number, "Main · No. 1". On a narrow phone with the clock on, only the line's name
// gives way, so the number always shows. The dot is drawn, since the font's own has no width and hugs the number;
// a screen reader hears "Main, No. 1".
function showWhere(i) {
  const where = $('where'), part = (cls, text = '') => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
  where.textContent = '';
  if (LINES.length > 1) {
    const sep = part('sep'); sep.setAttribute('aria-hidden', 'true');
    where.append(part('where-line', shortName(line)), part('sr-only', ', '), sep);
  }
  where.append(part('where-no', `No. ${i + 1}`));
}

function openPuzzle(i) {
  const p = list[i];
  const lineOf = new Int8Array(N);
  p.lines.forEach((line, k) => line.forEach(stop => { lineOf[stop] = k; }));
  const game = { ...(gameFor(p.id) || fresh()), grid: p.grid };
  cur = { i, p, line, words: p.lines.map(l => spell(p.grid, l)), extra: detoursOf(line.id), lineOf, game };
  sel = []; cursor = -1; $('spoken').textContent = '';
  showWhere(i);
  $('b-back').setAttribute('aria-label', `${line.name} puzzles`);
  document.title = `${shortName(line)} No. ${i + 1} · Crosstown`;
  buildBoard();
  for (const k of game.found) drawLine(k, false);
  $('s-list').hidden = true; $('s-play').hidden = false;
  scrollTo(0, 0);   // zoomed in, the play screen can be taller than the window: a new puzzle starts at its clue
  // Until a first word is sent, the puzzle opens saying how to trace one. (A puzzle only looked at is saved too, for
  // its clock, so what's saved can't say whether anyone has traced yet.)
  if (game.done) sayName();
  else if (!traced()) say('Drag across the letters to trace a word, or tap them and tap the last one again', 'note');
  else say('');
  paint();
  startClock();
  // The control that opened it (a row, Continue, Next puzzle) is on a screen that's gone, so the focus goes to the map:
  // a keyboard can play straight away, and a screen reader hears where it is. After a tap no ring shows.
  board.focus({ preventScroll: true });
}

// Another window has a better game of the puzzle on screen (finished there, or further along; see ahead()), so this
// one takes it in and says so, rather than carrying on with a game that can only lose to it when saved. Not while the
// last line draws or a sheet is open: closing the sheet looks again.
function catchUp() {
  if (!cur || cur.finishing || anySheet()) return;
  const there = saved.games[cur.p.id];
  if (there === cur.game || ahead(there, cur.game, cur.p.id) <= 0) return;
  const game = readGame(there, cur.p.id);
  stopClock();
  cur.game = { ...game, grid: cur.p.grid };
  saved.games[cur.p.id] = cur.game;
  sel = []; drag = null;
  layers.lines.textContent = '';
  for (const k of game.found) drawLine(k, false);
  say(game.done ? 'Finished in another window' : 'Carried on in another window', 'note');
  paint();
  startClock();
  if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('[hidden]')) board.focus({ preventScroll: true });
}

const keep = () => setGame(cur.p.id, cur.game);
// Whether a word has ever been sent here: kept with the options from the first one, and true of a save from before
// that with a line or a detour in it.
const traced = () => saved.options.traced === true || Object.keys(saved.games).some(id => started(gameFor(id)));
// A finished map says its name, with the Crosstown's colour, however it was reached.
const sayName = () => say(cur.p.name, 'note', 0);

// Back on the list, the puzzle just left is in sight with the focus on it, however it was reached (Continue, Next
// puzzle a few times, Forward from another line's list), so a keyboard carries on from there.
function leave() {
  stopClock();
  if (cur && (cur.game.found.length || cur.game.detours.length || cur.game.ms > 5000)) keep();
  const left = cur && cur.line === line ? cur.i : -1;
  cur = null;
  drag = null;   // Back can come in the middle of a drag, and letting go after it has no puzzle to spell the word on
  $('s-play').hidden = true; $('s-list').hidden = false;
  document.title = 'Crosstown';
  drawList();
  toRow(left);
}
// Puts a puzzle's row in sight (in the middle, if it's out of sight), and the focus on it (unless `focus` is false).
function toRow(i, focus = true) {
  const row = $('route').children[i];
  if (!row) return;
  const r = row.getBoundingClientRect(), view = $('s-list').querySelector('.list-scroll').getBoundingClientRect();
  if (r.top < view.top || r.bottom > view.bottom) row.scrollIntoView({ block: 'center' });
  if (focus) row.querySelector('.row').focus({ preventScroll: true });
}

// The clock only runs while the puzzle is on screen and unfinished.
function startClock() {
  stopClock();
  $('clock').hidden = !saved.options.clock;
  $('clock').textContent = clock(cur.game.ms);
  if (cur.game.done || document.hidden) return;
  since = performance.now();
  ticking = setInterval(() => {
    const now = performance.now(); cur.game.ms += now - since; since = now;
    $('clock').textContent = clock(cur.game.ms);
  }, 500);
}
function stopClock() {
  if (!ticking) return;
  clearInterval(ticking); ticking = 0;
  if (cur) cur.game.ms += performance.now() - since;
}
// Back on screen, a puzzle another window has got further with since is taken in (see catchUp()), in case this window
// was asleep when that was saved.
document.addEventListener('visibilitychange', () => {
  if (!cur) return;
  if (document.hidden) { stopClock(); keep(); return; }
  if (anySheet()) return;
  try { adopt(mergeInto(load())); } catch { /* nothing stored to look at */ }
  startClock(); catchUp();
});

// ---- tracing ----------------------------------------------------------------------------------------------------
function stopAt(e, reach) {
  const box = board.getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width * W, y = (e.clientY - box.top) / box.height * H;
  const c = Math.floor(x), r = Math.floor(y);
  if (c < 0 || c >= W || r < 0 || r >= H) return -1;
  return Math.hypot(x - c - 0.5, y - r - 0.5) <= reach ? r * W + c : -1;
}
const taken = i => cur.game.found.includes(cur.lineOf[i]);
// A stop on a finished line just tells you which line it is, whether you tap it or press Enter on it.
const nameLine = i => { const k = cur.lineOf[i]; say(k ? cur.words[k] : `Crosstown: ${cur.p.name}`, k ? '' : 'note', k); };
// A word can't go on through a stop that's on a found line: tracing into one says so, rather than skipping over it to
// spell a different word, or dropping a tapped word.
const sayTaken = i => { const k = cur.lineOf[i]; say(`${cur.p.grid[i]} is on the ${k ? `${cur.words[k]} line` : 'Crosstown'} already. Each letter is used once`, 'note nope'); };
const takenNext = i => taken(i) && sel.length > 0 && !sel.includes(i) && adjacent(sel[sel.length - 1], i);

// One finger traces at a time: while it's down, another finger (or a palm) resting on the map is ignored, rather
// than starting a word of its own and losing the one being traced. (A drag whose finger has gone, without the
// browser saying so, no longer holds the capture, and so doesn't block the next one.)
const other = e => drag && e.pointerId !== drag.pointerId;
board.addEventListener('pointerdown', e => {
  if (!cur || e.button > 0 || (other(e) && board.hasPointerCapture?.(drag.pointerId))) return;
  const i = stopAt(e, 0.5);
  if (i < 0) return;
  e.preventDefault();
  cursor = -1;
  // A tapped word waiting beside it stays, and hears why the stop can't be added; otherwise the stop names its line.
  if (taken(i)) { if (!cur.game.done && takenNext(i)) sayTaken(i); else { sel = []; nameLine(i); } paint(); return; }
  if (cur.game.done) return;
  board.setPointerCapture?.(e.pointerId);
  drag = { pointerId: e.pointerId, changed: false, tapLast: false, joined: false, blocked: -1 };
  const at = sel.indexOf(i);
  if (at >= 0 && at === sel.length - 1) drag.tapLast = true;
  else if (at >= 0) sel = sel.slice(0, at + 1);
  else if (sel.length && adjacent(sel[sel.length - 1], i)) { sel.push(i); drag.joined = true; }
  else sel = [i];
  showTrace(); paint();
});
board.addEventListener('pointermove', e => {
  if (!drag || !cur || other(e) || drag.blocked >= 0) return;
  const i = stopAt(e, 0.4);
  if (i < 0 || i === sel[sel.length - 1]) return;
  // A tap beside the tapped letters adds to their word, but a drag from there spells a word of its own, so a stray
  // tap can't end up in front of it. Dragging on from the last tapped letter still carries that word on.
  const word = drag.joined ? sel.slice(-1) : sel;
  if (word.length > 1 && i === word[word.length - 2]) word.pop();
  else if (!word.includes(i) && adjacent(word[word.length - 1], i)) {
    // Into a stop on a found line: the drag goes no further, says why straight away, and sends nothing when it ends.
    if (taken(i)) { drag.blocked = i; sayTaken(i); return; }
    word.push(i);
  } else return;
  sel = word; drag.joined = false;
  drag.changed = true;
  showTrace(); paint();
});
board.addEventListener('pointerup', e => {
  if (!drag || other(e)) return;
  const { changed, tapLast, blocked } = drag; drag = null;
  if (blocked >= 0) { sel = []; paint(); }
  else if (changed || tapLast) submit();
});
// The browser takes the touch back (a system gesture, palm rejection): the word being traced goes, not half of it.
board.addEventListener('pointercancel', e => {
  if (!drag || other(e)) return;
  drag = null; sel = [];
  if (cur) { showTrace(); paint(); }
});

// Each arrow move is read out to screen readers in a line of its own, kept off the screen and apart from the
// readout: the letter and where it is, and whether a token has ringed it, or the line it's on once that line is
// found. The row and column come every time, so two stops that are otherwise alike still sound different. A stop in
// the word being traced says where in the word it is, since Enter there cuts the word back to it, or on the last
// letter sends it.
function speak(i, edge = false) {
  const k = cur.lineOf[i], at = `row ${row(i) + 1}, column ${col(i) + 1}`, hint = cur.game.hint, n = sel.indexOf(i);
  let words = `${cur.p.grid[i]}, ${at}`;
  if (taken(i)) words = `${cur.p.grid[i]}, on the ${k ? `${cur.words[k]} line` : 'Crosstown'}, ${at}`;
  else if (hint?.line === k) words += hint.level > 1 && cur.p.lines[k][0] === i ? ', ringed, the route starts here' : ', ringed';
  if (n >= 0) words += `, letter ${n + 1} of your word${n > 0 && n === sel.length - 1 ? ', Enter sends it' : ''}`;
  if (edge) words = `${cur.p.grid[i]}, ${at}, edge of the map`;
  $('spoken').textContent = words;
}

// The map taken by the keyboard (Tab, or a puzzle opened with a key), with no word under way, says how to play it
// with keys: on a first visit in place of the tip on dragging, and otherwise until the first key.
const KEYS_TIP = 'Arrow keys move, Enter adds a letter, Enter again sends';
let keysTip = false;   // the tip goes at the next key
board.addEventListener('focus', () => {
  if (!cur || cur.game.done || sel.length || !board.matches(':focus-visible')) return;
  say(KEYS_TIP, 'note');
  keysTip = traced();
});

const STEPS = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0], Home: [-1, -1], PageUp: [-1, 1], End: [1, -1], PageDown: [1, 1] };
const PAD = { Numpad7: 'Home', Numpad8: 'ArrowUp', Numpad9: 'PageUp', Numpad4: 'ArrowLeft', Numpad6: 'ArrowRight', Numpad1: 'End', Numpad2: 'ArrowDown', Numpad3: 'PageDown' };

// On a finished map every stop is on a found line, so the arrows and Enter only name lines there, as a tap does.
board.addEventListener('keydown', e => {
  if (!cur) return;
  // The arrows, and the diagonals as a grid usually has them: Home and Page Up up left and right, End and Page Down
  // down left and right, as on the number pad (where 7, 9, 1 and 3 do the same with Num Lock on, and 8, 4, 6 and 2
  // are the arrows).
  const step = STEPS[e.key] || STEPS[PAD[e.code]];
  if (keysTip && (step || ['Enter', ' ', 'Escape', 'Backspace'].includes(e.key))) {
    keysTip = false;
    if ($('readout').textContent === KEYS_TIP) say('');
  }
  if (step) {
    // A move off the map stays put, and says so, so it's heard (the same words again would be silent).
    let edge = false;
    if (cursor < 0) cursor = sel.length ? sel[sel.length - 1] : 0;
    else { const r = row(cursor) + step[0], c = col(cursor) + step[1]; if (r >= 0 && r < H && c >= 0 && c < W) cursor = r * W + c; else edge = true; }
    speak(cursor, edge);
  } else if (e.key === 'Enter' || e.key === ' ') {
    // Before any arrow, Enter puts the cursor down (on the word's last letter, or the first stop) and says where.
    if (cursor < 0) { cursor = sel.length ? sel[sel.length - 1] : 0; speak(cursor); e.preventDefault(); paint(); return; }
    const at = sel.indexOf(cursor);
    if (taken(cursor)) { if (!cur.game.done && takenNext(cursor)) sayTaken(cursor); else nameLine(cursor); }
    else if (at >= 0 && at === sel.length - 1) { e.preventDefault(); submit(); return; }
    else if (at >= 0) sel = sel.slice(0, at + 1);
    else if (sel.length && adjacent(sel[sel.length - 1], cursor)) sel.push(cursor);
    else sel = [cursor];
    if (!taken(cursor)) showTrace(true);
  } else if ((e.key === 'Escape' || e.key === 'Backspace') && !cur.game.done) {
    if (e.key === 'Backspace') sel.pop(); else { if (sel.length) $('spoken').textContent = 'Word cleared'; sel = []; }
    showTrace(true);
  } else return;
  e.preventDefault(); paint();
});
// Coming back to the map reads out where the cursor lands, even if it's the stop it left from.
board.addEventListener('blur', () => { $('spoken').textContent = ''; if (cursor >= 0) { cursor = -1; if (cur) paint(); } });

function submit() {
  const word = spell(cur.p.grid, sel);
  sel = [];
  if (word.length > 1 && saved.options.traced !== true) setOption('traced', true);
  judgeWord(word);
}
function judgeWord(word) {
  const { game, words } = cur;
  if (word.length < MIN_LENGTH) { say(word.length > 1 ? `Too short: words have ${MIN_LENGTH} letters or more` : '', 'note nope'); paint(); return; }
  const k = words.findIndex((w, n) => w === word && !game.found.includes(n));
  if (k >= 0) return found(k);
  if (cur.extra.failed) cur.extra = detoursOf(cur.line.id);   // ask again: the signal may be back
  if (cur.waiting || (!cur.extra.ready && !game.detours.includes(word.toLowerCase()))) { wait(word); return; }
  if (cur.extra.stale && !game.detours.includes(word.toLowerCase())) { say(STALE, 'note'); paint(); return; }
  const { news, counted } = fares(game, cur.p, cur.extra, [word]);
  say(...news);
  if (counted) keep();
  paint();
}

// Words traced while the line's detours are on their way wait for them together, and count or don't all at once
// when the file comes or fails (see land()). After WAIT_LIMIT the readout says they're still waiting, rather than
// leave "One moment" up on a connection that has stalled.
const WAIT_LIMIT = 6000; // ms
const SLOW = 'Detours are still on their way. Your words will count when they come';
const pending = new Set();   // the puzzles (cur as it was) with words waiting, the one on screen or ones left since
function wait(word) {
  const mine = cur;
  let q = mine.waiting;
  if (!q) {
    q = mine.waiting = { words: [], extra: mine.extra };
    q.timer = setTimeout(() => land(mine, q, false), WAIT_LIMIT);
    q.extra.wait.then(() => land(mine, q, !q.extra.failed));
    pending.add(mine);
  }
  q.words.push(word);
  say(q.late ? SLOW : 'One moment', 'note');
  paint();
}
// Starting a puzzle over, or erasing everything, drops the words still waiting on it (`id`), or on any puzzle.
function dropWaiting(id) {
  for (const m of pending) if (!id || m.p.id === id) { clearTimeout(m.waiting.timer); m.waiting = null; pending.delete(m); }
}

// The waiting words land: counted if the detours came (`arrived`), and if they didn't, not called anything, since
// they may well be detours. On a finished map they're dropped, as fare is no use there and the done sheet has
// already counted the detours. After Back they count in the game that was left, and it's saved. At WAIT_LIMIT, with
// the file still coming, they go on waiting for it (`late`), and later words join them.
function land(mine, q, arrived) {
  if (mine.waiting !== q) return;   // landed already, or dropped
  const shown = cur && cur.p.id === mine.p.id ? cur : null;
  const game = shown ? shown.game : gameFor(mine.p.id) || mine.game;
  if (!arrived && !q.extra.ready) {
    q.late = true;
    if (shown && !game.done) { say(SLOW, 'note'); paint(); }
    return;
  }
  mine.waiting = null; clearTimeout(q.timer); pending.delete(mine);
  if (game.done) return;
  if (!arrived) {
    if (shown) { say(q.extra.stale ? STALE : "Can't check detours right now. Try that word again in a moment", 'note'); paint(); }
    return;
  }
  const { news, counted } = fares(game, mine.p, q.extra, q.words);
  if (shown) { say(...news); if (counted) keep(); paint(); }
  else if (counted) { setGame(mine.p.id, { ...game, grid: mine.p.grid }); if (!cur) drawList(); }
}

// Counts the words that are new detours, and says the best news among them: a token earned, then a detour, then a
// word already counted, then not a word on this map.
function fares(game, p, extra, list) {
  const got = []; let again = '', won = 0;
  for (const word of list) {
    const lower = word.toLowerCase();
    if (game.detours.includes(lower)) again = word;
    else if (isDetour(extra, p.id, lower)) {
      const fare = fareFor(lower);
      game.detours.push(lower); game.fare += fare; got.push([lower, fare]);
      while (game.fare >= FARE_PER_TOKEN) { game.fare -= FARE_PER_TOKEN; game.tokens++; won++; }
    }
  }
  const tokens = won > 1 ? `. ${won} tokens earned` : won ? '. Token earned' : '';
  // In capitals, as found words are, whether new or counted already.
  const news = got.length === 1 ? [`Detour: ${got[0][0].toUpperCase()}, +${got[0][1]} fare${tokens}`, 'note']
    : got.length ? [`${got.length} detours, +${got.reduce((n, [, f]) => n + f, 0)} fare${tokens}`, 'note']
    : again ? [`${again} already counted`, 'note nope']
    : ['Not a word on this map', 'note nope'];
  return { news, counted: got.length > 0 };
}

// Is this word one of the puzzle's detours? The open puzzle's list is read into a set the first time it's asked.
let detourCache = { id: null, set: null };
function isDetour(extra, id, word) {
  if (detourCache.id !== id && extra.words[id] !== undefined) detourCache = { id, set: new Set(extra.words[id].split(' ')) };
  return detourCache.id === id && detourCache.set.has(word);
}

function found(k) {
  const { p, game } = cur;
  if (!game.found.length) game.night = saved.options.night;
  if (k === 0) game.crossAt = game.found.length;
  game.found.push(k);
  if (game.hint?.line === k) game.hint = null;
  drawLine(k, true);
  // A found word would otherwise sound just like the word as it was traced, so it's heard as found, with the count.
  const n = p.lines.length, all = game.found.length === n;
  say(k === 0 ? p.name : cur.words[k], k === 0 ? 'crossed' : '', k,
    all ? `, found. All ${n} lines found` : k === 0 ? ', found' : `, found. ${game.found.length} of ${n} lines`);
  // The Crosstown is the map's big find: its name in the readout's full size, then "Crosstown" small after it. A
  // screen reader hears "Crosstown: Junk drawer, found", the label first.
  if (k === 0) {
    const out = $('readout'), sep = document.createElement('span'), label = document.createElement('span'), colon = document.createElement('span');
    sep.className = 'sep'; sep.setAttribute('aria-hidden', 'true');
    colon.className = 'sr-only'; colon.textContent = ': ';
    label.className = 'send'; label.append('Crosstown', colon);
    out.insertBefore(label, out.firstChild.nextSibling); out.insertBefore(sep, label);
  }
  // The last line: its word stays while the line draws, then the map says its name, as it does when it's opened again
  // finished. The done sheet rises after that, and only then do Results and Next puzzle take the fare's place.
  if (all) {
    stopClock();
    game.done = true; game.hint = null;
    if (!saved.best[p.id] || game.ms < saved.best[p.id]) saved.best[p.id] = Math.round(game.ms);
    cur.finishing = true;
    keep(); paint();
    // Whether this finish was the one that ended its line, or every line: the done sheet marks that moment, and only
    // that one (Results on any map of a finished line opened later reads as any finished map does).
    const ended = l => tally(l).finished === l.puzzles.length;
    cur.justEnded = !ended(cur.line) ? null : LINES.every(ended) ? 'all' : 'line';
    askToKeep();
    const word = $('readout').textContent;
    setTimeout(() => { if (cur?.p === p && $('readout').textContent === word) sayName(); }, 550);
    setTimeout(() => { if (cur?.p === p) { cur.finishing = false; showDone(); paint(); } }, 900);
    return;
  }
  keep(); paint();
}

// Once a puzzle is finished there's progress worth keeping, so once a visit the browser is asked to keep it rather
// than clear it to make room or after a spell away. Safari deletes a site's storage "after seven days of Safari use
// without user interaction on the site" (webkit.org/blog/10218, March 2020), and grants persist() "based on
// heuristics like whether the website is opened as a Home Screen Web App" (webkit.org/blog/14403, August 2023).
// Chromium and Safari decide without asking; Firefox would ask with a prompt, so there it's asked only in the
// installed app.
let askedToKeep = false;
function askToKeep() {
  if (askedToKeep || single || !keeping() || !navigator.storage?.persist || !navigator.storage.persisted) return;
  askedToKeep = true;
  if (/\bGecko\/\d/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches) return;
  navigator.storage.persisted().then(yes => yes || navigator.storage.persist()).catch(() => {});
}

// The line a new token would ring: any ordinary line first, the Crosstown only once it's the last one left.
// None when the only line left is the one whose route is already drawn.
function nextHint(game, p) {
  const open = p.lines.map((_, k) => k).filter(k => !game.found.includes(k) && k !== game.hint?.line);
  return open.find(k => k !== 0) ?? open[0];
}

const routeFirst = game => game.hint?.level === 2 && !game.found.includes(game.hint.line);
$('b-token').addEventListener('click', () => {
  const { p, game } = cur;
  if (game.done) return;
  if (!game.tokens) { say(`No tokens ${game.spent ? 'left' : 'yet'}. Detours, words that aren't lines, earn fare: ${FARE_PER_TOKEN} fare is a token`, 'note'); return; }
  if (routeFirst(game)) { say('Trace the dashed route first. No token spent', 'note'); return; }
  if (game.hint && game.hint.level === 1) { game.hint.level = 2; say('The dashed route starts at the solid ring', 'note'); }
  else {
    const pick = nextHint(game, p);
    if (pick === undefined) return;
    game.hint = { line: pick, level: 1 };
    say(`${p.lines[pick].length} ringed stops make a line`, 'note');
  }
  game.tokens--; game.spent++;
  sel = [];
  keep(); paint();
});

// ---- sheets -----------------------------------------------------------------------------------------------------
const anySheet = () => [...document.querySelectorAll('.sheet')].some(s => !s.hidden);
let opener = null;
function openSheet(id) {
  opener = document.activeElement;
  // On the list a sheet adds a step to the history, so Back closes it rather than leaving the game (see Back below).
  if (!cur && !single && !sheetStep) try { history.pushState({ sheet: 1 }, ''); sheetStep = true; } catch { /* Back leaves, as before */ }
  // The clock stops while a sheet is open, so the letters go too: no studying the map off the clock.
  if (cur) { stopClock(); board.classList.toggle('paused', !cur.game.done); }
  $('app').inert = true;   // the page behind stays out of reach of Tab and screen readers until the sheet closes
  $(id).hidden = false;
  // The main button if it's showing (Next puzzle, Done, Got it), otherwise the first one that is. Where the sheet is
  // too tall for the window (zoomed in, or a small phone), that button is out of sight at the foot, so the focus goes
  // to the sheet itself: its top shows, the arrow keys scroll it, Tab reaches the buttons, and a screen reader starts
  // at its title.
  const panel = $(id).querySelector('.panel');
  panel.scrollTop = 0;
  if (panel.scrollHeight > panel.clientHeight + 1) { panel.tabIndex = -1; panel.focus({ preventScroll: true }); }
  else {
    panel.removeAttribute('tabindex');
    ($(id).querySelector('.btn.primary:not([hidden])') || $(id).querySelector('.btn:not([hidden])'))?.focus({ preventScroll: true });
  }
}
// A list sheet's step comes off the history when the sheet closes (`step`): 'back' takes it off, for a close from the
// page; 'gone' when Back has already taken it; 'keep' when another sheet is taking this one's place.
function closeSheets(step = 'back') {
  if (sheetStep && step !== 'keep') { sheetStep = false; if (step === 'back') { backing = true; history.back(); } }
  for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
  $('app').inert = false;
  board.classList.remove('paused');
  $('share-box').hidden = true;
  armed = null; $('m-restart').textContent = 'Start this puzzle over'; $('m-erase').textContent = 'Erase progress on every line';
  if (cur) startClock();
  opener?.focus?.({ preventScroll: true });
  catchUp();
}
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheets(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && anySheet()) closeSheets(); });

function openMenu() {
  $('o-clock').checked = saved.options.clock; $('o-night').checked = saved.options.night;
  $('m-restart').hidden = !cur; $('m-erase').hidden = !!cur;
  if (cur?.game.done) $('m-restart').textContent = 'Play this puzzle again';
  openSheet('sheet-menu');
}
$('b-menu').addEventListener('click', openMenu);
$('b-list-menu').addEventListener('click', openMenu);
$('b-how').addEventListener('click', () => openSheet('sheet-how'));
$('m-how').addEventListener('click', () => { closeSheets('keep'); openSheet('sheet-how'); });
$('o-clock').addEventListener('change', e => { setOption('clock', e.target.checked); if (cur) $('clock').hidden = !e.target.checked; else drawList(); });
$('o-night').addEventListener('change', e => { setOption('night', e.target.checked); if (cur) paint(); else drawList(); });

// The page can't show a confirm box everywhere it runs, so the button asks for a second tap instead. The ask can be
// worked out at the first tap (`ask` a function).
let armed = null;
function twice(btn, ask, act) {
  btn.addEventListener('click', () => {
    if (armed !== btn) { armed = btn; btn.textContent = typeof ask === 'function' ? ask() : ask; return; }
    armed = null; act();
  });
}
// A finished map's stars go with it, so the second tap says how many.
const restartAsk = () => {
  if (!cur.game.done) return 'Tap again to clear this puzzle';
  const n = starsFor(cur.game);
  return n === 1 ? 'Tap again: its 1 star goes too' : `Tap again: its ${n} stars go too`;
};
twice($('m-restart'), restartAsk, () => {
  dropWaiting(cur.p.id);
  cur.game = fresh(); setGame(cur.p.id, null);
  const i = cur.i; closeSheets(); openPuzzle(i);
});
twice($('m-erase'), 'Tap again to erase every line', () => {
  // Every game goes, here and in any other window, rather than being merged with what's stored.
  dropWaiting(); saved.games = {}; saved.best = {}; changed.games.clear(); changed.erased = true; save();
  closeSheets(); drawList(); toast(keeping() ? 'Progress erased on every line' : 'Erased for this visit only');
});

function shareText() {
  const { p, game, i, line: l } = cur;
  const n = starsFor(game);
  const bits = [`${p.lines.length} lines`, game.spent ? `${game.spent} token${game.spent > 1 ? 's' : ''}` : 'no tokens'];
  if (saved.options.clock) bits.push(clock(game.ms));
  if (game.night) bits.push('night service');
  return `Crosstown ${LINES.length > 1 ? `${l.name} ` : ''}No. ${i + 1} ${'★'.repeat(n)}${'☆'.repeat(3 - n)}\n${bits.join(', ')}\n${SITE}`;
}

function showDone() {
  const { p, game, words } = cur;
  $('done-title').textContent = p.name;
  // Each star says whether it was earned, as the gold or grey star does on screen, and the sheet says how many in all
  // (read with the stats when the focus lands on its button).
  const rows = [['Every stop on a line', true], ['No tokens spent', game.spent === 0], ['Crosstown found first', game.crossAt === 0]];
  $('done-stars').innerHTML = rows.map(([label, got]) => `<li class="${got ? 'got' : ''}">${STAR}<span><span class="sr-only">${got ? 'Earned' : 'Missed'}: </span>${label}</span></li>`).join('');
  $('done-sum').textContent = `${rows.filter(([, got]) => got).length} of 3 stars.`;
  const d = game.detours.length, stats = [d ? `${d} detour${d === 1 ? '' : 's'}` : 'no detours'];   // as the share says "no tokens"
  if (game.spent) stats.unshift(`${game.spent} token${game.spent > 1 ? 's' : ''} spent`);
  if (saved.options.clock) stats.unshift(clock(game.ms));
  if (game.night) stats.push('night service');
  if (!keeping()) stats.push('not kept in this browser');
  const said = stats.join(', ');
  $('done-stats').textContent = said[0].toUpperCase() + said.slice(1);   // "No detours" on its own
  // The Crosstown is keyed by the map's name, spaces and all ("JUNK DRAWER"), where its letters are the line's.
  const key = $('done-key'); key.textContent = '';
  const named = p.name.toUpperCase(), xt = named.normalize('NFD').replace(/[^A-Z]/g, '') === words[0] ? named : words[0];
  words.forEach((w, k) => {
    const li = document.createElement('li'); if (k === 0) li.className = 'xt';
    const sw = document.createElement('i'); sw.className = `c${k}`;
    li.append(sw, k === 0 ? `${xt} (the Crosstown)` : w); key.append(li);
  });
  // The finish that ends a line says the line is finished, and how it went. Any finished map offers the next line
  // with any left once its own line is finished.
  const { n, to } = after(), ended = cur.justEnded;
  $('done-eyebrow').textContent = ended === 'all' ? 'Every line finished' : ended ? `${cur.line.name} finished` : 'Last stop';
  // The line's tally, on a strip in its colour over a route to a terminus, as a finished line's route ends on the
  // list. The finish that ends every line adds the whole network's. Emptied when it's not shown, as the sheet's
  // description still reads it.
  const strips = $('done-line'); strips.textContent = '';
  if (ended) {
    const t = tally(cur.line);
    strips.append(terminus(cur.line.name, tint(cur.line)[0], t.finished, t.stars));
    if (ended === 'all') {
      let all = 0, got = 0;
      for (const l of LINES) { const n = tally(l); all += n.finished; got += n.stars; }
      strips.append(terminus('Every line', 'var(--cross)', all, got));
    }
  }
  strips.hidden = !ended;
  $('b-done-next').hidden = n < 0 && !to;
  $('b-done-next').textContent = to ? `On to the ${to.name}` : 'Next puzzle';
  openSheet('sheet-done');
}
$('b-results').addEventListener('click', showDone);
// "Market Line" and "81 of 81 · 243★" over a route to a terminus bar (every one of them finished, so the count is the
// total too). A screen reader hears it in words: "Market Line: 81 of 81, 243 of 243 stars".
function terminus(name, color, n, stars) {
  const part = (tag, cls, text = '') => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
  const [count, most, got] = [n, n * 3, stars].map(v => v.toLocaleString());
  const strip = part('p', 'term'); strip.style.setProperty('--c', color);
  const shown = part('span', 'term-show'); shown.setAttribute('aria-hidden', 'true');
  const tail = part('span', 'term-n', `${count} of ${count}`);
  tail.append(part('span', 'sep'), part('span', 'st', `${got}★`));
  shown.append(part('strong', 'term-name', name), tail, part('span', 'rt'));
  strip.append(part('span', 'sr-only', `${name}: ${count} of ${count}, ${got} of ${most} stars`), shown);
  return strip;
}
// After a finished puzzle: the next one on its line (n), or with the line finished, the next line with one left (to).
function after() { const n = nextUp(cur.i); return { n, to: n < 0 ? nextLine() : null }; }
// Next puzzle, or on to the next line's next puzzle. Either way the puzzle's step in the history is changed, not added
// to, so Back means the list, and after a new line it's that line's list.
function goNext() {
  const { n, to } = after();
  closeSheets();
  if (n < 0 && !to) return;
  stopClock(); keep();
  if (to) showLine(to);
  openPuzzle(n >= 0 ? n : nextUp());
  changeStep();
  // The map may have had the focus already, so moving it there says nothing new: the new puzzle is said instead.
  const dark = saved.options.night && !cur.game.found.length && !cur.game.done;
  $('spoken').textContent = `${shortName(line)}, No. ${cur.i + 1}. ${dark ? 'Night service' : cur.p.clue}`;
}
$('b-next').addEventListener('click', goNext);
$('b-done-next').addEventListener('click', goNext);

$('b-share').addEventListener('click', async () => {
  const text = shareText();
  if (!single && navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Result copied'); }
  catch {
    // The box says what to do in a label of its own: a toast would sit on top of the text it's about.
    const box = $('share-text'); box.value = text; $('share-box').hidden = false; box.focus(); box.select();
  }
});

// The toast is a live region that's always there, shown with a class, so screen readers hear a message that arrives
// with it (one that appears and fills at the same moment is often missed).
let toastTimer = 0;
function toast(text, ms = 2200) {
  const t = $('toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('on'); t.textContent = ''; }, ms);
}

// ---- Back -------------------------------------------------------------------------------------------------------
// Back (the browser's, or the back gesture in the installed app) goes from a puzzle to the list. Opening a puzzle
// from the list adds a step to the history, and Next puzzle changes that step instead of adding one, so Back always
// means the list. With a sheet open, Back closes the sheet first; Forward opens the puzzle again. A sheet opened on
// the list adds a step of its own ({ sheet: 1 }), so Back closes it there too, and closing it any other way takes the
// step off again. The one-file copy leaves the history alone, since it belongs to the page around it.
const STEP = 'crosstown';   // the key in the history's state that names the puzzle open at that step
let backing = false;        // the page asked the history for a Back that hasn't come through yet
let sheetStep = false;      // a sheet open on the list has its step in the history

function fromList(i) { openPuzzle(i); addStep(); }
function addStep() {
  if (single || backing) return;   // a Back on its way adds the step when it comes through
  try { history.pushState({ [STEP]: cur.p.id }, ''); } catch { /* no history to add to: the back arrow still works */ }
}
function changeStep() {
  if (!single && history.state?.[STEP]) try { history.replaceState({ [STEP]: cur.p.id }, ''); } catch { /* same */ }
}
// The back arrow shows the list straight away, then takes the puzzle's step off the history.
function back() {
  leave();
  if (!single && history.state?.[STEP]) { backing = true; history.back(); }
}
window.addEventListener('popstate', e => {
  if (single) return;
  const id = e.state?.[STEP];
  if (backing) { backing = false; if (cur) addStep(); return; }
  if (sheetStep) { closeSheets('gone'); return; }   // Back with a sheet open on the list
  if (cur && !id) {
    if (anySheet()) { closeSheets(); addStep(); } else leave();
  } else if (!cur && id) {
    const p = PUZZLES.find(q => q.id === id);
    if (p) { if (anySheet()) closeSheets('gone'); if (p.line !== line.id) { pickLine(lineOf(p.line)); drawList(); } openPuzzle(list.indexOf(p)); }
  } else if (!cur && e.state?.sheet) { backing = true; history.back(); }   // Forward to a sheet that's been closed
});

// ---- start ------------------------------------------------------------------------------------------------------
$('b-back').addEventListener('click', back);
$('b-continue').addEventListener('click', () => {
  const n = nextUp();
  if (n >= 0) { fromList(n); return; }
  const l = nextLine();
  if (l) { showLine(l); $('b-continue').focus({ preventScroll: true }); }
});
$('b-line').addEventListener('click', openLines);
$('meter').addEventListener('click', () => { if (cur && !cur.game.done) say(`${cur.game.fare} of ${FARE_PER_TOKEN} fare to the next token`, 'note'); });
window.addEventListener('pagehide', () => { if (cur) { stopClock(); keep(); } });
// Another window saved: take in what it saved. The list (and the lines sheet, if it's open) shows it straight away; a
// puzzle on screen carries on as it is, unless the other window has a better game of it (see catchUp()). The line on
// show stays.
window.addEventListener('storage', e => {
  if (e.key !== KEY && e.key !== null) return;
  try { adopt(mergeInto(load())); } catch { return; }
  if (cur) { catchUp(); return; }
  drawList();
  if (!$('sheet-lines').hidden) drawLines();
});
setLine(line);
drawList();
// A reload on a puzzle's step (or a sheet's) opens on the list, so that step goes too, and Back from the list leaves
// the game. The puzzle that was open is in sight, as after the back arrow, with the focus on it where there's a mouse.
// (On a touch screen nothing has been pressed yet, so the browser would ring the row as if a key had been.)
if (!single && (history.state?.[STEP] || history.state?.sheet)) {
  toRow(list.findIndex(q => q.id === history.state[STEP]), matchMedia('(hover: hover)').matches);
  backing = true; history.back();
}

// The offline copy. If making it was cut short (the signal went), it's tried again when the signal comes back or the
// game comes back on screen, rather than at the next page load. update() fetches sw.js afresh, and sets up a new
// release if it's changed or the last one didn't finish.
if (!single && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const sw = navigator.serviceWorker;
  sw.register('sw.js').catch(() => {});
  const again = () => sw.getRegistration().then(r => (r ? r.update() : sw.register('sw.js'))).catch(() => {});
  window.addEventListener('online', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
}

// Running: the note at the end of index.html, which offers to load the page again if the game doesn't start, stays away.
window.crosstownStarted = true;
