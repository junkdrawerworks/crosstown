// Plays the game in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import assert from 'node:assert/strict';
import { playwright, serve, drag, tap, tapOut } from '../tools/play.mjs';
import { LINES } from '../js/puzzles.js';
import { DETOURS } from '../js/detours/main.js';
import { traces, spell, adjacent, NEIGHBORS } from '../js/board.js';
import { fareFor, starsFor, FARE_PER_TOKEN } from '../js/rules.js';

const { server, base } = serve();
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

const text = sel => page.textContent(sel);
// The list opens on the first line (the Main Line), and puzzle numbers count along it.
const PUZZLES = LINES[0].puzzles.map(q => ({ ...q, detours: DETOURS[q.id] }));
const p = PUZZLES[0];
const words = p.lines.map(l => spell(p.grid, l));
// A detour that avoids the given lines, of at least `min` letters, with the stops to trace it.
function detour(avoid, min, skip = new Set()) {
  const off = new Set(avoid.flatMap(k => p.lines[k]));
  for (const d of p.detours.split(' ')) {
    if (d.length < min || skip.has(d)) continue;
    const t = traces(p.grid, d.toUpperCase(), 20).find(t => t.every(i => !off.has(i)));
    if (t) return { word: d, path: t };
  }
  throw new Error('no detour found');
}
// The first detour on a puzzle of any line that can be traced (clear of the stops in `avoid`), with its stops.
async function detourOn(q, min = 4, avoid = []) {
  const { DETOURS } = await import(`../js/detours/${q.line}.js`);
  for (const d of DETOURS[q.id].split(' ')) {
    const t = d.length >= min && traces(q.grid, d.toUpperCase(), 20).find(t => !t.some(i => avoid.includes(i)));
    if (t) return { word: d, path: t };
  }
  throw new Error(`no detour found on ${q.id}`);
}

await page.goto(base);
await page.evaluate(() => document.fonts.ready);

// The list: every puzzle, none started.
assert.equal(await page.locator('#route li').count(), PUZZLES.length);
assert.equal(await text('#b-continue'), 'Play No. 1');
assert.equal(await text('#tally'), `${PUZZLES.length} puzzles`);

// Open the first one. Nothing found yet, no tokens. On a first visit the readout says how to trace, in a note that
// fits it without moving the map.
await page.click('#b-continue');
const HOW = 'Drag across the letters to trace a word, or tap them and tap the last one again';
assert.equal(await text('#readout'), HOW);
for (const [width, height] of [[320, 568], [390, 844]]) {
  await page.setViewportSize({ width, height });
  assert.equal(await page.evaluate(() => { const r = document.getElementById('readout'); return r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5; }), true, `the first visit's note is taller than the readout at ${width} px`);
}
assert.equal(await text('#clue'), p.clue);
assert.equal(await text('#count'), `0 of ${p.lines.length} lines`);
assert.equal(await page.locator('#board .stop').count(), 48);
assert.equal(await page.isDisabled('#b-token'), true);

// Drag out one line, tap out another. A stray tap just before, beside where the drag starts, stays out of its word.
const stray = NEIGHBORS[p.lines[2][0]].find(j => !p.lines[2].includes(j));
assert.ok(stray !== undefined, 'no stop beside the line to tap by mistake');
await tap(page, stray);
await drag(page, p.lines[2]);
assert.equal(await text('#count'), `1 of ${p.lines.length} lines`, 'a stray tap ended up in front of the dragged word');
assert.equal(await text('#readout'), words[2]);
assert.equal(await page.locator('#board .stop.on.c2').count(), p.lines[2].length);
await tapOut(page, p.lines[4]);
assert.equal(await text('#count'), `2 of ${p.lines.length} lines`);

// The same word spelled backwards is not the line.
await drag(page, p.lines[1].slice().reverse());
assert.equal(await text('#count'), `2 of ${p.lines.length} lines`);

// Too short, and not a word.
await drag(page, p.lines[1].slice(0, 3));
assert.equal(await text('#readout'), 'Too short');
const junk = (() => {   // four neighbouring unfound stops that spell nothing
  const off = new Set([...p.lines[2], ...p.lines[4]]);
  const all = new Set(p.detours.split(' '));
  for (let a = 0; a < 48; a++) for (let b = 0; b < 48; b++) for (let c = 0; c < 48; c++) for (let d = 0; d < 48; d++) {
    const path = [a, b, c, d];
    if (new Set(path).size < 4 || path.some(i => off.has(i)) || !adjacent(a, b) || !adjacent(b, c) || !adjacent(c, d)) continue;
    const w = spell(p.grid, path);
    if (!all.has(w.toLowerCase()) && !words.includes(w)) return path;
  }
})();
await drag(page, junk);
assert.equal(await text('#readout'), 'Not a word on this map');

// A detour earns fare by its length, once.
const first = detour([2, 4], 5);
await drag(page, first.path);
assert.match(await text('#readout'), new RegExp(`^Detour: ${first.word}, \\+${fareFor(first.word)} fare`));
let fare = fareFor(first.word);
assert.equal(await page.locator('#pips .full').count(), fare % FARE_PER_TOKEN);
await drag(page, first.path);
assert.match(await text('#readout'), /already counted$/);

// Enough detours for two tokens.
const used = new Set([first.word]);
while (fare < FARE_PER_TOKEN * 2) { const d = detour([2, 4], 6, used); used.add(d.word); await drag(page, d.path); fare += fareFor(d.word); }
assert.equal(await text('#token-label'), `Use a token (${Math.floor(fare / FARE_PER_TOKEN)})`);

// The first token rings a line's stops; the second draws its route.
await page.click('#b-token');
const ringed = await page.locator('#board .stop.hint').count();
assert.ok(p.lines.some((l, k) => k && l.length === ringed), 'the ringed stops should be one whole line');
assert.equal(await page.locator('#board .guide').count(), 0);
await page.click('#b-token');
assert.equal(await page.locator('#board .guide').count(), 1);
assert.equal(await page.locator('#board .stop.first').count(), 1);

// Leaving and coming back keeps everything.
await page.reload();
assert.equal(await text('#b-continue'), 'Resume No. 1');
assert.match(await text('#route li:first-child .row-sub'), /^2 of \d lines found$/);
await page.tap('#route li:first-child .row');
assert.equal(await text('#count'), `2 of ${p.lines.length} lines`);
// The map has the focus once the puzzle opens, with no ring after a tap.
assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.matches(':focus-visible')]), ['board', false], 'the map should have the focus, without a ring, after a tap opens a puzzle');
assert.equal(await text('#readout'), '', 'only a first visit is told how to trace');
assert.equal(await page.locator('#board .line').count(), 2);
assert.equal(await page.locator('#board .guide').count(), 1);

// With the keyboard: Tab to the map, which shows it has focus, then walk to a line's first stop and press Enter
// along it.
await page.focus('#b-menu');
await page.keyboard.press('Tab');
assert.deepEqual(await page.evaluate(() => [document.activeElement.id, getComputedStyle(document.activeElement).outlineStyle]), ['board', 'solid'], 'the map should show keyboard focus');
await page.focus('#board');
const walk = async (to, on = page) => {
  let at = await on.evaluate(() => [...document.querySelectorAll('#board .stop')].findIndex(s => s.classList.contains('cursor')));
  if (at < 0) { await on.keyboard.press('ArrowRight'); at = 0; }
  for (; at % 6 < to % 6; at++) await on.keyboard.press('ArrowRight');
  for (; at % 6 > to % 6; at--) await on.keyboard.press('ArrowLeft');
  for (; at < to; at += 6) await on.keyboard.press('ArrowDown');
  for (; at > to; at -= 6) await on.keyboard.press('ArrowUp');
};
for (const stop of p.lines[3]) { await walk(stop); await page.keyboard.press('Enter'); }
await page.keyboard.press('Enter');
assert.equal(await text('#count'), `3 of ${p.lines.length} lines`);

// The cursor shows on every stop, the blue line's own included.
await walk(p.lines[2][0]);
const ring = await page.evaluate(async () => {
  const dot = document.querySelector('#board .stop.cursor .dot');
  await Promise.all(dot.getAnimations().map(a => a.finished));   // the colours fade in; read them once they've settled
  const s = getComputedStyle(dot);
  return { blue: dot.parentNode.classList.contains('c2'), stroke: s.stroke, fill: s.fill };
});
assert.ok(ring.blue && ring.stroke !== ring.fill, `the cursor should show on a blue-line stop: ${JSON.stringify(ring)}`);

// An open sheet starts on its main button, keeps the keyboard inside it, and hands focus back when it closes.
const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim());
// The clock stops behind a sheet, so the letters go too, until it closes.
const letters = (on = page) => on.evaluate(() => getComputedStyle(document.querySelector('#board .stop text')).visibility);
await page.focus('#b-menu');
await page.keyboard.press('Enter');
assert.equal(await focused(), 'Done');
assert.equal(await letters(), 'hidden', 'the map can be read behind a sheet while the clock is stopped');
for (let k = 0; k < 12; k++) {
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('app').contains(document.activeElement)), false, 'Tab reached the page behind a sheet');
}
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => document.activeElement.id), 'b-menu');
assert.equal(await letters(), 'visible');

