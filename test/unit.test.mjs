// Checks every puzzle the slow, independent way:  node --test test/unit.test.mjs
// Nothing here trusts the tool that made js/puzzles.js. It re-derives each claim from the grid and the lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { W, H, N, row, col, adjacent, diagonalSquare, spell, spans, traces } from '../js/board.js';
import { LINES, DETOURS as LOAD } from '../js/puzzles.js';
import { LINES as THEME_LINES, THEMES } from '../tools/themes.mjs';
import { isRude } from '../tools/rude-words.mjs';
import { nearAnswer } from '../tools/near-answers.mjs';
import { fareFor, FARE_PER_TOKEN, starsFor } from '../js/rules.js';

// Does the line start on one edge of the map and end on the opposite one?
const acrossTown = line => {
  const a = line[0], b = line.at(-1);
  return (col(a) === 0 && col(b) === W - 1) || (col(a) === W - 1 && col(b) === 0) || (row(a) === 0 && row(b) === H - 1) || (row(a) === H - 1 && row(b) === 0);
};

// Each line's detours, from its own file, put back on its puzzles.
const PUZZLES = [];
for (const line of LINES) {
  const { DETOURS } = await LOAD[line.id]();
  for (const p of line.puzzles) PUZZLES.push({ ...p, line: line.id, detours: DETOURS[p.id] });
}

test('the lines match the themes, in order, with no repeats', async () => {
  assert.deepEqual(LINES.map(l => [l.id, l.name, l.about, l.color]), THEME_LINES.map(l => [l.id, l.name, l.about, l.color]));
  LINES.forEach((line, n) => {
    assert.deepEqual(line.puzzles.map(p => p.id), THEME_LINES[n].themes.map(t => t.id), `${line.name} is out of step with its themes`);
    assert.ok(line.puzzles.length >= 30, `${line.name} is short`);
    assert.match(line.color, /^(cross|l[1-8])$/);
  });
  assert.equal(new Set(PUZZLES.map(p => p.id)).size, PUZZLES.length, 'ids are what progress is saved under, so each is used once across every line');
  assert.equal(new Set(THEMES.map(t => t.cross)).size, THEMES.length, 'two puzzles share a Crosstown');
  assert.equal(new Set(LINES.map(l => l.id)).size, LINES.length);
  // Every line's detours file has exactly its own puzzles.
  for (const line of LINES) {
    const { DETOURS } = await LOAD[line.id]();
    assert.deepEqual(Object.keys(DETOURS), line.puzzles.map(p => p.id));
  }
});

// A page left open across a release can be sent the next release's detours (they load when a line is shown), so each
// detours file says which line it was made with (FOR, a fingerprint of its words), and puzzles.js says the same (fp).
test('every line\'s detours file carries the fingerprint puzzles.js has for it', async () => {
  for (const line of LINES) {
    const { FOR, DETOURS } = await LOAD[line.id]();
    assert.match(line.fp, /^[0-9a-f]{8}$/, `${line.name} has no fingerprint: run tools/make-puzzles.mjs`);
    assert.equal(FOR, line.fp, `${line.name}'s detours are from another run of tools/make-puzzles.mjs than puzzles.js`);
    assert.equal(FOR, createHash('sha1').update(JSON.stringify(DETOURS)).digest('hex').slice(0, 8), `${line.name}'s fingerprint isn't of its detours`);
  }
  assert.equal(new Set(LINES.map(l => l.fp)).size, LINES.length);
});

test('the Main Line keeps the first 108 puzzles, in order, so saved progress and puzzle numbers stay put', () => {
  const main = LINES[0];
  assert.equal(main.id, 'main');
  assert.equal(main.puzzles.length, 108);
  assert.equal(main.puzzles[0].id, 'junk-drawer');
  assert.equal(main.puzzles[107].id, 'fairgrounds');
});

// A saved game is dropped when its board's letters change (js/app.js, gameFor), so a Main Line board laid out again
// would quietly wipe Mark's progress on it. test/main-line.json is every Main Line board as published.
test('the Main Line boards are the ones Mark played', async () => {
  const published = JSON.parse(await readFile(new URL('./main-line.json', import.meta.url), 'utf8'));
  const now = LINES[0].puzzles.map(p => [p.id, p.grid]);
  const ids = new Set(now.map(([id]) => id));
  assert.deepEqual(published.map(([id]) => id).filter(id => !ids.has(id)), [], 'a Main Line puzzle is gone: its saved progress would be lost');
  assert.deepEqual(now, published, 're-laying a Main Line board resets saved progress on it: put it to Mark before changing test/main-line.json');
});

