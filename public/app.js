import { isDone, isVisible, dayKey, addDays, linkify, courseColors, viewModel, parseLink, brightspaceOrigin, announcementUrl, assignmentListUrl, itemDays, parseMarkdown, layoutSpans, sundayOf, boilerexamsUrl, FEATURES, featureOn, layoutDayBlocks } from '/logic.mjs';

const $ = s => document.querySelector(s);
let data = null;
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };
const view = { tab: pref('tab') || 'cal', mode: pref('mode') || 'month', cursor: new Date(), annCourse: 'all' };

// ---------- small DOM helper: text only, never innerHTML ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) { if (sv != null) el.style.setProperty(sk, sv); }
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- formatting ----------
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
const fmtFull = d => new Date(d).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function fmtAgo(d) {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
const dueLabel = i => (i.allDay ? 'all day' : i.end && i.kind === 'exam' ? `${fmtTime(i.due)}–${fmtTime(i.end)}` : fmtTime(i.due));
const rangeLabel = i => `${fmtDay(i.rangeStart)} – ${fmtDay(i.due)}${i.allDay ? '' : ' ' + fmtTime(i.due)}`;

// ---------- model ----------
let courseById = {};
// Same view model the server uses for notifications, so the page and the digest always agree.
function model() {
  const m = viewModel(data, new Date());
  data.colors = courseColors(data.courses, m.visible, data.term);
  courseById = Object.fromEntries(data.courses.map(c => [c.id, { ...c, color: data.colors[c.id] }]));
  return m;
}
const courseOf = i => courseById[i.courseId];
const colorOf = i => courseOf(i)?.color || '#cbd5e1';
const tagText = i => courseOf(i)?.short || 'Personal';
// Your note on an item: task notes live on the task, Brightspace item notes in state.notes.
const noteOf = i => (i.kind === 'task' ? i.notes : data.state.notes?.[i.id]) || '';

// ---------- api ----------
const api = (path, body, method = 'POST') => fetch(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}).catch(e => { $('#status').textContent = `Couldn’t save: ${e.message}. Is the dashboard server running?`; throw e; });

async function load() {
  try {
    data = await (await fetch('/api/data')).json();
  } catch {
    $('#status').textContent = 'Dashboard server is not running.';
    return;
  }
  render();
}

async function patchState(patch) {
  data.state = await api('/api/state', patch);
  render();
}

// ---------- render ----------
function render() {
  if (!data) return;
  const m = model();
  renderStatus();
  renderBanner(m);
  renderTabs();
  renderTodo(m);
  renderCalendar(m);
  renderLegend(m);
  renderAnnouncements(m);
  renderNotifyButton();
}

function renderStatus() {
  $('#demo').hidden = !data.fixture;
  const s = $('#status');
  s.replaceChildren();
  if (data.refreshing) s.append(h('span', { class: 'spin' }, '↻'), ' Refreshing from Brightspace… (takes about 2 min)');
  else if (data.refreshedAt) {
    s.append(`Updated ${fmtTime(data.refreshedAt)} (${fmtAgo(data.refreshedAt)})`);
    if (data.nextRefreshAt) s.append(` · next ${fmtTime(data.nextRefreshAt)}`);
  } else s.append('No data yet. First refresh in progress…');
  $('#btnRefresh').disabled = data.refreshing;
}

function renderBanner({ visible }) {
  const failed = (data.failedCourses || []).filter(id => visible.has(id)).map(id => courseById[id]?.short || id); // hidden courses (e.g. newsletters) don't nag
  const b = $('#banner');
  b.replaceChildren();
  b.className = 'banner';
  const e = data.lastError;
  if (e?.kind === 'auth' || data.paused) {
    b.classList.add('red');
    b.append(h('strong', {}, 'Brightspace sign-in needed.'),
      ' Automatic refreshes are paused so your phone doesn’t get MFA prompts overnight.',
      h('button', { class: 'primary', onclick: signIn }, 'Sign in'),
      h('span', { class: 'muted' }, 'After approving on your phone, click ↻ Refresh.'));
  } else if (e) {
    b.append(h('strong', {}, `Couldn’t reach Brightspace at ${fmtTime(e.at)}.`),
      data.refreshedAt ? ` Showing data from ${fmtFull(data.refreshedAt)}.` : '',
      data.nextRefreshAt ? ` Retrying at ${fmtTime(data.nextRefreshAt)}.` : '',
      h('span', { class: 'muted', title: e.message }, ' (details)'));
  } else if (failed.length) {
    b.append(`${failed.length} course(s) didn’t respond in time and show earlier data: ${failed.join(', ')}.`);
  } else { b.hidden = true; return; }
  b.hidden = false;
}

async function signIn() {
  await api('/api/signin', {});
  alertText('A terminal window opened. Follow its instructions (approve the number on your phone), then click ↻ Refresh.');
}
function alertText(msg) { $('#status').textContent = msg; }

function renderTabs() {
  const cal = view.tab === 'cal';
  $('#tabCal').setAttribute('aria-selected', cal);
  $('#tabAnn').setAttribute('aria-selected', !cal);
  $('#panelCal').hidden = !cal;
  $('#panelAnn').hidden = cal;
}