// Finish it. The Crosstown wasn't first and tokens were spent, so one star.
for (const k of [0, 1, 5, 6].filter(k => k < p.lines.length)) await drag(page, p.lines[k]);
for (let k = 7; k < p.lines.length; k++) await drag(page, p.lines[k]);
await page.waitForSelector('#sheet-done:not([hidden])');
assert.equal(await focused(), 'b-done-next', 'the done sheet should start on Next puzzle');
assert.equal(await text('#done-title'), p.name);
assert.equal(await page.locator('#done-stars .got').count(), 1);
// Earned and missed stars say which they are, not only by colour, and the sheet's description gives the result.
assert.deepEqual(await page.$$eval('#done-stars li', l => l.map(li => li.textContent)), ['Earned: Every stop on a line', 'Missed: No tokens spent', 'Missed: Crosstown found first']);
assert.equal(await page.getAttribute('#sheet-done .panel', 'aria-describedby'), 'done-sum done-stats done-line');
assert.deepEqual([await text('#done-sum'), await text('#done-line')], ['1 of 3 stars.', ''], "the description should say the stars, and nothing of a line that isn't finished");
assert.equal(await page.locator('#done-key li').count(), p.lines.length);
assert.equal(await page.locator('#board .stop.on').count(), 48);

// Sharing falls back to the clipboard, or to text you can select.
await page.click('#b-share');
await page.waitForSelector('#toast:not([hidden]), #share-box:not([hidden])', { timeout: 5000 });
if (await page.isVisible('#toast')) assert.equal(await text('#toast'), 'Result copied');
else assert.match(await page.inputValue('#share-text'), /^Crosstown Main Line No. 1 /);

// On to the next one, with night service on: the clue stays hidden until the first line.
await page.click('#b-done-next');
assert.equal(await text('#where'), 'Main, No. 2');
await page.click('#b-menu');
await page.check('#o-night');
await page.check('#o-clock');
await page.click('#sheet-menu .panel-row [data-close]');
assert.match(await text('#clue'), /^Night service/);
assert.equal(await page.isVisible('#clock'), true);
await drag(page, PUZZLES[1].lines[0]);
assert.equal(await text('#clue'), PUZZLES[1].clue);
assert.equal(await text('#readout'), `Crosstown: ${PUZZLES[1].name}`);

// Back on the list: one finished with a star, one under way.
await page.click('#b-back');
assert.equal(await text('#tally'), `1 of ${PUZZLES.length} finished, 1 of ${PUZZLES.length * 3} stars`);
assert.equal(await page.locator('#route li.done').count(), 1);
assert.equal(await page.locator('#route li.going').count(), 1);

// Night service keeps the clues off the list too, except where a line has been found.
assert.equal(await text('#route li:nth-child(1) .row-clue'), PUZZLES[0].clue);
assert.equal(await text('#route li:nth-child(2) .row-clue'), PUZZLES[1].clue);
assert.equal(await text('#route li:nth-child(3) .row-clue'), 'Night service');
assert.equal(await page.locator('#route .row-clue', { hasText: PUZZLES[2].clue }).count(), 0, 'a hidden clue is on the list');
await page.click('#b-list-menu');
await page.uncheck('#o-night');
assert.equal(await text('#route li:nth-child(3) .row-clue'), PUZZLES[2].clue, 'turning night service off should show the clues');
await page.check('#o-night');
await page.click('#sheet-menu .panel-row [data-close]');
assert.equal(await text('#route li:nth-child(3) .row-clue'), 'Night service');

// Starting a puzzle over takes two taps.
await page.click('#route li:nth-child(2) .row');
await page.click('#b-menu');
await page.click('#m-restart');
assert.equal(await text('#m-restart'), 'Tap again to clear this puzzle');
await page.click('#m-restart');
assert.equal(await text('#count'), `0 of ${PUZZLES[1].lines.length} lines`);
await page.click('#b-back');

// Fits a phone: nothing scrolls sideways, on the list or in a puzzle.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the list scrolls sideways on a phone');
await page.click('#route li:nth-child(3) .row');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, 'a puzzle should fit the screen');
const box = await page.locator('#board').boundingBox();
assert.ok(box.width > 300 && box.y + box.height < 844 - 60, 'the map should be big and clear of the buttons');

// A small phone still fits the whole map.
await page.setViewportSize({ width: 320, height: 568 });
const small = await page.locator('#board').boundingBox();
const bar = await page.locator('#fare').boundingBox();
assert.ok(small.width >= 240 && small.y + small.height <= bar.y + 1, 'the map should fit above the fare bar on a small phone');
await page.setViewportSize({ width: 390, height: 844 });

// Another visitor, arriving with `state` already saved, for the checks that need a particular save.
async function visitor(state, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  await context.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('crosstown.v1', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(state));
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(base);
  await tab.evaluate(() => document.fonts.ready);
  return { other: context, tab, errors };
}
const finished = q => ({ found: q.lines.map((_, k) => k), detours: [], spent: 0, done: true, crossAt: 0 });
// The contrast ratio of two computed colours, as WCAG reckons it.
function contrast(a, b) {
  const lum = c => {
    const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The last puzzle has no next one, so its done sheet starts on Share instead.
{
  const last = PUZZLES.at(-1);
  // Every other puzzle on every line finished, so this is the last one anywhere.
  const games = Object.fromEntries(LINES.flatMap(l => l.puzzles).filter(q => q.id !== last.id).map(q => [q.id, finished(q)]));
  games[last.id] = { found: last.lines.map((_, k) => k).slice(1), detours: [] };
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  await tab.click('#b-continue');
  await drag(tab, last.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await letters(tab), 'visible', 'the finished map should show behind the done sheet');
  assert.equal(await tab.isHidden('#b-done-next'), true);
  assert.equal(await tab.textContent('#sheet-done .eyebrow'), 'Every line finished');
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'b-share', 'the last done sheet should start on Share');
  const earned = await tab.evaluate(() => ({ fill: getComputedStyle(document.querySelector('#done-stars .got svg')).fill, bg: getComputedStyle(document.querySelector('#sheet-done .panel')).backgroundColor }));
  assert.ok(contrast(earned.fill, earned.bg) >= 3, `the stars earned are hard to see on the done sheet: ${JSON.stringify(earned)}`);

  // On the finished map the arrows and Enter name the lines, the same as tapping a stop.
  await tab.keyboard.press('Escape');
  await tab.focus('#board');
  const named = i => { const k = last.lines.findIndex(l => l.includes(i)); return k ? spell(last.grid, last.lines[k]) : `Crosstown: ${last.name}`; };
  for (const stop of [last.lines[1][0], last.lines[0][0]]) {
    await walk(stop, tab);
    await tab.keyboard.press('Enter');
    assert.equal(await tab.textContent('#readout'), named(stop), 'Enter on a finished map should name the line');
  }
  assert.equal(await tab.locator('#board .stop.cursor').count(), 1);

  // With every puzzle finished, the big button on the list says so in letters you can read, in either palette.
  await tab.click('#b-back');
  for (const colorScheme of ['light', 'dark']) {
    await tab.emulateMedia({ colorScheme });
    const btn = await tab.evaluate(() => {
      const b = document.getElementById('b-continue'), s = getComputedStyle(b);
      return { text: b.textContent, disabled: b.disabled, color: s.color, bg: s.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : s.backgroundColor };
    });
    assert.equal(btn.text, 'All finished');
    assert.ok(btn.disabled && contrast(btn.color, btn.bg) >= 4.5, `"All finished" is hard to read in ${colorScheme}: ${JSON.stringify(btn)}`);
    // The stars on the list are small text, so full and empty ones need the contrast text does to tell apart.
    const stars = await tab.evaluate(() => ({ color: getComputedStyle(document.querySelector('#route .st')).color, bg: getComputedStyle(document.body).backgroundColor }));
    assert.ok(contrast(stars.color, stars.bg) >= 4.5, `the stars on the list are hard to see in ${colorScheme}: ${JSON.stringify(stars)}`);
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// With one line left and its route already drawn, a token has nothing to do, so the button is off. With only its
// stops ringed, a token can still draw the route.
{
  const lastLine = p.lines.length - 1;
  const nearly = hint => ({ options: {}, best: {}, games: { [p.id]: { found: p.lines.map((_, k) => k).slice(0, -1), detours: [], hint, tokens: 1, spent: 1 } } });
  const { other, tab, errors } = await visitor(nearly({ line: lastLine, level: 2 }));
  await tab.click('#b-continue');
  assert.equal(await tab.locator('#board .guide').count(), 1);
  assert.equal(await tab.isDisabled('#b-token'), true, 'a token with nothing to do should be off');
  await tab.click('#b-back');   // leaving saves the open puzzle, so leave before writing a different save
  await tab.evaluate(s => localStorage.setItem('crosstown.v1', s), JSON.stringify(nearly({ line: lastLine, level: 1 })));
  await tab.reload();
  await tab.click('#b-continue');
  assert.equal(await tab.isDisabled('#b-token'), false);
  await tab.click('#b-token');
  assert.equal(await tab.locator('#board .guide').count(), 1, 'the token should draw the last line\'s route');
  assert.deepEqual(errors, []);
  await other.close();
}

// While a route shows on a line not yet found, the token button stays off, even with tokens and other lines left:
// another token would ring a different line and lose the route. A tap on it says so, and spends nothing. Tracing
// that line turns it back on.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: [], detours: [], hint: { line: 1, level: 2 }, tokens: 2, spent: 2 } } });
  await tab.click('#b-continue');
  assert.equal(await tab.locator('#board .guide').count(), 1);
  assert.equal(await tab.isDisabled('#b-token'), true, 'a token while a route is showing would lose the route');
  await tab.click('#b-token', { force: true });
  assert.equal(await tab.textContent('#readout'), 'Trace the dashed route first. Your tokens keep', 'a tap on the token button while a route shows should say why it is off');
  assert.deepEqual([await tab.textContent('#token-label'), await tab.locator('#board .guide').count()], ['Use a token (2)', 1]);
  await drag(tab, p.lines[1]);
  assert.equal(await tab.locator('#board .guide').count(), 0);
  assert.equal(await tab.isDisabled('#b-token'), false, 'once the route is traced, a token should work again');
  await tab.click('#b-token');
  assert.ok(await tab.locator('#board .stop.hint').count() > 0, 'the next token should ring another line');
  assert.deepEqual(errors, []);
  await other.close();
}

// Tapping the first letters of a word and then dragging on from the last one carries the same word on. Until it's
// sent, a tapped word shows muted, so it can't be taken for a word that's been found; a dragged word shows as usual.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} });
  await tab.click('#b-continue');
  const pending = () => tab.evaluate(() => document.getElementById('readout').classList.contains('pending'));
  await tap(tab, p.lines[1][0]);
  await tap(tab, p.lines[1][1]);
  assert.equal(await pending(), true, 'a tapped word not yet sent looks like a found one');
  const box = await tab.locator('#board').boundingBox();
  const at = i => [box.x + (i % 6 + 0.5) * box.width / 6, box.y + (Math.floor(i / 6) + 0.5) * box.height / 8];
  await tab.mouse.move(...at(p.lines[1][1]));
  await tab.mouse.down();
  for (const i of p.lines[1].slice(2)) {
    await tab.mouse.move(...at(i), { steps: 3 });
    assert.equal(await pending(), false, 'a word being dragged should show as usual');
  }
  await tab.mouse.up();
  assert.equal(await tab.textContent('#count'), `1 of ${p.lines.length} lines`, 'dragging on from the last tapped letter should carry the word on');
  assert.equal(await tab.textContent('#readout'), words[1]);
  assert.deepEqual(errors, []);
  await other.close();
}

// On narrow phones (many Androids are 360 wide) the button labels stay on one line, on the list and in a puzzle.
for (const [width, height] of [[360, 780], [320, 568]]) {
  const games = Object.fromEntries(PUZZLES.slice(0, 11).map(q => [q.id, finished(q)]));
  games[PUZZLES[11].id] = { found: [1], detours: [], tokens: 12, fare: 2 };
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games }, { viewport: { width, height } });
  const oneLine = ids => tab.evaluate(([ids, width]) => ids.filter(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.height > 44.5 || r.right > width - 15.5; }), [ids, width]);
  const row = ['b-continue', 'b-how', 'b-list-menu'];
  assert.equal(await tab.textContent('#b-continue'), 'Resume No. 12');
  assert.deepEqual(await oneLine(row), [], `list buttons that wrap or stick out at ${width}px`);
  if (width >= 360) assert.equal(await tab.evaluate(ids => new Set(ids.map(id => Math.round(document.getElementById(id).getBoundingClientRect().top))).size, row), 1, 'the list buttons should share a row');
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#token-label'), 'Use a token (12)');
  assert.deepEqual(await oneLine(['b-token']), [], `the token button wraps or sticks out at ${width}px`);
  assert.deepEqual(errors, []);
  await other.close();
}
// With a line finished, the big button offers the next line, and the three still share a row from 360 up. Below that
// the big button has a row of its own and the other two share the next.
for (const l of LINES.length > 1 ? LINES : []) {
  const games = Object.fromEntries(l.puzzles.map(q => [q.id, finished(q)]));
  const { other, tab, errors } = await visitor({ options: { line: l.id }, best: {}, games });
  const next = LINES[(LINES.indexOf(l) + 1) % LINES.length];
  assert.equal(await tab.textContent('#b-continue'), `On to ${next.name.replace(/ Line$/, '')}`);
  for (const width of [430, 390, 360, 320]) {
    await tab.setViewportSize({ width, height: 800 });
    const boxes = await tab.evaluate(() => ['b-continue', 'b-how', 'b-list-menu'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(r.top), h: r.height, right: r.right }; }));
    const tops = boxes.map(b => b.top);
    const tidy = width >= 360 ? new Set(tops).size === 1 : tops[0] < tops[1] && tops[1] === tops[2];
    assert.ok(tidy && boxes.every(b => b.h <= 44.5 && b.right <= width - 15.5), `the list buttons with "${await tab.textContent('#b-continue')}" at ${width}px: ${JSON.stringify(boxes)}`);
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// The bar names the line and the number. On a small phone with the clock past an hour, only the line's name gives
// way: the number always shows whole.
if (LINES.length > 1) {
  const l = LINES.reduce((a, b) => (b.name.length > a.name.length ? b : a)), q = l.puzzles.at(-1);
  const { other, tab, errors } = await visitor({ options: { clock: true, line: l.id }, best: {}, games: { [q.id]: { found: [1], detours: [], ms: 5025000 } } }, { viewport: { width: 320, height: 568 } });
  await tab.click(`#route li:nth-child(${l.puzzles.length}) .row`);
  assert.equal(await tab.textContent('#clock'), '1:23:45');
  const bar = await tab.evaluate(() => {
    const box = id => document.querySelector(id).getBoundingClientRect();
    const no = document.querySelector('#where .where-no');
    return { text: document.getElementById('where').textContent, whole: no.scrollWidth <= no.clientWidth, clear: box('#where .where-no').right <= box('#clock').left, sep: getComputedStyle(document.querySelector('#where .sep')).width };
  });
  assert.deepEqual(bar, { text: `${l.name.replace(/ Line$/, '')}, No. ${l.puzzles.length}`, whole: true, clear: true, sep: bar.sep }, `the puzzle's number is cut off at 320 px: ${JSON.stringify(bar)}`);
  assert.notEqual(bar.sep, '0px');
  assert.deepEqual(errors, []);
  await other.close();
}

