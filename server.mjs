import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildItems, refreshDue, nextSlot, shortName, currentTerm, viewModel, digestItems, digestMessage, digestLink, boilerexamsKey, FEATURES, isVisible, htmlToText, featureOn, cleanGradeConfig, courseTerm, onCalendar } from './logic.mjs';
import { createGcal } from './gcal-routes.mjs';
import { createSmart } from './smart-ann.mjs';
import { createSyllabus } from './syllabus.mjs';
import { createUpdater, restartServer } from './update.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = process.argv.includes('--fixture');
// Demo mode: Google Calendar talks to a fake Claude so it works offline with made-up calendars.
if (FIXTURE && !process.env.DASH_GCAL_CMD) process.env.DASH_GCAL_CMD = JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-claude.mjs')]);
if (FIXTURE && !process.env.DASH_SYLLABUS_CMD) process.env.DASH_SYLLABUS_CMD = JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-syllabus.mjs')]); // demo's fake syllabus reader
if (FIXTURE && !process.env.DASH_SMART_CMD) process.env.DASH_SMART_CMD = JSON.stringify([process.execPath, path.join(ROOT, 'fixtures', 'fake-smart.mjs')]); // demo's fake announcement reader
// DASH_PORT / DASH_DATA exist for tests and for anyone whose port 4321 is taken.
const PORT = Number(process.env.DASH_PORT) || 4321;
const DATA = process.env.DASH_DATA ? path.resolve(process.env.DASH_DATA) : path.join(ROOT, FIXTURE ? 'data-demo' : 'data'); // demo never touches real data
const URL_SELF = `http://localhost:${PORT}/`;
const RETRY_MIN = [5, 15, 30];
fs.mkdirSync(DATA, { recursive: true });
if (FIXTURE && !process.env.FAKE_GCAL_STATE) process.env.FAKE_GCAL_STATE = path.join(DATA, 'fake-gcal.json'); // demo's fake Google Calendar

// ---------- log (capped) ----------
const LOG = path.join(DATA, 'server.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) {
      const buf = fs.readFileSync(LOG);
      fs.writeFileSync(LOG, buf.subarray(buf.length - 200_000));
    }
    fs.appendFileSync(LOG, line);
  } catch {}
}
process.on('uncaughtException', e => log('uncaught', e.stack || e));
process.on('unhandledRejection', e => log('unhandled', e?.stack || e));

// ---------- json storage ----------
const file = n => path.join(DATA, n);
// A damaged file (e.g. power cut mid-save) falls back to the last good backup; only if that's bad too do we start fresh.
function readJson(n, dflt) {
  try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT' && !fs.existsSync(file(n) + '.bak')) return dflt;
    try { fs.copyFileSync(file(n), file(n) + '.bad'); } catch {}
    try {
      const v = JSON.parse(fs.readFileSync(file(n) + '.bak', 'utf8'));
      log(`could not read ${n} (${e.message}); restored the previous backup (damaged copy kept as ${n}.bad)`);
      return v;
    } catch {
      log(`could not read ${n} (${e.message}) and no usable backup; starting fresh (damaged copy kept as ${n}.bad)`);
      return dflt;
    }
  }
}
// Save = write a temp file, force it to disk, keep the previous version as .bak, then swap it in atomically.
function writeJson(n, v) {
  const tmp = file(n) + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(v)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.copyFileSync(file(n), file(n) + '.bak'); } catch {}
  fs.renameSync(tmp, file(n));
}

