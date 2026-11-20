// Saving to Google Drive, through a stand-in for Google (test/fake-google.mjs, from the junkdrawer.works kit):
// node test/drive.mjs  (needs Playwright). Each browser context is a device; contexts given the same fake share one
// Drive. The page only offers Drive at crosstown.junkdrawer.works, so the tests add this server's address to that list.
import assert from 'node:assert/strict';
import { playwright, serve, drag } from '../tools/play.mjs';
import { LINES } from '../js/puzzles.js';
import { fakeGoogle } from './fake-google.mjs';

const { server, base } = serve();
const origin = new URL(base).origin;
const browser = await playwright.chromium.launch();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const [MAIN, MARKET, PARK] = LINES.map(l => l.puzzles);
const finished = q => ({ found: q.lines.map((_, k) => k), detours: [], spent: 0, done: true, crossAt: 0 });
// Mark's progress: every Main Line puzzle finished, as it is on his phone.
const marks = () => ({ options: { line: LINES[0].id }, games: Object.fromEntries(MAIN.map(q => [q.id, finished(q)])), best: { [MAIN[0].id]: 61000 }, stars: {} });
const problems = [];

async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* not yet */ }
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
// A device: a browser context with `state` saved (once: not again on a reload or in a second tab), sharing the fake
// Google `g`. Without `g`, the page is left as it is, so Drive should be nowhere.
async function device(state, g, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...options });
  await ctx.addInitScript(s => { if (s && !localStorage.getItem('__seeded')) { localStorage.setItem('crosstown.v1', s); localStorage.setItem('__seeded', '1'); } }, state ? JSON.stringify(state) : '');
  if (g) await g.install(ctx, { rewrite: { '**/js/sync.js': s => s.replace("['https://crosstown.junkdrawer.works']", `['https://crosstown.junkdrawer.works', '${origin}']`) } });
  const tab = await open(ctx);
  return { ctx, tab };
}
async function open(ctx) {
  const tab = await ctx.newPage();
  tab.on('pageerror', e => problems.push(e.message));
  // (A sign-in Google refuses shows as a failed request, which is what's being tested there.)
  tab.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(m.text()); });
  await tab.goto(base);
  await tab.evaluate(() => document.fonts.ready);
  return tab;
}
const stored = tab => tab.evaluate(() => JSON.parse(localStorage.getItem('crosstown.v1') || '{}'));
const syncState = tab => tab.evaluate(() => JSON.parse(localStorage.getItem('crosstown.sync') || '{}'));
const dot = tab => tab.getAttribute('#b-cloud', 'data-s');
const finishedHere = async tab => Object.entries((await stored(tab)).games || {}).filter(([, x]) => x.done).map(([id]) => id);
async function turnOn(tab) {
  await tab.click('#b-list-menu');
  await tab.locator('#drive-card:not([hidden])').waitFor();
  await tab.waitForFunction(() => !!window.google);
  await tab.click('#drive-card [data-a="on"]');
  await until(async () => (await syncState(tab)).last > 0 && await dot(tab) === 'ok', 'the first sync');
  await tab.keyboard.press('Escape');
}
async function syncNow(tab) {
  const before = (await syncState(tab)).last || 0;
  await tab.click('#b-cloud');
  await until(async () => ((await syncState(tab)).last || 0) > before && await dot(tab) === 'ok', 'a sync');
}
// A sync on a device showing a puzzle, where the cloud isn't: the one that comes when the page is back on screen, its
// last sync made to look a while ago (from a tab of the same device that isn't the game).
async function syncOnScreen(dev) {
  const nudge = await dev.ctx.newPage();
  await nudge.goto(base + 'icon.svg');
  await nudge.evaluate(() => { const s = JSON.parse(localStorage.getItem('crosstown.sync')); s.last = 1; localStorage.setItem('crosstown.sync', JSON.stringify(s)); });
  await nudge.close();
  await dev.tab.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}
const pick = async (tab, n) => { await tab.click('#b-line'); await tab.click(`#lines li:nth-child(${n}) .line-row`); };
async function finish(tab, q, n) {
  await tab.click(`#route li:nth-child(${n}) .row`);
  for (const path of q.lines) await drag(tab, path);
  await tab.waitForSelector('#sheet-done:not([hidden])');
  await tab.keyboard.press('Escape'); await tab.click('#b-back');
}

