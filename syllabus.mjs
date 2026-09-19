// Syllabus scan (optional feature), server side: reads each class's syllabus (Brightspace overview + syllabus/schedule
// files + files the student adds), asks Claude for dated items and the grading scheme, checks every answer against the
// text, and keeps the results in data/syllabus.json. Inert unless ⚙ Settings → Features → Syllabus scan is on.
// See spec-next-features.md §2.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude-json.mjs';
import { SYLLABUS_SYSTEM } from './syllabus-prompt.mjs';
import { fileText, joinSources, SYLLABUS_TYPES } from './syllabus-text.mjs';
import { featureOn, verifySyllabusEvent, verifyGrading, sameEvent, smartStatus, smartItems, eventFields, dayKey, courseTerm, currentTerm } from './logic.mjs';

const TIMEOUT = Number(process.env.DASH_SYLLABUS_TIMEOUT) || 180_000;
const RETRY_AFTER_FAIL = 30 * 60_000;
const MAX_FILE = 15 * 1024 * 1024;

export function createSyllabus({ state, readJson, writeJson, log, dataDir, courses, itemsOf, visibleCourses, fetchSources }) {
  const store = { courses: {}, found: [], lastRun: null, lastError: null, lastCostUsd: null, ...readJson('syllabus.json', {}) };
  let running = false, lastAttempt = 0;
  const on = () => featureOn(state, 'syllabusScan');
  const save = () => writeJson('syllabus.json', store);
  const root = path.join(dataDir, 'syllabi');
  const addedDir = id => path.join(root, 'added', String(id));
  const addedFiles = id => { try { return fs.readdirSync(addedDir(id)).filter(f => SYLLABUS_TYPES.includes(path.extname(f).toLowerCase())); } catch { return []; } };
  // this term's classes that are ticked in ⚙ Settings → Courses
  const classes = () => { const list = courses(), term = currentTerm(list), shown = visibleCourses(); return list.filter(c => term && courseTerm(c) === term && shown.has(c.id)); };
  const pending = () => classes().filter(c => !store.courses[c.id]?.scannedAt || store.courses[c.id]?.rescan);
  const over = f => new Date(`${f.date}T${f.end || f.start || '23:59'}`) < new Date();

  async function scan(reason) {
    if (!on() || running) return;
    const todo = pending();
    if (!todo.length) return;
    running = true; lastAttempt = Date.now();
    let cost = 0;
    const done = new Set();
    try {
      let fromBrightspace = {};
      if (fetchSources) {
        try { fromBrightspace = await fetchSources(todo.map(c => c.id), path.join(root, 'brightspace')); }
        catch (e) { log(`syllabus: Brightspace sources failed (${e.message}); using added files only`); }
      }
      for (const c of todo) {
        const now = new Date();
        const entry = store.courses[c.id] = { ...(store.courses[c.id] || {}), rescan: false, error: null, note: null };
        const parts = [], problems = [];
        for (const s of fromBrightspace[c.id] || []) {
          try { parts.push({ name: s.name, text: s.text ?? await fileText(s.file) }); } catch (e) { problems.push(`${s.name}: ${e.message}`); }
        }
        for (const f of addedFiles(c.id)) {
          try { parts.push({ name: f, text: await fileText(path.join(addedDir(c.id), f)) }); } catch (e) { problems.push(`${f}: ${e.message}`); }
        }
        entry.sources = parts.filter(p => p.text).map(p => ({ name: p.name, chars: p.text.length }));
        entry.problems = problems;
        const text = joinSources(parts);
        if (text.length < 40) { entry.note = 'None in Brightspace — add the file below'; entry.scannedAt = now.toISOString(); done.add(c.id); save(); continue; }
        const { body, cost: c1 } = await askClaude({ system: SYLLABUS_SYSTEM, name: 'syllabus', cmdVar: 'DASH_SYLLABUS_CMD', timeout: TIMEOUT,
          input: { course: c.short, year: now.getFullYear(), today: dayKey(now), text } });
        cost += c1;
        // already on the calendar: Brightspace items, announced exams, Smart Announcements events, earlier finds
        const pad = n => String(n).padStart(2, '0');
        const existing = itemsOf().filter(i => i.due).map(i => ({ courseId: i.courseId, date: dayKey(i.due), title: i.title, exam: !!i.exam,
          start: i.allDay ? null : `${pad(new Date(i.due).getHours())}:${pad(new Date(i.due).getMinutes())}` }));
        let added = 0, review = 0;
        for (const ev of Array.isArray(body.events) ? body.events : []) {
          const f = verifySyllabusEvent(ev, text, c.id, now);
          if (!f) continue;
          if (f.kind === 'exam' && existing.some(x => x.exam && x.courseId === f.courseId && x.date === f.date)) continue;
          if (existing.some(x => sameEvent(x, f, true)) || store.found.some(x => sameEvent(x, f))) continue;
          const { sure, ...keep } = f;
          const st = smartStatus({ ...f, sure }, store.found, true);
          const n = Math.max(-1, ...store.found.filter(x => x.courseId === c.id).map(x => Number(x.id.split(':').pop()))) + 1;
          store.found.push({ ...keep, id: `sy:${c.id}:${n}`, ...st });
          st.status === 'added' ? added++ : review++;
        }
        entry.grading = verifyGrading(body.grading, text);
        entry.counts = { added, review };
        entry.scannedAt = now.toISOString(); done.add(c.id);
        save();
      }
      store.lastError = null;
      log(`syllabus (${reason}): ${todo.length} class(es) read ($${cost.toFixed(3)})`);
    } catch (e) {
      store.lastError = { kind: e.kind || 'agent', message: String(e.message).slice(0, 300), at: new Date().toISOString() };
      for (const c of todo) if (!done.has(c.id)) (store.courses[c.id] ||= {}).rescan = true; // tried again later
      log(`syllabus (${reason}) failed (${e.kind}): ${e.message}`);
    } finally {
      store.lastRun = new Date().toISOString();
      store.lastCostUsd = Math.round(cost * 1000) / 1000;
      running = false;
      save();
    }
  }

  function tick() {
    if (on() && !running && pending().length && (!store.lastError || Date.now() - lastAttempt >= RETRY_AFTER_FAIL)) scan('new classes or files');
  }
  const isClass = id => classes().some(c => c.id === id);

  async function handle(req, res, p, { readBody, send }) {
    if (!p.startsWith('/api/syllabus/') || req.method !== 'POST') return false;
    if (!on()) { send(res, 409, { error: 'Syllabus scan is turned off (⚙ Settings → Features).' }); return true; }
    try {
      if (p === '/api/syllabus/file') {
        const b = await readBody(req, 25e6); // base64 of a file up to 15 MB
        const id = Number(b.courseId);
        if (!isClass(id)) { send(res, 400, { error: 'Pick one of your classes.' }); return true; }
        const name = path.basename(String(b.name || '')).replace(/[^\w .()\-]+/g, '_').slice(0, 120);
        if (!SYLLABUS_TYPES.includes(path.extname(name).toLowerCase())) { send(res, 400, { error: 'Add a PDF, Word (.docx) or web page (.html) file.' }); return true; }
        const buf = Buffer.from(String(b.data || ''), 'base64');
        if (!buf.length || buf.length > MAX_FILE) { send(res, 400, { error: 'That file is empty or bigger than 15 MB.' }); return true; }
        fs.mkdirSync(addedDir(id), { recursive: true });
        fs.writeFileSync(path.join(addedDir(id), name), buf);
        (store.courses[id] ||= {}).rescan = true; store.lastError = null; save();
        scan('file added');
        send(res, 200, { ok: true, name }); return true;
      }
      const b = await readBody(req);
      if (p === '/api/syllabus/file-remove') {
        const id = Number(b.courseId), name = path.basename(String(b.name || ''));
        if (!isClass(id) || !addedFiles(id).includes(name)) { send(res, 404, { error: 'No such file.' }); return true; }
        fs.rmSync(path.join(addedDir(id), name), { force: true });
        send(res, 200, { ok: true }); return true;
      }
      if (p === '/api/syllabus/scan') {
        const ids = b.courseId != null ? [Number(b.courseId)].filter(isClass) : classes().map(c => c.id);
        for (const id of ids) (store.courses[id] ||= {}).rescan = true;
        store.lastError = null; save();
        scan('manual');
        send(res, 202, { ok: true }); return true;
      }
      if (p === '/api/syllabus/decide') {
        const f = store.found.find(x => x.id === b.id);
        if (!f) { send(res, 404, { error: 'That event is gone.' }); return true; }
        if (b.action === 'decline' || b.action === 'remove') f.status = 'declined';
        else if (b.action === 'accept') Object.assign(f, b.fields ? eventFields(b.fields, f) : {}, { status: 'added', accepted: true, maybe: undefined });
        else { send(res, 400, { error: 'Unknown action.' }); return true; }
        save(); send(res, 200, { ok: true }); return true;
      }
      send(res, 404, { error: 'not found' }); return true;
    } catch (e) { send(res, e.status || 500, { error: e.message }); return true; }
  }

  return {
    handle, tick,
    items: () => (on() ? smartItems(store.found) : []),
    // the grading scheme read from a class's syllabus, for the Grades feature (null when unknown or the feature is off)
    grading: id => (on() ? store.courses[id]?.grading || null : null),
    payload: () => {
      if (!on()) return null;
      const shown = visibleCourses();
      return {
        running, lastRun: store.lastRun, lastError: store.lastError, lastCostUsd: store.lastCostUsd,
        // counts are what's there now for the class (not just what the last scan added)
        classes: classes().map(c => ({ id: c.id, short: c.short, files: addedFiles(c.id), ...store.courses[c.id],
          counts: store.courses[c.id]?.scannedAt ? { added: store.found.filter(f => f.courseId === c.id && f.status === 'added').length, review: store.found.filter(f => f.courseId === c.id && f.status === 'review' && !over(f)).length } : null })),
        review: store.found.filter(f => f.status === 'review' && !over(f) && shown.has(f.courseId)),
      };
    },
  };
}