// Fixture mode: fictional sample data, shifted by whole days so it's always "around today".
function loadFixture() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/sample.json'), 'utf8'));
  const shift = Math.round((Date.now() - Date.parse(raw.anchor)) / 864e5) * 864e5;
  const walk = o => { for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object') walk(v);
    else if (/^(dueDate|startDate|endDate|date|createdDate)$/.test(k) && v) o[k] = new Date(Date.parse(v) + shift).toISOString();
  } };
  walk(raw);
  // dates written in announcement text ("Wednesday, September 23") move with the data, or the demo drifts into the past
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const year = new Date(raw.anchor).getFullYear();
  const DATE_RE = new RegExp(`\\b((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, )?(${MONTHS.join('|')}) (\\d{1,2})\\b`, 'g');
  const retext = t => String(t || '').replace(DATE_RE, (m, weekday, mon, day) =>
    new Date(new Date(year, MONTHS.indexOf(mon), +day, 12).getTime() + shift)
      .toLocaleDateString('en-US', weekday ? { weekday: 'long', month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric' }));
  for (const x of raw.announcements || []) { x.title = retext(x.title); x.body = retext(x.body); }
  return { raw, refreshedAt: new Date().toISOString(), firstSeen: {}, failedCourses: [] };
}
let cache = FIXTURE ? loadFixture() : readJson('cache.json', null);
let tasks = readJson('tasks.json', []);
if (!Array.isArray(tasks)) tasks = [];
// notes: your own notes on Brightspace items, by item id. Never pruned, so a note survives an item briefly vanishing.
// features: optional features switched on in ⚙ Settings (all off by default).
const STATE_DEFAULTS = { done: {}, seenAnnouncements: [], hiddenCourses: {}, calendarHidden: {}, notes: {}, features: {}, grades: {}, notifications: true, lastDigest: null };
let state = { ...STATE_DEFAULTS, ...readJson('state.json', {}) };
delete state.notified; // from the earlier per-item notification design
const meta = { lastAttemptAt: null, lastError: null, paused: false, retryIndex: 0, nextRetryAt: null, refreshing: null, notifyBlocked: null };
// Windows silently drops notifications when they're switched off in Settings; remember that so the page can say so.
async function checkNotifyBlock() {
  const { notificationBlock } = await import('./toast.mjs');
  meta.notifyBlocked = await notificationBlock().catch(() => null);
  return meta.notifyBlocked;
}

// ---------- Boilerexams ----------
// Which courses have a Boilerexams page. Checked on start-up, every 6 hours, and right away when a new exam shows up,
// so every exam gets a "Study on Boilerexams" button whenever that course exists there. Failures keep the last list.
// DASH_BOILEREXAMS_FILE (tests / demo) reads the list from a file instead of the internet.
let boilerexams = readJson('boilerexams.json', { fetchedAt: null, courses: [] });
let beFetching = null;
function refreshBoilerexams(reason, force = false) {
  const fresh = boilerexams.fetchedAt && Date.now() - new Date(boilerexams.fetchedAt) < 6 * 3600_000;
  if ((fresh && !force) || beFetching) return beFetching;
  beFetching = (async () => {
    try {
      const file = process.env.DASH_BOILEREXAMS_FILE || (FIXTURE ? path.join(ROOT, 'fixtures', 'boilerexams.json') : null);
      const list = file ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : await (await fetch('https://api.boilerexams.com/courses', { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'academic-dashboard' } })).json();
      if (!Array.isArray(list)) throw new Error('unexpected reply');
      const courses = list.filter(c => c && c.abbreviation && c.number && c.flags?.published !== false).map(c => ({ abbreviation: String(c.abbreviation).toUpperCase(), number: Number(c.number) }));
      boilerexams = { fetchedAt: new Date().toISOString(), courses };
      if (!FIXTURE) writeJson('boilerexams.json', boilerexams);
      log(`boilerexams (${reason}): ${courses.length} courses`);
    } catch (e) { log(`boilerexams (${reason}) failed: ${e.message}; keeping the last list`); }
    finally { beFetching = null; }
  })();
  return beFetching;
}
const examIds = () => new Set(itemsOf().filter(i => i.exam).map(i => i.id));

// ---------- Google Calendar (optional feature, gcal-routes.mjs) ----------
const gcal = createGcal({ state, readJson, writeJson, log, itemsOf: () => itemsOf(), courses: () => coursesOf(cache?.raw) });

// ---------- updates (always on, update.mjs) ----------
const updater = createUpdater({ root: ROOT, dataDir: DATA, readJson, writeJson, log, onRestart: () => restartServer(ROOT, cb => server.close(cb)) });
// demo and test servers don't ask GitHub (tests start many throwaway servers), unless a test points them at a fake
const CHECK_UPDATES = process.env.DASH_UPDATE_API || (!FIXTURE && !process.env.DASH_MCP_CMD);

// ---------- view helpers ----------
const coursesOf = raw => (raw?.courses || []).map(c => ({ id: c.id, name: c.name, code: c.code, short: shortName(c) }));
// ---------- Smart Announcements (optional feature, smart-ann.mjs) ----------
const smart = createSmart({ state, readJson, writeJson, log, announcements: () => cache?.raw?.announcements || [], courses: () => coursesOf(cache?.raw), calendar: () => calendarWith(syllabus.items()), mine: () => myTasks(),
  // courses ticked in ⚙ Settings → Courses (same rule the page uses); announcements from the others are ignored
  visibleCourses: () => visibleCourses() });

// ---------- Syllabus scan (optional feature, syllabus.mjs) ----------
const syllabus = createSyllabus({ state, readJson, writeJson, log, dataDir: DATA, courses: () => coursesOf(cache?.raw),
  calendar: () => calendarWith(smart.items()), mine: () => myTasks(), visibleCourses: () => visibleCourses(),
  fetchSources: FIXTURE ? demoSyllabi : (ids, dir) => import('./brightspace.mjs').then(m => m.fetchSyllabusSources(ids, dir)) });
// demo: fixtures/demo-syllabi/<courseId>.html, with {{+Nd}} turned into a date N days from today
async function demoSyllabi(ids) {
  const out = {};
  for (const id of ids) {
    const f = path.join(ROOT, 'fixtures', 'demo-syllabi', `${id}.html`);
    if (!fs.existsSync(f)) continue;
    const html = fs.readFileSync(f, 'utf8').replace(/\{\{\+(\d+)d\}\}/g, (m, n) => { const d = new Date(); d.setDate(d.getDate() + Number(n)); return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); });
    out[id] = [{ name: 'Syllabus (demo)', text: htmlToText(html) }];
  }
  return out;
}
function visibleCourses() { const list = coursesOf(cache?.raw); return new Set(list.filter(c => isVisible(c, brightspaceItems(), state, new Date(), currentTerm(list))).map(c => c.id)); }

