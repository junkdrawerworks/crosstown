// Lays out the puzzles in tools/themes/ and writes js/puzzles.js and js/detours/:
//
//   node tools/make-puzzles.mjs                every puzzle on every line
//   node tools/make-puzzles.mjs market         just the puzzles on that line (the rest keep their boards)
//   node tools/make-puzzles.mjs tide-pool ...  just those puzzles, and print their boards
//
// For each theme it picks a set of words that fills the 48 stops exactly, packs them into the grid as lines that
// never share a stop or cut across each other, and keeps the tidiest layout it finds. It then lists every other
// dictionary word that can be traced on that board (the "detours" that earn fare). The same seed gives the same
// boards, so running it again changes nothing unless a theme changed. The work is shared across the CPUs.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { W, H, N, row, col, NEIGHBORS, diagonalSquare, spell, traces } from '../js/board.js';
import { LINES } from './themes.mjs';
import { isRude } from './rude-words.mjs';
import { nearAnswer } from './near-answers.mjs';

const require = createRequire(import.meta.url);
const MIN = 4;                    // shortest word that counts, theme or detour
const LAYOUTS = 1500;             // layouts to compare per word set
const SETS = 6;                   // word sets to try per theme

// ---- the dictionary -------------------------------------------------------------------------------------------
// SCOWL (via wordlist-english), every dialect, minus the words nobody wants to be told they found (tools/rude-words.mjs).
const lists = require('wordlist-english');
const DICT = new Set();
for (const key of ['english', 'english/american', 'english/british', 'english/canadian', 'english/australian']) {
  for (const w of lists[key]) if (/^[a-z]{4,14}$/.test(w) && !isRude(w)) DICT.add(w.toUpperCase());
}
const trie = { kids: new Map(), end: false };
for (const w of DICT) {
  let node = trie;
  for (const ch of w) { if (!node.kids.has(ch)) node.kids.set(ch, { kids: new Map(), end: false }); node = node.kids.get(ch); }
  node.end = true;
}

// ---- helpers ------------------------------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// A word as people write it ("PRIMA DONNA", "VELOUTÉ") comes down to its letters on the map ("PRIMADONNA", "VELOUTE").
const lettersOf = written => written.normalize('NFD').replace(/[^A-Z]/g, '');
const hash = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const shuffle = (a, rnd) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// The word sets that fill the grid, best first: six to eight words, favouring the ones listed earliest.
function wordSets(theme) {
  const all = theme.words.split(' ');
  const need = N - theme.cross.length;
  const out = [];
  const pick = (i, left, chosen, cost) => {
    if (left === 0) { if (chosen.length >= 6 && chosen.length <= 8) out.push({ words: chosen.slice(), cost: cost + 4 * Math.abs(chosen.length - 7) }); return; }
    if (i === all.length || left < MIN || chosen.length === 8) return;
    chosen.push(all[i]); pick(i + 1, left - all[i].length, chosen, cost + i); chosen.pop();
    pick(i + 1, left, chosen, cost);
  };
  pick(0, need, [], 0);
  return out.sort((a, b) => a.cost - b.cost).slice(0, SETS * 4);
}

