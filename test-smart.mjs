// Integration tests for the optional Smart Announcements feature: the real server in demo mode with a fake
// `claude` (fixtures/fake-smart.mjs). Nothing touches your data or Claude usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFound, sameEvent, smartItems, isDone } from './logic.mjs';
import { parseReply } from './smart-ann.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });

async function start({ mode = 'ok', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-smart-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--fixture'], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, DASH_PORT: String(port), DASH_DATA: dir, DASH_TOAST_LOG: path.join(dir, 'toasts.log'), FAKE_SMART_MODE: mode, ...env,
  } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const post = async (p, body = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const data = async () => (await fetch(base + '/api/data')).json();
  const scanned = async () => { for (let i = 0; i < 150; i++) { const d = await data(); if (d.smart && !d.smart.running && d.smart.lastRun) return d; await new Promise(r => setTimeout(r, 100)); } throw new Error('scan never finished'); };
  return { post, data, scanned, dir, stop: () => new Promise(r => { child.once('exit', r); child.kill(); }) };
}
const enable = s => s.post('/api/state', { features: { smartAnnouncements: true } });

// ---------- unit: the checks every suggestion goes through ----------
test('verifyFound: only what the announcement really says, dated sensibly', () => {
  const ann = { id: 7, courseId: 3, title: 'SI review', body: '<p>SI will hold a Midterm 1 review session on Monday, September 21 from 7:00-9:00 PM in WALC 1055.</p>', date: '2026-09-15T12:00:00Z' };
  const now = new Date('2026-09-18T12:00:00');
  const ev = { kind: 'review', title: 'Midterm 1 review', date: '2026-09-21', start: '19:00', end: '21:00', location: 'WALC 1055', confidence: 'high', missing: [],
    quote: 'SI will hold a Midterm 1 review session on Monday, September 21 from 7:00-9:00 PM in WALC 1055.' };
  const f = verifyFound(ev, ann, now);
  assert.equal(f.sure, true);
  assert.deepEqual([f.date, f.start, f.end, f.location, f.courseId, f.annId], ['2026-09-21', '19:00', '21:00', 'WALC 1055', 3, 7]);
  assert.equal(verifyFound({ ...ev, quote: '  si will hold a MIDTERM 1 review session on monday,   September 21 from 7:00-9:00 PM in WALC 1055. ' }, ann, now).sure, true, 'case and spacing are forgiven');
  assert.equal(verifyFound({ ...ev, quote: 'Free pizza for everyone on September 21.' }, ann, now), null, 'invented quote');
  assert.equal(verifyFound({ ...ev, date: '2026-02-30' }, ann, now), null, 'impossible date');
  assert.equal(verifyFound({ ...ev, date: '2028-09-21' }, ann, now), null, 'too far from the posting');
  assert.equal(verifyFound({ ...ev, kind: 'party' }, ann, now), null, 'unknown kind');
  assert.equal(verifyFound(ev, ann, new Date('2026-09-22T12:00:00')), null, 'already over');
  assert.equal(verifyFound({ ...ev, start: '7pm', end: 'x' }, ann, now).start, null, 'bad times dropped → all day');
  assert.equal(verifyFound({ ...ev, kind: 'optional' }, ann, now).sure, false, 'optional events always go to review');
  assert.equal(verifyFound({ ...ev, confidence: 'low' }, ann, now).sure, false);
  assert.equal(verifyFound({ ...ev, missing: ['time'] }, ann, now).sure, false);
});

test('sameEvent / smartItems / done rules', () => {
  const a = { courseId: 1, date: '2026-09-21', start: '19:00', title: 'Midterm 1 review session' };
  assert.equal(sameEvent(a, { ...a, title: 'SI Midterm 1 Review' }), true);
  assert.equal(sameEvent(a, { ...a, start: '10:00' }), false);
  assert.equal(sameEvent(a, { ...a, courseId: 2 }), false);
  assert.equal(sameEvent(a, { ...a, title: 'Lab safety quiz' }), false);
  // deadlines at 11:59 PM share a night, not an identity (a real pattern: a lab with several items due one night)
  const d = { courseId: 1, date: '2026-09-23', start: '23:59', title: 'PreLab Quiz - How Fast Does It React' };
  assert.equal(sameEvent(d, { ...d, title: 'Procedure - How Fast Does It React' }), false);
  assert.equal(sameEvent(d, { ...d, start: null, title: 'PreLab quiz: how fast does it react' }), true);
  assert.equal(sameEvent({ ...d, title: 'Project 1 reminder' }, { ...d, title: 'Project 1' }, true), true, 'against a Brightspace item, paraphrase is fine');
  const [i] = smartItems([{ id: 'sa:1:0', annId: 1, courseId: 1, kind: 'review', title: 'Review', date: '2026-09-21', start: '19:00', end: '21:00', location: '', quote: 'q', status: 'added' },
    { id: 'sa:1:1', annId: 1, courseId: 1, kind: 'review', title: 'x', date: '2026-09-21', start: null, end: null, quote: 'q', status: 'review' }]);
  assert.equal(i.kind, 'event');
  assert.equal(new Date(i.due).getHours(), 19);
  assert.equal(isDone(i, {}, new Date('2026-09-22T12:00:00')), true, 'events are over once past');
  assert.equal(isDone({ ...i, eventKind: 'deadline' }, {}, new Date('2026-09-22T12:00:00')), false, 'deadlines wait to be checked off');
});

test('parseReply: tolerant of chatty wrapping, strict about the result', () => {
  const wrap = result => JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.003, result });
  assert.equal(parseReply(wrap('```json\n{"events":[{"title":"x"}]}\n```')).events.length, 1);
  assert.throws(() => parseReply(wrap('no json here')), /expected format/);
  assert.throws(() => parseReply('', 'Invalid API key · Please run /login'), e => e.kind === 'auth');
  assert.throws(() => parseReply(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })), e => e.kind === 'agent');
});