// ----- to-do -----
function itemRow(i, { showDay = false } = {}) {
  const badges = [];
  if (i.exam) badges.push(h('span', { class: 'badge b-exam' }, i.kind === 'exam' ? 'EXAM · from announcement' : 'EXAM'));
  if (i.rangeStart && !i.done && i.st !== 'overdue') badges.push(h('span', { class: `badge ${i.st === 'today' ? 'b-today' : 'b-info'}` }, `${i.st === 'today' ? 'NOW · ' : ''}${rangeLabel(i)}`));
  else if (i.st === 'overdue') badges.push(h('span', { class: 'badge b-overdue' }, `⚠ OVERDUE · ${fmtDay(i.due)}`));
  else if (i.st === 'today') badges.push(h('span', { class: 'badge b-today' }, `TODAY ${dueLabel(i)}`));
  else if (i.st === 'tomorrow') badges.push(h('span', { class: 'badge b-tomorrow' }, `TOMORROW ${dueLabel(i)}`));
  else if (i.due && (showDay || i.st === 'week' || i.st === 'later' || i.st === 'done')) badges.push(h('span', {}, `${fmtDay(i.due)} · ${dueLabel(i)}`));
  if (i.opens) badges.push(h('span', { class: 'badge b-opens' }, `OPENS ${fmtDay(i.start)} ${fmtTime(i.start)}`));
  if (i.timeLimit) badges.push(h('span', { class: 'badge b-info' }, `${i.timeLimit} min timed`));
  if (i.points) badges.push(h('span', {}, `${i.points} pts`));
  if (i.isNew && !i.done) badges.push(h('span', { class: 'badge b-new' }, 'NEW'));
  if (i.kind === 'task') badges.push(h('span', { title: 'Manual task' }, '✎'));
  if (i.done && (i.submitted || i.graded) && typeof data.state.done[i.id] !== 'boolean') badges.push(h('span', {}, i.submitted ? '✓ submitted' : '✓ graded'));
  if (noteOf(i)) badges.push(h('span', { class: 'note-mark', title: noteOf(i) }, '📝 note'));

  return h('div', { class: `item${i.done ? ' done' : ''}${i.exam ? ' exam' : ''}`, 'data-id': i.id },
    h('input', { type: 'checkbox', checked: i.done, 'aria-label': `Mark “${i.title}” done`, onchange: e => toggleDone(i, e.target.checked) }),
    h('div', { class: 'main', onclick: () => openItem(i), onkeydown: e => e.key === 'Enter' && openItem(i), tabindex: 0, role: 'button' },
      h('div', { class: 'title' }, h('span', { class: 'tag', style: { '--c': colorOf(i) } }, tagText(i)), ' ', i.title),
      h('div', { class: 'meta' }, badges)));
}

function toggleDone(i, checked) {
  // If unchecking returns to Brightspace's own verdict, drop the override instead of storing it.
  const auto = isDone(i, {}, new Date());
  patchState({ done: { [i.id]: checked === auto ? null : checked } });
}

function renderTodo({ all }) {
  const groups = [
    ['overdue', 'Overdue', all.filter(i => i.st === 'overdue')],
    ['today', 'Today', all.filter(i => i.st === 'today' || (i.done && i.due && dayKey(i.due) === dayKey(new Date())))],
    ['tomorrow', 'Tomorrow', all.filter(i => i.st === 'tomorrow')],
    ['week', 'This week', all.filter(i => i.st === 'week')],
    ['later', 'Later', all.filter(i => i.st === 'later'), true],
    ['nodate', 'No due date', all.filter(i => i.st === 'nodate'), true],
  ];
  const box = $('#todoList');
  const openState = Object.fromEntries([...box.querySelectorAll('details[data-g]')].map(d => [d.dataset.g, d.open]));
  box.replaceChildren(...groups.map(([key, label, items, collapsible]) => {
    if (!items.length && (key === 'overdue' || collapsible)) return null;
    const title = [label, h('span', { class: 'muted' }, `(${items.length})`)];
    const rows = items.length ? items.map(i => itemRow(i)) : [h('div', { class: 'empty' }, key === 'today' ? 'Nothing due today.' : 'Nothing here.')];
    if (collapsible) return h('details', { class: `group ${key}`, 'data-g': key, open: openState[key] || false }, h('summary', {}, title), rows);
    return h('div', { class: `group ${key}` }, h('div', { class: 'group-title' }, title), rows);
  }).filter(Boolean)); // empty groups return null; replaceChildren would print "null"
}

// ----- calendar -----
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const midnight = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };

