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
// A row is read with its number as the screen shows it elsewhere, "No. 1".
assert.equal(await text('#route li:first-child .roundel'), 'No. 1');
// The puzzle the big button plays is marked on the route as the next stop, its roundel ringed in the line's colour.
assert.deepEqual(await page.$$eval('#route li.next', l => l.map(x => [[...x.parentNode.children].indexOf(x), x.querySelector('.row-go').textContent])), [[0, 'Next stop']]);
assert.equal(await page.evaluate(() => { const r = getComputedStyle(document.querySelector('#route li.next .roundel')), o = getComputedStyle(document.querySelector('#route li:nth-child(2) .roundel')); return r.borderTopColor !== o.borderTopColor && r.color !== o.color; }), true, 'the next stop should look unlike the stops after it');
// The toast stays where screen readers can hear it, shown only by a class, so a message is heard as it arrives.
assert.deepEqual(await page.evaluate(() => { const t = document.getElementById('toast'), s = getComputedStyle(t); return [t.hidden, s.display === 'none', s.visibility, s.opacity, t.getAttribute('role')]; }), [false, false, 'visible', '0', 'status']);

// Open the first one. Nothing found yet, no tokens. On a first visit the readout says how to trace, in a note that
// fits it without moving the map.
await page.click('#b-continue');
const HOW = 'Drag across the letters to trace a word, or tap them and tap the last one again';
const TOO_SHORT = 'Too short: words have 4 letters or more';
assert.equal(await text('#readout'), HOW);
for (const [width, height] of [[320, 568], [390, 844]]) {
  await page.setViewportSize({ width, height });
  assert.equal(await page.evaluate(() => { const r = document.getElementById('readout'); return r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5; }), true, `the first visit's note is taller than the readout at ${width} px`);
}
assert.equal(await text('#clue'), p.clue);
// A clue that wraps on the sign isn't left with a stub over a longer line ("It’s in" over "here somewhere" at 360 px).
await page.setViewportSize({ width: 360, height: 740 });
const clueLines = await page.evaluate(() => {
  const t = document.getElementById('clue').firstChild, r = document.createRange(), lines = [];
  for (let i = 0; i < t.length; i++) {
    r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect();
    if (!lines.length || b.top > lines.at(-1).top + 3) lines.push({ top: b.top, left: b.left, right: b.right }); else lines.at(-1).right = b.right;
  }
  return lines.map(l => l.right - l.left);
});
assert.ok(clueLines.every((w, k) => k === clueLines.length - 1 || w >= 0.55 * clueLines[k + 1]), `the clue "${p.clue}" wraps lopsided at 360 px: ${clueLines}`);
await page.setViewportSize({ width: 390, height: 844 });
assert.equal(await text('#count'), `0 of ${p.lines.length} lines`);
// Beside the count, the three stars still in reach: all three at the start, each going dim the moment it's lost.
const signStars = () => page.$$eval('#sign-stars svg', l => l.map(s => !s.classList.contains('lost')));
assert.deepEqual([await signStars(), await page.getAttribute('#sign-stars', 'aria-label')], [[true, true, true], '3 of 3 stars still in reach']);
// They sit beside the count (over it on a narrow phone, so the clue keeps its width), inside the sign, gold that shows
// on it, and an outline once lost, in either palette.
for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[320, 568], [390, 844]]) {
  await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height });
  const look = await page.evaluate(() => {
    const st = document.getElementById('sign-stars'), c = document.getElementById('count'), sign = document.querySelector('.sign').getBoundingClientRect();
    const a = st.getBoundingClientRect(), b = c.getBoundingClientRect();
    const beside = Math.abs((a.top + a.bottom) - (b.top + b.bottom)) < 4 && a.right <= b.left, over = a.bottom <= b.top + 1 && Math.abs(a.right - b.right) < 1;
    return { oneLine: innerWidth >= 375 ? beside : over, inside: a.left >= sign.left && b.right <= sign.right,
      fill: getComputedStyle(st.querySelector('svg')).fill, bg: getComputedStyle(document.querySelector('.sign')).backgroundColor };
  });
  assert.deepEqual([look.oneLine, look.inside], [true, true], `the sign's stars should sit beside the count (over it under 375 px) at ${width} px in ${colorScheme}`);
  assert.ok(contrast(look.fill, look.bg) >= 3, `the sign's stars are hard to see in ${colorScheme}: ${JSON.stringify(look)}`);
}
await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 390, height: 844 });
assert.equal(await page.locator('#board .stop').count(), 48);
assert.equal(await page.isDisabled('#b-token'), true);
// With no tokens the button is off but still says, when tapped, how to get one; the meter, tapped, gives the count.
// Both notes fit the readout without moving the map, on a small phone too.
const NO_TOKENS = `No tokens yet. Detours, words that aren’t lines, earn fare: ${FARE_PER_TOKEN} fare is a token`;
await page.click('#b-token', { force: true });
assert.equal(await text('#readout'), NO_TOKENS, 'a tap on the token button with none should say how fare works');
for (const [width, height] of [[320, 568], [390, 844]]) {
  await page.setViewportSize({ width, height });
  assert.equal(await page.evaluate(() => { const r = document.getElementById('readout'); return r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5; }), true, `the note on tokens is taller than the readout at ${width} px`);
}
assert.equal(await text('#token-label'), 'No tokens');
await page.click('#meter');
assert.equal(await text('#readout'), `0 of ${FARE_PER_TOKEN} fare to the next token. No detours so far`, 'a tap on the fare meter should give the count');
for (const [width, height] of [[320, 568], [390, 844]]) {
  await page.setViewportSize({ width, height });
  assert.equal(await page.evaluate(() => { const r = document.getElementById('readout'); return r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5; }), true, `the fare meter's note is taller than the readout at ${width} px`);
}
assert.equal(await page.evaluate(() => document.getElementById('meter').tagName), 'BUTTON');

// Drag out one line, tap out another. A stray tap just before, beside where the drag starts, stays out of its word.
const stray = NEIGHBORS[p.lines[2][0]].find(j => !p.lines[2].includes(j));
assert.ok(stray !== undefined, 'no stop beside the line to tap by mistake');
await tap(page, stray);
await drag(page, p.lines[2]);
assert.equal(await text('#count'), `1 of ${p.lines.length} lines`, 'a stray tap ended up in front of the dragged word');
// Another line found before the Crosstown: that star goes dim, and the others stay.
assert.deepEqual([await signStars(), await page.getAttribute('#sign-stars', 'aria-label')], [[true, true, false], '2 of 3 stars still in reach'], 'a line found before the Crosstown should dim its star');
// A found word is heard as found, with the count, in words kept off the screen.
assert.equal(await text('#readout'), `${words[2]}, found. 1 of ${p.lines.length} lines`);
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#readout .sr-only')].map(s => s.getBoundingClientRect().width <= 1)), [true], 'what the readout says after a found word should not show');
assert.equal(await page.locator('#board .stop.on.c2').count(), p.lines[2].length);
await tapOut(page, p.lines[4]);
assert.equal(await text('#count'), `2 of ${p.lines.length} lines`);

// The same word spelled backwards is not the line.
await drag(page, p.lines[1].slice().reverse());
assert.equal(await text('#count'), `2 of ${p.lines.length} lines`);

// Too short, and not a word.
await drag(page, p.lines[1].slice(0, 3));
assert.equal(await text('#readout'), TOO_SHORT);
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
assert.match(await text('#readout'), new RegExp(`^Detour: ${first.word.toUpperCase()}, \\+${fareFor(first.word)} fare`));
// The first detour ever says what fare buys, once; the first token ever, how to spend it (only that, if it's both).
const FARE_TIP = `. Every ${FARE_PER_TOKEN} fare buys a token, a hint`, TOKEN_TIP = '. Tap Use a token for a hint';
let toldToken = fareFor(first.word) >= FARE_PER_TOKEN, toldFare = !toldToken;
assert.ok((await text('#readout')).endsWith(toldToken ? `Token earned${TOKEN_TIP}` : `fare${FARE_TIP}`), 'the first detour ever should say what fare buys');
let fare = fareFor(first.word);
assert.equal(await page.locator('#pips .full').count(), fare % FARE_PER_TOKEN);
await page.click('#meter');
assert.equal(await text('#readout'), `${fare % FARE_PER_TOKEN} of ${FARE_PER_TOKEN} fare to the next token. 1 detour so far`, 'a tap on the fare meter should give the detours so far too');
await drag(page, first.path);
assert.equal(await text('#readout'), `${first.word.toUpperCase()} already counted`, 'a detour should be in capitals whether new or counted already');

// Enough detours for two tokens.
const used = new Set([first.word]);
while (fare < FARE_PER_TOKEN * 2) {
  const d = detour([2, 4], 6, used), before = Math.floor(fare / FARE_PER_TOKEN);
  used.add(d.word); await drag(page, d.path); fare += fareFor(d.word);
  const said = await text('#readout');
  const tip = !toldToken && Math.floor(fare / FARE_PER_TOKEN) > before ? `Token earned${TOKEN_TIP}` : !toldFare ? FARE_TIP : '';
  if (tip) assert.ok(said.endsWith(tip), `the first token ever should say how to spend it, and the first detour what fare buys: ${said}`);
  else assert.ok(!said.endsWith(TOKEN_TIP) && !said.endsWith(FARE_TIP), `each tip should show once: ${said}`);
  if (tip === FARE_TIP) toldFare = true; else if (tip) toldToken = true;
}
assert.equal(await text('#token-label'), `Use a token (${Math.floor(fare / FARE_PER_TOKEN)})`);

// The first token rings a line's stops; the second draws its route. The first dims the star for no tokens.
assert.deepEqual(await signStars(), [true, true, false]);
await page.click('#b-token');
assert.deepEqual([await signStars(), await page.getAttribute('#sign-stars', 'aria-label')], [[true, false, false], '1 of 3 stars still in reach'], 'the first token should dim the star for no tokens');
const ringed = await page.locator('#board .stop.hint').count();
assert.ok(p.lines.some((l, k) => k && l.length === ringed), 'the ringed stops should be one whole line');
assert.equal(await page.locator('#board .guide').count(), 0);
await page.click('#b-token');
assert.equal(await page.locator('#board .guide').count(), 1);
assert.equal(await page.locator('#board .stop.first').count(), 1);

// Leaving and coming back keeps everything.
await page.reload();
assert.equal(await text('#b-continue'), 'Resume No. 1');
assert.equal(await page.locator('#route li.next').count(), 0, 'a puzzle under way says Resume, not Next stop');
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
assert.equal(await text('#readout'), 'Arrow keys move, Enter adds a letter, Enter again sends', 'the map taken by Tab should say how to play with keys');
await page.focus('#board');
const walk = async (to, on = page) => {
  let at = await on.evaluate(() => [...document.querySelectorAll('#board .stop')].findIndex(s => s.classList.contains('cursor')));
  if (at < 0) { await on.keyboard.press('ArrowRight'); at = 0; }
  for (; at % 6 < to % 6; at++) await on.keyboard.press('ArrowRight');
  for (; at % 6 > to % 6; at--) await on.keyboard.press('ArrowLeft');
  for (; at < to; at += 6) await on.keyboard.press('ArrowDown');
  for (; at > to; at -= 6) await on.keyboard.press('ArrowUp');
};
for (const [n, stop] of p.lines[3].entries()) {
  await walk(stop); await page.keyboard.press('Enter');
  // A word built with Enter waits for Enter again on its last letter, and says so.
  if (n === 1) assert.equal(await text('#readout'), `${words[3].slice(0, 2)}, Enter again on ${words[3][1]}`);
}
await page.keyboard.press('Enter');
assert.equal(await text('#count'), `3 of ${p.lines.length} lines`);

// The cursor is a ring of its own outside the dot, with the map showing between, so it shows on every stop, the blue
// line's own included, and it can't be taken for the ring that marks where a hinted route starts.
await walk(p.lines[2][0]);
const ring = await page.evaluate(() => {
  const stop = document.querySelector('#board .stop.cursor'), cur = stop.querySelector('.cur'), dot = stop.querySelector('.dot'), s = getComputedStyle(cur);
  const first = document.querySelector('#board .stop.first .ring');
  // On an edge stop the ring reaches past the map's edge (the stops are 10 apart, 5 from the edge), so it isn't cut off.
  const reach = cur.r.baseVal.value + parseFloat(s.strokeWidth) / 2, overflow = getComputedStyle(document.getElementById('board')).overflow;
  return { blue: stop.classList.contains('c2'), shown: s.opacity, gap: cur.r.baseVal.value - parseFloat(s.strokeWidth) / 2 - dot.r.baseVal.value, stroke: s.stroke, first: first && getComputedStyle(first).stroke, whole: reach <= 5 || overflow === 'visible' };
});
assert.ok(ring.blue && ring.shown === '1' && ring.gap > 0.4 && ring.first && ring.stroke !== ring.first && ring.whole, `the cursor should stand apart on a blue-line stop: ${JSON.stringify(ring)}`);

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

