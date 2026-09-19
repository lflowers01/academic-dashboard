// Integration tests for the optional Syllabus scan feature: the real server against a fake Brightspace
// (fixtures/fake-mcp.mjs: an overview with a midterm, a "Course Syllabus" file) and a fake Claude (fixtures/fake-syllabus.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteInText, verifySyllabusEvent, verifyGrading } from './logic.mjs';
import { fileText, joinSources } from './syllabus-text.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise(r => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });

async function start({ mode = 'ok', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-syl-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, DASH_PORT: String(port), DASH_DATA: dir, DASH_TOAST_LOG: path.join(dir, 'toasts.log'),
    DASH_MCP_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-mcp.mjs')]),
    DASH_BOILEREXAMS_FILE: path.join(ROOT, 'fixtures', 'boilerexams-test.json'),
    DASH_SYLLABUS_CMD: JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-syllabus.mjs')]), FAKE_SYLLABUS_MODE: mode, ...env,
  } });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/data'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const post = async (p, body = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const data = async () => (await fetch(base + '/api/data')).json();
  const until = async (ok, what) => { for (let i = 0; i < 200; i++) { const d = await data(); if (ok(d)) return d; await new Promise(r => setTimeout(r, 100)); } throw new Error(`timed out waiting for ${what}`); };
  await until(d => d.refreshedAt && !d.refreshing, 'the first refresh');
  return { post, data, until, dir, stop: () => new Promise(r => { child.once('exit', r); child.kill(); }) };
}
const enable = s => s.post('/api/state', { features: { syllabusScan: true } });
const scanned = s => s.until(d => d.syllabus && !d.syllabus.running && d.syllabus.classes.every(c => c.scannedAt), 'the scan');

// ---------- unit ----------
test('quoteInText tolerates PDF table order, not invention', () => {
  const t = 'Week 5 Topic\nExam 1\nThurs. Sept. 24\n8:00 - 9:00 PM\nMidterm review';
  assert.equal(quoteInText('Exam 1 Thurs. Sept. 24 8:00 - 9:00 PM', t), true);
  assert.equal(quoteInText('exam 1   thurs sept 24', t), true);
  assert.equal(quoteInText('Exam 1 Fri. Oct. 2 8:00 PM', t), false);
  assert.equal(quoteInText('Exam', t), false, 'too short to mean anything');
});

test('verifySyllabusEvent / verifyGrading keep only what the syllabus says', () => {
  const now = new Date('2026-09-19T12:00:00');
  const text = 'Midterm Exam 2 is on Tuesday, October 20 from 8:00-9:00 PM.\nWorkshop 5 on Oct 22.\nQuizzes 15%\nFinal Exam 25%\nA: 93%';
  const ok = verifySyllabusEvent({ kind: 'exam', title: 'Midterm Exam 2', date: '2026-10-20', start: '20:00', end: '21:00', confidence: 'high', quote: 'Midterm Exam 2 is on Tuesday, October 20 from 8:00-9:00 PM.' }, text, 7, now);
  assert.deepEqual([ok.kind, ok.start, ok.end, ok.sure, ok.source, ok.courseId], ['exam', '20:00', '21:00', true, 'syllabus', 7]);
  assert.equal(verifySyllabusEvent({ kind: 'class-change', title: 'Workshop 5', date: '2026-10-22', confidence: 'high', quote: 'Workshop 5 on Oct 22' }, text, 7, now), null, 'a regular session is not a class change');
  assert.equal(verifySyllabusEvent({ kind: 'exam', title: 'X', date: '2026-10-20', confidence: 'high', quote: 'Exam 9 is on the moon' }, text, 7, now), null);
  assert.equal(verifySyllabusEvent({ ...ok, quote: ok.quote, date: '2026-09-01', confidence: 'high' }, text, 7, now), null, 'already over');
  const g = verifyGrading({ type: 'weighted', components: [{ name: 'Quizzes', weight: 15, quote: 'Quizzes 15%' }, { name: 'Final Exam', weight: 25, quote: 'Final Exam 25%' }, { name: 'Vibes', weight: 60, quote: 'Vibes 60%' }], scale: [{ letter: 'A', min: 93 }, { letter: 'Pass', min: 0 }] }, text);
  assert.deepEqual(g, { type: 'weighted', components: [{ name: 'Quizzes', value: 15 }, { name: 'Final Exam', value: 25 }], scale: [{ letter: 'A', min: 93 }], total: 40 });
  assert.equal(verifyGrading({ type: 'vibes', components: [] }, text), null);
});