// Counts written out by hand in the page and the README, checked against the lines, so adding a puzzle or a line
// can't leave them behind. The list's card for the line on show is in index.html as it first paints, before app.js
// fills it in, so that has to match the first line too.
test('the page and the README give the right counts, and the list first paints the first line', async () => {
  const total = LINES.reduce((n, l) => n + l.puzzles.length, 0);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const description = html.match(/<meta name="description" content="([^"]*)"/)[1];
  for (const [file, text] of [['the meta description in index.html', description], ['index.html', html], ['README.md', readme]]) {
    if (file !== 'index.html') assert.ok(text.includes(`${total} puzzles`), `${file} should say "${total} puzzles"`);
    const others = [...text.matchAll(/\b(\d+) puzzles\b/g)].map(m => m[0]).filter(m => m !== `${total} puzzles`);
    assert.deepEqual(others, [], `${file} gives another count: change it to "${total} puzzles"`);
  }
  const say = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'][LINES.length];
  assert.equal(html.match(/<strong>(\w+) lines?\.<\/strong>/)?.[1], say, `How to play in index.html should say "${say} lines."`);
  assert.equal(readme.match(/\*\*(\w+) lines?\.\*\*/)?.[1], say, `How it plays in README.md should say "${say} lines."`);
  assert.equal(html.match(/id="line-name">([^<]*)</)?.[1], LINES[0].name, `#line-name in index.html should read "${LINES[0].name}"`);
  assert.equal(html.match(/id="line-about">([^<]*)</)?.[1], LINES[0].about, `#line-about in index.html should read "${LINES[0].about}"`);
});

// A clue or name changed in a theme only reaches the game when the tool runs, so check that it did.
test('the words How to play and the README give as examples are lines on the Main Line', async () => {
  const main = new Set(LINES[0].puzzles.flatMap(p => p.lines.map(l => spell(p.grid, l))));
  for (const file of ['../index.html', '../README.md']) {
    const examples = [...(await readFile(new URL(file, import.meta.url), 'utf8')).matchAll(/\blike ([A-Z]{4,})\b/g)].map(m => m[1]);
    assert.ok(examples.length >= 2, `${file} gives fewer examples than expected`);
    for (const w of examples) assert.ok(main.has(w), `${file} gives ${w} as an example, but it isn't a line on the Main Line`);
  }
});

test('each puzzle has its theme’s name and clue', () => {
  for (const p of PUZZLES) {
    const theme = THEMES.find(t => t.id === p.id);
    assert.equal(p.name, theme.name ?? theme.id[0].toUpperCase() + theme.id.slice(1).replaceAll('-', ' '), `${p.id}'s name isn't its theme's: run tools/make-puzzles.mjs`);
    assert.equal(p.clue, theme.clue, `${p.id}'s clue isn't its theme's: run tools/make-puzzles.mjs`);
  }
});

// A word that is on two boards of one line is a repeat the player notices, and the second find is free.
test('no word is on two boards of the same line', () => {
  for (const line of LINES) {
    const seen = new Map();
    const twice = [];
    for (const p of line.puzzles) {
      for (const w of p.lines.map(l => spell(p.grid, l))) {
        if (seen.has(w)) twice.push(`${w} (${seen.get(w)}, ${p.id})`); else seen.set(w, p.id);
      }
    }
    assert.deepEqual(twice, [], `${line.name} repeats words`);
  }
});

