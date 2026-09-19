// Browser test for the optional Google Calendar feature, in demo mode (fake Brightspace + fake Claude/Google).
// Runs in Firefox and Chromium. Needs Playwright: PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e-gcal.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM || ROOT, 'package.json'));
const pw = require('playwright');
const CLASSES = 'classes@group.calendar.google.com', CLUBS = 'clubs@group.calendar.google.com', HOLIDAYS = 'holidays@group.v.calendar.google.com';

async function demo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ge2e-'));
  const port = 5600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: dir, DASH_TOAST_LOG: path.join(dir, 't.log') } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const post = (p, b = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const data = () => fetch(base + '/api/data').then(r => r.json());
  return { base, dir, post, data, stop: () => child.kill() };
}

async function run(browserName) {
  const s = await demo();
  await s.post('/api/state', { features: { googleCalendar: true } });
  await s.post('/api/gcal/connect');
  await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true, edit: true, todo: true }, [CLUBS]: { show: true, todo: true }, [HOLIDAYS]: { show: true, todo: true } } });
  for (let i = 0; i < 50 && !(await s.data()).gcal.syncedAt; i++) await new Promise(r => setTimeout(r, 100));
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/status of 403/.test(m.text()) && errors.push(m.text())); // the failed-save step's 403 is expected
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${String(e.message).split('\n').filter(Boolean).slice(0, 5).join(' / ')} @ ${(String(e.stack).match(/test-e2e-gcal\.mjs:(\d+)/) || [])[1]}`); process.exitCode = 1; await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close())).catch(() => {}); } };
  const reload = async () => { await page.goto(s.base); await page.waitForSelector('#todoList .item'); };
  console.log(`google calendar · ${browserName}:`);
  try {
    await reload();
    await page.click('#modeMonth');

    await step('Google events are outlined; Brightspace items stay filled', async () => {
      const g = page.locator('#calGrid .chip.gchip').first();
      await g.waitFor();
      const [gBg, bBg] = [await g.evaluate(e => getComputedStyle(e).backgroundColor), await page.locator('#calGrid .chip:not(.gchip)').first().evaluate(e => getComputedStyle(e).backgroundColor)];
      assert.match(gBg, /rgba\(0, 0, 0, 0\)|transparent/);
      assert.doesNotMatch(bBg, /rgba\(0, 0, 0, 0\)|transparent/);
      assert.match(await g.innerText(), /◷/);
      assert.equal(await page.locator('#legend .gtag').count(), 3);
    });

    await step('filter: All · Brightspace · Google', async () => {
      await page.click('.src-filter [data-src=google]');
      assert.equal(await page.locator('#calGrid .chip:not(.gchip)').count(), 0);
      assert.ok(await page.locator('#calGrid .chip.gchip').count() > 0);
      await page.click('.src-filter [data-src=brightspace]');
      assert.equal(await page.locator('#calGrid .chip.gchip').count(), 0);
      assert.ok(await page.locator('#calGrid .chip:not(.gchip)').count() > 0);
      await page.click('.src-filter [data-src=all]');
      assert.ok(await page.locator('#calGrid .chip.gchip').count() > 0 && await page.locator('#calGrid .chip:not(.gchip)').count() > 0);
      await reload();
      assert.equal(await page.getAttribute('.src-filter [data-src=all]', 'aria-pressed'), 'true'); // remembered
    });

    await step('duplicate merged: the Brightspace midterm shows "In Google", the Google copy is not drawn twice', async () => {
      const d = await s.data();
      const mid = d.items.find(i => i.title === 'Midterm 1');
      await page.goto(`${s.base}/#item=${encodeURIComponent(mid.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.match(await page.innerText('#itemBody .ginfo'), /In Google Calendar · Classes/);
      await page.keyboard.press('Escape');
      await page.click('#modeWeek');
      for (let n = 0; n < 3 && !(await page.locator('#calGrid .chip.exam').count()); n++) await page.click('#next');
      assert.equal(await page.locator('#calGrid .chip.gchip', { hasText: 'Midterm' }).count(), 0);
      await page.click('#today'); await page.click('#modeMonth');
    });

    await step('Today strip lists today\'s Google events (if any) and collapses', async () => {
      const d = await s.data();
      const today = new Date().toDateString();
      const n = d.gcal.events.filter(e => new Date(e.start).toDateString() === today).length;
      if (!n) { assert.equal(await page.locator('.today-strip').count(), 0); return; }
      assert.equal(await page.locator('.today-strip .strip-row').count(), n);
      await page.click('.today-strip .strip-head');
      assert.equal(await page.locator('.today-strip .strip-row').count(), 0);
      await page.click('.today-strip .strip-head');
    });

    await step('settings: calendars table; hiding a calendar removes its events', async () => {
      await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=gcal]');
      assert.equal(await page.locator('.gcal-table tbody tr').count(), 3);
      await page.locator('.gcal-table tbody tr', { hasText: 'Clubs' }).locator('input[type=checkbox]').first().uncheck();
      await page.waitForFunction(() => ![...document.querySelectorAll('#calGrid .chip.gchip')].some(c => c.innerText.includes('Robotics Club')));
      await page.locator('.gcal-table tbody tr', { hasText: 'Clubs' }).locator('input[type=checkbox]').first().check();
      await page.waitForFunction(() => [...document.querySelectorAll('#calGrid .chip.gchip')].some(c => c.innerText.includes('Robotics Club')), null, { timeout: 15000 });
      await page.keyboard.press('Escape');
    });

    await step('create a Google event (Add → Google event), shown while saving, then saved', async () => {
      await page.click('#btnAdd');
      await page.click('#dlgAdd .gchoice');
      const d = new Date(); d.setDate(d.getDate() + 3);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.fill('#dlgEvent input[name=title]', 'E2E study session');
      await page.fill('#dlgEvent input[name=startDate]', ymd); await page.fill('#dlgEvent input[name=startTime]', '15:00');
      await page.fill('#dlgEvent input[name=endDate]', ymd); await page.fill('#dlgEvent input[name=endTime]', '16:30');
      await page.fill('#dlgEvent input[name=location]', 'WALC 3087');
      await page.click('#dlgEvent button[value=save]');
      await page.waitForFunction(() => [...document.querySelectorAll('.chip.gchip')].some(c => c.innerText.includes('E2E study session') && !c.classList.contains('pending')), null, { timeout: 15000 });
      const fake = JSON.parse(fs.readFileSync(path.join(s.dir, 'fake-gcal.json'), 'utf8'));
      assert.ok(fake.events[CLASSES].some(e => e.summary === 'E2E study session' && e.location === 'WALC 3087'));
    });

    await step('edit it, then delete it (asks twice)', async () => {
      await page.locator('#calGrid .chip.gchip', { hasText: 'E2E study session' }).first().click();
      await page.click('#itemBody button:has-text("Edit")');
      await page.fill('#dlgEvent input[name=title]', 'E2E study session (moved)');
      await page.click('#dlgEvent button[value=save]');
      await page.waitForFunction(() => [...document.querySelectorAll('.chip.gchip')].some(c => c.innerText.includes('(moved)') && !c.classList.contains('pending')), null, { timeout: 15000 });
      await page.locator('#calGrid .chip.gchip', { hasText: '(moved)' }).first().click();
      const del = page.locator('#itemBody button.danger');
      await del.click();
      assert.equal(await page.$eval('#dlgItem', d => d.open), true, 'first click only asks');
      await del.click();
      // the chip disappears at once (optimistic); wait for Google's confirmation before checking the calendar
      await page.waitForFunction(() => /Deleted .* from Google ✓/.test(document.querySelector('.gnotice')?.textContent || ''), null, { timeout: 15000 });
      assert.equal(await page.locator('.chip.gchip', { hasText: '(moved)' }).count(), 0);
      const fake = JSON.parse(fs.readFileSync(path.join(s.dir, 'fake-gcal.json'), 'utf8'));
      const left = fake.events[CLASSES].filter(e => e.summary.startsWith('E2E study session')).map(e => e.id + ':' + e.summary);
      assert.deepEqual(left, []);
    });

    await step('a failed save shows an error that stays until dismissed, and reopens the form', async () => {
      // make the server refuse: the calendar loses "Allow edits" behind the page's back
      await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { edit: false } } });
      await page.click('#btnAdd');   // the page still thinks Classes is editable
      await page.click('#dlgAdd .gchoice');
      await page.fill('#dlgEvent input[name=title]', 'Should fail');
      await page.click('#dlgEvent button[value=save]');
      await page.waitForSelector('.gnotice.error', { timeout: 15000 });
      assert.match(await page.innerText('.gnotice.error'), /Couldn’t save “Should fail”/);
      await page.waitForFunction(() => document.querySelector('#dlgEvent').open);
      assert.match(await page.innerText('#dlgEvent'), /Google didn’t save it/);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3500); // a refresh cycle passes…
      assert.equal(await page.locator('.gnotice.error').count(), 1, '…and the error is still there');
      await page.click('.gnotice-x');
      assert.equal(await page.locator('.gnotice').count(), 0);
      await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { edit: true } } });
      await reload(); await page.click('#modeMonth');
    });

    await step('read-only calendars have no Edit/Delete', async () => {
      await page.click('.src-filter [data-src=google]');
      await page.locator('#calGrid .chip.gchip', { hasText: 'Robotics Club' }).first().click();
      assert.equal(await page.locator('#itemBody button:has-text("Edit")').count(), 0);
      assert.match(await page.innerText('#itemBody'), /Read-only here/);
      await page.keyboard.press('Escape');
      await page.click('.src-filter [data-src=all]');
    });

    await step('add a Brightspace item to Google from its details', async () => {
      const d = await s.data();
      const it = d.items.find(i => i.kind === 'assignment' && i.due && new Date(i.due) > new Date() && !i.exam);
      await page.goto(`${s.base}/#item=${encodeURIComponent(it.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      if (!(await page.locator('#itemBody .gadd').count())) throw new Error('no Add button; page sees calendars ' + JSON.stringify(await page.evaluate(() => window.dash.data.gcal.calendars.map(c => [c.summary, c.show, c.edit]))) + ' server ' + JSON.stringify((await s.data()).gcal.calendars.map(c => [c.summary, c.show, c.edit])));
      await page.click('#itemBody .gadd');
      await page.waitForFunction(() => /Added ✓/.test(document.querySelector('#itemBody .gadd-row')?.innerText || ''), null, { timeout: 15000 });
      const fake = JSON.parse(fs.readFileSync(path.join(s.dir, 'fake-gcal.json'), 'utf8'));
      assert.ok(fake.events[CLASSES].some(e => e.summary === `Due: ${it.title} (${d.courses.find(c => c.id === it.courseId).short})`));
      await page.keyboard.press('Escape');
    });

    await step('day view shows Google events as blocks', async () => {
      await page.click('#modeDay');
      for (let n = 0; n < 7 && !(await page.locator('#calGrid .day-block .chip.gchip').count()); n++) await page.click('#next');
      assert.ok(await page.locator('#calGrid .day-block .chip.gchip').count() >= 1);
      await page.click('#today'); await page.click('#modeMonth');
    });

    await step('legend badges hide a calendar or course on the calendar only, and survive a reload', async () => {
      const gchips = () => page.locator('#calGrid .chip.gchip', { hasText: 'Lecture' }).count();
      const todo = await page.locator('#todoList .item').count();
      assert.ok(await gchips() > 0);
      await page.locator('#legend .gtag', { hasText: 'Classes' }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('#calGrid .chip.gchip')].some(c => c.innerText.includes('Lecture')));
      assert.equal(await page.locator('#legend .gtag.off', { hasText: 'Classes' }).count(), 1, 'hidden badge stays, dimmed');
      const course = page.locator('#legend .tag.legend-btn').first();
      const before = await page.locator('#calGrid .chip:not(.gchip)').count();
      await course.click();
      await page.waitForFunction(n => document.querySelectorAll('#calGrid .chip:not(.gchip)').length < n, before);
      assert.equal(await page.locator('#todoList .item').count(), todo, 'to-do list unaffected');
      await reload(); await page.click('#modeMonth');
      assert.equal(await gchips(), 0, 'still hidden after reload');
      await page.locator('#legend .tag.legend-btn.off').first().click();
      await page.waitForFunction(n => document.querySelectorAll('#calGrid .chip:not(.gchip)').length === n, before); // (Classes still hidden, same room as before)
      await page.locator('#legend .gtag', { hasText: 'Classes' }).click();
      await page.waitForFunction(() => !document.querySelector('#legend .legend-btn.off'));
      assert.ok(await gchips() > 0);
    });

    await step('per-calendar "To-do" switch controls the Today list on the left; off by default and when not shown', async () => {
      await s.post('/api/gcal/settings', { calendars: { [CLUBS]: { show: false } } });
      await s.post('/api/gcal/settings', { calendars: { [CLUBS]: { show: true } } });
      assert.equal((await s.data()).gcal.calendars.find(c => c.id === CLUBS).todo, false, 'hiding a calendar turns its To-do off');
      // (events this suite created from a Brightspace item are merged into that item, so they never show in the strip)
      const todayClasses = (await s.data()).gcal.events.some(e => e.calendarId === CLASSES && !e.title.startsWith('Due: ') && new Date(e.start).toDateString() === new Date().toDateString());
      await page.click('#btnSettings'); await page.click('#settingsNav [data-feature]');
      const box = page.getByLabel('Show Classes in the to-do list');
      assert.equal(await box.isChecked(), true, '(turned on in this suite setup)');
      await box.uncheck();
      await page.waitForFunction(() => window.dash.data.gcal.calendars.find(c => c.summary === 'Classes').todo === false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.today-strip', { hasText: 'Lecture' }).count(), 0);
      await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { todo: true } } });
      await reload(); await page.click('#modeMonth');
      if (todayClasses) assert.equal(await page.locator('.today-strip').count(), 1);
    });

    await step('turning the feature off removes all of it from the page', async () => {
      await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=features]');
      await page.locator('#featureList input[type=checkbox]').first().uncheck();
      await page.waitForFunction(() => !document.querySelector('#calGrid .chip.gchip'));
      assert.equal(await page.locator('.src-filter').count(), 0);
      assert.equal(await page.locator('.today-strip').count(), 0);
      assert.equal(await page.locator('#settingsNav [data-sec=gcal]').count(), 0);
      await page.keyboard.press('Escape');
      await page.click('#btnAdd');
      assert.equal(await page.$eval('#dlgTask', d => d.open), true, '"Add" goes straight to a task again');
      await page.keyboard.press('Escape');
    });

    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally { await browser.close(); s.stop(); }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);