// ---- packing ------------------------------------------------------------------------------------------------
// Fills the grid with one line per length in `lengths` (the Crosstown's first). Returns the lines, or null.
function pack(lengths, rnd) {
  const taken = new Uint8Array(N);
  const cut = new Uint8Array(N);            // little squares a diagonal already crosses
  const lines = [];
  let budget = 4000;

  const freeAround = i => { let n = 0; for (const j of NEIGHBORS[i]) if (!taken[j]) n++; return n; };
  const canStep = (a, b) => { if (taken[b]) return false; const d = diagonalSquare(a, b); return d < 0 || !cut[d]; };
  const lay = path => { for (let k = 0; k < path.length; k++) { taken[path[k]] = 1; if (k) { const d = diagonalSquare(path[k - 1], path[k]); if (d >= 0) cut[d] = 1; } } };
  const lift = path => { for (let k = 0; k < path.length; k++) { taken[path[k]] = 0; if (k) { const d = diagonalSquare(path[k - 1], path[k]); if (d >= 0) cut[d] = 0; } } };

  // Each pocket of empty stops must be a size some of the remaining lines could add up to.
  const fits = rest => {
    const sums = new Uint8Array(N + 1); sums[0] = 1;
    for (const len of rest) for (let s = N; s >= len; s--) if (sums[s - len]) sums[s] = 1;
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (taken[i] || seen[i]) continue;
      let size = 0; const stack = [i]; seen[i] = 1;
      while (stack.length) { const a = stack.pop(); size++; for (const b of NEIGHBORS[a]) if (!taken[b] && !seen[b]) { seen[b] = 1; stack.push(b); } }
      if (!sums[size]) return false;
    }
    return true;
  };

  // The Crosstown: from one edge to the opposite one.
  const across = lengths[0] < H ? true : rnd() < 0.5;
  const along = across ? col : row, far = across ? W - 1 : H - 1;
  const starts = shuffle(Array.from({ length: N }, (_, i) => i).filter(i => along(i) === 0), rnd);
  const cross = [];
  const walkCross = i => {
    if (--budget < 0) return false;
    cross.push(i); taken[i] = 1;
    const left = lengths[0] - cross.length;
    if (left === 0) { if (along(i) === far) return true; }
    else if (far - along(i) <= left) {
      for (const j of shuffle(NEIGHBORS[i].slice(), rnd)) {
        if (!canStep(i, j)) continue;
        if (left > 1 && along(j) === far && rnd() < 0.7) continue;  // don't hug the far edge early
        const d = diagonalSquare(i, j); if (d >= 0) cut[d] = 1;
        if (walkCross(j)) return true;
        if (d >= 0) cut[d] = 0;
      }
    }
    cross.pop(); taken[i] = 0;
    return false;
  };
  let placed = false;
  for (const s of starts) { if (walkCross(s)) { placed = true; break; } if (budget < 0) return null; }
  if (!placed || !fits(lengths.slice(1))) return null;
  lines.push(cross.slice());

  // Then the rest, always starting from the most hemmed-in empty stop.
  const fill = rest => {
    if (!rest.length) return true;
    let best = -1, least = 99;
    for (let i = 0; i < N; i++) if (!taken[i]) { const f = freeAround(i) + rnd() * 0.5; if (f < least) { least = f; best = i; } }
    for (const len of shuffle([...new Set(rest)], rnd)) {
      const after = rest.slice(); after.splice(after.indexOf(len), 1);
      let tries = 0;
      const path = [];
      const grow = i => {
        if (--budget < 0 || tries > 10) return false;
        path.push(i); taken[i] = 1;
        if (path.length === len) {
          tries++;
          if (fits(after)) { lines.push(path.slice()); if (fill(after)) return true; lines.pop(); }
        } else {
          const before = path.length > 1 ? path[path.length - 2] : -1;
          const straight = j => before >= 0 && j - i === i - before && col(j) - col(i) === col(i) - col(before);
          const next = NEIGHBORS[i].filter(j => canStep(i, j)).map(j => [freeAround(j) + rnd() * 3 + (straight(j) ? 1.5 : 0), j]).sort((a, b) => a[0] - b[0]);
          for (const [, j] of next) {
            const d = diagonalSquare(i, j); if (d >= 0) cut[d] = 1;
            if (grow(j)) return true;
            if (d >= 0) cut[d] = 0;
          }
        }
        path.pop(); taken[i] = 0;
        return false;
      };
      if (grow(best)) return true;
      if (budget < 0) return false;
    }
    return false;
  };
  return fill(lengths.slice(1)) ? lines : null;
}

// ---- judging a layout ---------------------------------------------------------------------------------------
function turns(path) {
  let n = 0, run = 1, longest = 1;
  for (let k = 2; k < path.length; k++) {
    const same = path[k] - path[k - 1] === path[k - 1] - path[k - 2] && col(path[k]) - col(path[k - 1]) === col(path[k - 1]) - col(path[k - 2]);
    if (same) { run++; longest = Math.max(longest, run + 1); } else { n++; run = 1; }
  }
  return { n, longest: Math.max(longest, 2) };
}