// Each arrow move on the map is read out to screen readers in a line of its own that isn't on screen: the letter
// and where it is, whether a token has ringed it, or the line it's on once that line is found.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: [0, 2], detours: [], hint: { line: 1, level: 2 } } } });
  await tab.click('#b-continue');
  await tab.focus('#board');
  const at = i => `row ${Math.floor(i / 6) + 1}, column ${i % 6 + 1}`;
  const hears = async (stop, words) => { await walk(stop, tab); assert.equal(await tab.evaluate(() => document.getElementById('spoken')?.textContent), words, 'an arrow move should be read out'); };
  const open = p.lines[3][1], route = p.lines[1];
  await hears(open, `${p.grid[open]}, ${at(open)}`);
  await hears(p.lines[2][1], `${p.grid[p.lines[2][1]]}, on the ${words[2]} line, ${at(p.lines[2][1])}`);
  await hears(p.lines[0][0], `${p.grid[p.lines[0][0]]}, on the Crosstown, ${at(p.lines[0][0])}`);
  await hears(route[1], `${p.grid[route[1]]}, ${at(route[1])}, ringed`);
  await hears(route[0], `${p.grid[route[0]]}, ${at(route[0])}, ringed, the route starts here`);
  const spoken = await tab.evaluate(() => { const s = document.getElementById('spoken'), r = s.getBoundingClientRect(); return { live: s.getAttribute('aria-live'), w: r.width, h: r.height, inPlay: document.getElementById('s-play').contains(s) }; });
  assert.ok(spoken.live === 'polite' && spoken.w <= 1 && spoken.h <= 1 && spoken.inPlay, `the moves should be read out, not shown: ${JSON.stringify(spoken)}`);
  assert.equal(await tab.textContent('#readout'), '', 'moving the cursor should leave the readout alone');
  assert.deepEqual(errors, []);
  await other.close();
}

// Where the clipboard can't be used, Share puts the result in a box to copy by hand, with what to do in a label just
// above it, not in a toast on top of it. Where it can, a toast says the result was copied.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: p.lines.map((_, k) => k).slice(1), detours: [] } } });
  await tab.click('#b-continue');
  await drag(tab, p.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  const clipboard = works => tab.evaluate(works => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    navigator.clipboard.writeText = () => (works ? Promise.resolve() : Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')));
  }, works);
  await clipboard(false);
  await tab.click('#b-share');
  await tab.waitForSelector('#share-box:not([hidden])', { timeout: 5000 });
  const shown = await tab.evaluate(() => {
    const box = document.getElementById('share-text'), label = box.labels[0];
    return { toast: !document.getElementById('toast').hidden, label: label?.textContent, gap: box.getBoundingClientRect().top - label?.getBoundingClientRect().bottom, focused: document.activeElement === box, value: box.value, selected: box.selectionEnd - box.selectionStart };
  });
  assert.equal(shown.toast, false, 'a toast would cover the text to copy');
  assert.ok(shown.label === 'Select the text and copy it' && shown.gap >= 0 && shown.gap < 12, `the instruction should sit just above the box: ${JSON.stringify(shown)}`);
  assert.ok(shown.focused && shown.value.startsWith('Crosstown Main Line No. 1 ') && shown.selected === shown.value.length, `the result should be in the box, selected: ${JSON.stringify(shown)}`);
  await tab.keyboard.press('Escape');
  await tab.click('#b-results');
  assert.equal(await tab.isHidden('#share-box'), true, 'the box should go when the sheet closes');
  await clipboard(true);
  await tab.click('#b-share');
  await tab.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  assert.equal(await tab.textContent('#toast'), 'Result copied');
  assert.equal(await tab.isHidden('#share-box'), true);
  assert.deepEqual(errors, []);
  await other.close();
}

// On a small phone a note that wraps onto a second line still fits the readout's height, so the map stays put.
{
  const longest = p.detours.split(' ').reduce((a, b) => (b.length > a.length ? b : a));
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: [], detours: [], fare: 3 } } }, { viewport: { width: 320, height: 568 } });
  await tab.click('#b-continue');
  const top = async () => (await tab.locator('#board').boundingBox()).y;
  const before = await top();
  await drag(tab, traces(p.grid, longest.toUpperCase(), 1)[0]);
  assert.match(await tab.textContent('#readout'), /Token earned$/);
  const lines = await tab.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('readout')); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; });
  assert.equal(lines, 2, `this check needs a note long enough to wrap at 320 px: ${await tab.textContent('#readout')}`);
  assert.equal(await top(), before, 'the map moved down when a note wrapped onto two lines');
  assert.deepEqual(errors, []);
  await other.close();
}

