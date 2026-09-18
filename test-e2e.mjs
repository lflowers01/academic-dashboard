// Browser test: clicks through the real page in Firefox and Chromium (Chrome's engine) against demo data.
// Needs Playwright (not a dependency of the dashboard): PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // not URL.pathname: that breaks on folders with spaces
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM || ROOT, 'package.json'));
const pw = require('playwright');
const SHOTS = process.env.SHOTS || os.tmpdir();

async function demoServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-e2e-'));
  const port = 4900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], {
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: dir, DASH_TOAST_LOG: path.join(dir, 'toasts.log'), ...extraEnv }, stdio: 'ignore', windowsHide: true,
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  return { base, dir, stop: () => child.kill() };
}

async function run(browserName) {
  const srv = await demoServer();
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${e.message.split('\n')[0]}`); process.exitCode = 1; } };
  const clean = t => !/\[object |(^|\s)(null|undefined|NaN)(\s|$)|Invalid Date/.test(t);
  console.log(`${browserName}:`);
  try {
    await page.goto(srv.base);
    await page.waitForSelector('#todoList .item');

    await step('renders without junk text', async () => {
      assert.ok(clean(await page.innerText('body')));
      assert.equal(await page.$eval('img.brand', i => i.complete && i.naturalWidth > 0), true);
      assert.equal(await page.$eval('.credits img', i => i.complete && i.naturalWidth > 0), true);
      assert.equal(await page.getAttribute('.credits a', 'href'), 'https://lucasflowers.net');
      assert.equal(await page.getAttribute('a.brand-link', 'href'), 'https://experience.elluciancloud.com/mypurdue');
      assert.equal(await page.getAttribute('a.brand-link', 'target'), '_blank');
      assert.equal(await page.$eval('link[rel=icon]', l => l.getAttribute('href')), '/icon.svg');
    });

    await step('exams look different (gold, labelled)', async () => {
      await page.click('#modeWeek'); await page.click('#next'); // demo exams are next week; week view shows every entry
      const chip = page.locator('#calGrid .chip.exam').first();
      await chip.waitFor();
      assert.match(await chip.innerText(), /EXAM/);
      const bg = await chip.evaluate(e => getComputedStyle(e).outlineColor);
      assert.match(bg, /207, 185, 145/); // #cfb991
      await page.click('#today'); await page.click('#modeMonth');
    });

    await step('month / week / navigation', async () => {
      await page.click('#modeWeek');
      assert.equal(await page.locator('#calGrid .dow').count(), 7);
      await page.click('#next'); await page.click('#prev'); await page.click('#today');
      assert.ok(await page.locator('#calGrid .day.is-today').count() === 1);
      await page.click('#modeMonth');
    });

    await step('+N more popup lists real rows', async () => {
      const more = page.locator('#calGrid .more').first();
      if (await more.count()) {
        await more.click();
        assert.ok(await page.locator('#dlgDay .item').count() > 3);
        assert.ok(clean(await page.innerText('#dlgDay')));
        await page.keyboard.press('Escape');
      }
    });

    await step('Enter saves a new task; Esc on edit does not duplicate', async () => {
      await page.keyboard.press('n');
      await page.fill('#taskForm input[name=title]', 'E2E task <b>x</b>');
      await page.check('#taskForm input[name=exam]');
      await page.press('#taskForm input[name=title]', 'Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('#todoList .item')].some(e => e.innerText.includes('E2E task <b>x</b>')));
      const row = page.locator('#todoList .item', { hasText: 'E2E task' });
      assert.match(await row.innerText(), /EXAM/);
      await row.locator('.main').click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const tasks = (await (await fetch(srv.base + '/api/data')).json()).tasks;
      assert.equal(tasks.filter(t => t.title.startsWith('E2E task')).length, 1);
    });

    await step('date-range task shows on each day of its range', async () => {
      const start = new Date(); start.setDate(start.getDate() + 1);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await page.click('#btnAdd');
      await page.fill('#taskForm input[name=title]', 'Range E2E');
      await page.fill('#taskForm input[name=date]', ymd(start));
      await page.fill('#taskForm input[name=endDate]', ymd(end));
      await page.click('#taskForm button[value=save]');
      await page.waitForFunction(() => [...document.querySelectorAll('#todoList .item')].some(e => e.innerText.includes('Range E2E')));
      await page.click('#modeWeek');
      if (start.getDay() === 0) await page.click('#next'); // tomorrow is Sunday → the range is in next week's row
      const bars = page.locator('#calGrid .chip.span', { hasText: 'Range E2E' });
      const crosses = end.getDay() === 0; // Sat→Sun splits across two week rows
      assert.equal(await bars.count(), 1, 'one bar per week row, not one box per day');
      if (!crosses) assert.match(await bars.first().evaluate(e => e.style.gridColumn), /span 2/);
      await page.click('#today'); await page.click('#modeMonth');
      assert.equal(await page.locator('#calGrid .chip.range', { hasText: 'Range E2E' }).count() >= 1, true);
      await page.locator('#todoList .item', { hasText: 'Range E2E' }).locator('.main').click();
      assert.equal(await page.inputValue('#taskForm input[name=endDate]'), ymd(end));
      await page.click('#taskDelete');
      await page.waitForTimeout(400);
    });

    await step('Delete removes the task for good', async () => {
      await page.locator('#todoList .item', { hasText: 'E2E task' }).locator('.main').click();
      await page.click('#taskDelete');
      await page.waitForTimeout(500);
      const tasks = (await (await fetch(srv.base + '/api/data')).json()).tasks;
      assert.equal(tasks.length, 0);
    });

    await step('Cancel button and Ctrl+N', async () => {
      await page.keyboard.press('n');
      await page.fill('#taskForm input[name=title]', 'should not save');
      await page.click('#taskForm button:has-text("Cancel")');
      await page.keyboard.press('Control+n'); // must not open the form
      await page.waitForTimeout(300);
      assert.equal(await page.$eval('#dlgTask', d => d.open), false);
      const tasks = (await (await fetch(srv.base + '/api/data')).json()).tasks;
      assert.equal(tasks.length, 0);
    });

    await step('check off and undo', async () => {
      const row = page.locator('#todoList .group.tomorrow .item').first();
      const title = await row.locator('.title').innerText();
      await row.locator('input[type=checkbox]').check();
      await page.waitForTimeout(400);
      const state = (await (await fetch(srv.base + '/api/data')).json()).state;
      assert.equal(Object.values(state.done).filter(Boolean).length, 1);
      // done rows due tomorrow drop out of the list; undo via the calendar chip
      await page.locator('#calGrid .chip.done', { hasText: title.replace(/^\S+( \d+)?( Lab)? /, '').slice(0, 10) }).first().click();
      await page.locator('#dlgItem input[type=checkbox]').uncheck();
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      const s2 = (await (await fetch(srv.base + '/api/data')).json()).state;
      assert.equal(Object.keys(s2.done).length, 0);
    });

    await step('notes render markdown safely and can be edited again', async () => {
      const { items } = await (await fetch(srv.base + '/api/data')).json();
      const it = items.find(i => i.kind === 'quiz' && i.due);
      await page.goto(`${srv.base}/#item=${encodeURIComponent(it.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      await page.fill('#itemBody .note-box', '**Room** ELLT 116\n- [ ] bring calc\n[syllabus](https://purdue.edu)\n<img src=x onerror=alert(1)>');
      await page.locator('#itemBody .note-box').blur();
      await page.waitForSelector('#itemBody .note-view:not([hidden])');
      assert.equal(await page.locator('#itemBody .note-view strong').innerText(), 'Room');
      assert.equal(await page.locator('#itemBody .note-view li.task input[type=checkbox]').count(), 1);
      assert.equal(await page.locator('#itemBody .note-view a').getAttribute('href'), 'https://purdue.edu');
      assert.equal(await page.locator('#itemBody .note-view img').count(), 0); // HTML stays text
      await page.click('#itemBody .note-view strong');
      assert.equal(await page.isVisible('#itemBody .note-box'), true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      assert.match((await (await fetch(srv.base + '/api/data')).json()).state.notes[it.id], /^\*\*Room\*\*/);
    });

    await step('notes on a Brightspace item save and come back after a reload', async () => {
      const { items } = await (await fetch(srv.base + '/api/data')).json();
      const it = items.find(i => i.kind === 'assignment' && i.due && new Date(i.due) > new Date());
      await page.goto(`${srv.base}/#item=${encodeURIComponent(it.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      await page.fill('#itemBody .note-box', 'Room ELLT 116 <script>x</script>');
      await page.waitForFunction(() => document.querySelector('.note-status').textContent === 'Saved');
      await page.keyboard.press('Escape');
      assert.equal((await (await fetch(srv.base + '/api/data')).json()).state.notes[it.id], 'Room ELLT 116 <script>x</script>');
      await page.reload(); await page.waitForSelector('#todoList .item');
      assert.ok(await page.locator(`#todoList .item[data-id="${it.id}"] .note-mark`).count() === 1);
      await page.goto(`${srv.base}/#item=${encodeURIComponent(it.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.equal(await page.inputValue('#itemBody .note-box'), 'Room ELLT 116 <script>x</script>');
      assert.equal(await page.innerText('#itemBody .note-view'), 'Room ELLT 116 <script>x</script>'); // shown as text
      // typing then closing right away still saves (flush on close)
      await page.click('#itemBody .note-edit');
      await page.fill('#itemBody .note-box', 'changed fast');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      assert.equal((await (await fetch(srv.base + '/api/data')).json()).state.notes[it.id], 'changed fast');
      // clearing removes it
      await page.goto(`${srv.base}/#item=${encodeURIComponent(it.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      await page.click('#itemBody .note-edit');
      await page.fill('#itemBody .note-box', '');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      assert.equal((await (await fetch(srv.base + '/api/data')).json()).state.notes[it.id], undefined);
    });

    await step('item details open with instructions', async () => {
      await page.locator('#todoList .item .main').first().click();
      assert.ok(await page.$eval('#dlgItem', d => d.open));
      assert.ok(clean(await page.innerText('#dlgItem')));
      await page.keyboard.press('Escape');
    });

    await step('courses dialog hides and restores a course', async () => {
      await page.click('#btnCourses');
      const before = await page.locator('#legend .tag').count();
      await page.locator('#courseList input[type=checkbox]:checked').first().uncheck();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#legend .tag').count(), before - 1);
      await page.click('#courseReset');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#legend .tag').count(), before);
      await page.keyboard.press('Escape');
    });

    await step('announced exam links to its announcement in Brightspace', async () => {
      const { items } = await (await fetch(srv.base + '/api/data')).json();
      const ex = items.find(i => i.kind === 'exam');
      await page.goto(`${srv.base}/#item=${encodeURIComponent(ex.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      const link = page.locator('#itemBody a', { hasText: 'announcement in Brightspace' });
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('href'), `https://purdue.brightspace.com/d2l/le/news/${ex.courseId}/${ex.sourceAnnouncement}/view?ou=${ex.courseId}`);
      await page.keyboard.press('Escape');
    });

    await step('clicking an announcement opens it in full with a Brightspace link', async () => {
      await page.click('#tabAnn');
      const card = page.locator('.ann').first();
      const title = await card.locator('h3').innerText();
      await card.click();
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.ok((await page.innerText('#itemBody h2')).includes(title));
      const link = page.locator('#itemBody a', { hasText: 'Open in Brightspace' });
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('href'), /\/d2l\/le\/news\/\d+\/\d+\/view/);
      await page.keyboard.press('Escape');
      await page.click('#tabCal');
    });

    await step('past-due assignment links to the course list; open one links straight to it', async () => {
      const { items } = await (await fetch(srv.base + '/api/data')).json();
      const past = items.find(i => i.kind === 'assignment' && i.url && i.due && new Date(i.due) < new Date());
      const open = items.find(i => i.kind === 'assignment' && i.url && i.due && new Date(i.due) > new Date());
      await page.goto(`${srv.base}/#item=${encodeURIComponent(past.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.match(await page.locator('#itemBody .links a').first().getAttribute('href'), /folders_list\.d2l\?ou=\d+&isprv=0$/);
      assert.equal(await page.locator('#itemBody .links a.minor').getAttribute('href'), past.url);
      await page.keyboard.press('Escape');
      await page.goto(`${srv.base}/#item=${encodeURIComponent(open.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.equal(await page.locator('#itemBody .links a').count(), 1);
      assert.equal(await page.locator('#itemBody .links a').getAttribute('href'), open.url);
      await page.keyboard.press('Escape');
    });

    await step('exams in Boilerexams courses get "Study on Boilerexams"; others do not', async () => {
      const d = await (await fetch(srv.base + '/api/data')).json();
      const withBE = d.items.find(i => i.exam && d.boilerexams[i.courseId]);
      const without = d.items.find(i => !i.exam && d.boilerexams[i.courseId]);
      await page.goto(`${srv.base}/#item=${encodeURIComponent(withBE.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      const btn = page.locator('#itemBody .study-btn');
      assert.equal(await btn.innerText(), 'Study on Boilerexams ↗');
      assert.equal(await btn.getAttribute('href'), `https://boilerexams.com/courses/${d.boilerexams[withBE.courseId]}/exams`);
      assert.equal(await btn.getAttribute('target'), '_blank');
      await page.keyboard.press('Escape');
      await page.goto(`${srv.base}/#item=${encodeURIComponent(without.id)}`); // not an exam → no button
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.equal(await page.locator('#itemBody .study-btn').count(), 0);
      await page.keyboard.press('Escape');
    });

    await step('announcements tab, unread badge, mark read', async () => {
      assert.equal(await page.isVisible('#annBadge'), true);
      await page.click('#tabAnn');
      assert.ok(await page.locator('.ann').count() >= 3);
      assert.ok(!(await page.innerText('#annList')).includes('<b>'));
      await page.click('#btnMarkRead');
      await page.waitForTimeout(400);
      assert.equal(await page.isVisible('#annBadge'), false);
      await page.click('#tabCal');
    });

    await step('notifications dialog: toggle + test', async () => {
      await page.click('#btnNotify');
      await page.click('#notifyTest');
      await page.waitForFunction(() => document.querySelector('#notifyResult').textContent.startsWith('Sent'));
      assert.match(fs.readFileSync(path.join(srv.dir, 'toasts.log'), 'utf8'), /Notifications are working/);
      await page.uncheck('#notifyToggle');
      await page.waitForTimeout(300);
      assert.equal((await (await fetch(srv.base + '/api/data')).json()).state.notifications, false);
      await page.check('#notifyToggle');
      await page.keyboard.press('Escape');
    });

    await step('clicking an empty day opens the add-task form for that day', async () => {
      await page.click('#modeMonth');
      const empty = page.locator('#calGrid .day-items:not(:has(.chip, .more))').first();
      await empty.click();
      assert.equal(await page.$eval('#dlgTask', d => d.open), true);
      assert.match(await page.inputValue('#taskForm input[name=date]'), /^\d{4}-\d{2}-\d{2}$/);
      await page.keyboard.press('Escape');
      assert.equal((await (await fetch(srv.base + '/api/data')).json()).tasks.length, 0);
    });

    await step('notification links open an item / highlight items', async () => {
      const { items } = await (await fetch(srv.base + '/api/data')).json();
      const target = items.find(i => i.due && i.kind === 'assignment');
      await page.goto(`${srv.base}/#item=${encodeURIComponent(target.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      assert.match(await page.innerText('#itemBody h2'), new RegExp(target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await page.evaluate(() => location.hash), ''); // handled once
      await page.keyboard.press('Escape');
      const two = items.filter(i => i.due && i.kind === 'assignment' && new Date(i.due) > new Date()).slice(0, 2);
      await page.goto(`${srv.base}/#due=${two.map(i => encodeURIComponent(i.id)).join(',')}`);
      await page.waitForSelector('#todoList .item.flash');
      assert.equal(await page.locator('#todoList .item.flash').count(), two.length);
    });

    await step('narrow window stacks, no horizontal scroll', async () => {
      await page.setViewportSize({ width: 700, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.setViewportSize({ width: 1440, height: 950 });
    });

    await page.screenshot({ path: path.join(SHOTS, `e2e-${browserName}.png`) });
    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally {
    await browser.close();
    srv.stop();
  }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);

// Windows notifications switched off → the page must say so and offer the settings button.
{
  const srv = await demoServer({ DASH_NOTIFY_BLOCK: 'system' });
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(srv.base); await page.waitForSelector('#todoList .item');
    assert.match(await page.innerText('#btnNotify'), /blocked/);
    await page.click('#btnNotify');
    assert.equal(await page.isVisible('#notifyBlocked'), true);
    assert.match(await page.innerText('#notifyBlocked'), /switched off for your whole PC/);
    await page.click('#notifyTest');
    await page.waitForFunction(() => document.querySelector('#notifyResult').textContent.startsWith('Not sent'));
    console.log('blocked notifications:');
    console.log('  ✔ page explains it and offers Windows settings');
  } catch (err) { console.log('blocked notifications:'); console.log('  ✖ ' + String(err.message).split(/\r?\n/)[0]); process.exitCode = 1; }
  finally { await browser.close(); srv.stop(); }
}