for (const p of PUZZLES) {
  const theme = THEMES.find(t => t.id === p.id);
  const words = p.lines.map(l => spell(p.grid, l));

  test(`${p.id}: every stop is on exactly one line`, () => {
    assert.match(p.grid, new RegExp(`^[A-Z]{${N}}$`));
    const seen = new Array(N).fill(0);
    for (const line of p.lines) for (const i of line) { assert.ok(Number.isInteger(i) && i >= 0 && i < N); seen[i]++; }
    assert.deepEqual(seen, new Array(N).fill(1));
  });

  test(`${p.id}: lines step stop to stop and never cut across each other`, () => {
    const cut = new Set();
    for (const line of p.lines) {
      for (let k = 1; k < line.length; k++) {
        assert.ok(adjacent(line[k - 1], line[k]), `${line[k - 1]} and ${line[k]} aren't neighbours`);
        const d = diagonalSquare(line[k - 1], line[k]);
        if (d >= 0) { assert.ok(!cut.has(d), `two lines cross between stops ${d} and ${d + W + 1}`); cut.add(d); }
      }
    }
  });

  test(`${p.id}: the words are the theme's, and the first runs edge to edge`, () => {
    assert.equal(words[0], theme.cross);
    assert.ok(spans(p.lines[0]) && acrossTown(p.lines[0]), 'the Crosstown should start and end on opposite edges');
    const listed = new Set(theme.words.split(' '));
    for (const w of words.slice(1)) assert.ok(listed.has(w), `${w} isn't in the theme`);
    assert.equal(new Set(words).size, words.length);
    assert.ok(words.length >= 7 && words.length <= 9);
    for (const w of words) assert.ok(w.length >= 4);
    assert.ok(p.clue && !words.some(w => p.clue.toUpperCase().replace(/[^A-Z]/g, '').includes(w)), 'the clue gives a word away');
  });

  test(`${p.id}: no word can be spelled through another line's stops`, () => {
    p.lines.forEach((line, k) => {
      const own = new Set(line);
      for (const t of traces(p.grid, words[k], 40)) assert.ok(t.every(i => own.has(i)), `${words[k]} can be traced another way`);
    });
  });

  test(`${p.id}: only the Crosstown runs edge to edge`, () => {
    p.lines.forEach((line, k) => { if (k) assert.ok(!acrossTown(line), `${words[k]} runs edge to edge too, so it could be taken for the Crosstown`); });
  });

  test(`${p.id}: a theme word that isn't a line can't be traced either`, () => {
    for (const w of theme.words.split(' ')) {
      if (!words.includes(w)) assert.equal(traces(p.grid, w, 1).length, 0, `${w} is on the theme's list, but the map would call it a detour`);
    }
  });

  test(`${p.id}: detours are real finds, none is an answer or one with an ending added or taken off, and none is rude`, () => {
    const list = p.detours.split(' ');
    assert.ok(list.length >= 100, 'too few detours to earn a token');
    assert.equal(new Set(list).size, list.length);
    const answers = new Set(words.map(w => w.toLowerCase()));
    for (const d of list) {
      assert.match(d, /^[a-z]{4,}$/);
      assert.ok(!answers.has(d));
      assert.ok(!nearAnswer(d, words), `${d} is an answer with an ending added or taken off, so it shouldn't earn fare`);
      assert.ok(!isRude(d), `${d} shouldn't earn fare`);
      assert.ok(traces(p.grid, d.toUpperCase(), 1).length, `${d} isn't on the board`);
    }
  });
}

test('rude words stay out with -s, -es, -d or -ed on the end, and plain words that only look like them stay in', () => {
  for (const w of ['clits', 'boners', 'nudes', 'orgies', 'arsed', 'asses']) assert.ok(isRude(w), `${w} should stay out`);
  for (const w of ['spices', 'spiced', 'crapes', 'classes', 'passed', 'stories', 'clocks']) assert.ok(!isRude(w), `${w} should count`);
  // Words a family game shouldn't congratulate, and longer words that only start with one of them.
  for (const w of ['sperm', 'testes', 'prick', 'pricks', 'pricked', 'shag', 'bonk', 'harlot', 'harlots', 'nonce']) assert.ok(isRude(w), `${w} should stay out`);
  for (const w of ['prickle', 'prickly', 'shaggy', 'shagreen', 'spermaceti', 'gymnosperm', 'bonkers', 'harlotry', 'testis']) assert.ok(!isRude(w), `${w} should count`);
  // Words that hurt someone, or that a family game shouldn't cheer, and the plain words that start the same way.
  for (const w of ['bimbo', 'bimbos', 'pimp', 'pimps', 'pimped', 'pimping', 'ghetto', 'ghettos', 'ghettoes', 'spank', 'spanks', 'spanked', 'spanking', 'queer', 'queers']) assert.ok(isRude(w), `${w} should stay out`);
  for (const w of ['pimple', 'pimples', 'pimpled', 'pimpernel', 'spanker', 'spangle', 'queerly', 'ghee']) assert.ok(!isRude(w), `${w} should count`);
});