// A damaged save, or one from an older layout of a board, can't stop the page: the list still draws, and each
// puzzle still opens and plays, keeping whatever could be read.
{
  const damaged = { options: {}, best: [], games: {
    [PUZZLES[0].id]: { found: [0, 1, 99], detours: 'oops', fare: 'x', hint: { line: 1, level: 2 } },
    [PUZZLES[1].id]: { found: null },
    [PUZZLES[2].id]: { found: '01' },
  } };
  const { other, tab, errors } = await visitor(damaged);
  assert.equal(await tab.locator('#route li').count(), PUZZLES.length, 'a damaged save should still list every puzzle');
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-sub'), `2 of ${PUZZLES[0].lines.length} lines found`);
  await tab.click('#route li:nth-child(1) .row');
  assert.equal(await tab.locator('#board .line').count(), 2, 'the line number the board does not have should be dropped');
  await drag(tab, PUZZLES[0].lines[2]);
  assert.equal(await tab.textContent('#count'), `3 of ${PUZZLES[0].lines.length} lines`);
  await tab.click('#b-back');
  for (const n of [1, 2]) {
    await tab.click(`#route li:nth-child(${n + 1}) .row`);
    await drag(tab, PUZZLES[n].lines[1]);
    assert.equal(await tab.textContent('#count'), `1 of ${PUZZLES[n].lines.length} lines`);
    await tab.click('#b-back');
  }
  await tab.reload();
  assert.equal(await tab.textContent('#route li:nth-child(3) .row-sub'), `1 of ${PUZZLES[2].lines.length} lines found`);
  assert.deepEqual(errors, [], 'errors with a damaged save');
  await other.close();
}

// A save cut short (not JSON at all) stays as it was when the page opens, and a copy is put aside to be got back by
// hand, before anything can write over it. Best times that aren't times show no time, and fare worth a token or more
// counts as tokens.
{
  const [a, b, c, d] = PUZZLES;
  const whole = JSON.stringify({ options: { clock: true }, best: { [a.id]: 'fast', [b.id]: -1, [c.id]: 61000 }, games: {
    [a.id]: finished(a), [b.id]: finished(b), [c.id]: finished(c), [d.id]: { found: [], detours: [], fare: 7, tokens: 0 },
  } });
  const cut = whole.slice(0, -20);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('crosstown.v1', s); sessionStorage.setItem('seeded', '1'); } }, cut);
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(base);
  assert.equal(await tab.textContent('#tally'), `${PUZZLES.length} puzzles`);
  const kept = () => tab.evaluate(() => [localStorage.getItem('crosstown.v1'), localStorage.getItem('crosstown.v1.unreadable')]);
  assert.deepEqual(await kept(), [cut, cut], 'a save that could not be read should be left as it was, and put aside');
  await tab.click('#b-continue'); await drag(tab, a.lines[1]); await tab.click('#b-back');
  assert.equal((await kept())[1], cut, 'the save put aside should stay put');

  await tab.evaluate(s => localStorage.setItem('crosstown.v1', s), whole);
  await tab.reload();
  for (const [n, time] of [[1, ''], [2, ''], [3, ' 1:01']]) assert.equal(await tab.textContent(`#route li:nth-child(${n}) .row-sub`), `${PUZZLES[n - 1].name} ★★★${time}`, 'a best time that is not a time should not show');
  await tab.click('#route li:nth-child(4) .row');
  assert.equal(await tab.getAttribute('#meter', 'aria-label'), `Fare: 3 of ${FARE_PER_TOKEN}`);
  assert.equal(await tab.textContent('#token-label'), 'Use a token (1)', 'a whole token of fare should count as a token');
  assert.deepEqual(errors, []);
  await context.close();
}

// Two windows at once (the installed app and a browser tab, or two tabs): neither writes over what the other saved,
// whether by being switched away from, by switching lines or by playing the same puzzle, and each shows what the
// other saved as it happens. Starting a puzzle over, and erasing every line, still take games out in both.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const [a, b] = [await context.newPage(), await context.newPage()];
  const errors = [];
  for (const tab of [a, b]) tab.on('pageerror', e => errors.push(e.message));
  const stored = () => a.evaluate(() => JSON.parse(localStorage.getItem('crosstown.v1')));
  // The page is switched away from (another app, another tab), and so saves the puzzle on screen.
  const away = tab => tab.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
  const pick = async (tab, n) => { await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${n}) .line-row`); };
  const m = LINES[1].puzzles[0];
  await b.goto(base); await b.click('#b-continue'); await drag(b, p.lines[1]);   // B: Main No. 1, a line found
  await a.goto(base); await pick(a, 2); await a.click('#b-continue');
  for (const line of m.lines) await drag(a, line);                                 // A: Market No. 1, finished
  await a.waitForSelector('#sheet-done:not([hidden])');
  await away(b);
  let s = await stored();
  assert.equal(s.games[m.id]?.done, true, 'switching away from one window lost a puzzle finished in the other');
  assert.equal(s.games[p.id]?.found.length, 1);
  // A finishes Main No. 1, which B still has open with one line. B is switched away from: the finished game stays.
  await a.keyboard.press('Escape'); await a.click('#b-back'); await pick(a, 1);
  assert.equal(await a.textContent('#route li:nth-child(1) .row-sub'), `1 of ${p.lines.length} lines found`, 'the list should show a game saved in the other window');
  await a.click('#route li:nth-child(1) .row');
  for (const k of p.lines.keys()) if (k !== 1) await drag(a, p.lines[k]);
  await a.waitForSelector('#sheet-done:not([hidden])');
  await away(b);
  assert.equal((await stored()).games[p.id]?.done, true, 'a game further along in the other window was written over');
  await b.click('#b-back');
  assert.equal(await b.getAttribute('#route li:nth-child(1)', 'class'), 'done');
  // B switches line: A's games stay, and B's lines sheet and lists show them.
  await b.click('#b-line');
  assert.match(await b.textContent('#lines li:nth-child(2) .line-prog'), /^1 of /, 'the lines sheet should show a puzzle finished in the other window');
  await b.click('#lines li:nth-child(3) .line-row');
  s = await stored();
  assert.deepEqual([s.games[m.id]?.done, s.games[p.id]?.done, s.options.line], [true, true, LINES[2].id], 'switching line in one window lost games saved in the other');
  await pick(b, 2);
  assert.equal(await b.getAttribute('#route li:nth-child(1)', 'class'), 'done');
  // A, back on its list, stays on the line it had on show.
  await a.keyboard.press('Escape'); await a.click('#b-back');
  assert.equal(await a.textContent('#line-name'), LINES[0].name);
  // A starts Market No. 1 over. B shows it, and B's next writes (an option, a line) don't bring the game back.
  await pick(a, 2); await a.click('#route li:nth-child(1) .row');
  await a.click('#b-menu'); await a.click('#m-restart'); await a.click('#m-restart'); await a.click('#b-back');
  await b.waitForFunction(() => document.querySelector('#route li:nth-child(1)').className === 'todo', null, { timeout: 5000 })
    .catch(() => assert.fail('a puzzle started over in one window should show as not started in the other'));
  await b.click('#b-list-menu'); await b.click('#o-clock'); await b.keyboard.press('Escape');
  await pick(b, 1);
  s = await stored();
  assert.deepEqual([s.games[m.id], s.games[p.id]?.done, s.options.clock], [undefined, true, true], 'one window brought back a puzzle started over in the other');
  // B erases every line: A's list empties, and A's next write doesn't bring anything back.
  await b.click('#b-list-menu'); await b.click('#m-erase'); await b.click('#m-erase');
  await a.waitForFunction(() => document.getElementById('tally').textContent.endsWith(' puzzles'), null, { timeout: 5000 })
    .catch(() => assert.fail('erasing in one window should empty the other\'s list'));
  await pick(a, 4);
  s = await stored();
  assert.deepEqual([s.games, s.best, s.options.clock, s.options.line], [{}, {}, true, LINES[3].id], 'one window brought back progress erased in the other');
  assert.equal(await b.textContent('#tally'), `${PUZZLES.length} puzzles`);
  assert.equal(await b.isHidden('#unkept'), true, 'where storage works, the list should say nothing about it');
  assert.deepEqual(errors, []);
  await context.close();
}

// A browser that isn't keeping anything (storage blocked, or full) still plays, and the list says progress isn't
// being kept. Erasing doesn't claim to have erased anything for good.
for (const how of ['blocked', 'full']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(how => {
    if (how === 'full') Storage.prototype.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
    else Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Access is denied.', 'SecurityError'); } });
  }, how);
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(base);
  const note = "This browser isn't keeping your progress, so it goes when the page closes.";
  assert.equal(await tab.isVisible('#unkept') && await tab.textContent('#unkept'), note, `the list should say progress isn't kept (${how})`);
  await tab.click('#b-continue');
  for (const line of p.lines) await drag(tab, line);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  await tab.keyboard.press('Escape'); await tab.click('#b-back');
  assert.equal(await tab.getAttribute('#route li:nth-child(1)', 'class'), 'done', `a puzzle should still finish (${how})`);
  assert.equal(await tab.isVisible('#unkept'), true);
  await tab.click('#b-list-menu'); await tab.click('#m-erase'); await tab.click('#m-erase');
  assert.equal(await tab.textContent('#toast'), 'Erased for this visit only');
  assert.deepEqual(errors, [], `errors with storage ${how}`);
  await context.close();
}
// Each saved game keeps its board's letters. Progress on a board laid out again since starts fresh, since its line
// numbers would draw lines on the wrong letters, but its best time stays. A game saved before games kept their
// letters counts as one on the board as it is now.
{
  const [a, b, c] = PUZZLES;
  const relaid = a.grid.split('').reverse().join('');
  const { other, tab, errors } = await visitor({ options: { clock: true }, best: { [a.id]: 61000 }, games: {
    [a.id]: { ...finished(a), grid: relaid },
    [b.id]: { found: [1], detours: [] },
    [c.id]: { found: [2], detours: [], grid: c.grid },
  } });
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-sub'), `${a.lines.length} lines`, 'progress on a board laid out again should start fresh');
  assert.equal(await tab.textContent('#route li:nth-child(2) .row-sub'), `1 of ${b.lines.length} lines found`, 'a game saved without its letters should be kept');
  assert.equal(await tab.textContent('#route li:nth-child(3) .row-sub'), `1 of ${c.lines.length} lines found`);
  await tab.click('#route li:nth-child(1) .row');
  assert.equal(await tab.textContent('#count'), `0 of ${a.lines.length} lines`);
  assert.equal(await tab.locator('#board .line').count(), 0);
  await drag(tab, a.lines[1]);
  await tab.click('#b-back');
  await tab.click('#route li:nth-child(2) .row');
  await tab.click('#b-back');
  const stored = await tab.evaluate(() => JSON.parse(localStorage.getItem('crosstown.v1')));
  assert.equal(stored.best[a.id], 61000, 'the best time should stay');
  assert.deepEqual([stored.games[a.id].grid, stored.games[a.id].found], [a.grid, [1]], 'a saved game should keep its board\'s letters');
  assert.deepEqual([stored.games[b.id].grid, stored.games[b.id].found], [b.grid, [1]], 'a game saved without its letters should take them on');
  assert.deepEqual(errors, []);
  await other.close();
}

