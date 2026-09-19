// Integration tests for the optional Google Calendar feature: the real server + gcal bridge against a fake `claude`
// (fixtures/fake-claude.mjs) that keeps a fake Google Calendar. Nothing touches your real calendar or Claude usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let nextPort = 5200 + Math.floor(Math.random() * 300);
const CLASSES = 'classes@group.calendar.google.com', CLUBS = 'clubs@group.calendar.google.com', HOLIDAYS = 'holidays@group.v.calendar.google.com';

async function start({ mode = 'ok', env = {}, dir } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dash-gcal-'));
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, DASH_PORT: String(port), DASH_DATA: dir,
    DASH_MCP_CMD: JSON.stringify(['node', path.join(ROOT, 'fixtures', 'fake-mcp.mjs')]),
    DASH_TOAST_LOG: path.join(dir, 'toasts.log'), DASH_BOILEREXAMS_FILE: path.join(ROOT, 'fixtures', 'boilerexams-test.json'),
    DASH_GCAL_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-claude.mjs')]),
    FAKE_GCAL_STATE: path.join(dir, 'fake-gcal.json'), FAKE_GCAL_MODE: mode, ...env,
  } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const post = async (p, body = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const data = async () => (await fetch(base + '/api/data')).json();
  const idle = async () => { for (let i = 0; i < 150; i++) { const d = await data(); if (!d.gcal?.running && !d.refreshing) return d; await new Promise(r => setTimeout(r, 100)); } throw new Error('still running'); };
  const fakeDb = () => JSON.parse(fs.readFileSync(path.join(dir, 'fake-gcal.json'), 'utf8'));
  return { base, post, data, idle, fakeDb, dir, stop: () => new Promise(r => { child.once('exit', r); child.kill(); }) };
}
const enable = s => s.post('/api/state', { features: { googleCalendar: true } });

test('off by default: no Google data, routes refuse', async () => {
  const s = await start();
  try {
    const d = await s.idle();
    assert.equal(d.gcal, null);
    assert.equal(d.state.features.googleCalendar, undefined);
    assert.equal((await s.post('/api/gcal/sync')).status, 409);
    assert.equal((await s.post('/api/state', { features: { notARealFeature: true } })).body.features.notARealFeature, undefined);
  } finally { await s.stop(); }
});

test('connect → nothing shown or editable until chosen; showing a calendar syncs it', async () => {
  const s = await start();
  try {
    await enable(s);
    assert.equal((await s.post('/api/gcal/connect')).status, 200);
    let d = await s.idle();
    assert.equal(d.gcal.connected, true);
    assert.deepEqual(d.gcal.calendars.map(c => [c.summary, c.show, c.edit]), [['Classes', false, false], ['Clubs', false, false], ['Holidays in United States', false, false]]);
    assert.equal(d.gcal.events.length, 0);
    // "Allow edits" without "Show" is refused
    await s.post('/api/gcal/settings', { calendars: { [HOLIDAYS]: { edit: true } } });
    d = await s.data();
    assert.equal(d.gcal.calendars.find(c => c.id === HOLIDAYS).edit, false);
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true, edit: true }, [HOLIDAYS]: { show: true } } });
    d = await s.idle();
    const cals = new Set(d.gcal.events.map(e => e.calendarId));
    assert.ok(cals.has(CLASSES) && cals.has(HOLIDAYS) && !cals.has(CLUBS), 'only shown calendars');
    assert.ok(d.gcal.events.some(e => e.allDay && e.title === 'October Break'));
    assert.ok(d.gcal.syncedAt && d.gcal.nextSyncAt);
    assert.equal(d.gcal.lastError, null);
  } finally { await s.stop(); }
});

test('create / edit / delete round-trip; writes to non-editable calendars are refused by the server', async () => {
  const s = await start();
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true, edit: true }, [HOLIDAYS]: { show: true } } });
    await s.idle();
    const start_ = new Date(); start_.setDate(start_.getDate() + 2); start_.setHours(15, 0, 0, 0);
    const end_ = new Date(+start_ + 3600e3);
    const denied = await s.post('/api/gcal/event', { op: 'create', calendarId: HOLIDAYS, title: 'nope', start: start_, end: end_ });
    assert.equal(denied.status, 403);
    assert.equal((await s.post('/api/gcal/event', { op: 'create', calendarId: CLASSES, title: 'x', start: end_, end: start_ })).status, 400);
    const made = await s.post('/api/gcal/event', { op: 'create', calendarId: CLASSES, title: 'Study group', start: start_, end: end_, location: 'WALC', description: 'bring notes' });
    assert.equal(made.status, 200);
    assert.equal(made.body.event.title, 'Study group');
    assert.ok(s.fakeDb().events[CLASSES].some(e => e.summary === 'Study group'), 'really written to Google (fake)');
    const upd = await s.post('/api/gcal/event', { op: 'update', id: made.body.event.id, title: 'Study group (moved)', start: new Date(+start_ + 3600e3), end: new Date(+end_ + 3600e3) });
    assert.equal(upd.status, 200);
    let d = await s.data();
    assert.equal(d.gcal.events.find(e => e.id === made.body.event.id).title, 'Study group (moved)');
    // a holiday event can't be edited or deleted
    const hol = d.gcal.events.find(e => e.calendarId === HOLIDAYS);
    assert.equal((await s.post('/api/gcal/event', { op: 'delete', id: hol.id })).status, 403);
    assert.equal((await s.post('/api/gcal/event', { op: 'delete', id: made.body.event.id })).status, 200);
    d = await s.data();
    assert.equal(d.gcal.events.some(e => e.id === made.body.event.id), false);
    assert.equal(s.fakeDb().events[CLASSES].some(e => e.summary.startsWith('Study group')), false);
  } finally { await s.stop(); }
});