// Does the line start on one edge of the map and end on the opposite one? The Crosstown always does.
function acrossTown(line) {
  const a = line[0], b = line.at(-1);
  return (col(a) === 0 && col(b) === W - 1) || (col(a) === W - 1 && col(b) === 0) || (row(a) === 0 && row(b) === H - 1) || (row(a) === H - 1 && row(b) === 0);
}

// Lower is better. A word that can also be spelled through some other line's stops is the thing to avoid, and so
// is a theme word left out of the set that can still be traced: whoever finds it would be told it's only a detour.
// So is another line running edge to edge, which could be taken for the Crosstown.
function judge(grid, words, lines, unused) {
  let stray = 0, dull = 0;
  for (const word of unused) if (traces(grid, word, 1).length) stray++;
  lines.forEach((line, k) => { if (k && acrossTown(line)) stray++; });
  words.forEach((word, k) => {
    const own = new Set(lines[k]);
    for (const t of traces(grid, word, 12)) if (t.some(i => !own.has(i))) stray++;
    const { n, longest } = turns(lines[k]);
    if (n === 0) dull += 3;
    dull += Math.max(0, longest - 4);
  });
  return stray * 100 + dull;
}

// ---- detours --------------------------------------------------------------------------------------------------
// Every dictionary word that can be traced anywhere on the board, through any stops, apart from the answers and the
// answers with an ending added or taken off (tools/near-answers.mjs).
function detours(grid, answers) {
  const found = new Set();
  const used = new Uint8Array(N);
  const walk = (i, node, sofar) => {
    const next = node.kids.get(grid[i]);
    if (!next) return;
    used[i] = 1; sofar += grid[i];
    if (next.end) found.add(sofar);
    for (const j of NEIGHBORS[i]) if (!used[j]) walk(j, next, sofar);
    used[i] = 0;
  };
  for (let i = 0; i < N; i++) walk(i, trie, '');
  return [...found].filter(w => !answers.includes(w) && !nearAnswer(w, answers)).sort();
}

// ---- make them ------------------------------------------------------------------------------------------------
function make(theme) {
  const sets = wordSets(theme);
  if (!sets.length) throw new Error(`${theme.id}: no set of 6 to 8 words fills ${N - theme.cross.length} stops`);
  let best = null;
  sets.forEach((set, rank) => {
    if (best && best.score <= rank * 2) return;
    if (rank >= SETS && best && best.score < 100) return;   // past the first few sets only to clear up a stray word
    const words = [theme.cross, ...set.words];
    const unused = theme.words.split(' ').filter(w => !words.includes(w));
    const lengths = words.map(w => w.length);
    let made = 0;
    for (let attempt = 0; made < LAYOUTS && attempt < LAYOUTS * 40; attempt++) {
      const rnd = rng(hash(`${theme.id}/${rank}/${attempt}`));
      const lines = pack(lengths, rnd);
      if (!lines) continue;
      made++;
      // Give each line a word of its length, read from either end. A few goes each, since a different pairing
      // can clear up a word that could otherwise be spelled through its neighbours.
      for (let go = 0; go < 4; go++) {
        const byLength = new Map();
        lines.forEach((line, k) => { if (k) { if (!byLength.has(line.length)) byLength.set(line.length, []); byLength.get(line.length).push(line); } });
        for (const group of byLength.values()) shuffle(group, rnd);
        const laid = words.map((w, k) => {
          const line = k === 0 ? lines[0] : byLength.get(w.length).pop();
          return k === 0 ? (rnd() < 0.25 ? line.slice().reverse() : line) : (rnd() < 0.5 ? line.slice().reverse() : line);
        });
        const grid = Array(N);
        laid.forEach((line, k) => line.forEach((cell, n) => { grid[cell] = words[k][n]; }));
        const score = judge(grid, words, laid, unused) + rank * 2;
        if (!best || score < best.score) best = { score, grid: grid.join(''), lines: laid, words };
      }
      if (best.score <= rank * 2) break;
    }
  });
  if (!best) throw new Error(`${theme.id}: couldn't lay it out`);
  const extra = detours(best.grid, best.words);
  const name = theme.name ?? theme.id[0].toUpperCase() + theme.id.slice(1).replaceAll('-', ' ');
  let log = `${theme.id.padEnd(22)} score ${String(best.score).padStart(3)}  ${best.words.length - 1} lines + ${theme.cross}  ${extra.length} detours  ${best.words.slice(1).join(' ')}`;
  if (best.score >= 100) log += '  <- a word can be traced another way';
  return { puzzle: { id: theme.id, name, clue: theme.clue, grid: best.grid, lines: best.lines, detours: extra.join(' ').toLowerCase() }, log };
}