// Back (the browser's, or the back gesture in the installed app) goes from a puzzle to the list, closing an open
// sheet first, and Forward opens the puzzle again. Next puzzle doesn't add a step, so Back still means the list. The
// back arrow and a reload on a puzzle leave no step behind, so one Back from the list leaves the game.
{
  const [a, b] = PUZZLES;
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {
    [a.id]: { found: a.lines.map((_, k) => k).slice(1), detours: [] },
    [b.id]: { found: [1], detours: [] },
  } });
  const see = (want, why) => tab.waitForFunction(want => (document.getElementById('s-list').hidden ? document.getElementById('where').textContent : 'list') === want, want, { timeout: 5000 }).catch(() => assert.fail(why));
  const left = await tab.evaluate(() => history.length);
  await tab.click('#route li:nth-child(2) .row');
  await see('Main, No. 2', 'the puzzle should open');
  await tab.goBack();
  await see('list', 'Back should go from a puzzle to the list');
  assert.equal(await tab.textContent('#route li:nth-child(2) .row-sub'), `1 of ${b.lines.length} lines found`);
  await tab.goForward();
  await see('Main, No. 2', 'Forward should open the puzzle again');
  await tab.click('#b-menu');
  await tab.goBack();
  await see('Main, No. 2', 'Back with a sheet open should stay on the puzzle');
  assert.equal(await tab.isHidden('#sheet-menu'), true, 'Back should close the open sheet');
  await tab.goBack();
  await see('list', 'Back after closing a sheet should go to the list');

  await tab.click('#b-continue');
  await see('Main, No. 1');
  await drag(tab, a.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  await tab.click('#b-done-next');
  await see('Main, No. 2');
  await tab.goBack();
  await see('list', 'Back after Next puzzle should go to the list, not the puzzle before');

  // The back arrow, even with another puzzle opened before its Back has come through.
  await tab.click('#route li:nth-child(2) .row');
  await see('Main, No. 2');
  await tab.evaluate(() => { document.getElementById('b-back').click(); document.querySelector('#route li:nth-child(3) .row').click(); });
  await see('Main, No. 3');
  await tab.waitForFunction(id => history.state?.crosstown === id, PUZZLES[2].id, { timeout: 5000 });
  await tab.goBack();
  await see('list', 'Back after the back arrow should go to the list');

  await tab.click('#route li:nth-child(2) .row');
  await see('Main, No. 2');
  await tab.reload();
  await see('list', 'a reload should open on the list');
  await tab.waitForFunction(() => history.state === null, null, { timeout: 5000 });
  assert.equal(await tab.evaluate(() => history.length), left + 1, 'the history should hold one step for a puzzle, no more');
  assert.deepEqual(errors, []);
  await tab.goBack();   // to the blank page the tab started on, where the seeding script can't run
  assert.equal(tab.url(), 'about:blank', 'one Back from the list should leave the game');
  await other.close();
}

// On the list, Back with a sheet open closes the sheet and stays on the list. Closing a sheet from the page (Close,
// the scrim, Escape, picking a line) takes its step off again, so one Back from the list still leaves the game.
if (LINES.length > 1) {
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} });
  const open = async (button, sheet) => { await tab.click(button); await tab.waitForSelector(`${sheet}:not([hidden])`); };
  const listOnly = () => tab.waitForFunction(() => history.state === null && [...document.querySelectorAll('.sheet')].every(s => s.hidden) && !document.getElementById('s-list').hidden, null, { timeout: 5000 });
  const blank = await tab.evaluate(() => history.length);
  await open('#b-line', '#sheet-lines');
  await tab.goBack();
  await listOnly().catch(() => assert.fail('Back with the Lines sheet open should close it and stay on the list'));
  await open('#b-list-menu', '#sheet-menu');
  await tab.click('#m-how');
  await tab.waitForSelector('#sheet-how:not([hidden])');
  await tab.goBack();
  await listOnly().catch(() => assert.fail('Back with How to play open from Options should close it'));
  await open('#b-how', '#sheet-how');
  await tab.keyboard.press('Escape');
  await listOnly();
  await open('#b-list-menu', '#sheet-menu');
  await tab.click('#sheet-menu .scrim', { position: { x: 20, y: 20 } });
  await listOnly();
  await open('#b-line', '#sheet-lines');
  const during = await tab.evaluate(() => history.length);
  await tab.click('#lines li:nth-child(2) .line-row');
  await listOnly();
  assert.equal(await tab.textContent('#line-name'), LINES[1].name);
  assert.equal(await tab.evaluate(() => history.length), during, 'picking a line should not add a step');
  assert.equal(during, blank + 1, 'a sheet on the list should add one step, no more');
  await open('#b-line', '#sheet-lines');   // a reload with a sheet open opens on the list, and its step goes
  await tab.reload(); await tab.evaluate(() => document.fonts.ready);
  await listOnly().catch(() => assert.fail("a reload with a sheet open should take the sheet's step off"));
  assert.equal(await tab.textContent('#line-name'), LINES[1].name);
  assert.deepEqual(errors, []);
  await tab.goBack();
  assert.equal(tab.url(), 'about:blank', 'one Back from the list should leave the game');
  await other.close();
}