const brightspaceItems = () => buildItems(cache?.raw || {});
// for the scanners' duplicate check (onCalendar in logic.mjs): what's on the calendar besides that feature's own finds
const shortById = () => Object.fromEntries(coursesOf(cache?.raw).map(c => [c.id, c.short]));
const calendarWith = found => onCalendar({ items: [...brightspaceItems(), ...found], tasks, google: gcal.payload()?.events || [], shortById: shortById() });
const myTasks = () => onCalendar({ tasks, shortById: shortById() });
function itemsOf() {
  return [...brightspaceItems(), ...smart.items(), ...syllabus.items()].map(i => ({ ...i, firstSeen: cache?.firstSeen?.[i.id] }));
}

// ---------- notifications ----------
// A digest of what's due today / early tomorrow, sent after start-up and after every scheduled refresh.
async function sendDigest(reason) {
  if (FIXTURE || !state.notifications || !cache) return;
  const courses = coursesOf(cache.raw);
  const now = new Date();
  const { all } = viewModel({ items: itemsOf(), tasks, courses, state, term: currentTerm(courses) }, now);
  const due = digestItems(all, now);
  const short = Object.fromEntries(courses.map(c => [c.id, c.short]));
  let msg = digestMessage(due, now, i => short[i.courseId] || '');
  const events = gcal.digestLine(now); // only when the user turned "include Google events" on
  if (events) msg = msg ? { ...msg, lines: [...msg.lines, events] } : { title: 'Today', lines: [events] };
  // a new version is mentioned once, in the next digest (friends who rarely open the page still hear about it)
  const newVersion = updater.available();
  const updateLine = newVersion && state.updateNotified !== newVersion ? `Dashboard update available (v${newVersion}): open the dashboard to install it` : null;
  if (updateLine) msg = msg ? { ...msg, lines: [...msg.lines, updateLine] } : { title: 'Academic Dashboard', lines: [updateLine] };
  if (!msg) return log(`digest (${reason}): nothing due today`);
  // Start-up and the first refresh happen together; don't send the same digest twice within 90 minutes.
  const sig = JSON.stringify(msg);
  if (state.lastDigest?.sig === sig && now - new Date(state.lastDigest.at) < 90 * 60_000) return;
  if (await checkNotifyBlock()) return log(`digest (${reason}): ${msg.title} → not shown, Windows notifications are off (${meta.notifyBlocked})`);
  const { showToast } = await import('./toast.mjs');
  const r = await showToast(msg.title, msg.lines, digestLink(URL_SELF, due)); // click → opens those items
  log(`digest (${reason}): ${msg.title} → ${r.ok ? 'shown' : 'FAILED ' + r.error}`);
  if (r.ok) { state.lastDigest = { sig, at: now.toISOString() }; if (updateLine) state.updateNotified = newVersion; writeJson('state.json', state); }
}