test('slurs and sneers stay out, with their plurals and other forms, and plain words that start the same way stay in', () => {
  for (const w of ['wog', 'wogs', 'boong', 'boongs', 'lubra', 'lubras', 'yid', 'yids', 'sheeny', 'sheenies', 'negroid', 'negroids',
    'negress', 'squaw', 'squaws', 'coolie', 'coolies', 'poof', 'poofs', 'poofter', 'poofters', 'sodomite', 'sodomites', 'sodomise',
    'sodomises', 'sodomize', 'whore', 'whores', 'whored', 'whoring', 'gyp', 'gypper', 'gyppers', 'shiksa', 'shiksas',
    'cretin', 'cretins', 'fatso', 'fatsos', 'fatsoes', 'wench', 'wenches', 'mongol', 'mongols', 'harelip', 'harelips',
    'slapper', 'slappers', 'gringo', 'gringos', 'midget', 'midgets', 'trollop', 'trollops', 'strumpet', 'strumpets',
    'bugger', 'buggers', 'buggery', 'limey', 'limeys', 'pommy', 'pommies', 'mick', 'micks', 'octoroon', 'octoroons', 'quadroon',
    'quadroons', 'cretinous', 'hussy', 'hussies', 'trull', 'trulls', 'slattern', 'slatterns', 'doxy', 'doxies']) assert.ok(isRude(w), `${w} should stay out`);
  for (const w of ['woggle', 'coolly', 'mongoose', 'monger', 'mongrel', 'wrench', 'buggy', 'midge', 'midges', 'sheen', 'sheens',
    'whorl', 'whorls', 'gypsum', 'lime', 'limes', 'pommel', 'mickle', 'doxology']) assert.ok(!isRude(w), `${w} should count`);
});

test('an answer with an ending added or taken off is near it, and a longer word that only starts with it isn\'t', () => {
  const near = [['spears', 'spear'], ['spear', 'spears'], ['bake', 'baked'], ['bake', 'baker'], ['bake', 'baking'], ['bake', 'bakes'],
    ['baked', 'bake'], ['baking', 'bake'], ['box', 'boxes'], ['boxes', 'box'], ['berry', 'berries'], ['carry', 'carried'],
    ['stop', 'stopped'], ['plan', 'planner'], ['plan', 'planning'], ['jump', 'jumping'], ['jump', 'jumper'], ['corner', 'corn']];
  for (const [answer, word] of near) assert.ok(nearAnswer(word, ['TACK', answer.toUpperCase()]), `${word} should be near ${answer}`);
  for (const [answer, word] of [['spear', 'spearmint'], ['bake', 'bakery'], ['stop', 'stoop'], ['plan', 'plane'], ['carry', 'carrot'], ['corn', 'acorn']]) {
    assert.ok(!nearAnswer(word, [answer]), `${word} shouldn't be near ${answer}`);
  }
});

test('fare and stars', () => {
  assert.equal(fareFor('tape'), 1);
  assert.equal(fareFor('twine'), 2);
  assert.equal(fareFor('pencil'), 3);
  assert.equal(fareFor('scissors'), 4);
  assert.ok(FARE_PER_TOKEN >= 3);
  assert.equal(starsFor({ done: true, spent: 0, crossAt: 0 }), 3);
  assert.equal(starsFor({ done: true, spent: 0, crossAt: 2 }), 2);
  assert.equal(starsFor({ done: true, spent: 1, crossAt: 0 }), 2);
  assert.equal(starsFor({ done: true, spent: 2, crossAt: 4 }), 1);
  assert.equal(starsFor({ done: false, spent: 0, crossAt: 0 }), 0);
});

test('the offline copy lists every file the page loads', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  for (const f of ['index.html', 'css/app.css', 'js/app.js', 'js/board.js', 'js/rules.js', 'js/puzzles.js', 'fonts/overpass.woff2', 'icon.svg', 'manifest.webmanifest', ...LINES.map(l => `js/detours/${l.id}.js`)]) {
    assert.ok(sw.includes(`'${f}'`), `sw.js doesn't keep ${f}`);
  }
});