// Back on the list shows the puzzle just left, by the back arrow or the browser's Back, even when it was opened by
// Continue from the top of the list or reached by Next puzzle, and the focus is on its row. Opening a puzzle puts the
// focus on the map. A reload on a puzzle opens the list there too.
{
  const games = Object.fromEntries(PUZZLES.slice(0, 39).map(q => [q.id, finished(q)]));
  const q = PUZZLES[39];
  games[q.id] = { found: q.lines.map((_, k) => k).slice(1), detours: [] };
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  const inView = n => tab.evaluate(n => { const r = document.querySelector(`#route li:nth-child(${n})`).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, n);
  const focus = () => tab.evaluate(() => { const a = document.activeElement; return a.classList.contains('row') ? `row ${[...document.getElementById('route').children].indexOf(a.parentNode) + 1}` : a.id || a.tagName; });
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#where'), 'Main, No. 40');
  assert.equal(await focus(), 'board', 'the map should have the focus once a puzzle opens');
  await tab.click('#b-back');
  assert.equal(await inView(40), true, 'Back to the list should show the puzzle just left');
  assert.equal(await focus(), 'row 40', 'Back to the list should put the focus on the puzzle just left');
  await tab.evaluate(() => { document.querySelector('#s-list .list-scroll').scrollTop = 0; });
  await tab.click('#b-continue');
  await drag(tab, q.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  await tab.click('#b-done-next');
  assert.equal(await tab.textContent('#where'), 'Main, No. 41');
  assert.equal(await focus(), 'board', 'Next puzzle should put the focus on the map');
  await tab.goBack();
  await tab.waitForSelector('#s-list:not([hidden])');
  assert.equal(await inView(41), true, 'Back after Next puzzle should show the puzzle just left');
  assert.equal(await focus(), 'row 41', "the browser's Back should put the focus on the puzzle just left");
  const top = await tab.evaluate(() => document.querySelector('#s-list .list-scroll').scrollTop);
  await tab.focus('#route li:nth-child(41) .row');
  await tab.keyboard.press('Enter');
  assert.equal(await focus(), 'board', 'opening a row by keyboard should put the focus on the map');
  await tab.click('#b-back');
  assert.equal(await tab.evaluate(() => document.querySelector('#s-list .list-scroll').scrollTop), top, 'a row already in sight should stay put');
  await tab.evaluate(() => { document.querySelector('#s-list .list-scroll').scrollTop = 0; });
  await tab.click('#route li:nth-child(40) .row');
  await tab.reload(); await tab.evaluate(() => document.fonts.ready);
  await tab.waitForSelector('#s-list:not([hidden])');
  assert.deepEqual([await inView(40), await focus()], [true, 'row 40'], 'a reload on a puzzle should open the list at that puzzle');
  assert.deepEqual(errors, []);
  await other.close();
}

// Erasing, from Options on the list, says it's every line's progress that goes, and takes two taps.
if (LINES.length > 1) {
  const [a, b] = [LINES[0].puzzles[0], LINES[1].puzzles[0]];
  const { other, tab, errors } = await visitor({ options: { line: LINES[1].id }, best: { [a.id]: 1000 }, games: { [a.id]: finished(a), [b.id]: finished(b) } });
  await tab.click('#b-list-menu');
  assert.equal(await tab.textContent('#m-erase'), 'Erase progress on every line');
  await tab.click('#m-erase');
  assert.equal(await tab.textContent('#m-erase'), 'Tap again to erase every line');
  await tab.keyboard.press('Escape');
  await tab.click('#b-list-menu');
  assert.equal(await tab.textContent('#m-erase'), 'Erase progress on every line', 'closing the sheet should disarm the button');
  await tab.click('#m-erase'); await tab.click('#m-erase');
  assert.equal(await tab.textContent('#toast'), 'Progress erased on every line');
  assert.deepEqual(await tab.evaluate(() => { const s = JSON.parse(localStorage.getItem('crosstown.v1')); return [s.games, s.best]; }), [{}, {}]);
  assert.equal(await tab.locator('#route li.done').count(), 0);
  assert.deepEqual(errors, []);
  await other.close();
}

// A Back that comes in the middle of a drag (the browser's button, or a mouse's back button with the other one
// still down) goes to the list, and letting go afterwards does nothing: no error, and no half-traced word kept.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} });
  await tab.click('#route li:nth-child(1) .row');
  const box = await tab.locator('#board').boundingBox();
  const at = i => [box.x + (i % 6 + 0.5) * box.width / 6, box.y + (Math.floor(i / 6) + 0.5) * box.height / 8];
  await tab.mouse.move(...at(p.lines[1][0]));
  await tab.mouse.down();
  for (const i of p.lines[1].slice(1, 3)) await tab.mouse.move(...at(i), { steps: 3 });
  await tab.goBack();
  await tab.waitForFunction(() => !document.getElementById('s-list').hidden, null, { timeout: 5000 });
  await tab.mouse.up();
  await tab.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(errors, [], 'letting go after a Back in the middle of a drag');
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-sub'), `${p.lines.length} lines`, 'a word cut off by Back should not count');
  await tab.click('#route li:nth-child(1) .row');
  await drag(tab, p.lines[1]);
  assert.equal(await tab.textContent('#count'), `1 of ${p.lines.length} lines`, 'the next drag should trace as usual');
  await other.close();
}

// Touch: a touch the browser takes back (a system gesture, palm rejection) leaves nothing half traced, and a second
// finger resting on the map while one traces doesn't take the word over.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await tab.click('#b-continue');
  const box = await tab.locator('#board').boundingBox();
  const at = (i, id = 0) => ({ x: box.x + (i % 6 + 0.5) * box.width / 6, y: box.y + (Math.floor(i / 6) + 0.5) * box.height / 8, id });
  const cdp = await other.newCDPSession(tab);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const [a, b, c] = p.lines[1];
  await touch('touchStart', [at(a)]);
  await touch('touchMove', [at(b)]);
  await touch('touchMove', [at(c)]);
  await touch('touchCancel', []);
  await tab.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual([await tab.locator('#board .stop.sel').count(), await tab.locator('#board .trace').count(), await tab.textContent('#readout')], [0, 0, ''], 'a cancelled touch left a word half traced');

  const resting = p.lines[3].at(-1);
  const [first, ...rest] = p.lines[1];
  await touch('touchStart', [at(first)]);
  await touch('touchStart', [at(first), at(resting, 1)]);
  for (const i of rest) await touch('touchMove', [at(i), at(resting, 1)]);
  await touch('touchEnd', []);
  assert.equal(await tab.textContent('#count'), `1 of ${p.lines.length} lines`, 'a second finger on the map lost the word being traced');
  assert.equal(await tab.textContent('#readout'), words[1]);
  assert.deepEqual(errors, []);
  await other.close();
}

// A line's detours that can't be loaded (a first visit on a weak signal, before the offline copy is in) don't make a
// real detour "Not a word on this map": the readout says they can't be checked, and the next word asks for them
// again, so once they come the same puzzle counts it.
{
  server.refuse = 'js/detours/main.js';
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { serviceWorkers: 'block' });
  await tab.click('#b-continue');
  await drag(tab, first.path);
  await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
  assert.equal(await tab.textContent('#readout'), "Can't check detours right now. Try that word again in a moment");
  assert.equal(await tab.locator('#pips .full').count(), 0);
  server.refuse = null;
  await drag(tab, first.path);
  await tab.waitForFunction(() => document.getElementById('readout').textContent.startsWith('Detour:'), null, { timeout: 8000 })
    .catch(async () => assert.fail(`a detour once its file could load read "${await tab.textContent('#readout')}"`));
  assert.equal(await tab.locator('#pips .full').count(), fareFor(first.word) % FARE_PER_TOKEN);
  assert.deepEqual(errors, []);
  await other.close();
}

// Words traced while a line's detours are on their way count together when they come, and the best news shows: a
// detour then a word that isn't one still says the detour. A detour still waiting when Back is pressed counts in the
// game that was left.
{
  server.slow = { path: 'js/detours/main.js', ms: 2500 };
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { serviceWorkers: 'block' });
  await tab.click('#b-continue');
  await drag(tab, first.path);
  assert.equal(await tab.textContent('#readout'), 'One moment');
  await drag(tab, junk);
  await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
  assert.match(await tab.textContent('#readout'), new RegExp(`^Detour: ${first.word}, \\+${fareFor(first.word)} fare`), 'a word that is not one buried the detour before it');
  assert.equal(await tab.locator('#pips .full').count(), fareFor(first.word) % FARE_PER_TOKEN);
  await tab.click('#b-back');
  await tab.evaluate(() => localStorage.clear());
  await tab.reload();
  await tab.click('#b-continue');
  await drag(tab, first.path);
  await tab.click('#b-back');
  await tab.waitForFunction(id => JSON.parse(localStorage.getItem('crosstown.v1'))?.games?.[id]?.detours?.length === 1, p.id, { timeout: 8000 })
    .catch(() => assert.fail('a detour still waiting at Back was dropped'));
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-sub'), `0 of ${p.lines.length} lines found`, 'the list should show the game the detour started');
  server.slow = null;
  assert.deepEqual(errors, []);
  await other.close();
}

