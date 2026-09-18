import { isDone, isVisible, dayKey, addDays, linkify, courseColors, viewModel, parseLink, brightspaceOrigin, announcementUrl, assignmentListUrl, itemDays } from '/logic.mjs';

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
  if (i.kind === 'task' && i.notes) badges.push(h('span', { title: i.notes }, '📝'));

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
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const mondayOf = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return addDays(d, -((d.getDay() + 6) % 7)); };

function renderCalendar({ all, now }) {
  const c = view.cursor;
  let start, days;
  if (view.mode === 'month') {
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    start = mondayOf(first);
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    days = Math.round((mondayOf(addDays(last, 7)) - start) / 864e5); // whole weeks through the month's last day
    $('#calTitle').textContent = c.toLocaleDateString([], { month: 'long', year: 'numeric' });
  } else {
    start = mondayOf(c);
    days = 7;
    const end = addDays(start, 6);
    $('#calTitle').textContent = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  $('#modeMonth').setAttribute('aria-pressed', view.mode === 'month');
  $('#modeWeek').setAttribute('aria-pressed', view.mode === 'week');

  // Bucket by local day: due chips + "opens" chips.
  const byDay = {};
  const push = (k, v) => (byDay[k] ||= []).push(v);
  for (const i of all) {
    if (i.due && (i.st !== 'expired' || i.done)) for (const k of itemDays(i)) push(k, { i, kind: 'due' });
    if (i.start && i.opens) push(dayKey(i.start), { i, kind: 'opens' });
  }
  const todayKey = dayKey(now);
  const limit = view.mode === 'month' ? 3 : Infinity;
  const cells = [];
  for (let n = 0; n < days; n++) {
    const d = addDays(start, n), k = dayKey(d);
    const entries = byDay[k] || [];
    const chips = entries.slice(0, limit).map(chipFor);
    const cls = ['day', view.mode === 'week' && 'week', view.mode === 'month' && d.getMonth() !== c.getMonth() && 'other', k === todayKey && 'is-today'].filter(Boolean).join(' ');
    cells.push(h('div', { class: cls, onclick: e => { if (e.target === e.currentTarget || e.target.classList.contains('num')) openDay(d, entries); } },
      view.mode === 'month' ? h('div', { class: 'num' }, d.getDate()) : null,
      chips,
      entries.length > limit ? h('button', { class: 'more', type: 'button', onclick: () => openDay(d, entries) }, `+${entries.length - limit} more`) : null));
  }
  const heads = DOW.map((w, n) => h('div', { class: 'dow' }, view.mode === 'week' ? `${w} ${addDays(start, n).getMonth() + 1}/${addDays(start, n).getDate()}` : w));
  $('#calGrid').replaceChildren(h('div', { class: 'grid' }, heads, cells));
}

// '8:00 PM–9:00 PM' → '8p–9p', '11:59 PM' → '11:59p' (month cells are narrow)
const compactTime = t => t.split('–').map(p => p.replace(':00', '').replace(/\s?([AP])M/i, (_, x) => x.toLowerCase())).join('–');

function chipFor({ i, kind }) {
  const urgent = kind === 'due' && !i.done && (i.st === 'overdue' || i.st === 'today');
  const label = kind === 'opens' ? `Opens: ${i.title}` : i.title;
  const time = kind === 'opens' ? fmtTime(i.start) : (i.allDay ? '' : dueLabel(i));
  return h('button', {
    type: 'button', class: ['chip', kind === 'opens' && 'opens', kind === 'due' && i.exam && 'exam', i.rangeStart && 'range', i.done && kind === 'due' && 'done', urgent && 'urgent'].filter(Boolean).join(' '),
    style: { '--c': colorOf(i) }, title: `${tagText(i)} · ${label}${time ? ' · ' + time : ''}`,
    onclick: e => { e.stopPropagation(); openItem(i); },
  }, kind === 'due' && i.exam ? h('span', { class: 'x' }, 'EXAM') : null,
  view.mode === 'week' ? h('span', { class: 't' }, tagText(i)) : null, // month cells are narrow: color bar + legend identify the course
  view.mode === 'month' && time ? h('span', { class: 't' }, compactTime(time)) : null,
  label, view.mode === 'week' && time ? ` · ${time}` : '');
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

function openAnnouncement(a) {
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

function openTaskForm(task, date) {
  const f = $('#taskForm');
  f.reset();
  $('#taskFormTitle').textContent = task ? 'Edit task' : 'Add task';
  const sel = f.courseId;
  sel.replaceChildren(h('option', { value: '' }, 'Personal (no course)'),
    ...data.courses.filter(c => model().visible.has(c.id)).map(c => h('option', { value: c.id }, c.short)));
  f.title.value = task?.title || '';
  f.date.value = task?.date || date || dayKey(new Date());
  f.time.value = task?.time || '';
  f.endDate.value = task?.endDate || '';
  sel.value = task?.courseId ?? '';
  f.notes.value = task?.notes || '';
  f.exam.checked = !!task?.exam;
  f.dataset.id = task?.id || '';
  $('#taskDelete').hidden = !task;
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
  if (!$('#dlgCourses').open) $('#dlgCourses').showModal();
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
  $('#btnNotify').querySelector('span').textContent = !on ? 'Notifications off' : blocked ? 'Notifications blocked' : 'Notifications on';
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
$('#today').onclick = () => { view.cursor = new Date(); render(); };
$('#prev').onclick = () => { view.cursor = view.mode === 'month' ? new Date(view.cursor.getFullYear(), view.cursor.getMonth() - 1, 1) : addDays(view.cursor, -7); render(); };
$('#next').onclick = () => { view.cursor = view.mode === 'month' ? new Date(view.cursor.getFullYear(), view.cursor.getMonth() + 1, 1) : addDays(view.cursor, 7); render(); };
$('#btnAdd').onclick = () => openTaskForm(null);
$('#btnCourses').onclick = openCourses;
$('#btnMarkRead').onclick = () => patchState({ seenAnnouncements: data.announcements.map(a => a.id) });
$('#btnRefresh').onclick = () => {
  data.refreshing = true; renderStatus();
  api('/api/refresh', {}).finally(load);
  setTimeout(load, 500);
};
$('#btnNotify').onclick = () => { $('#notifyResult').textContent = ''; renderNotifyButton(); $('#dlgNotify').showModal(); };
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