// Finish it. The Crosstown wasn't first and tokens were spent, so one star. The last word stays while its line draws,
// then the readout says the map's name; the done sheet rises after that, and only then does the footer change.
await page.evaluate(() => {
  // One observer, so the changes come in the order they were made.
  const log = window.finishing = [], readout = document.getElementById('readout');
  const seen = new MutationObserver(records => {
    for (const r of records) {
      const what = r.type === 'attributes' ? `${r.target.id} ${r.target.hidden ? 'hidden' : 'shown'}` : `readout ${readout.textContent}`;
      if (log.at(-1) !== what) log.push(what);
    }
  });
  seen.observe(readout, { childList: true, subtree: true, characterData: true });
  for (const id of ['after', 'sheet-done']) seen.observe(document.getElementById(id), { attributes: true, attributeFilter: ['hidden'] });
});
const order = [0, 1, 5, 6].filter(k => k < p.lines.length);
for (let k = 7; k < p.lines.length; k++) order.push(k);
for (const k of order) await drag(page, p.lines[k]);
await page.waitForSelector('#sheet-done:not([hidden])');
{
  const log = await page.evaluate(() => window.finishing), at = what => log.indexOf(what);
  const word = at(`readout ${words[order.at(-1)]}, found. All ${p.lines.length} lines found`), name = at(`readout ${p.name}`);
  assert.ok(word >= 0 && name > word && at('sheet-done shown') > name && at('after shown') > at('sheet-done shown'), `the finish should go word, name, done sheet, footer: ${JSON.stringify(log)}`);
  assert.equal(await text('#readout'), p.name, 'a map finished should say its name');
}
assert.equal(await focused(), 'b-done-next', 'the done sheet should start on Next puzzle');
assert.equal(await text('#done-title'), p.name);
// An ordinary puzzle's sheet says "Last stop", which can't be taken for the end of a Line of puzzles. Short of three
// stars it's never graded: this one has one.
assert.equal(await text('#sheet-done .eyebrow'), 'Last stop');
assert.equal(await page.locator('#done-stars .got').count(), 1);
// Earned and missed stars say which they are, not only by colour, and the sheet's description gives the result.
assert.deepEqual(await page.$$eval('#done-stars li', l => l.map(li => li.textContent)), ['Earned: Every stop on a line', 'Missed: No tokens spent', 'Missed: Crosstown found first']);
assert.equal(await page.getAttribute('#sheet-done .panel', 'aria-describedby'), 'done-sum done-stats done-line');
assert.deepEqual([await text('#done-sum'), await text('#done-line')], ['1 of 3 stars.', ''], "the description should say the stars, and nothing of a line that isn't finished");
assert.equal(await page.locator('#done-key li').count(), p.lines.length);
assert.equal(await text('#done-key li.xt'), `${p.name.toUpperCase()} (the Crosstown)`, 'the key should give the Crosstown as the map names it, spaces and all');
assert.notEqual(p.name.toUpperCase(), words[0], 'the first map should have a Crosstown of two words, to test the key');
assert.equal(await page.locator('#board .stop.on').count(), 48);
// The sign's stars, once the map is finished, are the stars it got.
assert.deepEqual([await signStars(), await page.getAttribute('#sign-stars', 'aria-label')], [[true, false, false], '1 of 3 stars']);
// The detours found are a button on the done sheet, closed to begin with, that shows them in capitals, A to Z.
{
  const mine = await page.evaluate(id => JSON.parse(localStorage.getItem('crosstown.v1')).games[id].detours, p.id);
  const more = '#done-stats .more', shown = async () => [await page.getAttribute(more, 'aria-expanded'), await page.isHidden('#done-detours')];
  assert.ok(mine.length > 1);
  assert.equal(await text(more), `${mine.length} detours`);
  assert.deepEqual(await shown(), ['false', true]);
  await page.click(more);
  assert.deepEqual([...await shown(), await text('#done-detours')], ['true', false, mine.map(w => w.toUpperCase()).sort().join(', ')], 'the detours found should show, in capitals, A to Z');
  await page.click(more);
  assert.deepEqual(await shown(), ['false', true]);
}

// Sharing falls back to the clipboard, or to text you can select.
await page.click('#b-share');
await page.waitForSelector('#toast.on, #share-box:not([hidden])', { timeout: 5000 });
if (await page.isVisible('#toast.on')) assert.equal(await text('#toast'), 'Result copied');
else assert.match(await page.inputValue('#share-text'), /^Crosstown Main Line No. 1 /);

// On to the next one, with night service on: the clue stays hidden until the first line.
await page.click('#b-done-next');
assert.equal(await text('#where'), 'Main, No. 2');
assert.equal(await text('#spoken'), `Main, No. 2. ${PUZZLES[1].clue}`, 'Next puzzle should say which puzzle and clue it is');
// The page's title names the puzzle, and the back arrow the list it goes to.
assert.deepEqual([await page.title(), await page.getAttribute('#b-back', 'aria-label')], ['Main No. 2 · Crosstown', 'Main Line puzzles']);
await page.click('#b-menu');
await page.check('#o-night');
await page.check('#o-clock');
await page.click('#sheet-menu .panel-row [data-close]');
assert.match(await text('#clue'), /^Night service/);
assert.equal(await page.isVisible('#clock'), true);
assert.equal(await text('#map-where'), `Main Line, No. 2. Night service. 0 of ${PUZZLES[1].lines.length} lines.`, 'the map\'s description should keep the clue hidden too');
await drag(page, PUZZLES[1].lines[0]);
assert.equal(await text('#clue'), PUZZLES[1].clue);
assert.equal(await text('#readout'), `Crosstown: ${PUZZLES[1].name}, found`);
assert.equal(await page.getAttribute('#readout', 'class'), 'readout crossed', 'the Crosstown found should be said in full, not in a note');

// Back on the list: one finished with a star, one under way.
await page.click('#b-back');
assert.equal(await page.title(), 'Crosstown');
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
// On the map finished with one star, the second tap says so in the singular. Closing the sheet keeps the map.
await page.click('#route li:nth-child(1) .row');
await page.click('#b-menu');
await page.click('#m-restart');
assert.equal(await text('#m-restart'), 'Tap again: its 1 star stays');
await page.keyboard.press('Escape');
assert.equal(await text('#count'), 'All found');
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
  // It gives the line's tally and the whole network's, each a strip ending at a terminus, heard in words.
  {
    const all = LINES.reduce((n, l) => n + l.puzzles.length, 0), n = PUZZLES.length;
    const [count, got, most] = await tab.evaluate(ns => ns.map(v => v.toLocaleString()), [all, all * 3 - 1, all * 3]);
    assert.deepEqual(await tab.$$eval('#done-line .term .sr-only', s => s.map(x => x.textContent)), [`${LINES[0].name}: ${n} of ${n}, ${n * 3 - 1} of ${n * 3} stars`, `Every line: ${count} of ${count}, ${got} of ${most} stars`]);
    assert.deepEqual(await tab.$$eval('#done-line .term-show', s => s.map(x => [x.getAttribute('aria-hidden'), x.textContent])), [['true', `${LINES[0].name}${n} of ${n}${n * 3 - 1}★`], ['true', `Every line${count} of ${count}${got}★`]]);
  }
  assert.equal(await tab.textContent('#done-stats'), 'No detours', 'a map finished without detours should say "No detours", not "0 detours"');
  assert.equal(await tab.evaluate(() => document.activeElement.id), 'b-share', 'the last done sheet should start on Share');
  const earned = await tab.evaluate(() => ({ fill: getComputedStyle(document.querySelector('#done-stars .got svg')).fill, bg: getComputedStyle(document.querySelector('#sheet-done .panel')).backgroundColor }));
  assert.ok(contrast(earned.fill, earned.bg) >= 3, `the stars earned are hard to see on the done sheet: ${JSON.stringify(earned)}`);

  // On the finished map the arrows and Enter name the lines, the same as tapping a stop.
  await tab.keyboard.press('Escape');
  await tab.focus('#board');
  const named = i => { const k = last.lines.findIndex(l => l.includes(i)), w = spell(last.grid, last.lines[k]); return k ? last.written?.[w] ?? w : `Crosstown: ${last.name}`; };
  for (const stop of [last.lines[1][0], last.lines[0][0]]) {
    await walk(stop, tab);
    await tab.keyboard.press('Enter');
    assert.equal(await tab.textContent('#readout'), named(stop), 'Enter on a finished map should name the line');
  }
  assert.equal(await tab.locator('#board .stop.cursor').count(), 1);

  // With every puzzle finished, the tally gives the whole network's: every puzzle, and the stars, with the one star
  // missed on the last puzzle, and a way to it. The big button goes for three stars, at the first puzzle short of them.
  await tab.click('#b-back');
  const all = LINES.reduce((n, l) => n + l.puzzles.length, 0);
  const [puzzles, got, most] = await tab.evaluate(ns => ns.map(n => n.toLocaleString()), [all, all * 3 - 1, all * 3]);
  assert.equal(await tab.textContent('#b-continue'), 'Go for three stars', 'with every line finished and a star short, the big button should go for three stars');
  assert.equal(await tab.textContent('#tally'), `Every line finished: ${puzzles} puzzles, ${got} of ${most} stars No. ${PUZZLES.length} short of three stars`);
  // In ink and heavier than an ordinary tally: it's the biggest moment the list has.
  const look = await tab.evaluate(() => { const s = getComputedStyle(document.getElementById('tally')), h = getComputedStyle(document.querySelector('h1')); return [s.color === h.color, s.fontSize, s.fontWeight]; });
  assert.deepEqual(look, [true, '15px', '700'], 'the network\'s tally should be in ink, 15px, bold');
  for (const colorScheme of ['light', 'dark']) {
    await tab.emulateMedia({ colorScheme });
    // The stars on the list are small text, so full and empty ones need the contrast text does to tell apart.
    const stars = await tab.evaluate(() => ({ color: getComputedStyle(document.querySelector('#route .st')).color, bg: getComputedStyle(document.body).backgroundColor }));
    assert.equal(await tab.getAttribute('#route .st', 'role'), 'img', 'the stars on the list should be read by their label, not as star glyphs');
    assert.ok(contrast(stars.color, stars.bg) >= 4.5, `the stars on the list are hard to see in ${colorScheme}: ${JSON.stringify(stars)}`);
  }
  await tab.emulateMedia({ colorScheme: 'light' });
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#where'), `Main, No. ${PUZZLES.length}`, 'Go for three stars should open the puzzle short of them');
  assert.deepEqual(errors, []);
  await other.close();
}
// With every puzzle on every line at three stars, the big button goes rather than sitting there doing nothing, and How
// to play moves up to the front of the row.
{
  const games = Object.fromEntries(LINES.flatMap(l => l.puzzles).map(q => [q.id, finished(q)]));
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  const all = LINES.reduce((n, l) => n + l.puzzles.length, 0);
  const [puzzles, most] = await tab.evaluate(ns => ns.map(n => n.toLocaleString()), [all, all * 3]);
  assert.equal(await tab.isHidden('#b-continue'), true, 'with every star won, the big button should go, not sit there off');
  assert.equal(await tab.textContent('#tally'), `Every line finished: ${puzzles} puzzles, ${most} of ${most} stars`);
  assert.equal(await tab.evaluate(() => document.querySelector('.mast-row button:not([hidden])').id), 'b-how', 'How to play should move up to the front of the row');
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
  assert.equal(await tab.textContent('#readout'), 'Trace the dashed route first. No token spent', 'a tap on the token button while a route shows should say why it is off');
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
  // It says how to send it: tap the last letter again.
  assert.equal(await tab.textContent('#readout'), `${words[1].slice(0, 2)}, tap ${words[1][1]} again`, 'a tapped word should say how to send it');
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
  assert.equal(await tab.textContent('#readout'), `${words[1]}, found. 1 of ${p.lines.length} lines`);
  assert.deepEqual(errors, []);
  await other.close();
}

// A detour can run through the stops of found lines. A drag goes on through them, from one too, and a tapped word (or
// one keyed in) goes on into one beside its last letter, which shows as traced. A found line's stop tapped on its own,
// or pressed and let go, names its line, and a tapped word elsewhere goes. A found line traced again says it's found.
{
  const { other, tab, errors } = await visitor({ options: { traced: true }, best: {}, games: { [p.id]: { found: [0], detours: [], crossAt: 0, spent: 1 } } });
  await tab.click('#b-continue');
  // With the tokens all spent, the token button says there are none left, not none yet.
  await tab.click('#b-token', { force: true });
  assert.equal(await tab.textContent('#readout'), NO_TOKENS.replace('yet', 'left'));
  const onCross = i => p.lines[0].includes(i);
  const crossing = p.detours.split(' ').map(d => ({ word: d, path: traces(p.grid, d.toUpperCase(), 20).find(t => t.some(onCross)) })).filter(d => d.path);
  const dragged = crossing.find(d => !onCross(d.path[0]));
  const tapped = crossing.find(d => d !== dragged && !onCross(d.path[0]) && d.word.length < 7);
  const keyed = crossing.find(d => d !== dragged && d !== tapped && !onCross(d.path[0]));
  const fromFound = crossing.find(d => onCross(d.path[0]) && ![dragged, tapped, keyed].includes(d));
  assert.ok(dragged && tapped && keyed && fromFound, 'this check needs detours through the first map\'s Crosstown');
  const detourSaid = d => new RegExp(`^Detour: ${d.word.toUpperCase()}, \\+${fareFor(d.word)} fare`);
  await drag(tab, dragged.path);
  assert.match(await tab.textContent('#readout'), detourSaid(dragged), 'a drag through a found line should spell a detour');
  await drag(tab, fromFound.path);
  assert.match(await tab.textContent('#readout'), detourSaid(fromFound), 'a drag from a found line should spell a detour');
  for (const i of tapped.path) await tap(tab, i);
  await tab.waitForTimeout(400);   // the stops' colours ease in
  const shown = await tab.evaluate(() => {
    const fill = q => getComputedStyle(document.querySelector(q)).fill;
    return { on: document.querySelectorAll('#board .stop.on.sel').length, found: fill('#board .stop.on.sel .dot'), free: fill('#board .stop.sel:not(.on) .dot') };
  });
  assert.deepEqual([shown.on, shown.found], [tapped.path.filter(onCross).length, shown.free], 'a found line\'s stop in a tapped word should show as traced');
  await tap(tab, tapped.path.at(-1));
  assert.match(await tab.textContent('#readout'), detourSaid(tapped), 'a tapped word should go on through a found line');
  await tab.focus('#board');
  await tab.keyboard.press('Enter');
  for (const i of keyed.path) { await walk(i, tab); await tab.keyboard.press('Enter'); }
  await tab.keyboard.press('Enter');
  assert.match(await tab.textContent('#readout'), detourSaid(keyed), 'a word keyed in should go on through a found line');
  assert.equal(await tab.textContent('#count'), `1 of ${p.lines.length} lines`);
  // A found line traced again is found already, and earns nothing.
  const fare = await tab.getAttribute('#meter', 'aria-label');
  await drag(tab, p.lines[0]);
  assert.deepEqual([await tab.textContent('#readout'), await tab.evaluate(() => document.getElementById('readout').className)], ['Crosstown already found', 'readout note nope']);
  const k = 1;
  await tapOut(tab, p.lines[k]);
  await drag(tab, p.lines[k]);
  assert.equal(await tab.textContent('#readout'), `${words[k]} already found`);
  assert.deepEqual([await tab.textContent('#count'), await tab.getAttribute('#meter', 'aria-label')], [`2 of ${p.lines.length} lines`, fare]);
  // A found line's stop on its own names its line, tapped or pressed and let go, and a tapped word away from it goes.
  const free = j => !onCross(j) && !p.lines[k].includes(j);
  const from = NEIGHBORS[p.lines[k][0]].find(free) ?? [...Array(48).keys()].find(free);
  const far = p.lines[0].find(i => !NEIGHBORS[from].includes(i));
  await tap(tab, from); await tap(tab, far);
  assert.deepEqual([await tab.textContent('#readout'), await tab.locator('#board .stop.sel').count()], [`Crosstown: ${p.name}`, 0]);
  await drag(tab, [p.lines[k][1]]);
  assert.deepEqual([await tab.textContent('#readout'), await tab.locator('#board .stop.sel').count()], [words[k], 0]);
  // The Lines sheet says a line with a puzzle under way and none finished is under way, after a full stop.
  await tab.click('#b-back'); await tab.click('#b-line');
  assert.equal(await tab.getAttribute('#lines li:nth-child(1) .line-row', 'aria-label'), `${LINES[0].name}: ${LINES[0].about}. Under way`);
  assert.deepEqual(errors, []);
  await other.close();
}