// The lines: the list shows one at a time, the button above Continue changes it, and each line keeps its own
// numbers and progress. Seeded as Mark has it: every Main Line puzzle finished.
if (LINES.length > 1) {
  const [main, second] = LINES;
  const games = Object.fromEntries(main.puzzles.map(q => [q.id, finished(q)]));
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  assert.equal(await tab.textContent('#line-name'), main.name);
  assert.equal(await tab.textContent('#tally'), `${main.puzzles.length} of ${main.puzzles.length} finished, ${main.puzzles.length * 3} of ${main.puzzles.length * 3} stars`);
  assert.equal(await tab.textContent('#b-continue'), `On to ${second.name.replace(/ Line$/, '')}`, 'a finished line should offer the next one');
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#line-name'), second.name);
  assert.equal(await tab.locator('#route li').count(), second.puzzles.length);
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-clue'), second.puzzles[0].clue);
  assert.equal(await tab.textContent('#b-continue'), 'Play No. 1');
  assert.equal(await tab.textContent('#tally'), `${second.puzzles.length} puzzles`);
  await tab.reload(); await tab.evaluate(() => document.fonts.ready);
  assert.equal(await tab.textContent('#line-name'), second.name, 'the line on show should be kept over a reload');

  // The Lines sheet: every line, the one on show marked, how far along each is and the stars, and the total.
  const n = main.puzzles.length, all = LINES.reduce((t, l) => t + l.puzzles.length, 0);
  assert.equal(await tab.getAttribute('#b-line', 'aria-label'), `${second.name}: ${second.about}. Change line`);
  await tab.click('#b-line');
  await tab.waitForSelector('#sheet-lines:not([hidden])');
  assert.equal(await tab.locator('#lines .line-row').count(), LINES.length);
  assert.equal(await tab.getAttribute('#lines li:nth-child(2) .line-row', 'aria-current'), 'true');
  assert.equal(await tab.evaluate(() => document.activeElement.getAttribute('aria-current')), 'true', 'the Lines sheet should start on the line on show');
  assert.equal(await tab.textContent('#lines li:nth-child(1) .line-prog'), `${n} of ${n}${n * 3}★`);   // with a dot drawn between
  assert.equal(await tab.getAttribute('#lines li:nth-child(1) .line-row', 'aria-label'), `${main.name}: ${main.about}. ${n} of ${n} finished, ${n * 3} stars`);
  assert.equal(await tab.textContent('#lines li:nth-child(2) .line-prog'), `${second.puzzles.length} puzzles`);
  assert.equal(await tab.textContent('#lines-note'), `Each line is its own set of puzzles. Your progress on every line is kept: ${n} of ${all} finished.`);
  await tab.click('#lines li:nth-child(1) .line-row');
  await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
  assert.deepEqual(await tab.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-label')]), ['b-line', `${main.name}: ${main.about}. Change line`], 'focus should come back to the line button, naming the new line');
  assert.equal(await tab.locator('#route li').count(), main.puzzles.length);
  assert.equal(await tab.locator('#route li.done').count(), main.puzzles.length, 'nothing finished on the Main Line should be lost');
  await tab.click('#b-line'); await tab.click('#lines li:nth-child(2) .line-row');

  // A puzzle on the second line: its number counts along the line, and its detours (loaded with the line) earn fare.
  const q = second.puzzles[0];
  const { DETOURS } = await import(`../js/detours/${second.id}.js`);
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#where'), `${second.name.replace(/ Line$/, '')}, No. 1`);
  const own = new Set(q.lines.flat());
  const d = DETOURS[q.id].split(' ').map(w => [w, traces(q.grid, w.toUpperCase(), 1)[0]]).find(([, t]) => t);
  assert.ok(own.size === 48 && d, 'the puzzle should have a traceable detour');
  await drag(tab, d[1]);
  assert.match(await tab.textContent('#readout'), new RegExp(`^Detour: ${d[0]}, \\+${fareFor(d[0])} fare`));
  await drag(tab, q.lines[0]);
  assert.equal(await tab.textContent('#readout'), `Crosstown: ${q.name}`);

  // Back to the list, over to the Main Line.
  await tab.goBack();
  await tab.waitForSelector('#s-list:not([hidden])');
  await tab.click('#b-line');
  assert.equal(await tab.textContent('#lines li:nth-child(2) .line-prog'), 'Under way', 'a line with a puzzle started should say so');
  await tab.click('#lines li:nth-child(1) .line-row');
  assert.equal(await tab.textContent('#line-name'), main.name);
  // A finished Main Line map, Back, on to the second line by the big button, then Forward: the map opens again, on its
  // own line's list.
  await tab.click('#route li:nth-child(5) .row');
  await tab.goBack();
  await tab.waitForSelector('#s-list:not([hidden])');
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#line-name'), second.name);
  assert.equal(await tab.textContent('#route li:nth-child(1) .row-sub'), `1 of ${q.lines.length} lines found`);
  await tab.goForward();
  await tab.waitForSelector('#s-play:not([hidden])');
  assert.equal(await tab.textContent('#clue'), main.puzzles[4].clue);
  await tab.click('#b-back');
  assert.equal(await tab.textContent('#line-name'), main.name, 'Forward to a puzzle on another line should bring its list');
  assert.deepEqual(errors, []);
  await other.close();

  // On a small phone the line on show can be below the sheet's fold: it's scrolled into view with the focus on it.
  const small = await visitor({ options: { line: LINES.at(-1).id }, best: {}, games: {} }, { viewport: { width: 320, height: 568 } });
  await small.tab.click('#b-line');
  await small.tab.waitForSelector('#sheet-lines:not([hidden])');
  const seen = await small.tab.evaluate(async () => {
    await Promise.all(document.getAnimations().map(x => x.finished));   // the sheet rises into place
    const a = document.activeElement, r = a.getBoundingClientRect(), panel = document.querySelector('#sheet-lines .panel').getBoundingClientRect();
    return { current: a.getAttribute('aria-current'), inView: r.top >= panel.top && r.bottom <= Math.min(panel.bottom, innerHeight) };
  });
  assert.deepEqual(seen, { current: 'true', inView: true }, 'the line on show should be focused and in view in the Lines sheet');
  assert.deepEqual(small.errors, []);
  await small.other.close();

  // A line that's gone (or a damaged option) falls back to the first one.
  const gone = await visitor({ options: { line: 'no-such-line' }, best: {}, games: {} });
  assert.equal(await gone.tab.textContent('#line-name'), main.name);
  assert.equal(await gone.tab.locator('#route li').count(), main.puzzles.length);
  assert.deepEqual(gone.errors, []);
  await gone.other.close();
}

// The last puzzle on a line: the done sheet says the line is finished, with its tally, and offers the next line. That
// opens the next line's first puzzle in place of this one, so Back goes to the new line's list.
if (LINES.length > 2) {
  const [, second, third] = LINES, last = second.puzzles.at(-1), total = second.puzzles.length;
  const games = Object.fromEntries(second.puzzles.slice(0, -1).map(q => [q.id, finished(q)]));
  games[last.id] = { found: last.lines.map((_, k) => k).slice(1), detours: [] };
  const { other, tab, errors } = await visitor({ options: { line: second.id }, best: {}, games });
  const left = await tab.evaluate(() => history.length);
  await tab.click('#b-continue');
  await drag(tab, last.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.textContent('#sheet-done .eyebrow'), `${second.name} finished`);
  assert.equal(await tab.textContent('#done-line'), `${second.name}: ${total} of ${total}, ${total * 3 - 1} of ${total * 3} stars`);
  assert.deepEqual([await tab.evaluate(() => document.activeElement.id), await tab.textContent('#b-done-next')], ['b-done-next', `On to the ${third.name}`], 'a finished line should offer the next one');
  await tab.keyboard.press('Escape');
  assert.equal(await tab.textContent('#b-next'), `On to ${third.name.replace(/ Line$/, '')}`, "the map's Next should offer the next line too");
  await tab.setViewportSize({ width: 320, height: 568 });
  await tab.evaluate(() => { document.getElementById('b-next').textContent = 'On to University'; });   // the longest
  assert.ok((await tab.locator('#b-next').boundingBox()).height <= 44.5, "the map's Next wraps at 320 px");
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.click('#b-results');
  await tab.click('#b-done-next');
  assert.equal(await tab.textContent('#where'), `${third.name.replace(/ Line$/, '')}, No. 1`);
  assert.equal(await tab.textContent('#clue'), third.puzzles[0].clue);
  assert.equal(await tab.evaluate(() => history.length), left + 1, 'going on to the next line should not add a step');
  await tab.goBack();
  await tab.waitForSelector('#s-list:not([hidden])');
  assert.equal(await tab.textContent('#line-name'), third.name, "Back should go to the new line's list");
  assert.deepEqual(errors, []);
  await other.close();
}

// A finished roundel's number is text, so on every line, in either palette, it needs 4.5:1 against the roundel.
if (LINES.length > 1) {
  const games = Object.fromEntries(LINES.map(l => [l.puzzles[0].id, finished(l.puzzles[0])]));
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  for (const [n, l] of LINES.entries()) {
    await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${n + 1}) .line-row`);
    for (const colorScheme of ['light', 'dark']) {
      await tab.emulateMedia({ colorScheme });
      const roundel = await tab.evaluate(() => { const s = getComputedStyle(document.querySelector('#route li.done .roundel')); return { color: s.color, bg: s.backgroundColor }; });
      assert.ok(contrast(roundel.color, roundel.bg) >= 4.5, `a finished roundel's number on the ${l.name} is hard to read in ${colorScheme}: ${JSON.stringify(roundel)}`);
    }
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// Before the script has run, the list's top already looks as it will: the line card in its place, so nothing jumps
// when it fills in, and the big button off, so a tap on it can't go nowhere.
if (LINES.length > 1) {
  const tops = async script => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const tab = await context.newPage();
    if (!script) await tab.route('**/js/app.js', () => {});   // the script never comes
    await tab.goto(base, { waitUntil: script ? 'load' : 'commit' });
    await tab.waitForSelector('#b-continue'); await tab.evaluate(() => document.fonts.ready);
    const at = await tab.evaluate(() => ({ continue: Math.round(document.getElementById('b-continue').getBoundingClientRect().top), disabled: document.getElementById('b-continue').disabled, about: document.getElementById('line-about').textContent }));
    await context.close();
    return at;
  };
  const [before, after] = [await tops(false), await tops(true)];
  assert.deepEqual([before.continue, before.disabled, before.about], [after.continue, true, LINES[0].about], `the list's top moves or offers a dead button before the script runs: ${JSON.stringify({ before, after })}`);
  assert.equal(after.disabled, false);
}

