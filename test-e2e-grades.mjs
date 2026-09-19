// Browser test for the optional Grades feature, in demo mode. PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e-grades.mjs
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
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'dash-gre2e-')) } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  return { base, data: () => fetch(base + '/api/data').then(r => r.json()), stop: () => child.kill() };
}

async function run(browserName) {
  const s = await demo();
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(m.text())); // the refused bad setup is expected
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${String(e.message).split('\n').filter(Boolean).slice(0, 4).join(' / ')} @ ${(String(e.stack).match(/test-e2e-grades\.mjs:(\d+)/) || [])[1]}`); process.exitCode = 1; await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close())).catch(() => {}); } };
  const toggle = async name => {
    await page.click('#btnSettings'); await page.click('#settingsNav [data-sec=features]');
    await page.getByRole('switch', { name }).click();
    await page.keyboard.press('Escape');
  };
  const card = name => page.locator('.grade-card', { hasText: name });
  const big = async () => (await page.innerText('#dlgGrade h2')).replace(/\s+/g, ' ');
  console.log(`grades · ${browserName}:`);
  try {
    await page.goto(s.base); await page.waitForSelector('#todoList .item');

    await step('off by default: no Grades tab', async () => {
      assert.equal(await page.isVisible('#tabGrades'), false);
      assert.equal((await s.data()).grades, null);
    });

    await step('turning it on adds a Grades tab with a card per class', async () => {
      await toggle(/^Grades/);
      await page.click('#tabGrades');
      await page.waitForSelector('#panelGrades:not([hidden]) .grade-card');
      assert.match(await card('MA 161').innerText(), /75\.8%/);
      assert.match(await card('MA 161').innerText(), /Rough: set up how this class is graded/);
      assert.equal(await page.isVisible('#panelCal'), false);
    });

    await step('setting up weights: the grade follows them, and "what do I need" names the final', async () => {
      await card('MA 161').click();
      await page.click('#dlgGrade button:has-text("Categories with % weights")');
      const parts = [['Quizzes', 15], ['WebAssign', 15], ['Midterm Exams', 40], ['Final Exam', 30]];
      for (const [i, [name, value]] of parts.entries()) {
        if (i) await page.click('#dlgGrade button:has-text("+ Add")');
        await page.locator('#dlgGrade .scheme-row').nth(i).locator('input').nth(0).fill(name);
        await page.locator('#dlgGrade .scheme-row').nth(i).locator('input').nth(1).fill(String(value));
      }
      assert.match(await page.innerText('#dlgGrade .scheme-foot'), /Total 100% ✓/);
      await page.click('#dlgGrade .grade-scheme-actions button.primary');
      await page.waitForFunction(() => /77\.6%/.test(document.querySelector('#dlgGrade h2')?.innerText || ''));
      assert.match(await big(), /77\.6% C\+/);
      assert.match(await page.innerText('#dlgGrade .grade-need'), /on the Final Exam/);
      assert.match(await page.innerText('#dlgGrade'), /Final Exam · 30% · nothing graded yet/);
    });

    await step('a what-if changes the grade only on this page; Reset brings it back', async () => {
      await page.getByLabel('What-if score for Midterm Exam 1 in percent').fill('100');
      await page.getByLabel('What-if score for Midterm Exam 1 in percent').press('Tab');
      await page.waitForFunction(() => !/77\.6%/.test(document.querySelector('#dlgGrade h2').innerText));
      assert.match(await big(), /87\.9%/);
      await page.click('#dlgGrade button:has-text("Reset what-ifs")');
      await page.waitForFunction(() => /77\.6%/.test(document.querySelector('#dlgGrade h2').innerText));
    });

    await step('leaving out a "not graded yet" zero is saved', async () => {
      await page.getByLabel('Count WebAssign 3').uncheck();
      await page.waitForFunction(() => !/77\.6%/.test(document.querySelector('#dlgGrade h2').innerText));
      const after = await big();
      await page.keyboard.press('Escape');
      await page.reload(); await page.waitForSelector('#panelGrades:not([hidden]) .grade-card', { timeout: 5000 });
      await card('MA 161').click();
      assert.equal(await big(), after, 'kept after a reload (and the Grades tab stayed open)');
      await page.keyboard.press('Escape');
    });

    await step('a bad setup is refused with a reason', async () => {
      await card('ENGL 106').click();
      await page.click('#dlgGrade button:has-text("Total points")');
      await page.locator('#dlgGrade .scheme-row input').nth(1).fill('50');
      await page.click('#dlgGrade .grade-scheme-actions button.primary');
      await page.waitForSelector('#schemeError:not([hidden])');
      assert.match(await page.innerText('#schemeError'), /needs a name/);
      await page.keyboard.press('Escape');
    });

    await step('with Syllabus scan on, a class offers its syllabus scheme: Use this', async () => {
      await toggle(/^Syllabus scan/);
      for (let i = 0; i < 60 && !(await s.data()).grades?.some(c => c.id === 105 && c.suggestion); i++) await new Promise(r => setTimeout(r, 250)); // the syllabi are read first
      await page.reload(); await page.waitForSelector('#panelGrades:not([hidden]) .grade-card');
      await card('CS 159').click();
      const dbg = await page.evaluate(() => JSON.stringify(window.dash.data.grades.map(c => [c.id, c.short, !!c.suggestion])));
      assert.match(await page.innerText('#dlgGrade .grade-scheme'), /Your syllabus says: total points — Programming Projects 300 pts/, dbg);
      await page.click('#dlgGrade button:has-text("Use this")');
      await page.waitForFunction(() => /Total points \(from your syllabus\)/.test(document.querySelector('#dlgGrade').innerText));
      assert.match(await page.innerText('#dlgGrade .grade-need'), /on everything left/);
      await page.keyboard.press('Escape');
    });

    await step('turning it off hides the tab and goes back to the calendar', async () => {
      await toggle(/^Grades/);
      await page.waitForFunction(() => document.querySelector('#tabGrades').hidden && !document.querySelector('#panelCal').hidden);
    });

    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally { await browser.close(); s.stop(); }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);