// ---------- integration ----------
test('off by default: no data, no items, routes refuse', async () => {
  const s = await start();
  try {
    const d = await s.data();
    assert.equal(d.smart, null);
    assert.equal(d.items.some(i => i.kind === 'event'), false);
    assert.equal((await s.post('/api/smart/scan')).status, 409);
  } finally { await s.stop(); }
});

test('scan: sure class events are added, optional or incomplete ones wait for review, known exams are not repeated', async () => {
  const s = await start();
  try {
    await enable(s);
    const d = await s.scanned();
    assert.equal(d.smart.lastError, null);
    const events = d.items.filter(i => i.kind === 'event');
    assert.deepEqual(events.map(e => [e.eventKind, e.title]), [['review', 'SI review session for Exam 1']]);
    assert.equal(new Date(events[0].due).getHours(), 19);
    assert.ok(events[0].instructions.includes('Supplemental Instruction will hold'));
    assert.deepEqual(d.smart.review.map(f => [f.kind, f.missing]).sort(), [['class-change', ['time']], ['deadline', []], ['optional', []]]);
    assert.equal(d.smart.review.find(f => f.kind === 'deadline').courseId, 203, 'a sure deadline from a non-class site (Wellness Modules) still asks first');
    assert.equal(d.smart.counts.added, 1, 'the Project 1 reminder restates an assignment Brightspace already has, so it is skipped');
    assert.equal([...events, ...d.smart.review].some(x => /Project 1/.test(x.title)), false);
    assert.equal(d.items.some(i => i.kind === 'event' && i.exam), false);
    assert.equal(d.smart.pending, 0, 'everything read once');
  } finally { await s.stop(); }
});