// One sitting of four puzzles across two lines, with no reload, moving on by Next puzzle, by on to the next line and
// by the map's Next. One spends tokens, one is left by Back halfway and resumed. Each one has to end clean: nothing
// half traced or still held, no hint carried into the next, the clock stopped on screen and in the save, the fare in
// the save adding up to the fare its detours earned, the done sheet's stars the save's, and the map no bigger.
if (LINES.length > 2) {
  const [x, y] = [LINES[1], LINES[2]];
  const games = Object.fromEntries(x.puzzles.slice(0, -2).map(q => [q.id, finished(q)]));
  const { other, tab, errors } = await visitor({ options: { line: x.id, clock: true }, best: {}, games });
  const savedGame = id => tab.evaluate(id => JSON.parse(localStorage.getItem('crosstown.v1')).games[id], id);
  const board = () => tab.evaluate(() => ({ size: document.querySelectorAll('#board *').length, marks: document.querySelectorAll('#board .sel, #board .trace, #board .hint, #board .guide').length }));
  const sitting = [[x, x.puzzles.length - 2, 'tokens', 'next'], [x, x.puzzles.length - 1, 'back', 'on'], [y, 0, '', 'map'], [y, 1, '', 'end']];
  let size = 0;
  await tab.click('#b-continue');
  for (const [l, n, style, move] of sitting) {
    const q = l.puzzles[n], tag = `${l.name} No. ${n + 1}`;
    assert.equal(await tab.textContent('#where'), `${l.name.replace(/ Line$/, '')}, No. ${n + 1}`);
    const opened = await board();
    size ||= opened.size;
    assert.deepEqual(opened, { size, marks: 0 }, `${tag} opened with marks on the map, or a bigger map, than the first`);
    const [a, b] = [q.lines[1][0], q.lines[1][1]];
    const box = await tab.locator('#board').boundingBox(), at = i => [box.x + (i % 6 + 0.5) * box.width / 6, box.y + (Math.floor(i / 6) + 0.5) * box.height / 8];
    await tab.mouse.move(...at(a)); await tab.mouse.move(...at(b), { steps: 3 });
    assert.equal((await board()).marks, 0, `${tag}: a move with no button down traced something, so a drag was held`);
    let earned = 0;
    if (style === 'tokens') {
      const { DETOURS } = await import(`../js/detours/${l.id}.js`);
      const ds = DETOURS[q.id].split(' ').map(w => [w, traces(q.grid, w.toUpperCase(), 1)[0]]).filter(([, t]) => t);
      while (earned < 2 * FARE_PER_TOKEN) {
        const [w, t] = ds.shift();
        await drag(tab, t);
        await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
        if ((await tab.textContent('#readout')).startsWith(`Detour: ${w},`)) earned += fareFor(w);
      }
      await tab.click('#b-token'); await tab.click('#b-token');
      assert.equal(await tab.locator('#board .guide').count(), 1);
    }
    for (const [j, k] of q.lines.map((_, k) => k).entries()) {
      if (style === 'back' && j === 2) {
        await tap(tab, q.lines[k][0]); await tap(tab, q.lines[k][1]);
        await tab.click('#b-back');
        assert.equal(await tab.textContent('#b-continue'), `Resume No. ${n + 1}`);
        await tab.click('#b-continue');
        assert.equal((await board()).marks, 0, `${tag}: a half-traced word came back with Resume`);
      }
      await drag(tab, q.lines[k]);
    }
    await tab.waitForSelector('#sheet-done:not([hidden])');
    const end = await tab.evaluate(() => ({ clock: document.getElementById('clock').textContent, stars: document.querySelectorAll('#done-stars .got').length, marks: document.querySelectorAll('#board .sel, #board .trace, #board .hint, #board .guide').length }));
    const g = await savedGame(q.id);
    assert.equal(end.marks, 0, `${tag} ended with marks on the map`);
    assert.ok(g.done && g.hint === null && g.spent === (style === 'tokens' ? 2 : 0), `${tag} was saved unfinished, with a hint or the wrong tokens spent: ${JSON.stringify(g)}`);
    assert.equal(g.fare + FARE_PER_TOKEN * (g.tokens + g.spent), earned, `${tag}: the fare in the save doesn't add up to the ${earned} its detours earned`);
    assert.equal(g.detours.reduce((f, w) => f + fareFor(w), 0), earned);
    assert.equal(end.stars, starsFor(g), `${tag}: the done sheet's stars aren't the save's`);
    await tab.waitForTimeout(1100);
    assert.deepEqual([await tab.textContent('#clock'), (await savedGame(q.id)).ms], [end.clock, g.ms], `${tag}: the clock ran on after the end`);
    if (move === 'next') await tab.click('#b-done-next');
    else if (move === 'on') {
      assert.equal(await tab.textContent('#b-done-next'), `On to the ${y.name}`);
      await tab.click('#b-done-next');
    } else if (move === 'map') {
      await tab.click('#sheet-done .panel [data-close]');
      await tab.waitForTimeout(1100);
      assert.equal(await tab.textContent('#clock'), end.clock, `${tag}: the clock started again on the finished map`);
      assert.equal(await tab.textContent('#b-next'), 'Next puzzle');
      await tab.click('#b-next');
    }
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// It can be installed.
const cdp = await ctx.newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
assert.deepEqual(manifest.errors, []);
assert.match(manifest.data, /"name": "Crosstown"/);
// Installed, it stays upright: held sideways, a phone would leave the map about 144 px wide.
assert.equal(JSON.parse(manifest.data).orientation, 'portrait', 'the installed app should stay in portrait');

// Works offline once it has been opened: with the server dropping every connection, the page, its styles, its
// font and the puzzles still load, from the copy the service worker kept.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
server.down = true;
await page.reload().catch(e => assert.fail(`the page did not load offline: ${e.message.split('\n')[0]}`));
assert.equal(await page.locator('#route li').count(), PUZZLES.length, 'the page did not load offline');
await page.click('#b-continue');
assert.equal(await page.locator('#board .stop').count(), 48, 'a puzzle did not open offline');
assert.deepEqual(await page.evaluate(async () => {
  await document.fonts.ready;
  return { styled: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)', font: [...document.fonts].some(f => f.family.replace(/"/g, '') === 'Overpass' && f.status === 'loaded') };
}), { styled: true, font: true }, 'the styles or the font did not load offline');
// Every line's detours are in the copy, and count offline.
for (const [n, l] of LINES.entries()) {
  await page.click('#b-back');
  await page.click('#b-line'); await page.click(`#lines li:nth-child(${n + 1}) .line-row`);
  await page.click('#b-continue');
  const q = l.puzzles[Number((await text('#where')).match(/No\. (\d+)$/)[1]) - 1];
  const on = await page.evaluate(() => [...document.querySelectorAll('#board .stop')].flatMap((s, i) => (s.classList.contains('on') ? [i] : [])));
  const d = await detourOn(q, 4, on);
  await drag(page, d.path);
  await page.waitForFunction(() => document.getElementById('readout').textContent.startsWith('Detour:'), null, { timeout: 5000 })
    .catch(async () => assert.fail(`a detour on the ${l.name} offline read "${await text('#readout')}"`));
}
server.down = false;

assert.deepEqual(problems.filter(x => !x.startsWith('failed:')), [], 'problems while using it');
// Offline, checked the junkdrawer house kit's way, from a server that answers like GitHub Pages: a browser may keep
// each file for ten minutes, and asks again by its ETag. `net` is the connection: 'up', 'down' (the server drops every
// connection) or 'stalled' (a plane's or a train's wifi: it takes each request and holds on to it). With `release`
// set it serves the next release. The server's own switches are needed because the browser's offline switch can't
// make a stall, and in some Chromium builds it doesn't stop the service worker's own requests. `drop` names a file the
// server doesn't answer (the connection goes as it's asked for), counted in `dropped`.
{
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  let net = 'up', release = '', drop = '', dropped = 0;
  const held = [];
  const server = createServer((req, res) => {
    if (net === 'down') { req.socket.destroy(); return; }
    if (net === 'stalled') { held.push([req, res]); return; }
    if (drop && req.url.startsWith(drop)) { dropped++; req.socket.destroy(); return; }
    serve(req, res);
  }).listen(0);
  async function serve(req, res) {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    let body;
    try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
    if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, `const FILES = '${release}'`));
    if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from(`<!-- release ${release} -->\n`)]);
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
    res.writeHead(200, head);
    res.end(body);
  }
  const base = `http://localhost:${server.address().port}/`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  const title = await page.title();

  // Works offline once it has been opened.
  net = 'down';
  await ctx.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), title, 'the page did not open offline');
  await ctx.setOffline(false);

  // On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
  // the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
  net = 'stalled';
  const t0 = Date.now();
  await page.reload({ timeout: 10000 }).catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
  assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);

  // A line's detours load while the game is open (when the line is shown), so a connection that stalls after the page
  // has opened from the network would leave every detour traced on that line waiting. They come from the copy after
  // the worker's few seconds' wait too.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  net = 'stalled';
  const q = LINES[1].puzzles[0], d = await detourOn(q);
  await page.click('#b-line'); await page.click('#lines li:nth-child(2) .line-row');
  await page.click('#b-continue');
  await drag(page, d.path);
  await page.waitForFunction(() => document.getElementById('readout').textContent.startsWith('Detour:'), null, { timeout: 8000 })
    .catch(async () => assert.fail(`a detour on a stalled connection read "${await page.textContent('#readout')}" after 8 s`));
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);
  await page.click('#b-back');

  // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
  // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
  const copyOf = () => page.evaluate(async () => (await (await caches.match('index.html'))?.text())?.match(/<!-- release (\w+) -->/)?.[1]);
  release = 'next';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  for (const end = Date.now() + 10000; await copyOf() !== 'next';) {
    assert.ok(Date.now() < end, "the new release's offline copy kept the old index.html");
    await new Promise(r => setTimeout(r, 100));
  }

  // A release whose copy is cut short (here one line's detours don't come) leaves the copy from before whole, and is
  // tried again as the signal comes back, without another page load.
  release = 'after'; drop = '/js/detours/park.js';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  for (const end = Date.now() + 10000; !dropped;) { assert.ok(Date.now() < end, 'the next release was not asked for'); await new Promise(r => setTimeout(r, 100)); }
  await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !r.installing && !r.waiting; });
  // Meanwhile the game fetches a file of the next release from the network: it isn't kept beside the copy's older ones.
  assert.equal(await page.evaluate(async () => (await (await fetch('index.html')).text()).includes('<!-- release after -->')), true);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await copyOf(), 'next', 'a copy cut short should leave the one from before as it was');
  drop = '';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (const end = Date.now() + 10000; await copyOf() !== 'after';) {
    assert.ok(Date.now() < end, 'a copy cut short was not made again when the signal came back');
    await new Promise(r => setTimeout(r, 100));
  }
  const inCopy = await page.evaluate(async lines => (await Promise.all(lines.map(l => caches.match(`js/detours/${l}.js`)))).filter(Boolean).length, LINES.map(l => l.id));
  assert.equal(inCopy, LINES.length, 'every line\'s detours should be in the offline copy');
  assert.deepEqual(problems, [], 'problems while offline or on a stalled connection');
  await ctx.close();
  server.close();

  // sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js
  // is a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
  // index.html; the first 8 hex of the sha1 of those).
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
  const all = createHash('sha1');
  for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
  const files = all.digest('hex').slice(0, 8);
  assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
}

// The one-file copy (npm run build) plays from a file on its own: another line's detours are in it too, and nothing
// is asked of any server.
{
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'crosstown-build-'));
  try {
    execFileSync(process.execPath, ['scripts/build.mjs', dir], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
    const file = pathToFileURL(join(dir, 'crosstown.html')).href;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const tab = await ctx.newPage();
    const asked = [], errors = [];
    tab.on('request', r => { if (r.url() !== file && !r.url().startsWith('data:')) asked.push(r.url()); });
    tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(file);
    const l = LINES.at(-1), q = l.puzzles[0], d = await detourOn(q);
    await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${LINES.length}) .line-row`);
    await tab.click('#b-continue');
    assert.equal(await tab.textContent('#clue'), q.clue);
    await drag(tab, d.path);
    await tab.waitForFunction(() => document.getElementById('readout').textContent.startsWith('Detour:'), null, { timeout: 5000 })
      .catch(async () => assert.fail(`a detour in the one-file copy read "${await tab.textContent('#readout')}"`));
    assert.deepEqual(asked, [], 'the one-file copy asked for something besides itself');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
}

await browser.close();
server.close();
console.log('all good');