// A line written otherwise than its letters (ON DECK, where the map has ONDECK) is traced by its letters and shown as
// written: when it's found, when it's found again, when a stop on it is pressed or walked to, and in the done
// sheet's key.
{
  const n = PUZZLES.findIndex(q => q.written), q = PUZZLES[n], qw = q.lines.map(l => spell(q.grid, l));
  const k = qw.findIndex((w, j) => j > 0 && q.written[w]), as = q.written[qw[k]];
  const last = [...q.lines.keys()].reverse().find(j => j > 0 && j !== k);
  const games = { [q.id]: { found: [...q.lines.keys()].filter(j => j !== k && j !== last), detours: [] } };
  const { other, tab, errors } = await visitor({ options: { traced: true }, best: {}, games });
  await tab.click(`#route li:nth-child(${n + 1}) .row`);
  await drag(tab, q.lines[k]);
  assert.equal(await tab.textContent('#readout'), `${as}, found. ${q.lines.length - 1} of ${q.lines.length} lines`, 'a found line should be shown as it\'s written');
  await drag(tab, q.lines[k]);
  assert.equal(await tab.textContent('#readout'), `${as} already found`);
  await drag(tab, [q.lines[k][1]]);
  assert.equal(await tab.textContent('#readout'), as, 'a found line\'s stop should name it as it\'s written');
  await tab.focus('#board');
  await walk(q.lines[k][0], tab);
  assert.match(await tab.textContent('#spoken'), new RegExp(`, on the ${as} line, `), 'a found line\'s stop walked to should name it as it\'s written');
  await tab.keyboard.press('Escape');
  await drag(tab, q.lines[last]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.textContent(`#done-key li:nth-child(${k + 1})`), as, 'the key should give a line as it\'s written');
  assert.deepEqual(errors, []);
  await other.close();
}

// Late in a puzzle, with no detours left on the whole map that could earn another token, the first word that misses
// says so, once. Fare still on the meter counts: three fare and one four-letter detour left can still make a token.
{
  const all = p.detours.split(' '), last = all.find(d => d.length === 4 && traces(p.grid, d.toUpperCase(), 1).length);
  const { other, tab, errors } = await visitor({ options: { traced: true }, best: {}, games: { [p.id]: { found: [], detours: all.filter(d => d !== last), fare: 3, spent: 0 } } });
  await tab.click('#b-continue');
  const NONE_LEFT = 'Not a word on this map. No detours left that could earn a token';
  await drag(tab, junk);
  assert.equal(await tab.textContent('#readout'), 'Not a word on this map', 'a token can still be earned');
  await drag(tab, traces(p.grid, last.toUpperCase(), 1)[0]);
  assert.match(await tab.textContent('#readout'), /Token earned/);
  await drag(tab, junk);
  assert.equal(await tab.textContent('#readout'), NONE_LEFT, 'with no fare left to earn, the first miss should say so');
  for (const [width, height] of [[320, 568], [390, 844]]) {
    await tab.setViewportSize({ width, height });
    assert.equal(await tab.evaluate(() => { const r = document.getElementById('readout'); return r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5; }), true, `the note on no fare left is taller than the readout at ${width} px`);
  }
  await drag(tab, junk);
  assert.equal(await tab.textContent('#readout'), 'Not a word on this map', 'no fare left should be said once');
  assert.deepEqual(errors, []);
  await other.close();
}

// Finding the Crosstown says the map's name at the readout's full size, then "Crosstown" small after it. On a small
// phone the longest name stays whole on one line with its label, and the map doesn't move.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { viewport: { width: 320, height: 568 } });
  await tab.click('#b-continue');
  const top = (await tab.locator('#board').boundingBox()).y;
  await drag(tab, p.lines[0]);
  const longest = LINES.flatMap(l => l.puzzles).map(q => q.name).reduce((a, b) => (b.length > a.length ? b : a));
  for (const name of [p.name, longest]) {
    const fit = await tab.evaluate(name => {
      const r = document.getElementById('readout'), label = r.querySelector('.send');
      [...r.childNodes].find(n => n.nodeType === 3).textContent = name;
      const range = document.createRange(); range.selectNodeContents([...r.childNodes].find(n => n.nodeType === 3));
      return { tall: r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5, label: label.scrollWidth <= label.clientWidth, after: label.getBoundingClientRect().left > range.getBoundingClientRect().right, page: document.documentElement.scrollWidth <= innerWidth };
    }, name);
    assert.deepEqual(fit, { tall: true, label: true, after: true, page: true }, `"${name}", the Crosstown found, doesn't fit the readout at 320 px`);
  }
  assert.equal((await tab.locator('#board').boundingBox()).y, top, 'the map moved when the Crosstown was found');
  assert.deepEqual(errors, []);
  await other.close();
}

// Zoomed in, the map keeps a floor of 300 px tall and the page scrolls down to the fare, rather than the map
// shrinking (at 400% it used to vanish). A phone and a laptop at 100% are as they were. A finger dragged on the map
// traces and never scrolls the page; one dragged on the sign scrolls it.
{
  for (const [width, height, scale, size] of [[390, 844, 2, [358, 477]], [1280, 800, 1, [431, 575]], [640, 400, 2], [427, 267, 3], [320, 200, 4]]) {
    const { other, tab, errors } = await visitor({ options: { traced: true }, best: {}, games: {} }, { viewport: { width, height }, deviceScaleFactor: scale, isMobile: width === 390, hasTouch: true });
    await tab.click('#b-continue');
    const b = await tab.locator('#board').boundingBox(), fare = await tab.locator('#fare').boundingBox();
    const page = await tab.evaluate(() => ({ tall: document.documentElement.scrollHeight, wide: document.documentElement.scrollWidth, sy: scrollY }));
    if (size) assert.deepEqual([Math.round(b.width), Math.round(b.height), page.tall], [...size, height], `the map should be as it was at ${width}x${height}`);
    else {
      assert.ok(b.height >= 299.5 && page.tall > height && fare.y + fare.height <= page.tall + 0.5 && page.wide <= width, `zoomed in to ${width}x${height}, the map shrank or the fare can't be reached: ${JSON.stringify({ b, fare, page })}`);
      const cdp = await tab.context().newCDPSession(tab);
      const touch = async points => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
        for (const pt of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await tab.waitForTimeout(200);
      };
      const at = i => ({ x: b.x + (i % 6 + 0.5) * b.width / 6, y: b.y + (Math.floor(i / 6) + 0.5) * b.height / 8 });
      const down = [0, 6, 12, 18].filter(i => at(i).y < height - 4);
      const steps = down.slice(1).flatMap((i, n) => [1, 2, 3, 4].map(s => ({ x: at(i).x, y: at(down[n]).y + (at(i).y - at(down[n]).y) * s / 4 })));
      await touch([at(down[0]), ...steps]);
      assert.deepEqual([await tab.evaluate(() => scrollY), await tab.textContent('#readout') !== ''], [0, true], `a finger dragged down the map at ${width}x${height} should trace, not scroll the page`);
      await touch([...Array(10)].map((_, s) => ({ x: 30, y: height * (0.35 - s * 0.03) })));
      assert.ok(await tab.evaluate(() => scrollY) > 0, `a finger dragged on the sign at ${width}x${height} should scroll the page`);
    }
    assert.deepEqual(errors, []);
    await other.close();
  }
}

// A sheet too tall for the window (zoomed in to 200% on a laptop, or a small phone) would put the focus on a button out
// of sight at its foot, so the focus goes to the sheet itself, at its top, with a ring. The arrow keys scroll it, Tab
// reaches its buttons, Escape closes it and the focus goes back where it was. A sheet that fits starts on its button.
for (const [width, height] of [[640, 400], [375, 667]]) {
  const { other, tab, errors } = await visitor({ options: { traced: true }, best: {}, games: { [p.id]: { found: p.lines.map((_, k) => k).slice(1), detours: [] } } }, { viewport: { width, height } });
  const where = () => tab.evaluate(() => {
    const a = document.activeElement, panel = a.closest('.panel'), pr = panel?.getBoundingClientRect(), ar = a.getBoundingClientRect();
    return { focus: a.classList.contains('panel') ? 'panel' : a.id || a.textContent.trim(), seen: !!panel && ar.top >= pr.top - 1 && ar.bottom <= pr.bottom + 1, top: panel?.scrollTop, ring: getComputedStyle(a).outlineStyle !== 'none' };
  });
  const sheets = [['b-how', 'Got it'], ['b-list-menu', 'Done'], ['b-menu', 'Done'], ['board', 'b-done-next']];
  for (const [from, button] of sheets) {
    if (from === 'b-menu') await tab.click('#b-continue');
    await tab.focus(`#${from}`);
    if (from === 'board') await drag(tab, p.lines[0]); else await tab.keyboard.press('Enter');
    await tab.waitForSelector('.sheet:not([hidden])');
    const over = await tab.evaluate(() => { const panel = document.querySelector('.sheet:not([hidden]) .panel'); return panel.scrollHeight > panel.clientHeight + 1; });
    const at = await where();
    if (over) {
      assert.deepEqual(at, { focus: 'panel', seen: true, top: 0, ring: from === 'board' ? at.ring : true }, `a sheet too tall for ${width}x${height}, opened from ${from}, should start with the focus on itself`);
      await tab.keyboard.press('PageDown');
      await tab.waitForFunction(() => document.activeElement.scrollTop > 0, null, { timeout: 3000 }).catch(() => assert.fail('Page Down should scroll a sheet that has the focus'));
      await tab.keyboard.press('Tab');
      assert.equal((await where()).seen, true, 'Tab from the sheet should reach a button in sight');
    } else assert.deepEqual([at.focus, at.seen], [button, true], `a sheet that fits ${width}x${height} should start on its button`);
    await tab.keyboard.press('Escape');
    assert.equal(await tab.evaluate(() => document.activeElement.id), from, 'closing a sheet should hand the focus back');
  }
  // At 200% on a laptop every one of them is too tall; on a 375x667 phone How to play is.
  assert.ok(width === 640 || await tab.evaluate(() => document.getElementById('sheet-how').querySelector('.panel').getAttribute('tabindex') === '-1'), 'How to play should be too tall for a 375x667 phone, for this check');
  assert.deepEqual(errors, []);
  await other.close();
}

// The map taken by the keyboard says how to play it with keys. On a first visit that takes the place of the tip on
// dragging and stays while the arrows move; later it shows until the first key. Enter before any arrow puts the
// cursor down, on the first stop or on the last letter of a word under way, and says where it is.
{
  const KEYS = 'Arrow keys move, Enter adds a letter, Enter again sends';
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} });
  const cursorAt = () => tab.evaluate(() => [...document.querySelectorAll('#board .stop')].findIndex(s => s.classList.contains('cursor')));
  await tab.focus('#b-continue'); await tab.keyboard.press('Enter');
  assert.equal(await tab.textContent('#readout'), KEYS, 'a puzzle opened by keyboard on a first visit should say how to play with keys');
  await tab.keyboard.press('ArrowDown');
  assert.equal(await tab.textContent('#readout'), KEYS, 'on a first visit the keys tip should stay while the arrows move');
  await tab.keyboard.press('Escape');
  await tab.click('#b-back');
  await tab.evaluate(() => { const s = JSON.parse(localStorage.getItem('crosstown.v1')); s.options.traced = true; localStorage.setItem('crosstown.v1', JSON.stringify(s)); });
  await tab.reload();
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#readout'), '', 'a tap should not bring the keys tip');
  await tab.focus('#b-menu'); await tab.keyboard.press('Tab');
  assert.equal(await tab.textContent('#readout'), KEYS, 'Tab to the map should say how to play with keys');
  await tab.keyboard.press('Enter');
  assert.deepEqual([await cursorAt(), await tab.textContent('#spoken'), await tab.textContent('#readout')], [0, `${p.grid[0]}, row 1, column 1`, ''], 'Enter before any arrow should put the cursor on the first stop and say so');
  await tab.keyboard.press('Enter');
  assert.equal(await tab.locator('#board .stop.sel').count(), 1, 'Enter again should add the letter');
  await tab.locator('#board').blur();
  await tab.focus('#b-menu'); await tab.keyboard.press('Tab');
  assert.equal(await tab.textContent('#readout'), p.grid[0], 'with a word under way, the map taken by Tab should leave it showing');
  await tab.keyboard.press('Space');
  assert.equal(await cursorAt(), 0, 'Space before any arrow should put the cursor on the last letter of the word');
  assert.deepEqual(errors, []);
  await other.close();
}