// ---------- refresh ----------
async function doRefresh() {
  if (FIXTURE) return;
  const { fetchAll } = await import('./brightspace.mjs');
  try {
    const examsBefore = examIds();
    const { raw, failedCourses } = await fetchAll(cache?.raw);
    const items = buildItems(raw);
    const firstRun = !cache;
    const firstSeen = {};
    const now = new Date().toISOString();
    // First run: baseline everything as "old" so nothing shows NEW.
    for (const i of items) firstSeen[i.id] = cache?.firstSeen?.[i.id] || (firstRun ? '1970-01-01T00:00:00Z' : now);
    for (const a of raw.announcements || []) {
      const k = `ann:${a.id}`;
      firstSeen[k] = cache?.firstSeen?.[k] || (firstRun ? '1970-01-01T00:00:00Z' : now);
      if (firstRun) state.seenAnnouncements.push(a.id);
    }
    cache = { raw, refreshedAt: now, firstSeen, failedCourses };
    writeJson('cache.json', cache);
    pruneState([...items, ...smart.items(), ...syllabus.items()], raw.announcements || []); // found events keep their checkmarks too
    Object.assign(meta, { lastError: null, paused: false, retryIndex: 0, nextRetryAt: null });
    log(`refresh ok: ${items.length} items, ${failedCourses.length} course(s) failed`);
    // A new exam appeared → check Boilerexams now, not in up to 6 hours.
    const newExam = items.some(i => i.exam && !examsBefore.has(i.id));
    refreshBoilerexams(newExam ? 'new exam' : 'scheduled', newExam);
  } catch (e) {
    const kind = e.kind || 'network';
    meta.lastError = { kind, message: String(e.message).slice(0, 300), at: new Date().toISOString() };
    if (kind === 'auth') { meta.paused = true; meta.nextRetryAt = null; }
    else if (meta.retryIndex < RETRY_MIN.length) {
      meta.nextRetryAt = new Date(Date.now() + RETRY_MIN[meta.retryIndex++] * 60_000).toISOString();
    } else meta.nextRetryAt = null;
    log(`refresh FAILED (${kind}): ${e.message}`);
  } finally {
    meta.lastAttemptAt = new Date().toISOString();
  }
}

// Single flight: a second request joins the running refresh.
function refresh() {
  meta.refreshing ??= doRefresh().finally(() => { meta.refreshing = null; });
  return meta.refreshing;
}

function pruneState(items, announcements) {
  const ids = new Set([...items.map(i => i.id), ...tasks.map(t => t.id)]);
  state.done = Object.fromEntries(Object.entries(state.done).filter(([k]) => ids.has(k)));
  const annIds = new Set(announcements.map(a => a.id));
  state.seenAnnouncements = [...new Set(state.seenAnnouncements)].filter(id => annIds.has(id));
  writeJson('state.json', state);
}

// 60 s tick survives sleep/hibernate: on wake it sees a missed slot and refreshes once.
// Scheduled refreshes (and start-up) end with a digest, even when the refresh failed (cached data still counts).
async function tick() {
  const now = new Date();
  if (meta.refreshing) return;
  const retry = meta.nextRetryAt && now >= new Date(meta.nextRetryAt);
  const slot = !meta.nextRetryAt && refreshDue(now, meta.lastAttemptAt);
  if (!retry && !slot) return;
  if (meta.paused) { // signed out: don't touch Brightspace (MFA prompts), but keep reminding from cached data
    if (slot) { meta.lastAttemptAt = now.toISOString(); await sendDigest('scheduled, signed out'); }
    return;
  }
  await refresh();
  if (slot) await sendDigest(meta.lastAttemptAt && !meta.startupDigestSent ? 'start-up' : 'scheduled');
  meta.startupDigestSent = true;
}