// A worker lays out the themes it's sent, one at a time.
if (!isMainThread) {
  parentPort.on('message', theme => {
    try { parentPort.postMessage(make(theme)); } catch (err) { parentPort.postMessage({ error: err.message }); }
  });
} else {
  await main();
}

async function main() {
  const args = process.argv.slice(2);
  const lineIds = new Set(LINES.map(l => l.id));
  const all = LINES.flatMap(l => l.themes);
  const ids = new Set(all.map(t => t.id));
  for (const a of args) if (!lineIds.has(a) && !ids.has(a)) throw new Error(`${a} is neither a line nor a puzzle`);
  if (ids.size !== all.length) throw new Error('two puzzles share an id: ids must be unique across every line');
  // Each theme's written forms, by the letters they stand for. They only change how a word reads, never the board.
  const writtenOf = new Map(all.map(t => {
    const words = [t.cross, ...t.words.split(' ')], forms = {};
    for (const w of t.written ?? []) {
      const key = lettersOf(w);
      if (!words.includes(key)) throw new Error(`${t.id}: written form ${w} isn't the letters of one of its words`);
      if (key === w) throw new Error(`${t.id}: written form ${w} is just its letters: leave it out`);
      if (forms[key]) throw new Error(`${t.id}: ${key} is written two ways`);
      forms[key] = w;
    }
    return [t.id, forms];
  }));
  // A line's id can also be a puzzle's (the Ballpark Line and the Main Line's ballpark): the line wins.
  const show = new Set(args.filter(a => ids.has(a) && !lineIds.has(a)));
  const wanted = t => !args.length || show.has(t.id) || args.some(a => LINES.find(l => l.id === a)?.themes.includes(t));

  // The puzzles that aren't being laid out again keep their boards. Their detours are listed again, which is quick, so
  // a change to the dictionary or to which words count reaches every board.
  const kept = new Map();
  if (args.length && existsSync(new URL('../js/puzzles.js', import.meta.url))) {
    const { PUZZLES } = await import('../js/puzzles.js');
    for (const p of PUZZLES) {
      const extra = detours(p.grid, p.lines.map(l => spell(p.grid, l)));
      kept.set(p.id, { id: p.id, name: p.name, clue: p.clue, grid: p.grid, lines: p.lines, detours: extra.join(' ').toLowerCase() });
    }
  }
  const todo = all.filter(t => wanted(t) || !kept.has(t.id));

  // Share the work across the CPUs, keeping the printed order.
  const made = new Map();
  const queue = todo.slice();
  const workers = Math.max(1, Math.min(todo.length, cpus().length));
  let printed = 0;
  await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url));
    const next = () => { const t = queue.shift(); if (t) w.postMessage(t); else { w.terminate(); resolve(); } };
    let current = null;
    w.on('message', res => {
      if (res.error) { w.terminate(); reject(new Error(res.error)); return; }
      made.set(res.puzzle.id, res);
      while (printed < todo.length && made.has(todo[printed].id)) console.log(made.get(todo[printed++].id).log);
      next();
    });
    w.on('error', reject);
    next();
  })));

  for (const id of show) {
    const p = made.get(id).puzzle;
    for (let r = 0; r < H; r++) console.log('   ' + p.grid.slice(r * W, r * W + W).split('').join(' '));
    p.lines.forEach(l => console.log(`   ${spell(p.grid, l)}: ${l.join(',')}`));
  }

  const puzzleOf = t => made.get(t.id)?.puzzle ?? kept.get(t.id);
  // Each line's detours, and a fingerprint of them that both files carry (`fp` in puzzles.js, FOR in the line's
  // detours file), so a page left open across a release can tell that the detours it was just sent are for other boards.
  const byLine = new Map(LINES.map(line => [line.id, Object.fromEntries(line.themes.map(t => [t.id, puzzleOf(t).detours]))]));
  const fp = new Map([...byLine].map(([id, d]) => [id, createHash('sha1').update(JSON.stringify(d)).digest('hex').slice(0, 8)]));
  const header = '// Written by tools/make-puzzles.mjs from tools/themes/. Don\'t edit by hand: change the theme and run the tool.\n';
  const lines = LINES.map(line => {
    const puzzles = line.themes.map(t => {
      const p = puzzleOf(t);
      // The written forms of the words on this board, if any differ from their letters.
      const forms = Object.fromEntries(p.lines.map(l => spell(p.grid, l)).filter(w => writtenOf.get(t.id)[w]).map(w => [w, writtenOf.get(t.id)[w]]));
      const written = Object.keys(forms).length ? `,\n      written: ${JSON.stringify(forms)}` : '';
      return `    { id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, clue: ${JSON.stringify(p.clue)},\n      grid: '${p.grid}', lines: ${JSON.stringify(p.lines)}${written} },`;
    });
    return `  { id: ${JSON.stringify(line.id)}, name: ${JSON.stringify(line.name)}, about: ${JSON.stringify(line.about)}, color: ${JSON.stringify(line.color)}, fp: '${fp.get(line.id)}', puzzles: [\n${puzzles.join('\n')}\n  ] },`;
  });
  await writeFile(new URL('../js/puzzles.js', import.meta.url),
`${header}// The lines, in the order the list shows them. Each puzzle has its grid (the 48 letters, across then down), its
// lines (the stops of each theme word in order, the Crosstown first) and, where a word on it isn't written as just its
// letters, \`written\` (its letters, then the word as people write it). A line's fp is a fingerprint of its detours.
export const LINES = [
${lines.join('\n')}
];

// Every other word that can be traced on each board (a detour, which earns fare), one file per line, loaded when a
// puzzle on that line opens: they're most of the weight.
export const DETOURS = {
${LINES.map(l => `  ${JSON.stringify(l.id)}: () => import('./detours/${l.id}.js'),`).join('\n')}
};

// Every puzzle on every line, each knowing its line.
export const PUZZLES = LINES.flatMap(line => line.puzzles.map(p => Object.assign(p, { line: line.id })));
`);
  await mkdir(new URL('../js/detours/', import.meta.url), { recursive: true });
  for (const line of LINES) {
    const body = Object.entries(byLine.get(line.id)).map(([id, d]) => `  ${JSON.stringify(id)}: '${d}',`).join('\n');
    await writeFile(new URL(`../js/detours/${line.id}.js`, import.meta.url),
`${header}// Every word of four letters or more, other than the answers, that can be traced on each board of the ${line.name}.
// FOR is the line's fp in the puzzles.js these were made with (a fingerprint of them): another means another release.
export const FOR = '${fp.get(line.id)}';
export const DETOURS = {
${body}
};
`);
  }
  // The offline copy keeps every line's detours: sw.js lists them on the line after its "each line's detours" note.
  const swFile = new URL('../sw.js', import.meta.url);
  const sw = await readFile(swFile, 'utf8');
  const listed = `  ${LINES.map(l => `'js/detours/${l.id}.js',`).join(' ')}\n`;
  const after = sw.replace(/(\/\/ each line's detours[^\n]*\n)[^\n]*\n/, (_, note) => note + listed);
  if (after === sw && !sw.includes(listed)) throw new Error("sw.js has no \"each line's detours\" note to list them after");
  if (after !== sw) { await writeFile(swFile, after); console.log('sw.js now keeps every line\'s detours: npm test will say what FILES in it should be'); }
  console.log(`\n${todo.length} laid out, ${all.length} puzzles on ${LINES.length} line${LINES.length > 1 ? 's' : ''} written to js/puzzles.js and js/detours/`);
}
