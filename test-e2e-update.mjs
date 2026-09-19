// Browser test for the update pill/dialog (a fake GitHub says a newer version exists; nothing is installed here —
// test-update.mjs does a real install). PLAYWRIGHT_FROM=<folder with playwright installed> node test-e2e-update.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(process.env.PLAYWRIGHT_FROM || ROOT, 'package.json'));
const pw = require('playwright');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });

async function demo(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], { stdio: 'ignore', windowsHide: true,
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ue2e-')), ...env } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  return { base, stop: () => child.kill() };
}

async function run(browserName) {
  const ghPort = await freePort();
  const gh = http.createServer((req, res) => res.end(JSON.stringify({ tag_name: 'v99.0.0', body: '## What’s new\n- A **better** calendar\n\n<script>alert(1)</script>',
    html_url: 'https://github.com/lflowers01/academic-dashboard/releases/tag/v99.0.0', assets: [{ name: 'academic-dashboard.zip', browser_download_url: 'https://github.com/x.zip' }] }))).listen(ghPort, '127.0.0.1');
  const plain = await demo(), newer = await demo({ DASH_UPDATE_API: `http://127.0.0.1:${ghPort}/latest` });
  const browser = await pw[browserName].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${String(e.message).split('\n').filter(Boolean).slice(0, 3).join(' / ')}`); process.exitCode = 1; } };
  console.log(`updates · ${browserName}:`);
  try {
    await step('up to date: no pill; Settings shows the version', async () => {
      await page.goto(plain.base); await page.waitForSelector('#todoList .item');
      assert.equal(await page.isVisible('#btnUpdate'), false);
      await page.click('#btnSettings');
      assert.match(await page.innerText('#aboutLine'), new RegExp(`Version ${VERSION.replace(/\./g, '\\.')}`));
      await page.keyboard.press('Escape');
    });
    await step('newer release: a quiet pill in the header opens a dialog with the notes', async () => {
      await page.goto(newer.base); await page.waitForSelector('#todoList .item');
      await page.waitForSelector('#btnUpdate:not([hidden])', { timeout: 15000 }); // the server checks GitHub at start-up
      assert.match(await page.innerText('#btnUpdate'), /Update available · v99\.0\.0/);
      await page.click('#btnUpdate');
      const text = await page.innerText('#dlgUpdate');
      assert.match(text, /Version 99\.0\.0 is available/);
      assert.doesNotMatch(text, /null|undefined/);
      assert.match(text, new RegExp(`You have v${VERSION.replace(/\./g, '\\.')}`));
      assert.equal(await page.locator('#dlgUpdate strong', { hasText: 'better' }).count(), 1, 'notes rendered as Markdown');
      assert.equal(await page.locator('#dlgUpdate script').count(), 0, 'and never as HTML');
      assert.equal(await page.isDisabled('#dlgUpdate button.primary'), true, 'this folder is a git checkout, so no install from here');
    });
    await step('Later hides the pill (for a few days) and Settings still says an update exists', async () => {
      await page.click('#dlgUpdate button:has-text("Later")');
      await page.waitForFunction(() => document.querySelector('#btnUpdate').hidden);
      await page.reload(); await page.waitForSelector('#todoList .item');
      assert.equal(await page.isVisible('#btnUpdate'), false, 'stays hidden after a reload');
      await page.click('#btnSettings');
      assert.match(await page.innerText('#aboutLine'), /v99\.0\.0 is available/);
      await page.keyboard.press('Escape');
    });
    await step('no console errors', async () => assert.deepEqual(errors, []));
  } finally { await browser.close(); plain.stop(); newer.stop(); gh.close(); }
}

for (const b of (process.env.BROWSERS || 'firefox,chromium').split(',')) await run(b);