// The fare meter has no number on screen, so its empty slots need the 3:1 a part of the picture needs against the
// page (WCAG 2.2, 1.4.11), in both palettes, and the full ones stand out from them. In the dark palette a traced word's
// stops stand apart from the Crosstown's white.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: [], detours: [], fare: 2 } } });
  await tab.click('#b-continue');
  for (const colorScheme of ['light', 'dark']) {
    await tab.emulateMedia({ colorScheme });
    await tab.waitForTimeout(300);   // the pips' colours ease in
    const pip = await tab.evaluate(() => ({ empty: getComputedStyle(document.querySelector('#pips i:not(.full)')).borderTopColor, full: getComputedStyle(document.querySelector('#pips i.full')).backgroundColor, bg: getComputedStyle(document.body).backgroundColor }));
    const rgb = c => (c.startsWith('color(srgb') ? `rgb(${c.match(/[\d.]+/g).slice(0, 3).map(v => v * 255).join(', ')})` : c);   // a mixed colour
    assert.ok(contrast(rgb(pip.empty), pip.bg) >= 3 && contrast(pip.full, pip.bg) >= 4.5, `the fare's slots are hard to see in ${colorScheme}: ${JSON.stringify(pip)}`);
    // A traced word's stops can't be taken for the Crosstown's (white in the dark palette), and their letters read.
    const c = await tab.evaluate(() => Object.fromEntries(['select', 'on-select', 'cross'].map(v => { const i = document.createElement('i'); i.style.color = `var(--${v})`; document.body.append(i); const got = getComputedStyle(i).color; i.remove(); return [v, got]; })));
    assert.ok((colorScheme === 'light' || contrast(c.select, c.cross) >= 2.5) && contrast(c.select, c['on-select']) >= 4.5, `a traced word's stops are too like the Crosstown's in ${colorScheme}: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// In forced colours (Windows High Contrast) things drawn with a background colour are taken away, unless kept: the
// full fare slots stand apart from the empty ones, the route down the list and the line bars keep their colours, and
// the ready token keeps its fill.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [PUZZLES[0].id]: finished(PUZZLES[0]), [PUZZLES[1].id]: { found: [], detours: [], fare: 2, tokens: 1 } } });
  await tab.emulateMedia({ forcedColors: 'active' });
  const bg = () => tab.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const page = await bg();
  const list = await tab.evaluate(() => ({ route: getComputedStyle(document.querySelector('#route li:first-child'), '::after').backgroundColor, bar: getComputedStyle(document.querySelector('#b-line .line-bar')).backgroundColor }));
  assert.ok(contrast(list.route, page) > 1.2 && contrast(list.bar, page) > 1.2, `the route and the line bar vanish in forced colours: ${JSON.stringify({ ...list, page })}`);
  await tab.click('#route li:nth-child(2) .row');
  const play = await tab.evaluate(() => ({ full: getComputedStyle(document.querySelector('#pips i.full')).backgroundColor, empty: getComputedStyle(document.querySelector('#pips i:not(.full)')).backgroundColor, token: getComputedStyle(document.getElementById('b-token')).backgroundColor, label: getComputedStyle(document.getElementById('token-label')).color }));
  assert.ok(contrast(play.full, page) >= 3 && /, 0\)$|transparent/.test(play.empty) && contrast(play.token, play.label) >= 4.5, `the fare or the token can't be read in forced colours: ${JSON.stringify({ ...play, page })}`);
  assert.deepEqual(errors, []);
  await other.close();
}

// On a small phone a long tapped word stays whole on one line, and what to do next gives way, so the map doesn't move.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { viewport: { width: 320, height: 568 }, hasTouch: true });
  await tab.click('#b-continue');
  const long = p.lines.reduce((a, b) => (b.length > a.length ? b : a));
  for (const i of long) await tap(tab, i);
  for (const word of [spell(p.grid, long), 'M'.repeat(14)]) {   // 14 letters, the longest line on any map
    const fit = await tab.evaluate(word => {
      const r = document.getElementById('readout'); r.firstChild.textContent = word;
      return { tall: r.getBoundingClientRect().height <= parseFloat(getComputedStyle(r).minHeight) + 0.5, wide: r.scrollWidth <= r.clientWidth, page: document.documentElement.scrollWidth <= innerWidth };
    }, word);
    assert.deepEqual(fit, { tall: true, wide: true, page: true }, `a tapped word of ${word.length} letters doesn't fit the readout at 320 px`);
  }
  assert.deepEqual(errors, []);
  await other.close();
}

// A puzzle only looked at is saved for its clock, but nothing was traced, so the next one still says how to trace.
// Once a word has been sent, it doesn't.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: { found: [], detours: [], ms: 6000 } } });
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#readout'), HOW, 'someone who has only looked at a puzzle should still be told how to trace');
  await tap(tab, p.lines[1][0]); await tap(tab, p.lines[1][1]); await tap(tab, p.lines[1][1]);
  assert.equal(await tab.textContent('#readout'), TOO_SHORT);
  await tab.click('#b-back');
  await tab.click('#b-continue');
  assert.equal(await tab.textContent('#readout'), '', 'once a word has been sent, the tip should stop');
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
    // Below 360 the second row is filled too, How to play stretching so the menu sits at the edge, under the big button's.
    const tidy = width >= 360 ? new Set(tops).size === 1 : tops[0] < tops[1] && tops[1] === tops[2] && Math.abs(boxes[2].right - boxes[0].right) < 0.5;
    assert.ok(tidy && boxes.every(b => b.h <= 44.5 && b.right <= width - 15.5), `the list buttons with "${await tab.textContent('#b-continue')}" at ${width}px: ${JSON.stringify(boxes)}`);
  }
  // On to the next line: the focus stays on the big button, so a screen reader is told which line is on show now.
  if (l === LINES[0]) {
    await tab.click('#b-continue');
    await tab.waitForFunction(said => document.getElementById('list-said').textContent === said, `${next.name}, ${next.puzzles.length} puzzles`, { timeout: 2000 })
      .catch(async () => assert.fail(`On to the next line said "${await tab.textContent('#list-said')}"`));
    assert.equal(await tab.getAttribute('#route', 'aria-label'), `${next.name} puzzles`);
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
  // Every line's name stays whole at 320 px with the clock past ten minutes, and at 340 px past an hour.
  for (const [width, time] of [[320, '12:34'], [340, '1:02:03']]) {
    await tab.setViewportSize({ width, height: 568 });
    const cut = await tab.evaluate(([names, time]) => {
      document.getElementById('clock').textContent = time;
      const name = document.querySelector('#where .where-line');
      return names.filter(n => { name.textContent = n; return name.scrollWidth > name.clientWidth; });
    }, [LINES.map(l => l.name.replace(/ Line$/, '')), time]);
    assert.deepEqual(cut, [], `line names cut off in the bar at ${width} px with the clock at ${time}`);
  }
  // Between the name and the number, a short bar in the line's colour, in either palette, as on the list.
  for (const colorScheme of ['light', 'dark']) {
    await tab.emulateMedia({ colorScheme });
    const sep = await tab.evaluate(color => {
      const probe = document.createElement('i'); probe.style.color = `var(--${color})`; document.body.append(probe);
      const want = getComputedStyle(probe).color; probe.remove();
      const s = getComputedStyle(document.querySelector('#where .sep'));
      return { bar: parseFloat(s.width) > 2 * parseFloat(s.height), colour: s.backgroundColor === want };
    }, l.color);
    assert.deepEqual(sep, { bar: true, colour: true }, `the bar's separator should be a short bar in the ${l.name}'s colour in ${colorScheme}`);
  }
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
  // A stop in the word being traced says where in the word it is, and the last one that Enter sends it. Escape says
  // the word has gone. The map is described by where it is, the clue, the count and the keys.
  await tab.keyboard.press('Enter'); await walk(route[1], tab); await tab.keyboard.press('Enter');
  await hears(route[0], `${p.grid[route[0]]}, ${at(route[0])}, ringed, the route starts here, letter 1 of your word`);
  await hears(route[1], `${p.grid[route[1]]}, ${at(route[1])}, ringed, letter 2 of your word, Enter sends it`);
  await tab.keyboard.press('Escape');
  assert.deepEqual([await tab.textContent('#spoken'), await tab.locator('#board .stop.sel').count()], ['Word cleared', 0], 'Escape should say the word was cleared');
  // The description is in words of its own, not the screen's capitals, with a stop after each part.
  assert.equal(await tab.getAttribute('#board', 'aria-describedby'), 'map-said');
  assert.equal(await tab.textContent('#map-where'), `${LINES[0].name}, No. 1. Clue: ${p.clue}. 2 of ${p.lines.length} lines.`);
  const ax = await (await tab.context().newCDPSession(tab)).send('Accessibility.getFullAXTree');
  assert.match(ax.nodes.find(n => n.role?.value === 'application')?.description?.value ?? '', new RegExp(`^${LINES[0].name}, No\\. 1\\. Clue: .*\\. 2 of ${p.lines.length} lines\\. Arrow keys move\\.`), 'the map should be described by where it is, the clue, the count and the keys');
  assert.match(await tab.textContent('#map-keys'), /^Arrow keys move\. Home, Page Up, End and Page Down move diagonally: up left, up right, down left and down right\. Enter adds a letter; Enter again on the last letter sends the word\./);
  // The diagonals: Home, Page Up, End and Page Down, and the number pad's 7, 9, 1 and 3. A move off the map says so.
  const cursorAt = () => tab.evaluate(() => [...document.querySelectorAll('#board .stop')].findIndex(s => s.classList.contains('cursor')));
  await walk(14, tab);   // row 3, column 3
  for (const [key, to] of [['PageDown', 21], ['End', 26], ['Home', 19], ['PageUp', 14], ['Numpad3', 21], ['Numpad7', 14], ['Numpad9', 9], ['Numpad1', 14]]) {
    await tab.keyboard.press(key);
    assert.equal(await cursorAt(), to, `${key} should move the cursor diagonally`);
  }
  await walk(0, tab);
  await tab.keyboard.press('Home');
  assert.deepEqual([await cursorAt(), await tab.textContent('#spoken')], [0, `${p.grid[0]}, row 1, column 1, edge of the map`], 'a move off the map should say so');
  assert.equal(await tab.evaluate(() => scrollY), 0, 'Home on the map should not scroll the page');
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
    return { toast: document.getElementById('toast').classList.contains('on'), label: label?.textContent, gap: box.getBoundingClientRect().top - label?.getBoundingClientRect().bottom, focused: document.activeElement === box, value: box.value, selected: box.selectionEnd - box.selectionStart };
  });
  assert.equal(shown.toast, false, 'a toast would cover the text to copy');
  assert.ok(shown.label === 'Select the text and copy it' && shown.gap >= 0 && shown.gap < 12, `the instruction should sit just above the box: ${JSON.stringify(shown)}`);
  assert.ok(shown.focused && shown.value.startsWith('Crosstown Main Line No. 1 ') && shown.selected === shown.value.length, `the result should be in the box, selected: ${JSON.stringify(shown)}`);
  await tab.keyboard.press('Escape');
  await tab.click('#b-results');
  assert.equal(await tab.isHidden('#share-box'), true, 'the box should go when the sheet closes');
  await clipboard(true);
  await tab.click('#b-share');
  await tab.waitForSelector('#toast.on', { timeout: 5000 });
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
  // Earning a token, the meter shows full for a moment before it empties, and the token button gives a pulse.
  await tab.evaluate(() => {
    window.seen = { full: 0, pulse: false };
    new MutationObserver(() => { const p = document.getElementById('pips'); if (p.classList.contains('rollover')) window.seen.full = Math.max(window.seen.full, p.querySelectorAll('.full').length); }).observe(document.getElementById('pips'), { attributes: true, childList: true, subtree: true });
    new MutationObserver(() => { if (document.getElementById('b-token').classList.contains('earned')) window.seen.pulse = true; }).observe(document.getElementById('b-token'), { attributes: true });
  });
  await drag(tab, traces(p.grid, longest.toUpperCase(), 1)[0]);
  // The first token ever says how to spend it (and fare's tip waits, as the first detour ever is this one).
  assert.match(await tab.textContent('#readout'), /Token earned\. Tap Use a token for a hint$/);
  await tab.waitForFunction(() => !document.getElementById('pips').classList.contains('rollover'), null, { timeout: 2000 });
  const fare = (3 + fareFor(longest)) % FARE_PER_TOKEN;
  assert.deepEqual([await tab.evaluate(() => window.seen), await tab.locator('#pips .full').count()], [{ full: FARE_PER_TOKEN, pulse: true }, fare], 'earning a token should fill the meter for a moment, then show the fare left over');
  await tab.waitForFunction(() => !document.getElementById('b-token').classList.contains('earned'), null, { timeout: 2000 }).catch(() => assert.fail('the token button should lose its pulse once it has run'));
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
  // The list says the save couldn't be read and a copy is kept, for this visit.
  const ASIDE = "Your saved progress couldn’t be read, so this list starts fresh. A copy is kept in this browser.";
  assert.equal(await tab.isVisible('#aside-note') && await tab.textContent('#aside-note'), ASIDE, 'the list should say a save was put aside');

  await tab.evaluate(s => localStorage.setItem('crosstown.v1', s), whole);
  await tab.reload();
  for (const [n, time] of [[1, ''], [2, ''], [3, ' 1:01']]) assert.equal(await tab.textContent(`#route li:nth-child(${n}) .row-sub`), `${PUZZLES[n - 1].name} ★★★${time}`, 'a best time that is not a time should not show');
  await tab.click('#route li:nth-child(4) .row');
  assert.equal(await tab.getAttribute('#meter', 'aria-label'), `Fare: 3 of ${FARE_PER_TOKEN}`);
  assert.equal(await tab.textContent('#token-label'), 'Use a token (1)', 'a whole token of fare should count as a token');
  await tab.click('#b-back');
  assert.equal(await tab.isHidden('#aside-note'), true, 'a save that could be read should say nothing of one put aside');

  // A save that reads but has the wrong shape, its games wrapped in a list as a hand edit could leave it, is put aside
  // too (one already put aside is cleared here first), rather than written over by the next save.
  const wrapped = JSON.stringify({ options: {}, best: {}, games: [{ [a.id]: finished(a) }] });
  await tab.evaluate(s => { localStorage.removeItem('crosstown.v1.unreadable'); localStorage.setItem('crosstown.v1', s); }, wrapped);
  await tab.reload();
  assert.equal(await tab.textContent('#tally'), `${PUZZLES.length} puzzles`);
  assert.equal(await tab.isVisible('#aside-note') && await tab.textContent('#aside-note'), ASIDE);
  assert.equal((await kept())[1], wrapped, 'a save of the wrong shape should be put aside');
  await tab.click('#route li:nth-child(2) .row'); await drag(tab, b.lines[1]); await tab.click('#b-back');
  assert.deepEqual([(await kept())[1], Object.keys(JSON.parse((await kept())[0]).games)], [wrapped, [b.id]], 'the copy put aside should outlast the next save');
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
  // A plays Market No. 1 again. B shows it, still finished with its best stars but to play again, and B's next writes
  // (an option, a line) don't bring the old game back, or lose the stars.
  await pick(a, 2); await a.click('#route li:nth-child(1) .row');
  await a.click('#b-menu'); await a.click('#m-restart'); await a.click('#m-restart'); await a.click('#b-back');
  await b.waitForFunction(() => document.querySelector('#route li:nth-child(1) .row-go').textContent === 'Replay', null, { timeout: 5000 })
    .catch(() => assert.fail('a puzzle started over in one window should show as one to play again in the other'));
  assert.equal(await b.getAttribute('#route li:nth-child(1)', 'class'), 'done', 'a puzzle played again should keep its stars in the other window');
  await b.click('#b-list-menu'); await b.click('#o-clock'); await b.keyboard.press('Escape');
  await pick(b, 1);
  s = await stored();
  assert.deepEqual([s.games[m.id], s.stars[m.id] > 0, s.games[p.id]?.done, s.options.clock], [undefined, true, true, true], 'one window brought back a puzzle started over in the other');
  // B erases every line while A has Market No. 2 open with a line found: A's puzzle starts afresh, and A leaving it
  // doesn't write it back. A's list empties, and A's next write doesn't bring anything back.
  const m2 = LINES[1].puzzles[1];
  await a.click('#route li:nth-child(2) .row'); await drag(a, m2.lines[1]);
  await b.click('#b-list-menu'); await b.click('#m-erase'); await b.click('#m-erase');
  await a.waitForFunction(() => document.getElementById('readout').textContent === 'Progress erased in another window', null, { timeout: 5000 })
    .catch(() => assert.fail('erasing in one window should start the puzzle open in the other afresh'));
  assert.deepEqual([await a.textContent('#count'), await a.locator('#board .line').count()], [`0 of ${m2.lines.length} lines`, 0]);
  await a.click('#b-back');
  assert.deepEqual((await stored()).games, {}, 'leaving a puzzle wrote back a game erased in the other window');
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

