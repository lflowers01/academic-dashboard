// Browser test for the optional Smart Announcements feature, in demo mode (fake Brightspace + fake Claude).
// Runs in Firefox and Chromium. Needs Playwright: PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e-smart.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM || ROOT, 'package.json'));
const pw = require('playwright');
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });

async function demo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-se2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: dir, DASH_TOAST_LOG: path.join(dir, 't.log') } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const data = () => fetch(base + '/api/data').then(r => r.json());
  return { base, data, stop: () => child.kill() };
}

async function run(browserName) {
  const s = await demo();
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(m.text())); // the refused bad time is expected
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${String(e.message).split('\n').filter(Boolean).slice(0, 4).join(' / ')} @ ${(String(e.stack).match(/test-e2e-smart\.mjs:(\d+)/) || [])[1]}`); process.exitCode = 1; await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close())).catch(() => {}); } };
  const card = () => page.locator('.smart-card');
  const toggle = async () => {
    await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=features]');
    await page.locator('#featureList .feature-row', { hasText: 'Smart Announcements' }).locator('input[type=checkbox]').click();
    await page.keyboard.press('Escape');
  };
  console.log(`smart announcements · ${browserName}:`);
  try {
    await page.goto(s.base); await page.waitForSelector('#todoList .item');

    await step('off by default: no card, no found events', async () => {
      assert.equal(await card().count(), 0);
      assert.equal((await s.data()).items.some(i => i.kind === 'event'), false);
    });

    await step('turning it on scans right away: sure class events are added, the rest wait in the card', async () => {
      await toggle();
      await card().waitFor({ timeout: 15000 });
      assert.match(await card().innerText(), /Found in announcements\s*· 3 to review/);
      assert.match(await card().innerText(), /Industrial Roundtable/);
      await page.click('#modeWeek');
      for (let n = 0; n < 2 && !(await page.locator('#calGrid .chip', { hasText: 'SI review session' }).count()); n++) await page.click('#next');
      assert.match(await page.locator('#calGrid .chip', { hasText: 'SI review session' }).innerText(), /✦/);
      await page.click('#today'); await page.click('#modeMonth');
    });

    await step('Accept puts it on the calendar and the to-do list, marked as found', async () => {
      await page.locator('.smart-row', { hasText: 'Industrial Roundtable' }).locator('button', { hasText: 'Accept' }).click();
      await page.waitForFunction(() => /2 to review/.test(document.querySelector('.smart-card')?.innerText || ''));
      assert.match(await page.locator('#todoList .item', { hasText: 'Industrial Roundtable' }).innerText(), /✦ Event · from announcement/);
    });

    await step('Fill in & accept: the form shows the quote; a bad time is refused, then saved', async () => {
      await page.locator('.smart-row', { hasText: 'Makeup lab' }).locator('button', { hasText: 'Fill in' }).click();
      assert.match(await page.innerText('#dlgSmart'), /makeup lab session will be held/);
      await page.fill('#dlgSmart input[name=start]', '15:00'); await page.fill('#dlgSmart input[name=end]', '14:00');
      await page.click('#dlgSmart button[value=save]');
      await page.waitForSelector('#dlgSmart [role=alert]');
      assert.match(await page.innerText('#dlgSmart [role=alert]'), /end must be after/);
      await page.fill('#dlgSmart input[name=end]', '17:00'); await page.fill('#dlgSmart input[name=location]', 'EE 063');
      await page.click('#dlgSmart button[value=save]');
      await page.waitForFunction(() => !document.querySelector('#dlgSmart').open);
      const lab = (await s.data()).items.find(i => i.title === 'Makeup lab');
      assert.equal(new Date(lab.due).getHours(), 15);
      assert.equal(lab.location, 'EE 063');
    });

    await step('Decline removes it; an empty card disappears', async () => {
      await page.locator('.smart-row', { hasText: 'Wellness' }).locator('button', { hasText: 'Decline' }).click();
      await page.waitForFunction(() => !document.querySelector('.smart-card'));
      assert.equal((await s.data()).items.some(i => /wellness/i.test(i.title)), false);
    });

    await step('a found event can be removed from its details (asks twice)', async () => {
      await page.locator('#todoList .item', { hasText: 'Industrial Roundtable' }).locator('.main').click();
      assert.match(await page.innerText('#itemBody'), /Found in an announcement/);
      assert.ok(await page.locator('#itemBody a', { hasText: 'Open the announcement in Brightspace' }).count());
      await page.click('.smart-remove');
      assert.equal(await page.$eval('#dlgItem', d => d.open), true, 'first click only arms it');
      await page.click('.smart-remove');
      await page.waitForFunction(() => ![...document.querySelectorAll('#todoList .item')].some(e => e.innerText.includes('Industrial Roundtable')));
    });

    await step('settings section shows the last scan and what it found', async () => {
      await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=smart]');
      assert.match(await page.innerText('#featureSection'), /Last scan[\s\S]*2 added · 0 to review/);
      assert.match(await page.innerText('#featureSection'), /no tools/);
      await page.keyboard.press('Escape');
    });

    await step('turning it off hides all of it', async () => {
      await toggle();
      await page.waitForFunction(() => ![...document.querySelectorAll('#todoList .item')].some(e => /SI review session|Makeup lab/.test(e.innerText)));
      assert.equal(await page.locator('#settingsNav [data-sec=smart]').count(), 0);
    });

    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally { await browser.close(); s.stop(); }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);