// ---------- api ----------
function payload() {
  const raw = cache?.raw || { courses: [], announcements: [] };
  const now = new Date();
  const courses = coursesOf(raw);
  return {
    fixture: FIXTURE,
    refreshedAt: cache?.refreshedAt || null,
    nextRefreshAt: meta.paused ? null : (meta.nextRetryAt || nextSlot(now).toISOString()),
    refreshing: !!meta.refreshing,
    notifyBlocked: meta.notifyBlocked,
    lastError: meta.lastError,
    paused: meta.paused,
    failedCourses: cache?.failedCourses || [],
    courses,
    term: currentTerm(courses),
    items: itemsOf(),
    announcements: (raw.announcements || [])
      .filter(a => !a.startDate || new Date(a.startDate) <= now)
      .map(a => ({ id: a.id, title: a.title, body: a.body, date: a.date || a.createdDate, courseId: a.courseId, firstSeen: cache?.firstSeen?.[`ann:${a.id}`] })),
    tasks,
    state,
    // course id → Boilerexams key, for courses that exist there
    boilerexams: Object.fromEntries(courses.map(c => [c.id, boilerexamsKey(c, boilerexams.courses)]).filter(([, k]) => k)),
    gcal: gcal.payload(), // null unless the Google Calendar feature is on
    smart: smart.payload(), // null unless Smart Announcements is on
    syllabus: syllabus.payload(), // null unless Syllabus scan is on
    update: updater.payload(),
    // Grades (optional feature): each class's gradebook rows, plus the scheme its syllabus gives (if Syllabus scan read one)
    grades: featureOn(state, 'grades') ? coursesOf(raw).filter(c => { const t = currentTerm(courses); return t && courseTerm(c) === t; })
      .map(c => ({ id: c.id, short: c.short, rows: (raw.grades?.[c.id]?.grades || []).filter(r => r && typeof r.name === 'string'), suggestion: syllabus.grading(c.id) })) : null,
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const readBody = (req, max = 1e6) => new Promise((ok, fail) => { // max: characters (syllabus uploads pass more)
  let s = '', tooBig = false;
  req.setEncoding('utf8');
  // Past the limit (1 MB by default): stop keeping the data but let the upload finish, so the client gets a real 413 instead of a reset.
  req.on('data', c => { if (!tooBig) { s += c; if (s.length > max) { tooBig = true; s = ''; } } });
  req.on('end', () => {
    if (tooBig) return fail(Object.assign(new Error('too large'), { status: 413 }));
    try { const v = s ? JSON.parse(s) : {}; ok(v && typeof v === 'object' ? v : {}); } catch { fail(Object.assign(new Error('bad json'), { status: 400 })); }
  });
  req.on('error', fail);
});

function cleanTask(b, existing) {
  const title = String(b.title || '').trim().slice(0, 200);
  const date = String(b.date || '');
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(`${date}T00:00`))) return null;
  if (b.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) return null;
  const endDate = b.endDate ? String(b.endDate) : '';
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || isNaN(new Date(`${endDate}T00:00`)) || endDate < date)) return null;
  const courseId = Number(b.courseId);
  return {
    id: existing?.id || `task:${randomUUID()}`, title, date, endDate: endDate && endDate > date ? endDate : '', time: b.time || '',
    courseId: Number.isFinite(courseId) && courseId > 0 ? courseId : null,
    exam: !!b.exam, notes: String(b.notes || '').slice(0, 2000),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding guard: only answer to our own host names.
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // Other websites can't call the API: non-GET needs a JSON content type (forces a CORS preflight we never answer).
    if (req.method !== 'GET' && req.method !== 'HEAD' && !String(req.headers['content-type']).startsWith('application/json'))
      return send(res, 415, { error: 'json only' });

    if (p === '/api/data' && req.method === 'GET') return send(res, 200, payload());

    if (p === '/api/refresh' && req.method === 'POST') {
      meta.paused = false; // a manual refresh is allowed to try sign-in again
      await refresh();
      return send(res, 200, { ok: !meta.lastError, error: meta.lastError });
    }

    if (p === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const idx = b.id ? tasks.findIndex(t => t.id === b.id) : -1;
      const wasExam = !!tasks[idx]?.exam;
      const t = cleanTask(b, tasks[idx]);
      if (!t) return send(res, 400, { error: 'a title and a valid date are required (end date can’t be before the start)' });
      if (idx >= 0) tasks[idx] = t; else tasks.push(t);
      writeJson('tasks.json', tasks);
      if (t.exam && !wasExam) await refreshBoilerexams('exam task', true);
      return send(res, 200, t);
    }

    if (p.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/tasks/'.length));
      tasks = tasks.filter(t => t.id !== id);
      delete state.done[id];
      writeJson('tasks.json', tasks); writeJson('state.json', state);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/state' && req.method === 'POST') {
      const b = await readBody(req);
      for (const [k, v] of Object.entries(b.done || {})) v === null ? delete state.done[k] : (state.done[k] = !!v);
      for (const [k, v] of Object.entries(b.hiddenCourses || {})) v === null ? delete state.hiddenCourses[k] : (state.hiddenCourses[k] = !!v);
      // legend toggles: courses (or Google calendars) hidden on the calendar view only
      for (const [k, v] of Object.entries(b.calendarHidden || {})) { const key = String(k).slice(0, 300); v ? (state.calendarHidden[key] = true) : delete state.calendarHidden[key]; }
      for (const [k, v] of Object.entries(b.notes || {})) {
        const key = String(k).slice(0, 200), text = v == null ? '' : String(v).slice(0, 5000);
        text.trim() ? (state.notes[key] = text) : delete state.notes[key]; // empty note = no note
      }
      if (Array.isArray(b.seenAnnouncements)) state.seenAnnouncements = [...new Set([...state.seenAnnouncements, ...b.seenAnnouncements])];
      if (typeof b.notifications === 'boolean') state.notifications = b.notifications;
      // Grades: how a class is graded, rows moved between categories, rows left out / counted anyway (checked first, then saved)
      if (b.grades && typeof b.grades === 'object') {
        const next = {};
        for (const [id, v] of Object.entries(b.grades).slice(0, 50)) next[String(id).slice(0, 20)] = v === null ? null : cleanGradeConfig(v); // throws 400 on bad input
        for (const [id, v] of Object.entries(next)) v === null ? delete state.grades[id] : (state.grades[id] = { ...(state.grades[id] || {}), ...v });
      }
      if (b.updateSnooze === null || (b.updateSnooze && typeof b.updateSnooze.version === 'string')) state.updateSnooze = b.updateSnooze && { version: b.updateSnooze.version.slice(0, 20), until: new Date(Date.now() + 3 * 86400_000).toISOString() };
      for (const [k, v] of Object.entries(b.features || {})) if (FEATURES.some(f => f.id === k) && typeof v === 'boolean') state.features[k] = v; // unknown ids ignored
      if (b.features || b.hiddenCourses) { smart.tick(); syllabus.tick(); } // Smart Announcements switched on, or a course ticked again → scan now, not at the next tick
      writeJson('state.json', state);
      return send(res, 200, state);
    }

    if (p === '/api/notify-test' && req.method === 'POST') {
      if (await checkNotifyBlock()) return send(res, 200, { ok: false, blocked: meta.notifyBlocked });
      const { showToast } = await import('./toast.mjs');
      const r = await showToast('Academic Dashboard', ['Notifications are working. You’ll get a list of what’s due today when Windows starts and every 3 hours.'], URL_SELF);
      return send(res, 200, r);
    }

    if (p === '/api/notification-settings' && req.method === 'POST') {
      const { openNotificationSettings } = await import('./toast.mjs');
      openNotificationSettings();
      return send(res, 200, { ok: true });
    }

    if (await gcal.handle(req, res, p, { readBody, send })) return;
    if (await smart.handle(req, res, p, { readBody, send })) return;
    if (await syllabus.handle(req, res, p, { readBody, send })) return;
    if (await updater.handle(req, res, p, { readBody, send })) return;

    if (p === '/api/signin' && req.method === 'POST') {
      const { openSignInWindow } = await import('./brightspace.mjs');
      openSignInWindow();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const pub = path.join(ROOT, 'public');
      const fp = rel === 'logic.mjs' ? path.join(ROOT, 'logic.mjs') : path.join(pub, rel);
      if (rel !== 'logic.mjs' && !fp.startsWith(pub + path.sep)) return send(res, 404, { error: 'not found' });
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    log('request error', e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  }
});
server.requestTimeout = 6 * 60_000; // /api/refresh can legitimately take ~4 min

// After an in-app update the new server starts while the old one is still closing: wait for the port (up to 30 s).
let portTries = 0;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && process.env.DASH_WAIT_PORT && portTries++ < 60) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 500);
  log(`server error: ${e.message}${e.code === 'EADDRINUSE' ? ` (port ${PORT} busy — is the dashboard already running?)` : ''}`); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  delete process.env.DASH_WAIT_PORT;
  if (CHECK_UPDATES) { updater.tick(); setInterval(() => updater.tick(), 60 * 60_000); }
  log(`dashboard on ${URL_SELF}${FIXTURE ? ' (demo data)' : ''}`);
  checkNotifyBlock();
  refreshBoilerexams('start-up');
  setInterval(checkNotifyBlock, 5 * 60_000);
  gcal.tick(); setInterval(() => gcal.tick(), 60_000); // Google Calendar sync schedule (no-op while the feature is off)
  smart.tick(); setInterval(() => smart.tick(), 60_000); // scans new announcements (no-op while Smart Announcements is off)
  syllabus.tick(); setInterval(() => syllabus.tick(), 60_000); // reads syllabi of classes not read yet (no-op while Syllabus scan is off)
  if (!FIXTURE) { tick(); setInterval(tick, 60_000); }
});