// The same puzzle in two windows: the better game is the one kept, whichever window writes last, and a window that
// has fallen behind takes it in and says so. Stars come before detours, so a game with a token spent can't take the
// place of one without.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const [a, b] = [await context.newPage(), await context.newPage()];
  const errors = [];
  for (const tab of [a, b]) tab.on('pageerror', e => errors.push(e.message));
  const kept = id => a.evaluate(id => JSON.parse(localStorage.getItem('crosstown.v1')).games[id], id);
  const said = (tab, words) => tab.waitForFunction(w => document.getElementById('readout').textContent === w, words, { timeout: 5000 })
    .catch(async () => assert.fail(`the window behind said "${await tab.textContent('#readout')}", not "${words}"`));
  // Detours on a puzzle worth `want` fare, clear of the stops in `avoid`.
  async function faresOn(q, avoid, want) {
    const { DETOURS } = await import(`../js/detours/${q.line}.js`);
    const got = []; let fare = 0;
    for (const d of DETOURS[q.id].split(' ').sort((x, y) => y.length - x.length)) {
      const t = fare < want && traces(q.grid, d.toUpperCase(), 20).find(t => !t.some(i => avoid.includes(i)));
      if (t) { got.push(t); fare += fareFor(d); }
    }
    assert.ok(fare >= want, `not enough detours on ${q.id}`);
    return got;
  }
  // B is part way through No. 2, with detours. A starts it over and finishes it with three stars: B takes in A's game
  // as soon as it's further along than its own, then the finish, and shows the finished map.
  const [, q, r, t] = PUZZLES;
  // B can be put to sleep: while window.asleep is set, it hears nothing another window saves.
  await b.addInitScript(() => {
    const on = window.addEventListener;
    window.addEventListener = function (type, fn, ...rest) { return on.call(this, type, type === 'storage' ? e => { if (!window.asleep) fn(e); } : fn, ...rest); };
  });
  await b.goto(base); await b.click('#route li:nth-child(2) .row');
  await drag(b, q.lines[1]);
  for (const path of await faresOn(q, q.lines[1], FARE_PER_TOKEN)) await drag(b, path);
  await a.goto(base); await a.click('#route li:nth-child(2) .row');
  await a.click('#b-menu'); await a.click('#m-restart'); await a.click('#m-restart');
  await drag(a, q.lines[0]);
  assert.equal(await b.textContent('#count'), `1 of ${q.lines.length} lines`, 'a game with fewer detours should not take the place of the one on screen');
  await drag(a, q.lines[1]);
  await said(b, 'Carried on in another window');
  assert.equal(await b.textContent('#count'), `2 of ${q.lines.length} lines`);
  for (const path of q.lines.slice(2)) await drag(a, path);
  await a.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await a.locator('#done-stars .got').count(), 3);
  await said(b, 'Finished in another window');
  assert.deepEqual([await b.textContent('#count'), await b.isVisible('#after'), await b.locator('#board .stop.on').count()], ['All found', true, 48], 'the window behind should show the finished map');
  assert.equal(starsFor({ ...await kept(q.id), done: true }), 3);
  await a.keyboard.press('Escape'); await a.click('#b-back');
  await b.click('#b-back');
  assert.equal(await b.textContent('#route li:nth-child(2) .st'), '★★★');

  // B doesn't hear what A saves (asleep, as a phone leaves an app it isn't showing). B finds a line of No. 3 and earns a
  // token; A carries on from there and finishes with two stars. B, still asleep, spends its token and finishes with
  // the same detours and one star: A's two stars are kept, and B shows A's game once its done sheet closes.
  await b.evaluate(() => { window.asleep = true; });
  await b.click('#route li:nth-child(3) .row');
  await drag(b, r.lines[1]);
  for (const path of await faresOn(r, r.lines[1], FARE_PER_TOKEN)) await drag(b, path);
  await a.click('#route li:nth-child(3) .row');
  for (const k of r.lines.keys()) if (k !== 1) await drag(a, r.lines[k]);
  await a.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await a.locator('#done-stars .got').count(), 2);
  await b.click('#b-token');
  for (const k of r.lines.keys()) if (k !== 1) await drag(b, r.lines[k]);
  await b.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await b.locator('#done-stars .got').count(), 1);
  const g = await kept(r.id);
  assert.deepEqual([g.spent, starsFor({ ...g, done: true })], [0, 2], 'a one-star finish took the place of a two-star one');
  await b.keyboard.press('Escape');
  await said(b, 'Finished in another window');
  await b.click('#b-results');
  assert.equal(await b.locator('#done-stars .got').count(), 2, 'the window behind should show the game that was kept');
  await b.keyboard.press('Escape'); await b.click('#b-back');
  assert.equal(await b.textContent('#route li:nth-child(3) .st'), '★★☆');

  // Still asleep, B has No. 4 open with a line; A finishes it. B, back on screen, takes in the finish.
  await b.click('#route li:nth-child(4) .row'); await drag(b, t.lines[1]);
  await a.keyboard.press('Escape'); await a.click('#b-back'); await a.click('#route li:nth-child(4) .row');
  for (const k of t.lines.keys()) if (k !== 1) await drag(a, t.lines[k]);
  await a.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await b.textContent('#count'), `1 of ${t.lines.length} lines`);
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await said(b, 'Finished in another window');
  assert.equal(await b.textContent('#count'), 'All found');

  // Both awake on No. 5, which A has a line of. A earns a token and spends it: B shows the ring at once. B then finds a
  // detour: the token stays spent, so the ring stays and the 'No tokens spent' star stays out of reach, in both.
  await b.evaluate(() => { window.asleep = false; });
  const [u, v] = PUZZLES.slice(4);
  await a.keyboard.press('Escape'); await a.click('#b-back'); await a.click('#route li:nth-child(5) .row');
  await b.click('#b-back'); await b.click('#route li:nth-child(5) .row');
  await drag(a, u.lines[1]);
  await said(b, 'Carried on in another window');
  const paid = await faresOn(u, u.lines[1], FARE_PER_TOKEN);
  for (const path of paid) await drag(a, path);
  await a.click('#b-token');
  const rung = await a.locator('#board .stop.hint').count();
  await b.waitForFunction(n => document.querySelectorAll('#board .stop.hint').length === n, rung, { timeout: 5000 })
    .catch(() => assert.fail('a token spent in one window should ring its line in the other'));
  const { DETOURS: uDetours } = await import(`../js/detours/${u.line}.js`);
  const more = uDetours[u.id].split(' ').map(d => traces(u.grid, d.toUpperCase(), 20).find(t => !t.some(i => u.lines[1].includes(i))))
    .find(path => path && !paid.some(x => x.join() === path.join()));
  await drag(b, more);
  await said(a, 'Carried on in another window');
  assert.equal(await a.locator('#board .stop.hint').count(), rung, 'the ring a token bought went when the other window found a detour');
  const g5 = await kept(u.id);
  assert.deepEqual([g5.spent, !!g5.hint, g5.detours.length], [1, true, paid.length + 1], 'a token spent in one window came back when the other saved');
  assert.equal(g5.tokens * FARE_PER_TOKEN + g5.fare, g5.detours.reduce((n, d) => n + fareFor(d), 0) - FARE_PER_TOKEN, 'fare and tokens should add up to the detours, less the token spent');

  // On No. 6, B holds a word half traced when A saves a line: letting go still sends B's word, and B shows both lines.
  await a.click('#b-back'); await a.click('#route li:nth-child(6) .row');
  await b.click('#b-back'); await b.click('#route li:nth-child(6) .row');
  const at = async i => { const box = await b.locator('#board').boundingBox(); return { x: box.x + (i % 6 + 0.5) * box.width / 6, y: box.y + (Math.floor(i / 6) + 0.5) * box.height / 8 }; };
  const held = v.lines[2], start = await at(held[0]);
  await b.mouse.move(start.x, start.y); await b.mouse.down();
  for (const i of held.slice(1, -1)) { const pt = await at(i); await b.mouse.move(pt.x, pt.y, { steps: 3 }); }
  await drag(a, v.lines[1]);
  await b.waitForFunction(id => JSON.parse(localStorage.getItem('crosstown.v1')).games[id]?.found.length === 1, v.id, { timeout: 5000 });
  await b.waitForTimeout(300);   // for B to hear of it
  const end = await at(held.at(-1));
  await b.mouse.move(end.x, end.y, { steps: 3 }); await b.mouse.up();
  await said(b, 'Carried on in another window');
  assert.deepEqual([await b.locator('#board .line').count(), (await kept(v.id)).found.sort()], [2, [1, 2]], 'a word traced in one window was lost when the other saved');
  assert.equal(await a.locator('#board .line').count(), 2, 'the other window should show the line traced while it saved');
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
  const note = "This browser isn’t keeping your progress, so it goes when the page closes.";
  assert.equal(await tab.isVisible('#unkept') && await tab.textContent('#unkept'), note, `the list should say progress isn't kept (${how})`);
  await tab.click('#b-continue');
  for (const line of p.lines) await drag(tab, line);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.textContent('#done-stats'), 'No detours, not kept in this browser', `the done sheet should say its stars aren't kept (${how})`);
  await tab.keyboard.press('Escape'); await tab.click('#b-back');
  assert.equal(await tab.getAttribute('#route li:nth-child(1)', 'class'), 'done', `a puzzle should still finish (${how})`);
  assert.equal(await tab.isVisible('#unkept'), true);
  // The Lines sheet doesn't claim each line keeps its progress.
  await tab.click('#b-line');
  assert.equal(await tab.textContent('#lines-note'), `This browser isn’t keeping your progress, so it goes when the page closes. 1 of ${LINES.reduce((n, l) => n + l.puzzles.length, 0)} finished, 3 stars.`, `the Lines sheet should say progress isn’t kept (${how})`);
  await tab.keyboard.press('Escape');
  await tab.click('#b-list-menu'); await tab.click('#m-erase'); await tab.click('#m-erase');
  assert.equal(await tab.textContent('#toast'), 'Erased for this visit only');
  assert.deepEqual(errors, [], `errors with storage ${how}`);
  await context.close();
}
// Storage that fills up part way through a visit: what was saved before is still there, so the list says only new
// progress goes.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: { [p.id]: finished(p) } });
  assert.equal(await tab.isHidden('#unkept'), true);
  await tab.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }; });
  await tab.click('#route li:nth-child(2) .row'); await drag(tab, PUZZLES[1].lines[1]); await tab.click('#b-back');
  const stopped = 'This browser has stopped saving, so new progress goes when the page closes.';
  assert.equal(await tab.isVisible('#unkept') && await tab.textContent('#unkept'), stopped);
  // The Lines sheet says the same, not that everything goes.
  await tab.click('#b-line');
  assert.equal(await tab.textContent('#lines-note'), `${stopped} 1 of ${LINES.reduce((n, l) => n + l.puzzles.length, 0)} finished, 3 stars.`, 'the Lines sheet should say only new progress goes');
  await tab.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await other.close();
}
// After a puzzle is finished, the browser is asked once a visit to keep the progress (where it hasn't already said it
// will), and not before.
{
  const nearly = q => ({ found: q.lines.map((_, k) => k).slice(1), detours: [] });
  const [a, b] = PUZZLES;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(s => {
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('crosstown.v1', s); sessionStorage.setItem('seeded', '1'); }
    window.asked = 0;
    Object.defineProperty(navigator, 'storage', { value: { persisted: async () => false, persist: async () => { window.asked++; return true; } } });
  }, JSON.stringify({ options: {}, best: {}, games: { [a.id]: nearly(a), [b.id]: nearly(b) } }));
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(base);
  await tab.click('#b-continue');
  assert.equal(await tab.evaluate(() => window.asked), 0, 'the browser should not be asked before anything is finished');
  await drag(tab, a.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  await tab.waitForFunction(() => window.asked === 1, null, { timeout: 3000 }).catch(() => assert.fail('a finish should ask the browser to keep progress'));
  await tab.click('#b-done-next');
  await drag(tab, b.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.evaluate(() => window.asked), 1, 'the browser should be asked once a visit');
  assert.deepEqual(errors, []);
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
  assert.equal(await tab.textContent('#readout'), `${words[1]}, found. 1 of ${p.lines.length} lines`);
  assert.deepEqual(errors, []);
  await other.close();
}

