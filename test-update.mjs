// In-app updates: a real update of a throwaway install, from a fake GitHub serving a real release zip.
// Nothing here touches this folder's files, your data, or the real GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newer } from './update.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
const robocopy = (from, to) => { try { execFileSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', 'data', 'data-demo', 'node_modules', '.git'], { windowsHide: true }); } catch (e) { if (e.status >= 8) throw e; } };
const killPort = port => { try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); for (const l of out.split('\n')) { const m = l.match(new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING\\s+(\\d+)`)); if (m) execFileSync('taskkill', ['/pid', m[1], '/T', '/F'], { stdio: 'ignore' }); } } catch {} };

test('newer() compares versions numerically', () => {
  assert.equal(newer('1.10.0', '1.9.3'), true);
  assert.equal(newer('v1.4.2', '1.4.1'), true);
  assert.equal(newer('1.4.1', '1.4.1'), false);
  assert.equal(newer('1.4.0', '1.4.1'), false);
  assert.equal(newer(null, '1.4.1'), false);
});

// builds a release zip of this code with the given version (and a marker file), like `git archive` would
function makeRelease(dir, version) {
  const src = path.join(dir, 'rel', 'academic-dashboard');
  robocopy(ROOT, src);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
  fs.writeFileSync(path.join(src, 'UPDATED.txt'), version);
  const zip = path.join(dir, `release-${version}.zip`);
  execFileSync('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Path $env:SRC -DestinationPath $env:ZIP -Force'], { env: { ...process.env, SRC: src, ZIP: zip }, windowsHide: true });
  fs.rmSync(path.join(dir, 'rel'), { recursive: true, force: true });
  return zip;
}

// a fake api.github.com + asset host
async function fakeGitHub(zip, tag) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/latest') return res.end(JSON.stringify({ tag_name: tag, body: '## What’s new\n- Something **better**', html_url: `${base}/page`, assets: [{ name: 'academic-dashboard.zip', browser_download_url: `${base}/dl` }] }));
    if (req.url === '/dl') { res.writeHead(302, { Location: '/files/academic-dashboard.zip' }); return res.end(); }
    if (req.url === '/files/academic-dashboard.zip') return res.end(fs.readFileSync(zip));
    res.writeHead(404); res.end();
  }).listen(port, '127.0.0.1');
  return { api: `${base}/latest`, close: () => srv.close() };
}

async function installAt(dir) {
  const install = path.join(dir, 'install');
  robocopy(ROOT, install);
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(install, 'node_modules'), path.join(ROOT, 'node_modules')], { stdio: 'ignore' });
  return install;
}
// remove a throwaway install without following the node_modules junction into this folder's real node_modules
function cleanup(dir) {
  const j = path.join(dir, 'install', 'node_modules');
  try { if (fs.lstatSync(j)) fs.rmdirSync(j); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

async function startInstalled(install, dataDir, api) {
  const port = await freePort();
  spawn(process.execPath, ['server.mjs', '--fixture'], { cwd: install, windowsHide: true, stdio: 'ignore', detached: true,
    env: { ...process.env, DASH_PORT: String(port), DASH_DATA: dataDir, DASH_UPDATE_API: api } }).unref();
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const post = async (p, b = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const data = async () => { try { return await (await fetch(base + '/api/data')).json(); } catch { return null; } };
  return { port, post, data };
}

test('update: download, check, back up, copy over (data kept), restart as the new version', { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-upd-'));
  const gh = await fakeGitHub(makeRelease(dir, '99.0.0'), 'v99.0.0');
  const install = await installAt(dir), data = path.join(dir, 'data');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'tasks.json'), JSON.stringify([{ id: 'keep-me', title: 'Keep me', date: '2030-01-01' }]));
  let s;
  try {
    s = await startInstalled(install, data, gh.api);
    const u = (await s.post('/api/update/check')).body;
    assert.deepEqual([u.current, u.latest, u.available, u.canInstall], [VERSION, '99.0.0', true, true]);
    assert.match(u.notes, /Something \*\*better\*\*/);
    assert.equal((await s.post('/api/update')).status, 202);
    let d = null;
    for (let i = 0; i < 120 && d?.update?.current !== '99.0.0'; i++) { await new Promise(r => setTimeout(r, 500)); d = await s.data(); if (d?.update?.job?.error) break; }
    assert.equal(d?.update?.job?.error ?? null, null);
    assert.equal(d.update.current, '99.0.0', 'the restarted server runs the new version');
    assert.equal(d.update.available, false);
    assert.equal(fs.readFileSync(path.join(install, 'UPDATED.txt'), 'utf8'), '99.0.0');
    assert.ok(d.tasks.some(t => t.id === 'keep-me'), 'your data is kept');
    assert.ok(fs.existsSync(path.join(data, `backup-v${VERSION}`, 'server.mjs')), 'the old version is backed up');
  } finally { if (s) killPort(s.port); gh.close(); cleanup(dir); }
});

test('update: a download that is not the version it claims is refused and nothing changes', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-upd-'));
  const gh = await fakeGitHub(makeRelease(dir, '98.0.0'), 'v99.0.0'); // tag says 99, zip holds 98
  const install = await installAt(dir), data = path.join(dir, 'data');
  fs.mkdirSync(data);
  let s;
  try {
    s = await startInstalled(install, data, gh.api);
    await s.post('/api/update/check');
    assert.equal((await s.post('/api/update')).status, 202);
    let d = null;
    for (let i = 0; i < 60 && !d?.update?.job?.error; i++) { await new Promise(r => setTimeout(r, 500)); d = await s.data(); }
    assert.match(d.update.job.error, /says it is v98\.0\.0, not v99\.0\.0/);
    assert.equal(d.update.current, VERSION);
    assert.equal(fs.existsSync(path.join(install, 'UPDATED.txt')), false);
  } finally { if (s) killPort(s.port); gh.close(); cleanup(dir); }
});

test('update: a git checkout is never updated in place', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-upd-'));
  const gh = await fakeGitHub(path.join(dir, 'none.zip'), 'v99.0.0');
  const install = await installAt(dir), data = path.join(dir, 'data');
  fs.mkdirSync(path.join(install, '.git'));
  let s;
  try {
    s = await startInstalled(install, data, gh.api);
    const u = (await s.post('/api/update/check')).body;
    assert.equal(u.available, true);
    assert.equal(u.canInstall, false);
    assert.equal((await s.post('/api/update')).status, 409);
  } finally { if (s) killPort(s.port); gh.close(); cleanup(dir); }
});