function renderCalendar(m) {
  const { all, now } = m;
  const c = view.cursor;
  for (const [id, mode] of [['#modeMonth', 'month'], ['#modeWeek', 'week'], ['#modeDay', 'day']]) $(id).setAttribute('aria-pressed', view.mode === mode);
  if (view.mode === 'day') return renderDay(m);
  let start, days;
  if (view.mode === 'month') {
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    start = sundayOf(first);
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    days = Math.round((sundayOf(addDays(last, 7)) - start) / 864e5); // whole weeks through the month's last day
    $('#calTitle').textContent = c.toLocaleDateString([], { month: 'long', year: 'numeric' });
  } else {
    start = sundayOf(c);
    days = 7;
    const end = addDays(start, 6);
    $('#calTitle').textContent = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  // Bucket by local day. byDay = everything on that day (for the day popup); singles = what gets a box in the cell.
  // Multi-day tasks are drawn once per week row as a bar across their days instead.
  const byDay = {}, singles = {}, spans = [];
  const push = (map, k, v) => (map[k] ||= []).push(v);
  for (const i of all) {
    if (i.due && (i.st !== 'expired' || i.done)) {
      for (const k of itemDays(i)) push(byDay, k, { i, kind: 'due' });
      if (i.rangeStart) spans.push({ id: i.id, i, startDay: midnight(i.rangeStart), endDay: midnight(i.due) });
      else push(singles, dayKey(i.due), { i, kind: 'due' });
    }
    if (i.start && i.opens) { push(byDay, dayKey(i.start), { i, kind: 'opens' }); push(singles, dayKey(i.start), { i, kind: 'opens' }); }
  }
  const todayKey = dayKey(now);
  const limit = view.mode === 'month' ? 3 : Infinity;
  const rows = [];
  for (let w = 0; w < days / 7; w++) {
    const ws = addDays(start, w * 7);
    const { segs, lanes } = layoutSpans(spans, ws);
    // grid rows: 1 = day number, 2..lanes+1 = bars, last = the day's own boxes
    const kids = [];
    for (let n = 0; n < 7; n++) {
      const d = addDays(ws, n), k = dayKey(d), col = n + 1;
      const all_ = byDay[k] || [], own = singles[k] || [];
      const open = e => { if (e.target === e.currentTarget) openDay(d, all_); };
      kids.push(h('div', { class: ['day', view.mode === 'week' && 'week', view.mode === 'month' && d.getMonth() !== c.getMonth() && 'other', k === todayKey && 'is-today'].filter(Boolean).join(' '),
        style: { 'grid-column': String(col), 'grid-row': '1 / -1' }, onclick: open }));
      kids.push(h('div', { class: `num${k === todayKey ? ' today' : ''}`, style: { 'grid-column': String(col), 'grid-row': '1' }, onclick: () => goToDay(d), title: 'Open this day' },
        view.mode === 'month' ? d.getDate() : ''));
      kids.push(h('div', { class: 'day-items', style: { 'grid-column': String(col), 'grid-row': String(lanes + 2) }, onclick: open },
        own.slice(0, limit).map(chipFor),
        own.length > limit ? h('button', { class: 'more', type: 'button', onclick: () => openDay(d, all_) }, `+${own.length - limit} more`) : null));
    }
    for (const s of segs) kids.push(spanChip(s));
    rows.push(h('div', { class: `week-row${view.mode === 'week' ? ' tall' : ''}`, style: { 'grid-template-rows': `${view.mode === 'month' ? '22px' : '4px'} ${lanes ? `repeat(${lanes}, 26px) ` : ''}1fr` } }, kids));
  }
  const heads = DOW.map((w, n) => h('div', { class: 'dow' }, view.mode === 'week' ? `${w} ${addDays(start, n).getMonth() + 1}/${addDays(start, n).getDate()}` : w));
  $('#calGrid').replaceChildren(h('div', { class: 'cal-head' }, heads), ...rows);
}

// '8:00 PM–9:00 PM' → '8p–9p', '11:59 PM' → '11:59p' (month cells are narrow)
const compactTime = t => t.split('–').map(p => p.replace(':00', '').replace(/\s?([AP])M/i, (_, x) => x.toLowerCase())).join('–');

function goToDay(d) { view.mode = 'day'; view.cursor = new Date(d); pref('mode', 'day'); render(); }

// ----- Day view: all-day row + hour timeline (blocks for things with a duration, pins for deadlines) -----
const HOUR_PX = 48;
// Optional features can add to the day (e.g. Google events): each returns { allDay: [...nodes], blocks: [{id,start,end,node}] }.
const dayExtras = [];
function renderDay({ all, now }) {
  const d = new Date(view.cursor); d.setHours(0, 0, 0, 0);
  const k = dayKey(d);
  $('#calTitle').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const allDay = [], blocks = [], pins = [];
  for (const i of all) {
    if (i.due && (i.st !== 'expired' || i.done)) {
      if (i.rangeStart) { if (itemDays(i).includes(k)) allDay.push(chipFor({ i, kind: 'due' })); }
      else if (dayKey(i.due) === k) {
        if (i.allDay) allDay.push(chipFor({ i, kind: 'due' }));
        else if (i.kind === 'exam' && i.end) blocks.push({ id: i.id, start: i.due, end: i.end, node: () => chipFor({ i, kind: 'due' }) });
        else pins.push({ at: new Date(i.due), node: chipFor({ i, kind: 'due' }) });
      }
    }
    if (i.start && i.opens && dayKey(i.start) === k) pins.push({ at: new Date(i.start), node: chipFor({ i, kind: 'opens' }) });
  }
  for (const extra of dayExtras) { const x = extra(d); allDay.push(...(x.allDay || [])); blocks.push(...(x.blocks || [])); }

  // Hours shown: 7 AM–11 PM, stretched to fit anything earlier/later.
  const hourOf = t => { t = new Date(t); return t.getHours() + t.getMinutes() / 60; };
  const times = [...pins.map(p => hourOf(p.at)), ...blocks.flatMap(b => [hourOf(b.start), dayKey(b.end) === k ? hourOf(b.end) : 24])];
  const h0 = Math.max(0, Math.min(7, ...times.map(Math.floor)));
  const h1 = Math.min(24, Math.max(23, ...times.map(t => Math.ceil(t + 0.25))));
  const y = t => (Math.min(Math.max(hourOf(t), h0), h1) - h0) * HOUR_PX;

  const lanes = { pins: pins.length > 0, blocks: blocks.length > 0 };
  const pinStyle = lanes.blocks ? { left: '0', width: '42%' } : { left: '0', right: '0' };
  const blockLeft = lanes.pins ? 44 : 0, blockWidth = 100 - blockLeft;

  const grid = h('div', { class: 'day-grid', style: { height: `${(h1 - h0) * HOUR_PX}px` },
    onclick: e => {
      if (e.target !== e.currentTarget && !e.target.classList.contains('hour-line')) return;
      const r = e.currentTarget.getBoundingClientRect();
      const hr = Math.min(23, h0 + Math.floor((e.clientY - r.top) / HOUR_PX));
      openTaskForm(null, k, `${String(hr).padStart(2, '0')}:00`);
    } });
  for (let hr = h0; hr < h1; hr++) grid.append(h('div', { class: 'hour-line', style: { top: `${(hr - h0) * HOUR_PX}px` } }));
  // pins: several due at the same minute share one row
  const byMinute = {};
  for (const p of pins) (byMinute[p.at.getHours() * 60 + p.at.getMinutes()] ||= []).push(p);
  for (const [min, ps] of Object.entries(byMinute))
    grid.append(h('div', { class: 'pin-row', style: { top: `${y(ps[0].at) - 11}px`, ...pinStyle } }, h('span', { class: 'pin-tick' }), ps.map(p => p.node)));
  for (const b of layoutDayBlocks(blocks)) {
    const top = y(b.start), height = Math.max(22, (dayKey(b.end) === k ? y(b.end) : (h1 - h0) * HOUR_PX) - top);
    const w = blockWidth / b.cols;
    grid.append(h('div', { class: 'day-block', style: { top: `${top}px`, height: `${height}px`, left: `${blockLeft + b.col * w}%`, width: `calc(${w}% - 4px)` } }, b.node()));
  }
  if (k === dayKey(now) && hourOf(now) >= h0 && hourOf(now) <= h1) grid.append(h('div', { class: 'now-line', style: { top: `${y(now)}px` }, title: 'Now' }));

  const labels = h('div', { class: 'day-hours' }, Array.from({ length: h1 - h0 }, (_, n) => {
    const t = new Date(d); t.setHours(h0 + n);
    return h('div', { style: { top: `${n * HOUR_PX}px` } }, t.toLocaleTimeString([], { hour: 'numeric' }));
  }));
  $('#calGrid').replaceChildren(h('div', { class: 'day-view' },
    h('div', { class: 'day-allday' }, h('span', { class: 'muted' }, 'All day'), allDay.length ? allDay : h('span', { class: 'muted' }, '—')),
    h('div', { class: 'day-body' }, labels, grid)));
  // Scroll only the timeline (never the page), once per day you open: to "now" on today, else to the first item.
  if (renderDay.scrolledFor !== k) {
    renderDay.scrolledFor = k;
    const firstY = k === dayKey(now) ? y(now) : Math.min(...pins.map(p => y(p.at)), ...blocks.map(b => y(b.start)), Infinity);
    const body = $('#calGrid .day-body');
    if (body && isFinite(firstY)) body.scrollTop = Math.max(0, firstY - body.clientHeight / 3);
  }
}

// A multi-day task as one bar across its days in this week row; the title repeats on each row it continues onto.
function spanChip(s) {
  const i = s.i;
  const time = i.allDay ? '' : fmtTime(i.due);
  return h('button', {
    type: 'button',
    class: ['chip', 'range', 'span', i.exam && 'exam', i.done && 'done', s.contLeft && 'cont-left', s.contRight && 'cont-right', !i.done && (i.st === 'today' || i.st === 'overdue') && 'urgent'].filter(Boolean).join(' '),
    style: { '--c': colorOf(i), 'grid-column': `${s.col + 1} / span ${s.span}`, 'grid-row': String(s.lane + 2) },
    title: `${tagText(i)} · ${i.title} · ${rangeLabel(i)}${noteOf(i) ? '\n📝 ' + noteOf(i) : ''}`,
    onclick: e => { e.stopPropagation(); openItem(i); },
  }, s.contLeft ? h('span', { class: 'cont', 'aria-hidden': 'true' }, '◂ ') : null,
  i.exam ? h('span', { class: 'x' }, 'EXAM') : null,
  h('span', { class: 't' }, tagText(i)), i.title,
  !s.contRight && time ? h('span', { class: 'muted' }, ` · due ${compactTime(time)}`) : null,
  s.contRight ? h('span', { class: 'cont', 'aria-hidden': 'true' }, ' ▸') : null,
  noteOf(i) ? h('span', { class: 'chip-note' }, ' 📝') : null);
}

function chipFor({ i, kind }) {
  const urgent = kind === 'due' && !i.done && (i.st === 'overdue' || i.st === 'today');
  const label = kind === 'opens' ? `Opens: ${i.title}` : i.title;
  const time = kind === 'opens' ? fmtTime(i.start) : (i.allDay ? '' : dueLabel(i));
  return h('button', {
    type: 'button', class: ['chip', kind === 'opens' && 'opens', kind === 'due' && i.exam && 'exam', i.rangeStart && 'range', i.done && kind === 'due' && 'done', urgent && 'urgent'].filter(Boolean).join(' '),
    style: { '--c': colorOf(i) }, title: `${tagText(i)} · ${label}${time ? ' · ' + time : ''}${noteOf(i) ? '\n📝 ' + noteOf(i) : ''}`,
    onclick: e => { e.stopPropagation(); openItem(i); },
  }, kind === 'due' && i.exam ? h('span', { class: 'x' }, 'EXAM') : null,
  view.mode !== 'month' ? h('span', { class: 't' }, tagText(i)) : null, // month cells are narrow: color bar + legend identify the course
  view.mode === 'month' && time ? h('span', { class: 't' }, compactTime(time)) : null,
  label, view.mode !== 'month' && time ? ` · ${time}` : '', kind === 'due' && noteOf(i) ? h('span', { class: 'chip-note', 'aria-label': 'has a note' }, ' 📝') : null);
}

function renderLegend({ visible }) {
  $('#legend').replaceChildren(...data.courses.filter(c => visible.has(c.id))
    .map(c => h('span', { class: 'tag', style: { '--c': data.colors[c.id] }, title: c.name }, c.short)));
}

// ----- dialogs -----
function openItem(i) {
  if (i.kind === 'task') return openTaskForm(data.tasks.find(t => t.id === i.id));
  const rows = [
    ['Course', courseOf(i)?.name || ''],
    ['Type', i.kind === 'exam' ? 'Exam (found in an announcement)' : `${i.kind === 'quiz' ? 'Quiz' : 'Assignment'}${i.exam ? ' · exam' : ''}`],
    i.due && [i.kind === 'exam' ? 'When' : 'Due', i.kind === 'exam' ? `${fmtFull(i.due)}${i.end ? ' – ' + fmtTime(i.end) : ''}` : fmtFull(i.due)],
    i.start && ['Opens', fmtFull(i.start)],
    i.kind !== 'exam' && i.end && i.due && new Date(i.end) > new Date(i.due) && ['Late until', fmtFull(i.end)],
    i.points && ['Points', i.points],
    i.timeLimit && ['Time limit', `${i.timeLimit} min`],
    ['Status', i.done ? (i.submitted ? 'Submitted' : i.graded ? 'Graded' : i.kind === 'exam' && typeof data.state.done[i.id] !== 'boolean' ? 'Over' : 'Marked done') : i.st === 'overdue' ? 'Overdue' : 'Not done'],
  ].filter(Boolean);
  $('#itemBody').replaceChildren(h('div', { class: 'detail' },
    h('h2', {}, h('span', { class: 'tag', style: { '--c': colorOf(i) } }, tagText(i)), ' ', i.title),
    h('dl', {}, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
    i.instructions ? [h('strong', {}, 'Instructions'), h('div', { class: 'instr' }, linkNodes(i.instructions))] : null,
    noteEditor(i),
    studyButton(i),
    h('p', { class: 'links' }, ...brightspaceLinks(i),
      i.kind === 'exam' ? h('a', { href: announcementUrl(brightspaceOrigin(data.items), i.courseId, i.sourceAnnouncement), target: '_blank', rel: 'noopener noreferrer' }, 'Open the announcement in Brightspace ↗') : null, ' ',
      h('label', { style: { display: 'inline-flex', gap: '6px', 'align-items': 'center' } },
        h('input', { type: 'checkbox', checked: i.done, onchange: e => toggleDone(i, e.target.checked) }), 'Done'))));
  $('#dlgItem').showModal();
}

// Past-due assignments: Brightspace answers 403 on the (closed) submission page, so lead with the course's assignment list.
function brightspaceLinks(i) {
  if (!i.url) return [];
  const ext = (href, text, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
  if (i.kind === 'assignment' && i.due && new Date(i.due) < new Date())
    return [ext(assignmentListUrl(brightspaceOrigin(data.items), i.courseId), 'Open course assignments in Brightspace ↗'), ' ', ext(i.url, 'Submission page ↗ (may be closed)', 'minor')];
  return [ext(i.url, 'Open in Brightspace ↗')];
}

// Markdown blocks (from logic.mjs) → DOM. Only createElement/textContent; links must be http(s).
function renderInline(tokens) {
  return tokens.map(t => {
    if (t.t === 'text') return t.v;
    if (t.t === 'code') return h('code', {}, t.v);
    if (t.t === 'link') return /^https?:\/\//i.test(t.href) ? h('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer' }, renderInline(t.kids)) : renderInline(t.kids);
    return h({ b: 'strong', i: 'em', s: 'del' }[t.t], {}, renderInline(t.kids));
  });
}
function renderMarkdown(src) {
  return parseMarkdown(src).map(b => {
    if (b.type === 'h') return h(`h${b.level + 2}`, {}, renderInline(b.inline));
    if (b.type === 'p') return h('p', {}, renderInline(b.inline));
    if (b.type === 'quote') return h('blockquote', {}, renderInline(b.inline));
    if (b.type === 'code') return h('pre', {}, h('code', {}, b.text));
    if (b.type === 'hr') return h('hr');
    return h(b.type, {}, b.items.map(it => h('li', { class: it.checked == null ? null : 'task' },
      it.checked == null ? null : h('input', { type: 'checkbox', checked: it.checked, disabled: true }), renderInline(it.inline))));
  });
}

// "My notes" on a Brightspace item: saves as you type (and when the window closes).
let flushNote = null;
function noteEditor(i) {
  let timer = null, last = noteOf(i);
  const status = h('span', { class: 'note-status muted', 'aria-live': 'polite' });
  const save = async text => {
    clearTimeout(timer);
    if (text === last) return;
    last = text;
    status.textContent = 'Saving…';
    try {
      data.state = await api('/api/state', { notes: { [i.id]: text } });
      // Trust the server's copy, not the request: an out-of-date server would silently drop the note.
      const stored = data.state.notes?.[i.id] || '';
      if (stored !== (text.trim() ? text : '')) { status.textContent = 'Not saved: restart the dashboard (stop.cmd, then start.cmd)'; last = null; return; }
      status.textContent = 'Saved'; render();
    }
    catch { status.textContent = 'Not saved. Is the dashboard running?'; last = null; }
  };
  const box = h('textarea', { class: 'note-box', rows: 5, maxlength: 5000, 
    oninput: e => { status.textContent = ''; clearTimeout(timer); timer = setTimeout(() => save(e.target.value), 500); },
    onblur: () => { save(box.value); showView(); } });
  box.value = last;
  // Formatted view when there's a note; click it (or "Edit") to change it.
  const viewEl = h('div', { class: 'note-view md', tabindex: 0, role: 'button', title: 'Click to edit', onclick: e => { if (!e.target.closest('a')) showEdit(); }, onkeydown: e => e.key === 'Enter' && showEdit() });
  const editBtn = h('button', { type: 'button', class: 'note-edit', onclick: () => showEdit() }, 'Edit');
  function showView() {
    if (!box.value.trim()) return showEdit(false);
    viewEl.replaceChildren(...renderMarkdown(box.value));
    viewEl.hidden = false; editBtn.hidden = false; box.hidden = true;
  }
  function showEdit(focus = true) {
    viewEl.hidden = true; editBtn.hidden = true; box.hidden = false;
    if (focus) box.focus();
  }
  flushNote = () => save(box.value);
  const wrap = h('div', { class: 'notes' }, h('div', { class: 'note-label' }, h('strong', {}, 'My notes'), editBtn, status), viewEl, box);
  showView();
  return wrap;
}
$('#dlgItem').addEventListener('close', () => { flushNote?.(); flushNote = null; });

// Exams in a course that Boilerexams covers get a button to its practice exams; otherwise nothing.
function studyButton(i) {
  const key = i.exam && i.courseId != null ? data.boilerexams?.[i.courseId] : null;
  return key ? h('p', {}, h('a', { class: 'study-btn', href: boilerexamsUrl(key), target: '_blank', rel: 'noopener noreferrer' }, 'Study on Boilerexams ↗')) : null;
}

function openAnnouncement(a) {
  flushNote = null;
  const color = data.colors[a.courseId] || '#cbd5e1';
  $('#itemBody').replaceChildren(h('div', { class: 'detail' },
    h('h2', {}, h('span', { class: 'tag', style: { '--c': color } }, courseById[a.courseId]?.short || 'Other'), ' ', a.title),
    h('dl', {}, h('dt', {}, 'Course'), h('dd', {}, courseById[a.courseId]?.name || ''), h('dt', {}, 'Posted'), h('dd', {}, `${fmtFull(a.date)} (${fmtAgo(a.date)})`)),
    h('div', { class: 'instr ann-full' }, linkNodes(a.body)),
    a.courseId ? h('p', {}, h('a', { href: announcementUrl(brightspaceOrigin(data.items), a.courseId, a.id), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Brightspace ↗')) : null));
  $('#dlgItem').showModal();
  if (!data.state.seenAnnouncements.includes(a.id)) patchState({ seenAnnouncements: [a.id] }).catch(() => {});
}

function openDay(d, entries) {
  if (!entries.length) return openTaskForm(null, dayKey(d)); // empty day → straight to "add task" on that date
  const rows = entries.map(({ i, kind }) => kind === 'opens'
    ? h('div', { class: 'item' }, h('span', {}, '◌'), h('div', { class: 'main', onclick: () => openItem(i) }, h('div', { class: 'title' }, h('span', { class: 'tag', style: { '--c': colorOf(i) } }, tagText(i)), ` Opens ${fmtTime(i.start)}: ${i.title}`)))
    : itemRow(i, { showDay: true }));
  // replaceChildren takes nodes as separate arguments; an array would be stringified.
  $('#dayBody').replaceChildren(h('h2', {}, d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })),
    ...(rows.length ? rows : [h('p', { class: 'muted' }, 'Nothing scheduled.')]));
  $('#dayAdd').onclick = () => { $('#dlgDay').close(); openTaskForm(null, dayKey(d)); };
  $('#dlgDay').showModal();
}

function openTaskForm(task, date, time) {
  const f = $('#taskForm');
  f.reset();
  $('#taskFormTitle').textContent = task ? 'Edit task' : 'Add task';
  const sel = f.courseId;
  sel.replaceChildren(h('option', { value: '' }, 'Personal (no course)'),
    ...data.courses.filter(c => model().visible.has(c.id)).map(c => h('option', { value: c.id }, c.short)));
  f.title.value = task?.title || '';
  f.date.value = task?.date || date || dayKey(new Date());
  f.time.value = task?.time || time || '';
  f.endDate.value = task?.endDate || '';
  sel.value = task?.courseId ?? '';
  f.notes.value = task?.notes || '';
  f.exam.checked = !!task?.exam;
  f.dataset.id = task?.id || '';
  $('#taskDelete').hidden = !task;
  const study = $('#taskStudy');
  study.replaceChildren(...(task ? [studyButton({ ...task, exam: task.exam })].filter(Boolean) : []));
  $('#dlgTask').returnValue = ''; // otherwise Esc re-uses the last "save"
  $('#dlgTask').showModal();
  f.title.focus();
}

$('#taskForm').date.addEventListener('change', e => { $('#taskForm').endDate.min = e.target.value; });
$('#dlgTask').addEventListener('close', async () => {
  if ($('#dlgTask').returnValue !== 'save') return;
  const f = $('#taskForm');
  try { await api('/api/tasks', { id: f.dataset.id || undefined, title: f.title.value, date: f.date.value, endDate: f.endDate.value, time: f.time.value, courseId: f.courseId.value || null, exam: f.exam.checked, notes: f.notes.value }); } catch { return; }
  load();
});
$('#taskDelete').onclick = async () => {
  const id = $('#taskForm').dataset.id;
  $('#dlgTask').close('delete'); // not "save", so the close handler doesn't re-create it
  try { await api(`/api/tasks/${encodeURIComponent(id)}`, null, 'DELETE'); } catch { return; }
  load();
};

// ----- ⚙ Settings -----
let settingsSection = 'features';
function showSettingsSection(sec) {
  settingsSection = sec;
  for (const b of document.querySelectorAll('#settingsNav [data-sec]')) b.setAttribute('aria-selected', b.dataset.sec === sec);
  for (const s of document.querySelectorAll('.settings-sec')) s.hidden = s.dataset.sec !== sec;
  if (sec === 'courses') openCourses();
  if (sec === 'notifications') { $('#notifyResult').textContent = ''; renderNotifyButton(); }
  if (sec === 'features') renderFeatures();
}
function openSettings(sec = settingsSection) {
  showSettingsSection(sec);
  if (!$('#dlgSettings').open) $('#dlgSettings').showModal();
}
function renderFeatures() {
  $('#featureList').replaceChildren(...(FEATURES.length ? FEATURES.map(f => h('div', { class: 'feature-row' },
    h('label', { class: 'switch-row' },
      h('input', { type: 'checkbox', role: 'switch', checked: featureOn(data.state, f.id), onchange: e => patchState({ features: { [f.id]: e.target.checked } }).then(renderFeatures).catch(() => {}) }),
      h('span', {}, h('strong', {}, f.name), h('br'), h('small', { class: 'muted' }, f.description))))) : [h('p', { class: 'muted' }, 'No optional features yet.')]));
}

function openCourses() {
  const now = new Date();
  const list = [...data.courses].sort((a, b) => a.short.localeCompare(b.short));
  $('#courseList').replaceChildren(...list.map(c => {
    const on = isVisible(c, data.items, data.state, now, data.term);
    const overridden = typeof data.state.hiddenCourses[c.id] === 'boolean';
    return h('div', { class: 'course-row' },
      h('label', {}, h('input', { type: 'checkbox', checked: on, onchange: e => patchState({ hiddenCourses: { [c.id]: !e.target.checked } }).then(openCoursesRefresh) }),
        h('span', { class: 'tag', style: { '--c': data.colors[c.id] } }, c.short),
        h('span', {}, c.name, overridden ? h('small', {}, ' · manual') : null)));
  }));
}
const openCoursesRefresh = () => openCourses();
$('#courseReset').onclick = () => patchState({ hiddenCourses: Object.fromEntries(Object.keys(data.state.hiddenCourses).map(k => [k, null])) }).then(openCourses);

// ----- announcements -----
function linkNodes(text) {
  // Strip tags for readability; the result still only ever goes into text nodes.
  return linkify(String(text || '').replace(/<[^>]*>/g, '').replace(/\r\n/g, '\n').trim())
    .map(s => s.href ? h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, s.text) : s.text);
}

function renderAnnouncements({ visible }) {
  const seen = new Set(data.state.seenAnnouncements);
  const anns = data.announcements
    .filter(a => a.courseId == null || visible.has(a.courseId) || courseById[a.courseId] == null)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const unread = anns.filter(a => !seen.has(a.id));
  const badge = $('#annBadge');
  badge.hidden = !unread.length;
  badge.textContent = unread.length;
  document.title = unread.length ? `(${unread.length}) Academic Dashboard` : 'Academic Dashboard';

  const courseIds = [...new Set(anns.map(a => a.courseId))];
  $('#annFilter').replaceChildren(
    h('button', { type: 'button', 'aria-pressed': view.annCourse === 'all', onclick: () => { view.annCourse = 'all'; render(); } }, 'All'),
    ...courseIds.map(id => h('button', { type: 'button', 'aria-pressed': view.annCourse === id, onclick: () => { view.annCourse = id; render(); } }, courseById[id]?.short || 'Other')));

  const shown = anns.filter(a => view.annCourse === 'all' || a.courseId === view.annCourse);
  $('#annList').replaceChildren(...(shown.length ? shown.map(a => h('article', { class: `ann${seen.has(a.id) ? '' : ' unread'}`, style: { '--c': data.colors[a.courseId] || '#cbd5e1' },
      tabindex: 0, role: 'button', 'aria-label': `Open announcement: ${a.title}`, onclick: () => openAnnouncement(a), onkeydown: e => e.key === 'Enter' && openAnnouncement(a) },
    h('header', {}, seen.has(a.id) ? null : h('span', { class: 'dot', title: 'Unread' }),
      h('span', { class: 'tag', style: { '--c': data.colors[a.courseId] || '#cbd5e1' } }, courseById[a.courseId]?.short || 'Other'),
      h('h3', {}, a.title),
      h('span', { class: 'when', title: fmtFull(a.date) }, `${fmtAgo(a.date)} · ${fmtDay(a.date)}`)),
    h('div', { class: 'body clamp' }, linkNodes(a.body)))) : [h('p', { class: 'muted' }, 'No announcements.')]));

  if (view.tab === 'ann' && unread.length) {
    clearTimeout(renderAnnouncements.t);
    renderAnnouncements.t = setTimeout(() => view.tab === 'ann' && patchState({ seenAnnouncements: shown.map(a => a.id) }), 2000);
  }
}

// ---------- notifications (native Windows, sent by the server) ----------
const BLOCKED = {
  system: 'Windows notifications are switched off for your whole PC, so Windows hides these.',
  app: 'Windows is blocking notifications from “Windows PowerShell”, which the dashboard uses to show them.',
};
function renderNotifyButton() {
  const on = data?.state?.notifications !== false;
  const blocked = data?.notifyBlocked;
  $('#settingsDot').hidden = !(on && blocked); // ⚙ gets a dot while notifications are on but Windows blocks them
  $('#notifyToggle').checked = on;
  $('#notifyBlocked').hidden = !blocked;
  $('#notifyBlockedText').textContent = BLOCKED[blocked] || '';
}
async function sendTestNotification() {
  const out = $('#notifyResult');
  out.textContent = 'Sending…';
  try {
    const r = await api('/api/notify-test', {});
    if (r.blocked) { data.notifyBlocked = r.blocked; renderNotifyButton(); }
    out.textContent = r.ok ? 'Sent! It should appear in the bottom-right corner (or in the notification center if Do Not Disturb is on).'
      : r.blocked ? 'Not sent: turn Windows notifications on first (button above).' : `Windows refused it: ${r.error}`;
  } catch { out.textContent = 'Couldn’t reach the dashboard server.'; }
}

// ---------- wiring ----------
$('#tabCal').onclick = () => { view.tab = 'cal'; pref('tab', 'cal'); render(); };
$('#tabAnn').onclick = () => { view.tab = 'ann'; pref('tab', 'ann'); render(); };
$('#modeMonth').onclick = () => { view.mode = 'month'; pref('mode', 'month'); render(); };
$('#modeWeek').onclick = () => { view.mode = 'week'; pref('mode', 'week'); render(); };
$('#modeDay').onclick = () => { view.mode = 'day'; pref('mode', 'day'); render(); };
$('#today').onclick = () => { view.cursor = new Date(); render(); };
const step = dir => view.mode === 'month' ? new Date(view.cursor.getFullYear(), view.cursor.getMonth() + dir, 1) : addDays(view.cursor, dir * (view.mode === 'day' ? 1 : 7));
$('#prev').onclick = () => { view.cursor = step(-1); render(); };
$('#next').onclick = () => { view.cursor = step(1); render(); };
$('#btnAdd').onclick = () => openTaskForm(null);
$('#btnSettings').onclick = () => openSettings();
$('#btnMarkRead').onclick = () => patchState({ seenAnnouncements: data.announcements.map(a => a.id) });
$('#btnRefresh').onclick = () => {
  data.refreshing = true; renderStatus();
  api('/api/refresh', {}).finally(load);
  setTimeout(load, 500);
};
$('#settingsNav').onclick = e => { const b = e.target.closest('[data-sec]'); if (b) showSettingsSection(b.dataset.sec); };
$('#notifyToggle').onchange = e => patchState({ notifications: e.target.checked }).catch(() => {});
$('#notifyTest').onclick = sendTestNotification;
$('#notifySettings').onclick = () => api('/api/notification-settings', {}).catch(() => {});
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, dialog')) return;
  if (e.key === 'n') { e.preventDefault(); openTaskForm(null); }
  if (e.key === 't') $('#today').click();
});

// Links from notifications: #item=<id> opens that item; #due=<id>,<id> highlights those rows.
function followLink() {
  const link = parseLink(location.hash);
  if (!link || !data) return;
  history.replaceState(null, '', location.pathname); // handle once; a reload shouldn't re-open it
  view.tab = 'cal'; view.cursor = new Date(); render();
  const { all } = model();
  const found = link.ids.map(id => all.find(i => i.id === id)).filter(Boolean);
  if (link.kind === 'item' && found[0]) return openItem(found[0]);
  const rows = found.map(i => document.querySelector(`#todoList .item[data-id="${CSS.escape(i.id)}"]`)).filter(Boolean);
  rows.forEach(r => r.classList.add('flash'));
  rows[0]?.scrollIntoView({ block: 'center' });
  setTimeout(() => rows.forEach(r => r.classList.remove('flash')), 6000);
}
window.addEventListener('hashchange', followLink);

// Poll: every 60 s normally, every 5 s while a refresh runs. Re-rendering also moves "today" past midnight.
let firstLoad = true;
async function loop() {
  await load();
  if (firstLoad && data) { firstLoad = false; followLink(); }
  setTimeout(loop, data?.refreshing ? 5000 : 60000);
}
loop();
