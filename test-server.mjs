// Integration tests: the real server.mjs against a fake Brightspace (fixtures/fake-mcp.mjs).
// Each case gets its own port and temp data folder; notifications go to a log file, never your screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayKey } from './logic.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // not URL.pathname: that breaks on folders with spaces
// a port the OS says is free (a fixed range can hit some other local server, which answers with HTML)
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });

async function startServer({ mode = 'ok', extraEnv = {}, dir } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  const port = await freePort();
  const env = {
    ...process.env, DASH_PORT: String(port), DASH_DATA: dir,
    DASH_MCP_CMD: JSON.stringify(['node', path.join(ROOT, 'fixtures', 'fake-mcp.mjs')]),
    DASH_TOAST_LOG: path.join(dir, 'toasts.log'), DASH_BOILEREXAMS_FILE: path.join(ROOT, 'fixtures', 'boilerexams-test.json'), FAKE_MODE: mode, FAKE_LOG: path.join(dir, 'fake.log'), ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: 'ignore', windowsHide: true });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/api/data`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const api = async (p, opts = {}) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = (p, body, headers = { 'Content-Type': 'application/json' }) => api(p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const settled = async (ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const { body } = await api('/api/data'); if (!body.refreshing && (body.refreshedAt || body.lastError)) return body; await new Promise(r => setTimeout(r, 150)); }
    throw new Error('refresh never settled');
  };
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const stop = () => new Promise(r => { child.once('exit', r); child.kill(); });
  return { base, api, post, settled, read, stop, dir, port };
}

test('normal refresh: data, exams, skipped courses, start-up digest', async () => {
  const s = await startServer();
  try {
    const d = await s.settled();
    assert.equal(d.lastError, null);
    assert.equal(d.term, '202710');
    const titles = d.items.map(i => i.title);
    assert.ok(titles.includes('HW 3') && titles.includes('Lab 5'));
    // exam quiz flagged, practice quiz not, announced exam extracted
    assert.equal(d.items.find(i => i.title === 'Exam 2').exam, true);
    assert.equal(d.items.find(i => i.title === 'Exam 2 Practice Quiz').exam, false);
    const ann = d.items.find(i => i.kind === 'exam');
    assert.ok(ann, 'announced exam extracted');
    assert.equal(new Date(ann.due).getHours(), 20);
    // past-term, inactive and inaccessible courses are never fetched
    const asked = s.read('fake.log').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.name === 'get_assignments').map(x => x.args.courseId);
    assert.deepEqual(asked.sort(), [101, 102]);
    // start-up digest: HW 3 (today) + Lab 5 (8:30 tomorrow) — not Project (tomorrow 11:59 PM), not submitted Lab 4
    await new Promise(r => setTimeout(r, 500));
    const toasts = s.read('toasts.log').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(toasts.length, 1, 'exactly one start-up digest');
    const text = toasts[0].lines.join('\n');
    assert.match(text, /HW 3/);
    assert.match(text, /Lab 5/);
    assert.doesNotMatch(text, /Project|Lab 4/);
    assert.match(toasts[0].title, /1 due today · 1 early tomorrow/);
    assert.match(toasts[0].url, /#due=bs%3A101%3Aassignment%3A1,bs%3A102%3Aassignment%3A4$/); // click highlights exactly those
    // Boilerexams: MA 16200 exists there, CS 15900 doesn't
    assert.deepEqual(d.boilerexams, { 101: 'MA16200' });
  } finally { await s.stop(); }
});

test('expired sign-in: pauses, keeps serving, no Brightspace retries', async () => {
  const s = await startServer({ mode: 'auth' });
  try {
    const d = await s.settled();
    assert.equal(d.lastError.kind, 'auth');
    assert.equal(d.paused, true);
    assert.equal(d.nextRefreshAt, null);
    assert.match(s.read('server.log'), /sign-in window skipped/); // opened for real, but never with a fake Brightspace
  } finally { await s.stop(); }
});

test('session expired, server starts a hidden MFA sign-in: reported as signed out right away, not a timeout', async () => {
  const s = await startServer({ mode: 'reauth' });
  try {
    const t0 = Date.now();
    const d = await s.settled();
    assert.ok(Date.now() - t0 < 15000, 'did not wait for the MCP timeout');
    assert.equal(d.lastError.kind, 'auth');
    assert.equal(d.paused, true);
    assert.match(s.read('server.log'), /sign-in window/);
  } finally { await s.stop(); }
});

test('Brightspace hangs: times out, kills the process, schedules a retry', async () => {
  const s = await startServer({ mode: 'hang', extraEnv: { DASH_TOTAL_TIMEOUT: '2500' } });
  try {
    const d = await s.settled(15000);
    assert.equal(d.lastError.kind, 'network');
    assert.match(d.lastError.message, /longer than/);
    assert.equal(d.paused, false);
    assert.ok(new Date(d.nextRefreshAt) - Date.now() > 4 * 60_000, 'retry in ~5 min');
    await new Promise(r => setTimeout(r, 1500));
    const pid = JSON.parse(s.read('fake.log').split('\n')[0]).pid;
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'hung Brightspace process was killed');
  } finally { await s.stop(); }
});

test('one course refuses access: not treated as signed out', async () => {
  const s = await startServer({ mode: 'courseauth' });
  try {
    const d = await s.settled();
    assert.equal(d.lastError, null);
    assert.equal(d.paused, false);
    assert.deepEqual(d.failedCourses, [102]);
  } finally { await s.stop(); }
});

test('API guards and validation', async () => {
  const s = await startServer();
  try {
    await s.settled();
    // DNS-rebinding guard (fetch() drops a custom Host header, so use raw http)
    const status = await new Promise(r => http.get({ host: '127.0.0.1', port: s.port, path: '/api/data', headers: { Host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
    assert.equal(status, 403);
    assert.equal((await s.post('/api/refresh', 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await s.post('/api/tasks', '{not json')).status, 400);
    assert.equal((await s.post('/api/tasks', 'x'.repeat(1_100_000))).status, 413);
    assert.equal((await s.post('/api/tasks', { title: 'x', date: '2026-02-31x' })).status, 400);
    assert.equal((await s.post('/api/tasks', { title: 'x', date: '2026-09-30', time: '25:00' })).status, 400);
    assert.equal((await s.post('/api/tasks', { title: '   ', date: '2026-09-30' })).status, 400);
    assert.equal((await s.post('/api/tasks', { title: 'x', date: '2026-09-30', endDate: '2026-09-29' })).status, 400); // end before start
    assert.equal((await s.post('/api/tasks', { title: 'x', date: '2026-09-30', endDate: '2026-10-02' })).body.endDate, '2026-10-02');
    assert.equal((await s.post('/api/tasks', { title: 'x', date: '2026-09-30', endDate: '2026-09-30' })).body.endDate, ''); // same day = no range
    assert.equal((await s.api('/..%2f..%2fserver.mjs')).status, 404);
    assert.equal((await s.api('/%2e%2e/server.mjs')).status, 404);
    const r = await fetch(`${s.base}/icon.png`);
    assert.equal(r.headers.get('content-type'), 'image/png');
  } finally { await s.stop(); }
});

test('tasks, done state and settings survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  let s = await startServer({ dir });
  await s.settled();
  const t = (await s.post('/api/tasks', { title: 'MA 162 Exam 1 <script>', date: dayKey(new Date()), time: '20:00', courseId: 101, exam: true })).body;
  assert.equal(t.exam, true);
  await s.post('/api/state', { done: { 'bs:101:assignment:1': true }, notifications: false, notes: { 'bs:101:assignment:1': 'Do problems 3-7 <b>first</b>', 'ex:101:x': 'temp' } });
  await s.post('/api/state', { notes: { 'ex:101:x': '   ' } }); // blank = delete
  await s.stop();
  s = await startServer({ dir });
  try {
    const d = await s.settled();
    assert.equal(d.tasks[0].title, 'MA 162 Exam 1 <script>');
    assert.equal(d.state.done['bs:101:assignment:1'], true);
    assert.equal(d.state.notifications, false);
    assert.deepEqual(d.state.notes, { 'bs:101:assignment:1': 'Do problems 3-7 <b>first</b>' });
    // notifications off → no digest on the second start
    await new Promise(r => setTimeout(r, 500));
    const toasts = s.read('toasts.log').trim().split('\n').filter(Boolean);
    assert.equal(toasts.length, 1, 'only the first run sent a digest');
    // delete
    await s.api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    assert.equal((await s.api('/api/data')).body.tasks.length, 0);
  } finally { await s.stop(); }
});

test('corrupt data files do not brick the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  fs.writeFileSync(path.join(dir, 'tasks.json'), '"not an array"');
  const s = await startServer({ dir });
  try {
    const d = await s.settled();
    assert.equal(d.lastError, null);
    assert.deepEqual(d.tasks, []);
    assert.ok(fs.existsSync(path.join(dir, 'state.json.bad')));
  } finally { await s.stop(); }
});

test('a task file damaged mid-save is restored from the backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  let s = await startServer({ dir });
  await s.settled();
  await s.post('/api/tasks', { title: 'first', date: '2026-10-01' });
  await s.post('/api/tasks', { title: 'second', date: '2026-10-02' }); // .bak now holds [first]
  await s.stop();
  fs.writeFileSync(path.join(dir, 'tasks.json'), '[{"title":"sec'); // simulate a power cut mid-write
  s = await startServer({ dir });
  try {
    const d = await s.settled();
    assert.deepEqual(d.tasks.map(t => t.title), ['first']);
    assert.ok(fs.existsSync(path.join(dir, 'tasks.json.bad')));
  } finally { await s.stop(); }
});

test('port already in use: exits with a clear log line', async () => {
  const s = await startServer();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
    const out = (() => { try { execFileSync(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, DASH_PORT: String(s.port), DASH_DATA: dir }, stdio: 'pipe', timeout: 10000 }); return ''; } catch (e) { return String(e.stdout); } })();
    assert.match(out, /busy/);
  } finally { await s.stop(); }
});
