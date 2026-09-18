// Google Calendar feature, page side. Plugs into app.js through window.dash.hooks; does nothing while the
// feature is off (data.gcal is null). See spec-google-calendar.md.
import { matchGoogle, eventDays, dayKey, addDays, GCAL_WINDOW } from '/logic.mjs';

const D = window.dash;
const { h, hooks } = D;
// on = the feature switch is on AND the server sent Google data (the switch hides everything instantly, before the next fetch)
const on = () => !!D.data?.gcal && D.data?.state?.features?.googleCalendar === true;
const G = () => D.data.gcal;
const calById = () => Object.fromEntries(G().calendars.map(c => [c.id, c]));
const calColor = id => calById()[id]?.color || '#8ab4f8';
const calName = id => calById()[id]?.summary || 'Google Calendar';
const editableCals = () => G().calendars.filter(c => c.show && c.edit);
const isEditable = ev => !ev.pending && editableCals().some(c => c.id === ev.calendarId);
let src = D.pref('gsrc') || 'all'; // calendar filter: all | brightspace | google
const showGoogle = () => on() && G().settings.showOnCalendar && src !== 'brightspace';
const midnight = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
const fill = (box, ...nodes) => box.replaceChildren(...nodes.flat().filter(n => n != null && n !== false)); // replaceChildren would print "null"

// Changes in flight: shown right away with a "Saving to Google…" look; replaced by Google's copy when done.
// hidden: ids of real events being edited/deleted (not drawn); drafts: the "saving" versions to draw instead.
const hidden = new Set(), drafts = new Map();
const busy = () => hidden.size + drafts.size > 0;

// Result of the last Google action, shown next to the calendar title. The status line gets rewritten on every
// refresh, so it can't hold these: successes fade after 8 s, errors stay until dismissed.
let notice = null, noticeTimer = null;
let loadingMonth = false; // "Load Google events" clicked, waiting for Google
function note(text, kind = 'ok') {
  notice = { text, kind };
  clearTimeout(noticeTimer);
  if (kind !== 'error') noticeTimer = setTimeout(() => { notice = null; D.render(); }, kind === 'busy' ? 60_000 : 8000);
  D.render();
}

const timeRange = ev => ev.allDay ? 'all day' : `${D.fmtTime(ev.start)}–${D.fmtTime(ev.end)}`;
const whenText = ev => {
  if (ev.allDay) {
    const last = addDays(new Date(ev.end), -1);
    return dayKey(ev.start) === dayKey(last) ? `${D.fmtDay(ev.start)} · all day` : `${D.fmtDay(ev.start)} – ${D.fmtDay(last)} · all day`;
  }
  return `${D.fmtFull(ev.start)} – ${D.fmtTime(ev.end)}`;
};

// ---------- model: events + duplicates merged into Brightspace items ----------
hooks.model.push((m, data) => {
  if (!on()) return; // feature off → no Google anything (strip, badges, merges), even before the next fetch
  const shortById = Object.fromEntries(data.courses.map(c => [c.id, c.short]));
  const real = data.gcal.events.filter(e => !hidden.has(e.id));
  const { byItem, merged } = matchGoogle(m.all, real, shortById);
  m.gcal = { byItem, events: [...real.filter(e => !merged.has(e.id)), ...drafts.values()] };
});

// "Google only" hides Brightspace items and tasks from the calendar (the to-do list is unaffected)
hooks.itemFilter.push(() => !(on() && src === 'google' && G().settings.showOnCalendar));

// ---------- chips ----------
function gchip(ev, where = 'cell') {
  const t = ev.allDay ? '' : (where === 'cell' ? D.compactTime(D.fmtTime(ev.start)) : timeRange(ev));
  return h('button', {
    type: 'button', class: `chip gchip${ev.pending ? ' pending' : ''}`, style: { '--g': calColor(ev.calendarId) },
    title: `${ev.title} · ${ev.allDay ? whenText(ev) : timeRange(ev)}${ev.location ? ' · ' + ev.location : ''} · ${calName(ev.calendarId)}${ev.pending ? ' · saving to Google…' : ''}`,
    onclick: e => { e.stopPropagation(); openEvent(ev); },
  }, h('span', { class: 'gmark', 'aria-label': 'Google Calendar' }, '◷'), t ? h('span', { class: 't' }, t) : null, ev.title,
  where === 'block' && ev.location ? h('span', { class: 'muted' }, ` · ${ev.location}`) : null);
}
function gspan(ev, s) {
  return h('button', {
    type: 'button', class: ['chip', 'gchip', 'span', s.contLeft && 'cont-left', s.contRight && 'cont-right', ev.pending && 'pending'].filter(Boolean).join(' '),
    style: { '--g': calColor(ev.calendarId), 'grid-column': `${s.col + 1} / span ${s.span}`, 'grid-row': String(s.lane + 2) },
    title: `${ev.title} · ${whenText(ev)} · ${calName(ev.calendarId)}`, onclick: e => { e.stopPropagation(); openEvent(ev); },
  }, s.contLeft ? h('span', { class: 'cont' }, '◂ ') : null, h('span', { class: 'gmark' }, '◷'), ev.title, s.contRight ? h('span', { class: 'cont' }, ' ▸') : null);
}