test('syllabus files: HTML, text, and the joined text is capped with source headings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-syltxt-'));
  fs.writeFileSync(path.join(dir, 's.html'), '<h1>MA 162</h1><p>Exam 1 is on <b>Sept 24</b>.</p>');
  fs.writeFileSync(path.join(dir, 's.txt'), 'Quizzes 15%\r\n\r\n\r\n\r\nFinal 25%');
  assert.match(await fileText(path.join(dir, 's.html')), /MA 162\s+Exam 1 is on Sept 24\./);
  assert.equal(await fileText(path.join(dir, 's.txt')), 'Quizzes 15%\n\nFinal 25%');
  await assert.rejects(fileText(path.join(dir, 's.exe')), /can't read/);
  const joined = joinSources([{ name: 'A', text: 'x'.repeat(100_000) }, { name: 'B', text: 'y'.repeat(100_000) }]);
  assert.ok(joined.startsWith('=== A ===') && joined.includes('=== B ===') && joined.length <= 120_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- integration ----------
test('off by default; turning it on reads each class: Brightspace overview + syllabus file → events and grading', async () => {
  const s = await start();
  try {
    let d = await s.data();
    assert.equal(d.syllabus, null);
    assert.equal((await s.post('/api/syllabus/scan')).status, 409);
    await enable(s);
    d = await scanned(s);
    assert.equal(d.syllabus.lastError, null);
    assert.deepEqual(d.syllabus.classes.map(c => c.short).sort(), ['CS 159', 'MA 162']);
    const ma = d.syllabus.classes.find(c => c.short === 'MA 162'), cs = d.syllabus.classes.find(c => c.short === 'CS 159');
    assert.deepEqual(ma.sources.map(x => x.name), ['Course overview (Brightspace)']);
    assert.deepEqual(cs.sources.map(x => x.name), ['Course Syllabus (Brightspace)'], 'only the syllabus file, not "Lecture 1 slides"');
    assert.deepEqual(ma.grading, { type: 'weighted', components: [{ name: 'Quizzes', value: 20 }, { name: 'Midterms', value: 45 }, { name: 'Final Exam', value: 35 }], scale: [], total: 100 });
    assert.deepEqual(cs.grading.components.map(c => [c.name, c.value]), [['Projects', 300], ['Exams', 400], ['Labs', 100]]);
    const events = d.items.filter(i => i.source === 'syllabus');
    assert.deepEqual(events.map(e => [e.courseId, e.eventKind]).sort(), [[101, 'exam'], [102, 'deadline']]);
    const mid = events.find(e => e.courseId === 101);
    assert.equal(new Date(mid.due).getHours(), 20);
    assert.match(mid.instructions, /^From the syllabus:/);
    assert.equal(mid.sourceAnnouncement, null);
  } finally { await s.stop(); }
});

test('adding a file rescans that class; bad files are refused; files can be removed', async () => {
  const s = await start();
  try {
    await enable(s); await scanned(s);
    const when = new Date(); when.setDate(when.getDate() + 30);
    const long = when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const add = (body) => s.post('/api/syllabus/file', body);
    assert.equal((await add({ courseId: 999, name: 's.txt', data: 'eA==' })).status, 400, 'not one of your classes');
    assert.equal((await add({ courseId: 101, name: 'virus.exe', data: 'eA==' })).status, 400);
    assert.equal((await add({ courseId: 101, name: 's.txt', data: '' })).status, 400);
    const r = await add({ courseId: 101, name: '../../MA 162 schedule.txt', data: Buffer.from(`The Final Exam is on ${long} from 8:00-10:00 AM in ELLT 116.`).toString('base64') });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'MA 162 schedule.txt', 'the path part of the name is dropped');
    const d = await s.until(x => x.items.some(i => i.source === 'syllabus' && /Final Exam/.test(i.title)), 'the added file to be read');
    assert.deepEqual(d.syllabus.classes.find(c => c.id === 101).files, [r.body.name]);
    assert.equal((await s.post('/api/syllabus/file-remove', { courseId: 101, name: r.body.name })).status, 200);
    assert.deepEqual((await s.data()).syllabus.classes.find(c => c.id === 101).files, []);
  } finally { await s.stop(); }
});

test('safety: an event or grading part that is not in the syllabus is dropped; failures keep classes to retry', async () => {
  let s = await start({ mode: 'invented' });
  try {
    await enable(s);
    const d = await scanned(s);
    assert.equal(d.items.some(i => /HACKED/.test(i.title)), false);
    assert.equal(d.syllabus.classes.some(c => c.grading?.components.some(x => x.name === 'Made up')), false);
  } finally { await s.stop(); }
  s = await start({ mode: 'notloggedin' });
  try {
    await enable(s);
    const d = await s.until(x => x.syllabus?.lastError, 'the error');
    assert.equal(d.syllabus.lastError.kind, 'auth');
    assert.ok(d.syllabus.classes.some(c => c.rescan), 'not marked as read');
  } finally { await s.stop(); }
});

test('what blocks adding without asking: a missing date always, a missing time only for exams/reviews/help, never a missing room', async () => {
  const { blocksAdding } = await import('./logic.mjs');
  assert.equal(blocksAdding(['location'], 'exam', 'Midterm Exam 2'), false);
  assert.equal(blocksAdding(['time'], 'exam', 'Quiz 4'), false, 'a quiz on a known day is fine all day');
  assert.equal(blocksAdding(['time'], 'deadline', 'HW 4'), false);
  assert.equal(blocksAdding(['time'], 'exam', 'Final Exam'), true);
  assert.equal(blocksAdding(['time'], 'review', 'Exam 1 review'), true);
  assert.equal(blocksAdding(['date'], 'deadline', 'Essay'), true);
});
