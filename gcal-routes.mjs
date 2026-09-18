// Google Calendar feature, server side: settings, sync scheduling, event changes, permission checks.
// Everything here is inert unless ⚙ Settings → Features → Google Calendar is on. See spec-google-calendar.md.
import * as bridge from './gcal.mjs';
import { featureOn, normalizeEvent, localIso, GCAL_WINDOW, addDays, dayKey, matchGoogle, eventDays } from './logic.mjs';

const SYNC_EVERY = 6 * 3600_000;
const RETRY_AFTER_FAIL = 30 * 60_000;
// Outline colors for calendars (the connector doesn't expose Google's own colors); user can change them.
const GPALETTE = ['#8ab4f8', '#f28b82', '#fdd663', '#81c995', '#ff8bcb', '#c58af9', '#78d9ec', '#fcad70', '#e6c9a8', '#aecbfa'];

export function createGcal({ state, readJson, writeJson, log, itemsOf, courses }) {
  let store = { calendars: [], events: [], syncedAt: null, window: null, loaded: [], lastError: null, lastCostUsd: null, ...readJson('gcal.json', {}) };
  let running = null, lastAttempt = 0;
  const S = () => (state.gcal ||= { calendars: {}, showOnCalendar: true, showTodayStrip: true, digest: false });
  const on = () => featureOn(state, 'googleCalendar');
  const save = () => writeJson('gcal.json', store);
  const saveState = () => writeJson('state.json', state);
  const shownIds = () => store.calendars.filter(c => S().calendars[c.id]?.show).map(c => c.id);
  const editable = id => !!(S().calendars[id]?.show && S().calendars[id]?.edit && store.calendars.some(c => c.id === id));
  const cost = c => { store.lastCostUsd = Math.round(c * 1000) / 1000; };

  async function job(name, fn) {
    running = name;
    try { const r = await fn(); store.lastError = null; save(); return r; }
    catch (e) { store.lastError = { kind: e.kind || 'agent', message: String(e.message).slice(0, 300), at: new Date().toISOString() }; save(); log(`gcal ${name} failed (${e.kind}): ${e.message}`); throw e; }
    finally { running = null; }
  }

  function connect() {
    return job('connect', async () => {
      const r = await bridge.listCalendars();
      cost(r.cost);
      store.calendars = r.calendars;
      // give new calendars a color; nothing is shown or editable until the user says so
      let n = Object.keys(S().calendars).length;
      for (const c of r.calendars) S().calendars[c.id] ||= { show: false, edit: false, color: GPALETTE[n++ % GPALETTE.length] };
      saveState();
      log(`gcal connect: ${r.calendars.length} calendars ($${r.cost.toFixed(3)})`);
      return store.calendars;
    });
  }

  function syncWindow(now = new Date()) {
    const from = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -GCAL_WINDOW.back);
    return { from, to: addDays(from, GCAL_WINDOW.back + GCAL_WINDOW.ahead) };
  }

  async function read(ids, from, to) {
    const r = await bridge.listEvents(ids.map(calendarId => ({ calendarId, startTime: localIso(from), endTime: localIso(to) })));
    cost(r.cost);
    return Object.entries(r.byCalendar).flatMap(([cal, evs]) => evs.map(e => normalizeEvent(e, cal)).filter(Boolean));
  }

  function sync(reason = 'manual') {
    lastAttempt = Date.now();
    return job('sync', async () => {
      const ids = shownIds();
      const { from, to } = syncWindow();
      const events = ids.length ? await read(ids, from, to) : [];
      store.events = events;
      store.window = { from: from.toISOString(), to: to.toISOString() };
      store.loaded = [];
      store.syncedAt = new Date().toISOString();
      log(`gcal sync (${reason}): ${events.length} events from ${ids.length} calendar(s) ($${(store.lastCostUsd || 0).toFixed(3)})`);
    });
  }

  // "Load Google events for <month>" (outside the regular window; never automatic because it costs usage)
  function loadRange(from, to) {
    return job('load', async () => {
      const ids = shownIds();
      if (!ids.length) return;
      const events = await read(ids, from, to);
      const byId = new Map(store.events.map(e => [e.id, e]));
      for (const e of events) byId.set(e.id, e);
      store.events = [...byId.values()];
      store.loaded.push({ from: from.toISOString(), to: to.toISOString() });
    });
  }

  // ---------- event changes (only on calendars with "Allow edits") ----------
  function eventArgs(b) {
    const title = String(b.title || '').trim().slice(0, 300);
    const start = new Date(b.start), end = new Date(b.end);
    if (!title) throw Object.assign(new Error('A title is required.'), { status: 400 });
    if (isNaN(start) || isNaN(end) || end <= start) throw Object.assign(new Error('The end must be after the start.'), { status: 400 });
    if (end - start > 62 * 86400_000) throw Object.assign(new Error('Events can be at most 62 days long.'), { status: 400 });
    const args = { calendarId: b.calendarId, summary: title, startTime: localIso(start), endTime: localIso(end) };
    if (b.allDay) args.allDay = true;
    if (b.location) args.location = String(b.location).slice(0, 500);
    if (b.description) args.description = String(b.description).slice(0, 5000);
    return args;
  }
  function upsert(raw, calendarId, replaceId) {
    const ev = normalizeEvent(raw, calendarId);
    store.events = store.events.filter(e => e.id !== replaceId && (!ev || e.id !== ev.id));
    if (ev) store.events.push(ev);
    return ev;
  }
  const findEvent = id => store.events.find(e => e.id === id);

  async function change(b) {
    const op = b.op;
    if (op === 'create') {
      if (!editable(b.calendarId)) throw Object.assign(new Error('That calendar isn’t allowed to be edited (⚙ Settings → Google Calendar).'), { status: 403 });
      const args = eventArgs(b);
      return job('create', async () => { const r = await bridge.createEvent(args); cost(r.cost); return upsert(r.event, args.calendarId); });
    }
    const ev = findEvent(b.id);
    if (!ev) throw Object.assign(new Error('That event isn’t loaded any more; sync and try again.'), { status: 404 });
    if (!editable(ev.calendarId)) throw Object.assign(new Error('That calendar isn’t allowed to be edited (⚙ Settings → Google Calendar).'), { status: 403 });
    if (op === 'update') {
      const args = { ...eventArgs({ ...b, calendarId: ev.calendarId }), eventId: ev.eventId, allDay: !!b.allDay };
      if (!b.location) args.location = '';
      if (!b.description) args.description = '';
      return job('update', async () => { const r = await bridge.updateEvent(args); cost(r.cost); return upsert(r.event, ev.calendarId, ev.id); });
    }
    if (op === 'delete') {
      return job('delete', async () => {
        const r = await bridge.deleteEvent({ calendarId: ev.calendarId, eventId: ev.eventId });
        cost(r.cost);
        store.events = store.events.filter(e => e.id !== ev.id);
        return { deleted: ev.id };
      });
    }
    throw Object.assign(new Error('Unknown operation.'), { status: 400 });
  }

  // "Add to Google Calendar" from a Brightspace item: the event is built here from the server's own copy of the item.
  function fromItem({ itemId, calendarId }) {
    const item = itemsOf().find(i => i.id === itemId);
    if (!item || !item.due) throw Object.assign(new Error('That item isn’t available.'), { status: 404 });
    const shortById = Object.fromEntries(courses().map(c => [c.id, c.short]));
    const already = matchGoogle([item], store.events, shortById).byItem.get(item.id);
    if (already) throw Object.assign(new Error('It’s already in Google Calendar.'), { status: 409, event: already });
    const short = shortById[item.courseId] || '';
    const due = new Date(item.due);
    let start, end, title, allDay = false;
    if (item.exam) {
      title = `${short} ${item.title}`.trim();
      if (item.allDay) { start = new Date(due.getFullYear(), due.getMonth(), due.getDate()); end = addDays(start, 1); allDay = true; }
      else { start = due; end = item.end ? new Date(item.end) : new Date(+due + 3600_000); }
    } else {
      title = `Due: ${item.title}${short ? ` (${short})` : ''}`;
      start = new Date(+due - 15 * 60_000); end = due;
    }
    const description = `Added from Academic Dashboard.${item.url ? `\nBrightspace: ${item.url}` : ''}`;
    return change({ op: 'create', calendarId, title, start: start.toISOString(), end: end.toISOString(), allDay, description });
  }

  // ---------- routes ----------
  async function handle(req, res, p, { readBody, send }) {
    if (!p.startsWith('/api/gcal/')) return false;
    if (!on()) { send(res, 409, { error: 'Google Calendar is turned off (⚙ Settings → Features).' }); return true; }
    if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
    const b = await readBody(req);
    try {
      if (p === '/api/gcal/connect') { await connect(); return send(res, 200, { ok: true }), true; }
      if (p === '/api/gcal/sync') { await sync('manual'); return send(res, 200, { ok: true }), true; }
      if (p === '/api/gcal/load') {
        const from = new Date(b.from), to = new Date(b.to);
        if (isNaN(from) || isNaN(to) || to <= from || to - from > 45 * 86400_000) return send(res, 400, { error: 'Bad range.' }), true;
        await loadRange(from, to); return send(res, 200, { ok: true }), true;
      }
      if (p === '/api/gcal/settings') {
        const g = S();
        for (const [id, v] of Object.entries(b.calendars || {})) {
          if (!store.calendars.some(c => c.id === id)) continue;
          const cur = g.calendars[id] ||= { show: false, edit: false, color: GPALETTE[0] };
          if (typeof v.show === 'boolean') cur.show = v.show;
          if (typeof v.edit === 'boolean') cur.edit = v.edit;
          if (typeof v.todo === 'boolean') cur.todo = v.todo; // listed in the to-do column's Today strip (default no)
          if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) cur.color = v.color;
          if (!cur.show) cur.edit = cur.todo = false; // "Allow edits" and "To-do" need "Show"
        }
        for (const k of ['showOnCalendar', 'showTodayStrip', 'digest']) if (typeof b[k] === 'boolean') g[k] = b[k];
        saveState();
        // a newly shown calendar has no events yet → read now
        const newlyShown = Object.entries(b.calendars || {}).some(([id, v]) => v.show === true && !store.events.some(e => e.calendarId === id));
        if (newlyShown && !running) sync('calendar shown').catch(() => {});
        return send(res, 200, { ok: true }), true;
      }
      if (p === '/api/gcal/event') { const r = await change(b); return send(res, 200, { ok: true, event: r }), true; }
      if (p === '/api/gcal/from-item') { const r = await fromItem(b); return send(res, 200, { ok: true, event: r }), true; }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 502, { error: e.message, kind: e.kind || null, event: e.event || null });
    }
    return true;
  }

  function payload() {
    if (!on()) return null;
    const shown = new Set(shownIds());
    const next = store.syncedAt && shown.size ? new Date(Math.max(Date.now(), +new Date(store.syncedAt) + SYNC_EVERY)).toISOString() : null;
    return {
      connected: store.calendars.length > 0,
      calendars: store.calendars.map(c => ({ ...c, show: false, edit: false, todo: false, ...S().calendars[c.id] })),
      events: store.events.filter(e => shown.has(e.calendarId)),
      settings: { showOnCalendar: S().showOnCalendar !== false, showTodayStrip: S().showTodayStrip !== false, digest: !!S().digest },
      syncedAt: store.syncedAt, nextSyncAt: next, window: store.window, loaded: store.loaded,
      lastError: store.lastError, lastCostUsd: store.lastCostUsd, running,
    };
  }

  // every 6 h (and at start-up) while on, connected and something is shown; after a failure wait 30 min
  function tick() {
    if (!on() || running || !store.calendars.length || !shownIds().length) return;
    const due = !store.syncedAt || Date.now() - new Date(store.syncedAt) >= SYNC_EVERY;
    if (due && Date.now() - lastAttempt >= RETRY_AFTER_FAIL) sync('scheduled').catch(() => {});
  }

  // optional line for the Windows digest (off unless the user turned it on)
  function digestLine(now = new Date()) {
    if (!on() || !S().digest) return null;
    const today = dayKey(now), shown = new Set(shownIds());
    const evs = store.events.filter(e => shown.has(e.calendarId) && !e.allDay && eventDays(e).includes(today)).sort((a, b) => new Date(a.start) - new Date(b.start));
    if (!evs.length) return null;
    const t = d => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const list = evs.slice(0, 3).map(e => `${t(e.start)} ${e.title}`).join(', ');
    return `Events: ${list}${evs.length > 3 ? ` (+${evs.length - 3})` : ''}`;
  }

  return { handle, payload, tick, digestLine };
}