hooks.calendar.push(m => {
  if (!m.gcal || !showGoogle()) return null;
  const singles = [], spans = [];
  for (const ev of m.gcal.events) {
    if (D.calHidden(ev.calendarId)) continue;
    const days = eventDays(ev);
    if (ev.allDay && days.length > 1) spans.push({ id: ev.id, startDay: midnight(ev.start), endDay: midnight(addDays(new Date(ev.end), -1)), node: s => gspan(ev, s) });
    else for (const day of days) singles.push({ day, at: ev.allDay ? midnight(ev.start) : new Date(ev.start), node: gchip(ev) });
  }
  return { singles, spans };
});

hooks.day.push((m, d) => {
  if (!m.gcal || !showGoogle()) return null;
  const k = dayKey(d), allDay = [], blocks = [];
  for (const ev of m.gcal.events) {
    if (!eventDays(ev).includes(k) || D.calHidden(ev.calendarId)) continue;
    if (ev.allDay) allDay.push(gchip(ev, 'allday'));
    else blocks.push({ id: ev.id, start: ev.start, end: ev.end, node: () => gchip(ev, 'block') });
  }
  return { allDay, blocks };
});

hooks.legend.push(() => {
  if (!on() || !G().settings.showOnCalendar || src === 'brightspace') return [];
  return G().calendars.filter(c => c.show).map(c => D.legendButton(c.id, `Google Calendar: ${c.summary}`, { class: 'gtag', style: { '--g': c.color } }, ['◷ ', c.summary]));
});

// ---------- Today strip ----------
let stripOpen = D.pref('gstrip') !== 'closed';
hooks.todoTop.push(m => {
  if (!m.gcal || !G().settings.showTodayStrip) return null;
  const today = dayKey(new Date()), now = new Date();
  const inTodo = new Set(G().calendars.filter(c => c.show && c.todo).map(c => c.id));
  const evs = m.gcal.events.filter(e => inTodo.has(e.calendarId) && eventDays(e).includes(today)).sort((a, b) => (b.allDay - a.allDay) || new Date(a.start) - new Date(b.start));
  if (!evs.length) return null;
  const next = evs.find(e => !e.allDay && new Date(e.end) > now);
  return h('section', { class: 'today-strip' },
    h('button', { type: 'button', class: 'strip-head', 'aria-expanded': stripOpen, onclick: () => { stripOpen = !stripOpen; D.pref('gstrip', stripOpen ? 'open' : 'closed'); D.render(); } },
      h('span', {}, stripOpen ? '▾' : '▸'), h('strong', {}, 'Today'), h('span', { class: 'muted' }, ` · ${evs.length} event${evs.length > 1 ? 's' : ''} from Google Calendar`)),
    stripOpen ? h('div', { class: 'strip-list' }, evs.map(ev => h('button', {
      type: 'button', class: ['strip-row', !ev.allDay && new Date(ev.end) <= now && 'past', ev === next && 'next'].filter(Boolean).join(' '),
      style: { '--g': calColor(ev.calendarId) }, onclick: () => openEvent(ev) },
      h('span', { class: 'strip-time' }, ev.allDay ? 'all day' : D.fmtTime(ev.start)),
      h('span', { class: 'strip-title' }, ev.title),
      ev.location ? h('span', { class: 'muted strip-loc' }, ev.location) : null))) : null);
});