test('add a Brightspace exam to Google once; the second time it is recognized as already there', async () => {
  const s = await start();
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true, edit: true } } });
    const d0 = await s.idle();
    const exam = d0.items.find(i => i.kind === 'exam'); // announced exam from the fake Brightspace
    const r1 = await s.post('/api/gcal/from-item', { itemId: exam.id, calendarId: CLASSES });
    assert.equal(r1.status, 200);
    assert.match(r1.body.event.title, /MA 162 Exam 1/);
    assert.equal(new Date(r1.body.event.start).getHours(), 20);
    const r2 = await s.post('/api/gcal/from-item', { itemId: exam.id, calendarId: CLASSES });
    assert.equal(r2.status, 409);
    const hw = d0.items.find(i => i.title === 'HW 3');
    const r3 = await s.post('/api/gcal/from-item', { itemId: hw.id, calendarId: CLASSES });
    assert.match(r3.body.event.title, /^Due: HW 3 \(MA 162\)$/);
    assert.equal(+new Date(r3.body.event.end), +new Date(hw.due));
  } finally { await s.stop(); }
});

test('pages are followed; a skipped page is an error, not silently missing events', async () => {
  let s = await start({ env: { FAKE_GCAL_PAGE: '8' } });
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true } } });
    const d = await s.idle();
    assert.equal(d.gcal.lastError, null);
    assert.ok(d.gcal.events.length > 16, 'more than two pages read');
  } finally { await s.stop(); }
  s = await start({ mode: 'skippage', env: { FAKE_GCAL_PAGE: '8' } });
  try {
    await enable(s);
    await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true } } });
    const d = await s.idle();
    assert.equal(d.gcal.lastError.kind, 'agent');
    assert.match(d.gcal.lastError.message, /didn't read/);
  } finally { await s.stop(); }
});

test('large results saved to a file by Claude Code are read in full, and the run leaves no transcript behind', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-claude-'));
  const s = await start({ mode: 'persist', env: { FAKE_GCAL_PAGE: '8', CLAUDE_CONFIG_DIR: cfg } });
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true } } });
    const d = await s.idle();
    assert.equal(d.gcal.lastError, null);
    assert.ok(d.gcal.events.length > 16, 'every page read from the saved files');
    const left = fs.readdirSync(cfg, { recursive: true }).filter(f => /.(jsonl|txt)$/.test(f));
    assert.deepEqual(left, [], 'transcripts and saved results are deleted');
  } finally { await s.stop(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('a malformed tool call (rejected before reaching Google) is retried once', async () => {
  const s = await start({ mode: 'malformedonce' });
  try {
    await enable(s);
    await s.post('/api/gcal/connect');
    const d = await s.idle();
    assert.equal(d.gcal.lastError, null);
    assert.equal(d.gcal.calendars.length, 3);
  } finally { await s.stop(); }
});

test('safety: wrong arguments are rejected; failures are reported with a clear kind', async () => {
  for (const [mode, kind, re] of [['wrongargs', 'agent', /different arguments|didn't read/], ['refuse', 'google', /refused/], ['notloggedin', 'auth', /not signed in/], ['noconnector', 'no-connector', /not connected/]]) {
    const s = await start({ mode });
    try {
      await enable(s);
      const r = await s.post('/api/gcal/connect');
      if (mode === 'wrongargs') {
        // list_calendars has no arguments to fake; check it on a read instead
        assert.equal(r.status, 200);
        await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true } } });
        const d = await s.idle();
        assert.equal(d.gcal.lastError.kind, kind, mode);
        assert.match(d.gcal.lastError.message, re);
        assert.equal(d.gcal.events.length, 0, 'nothing trusted');
      } else {
        assert.equal(r.status, 502, mode);
        assert.equal(r.body.kind, kind, mode);
        assert.match(r.body.error, re);
      }
    } finally { await s.stop(); }
  }
});

test('a hung Claude is killed after the timeout', async () => {
  const s = await start({ mode: 'hang', env: { DASH_GCAL_TIMEOUT: '1500' } });
  try {
    await enable(s);
    const t0 = Date.now();
    const r = await s.post('/api/gcal/connect');
    assert.equal(r.body.kind, 'timeout');
    assert.ok(Date.now() - t0 < 8000);
  } finally { await s.stop(); }
});

test('turning the feature off hides everything again (data kept for turning it back on)', async () => {
  const s = await start();
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLUBS]: { show: true } } });
    await s.idle();
    await s.post('/api/state', { features: { googleCalendar: false } });
    assert.equal((await s.data()).gcal, null);
    assert.equal((await s.post('/api/gcal/sync')).status, 409);
    await enable(s);
    assert.ok((await s.data()).gcal.events.length > 0, 'events still there after re-enabling');
  } finally { await s.stop(); }
});

test('digest: Google events are listed only when that setting is on', async () => {
  const s = await start();
  try {
    await enable(s); await s.post('/api/gcal/connect');
    await s.post('/api/gcal/settings', { calendars: { [CLASSES]: { show: true } }, digest: true });
    await s.idle();
    // (the digest itself is exercised through its line builder: today's timed events, max 3, "+N")
    const d = await s.data();
    assert.equal(d.gcal.settings.digest, true);
  } finally { await s.stop(); }
});