test('decide: accept (with filled-in fields), decline, remove; bad fields are refused', async () => {
  const s = await start();
  try {
    await enable(s);
    let d = await s.scanned();
    const lab = d.smart.review.find(f => f.missing.includes('time'));
    const fair = d.smart.review.find(f => f.kind === 'optional');
    assert.equal((await s.post('/api/smart/decide', { id: lab.id, action: 'accept', fields: { title: 'Makeup lab', date: lab.date, start: '15:00', end: '14:00' } })).status, 400);
    assert.equal((await s.post('/api/smart/decide', { id: lab.id, action: 'accept', fields: { title: '', date: lab.date } })).status, 400);
    assert.equal((await s.post('/api/smart/decide', { id: lab.id, action: 'accept', fields: { title: 'Makeup lab', date: lab.date, start: '15:00', end: '17:00', location: 'EE 063' } })).status, 200);
    assert.equal((await s.post('/api/smart/decide', { id: fair.id, action: 'decline' })).status, 200);
    await s.post('/api/smart/decide', { id: d.smart.review.find(f => f.kind === 'deadline').id, action: 'decline' });
    d = await s.data();
    assert.equal(d.smart.review.length, 0);
    const made = d.items.find(i => i.id === lab.id);
    assert.equal(made.title, 'Makeup lab');
    assert.equal(made.location, 'EE 063');
    assert.equal(new Date(made.due).getHours(), 15);
    assert.equal(d.items.some(i => i.id === fair.id), false);
    await s.post('/api/smart/decide', { id: lab.id, action: 'remove' });
    d = await s.data();
    assert.equal(d.items.some(i => i.id === lab.id), false);
    assert.equal((await s.post('/api/smart/decide', { id: 'sa:nope', action: 'accept' })).status, 404);
    // turning the feature off hides everything; data is kept for turning it back on
    await s.post('/api/state', { features: { smartAnnouncements: false } });
    d = await s.data();
    assert.equal(d.smart, null);
    assert.equal(d.items.some(i => i.kind === 'event'), false);
    assert.ok(fs.existsSync(path.join(s.dir, 'smart-ann.json')));
  } finally { await s.stop(); }
});

test('safety: an event whose quote is not in the announcement is dropped', async () => {
  const s = await start({ mode: 'invented' });
  try {
    await enable(s);
    const d = await s.scanned();
    assert.equal([...d.items, ...d.smart.review].some(x => /HACKED/.test(x.title)), false);
    assert.equal(d.items.filter(i => i.kind === 'event').length, 1, 'the real events still come through');
  } finally { await s.stop(); }
});

test('failures are reported with a clear kind, and nothing is marked read', async () => {
  for (const [mode, kind, env] of [['notloggedin', 'auth'], ['garbage', 'agent'], ['hang', 'timeout', { DASH_SMART_TIMEOUT: '1500' }]]) {
    const s = await start({ mode, env });
    try {
      await enable(s);
      const d = await s.scanned();
      assert.equal(d.smart.lastError?.kind, kind, mode);
      assert.ok(d.smart.pending > 0, `${mode}: announcements stay unread so they are tried again`);
    } finally { await s.stop(); }
  }
});

test('announcements from courses unticked in Settings → Courses are ignored until the course is ticked again', async () => {
  const s = await start();
  try {
    await s.post('/api/state', { hiddenCourses: { 104: true } }); // ENGL 106: its announcement is the career fair
    await enable(s);
    let d = await s.scanned();
    assert.equal(d.smart.review.some(f => f.kind === 'optional'), false, 'nothing from the unticked course');
    assert.equal(d.smart.pending, 0, 'and it is not waiting to be sent to Claude either');
    await s.post('/api/state', { hiddenCourses: { 104: false } });
    for (let i = 0; i < 50 && !(d = await s.data()).smart.review.some(f => f.kind === 'optional'); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(d.smart.review.some(f => f.kind === 'optional' && f.courseId === 104), 'ticking it again reads its announcements');
  } finally { await s.stop(); }
});