// ---------- toolbar: source filter + "Load events for <month>" ----------
hooks.toolbar.push(m => {
  if (!on()) return [];
  const out = [];
  if (notice) out.push(h('span', { class: `gnotice ${notice.kind}`, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text,
    notice.kind === 'error' ? h('button', { type: 'button', class: 'gnotice-x', 'aria-label': 'Dismiss', onclick: () => { notice = null; D.render(); } }, '✕') : null));
  if (G().settings.showOnCalendar && G().connected) {
    out.push(h('div', { class: 'seg src-filter', role: 'group', 'aria-label': 'Show on calendar' },
      ...[['all', 'All'], ['brightspace', 'Brightspace'], ['google', 'Google']].map(([k, label]) =>
        h('button', { type: 'button', 'aria-pressed': src === k, 'data-src': k, onclick: () => { src = k; D.pref('gsrc', k); D.render(); } }, label))));
  }
  const range = viewRange();
  if (range && G().calendars.some(c => c.show) && !covered(range)) {
    const month = new Date(range.from.getFullYear(), range.from.getMonth(), 1);
    out.push(h('button', { type: 'button', class: 'load-month', disabled: !!G().running || loadingMonth, onclick: () => loadMonth(month) },
      G().running === 'load' || loadingMonth ? [h('span', { class: 'spin' }, '↻'), ' Loading…'] : `Load Google events for ${month.toLocaleDateString([], { month: 'long' })}`));
  }
  return out;
});
function viewRange() {
  const c = D.view.cursor, mode = D.view.mode;
  if (mode === 'month') return { from: new Date(c.getFullYear(), c.getMonth(), 1), to: new Date(c.getFullYear(), c.getMonth() + 1, 1) };
  const d = midnight(c);
  if (mode === 'day') return { from: d, to: addDays(d, 1) };
  const s = addDays(d, -d.getDay());
  return { from: s, to: addDays(s, 7) };
}
function covered({ from, to }) {
  if (!G().window) return true; // not synced yet
  const ranges = [G().window, ...(G().loaded || [])].map(r => [new Date(r.from), new Date(r.to)]);
  if (ranges.some(([a, b]) => a <= from && b >= to)) return true;
  // a current month whose early days are before the window is fine; offer loading only for later days
  // not yet loaded, or for a view that lies entirely before the window
  const w = [new Date(G().window.from), new Date(G().window.to)];
  const laterMissing = to > w[1] && !ranges.some(([a, b]) => a <= Math.max(from, w[1]) && b >= to);
  const allBefore = to <= w[0] && !ranges.some(([a, b]) => a <= from && b >= to);
  return !(laterMissing || allBefore);
}
async function loadMonth(month) {
  const from = month, to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  loadingMonth = true;
  note('Loading Google events… (about 20 s)', 'busy');
  try { await D.api('/api/gcal/load', { from, to }); note('Loaded ✓'); } catch (e) { note(`Couldn’t load Google events: ${e.message}`, 'error'); }
  loadingMonth = false;
  D.reload();
}

// ---------- to-do rows + details for Brightspace items ----------
hooks.rowBadges.push((i, m) => m?.gcal?.byItem.get(i.id) ? [h('span', { class: 'badge b-gcal', title: 'Also in your Google Calendar' }, '◷ In Google')] : []);

hooks.itemDetails.push((i, m) => {
  if (!on() || !m?.gcal || i.kind === 'task') return [];
  const ev = m.gcal.byItem.get(i.id);
  if (ev) return [h('div', { class: 'ginfo', style: { '--g': calColor(ev.calendarId) } },
    h('strong', {}, '◷ In Google Calendar · ', calName(ev.calendarId)),
    h('div', {}, whenText(ev), ev.location ? ` · ${ev.location}` : ''),
    ev.description ? h('div', { class: 'instr' }, D.linkNodes(ev.description)) : null,
    ev.htmlLink ? h('a', { href: ev.htmlLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Calendar ↗') : null)];
  const cals = editableCals();
  if (!cals.length || !i.due) return [];
  const preferred = (i.exam && cals.find(c => /exam/i.test(c.summary))) || cals[0];
  const sel = h('select', { class: 'gcal-select', 'aria-label': 'Google calendar' }, cals.map(c => h('option', { value: c.id, selected: c.id === preferred.id }, c.summary)));
  const msg = h('span', { class: 'muted', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'gadd', onclick: async () => {
    btn.disabled = true; msg.textContent = 'Adding to Google… (about 15 s)';
    try { await D.api('/api/gcal/from-item', { itemId: i.id, calendarId: sel.value }); msg.textContent = 'Added ✓'; D.reload(); }
    catch (e) { btn.disabled = false; msg.textContent = `Couldn’t add: ${e.message}`; }
  } }, '◷ Add to Google Calendar');
  return [h('div', { class: 'gadd-row' }, btn, ' to ', sel, ' ', msg)];
});

// ---------- event details ----------
function openEvent(ev) {
  const editable = isEditable(ev);
  let confirmDel = false;
  const del = h('button', { type: 'button', class: 'danger', onclick: () => {
    if (!confirmDel) { confirmDel = true; del.textContent = `Really delete from ${calName(ev.calendarId)}?`; return; }
    document.querySelector('#dlgItem').close();
    save('delete', ev, {});
  } }, 'Delete');
  document.querySelector('#itemBody').replaceChildren(h('div', { class: 'detail' },
    h('h2', {}, h('span', { class: 'gtag', style: { '--g': calColor(ev.calendarId) } }, '◷ ', calName(ev.calendarId)), ' ', ev.title),
    h('dl', {}, h('dt', {}, 'When'), h('dd', {}, whenText(ev)),
      ev.location ? [h('dt', {}, 'Where'), h('dd', {}, ev.location)] : null,
      ev.recurring ? [h('dt', {}, 'Repeats'), h('dd', {}, 'Yes. Changes here apply to this occurrence only.')] : null,
      ev.pending ? [h('dt', {}, 'Status'), h('dd', {}, 'Saving to Google…')] : null),
    ev.description ? h('div', { class: 'instr' }, D.linkNodes(ev.description)) : null,
    h('p', { class: 'links' },
      ev.htmlLink ? h('a', { href: ev.htmlLink, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Calendar ↗') : null,
      editable ? h('button', { type: 'button', onclick: () => { document.querySelector('#dlgItem').close(); openEventForm(ev); } }, 'Edit') : null,
      editable ? del : null,
      !editable && !ev.pending ? h('span', { class: 'muted' }, 'Read-only here (turn on “Allow edits” for this calendar in ⚙ Settings).') : null)));
  document.querySelector('#dlgItem').showModal();
}

// ---------- create / edit form ----------
const dlg = h('dialog', { id: 'dlgEvent' });
document.body.append(dlg);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function openEventForm(ev, { date, time, error } = {}) {
  const cals = editableCals();
  const start = ev ? new Date(ev.start) : (() => { const d = date ? new Date(`${date}T${time || '09:00'}`) : new Date(); if (!date) d.setHours(d.getHours() + 1, 0, 0, 0); return d; })();
  const end = ev ? (ev.allDay ? addDays(new Date(ev.end), -1) : new Date(ev.end)) : new Date(+start + 3600_000);
  const f = h('form', { method: 'dialog', class: 'event-form' },
    h('h2', {}, ev ? 'Edit Google event' : 'New Google event'),
    error ? h('p', { class: 'warn' }, error) : null,
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 300, value: ev?.title || '' })),
    h('label', {}, 'Calendar', h('select', { name: 'calendarId', disabled: !!ev }, cals.map(c => h('option', { value: c.id, selected: ev ? c.id === ev.calendarId : false }, c.summary)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'allDay', checked: !!ev?.allDay, onchange: () => sync_() }), 'All day'),
    h('div', { class: 'row2' },
      h('label', {}, 'Starts', h('input', { type: 'date', name: 'startDate', required: true, value: ymd(start) }), h('input', { type: 'time', name: 'startTime', value: hm(start) })),
      h('label', {}, 'Ends', h('input', { type: 'date', name: 'endDate', required: true, value: ymd(end) }), h('input', { type: 'time', name: 'endTime', value: hm(end) }))),
    h('label', {}, 'Location', h('input', { name: 'location', maxlength: 500, value: ev?.location || '' })),
    h('label', {}, 'Description', h('textarea', { name: 'description', rows: 3, maxlength: 5000 })),
    h('p', { class: 'muted' }, 'Saving goes through Claude and takes about 15 seconds; you can keep using the dashboard meanwhile.'),
    h('div', { class: 'dlg-actions' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'),
      h('button', { value: 'save', class: 'primary' }, ev ? 'Save changes' : 'Add to Google')));
  f.description.value = ev?.description || '';
  function sync_() { for (const n of ['startTime', 'endTime']) f[n].hidden = f.allDay.checked; }
  sync_();
  f.startDate.addEventListener('change', () => { if (f.endDate.value < f.startDate.value) f.endDate.value = f.startDate.value; });
  dlg.replaceChildren(f);
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    const allDay = f.allDay.checked;
    const s = allDay ? new Date(`${f.startDate.value}T00:00`) : new Date(`${f.startDate.value}T${f.startTime.value || '00:00'}`);
    const e = allDay ? addDays(new Date(`${f.endDate.value}T00:00`), 1) : new Date(`${f.endDate.value}T${f.endTime.value || '00:00'}`);
    const fields = { title: f.title.value.trim(), calendarId: ev ? ev.calendarId : f.calendarId.value, allDay, start: s.toISOString(), end: e.toISOString(), location: f.location.value.trim(), description: f.description.value.trim() };
    if (!fields.title || !(e > s)) return openEventForm(ev, { error: !fields.title ? 'Add a title.' : 'The end has to be after the start.' });
    save(ev ? 'update' : 'create', ev, fields);
  };
  dlg.showModal();
  f.title.focus();
}

async function save(op, ev, fields) {
  const draftId = `draft:${Date.now()}`;
  if (ev) hidden.add(ev.id);
  if (op !== 'delete') drafts.set(draftId, { ...(ev || {}), ...fields, id: draftId, kind: 'gcal', pending: true });
  D.render();
  note(op === 'delete' ? `Deleting “${ev.title}” from Google…` : `Saving “${fields.title}” to Google…`, 'busy');
  try {
    await D.api('/api/gcal/event', op === 'create' ? { op, ...fields } : { op, id: ev.id, ...fields });
    note(op === 'delete' ? `Deleted “${ev.title}” from Google ✓` : `Saved “${fields.title}” to Google ✓`);
  } catch (e) {
    note(`Couldn’t ${op === 'delete' ? 'delete' : 'save'} “${ev?.title || fields.title}”: ${e.message}`, 'error');
    if (op !== 'delete') setTimeout(() => openEventForm(ev, { error: `Google didn’t save it: ${e.message}` }), 50);
  } finally {
    if (ev) hidden.delete(ev.id);
    drafts.delete(draftId);
    await D.reload();
  }
}

// "Add": offer Task or Google event when at least one calendar allows edits
const chooser = h('dialog', { id: 'dlgAdd', class: 'chooser' });
document.body.append(chooser);
hooks.add.push(({ date, time }) => {
  if (!on() || !editableCals().length) return false;
  const when = date ? new Date(`${date}T${time || '12:00'}`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + (time ? ` at ${D.fmtTime(new Date(`${date}T${time}`))}` : '') : '';
  chooser.replaceChildren(h('h2', {}, when ? `Add on ${when}` : 'Add'),
    h('div', { class: 'choices' },
      h('button', { type: 'button', class: 'primary', onclick: () => { chooser.close(); D.openTaskForm(null, date, time); } }, '✎ Task', h('small', {}, 'Your own to-do')),
      h('button', { type: 'button', class: 'gchoice', onclick: () => { chooser.close(); openEventForm(null, { date, time }); } }, '◷ Google event', h('small', {}, 'On one of your calendars'))),
    h('form', { method: 'dialog', class: 'dlg-actions' }, h('span', { class: 'spacer' }), h('button', {}, 'Cancel')));
  chooser.showModal();
  return true;
});

// ---------- ⚙ Settings → Google Calendar ----------
const HELP = {
  'no-claude': 'Google Calendar needs Claude Code (claude.com/claude-code), signed in to the Claude account where Google Calendar is connected.',
  'no-connector': 'In Claude (claude.ai → Settings → Connectors) connect Google Calendar, then click Retry.',
  auth: 'Claude Code isn’t signed in. Open a terminal, run `claude` once and sign in, then click Retry.',
};
hooks.settings.push({
  id: 'gcal', title: 'Google Calendar', visible: on,
  render(box) {
    const g = G();
    // busy: the clicked button shows a spinner right away (connect waits ~10 s for Claude before anything re-renders)
    const busyBtn = (e, text) => { const b = e?.currentTarget; if (b) { b.disabled = true; b.replaceChildren(h('span', { class: 'spin' }, '↻'), ' ', text); } };
    const post = async (path, body) => { try { await D.api(path, body); } catch (e) { D.status(e.message); } await D.reload(); D.showSettingsSection('gcal'); };
    const running = g.running ? { connect: 'Connecting to your Google Calendar… (about 15 s)', sync: 'Syncing… (about 20–40 s)', load: 'Loading…', create: 'Saving an event…', update: 'Saving an event…', delete: 'Deleting an event…' }[g.running] : null;
    const err = g.lastError ? h('div', { class: 'warn' }, h('strong', {}, 'Problem: '), g.lastError.message, HELP[g.lastError.kind] ? h('div', {}, HELP[g.lastError.kind]) : null) : null;
    if (!g.connected) {
      fill(box,
        h('p', {}, 'Shows events from Google calendars you choose, next to your Brightspace work, and lets you add and change them. It works through the ', h('strong', {}, 'Google Calendar connector in Claude'), ', so you need Claude Code on this PC, signed in to a Claude account where Google Calendar is connected.'),
        h('p', { class: 'muted' }, 'Nothing is shown or changed until you pick calendars in the next step.'),
        err,
        h('p', {}, h('button', { type: 'button', class: 'primary', disabled: !!running, onclick: e => { busyBtn(e, 'Connecting… (about 15 s)'); post('/api/gcal/connect', {}); } }, running ? [h('span', { class: 'spin' }, '↻'), ' ', running] : (g.lastError ? 'Retry' : 'Connect Google Calendar'))));
      return;
    }
    const t = d => d ? new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
    const rows = g.calendars.map(c => h('tr', {},
      h('td', {}, h('span', { class: 'gswatch', style: { '--g': c.color } }), c.summary),
      h('td', {}, h('input', { type: 'checkbox', checked: c.show, 'aria-label': `Show ${c.summary}`, onchange: e => post('/api/gcal/settings', { calendars: { [c.id]: { show: e.target.checked } } }) })),
      h('td', {}, h('input', { type: 'checkbox', checked: c.show && c.todo, disabled: !c.show, 'aria-label': `Show ${c.summary} in the to-do list`, onchange: e => post('/api/gcal/settings', { calendars: { [c.id]: { todo: e.target.checked } } }) })),
      h('td', {}, h('input', { type: 'checkbox', checked: c.edit, disabled: !c.show, 'aria-label': `Allow edits to ${c.summary}`, onchange: e => post('/api/gcal/settings', { calendars: { [c.id]: { edit: e.target.checked } } }) })),
      h('td', {}, h('input', { type: 'color', value: c.color, 'aria-label': `Color for ${c.summary}`, onchange: e => post('/api/gcal/settings', { calendars: { [c.id]: { color: e.target.value } } }) }))));
    const opt = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g.settings[key], onchange: e => post('/api/gcal/settings', { [key]: e.target.checked }) }), label);
    fill(box,
      h('p', { class: 'gstatus' }, running ? h('strong', {}, running) : ['Last sync ', h('strong', {}, t(g.syncedAt)), g.nextSyncAt ? ` · next ${t(g.nextSyncAt)}` : '', g.lastCostUsd != null ? ` · last run used about $${g.lastCostUsd.toFixed(2)} of Claude usage` : ''],
        ' ', h('button', { type: 'button', disabled: !!running, onclick: e => { busyBtn(e, 'Syncing…'); post('/api/gcal/sync', {}); } }, 'Sync now')),
      err,
      h('p', { class: 'muted' }, `Range: events from ${GCAL_WINDOW.back / 7} week ago to ${GCAL_WINDOW.ahead / 7} weeks ahead. For other months, go to that month and click “Load Google events”. Syncs at start-up, every 6 hours, and when you click Sync now. Syncing passes the events of the calendars you show through Claude (your account, Haiku model).`),
      h('table', { class: 'gcal-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Calendar'), h('th', {}, 'Show'), h('th', { title: 'Show today’s events from this calendar in the “Today” list on the left' }, 'To-do'), h('th', {}, 'Allow edits'), h('th', {}, 'Color'))), h('tbody', {}, rows)),
      h('div', { class: 'gopts' },
        opt('showOnCalendar', 'Show Google events on the calendar'),
        opt('showTodayStrip', 'Show the “Today” schedule above the to-do list'),
        opt('digest', 'Include today’s Google events in the Windows notification')),
      h('p', {}, h('button', { type: 'button', disabled: !!running, onclick: e => { busyBtn(e, 'Refreshing calendar list…'); post('/api/gcal/connect', {}); } }, 'Refresh calendar list')));
  },
});

// While something is running (sync, saves), poll quickly so the result shows up promptly.
setInterval(() => { if (on() && (G().running || busy())) D.reload(); }, 3000);