// ---- nowhere but crosstown.junkdrawer.works ----
// Here (localhost, as the one-file copy and any other address would be) there's no card, no cloud and no call to Google.
{
  const { ctx, tab } = await device(marks());
  const asked = [];
  tab.on('request', r => { if (!r.url().startsWith(base)) asked.push(r.url()); });
  await tab.click('#b-list-menu');
  assert.deepEqual([await tab.isHidden('#drive-card'), await tab.isHidden('#b-cloud')], [true, true], 'Drive should show only at crosstown.junkdrawer.works');
  await tab.waitForTimeout(300);
  assert.deepEqual(asked, [], 'nothing should be asked of Google away from crosstown.junkdrawer.works');
  await ctx.close();
}

// Run once with each device turning Drive on first: Mark's 108 finished Main Line puzzles come through either way.
for (const order of ['phone first', 'phone second']) {
  const g = fakeGoogle();
  const driveFile = () => g.files().find(f => f.appProperties?.crosstown === 'sync' && !f.trashed);
  const driveDoc = () => JSON.parse(driveFile().body);
  // The phone has them all. The laptop erased everything once, long before Drive, then started Main No. 1 (a line
  // found), finished Market No. 1, and started Main No. 2 over (finished on the phone).
  const laptopState = { options: { night: true, line: LINES[1].id }, erasedAt: Date.now() - 9e6, cleared: { [MAIN[1].id]: Date.now() - 5e6 },
    best: { [MAIN[0].id]: 45000 }, stars: { [MAIN[1].id]: 2 },
    games: { [MAIN[0].id]: { found: [1], detours: [], began: Date.now() - 4e6 }, [MARKET[0].id]: finished(MARKET[0]) } };
  const phone = await device(marks(), g), laptop = await device(laptopState, g, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const P = phone.tab, L = laptop.tab;
  const [one, two] = order === 'phone first' ? [P, L] : [L, P];

  // ---- turning it on ----
  await turnOn(one);
  assert.deepEqual(await one.evaluate(() => window.__prompts), [{ prompt: 'select_account' }], 'the first time, Google asks which account');
  assert.equal(await one.evaluate(() => window.__cfg.scope), SCOPE, 'drive.file and nothing else');
  const shared = await one.evaluate(() => JSON.parse(localStorage.getItem('junkdrawer.google')));
  assert.deepEqual([shared.token, shared.email, shared.scope.includes(SCOPE), shared.exp > Date.now() + 50 * 60000], ['tok-mark', 'mark@gmail.com', true, true], 'the sign-in is kept for an hour, with its account');
  await one.click('#b-list-menu');
  assert.match(await one.locator('#drive-card').innerText(), /mark@gmail\.com/);
  await one.keyboard.press('Escape');
  {
    const folders = g.files().filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    assert.deepEqual(folders.map(f => [f.name, f.appProperties]), [['Crosstown', { crosstown: 'folder' }]], 'one folder, named Crosstown');
    const file = driveFile();
    assert.deepEqual([file.name, file.parents, g.files().length], ['Crosstown.json', [folders[0].id], 2], 'one file, in the folder, and nothing else in Drive');
    const d = driveDoc();
    assert.deepEqual(Object.keys(d).sort(), ['app', 'best', 'cleared', 'erasedAt', 'games', 'stars', 'version'], 'the file holds progress, and none of a device’s options');
    assert.equal(d.app, 'crosstown');
    assert.ok(!file.body.includes('mark@gmail.com') && !file.body.includes('tok-'), 'no account details in the file');
    assert.ok(g.calls.every(c => !/[?&]q=[^&]*name/.test(c)), 'never searches by name');
  }
  assert.equal(await one.isVisible('#b-cloud'), true, 'the list shows the cloud once Drive is on');

  // ---- a second device joining ----
  await turnOn(two);
  for (const [tab, name] of [[P, 'phone'], [L, 'laptop']]) {
    await syncNow(tab);
    const s = await stored(tab), done = new Set(await finishedHere(tab));
    assert.ok(MAIN.every(q => done.has(q.id)), `every Main Line puzzle should still be finished on the ${name} (${order})`);
    assert.equal(done.has(MARKET[0].id), true, `Market No. 1 should come over to the ${name} (${order})`);
    assert.deepEqual([s.best[MAIN[0].id], s.stars[MAIN[1].id]], [45000, 2], `the faster time and the stars should reach the ${name}`);
    assert.equal(s.games[MAIN[1].id]?.done, true, `a puzzle started over before Drive was on should not take the other device’s game, on the ${name}`);
  }
  // Nor afterwards, from either device.
  await syncNow(one); await syncNow(two);
  for (const tab of [P, L]) assert.equal((await stored(tab)).games[MAIN[1].id]?.done, true, 'a puzzle started over before Drive was on should keep the other device’s game at the next sync');
  assert.deepEqual([(await stored(P)).options.night, (await stored(L)).options.night, (await stored(L)).options.line], [false, true, LINES[1].id], 'each device keeps its own options');
  assert.equal(Object.values(driveDoc().games).filter(x => x.done).length, MAIN.length + 1, 'Drive has every finished puzzle');
  // A sync with nothing new writes nothing.
  {
    const v = driveFile().version;
    await syncNow(P); await syncNow(L);
    assert.equal(driveFile().version, v, 'a sync with nothing new should leave the Drive copy alone');
  }
  // The page shows what came, without a reload.
  await pick(P, 2);
  assert.match(await P.getAttribute('#route li:nth-child(1)', 'class'), /^done\b/, 'the phone’s list should show the laptop’s Market No. 1');
  if (order === 'phone second') { await phone.ctx.close(); await laptop.ctx.close(); continue; }

  // ---- both playing different puzzles, and the same one ----
  // The phone finishes Market No. 2 and finds two lines of Park No. 1; the laptop finds another line of Park No. 1.
  await finish(P, MARKET[1], 2);
  await pick(P, 3); await P.click('#route li:nth-child(1) .row'); await drag(P, PARK[0].lines[1]); await drag(P, PARK[0].lines[2]); await P.click('#b-back');
  await pick(L, 3); await L.click('#route li:nth-child(1) .row'); await drag(L, PARK[0].lines[3]); await L.click('#b-back');
  // Each sends its own shortly after it saves; at the same time, one has to read, put together and try again.
  await Promise.all([syncNow(P), syncNow(L)]);
  await syncNow(P); await syncNow(L);
  for (const [tab, name] of [[P, 'phone'], [L, 'laptop']]) {
    const s = await stored(tab);
    assert.equal(s.games[MARKET[1].id]?.done, true, `Market No. 2 should reach the ${name}`);
    assert.deepEqual(s.games[PARK[0].id]?.found.slice().sort(), [1, 2, 3], `Park No. 1 should have the lines found on both devices, on the ${name}`);
  }
  assert.equal(await L.textContent('#route li:nth-child(1) .row-sub'), `3 of ${PARK[0].lines.length} lines found`, 'the laptop’s list should show the lines found on the phone');
  assert.deepEqual(driveDoc().games[PARK[0].id].found.slice().sort(), [1, 2, 3]);
  // The phone has Park No. 1 open when the laptop finds another line of it: at its next sync the phone shows it, and
  // says where it came from.
  await P.click('#route li:nth-child(1) .row');
  await L.click('#route li:nth-child(1) .row'); await drag(L, PARK[0].lines[4]); await L.click('#b-back');
  await syncNow(L);
  await syncOnScreen(phone);
  await until(async () => await P.textContent('#readout') === 'Played on another device', 'the phone to take in the line found on the laptop');
  assert.equal(await P.textContent('#count'), `4 of ${PARK[0].lines.length} lines`);
  await P.click('#b-back');

  // ---- a puzzle started over ----
  // The laptop plays Main No. 3 again (finished): it stays started over on the phone, with its stars, and doesn't come
  // back from Drive. The phone has it open on its finished map, so that starts afresh too, and says so.
  await pick(P, 1); await P.click('#route li:nth-child(3) .row');
  await pick(L, 1); await L.click('#route li:nth-child(3) .row');
  await L.click('#b-menu'); await L.click('#m-restart'); await L.click('#m-restart');
  await L.click('#b-back');
  await syncNow(L);
  assert.equal(driveDoc().games[MAIN[2].id], undefined, 'Drive should drop the game a puzzle started over replaced');
  assert.ok(driveDoc().cleared[MAIN[2].id] > 0, 'Drive keeps when it was started over');
  await P.click('#b-back');   // leaving saves the finished game the phone had open, as it always has
  await syncNow(P);
  let s = await stored(P);
  assert.deepEqual([s.games[MAIN[2].id]?.done ?? false, s.stars[MAIN[2].id]], [false, 3], 'the phone should have Main No. 3 started over, its 3 stars kept');
  assert.equal(await P.textContent('#route li:nth-child(3) .row-go'), 'Replay');
  await syncNow(L);
  assert.equal((await stored(L)).games[MAIN[2].id]?.done ?? false, false, 'the game started over should not come back to the laptop');
  // A game begun after it was started over comes through as usual.
  await L.click('#route li:nth-child(3) .row'); await drag(L, MAIN[2].lines[1]); await L.click('#b-back');
  await syncNow(L); await syncNow(P);
  assert.deepEqual((await stored(P)).games[MAIN[2].id]?.found, [1], 'a game begun after the start-over should reach the phone');
  // The phone, on a puzzle's finished map when another device starts it over, starts afresh at its next sync, and
  // says so.
  await P.click('#route li:nth-child(4) .row');
  await L.click('#route li:nth-child(4) .row'); await L.click('#b-menu'); await L.click('#m-restart'); await L.click('#m-restart'); await L.click('#b-back');
  await syncNow(L);
  await syncOnScreen(phone);
  await until(async () => await P.textContent('#readout') === 'Started over on another device', 'the phone to start the puzzle afresh');
  assert.deepEqual([await P.textContent('#count'), await P.locator('#board .line').count()], [`0 of ${MAIN[3].lines.length} lines`, 0], 'a puzzle started over on another device should start afresh on screen');
  await P.click('#b-back');
  await syncNow(P);
  assert.equal((await stored(P)).games[MAIN[3].id]?.done ?? false, false, 'leaving it should not bring the old game back');

  // ---- erasing every line ----
  // The phone erases: every game goes from Drive and from the laptop, and nothing comes back from the laptop.
  await P.click('#b-list-menu'); await P.click('#m-erase');
  assert.equal(await P.textContent('#m-erase'), 'Tap again to erase every device', 'with Drive on, the second tap should say the erase reaches every device');
  await P.click('#m-erase');
  await syncNow(P);
  assert.deepEqual([driveDoc().games, driveDoc().best, driveDoc().stars], [{}, {}, {}], 'an erase should empty the Drive copy');
  await syncNow(L);
  s = await stored(L);
  assert.deepEqual([s.games, s.best, s.stars], [{}, {}, {}], 'an erase on the phone should reach the laptop');
  assert.equal(await L.textContent('#tally'), `${MAIN.length} puzzles`, 'the laptop’s list should empty');
  await syncNow(P);
  assert.deepEqual((await stored(P)).games, {}, 'nothing should come back to the phone');
  // Played after the erase, on either device, it syncs as before, and isn't erased again.
  await pick(L, 3); await finish(L, PARK[1], 2);
  await syncNow(L); await syncNow(P); await syncNow(L);
  assert.deepEqual([await finishedHere(P), await finishedHere(L)], [[PARK[1].id], [PARK[1].id]], 'a puzzle finished after the erase should stay on both');

  // ---- two tabs on one device ----
  // A second tab on the laptop hears what the first one synced.
  const L2 = await open(laptop.ctx);
  await pick(P, 3); await finish(P, PARK[2], 3);
  await syncNow(P); await syncNow(L);
  await until(async () => /^done\b/.test(await L2.getAttribute('#route li:nth-child(3)', 'class')), 'the laptop’s second tab to show the synced puzzle');
  await L2.close();

  // ---- saved here while a sync is under way ----
  // Progress loaded from a file while a sync is still reading Drive isn't written over by what the sync read before:
  // the sync puts the two together again. (The laptop has played something first, so the sync has something to write.)
  {
    await L.click('#route li:nth-child(7) .row'); await drag(L, PARK[6].lines[1]); await L.click('#b-back');
    await syncNow(L);
    let hold = true;
    const slow = async route => { if (hold && route.request().url().includes('alt=media')) await new Promise(r => setTimeout(r, 1500)); return route.fallback(); };
    await phone.ctx.route('https://www.googleapis.com/**', slow);
    const before = (await syncState(P)).last || 0;
    await P.click('#b-cloud');
    await until(async () => await dot(P) === 'busy', 'a sync to start');
    await P.click('#b-list-menu');
    const [chooser] = await Promise.all([P.waitForEvent('filechooser'), P.click('#m-load')]);
    await chooser.setFiles({ name: 'crosstown-progress.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ app: 'crosstown', version: 1, games: { [PARK[5].id]: finished(PARK[5]) }, best: {}, stars: {} })) });
    await P.waitForFunction(() => document.getElementById('m-load').textContent.startsWith('Tap again'));
    await P.click('#m-load');
    assert.equal(await dot(P), 'busy', 'the file should be loaded while the sync is still reading Drive');
    hold = false;
    await until(async () => (await syncState(P)).last > before && await dot(P) === 'ok' && driveDoc().games[PARK[5].id]?.done, 'the loaded puzzle to reach Drive');
    const s = await stored(P);
    assert.deepEqual([s.games[PARK[5].id]?.done, s.games[PARK[6].id]?.found], [true, [1]], 'a puzzle loaded during a sync should stay on the phone, with what the sync brought');
    await phone.ctx.unroute('https://www.googleapis.com/**', slow);
  }

  // ---- an expired sign-in needs a tap ----
  await L.evaluate(() => localStorage.setItem('junkdrawer.google', JSON.stringify({ token: 'tok-expired', exp: Date.now() + 30 * 60000, scope: 'https://www.googleapis.com/auth/drive.file', email: 'mark@gmail.com' })));
  await L.reload();
  await until(async () => await dot(L) === 'tap', 'the red dot');
  assert.equal(await L.evaluate(() => localStorage.getItem('junkdrawer.google')), null, 'a refused sign-in is cleared');
  const beforeTap = driveFile().version;
  await L.click('#route li:nth-child(4) .row'); await drag(L, PARK[3].lines[1]); await L.click('#b-back');
  await L.waitForTimeout(1800);
  assert.equal(driveFile().version, beforeTap, 'nothing reaches Drive while signed out');
  await L.waitForFunction(() => !!window.google);
  await L.click('#b-cloud');
  await until(async () => await dot(L) === 'ok' && driveFile().version > beforeTap, 'signing back in to sync');
  assert.deepEqual(await L.evaluate(() => window.__prompts.at(-1)), { prompt: '', login_hint: 'mark@gmail.com' }, 'straight back in, no account chooser');
  assert.deepEqual(driveDoc().games[PARK[3].id]?.found, [1]);

  // ---- a sign-in reused from another junkdrawer.works project ----
  // A new device at this address with a good sign-in already there turns Drive on without Google's window.
  const tablet = await device(null, g);
  await tablet.tab.evaluate(() => localStorage.setItem('junkdrawer.google', JSON.stringify({ token: 'tok-mark', exp: Date.now() + 40 * 60000, scope: 'https://www.googleapis.com/auth/drive.file', email: 'mark@gmail.com' })));
  await tablet.tab.reload();
  await turnOn(tablet.tab);
  assert.equal(await tablet.tab.evaluate(() => window.__prompts), undefined, 'no Google window with a good sign-in to hand');
  assert.deepEqual((await finishedHere(tablet.tab)).sort(), [PARK[1].id, PARK[2].id, PARK[5].id].sort(), 'the new device gets the progress');
  await tablet.ctx.close();

  // ---- two files made at once ----
  // Two devices that each made the file at the same moment: the second is folded into the first and binned.
  {
    const first = driveFile();
    const id = 'f' + g.drive.next++;
    g.drive.files[id] = { ...first, version: 1, modified: Date.now() + 1, body: JSON.stringify({ app: 'crosstown', version: 1, games: { [PARK[4].id]: finished(PARK[4]) }, best: {}, stars: {}, cleared: {}, erasedAt: 0 }) };
    await syncNow(P);
    assert.equal(g.files().filter(f => f.appProperties?.crosstown === 'sync' && !f.trashed).length, 1, 'one file left');
    assert.equal(driveFile().id, first.id, 'the first file is the one kept');
    assert.equal(driveDoc().games[PARK[4].id]?.done, true, 'with what was in the second');
    assert.ok(g.calls.some(c => c.startsWith('GET /drive/v3/files/' + first.id + '?fields=version')), 'the version is checked before a write');
  }

  // ---- stopping ----
  await L.click('#b-list-menu');
  await L.click('#drive-card [data-a="off"]');
  assert.equal(await L.textContent('#drive-card [data-a="off"]'), 'Tap again to stop');
  await L.click('#drive-card [data-a="off"]');
  await L.keyboard.press('Escape');
  assert.equal(await L.isHidden('#b-cloud'), true, 'the cloud goes once Drive is off');
  assert.equal(await L.evaluate(() => window.__revoked), undefined, 'stopping never revokes: that would sign every project out');
  assert.ok(await L.evaluate(() => localStorage.getItem('junkdrawer.google')), 'the shared sign-in stays for the other projects');
  const calls = g.calls.length;
  await L.click('#route li:nth-child(5) .row'); await drag(L, PARK[4].lines[1]); await L.click('#b-back');
  await L.waitForTimeout(1800);
  assert.equal(g.calls.length, calls, 'nothing goes to Drive once it’s off on this device');
  assert.deepEqual(problems, []);
  await phone.ctx.close(); await laptop.ctx.close();
}

assert.deepEqual(problems, []);
await browser.close();
server.close();
console.log('drive good');
