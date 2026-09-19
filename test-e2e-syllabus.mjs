// Browser test for the optional Syllabus scan feature, in demo mode (demo syllabi in fixtures/demo-syllabi + a fake Claude).
// Runs in Firefox and Chromium. Needs Playwright: PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e-syllabus.mjs
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
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sye2e-')) } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  return { base, data: () => fetch(base + '/api/data').then(r => r.json()), stop: () => child.kill() };
}

async function run(browserName) {
  const s = await demo();
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${String(e.message).split('\n').filter(Boolean).slice(0, 4).join(' / ')} @ ${(String(e.stack).match(/test-e2e-syllabus\.mjs:(\d+)/) || [])[1]}`); process.exitCode = 1; await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close())).catch(() => {}); } };
  const toggle = async () => {
    await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=features]');
    await page.getByRole('switch', { name: /^Syllabus scan/ }).click();
    await page.keyboard.press('Escape');
  };
  const settings = async () => { await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=syllabus]'); };
  const long = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); };
  console.log(`syllabus scan · ${browserName}:`);
  try {
    await page.goto(s.base); await page.waitForSelector('#todoList .item');

    await step('off by default; turning it on reads the syllabi: sure items on the calendar, the rest in a collapsed card', async () => {
      assert.equal(await page.locator('.syllabus-card').count(), 0);
      await toggle();
      await page.waitForSelector('.syllabus-card', { timeout: 15000 });
      assert.match(await page.innerText('.syllabus-card'), /Found in syllabi\s*· 1 to review/);
      assert.equal(await page.locator('.syllabus-card .smart-row').count(), 0, 'collapsed by default');
      const d = await s.data();
      assert.deepEqual(d.items.filter(i => i.source === 'syllabus').map(i => i.eventKind).sort(), ['class-change', 'deadline', 'exam']);
      assert.match(await page.locator('#todoList .item', { hasText: 'Project 2' }).textContent(), /✦ Deadline · from syllabus/);
    });

    await step('settings: one row per class, with what was read, found and the grading scheme', async () => {
      await settings();
      const ma = await page.locator('.syl-table tr', { hasText: 'MA 161' }).innerText();
      assert.match(ma, /Syllabus \(demo\)/); assert.match(ma, /2 added · 0 to review/); assert.match(ma, /Weighted · 4 parts · 100%/);
      assert.match(await page.locator('.syl-table tr', { hasText: 'CS 159' }).innerText(), /Points · 3 parts/);
      assert.match(await page.locator('.syl-table tr', { hasText: 'ENGL 106' }).innerText(), /None in Brightspace/);
    });

    await step('adding a file: matched to its class by the file name, read, and its dates show up', async () => {
      if (!(await page.$eval('#dlgSettings', d => d.open))) await settings();
      fs.writeFileSync(path.join(os.tmpdir(), 'WL-Fall-2026-ENGL-(WL)-10600-041-English-Composition.txt'), `Essay 3 is due ${long(18)} at 11:59 PM.`);
      await page.setInputFiles('#featureSection input[type=file]', path.join(os.tmpdir(), 'WL-Fall-2026-ENGL-(WL)-10600-041-English-Composition.txt'));
      await page.waitForFunction(() => /📎 WL-Fall-2026-ENGL/.test(document.querySelector('.syl-table')?.innerText || ''), null, { timeout: 15000 });
      const d = await (async () => { for (let i = 0; i < 100; i++) { const x = await s.data(); if (x.items.some(i => /Essay 3/.test(i.title))) return x; await new Promise(r => setTimeout(r, 150)); } })();
      assert.ok(d, 'the essay deadline was found');
      assert.equal(d.items.find(i => /Essay 3/.test(i.title)).courseId, 104);
    });

    await step('a file whose name names no class asks which class it is', async () => {
      if (!(await page.$eval('#dlgSettings', d => d.open))) await settings();
      fs.writeFileSync(path.join(os.tmpdir(), 'my notes.txt'), `Lab practical is on ${long(20)} from 2:00-4:00 PM.`);
      await page.setInputFiles('#featureSection input[type=file]', path.join(os.tmpdir(), 'my notes.txt'));
      await page.waitForSelector('.syl-ask');
      await page.selectOption('.syl-ask select', { label: 'CHM 115 Lab' });
      await page.click('.syl-ask button:has-text("Add")');
      await page.waitForFunction(() => /📎 my notes\.txt/.test(document.querySelector('.syl-table')?.innerText || ''), null, { timeout: 15000 });
      await page.click('.syl-table button[aria-label="Remove my notes.txt"]');
      await page.waitForFunction(() => !/📎 my notes\.txt/.test(document.querySelector('.syl-table')?.innerText || ''));
      await page.keyboard.press('Escape');
    });

    await step('Fill in & accept a syllabus item; its details say it came from the syllabus and can be removed', async () => {
      await page.click('.syllabus-card .strip-head');
      await page.locator('.syllabus-card .smart-row', { hasText: 'Quiz 3' }).locator('button', { hasText: 'Fill in' }).click();
      await page.fill('#dlgFound-syllabus input[name=start]', '18:30');
      await page.click('#dlgFound-syllabus button[value=save]');
      await page.waitForFunction(() => !/Quiz 3/.test(document.querySelector('.syllabus-card')?.textContent || '')); // (the lab practical from the last step still waits)
      const quiz = (await s.data()).items.find(i => i.title === 'Quiz 3');
      await page.goto(`${s.base}/#item=${encodeURIComponent(quiz.id)}`);
      await page.waitForFunction(() => document.querySelector('#dlgItem').open);
      const body = await page.innerText('#itemBody');
      assert.match(body, /found in the syllabus/i);
      assert.equal(await page.locator('#itemBody a', { hasText: 'Open the announcement' }).count(), 0);
      await page.click('.smart-remove'); await page.click('.smart-remove');
      await page.waitForFunction(() => ![...document.querySelectorAll('#todoList .item')].some(e => e.textContent.includes('Quiz 3')));
    });

    await step('Accept all takes every complete item in the card at once', async () => {
      await settings();
      const file = path.join(os.tmpdir(), 'WL-Fall-2026-ENGR-(WL)-13100-010-Events.txt');
      fs.writeFileSync(file, [22, 23, 24, 25].map(n => `Industry panel ${n} on ${long(n)} at 6:00 PM.`).join('\n'));
      await page.setInputFiles('#featureSection input[type=file]', file);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => /(\d+) to review/.test(document.querySelector('.syllabus-card')?.textContent || '') && +RegExp.$1 >= 4, null, { timeout: 15000 });
      if (!(await page.locator('.syllabus-card .smart-row').count())) await page.click('.syllabus-card .strip-head');
      const bulk = page.locator('.syllabus-card .smart-bulk button');
      assert.match(await bulk.innerText(), /Accept all \d+ complete ones/);
      await bulk.click();
      await page.waitForFunction(() => !document.querySelector('.syllabus-card'), null, { timeout: 15000 });
      assert.equal((await s.data()).items.filter(i => /Industry panel/.test(i.title)).length, 4);
    });

    await step('turning it off hides all of it', async () => {
      await toggle();
      await page.waitForFunction(() => ![...document.querySelectorAll('#todoList .item')].some(e => /Project 2|Essay 3/.test(e.textContent)));
      assert.equal(await page.locator('#settingsNav [data-sec=syllabus]').count(), 0);
    });

    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally { await browser.close(); s.stop(); }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);