// A fast swipe (or a busy phone merging its touch moves) can carry the finger over a stop between two events: the
// stops it passed over still count. Here each move jumps two stops along a straight stretch of a line, so every other
// stop is passed over without a move on it.
{
  const xy = i => [i % 6, Math.floor(i / 6)];
  const straight = l => l.length > 4 && l.every((s, j) => j % 2 === 0 || j === l.length - 1 || xy(l[j - 1]).every((v, a) => v + xy(l[j + 1])[a] === 2 * xy(s)[a]));
  const n = PUZZLES.findIndex(q => straight(q.lines[0])), q = PUZZLES[n], line = q.lines[0];
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await tab.click(`#route li:nth-child(${n + 1}) .row`);
  assert.equal(await tab.textContent('#where'), `Main, No. ${n + 1}`);
  const box = await tab.locator('#board').boundingBox();
  const at = i => ({ x: box.x + (i % 6 + 0.5) * box.width / 6, y: box.y + (Math.floor(i / 6) + 0.5) * box.height / 8, id: 0 });
  const cdp = await other.newCDPSession(tab);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const hops = line.filter((_, j) => j % 2 === 0 || j === line.length - 1);
  await touch('touchStart', [at(hops[0])]);
  for (const i of hops.slice(1)) await touch('touchMove', [at(i)]);
  await touch('touchEnd', []);
  assert.equal(await tab.textContent('#readout'), `Crosstown: ${q.name}, found`, `a swipe jumping over every other stop of ${spell(q.grid, line)} lost stops`);
  assert.deepEqual(errors, []);
  await other.close();
}

// A line's detours that can't be loaded (a first visit on a weak signal, before the offline copy is in) don't make a
// real detour "Not a word on this map": the readout says they can't be checked, and the next word asks for them
// again, so once they come the same puzzle counts it.
{
  server.refuse = 'js/detours/main.js';
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { serviceWorkers: 'block' });
  const asked = [];
  tab.on('request', r => { if (r.url().includes('/detours/')) asked.push(r.url().replace(base, '')); });
  await tab.click('#b-continue');
  await drag(tab, first.path);
  await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
  assert.equal(await tab.textContent('#readout'), "Can’t check detours right now. Try that word again in a moment");
  assert.equal(await tab.locator('#pips .full').count(), 0);
  // Each try asks for the file at an address of its own, as a browser may hand back a failed import's failure.
  await drag(tab, first.path);
  await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
  assert.equal(await tab.textContent('#readout'), "Can’t check detours right now. Try that word again in a moment");
  server.refuse = null;
  await drag(tab, first.path);
  await tab.waitForFunction(() => document.getElementById('readout').textContent.startsWith('Detour:'), null, { timeout: 8000 })
    .catch(async () => assert.fail(`a detour once its file could load read "${await tab.textContent('#readout')}"`));
  assert.equal(await tab.locator('#pips .full').count(), fareFor(first.word) % FARE_PER_TOKEN);
  // (Opening the puzzle asked again too, as did each word.)
  const tries = asked.filter(u => u.includes('main.js'));
  assert.ok(tries.length >= 3 && new Set(tries).size === tries.length && tries.every(u => /^js\/detours\/main\.js\?try=\d+$/.test(u)), `each try after a failure should ask at an address of its own: ${tries}`);
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
  assert.match(await tab.textContent('#readout'), new RegExp(`^Detour: ${first.word.toUpperCase()}, \\+${fareFor(first.word)} fare`), 'a word that is not one buried the detour before it');
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
// A file that takes longer than the wait (8 s here): the readout says the words are still on their way rather than
// "Try that word again", a word traced meanwhile joins them, and when the file comes the detour counts and is kept.
{
  server.slow = { path: 'js/detours/main.js', ms: 8000 };
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { serviceWorkers: 'block' });
  await tab.click('#b-continue');
  await drag(tab, first.path);
  assert.equal(await tab.textContent('#readout'), 'One moment');
  const SLOW = 'Detours are still on their way. Your words will count when they come';
  await tab.waitForFunction(() => document.getElementById('readout').textContent !== 'One moment', null, { timeout: 8000 });
  assert.equal(await tab.textContent('#readout'), SLOW, 'a word waiting on a slow file should hear it is still waiting');
  await drag(tab, junk);
  assert.equal(await tab.textContent('#readout'), SLOW);
  await tab.waitForFunction(s => document.getElementById('readout').textContent !== s, SLOW, { timeout: 8000 });
  assert.match(await tab.textContent('#readout'), new RegExp(`^Detour: ${first.word.toUpperCase()}, \\+${fareFor(first.word)} fare`), 'a detour traced before a slow file came was dropped');
  assert.equal(await tab.locator('#pips .full').count(), fareFor(first.word) % FARE_PER_TOKEN);
  assert.deepEqual(await tab.evaluate(id => JSON.parse(localStorage.getItem('crosstown.v1')).games[id].detours, p.id), [first.word]);
  server.slow = null;
  assert.deepEqual(errors, []);
  await other.close();
}

// With the clock on, the bar's clock at the finish is the time the done sheet gives. It ticks every half second, so a
// finish more than half a second past a tick left it a second behind. The page's clock is held here, and Back and Resume
// put the ticks a quarter second off the whole seconds, so the finish falls past a whole second the bar hasn't shown.
{
  const q = LINES[0].puzzles[0];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('crosstown.v1', s); sessionStorage.setItem('seeded', '1'); } },
    JSON.stringify({ options: { clock: true }, best: {}, games: {} }));
  const tab = await context.newPage();
  await tab.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await tab.goto(base);
  await tab.clock.pauseAt(new Date('2026-01-01T00:00:10Z'));   // time moves only when the test says
  await tab.click('#b-continue');
  await drag(tab, q.lines[1]);
  await tab.clock.runFor(1250);                  // ticks at 0.5 s and 1 s, then kept at 1.25 s by Back
  await tab.click('#b-back'); await tab.click('#b-continue');   // so the ticks now fall at 1.75, 2.25, 2.75 s
  await tab.clock.runFor(1600);                  // 2.85 s: the last tick, at 2.75 s, says 0:02
  for (const l of q.lines.slice(2)) await drag(tab, l);
  await tab.clock.runFor(200);                   // the last line at 3.05 s: 0:03
  await drag(tab, q.lines[0]);
  await tab.clock.runFor(1000);                  // the done sheet comes up 900 ms after the last line
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.textContent('#clock'), (await tab.textContent('#done-stats')).split(',')[0], "the bar's clock should agree with the done sheet");
  await context.close();
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
  // Results on a map of a line finished on an earlier visit reads as any finished map does: the line's finish was
  // marked when it happened. It still offers the next line.
  await tab.click('#route li:nth-child(1) .row');
  await tab.click('#b-results');
  // With all three stars it's "Express service".
  assert.equal(await tab.textContent('#sheet-done .eyebrow'), 'Express service', 'Results on an old three-star map should say Express service, not that its line was just finished');
  assert.deepEqual([await tab.isHidden('#done-line'), await tab.textContent('#done-line')], [true, '']);
  assert.equal(await tab.textContent('#b-done-next'), `On to ${second.name.replace(/ Line$/, '')}`);
  await tab.keyboard.press('Escape');
  // Starting a finished map over is playing it again, and its second tap says its stars stay.
  await tab.click('#b-menu');
  assert.equal(await tab.textContent('#m-restart'), 'Play this puzzle again');
  await tab.click('#m-restart');
  assert.equal(await tab.textContent('#m-restart'), 'Tap again: its 3 stars stay', "a finished map's start-over should say its stars stay");
  await tab.keyboard.press('Escape');
  await tab.click('#b-menu');
  assert.equal(await tab.textContent('#m-restart'), 'Play this puzzle again', 'closing the sheet should take back the first tap');
  // Played again, and finished worse, it keeps its best stars: the list, the tally and the Lines sheet count three, and
  // the line stays finished. Under way, its row says so, with its best.
  {
    const q = main.puzzles[0], full = `${main.puzzles.length} of ${main.puzzles.length} finished, ${main.puzzles.length * 3} of ${main.puzzles.length * 3} stars`;
    await tab.click('#m-restart'); await tab.click('#m-restart');
    assert.equal(await tab.textContent('#count'), `0 of ${q.lines.length} lines`);
    await drag(tab, q.lines[1]);
    await tab.click('#b-back');
    assert.deepEqual([await tab.textContent('#route li:nth-child(1) .row-sub'), await tab.textContent('#route li:nth-child(1) .row-go')], [`1 of ${q.lines.length} lines found, best ★★★`, 'Resume']);
    // The route stays solid through it, as the line is still finished.
    assert.equal(await tab.evaluate(() => { const bg = (n, w) => getComputedStyle(document.querySelector(`#route li:nth-child(${n})`), w).backgroundColor; return bg(1, '::after') === bg(2, '::before') && bg(1, '::after') === bg(3, '::after'); }), true, 'the route should stay solid through a puzzle played again');
    assert.equal(await tab.textContent('#tally'), full, 'a finished puzzle played again should still count, with its best stars');
    assert.equal(await tab.textContent('#b-continue'), `On to ${second.name.replace(/ Line$/, '')}`, 'a line with a puzzle played again should stay finished');
    await tab.click('#route li:nth-child(1) .row');
    for (const l of q.lines.slice(2)) await drag(tab, l);
    await drag(tab, q.lines[0]);
    await tab.waitForSelector('#sheet-done:not([hidden])');
    assert.deepEqual([await tab.textContent('#done-sum'), await tab.textContent('#sheet-done .eyebrow')], ['2 of 3 stars.', 'Last stop'], 'a puzzle played again on a finished line should not say the line was just finished');
    await tab.keyboard.press('Escape'); await tab.click('#b-back');
    assert.equal(await tab.textContent('#route li:nth-child(1) .st'), '★★★', 'the list should keep the best stars');
    assert.equal(await tab.textContent('#tally'), full, 'the tally should keep the best stars');
    await tab.click('#b-line');
    assert.match(await tab.getAttribute('#lines li:first-child button', 'aria-label'), new RegExp(`Finished, ${main.puzzles.length * 3} stars$`), 'the Lines sheet should keep the best stars');
    await tab.keyboard.press('Escape');
    // Kept over a reload, from what's saved.
    await tab.reload(); await tab.evaluate(() => document.fonts.ready);
    assert.equal(await tab.textContent('#tally'), full);
  }
  // A map opened again on a finished line goes on to the next map along it, from the button under it, round to No. 1
  // after the last. Results still offers the next line, and Back still means the list.
  {
    const n = main.puzzles.length;
    await tab.click('#route li:last-child .row');
    assert.equal(await tab.textContent('#b-next'), 'Next map', "a map opened again on a finished line should offer the next map");
    await tab.click('#b-next');
    assert.equal(await tab.textContent('#where'), 'Main, No. 1', 'Next map after the last should go round to No. 1');
    assert.equal(await tab.textContent('#spoken'), `Main, No. 1. ${main.puzzles[0].clue}`);
    await tab.click('#b-next');
    assert.equal(await tab.textContent('#where'), 'Main, No. 2');
    await tab.click('#b-results');
    assert.equal(await tab.textContent('#b-done-next'), `On to ${second.name.replace(/ Line$/, '')}`, 'Results should still offer the next line');
    await tab.keyboard.press('Escape');
    await tab.goBack();
    await tab.waitForSelector('#s-list:not([hidden])', { timeout: 5000 }).catch(() => assert.fail('Back after Next map should go to the list'));
    assert.equal(await tab.locator('#route li').count(), n);
  }
  // A finished line short of three stars on some puzzles: its tally ends with a way to the first of them.
  {
    const some = { ...games, [main.puzzles[4].id]: { ...finished(main.puzzles[4]), spent: 1 }, [main.puzzles[8].id]: { ...finished(main.puzzles[8]), crossAt: 2 } };
    const n = main.puzzles.length, { other: o2, tab: t2 } = await visitor({ options: {}, best: {}, games: some });
    assert.equal(await t2.textContent('#tally'), `${n} of ${n} finished, ${n * 3 - 2} of ${n * 3} stars 2 short of three stars, next No. 5`);
    await t2.click('#tally .tally-link');
    assert.equal(await t2.textContent('#where'), 'Main, No. 5', 'the link should open the first puzzle short of three stars');
    await t2.click('#b-back');
    await t2.evaluate(id => { const s = JSON.parse(localStorage.getItem('crosstown.v1')); s.stars = { [id]: 3 }; localStorage.setItem('crosstown.v1', JSON.stringify(s)); }, main.puzzles[4].id);
    await t2.reload(); await t2.evaluate(() => document.fonts.ready);
    assert.equal(await t2.textContent('#tally'), `${n} of ${n} finished, ${n * 3 - 1} of ${n * 3} stars No. 9 short of three stars`, 'a best of three stars kept should count over the game saved');
    await o2.close();
  }
  // A finished line's route ends at a terminus, "End of the line"; one under way runs off the end as before.
  const terminus = () => tab.evaluate(() => getComputedStyle(document.getElementById('route'), '::after').content);
  assert.equal(await terminus(), '"End of the line"', 'a finished line should end at a terminus');
  await tab.click('#b-continue');
  assert.equal(await terminus(), 'none', 'a line not finished should have no terminus');
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
  assert.equal(await tab.textContent('#lines li:nth-child(1) .line-prog'), `Finished${n * 3}★`, 'a finished line should say so');   // with a dot drawn between
  assert.equal(await tab.getAttribute('#lines li:nth-child(1) .line-row', 'aria-label'), `${main.name}: ${main.about}. Finished, ${n * 3} stars`);
  assert.equal(await tab.textContent('#lines li:nth-child(2) .line-prog'), `${second.puzzles.length} puzzles`);
  const [nn, aa, ss] = await tab.evaluate(ns => ns.map(v => v.toLocaleString()), [n, all, n * 3]);
  assert.equal(await tab.textContent('#lines-note'), `Each line keeps its own progress. ${nn} of ${aa} finished, ${ss} stars.`);
  // On a phone and a computer the Main Line's about stays on one line beside "Finished · 324★".
  for (const width of [390, 1280]) {
    await tab.setViewportSize({ width, height: 844 });
    assert.equal(await tab.evaluate(() => { const s = document.querySelector('#lines li:nth-child(1) .line-main small:last-child'); return s.getClientRects().length === 1 && s.getBoundingClientRect().height < 25; }), true, `the Main Line's about wraps at ${width} px`);
  }
  await tab.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await tab.$$eval('#lines .here', h => h.map(x => [x.closest('li') === x.closest('ul').children[1], x.textContent])), [[true, 'You are here']], 'the line on show should say so');
  // On a 375x667 phone every row and Close are in sight together, the sheet opened on the first line or the last, and
  // a sheet that fits isn't nudged so its title sits against the top edge.
  const sheetFit = () => tab.evaluate(() => {
    const panel = document.querySelector('#sheet-lines .panel'), box = panel.getBoundingClientRect(), close = document.querySelector('#sheet-lines .panel-row .btn').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#lines .line-row')].filter(r => { const b = r.getBoundingClientRect(); return b.top >= box.top && b.bottom <= box.bottom; });
    return { rows: rows.length, close: close.bottom <= box.bottom && close.bottom <= innerHeight, top: panel.scrollTop, focus: document.activeElement.getAttribute('aria-current') };
  });
  await tab.setViewportSize({ width: 375, height: 667 });
  assert.deepEqual(await sheetFit(), { rows: LINES.length, close: true, top: 0, focus: 'true' }, 'the Lines sheet should fit a 375x667 phone');
  await tab.click(`#lines li:nth-child(${LINES.length}) .line-row`); await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
  for (const [width, height] of [[375, 667], [360, 740]]) {
    await tab.setViewportSize({ width, height });
    await tab.click('#b-line'); await tab.waitForSelector('#sheet-lines:not([hidden])');
    await tab.waitForFunction(() => !document.querySelector('#sheet-lines .panel').getAnimations().length);   // risen
    assert.deepEqual(await sheetFit(), { rows: LINES.length, close: true, top: 0, focus: 'true' }, `the Lines sheet opened on the last line at ${width}x${height}`);
    await tab.keyboard.press('Escape'); await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
  }
  await tab.setViewportSize({ width: 390, height: 844 });
  // Changing line, the new line's route rises into place, and the colours change at once rather than fade, since a fade
  // from one line's colour to another's passes through brown. At rest nothing on the list moves.
  const atRest = () => tab.evaluate(() => { const l = document.getElementById('s-list'); return [l.classList.contains('switching'), getComputedStyle(l).transitionDuration, document.getElementById('route').getAnimations().length]; });
  assert.deepEqual(await atRest(), [false, '0s', 0], 'the list should be still at rest');
  await tab.evaluate(() => {
    window.faded = []; window.rose = [];
    document.getElementById('s-list').addEventListener('transitionrun', e => { if (e.target.id === 's-list') window.faded.push(e.propertyName); });
    document.getElementById('route').addEventListener('animationstart', e => { if (e.target.id === 'route') window.rose.push(e.animationName); });
  });
  await tab.click('#b-line'); await tab.waitForSelector('#sheet-lines:not([hidden])');
  await tab.click('#lines li:nth-child(1) .line-row');
  await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
  const colours = () => tab.evaluate(() => {
    const probe = document.createElement('i'); probe.style.color = 'var(--cross)'; document.body.append(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    return [getComputedStyle(document.querySelector('#b-line .line-bar')).backgroundColor, want];
  });
  const [bar, ink] = await colours();
  assert.equal(bar, ink, 'the new line\'s colour should show at once, not fade in');
  await tab.waitForFunction(() => window.rose.includes('rise'), null, { timeout: 2000 }).catch(() => assert.fail('changing line should make the route rise into place'));
  await tab.waitForFunction(() => !document.getElementById('s-list').classList.contains('switching'), null, { timeout: 2000 });
  assert.deepEqual(await atRest(), [false, '0s', 0]);
  assert.deepEqual(await tab.evaluate(() => window.faded), [], 'changing line should not fade from one colour to the other');
  // With reduced motion asked for, the route doesn't move.
  await tab.emulateMedia({ reducedMotion: 'reduce' });
  await tab.evaluate(() => { window.rose = []; });
  for (const k of [2, 1]) {
    await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${k}) .line-row`); await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
    assert.equal(await tab.evaluate(() => document.getElementById('route').getAnimations().length), 0, 'with reduced motion the route should not rise');
  }
  assert.deepEqual(await tab.evaluate(() => window.rose), [], 'with reduced motion the route should not rise');
  await tab.emulateMedia({ reducedMotion: 'no-preference' });
  await tab.waitForFunction(said => document.getElementById('list-said').textContent === said, `${main.name}, ${n} of ${n} finished`, { timeout: 2000 })
    .catch(async () => assert.fail(`picking a line said "${await tab.textContent('#list-said')}"`));
  assert.deepEqual(await tab.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-label')]), ['b-line', `${main.name}: ${main.about}. Change line`], 'focus should come back to the line button, naming the new line');
  assert.equal(await tab.locator('#route li').count(), main.puzzles.length);
  assert.equal(await tab.locator('#route li.done').count(), main.puzzles.length, 'nothing finished on the Main Line should be lost');
  await tab.click('#b-line'); await tab.click('#lines li:nth-child(2) .line-row');
  // From the keyboard alone: Enter on Change line opens the sheet on the line on show, Tab goes to the next, Enter picks it.
  await tab.focus('#b-line'); await tab.keyboard.press('Enter');
  await tab.waitForSelector('#sheet-lines:not([hidden])');
  await tab.keyboard.press('Tab'); await tab.keyboard.press('Enter');
  await tab.waitForSelector('#sheet-lines', { state: 'hidden' });
  assert.equal(await tab.textContent('#line-name'), LINES[2].name, 'a line picked from the keyboard should show');
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
  assert.match(await tab.textContent('#readout'), new RegExp(`^Detour: ${d[0].toUpperCase()}, \\+${fareFor(d[0])} fare`));
  await drag(tab, q.lines[0]);
  assert.equal(await tab.textContent('#readout'), `Crosstown: ${q.name}, found`);

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

// A puzzle under way further down a line, behind one not yet played, stays in sight: the big button keeps the line's
// order, and the tally ends with a way to it. With two under way, it says how many and goes to the nearer.
if (LINES.length > 1) {
  const m = LINES[1];
  const games = Object.fromEntries(m.puzzles.slice(0, 30).map(q => [q.id, finished(q)]));
  delete games[m.puzzles[7].id];
  games[m.puzzles[19].id] = { found: [1, 2], detours: [] };
  const { other, tab, errors } = await visitor({ options: { line: m.id }, best: {}, games });
  assert.equal(await tab.textContent('#b-continue'), 'Play No. 8');
  assert.equal(await tab.textContent('#tally'), `28 of ${m.puzzles.length} finished, 84 of ${m.puzzles.length * 3} stars` + ' No. 20 under way');
  assert.equal(await tab.textContent('#tally .tally-link'), 'No. 20 under way', 'a puzzle under way behind one not played should be offered');
  // Where the link goes onto a line of its own, its dot goes with it, and it's as easy to tap as the buttons above, its
  // text where it was.
  for (const width of [390, 360, 320]) {
    await tab.setViewportSize({ width, height: 844 });
    const link = await tab.evaluate(() => {
      const box = el => el.getBoundingClientRect(), l = box(document.querySelector('.tally-link')), d = box(document.querySelector('#tally .sep')), b = box(document.getElementById('b-continue'));
      return { together: Math.abs((d.top + d.bottom) / 2 - (l.top + l.bottom) / 2) < 6 && d.right <= l.left, tall: l.height >= 44, clear: l.top >= b.bottom };
    });
    assert.deepEqual(link, { together: true, tall: true, clear: true }, `the under-way link at ${width} px`);
  }
  await tab.setViewportSize({ width: 390, height: 844 });
  // The Lines sheet tells a screen reader of it too; on screen the row keeps to the count.
  await tab.click('#b-line');
  assert.equal(await tab.getAttribute('#lines li:nth-child(2) .line-row', 'aria-label'), `${m.name}: ${m.about}. 28 of ${m.puzzles.length} finished, 84 stars, 1 under way`);
  assert.equal(await tab.textContent('#lines li:nth-child(2) .line-prog'), `28 of ${m.puzzles.length}84★`);
  // Along each row's foot, a strip filled in the line's colour as far as you've got: 28 of the Market Line, none of the
  // rest.
  const strips = await tab.evaluate(() => [...document.querySelectorAll('#lines .line-row')].map(row => {
    const strip = row.querySelector('.line-strip'), fill = strip?.firstElementChild;
    if (!fill) return null;
    const probe = document.createElement('i'); probe.style.color = getComputedStyle(row.querySelector('.line-bar')).backgroundColor; document.body.append(probe);
    const colour = getComputedStyle(probe).color; probe.remove();
    const a = strip.getBoundingClientRect(), b = row.getBoundingClientRect();
    return { got: Math.round((1000 * fill.getBoundingClientRect().width) / a.width) / 1000, colour: getComputedStyle(fill).backgroundColor === colour, foot: a.bottom >= b.bottom - 3 && a.height <= 5 };
  }));
  const want = LINES.map(l => ({ got: l === m ? Math.round((1000 * 28) / m.puzzles.length) / 1000 : 0, colour: true, foot: true }));
  assert.deepEqual(strips, want, 'each line in the Lines sheet should have a strip along its foot, filled as far as you\'ve got');
  await tab.keyboard.press('Escape');
  await tab.click('#tally .tally-link');
  assert.equal(await tab.textContent('#where'), `${m.name.replace(/ Line$/, '')}, No. 20`);
  assert.equal(await tab.textContent('#count'), `2 of ${m.puzzles[19].lines.length} lines`);
  await tab.click('#b-back');
  await tab.evaluate(([s, id]) => { const v = JSON.parse(s); v.games[id] = { found: [1], detours: [] }; localStorage.setItem('crosstown.v1', JSON.stringify(v)); }, [await tab.evaluate(() => localStorage.getItem('crosstown.v1')), m.puzzles[33].id]);
  await tab.reload();
  assert.equal(await tab.textContent('#tally .tally-link'), '2 under way, next No. 20');
  // With nothing behind the first unfinished puzzle, there's nothing to offer.
  await tab.click('#b-continue'); await drag(tab, m.puzzles[7].lines[1]); await tab.click('#b-back');
  assert.equal(await tab.textContent('#b-continue'), 'Resume No. 8');
  assert.equal(await tab.textContent('#tally .tally-link'), '2 under way, next No. 20', 'the under-way link should count only those after the big button\'s');
  assert.deepEqual(errors, []);
  await other.close();
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
  assert.equal(await tab.textContent('#done-line .sr-only'), `${second.name}: ${total} of ${total}, ${total * 3 - 1} of ${total * 3} stars`);
  // The tally is a strip in the line's colour, with a route ending at a terminus bar.
  const strip = await tab.evaluate(() => {
    const t = document.querySelector('#done-line .term'), rt = t.querySelector('.rt'), c = getComputedStyle(rt).backgroundColor;
    return { count: document.querySelectorAll('#done-line .term').length, border: getComputedStyle(t).borderTopColor === c, bar: getComputedStyle(rt, '::after').backgroundColor === c, height: rt.getBoundingClientRect().height, shown: t.querySelector('.term-show').textContent };
  });
  const line2 = await tab.evaluate(c => { const d = document.createElement('i'); d.style.color = `var(--${c})`; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, second.color);
  assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#done-line .rt')).backgroundColor), line2, "the strip should be in the line's colour");
  assert.deepEqual(strip, { count: 1, border: true, bar: true, height: 6, shown: `${second.name}${total} of ${total}${total * 3 - 1}★` });
  assert.deepEqual([await tab.evaluate(() => document.activeElement.id), await tab.textContent('#b-done-next')], ['b-done-next', `On to ${third.name.replace(/ Line$/, '')}`], 'a finished line should offer the next one');
  await tab.keyboard.press('Escape');
  assert.equal(await tab.textContent('#b-next'), `On to ${third.name.replace(/ Line$/, '')}`, "the map's Next should offer the next line too");
  await tab.setViewportSize({ width: 320, height: 568 });
  await tab.evaluate(() => { document.getElementById('b-next').textContent = 'On to University'; });   // the longest
  assert.ok((await tab.locator('#b-next').boundingBox()).height <= 44.5, "the map's Next wraps at 320 px");
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.click('#b-results');
  await tab.click('#b-done-next');
  assert.equal(await tab.textContent('#where'), `${third.name.replace(/ Line$/, '')}, No. 1`);
  assert.equal(await tab.textContent('#readout'), `Now on the ${third.name}`, 'arriving on a new line should say so');
  assert.equal(await tab.textContent('#clue'), third.puzzles[0].clue);
  assert.equal(await tab.evaluate(() => history.length), left + 1, 'going on to the next line should not add a step');
  await tab.goBack();
  await tab.waitForSelector('#s-list:not([hidden])');
  assert.equal(await tab.textContent('#line-name'), third.name, "Back should go to the new line's list");
  assert.deepEqual(errors, []);
  await other.close();
}
// From the last line it goes round: past a finished Main Line, the next line with a puzzle left is the second, at its
// No. 1.
if (LINES.length > 2) {
  const [main, second] = LINES, end = LINES.at(-1), last = end.puzzles.at(-1);
  const games = Object.fromEntries([...main.puzzles, ...end.puzzles.slice(0, -1)].map(q => [q.id, finished(q)]));
  games[last.id] = { found: last.lines.map((_, k) => k).slice(1), detours: [] };
  const { other, tab, errors } = await visitor({ options: { line: end.id }, best: {}, games });
  await tab.click('#b-continue');
  await drag(tab, last.lines[0]);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  assert.equal(await tab.textContent('#sheet-done .eyebrow'), `${end.name} finished`);
  assert.equal(await tab.textContent('#b-done-next'), `On to ${second.name.replace(/ Line$/, '')}`, 'the last line should go round to the first line with a puzzle left');
  await tab.click('#b-done-next');
  assert.deepEqual([await tab.textContent('#where'), await tab.textContent('#clue')], [`${second.name.replace(/ Line$/, '')}, No. 1`, second.puzzles[0].clue]);
  assert.deepEqual(errors, []);
  await other.close();
}

// A finished roundel's number is text, so on every line, in either palette, it needs 4.5:1 against the roundel.
if (LINES.length > 1) {
  const games = Object.fromEntries(LINES.map(l => [l.puzzles[0].id, finished(l.puzzles[0])]));
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games });
  for (const [n, l] of LINES.entries()) {
    await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${n + 1}) .line-row`);
    await tab.waitForFunction(() => !document.getElementById('s-list').classList.contains('switching'));   // its route risen
    for (const colorScheme of ['light', 'dark']) {
      await tab.emulateMedia({ colorScheme });
      const roundel = await tab.evaluate(() => { const s = getComputedStyle(document.querySelector('#route li.done .roundel')); return { color: s.color, bg: s.backgroundColor }; });
      assert.ok(contrast(roundel.color, roundel.bg) >= 4.5, `a finished roundel's number on the ${l.name} is hard to read in ${colorScheme}: ${JSON.stringify(roundel)}`);
      // The stops not yet ridden are ringed in a pale tint of the line's colour, so a fresh line looks like that line;
      // the Main Line's colour is the ink, so its tint is a grey.
      const ring = await tab.evaluate(() => {
        const probe = document.createElement('i'); probe.style.color = 'color-mix(in srgb, var(--line) 30%, var(--bg))'; document.getElementById('route').append(probe);
        const want = getComputedStyle(probe).color; probe.remove();
        return { ring: getComputedStyle(document.querySelector('#route li.todo:not(.next) .roundel')).borderTopColor, segment: getComputedStyle(document.querySelector('#route li.todo:last-child'), '::before').backgroundColor, want };
      });
      assert.ok(ring.ring === ring.want && ring.segment === ring.want, `the ${l.name}'s stops not yet ridden should be a tint of its colour in ${colorScheme}: ${JSON.stringify(ring)}`);
      // The logo's two branch lines are the line's colour and a paler shade of it; the Main Line's are blue and red.
      const logo = await tab.evaluate(color => {
        const of = c => { const probe = document.createElement('i'); probe.style.color = c; document.body.append(probe); const v = getComputedStyle(probe).color; probe.remove(); return v; };
        const stroke = sel => getComputedStyle(document.querySelector(sel)).stroke;
        return { a: stroke('.mark-a'), b: stroke('.mark-b'), line: of(`var(--${color})`), blue: of('var(--l2)'), red: of('var(--l1)') };
      }, l.color);
      const lum = c => { const [r, g, b] = c.match(/[\d.]+/g).map(v => (c.startsWith('color(') ? v * 255 : +v)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };   // rgb() or color(srgb), as color-mix() comes out
      if (l.color === 'cross') assert.deepEqual([logo.a, logo.b], [logo.blue, logo.red], `the Main Line's logo should be blue and red in ${colorScheme}`);
      else assert.ok(logo.a === logo.line && logo.b !== logo.a && lum(logo.b) > lum(logo.a), `the ${l.name}'s logo should be its colour and a paler shade in ${colorScheme}: ${JSON.stringify(logo)}`);
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
        if ((await tab.textContent('#readout')).startsWith(`Detour: ${w.toUpperCase()},`)) earned += fareFor(w);
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
      assert.equal(await tab.textContent('#b-done-next'), `On to ${y.name.replace(/ Line$/, '')}`);
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

// On a first visit the offline copy waits for the line on show to have its detours: the service worker fetching every
// other line's at the same time would share a weak signal with them, and a word traced meanwhile would wait.
{
  server.slow = { path: 'js/detours/main.js', ms: 1500 };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const log = [], name = r => new URL(r.url()).pathname.replace(/^\//, '');
  context.on('request', r => log.push(`start ${name(r)}`));
  context.on('requestfinished', r => log.push(`end ${name(r)}`));
  const tab = await context.newPage();
  await tab.goto(base);
  await tab.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
  server.slow = null;
  const detours = log.filter(s => s.includes('js/detours/'));
  const mainIn = detours.indexOf('end js/detours/main.js'), others = detours.findIndex(s => s.startsWith('start') && !s.endsWith('/main.js'));
  assert.ok(mainIn >= 0 && others > mainIn, `another line's detours were asked for before the open line's had come: ${detours.slice(0, 5).join(', ')}`);
  await context.close();
}

// A swipe sideways on the play screen is nobody's, so it can't run on into Chrome's swipe to go Back or Forward: the
// page doesn't overscroll, the play screen only scrolls up and down (and pinches), and the map takes every touch.
{
  const { other, tab, errors } = await visitor({ options: {}, best: {}, games: {} }, { hasTouch: true, isMobile: true });
  await tab.click('#b-continue');
  const look = await tab.evaluate(() => ['html', 'body', '#s-play', '#board'].map(s => { const c = getComputedStyle(document.querySelector(s)); return [s, c.overscrollBehaviorX, c.touchAction]; }));
  assert.deepEqual(look.slice(0, 3).map(([s, o]) => [s, o]), [['html', 'none'], ['body', 'none'], ['#s-play', 'none']], 'nothing on the play screen should overscroll sideways');
  assert.deepEqual([look[2][2], look[3][2]], ['pan-y pinch-zoom', 'none'], 'the play screen should only scroll up and down, and the map take every touch');
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
// It has an id of its own, so an installed copy stays the same app whatever start_url becomes, and pictures for the
// fuller install sheet Chrome on Android shows when a manifest has a description and a screenshot. Each picture is the
// size the manifest says, and only the install sheet uses them, so the offline copy doesn't keep them.
{
  const { readFile } = await import('node:fs/promises');
  const app = JSON.parse(manifest.data);
  assert.deepEqual([app.id, manifest.manifest?.id], ['./', base], 'the manifest should give the app its id');
  assert.ok(app.description && app.screenshots?.length, 'the manifest should have a description and screenshots');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  for (const shot of app.screenshots) {
    const png = await readFile(new URL(`../${shot.src}`, import.meta.url));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, shot.sizes, `${shot.src} isn't the size the manifest says`);
    assert.ok(shot.label && shot.form_factor === 'narrow' && shot.type === 'image/png');
    assert.ok(!sw.includes(`'${shot.src}'`), `the offline copy needn't keep ${shot.src}`);
  }
}

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
  let net = 'up', release = '', drop = '', dropped = 0, gone = '';
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
    // The third release's app.js needs something only its own puzzles.js has.
    if (release === 'third' && path === '/js/app.js') body = Buffer.from(String(body).replace("import { LINES, DETOURS, PUZZLES } from './puzzles.js';", "import { LINES, DETOURS, PUZZLES, RELEASE } from './puzzles.js';"));
    if (release === 'third' && path === '/js/puzzles.js') body = Buffer.concat([body, Buffer.from("export const RELEASE = 'third';\n")]);
    // In the relaid release, a board on the Park Line has been laid out again, so its detours have changed (one, `gone`,
    // is no longer on it), and so has their fingerprint.
    if (release === 'relaid' && path === '/js/detours/park.js') body = Buffer.from(String(body).replace(/export const FOR = '\w+'/, "export const FOR = 'relaid00'").replace(` ${gone} `, ' '));
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
  // Each release keeps its copy under its own name (making it never touches the one in use), and the old one goes.
  assert.deepEqual(await page.evaluate(() => caches.keys()), ['crosstown-next']);

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
  assert.deepEqual(await page.evaluate(() => caches.keys()), ['crosstown-after']);

  // A page of a new release that comes from the network, but one of whose files doesn't (here puzzles.js, on the first
  // load and the one after), doesn't take the copy's older file to go with the new ones: the mix wouldn't run, and
  // would leave a list with a greyed Play button and nothing working. The page loads again by itself once, then says it
  // didn't load all the way, with a Reload button that brings the game once the network is back.
  release = 'third'; drop = '/js/puzzles.js';
  let loads = 0;
  const counting = f => { if (f === page.mainFrame()) loads++; };
  page.on('framenavigated', counting);
  await page.reload();
  await page.waitForSelector('#reload-line:not([hidden])', { timeout: 15000 })
    .catch(async () => assert.fail(`a page missing a file said nothing: the Play button reads "${await page.textContent('#b-continue')}"`));
  page.off('framenavigated', counting);
  assert.deepEqual(problems.filter(m => m.includes('does not provide')), [], "the page ran a new file beside the copy's older one");
  assert.equal(loads, 2, 'the page should load again by itself once, and only once');
  assert.deepEqual(await page.evaluate(() => ['b-line', 'mast-row', 'route'].filter(id => document.getElementById(id).checkVisibility())), [], 'the dead buttons should go');
  drop = '';
  await page.click('#b-reload');
  await page.waitForFunction(() => document.querySelectorAll('#route li').length > 0 && !document.getElementById('b-continue').disabled, null, { timeout: 15000 });
  assert.equal(await page.isHidden('#reload-line'), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('crosstown.reloaded')), null, 'a page that started should let the next one that doesn\'t load again by itself');

  // A page left open while a release goes out loads a line's detours when the line is shown, so it can be sent the new
  // release's, made for other boards. It doesn't check words against them (a real detour on the board on screen would
  // be "Not a word on this map"), and says a new version is out.
  const park = LINES.findIndex(l => l.id === 'park'), pq = LINES[park].puzzles[0], pd = await detourOn(pq);
  gone = pd.word; release = 'relaid';
  await page.click('#b-line'); await page.click(`#lines li:nth-child(${park + 1}) .line-row`);
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'A new version of Crosstown is out. Reload to play it', null, { timeout: 5000 })
    .catch(async () => assert.fail(`detours for other boards said "${await page.textContent('#toast')}" in the toast`));
  await page.click('#b-continue');
  assert.equal(await page.textContent('#clue'), pq.clue);
  await drag(page, pd.path);
  assert.equal(await page.textContent('#readout'), "Can’t check detours right now. Reload to play the new version");
  release = '';
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

// An error from something else on the page (an extension's script, say) before app.js has run doesn't count as the
// game failing to start: the game starts, so the list stays, and the page doesn't load itself again.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => document.addEventListener('readystatechange', () => {
    if (document.readyState !== 'interactive') return;
    const s = document.createElement('script'); s.textContent = 'throw new Error("not the game")'; document.head.append(s);
  }));
  const tab = await ctx.newPage();
  let loads = 0;
  tab.on('framenavigated', f => { if (f === tab.mainFrame()) loads++; });
  await tab.goto(base, { waitUntil: 'load' });
  await tab.waitForTimeout(300);
  assert.deepEqual(await tab.evaluate(() => [window.crosstownStarted, document.getElementById('reload-line').hidden, document.getElementById('mast-row').hidden, document.querySelectorAll('#route li').length]),
    [true, true, false, LINES[0].puzzles.length], "another script's error hid a game that started");
  assert.equal(loads, 1, "another script's error made the page load again");
  await ctx.close();
}

// The one-file copy (npm run build) plays from a file on its own: another line's detours are in it too, and nothing
// is asked of any server. Its fragment for hosts, artifact.html, takes the host's look.
{
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises');
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
    // artifact.html goes inside a page of the host's, which may set the look itself with data-theme on <html>: that
    // wins over the system's setting, either way round.
    const fragment = await readFile(join(dir, 'artifact.html'), 'utf8');
    for (const [theme, colorScheme, bg] of [['dark', 'light', 'rgb(15, 20, 27)'], ['light', 'dark', 'rgb(238, 242, 241)']]) {
      const host = join(dir, `host-${theme}.html`);
      await writeFile(host, `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${fragment}</body></html>`);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme });
      const tab = await ctx.newPage(), errors = [];
      tab.on('pageerror', e => errors.push(e.message));
      await tab.goto(pathToFileURL(host).href);
      assert.deepEqual([await tab.evaluate(() => getComputedStyle(document.body).backgroundColor), errors], [bg, []], `artifact.html under data-theme="${theme}" on a ${colorScheme} system should have the ${theme} background`);
      await ctx.close();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

await browser.close();
server.close();
console.log('all good');
