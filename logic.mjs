// Pure rules shared by the server, the browser, and the tests. No I/O here.

export const SLOT_HOURS = 3;
export const OVERDUE_DAYS = 14;
const DAY = 86400000;

// ---- refresh schedule (local clock, 00/03/06/.../21) ----
export function lastSlot(now) {
  const d = new Date(now);
  d.setHours(Math.floor(d.getHours() / SLOT_HOURS) * SLOT_HOURS, 0, 0, 0);
  return d;
}
export function nextSlot(now) {
  const d = lastSlot(now);
  d.setHours(d.getHours() + SLOT_HOURS); // setHours rolls over midnight correctly
  return d;
}
// Due when the last completed attempt (success or failure) happened before the current slot began.
export const refreshDue = (now, lastAttemptAt) => !lastAttemptAt || new Date(lastAttemptAt) < lastSlot(now);

// ---- dates ----
export const dayKey = d => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const startOfDay = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
export const addDays = (d, n) => { d = new Date(d); d.setDate(d.getDate() + n); return d; };

// Manual task {date:'YYYY-MM-DD', endDate?:'YYYY-MM-DD', time?:'HH:MM'} → due Date (all-day = 23:59 local).
// A range (date..endDate) is due at the end of its last day.
export function taskDue(t) {
  const [y, m, d] = (t.endDate || t.date).split('-').map(Number);
  const [hh, mm] = (t.time || '23:59').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

// ---- exams ----
// "Exam 2", "Midterm", "Final Exam" count; practice quizzes, info pages, agreements, reflections don't.
const EXAM_RE = /\b(exams?|midterms?|final exam|final test)\b/i;
const NOT_EXAM_RE = /\b(practice|review|prep|preparation|study|guide|sign[- ]?ups?|agreements?|information|info|registration|accommodations?|request|wrappers?|surveys?|reflections?|corrections?|policy|policies|schedule|conflicts?|makeup form|solutions?|key)\b/i;
export const isExamName = name => EXAM_RE.test(name || '') && !NOT_EXAM_RE.test(name || '');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const monthIndex = s => MONTHS[s.toLowerCase().replace('.', '').slice(0, s.toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[s.toLowerCase().slice(0, 3)];

// Finds the first date in a sentence. No year → the occurrence nearest after `ref` (within ~10 months).
export function findDate(text, ref) {
  const r = new Date(ref);
  const pick = (y, m, d) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    if (y != null) { if (y < 100) y += 2000; return new Date(y, m, d); }
    let dt = new Date(r.getFullYear(), m, d);
    if (dt < addDays(startOfDay(r), -45)) dt = new Date(r.getFullYear() + 1, m, d);
    return dt;
  };
  let m;
  // 23 September 2026
  if ((m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?`, 'i'))))
    return pick(m[3] ? +m[3] : null, monthIndex(m[2]), +m[1]);
  // September 23, 2026 / Sept. 23rd
  if ((m = text.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i'))))
    return pick(m[3] ? +m[3] : null, monthIndex(m[1]), +m[2]);
  // 9/23 or 9/23/2026 (not part of a longer number or a fraction like "1/2 of")
  if ((m = text.match(/(?:^|[\s(,])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/)))
    return pick(m[3] ? +m[3] : null, +m[1] - 1, +m[2]);
  return null;
}

// "8:00-9:00PM", "7 - 9 pm", "at 8:30 PM" → {start:[h,m], end?:[h,m]}
export function findTimes(text) {
  const ap = (h, s) => { s = (s || '').toLowerCase().replace(/\./g, ''); if (s === 'pm' && h < 12) return h + 12; if (s === 'am' && h === 12) return 0; return h; };
  let m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (m) {
    const endH = ap(+m[4], m[6]);
    let startH = ap(+m[1], m[3] || m[6]);
    if (!m[3] && startH > endH) startH -= 12; // "11-1pm" → 11 AM
    if (startH >= 0 && startH < 24 && endH < 24) return { start: [startH, +(m[2] || 0)], end: [endH, +(m[5] || 0)] };
  }
  m = text.match(/\b(?:at|@|from|starts?|begins?)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i) || text.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i);
  if (m) return { start: [ap(+m[1], m[3]), +(m[2] || 0)] };
  return null;
}

const EXAM_SCHEDULE_RE = /\b(exam|midterm|final)s?\b[^.!?]{0,40}?\b(is|are|on|held|scheduled|takes? place|moved|will be|starts?|begins?)\b/i;
const EXAM_NOISE_RE = /\b(due|no later than|deadline|request|sign[- ]?ups?|fill out|forms?|agreements?|conflicts?|regrades?|grades?|scores?|practice|review|registration|register|solutions?|key)\b/i;

const ORD = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
function examLabel(text) {
  let m = text.match(/\bfinal exam/i);
  if (m) return 'Final Exam';
  m = text.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(exam|midterm)/i);
  if (m) return `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()} ${ORD[m[1].toLowerCase()]}`;
  m = text.match(/\b(exam|midterm)\s*#?\s*(\d+)/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  m = text.match(/\b(midterm|exam)/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}` : 'Exam';
}

// Exam events announced in Brightspace announcements (e.g. "The first exam is on Wednesday, 23 September 2026 from 8:00-9:00PM").
// One event per course per day; the earliest-posted announcement wins.
export function examsFromAnnouncements(announcements) {
  const out = new Map();
  const sorted = [...(announcements || [])].sort((a, b) => new Date(a.date || a.createdDate) - new Date(b.date || b.createdDate));
  for (const a of sorted) {
    const posted = new Date(a.date || a.createdDate || Date.now());
    const text = `${a.title || ''}.\n${String(a.body || '').replace(/<[^>]*>/g, ' ')}`;
    // Sentence split that doesn't break on "Oct.", "Wed.", "p.m.", "Dr.", "Rm." etc.
    for (const sentence of text.split(/(?<!\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|dr|prof|mr|ms|mrs|no|rm|st|a\.m|p\.m|[ap])\.)(?<=[.!?])\s+|\n+/i)) {
      // Must *schedule* the exam ("Exam 1 is …", "will be held on …"). Sentences about deadlines around an exam
      // ("request a reschedule no later than…", "sign up for a seat by…", "Exam Agreement due…") don't count.
      if (!EXAM_SCHEDULE_RE.test(sentence) || EXAM_NOISE_RE.test(sentence)) continue;
      const date = findDate(sentence, posted);
      if (!date || date < addDays(posted, -2) || date > addDays(posted, 300)) continue;
      const times = findTimes(sentence);
      const start = new Date(date), allDay = !times;
      if (times) start.setHours(times.start[0], times.start[1], 0, 0); else start.setHours(23, 59, 0, 0);
      let end = null;
      if (times?.end) { end = new Date(date); end.setHours(times.end[0], times.end[1], 0, 0); if (end <= start) end = null; }
      const id = `ex:${a.courseId}:${dayKey(start)}`;
      if (out.has(id)) continue;
      out.set(id, {
        id, courseId: a.courseId, kind: 'exam', exam: true, title: examLabel(`${a.title} ${sentence}`),
        due: start.toISOString(), end: end?.toISOString() || null, allDay, start: null,
        points: null, timeLimit: null, url: null, submitted: false, graded: false,
        instructions: `From the announcement "${a.title}":\n${sentence.trim()}`, sourceAnnouncement: a.id,
      });
    }
  }
  return [...out.values()];
}

// ---- items ----
export const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// raw.assignments: {courseId: {assignments:[...]}}, raw.grades: {courseId: {grades:[...]}}
export function buildItems(raw) {
  const items = [];
  for (const [courseId, res] of Object.entries(raw.assignments || {})) {
    const graded = new Set((raw.grades?.[courseId]?.grades || [])
      .filter(g => g.pointsNumerator != null && g.pointsDenominator > 0)
      .map(g => normName(g.name)));
    for (const a of res?.assignments || []) {
      items.push({
        id: `bs:${courseId}:${a.type}:${a.id}`,
        courseId: Number(courseId),
        kind: a.type, // 'assignment' | 'quiz'
        exam: isExamName(a.name),
        title: a.name,
        due: a.dueDate || null,
        start: a.startDate || null,
        end: a.endDate || null,
        points: a.points ?? null,
        timeLimit: a.timeLimit ?? null,
        url: a.url || null,
        instructions: a.instructions?.markdown || '',
        submitted: a.type === 'assignment' && a.submission != null,
        graded: a.type === 'quiz' && graded.has(normName(a.name)),
      });
    }
  }
  // Announced exams, unless the course already has an exam item on that day.
  const examDays = new Set(items.filter(i => i.exam && i.due).map(i => `${i.courseId}:${dayKey(i.due)}`));
  for (const e of examsFromAnnouncements(raw.announcements)) {
    if (!examDays.has(`${e.courseId}:${dayKey(e.due)}`)) items.push(e);
  }
  return items;
}

export function tasksToItems(tasks) {
  return tasks.map(t => ({
    id: t.id, courseId: t.courseId ?? null, kind: 'task', exam: !!t.exam, title: t.title,
    due: taskDue(t).toISOString(), allDay: !t.time, notes: t.notes || '',
    rangeStart: t.endDate && t.endDate > t.date ? taskDue({ date: t.date, time: '00:00' }).toISOString() : null,
    start: null, end: null, points: null, timeLimit: null, url: null, instructions: '',
    submitted: false, graded: false,
  }));
}

// A manual toggle (true or false) always wins. Announced exams count as done once they're over.
export function isDone(item, doneMap = {}, now = new Date()) {
  if (typeof doneMap[item.id] === 'boolean') return doneMap[item.id];
  if (item.kind === 'exam' || (item.kind === 'task' && item.exam) || (item.kind === 'event' && item.eventKind !== 'deadline')) return new Date(item.end || item.due) < new Date(now);
  return item.submitted || item.graded;
}

// 'done' | 'nodate' | 'expired' | 'overdue' | 'today' | 'tomorrow' | 'week' | 'later'
export function status(item, now, done) {
  if (done) return 'done';
  if (!item.due) return 'nodate';
  const n = new Date(now);
  if (item.rangeStart && new Date(item.rangeStart) <= n && n <= new Date(item.due)) return 'today'; // inside a date range
  const due = item.rangeStart && new Date(item.rangeStart) > n ? new Date(item.rangeStart) : new Date(item.due);
  if (due < n) return due >= new Date(n - OVERDUE_DAYS * DAY) ? 'overdue' : 'expired';
  const today = startOfDay(n);
  if (due < addDays(today, 1)) return 'today';
  if (due < addDays(today, 2)) return 'tomorrow';
  if (due < addDays(today, 7)) return 'week';
  return 'later';
}

export const notOpenYet = (item, now) => !!item.start && new Date(item.start) > new Date(now);

// ---- courses ----
// Registrar course sections have codes like "wl.202710.CHM.11510.001" (campus.term.subject.number.section).
// Anything else (orientation, clubs, newsletters, trainings) is an org unit.
const SECTION_RE = /^[a-z]+\.(\d{6})\.([A-Z]{2,5})\.(\d{5})\./i;
export const courseTerm = c => (String(c.code || '').match(SECTION_RE) || [])[1] || null;
export const currentTerm = courses => courses.map(courseTerm).filter(Boolean).sort().at(-1) || null;

// Which courses are worth asking Brightspace about: accessible, active, and not from a past term.
export const shouldFetch = (c, term) => c.canAccess !== false && c.isActive !== false && !(term && courseTerm(c) && courseTerm(c) < term);

export function shortName(c) {
  const m = String(c.code || '').match(SECTION_RE) || c.name.match(/\b()([A-Z]{2,5})\s+(\d{5})\b/);
  if (m) {
    // Purdue numbers are 5 digits; students say the first 3 ("CHM 11510" → "CHM 115")
    const lab = /\blab\b/i.test(c.name);
    return `${m[2].toUpperCase()} ${m[3].slice(0, 3)}${lab ? ' Lab' : ''}`;
  }
  const paren = c.name.match(/\(([^)]{2,15})\)/); // "Fundamentals of Mechanical Design (SOLIDWORKS)" → "SOLIDWORKS"
  if (paren) return paren[1].trim();
  return c.name.replace(/^(Fall|Spring|Summer)\s+\d{4}\s*[-–]?\s*/i, '').trim(); // CSS ellipsizes long names
}

// This term's registrar courses always; everything else only while it has a not-done item due in the next 30 days.
export function defaultVisible(course, items, doneMap, now, term) {
  if (term && courseTerm(course) === term) return true;
  const n = new Date(now), horizon = addDays(n, 30);
  return items.some(i => i.courseId === course.id && i.due && !isDone(i, doneMap, n)
    && new Date(i.due) >= n && new Date(i.due) <= horizon);
}

export const isVisible = (course, items, state, now, term) =>
  typeof state.hiddenCourses?.[course.id] === 'boolean'
    ? !state.hiddenCourses[course.id]
    : defaultVisible(course, items, state.done, now, term);

// 13 bright hues for a black background; labels use black text on them (all ≥ 7:1).
export const PALETTE = ['#4ade80', '#60a5fa', '#c084fc', '#f472b6', '#2dd4bf', '#a3e635', '#fb923c', '#facc15', '#e879f9', '#fda4af', '#d6b48a', '#cbd5e1', '#ffffff'];
// Colors go to shown courses only (so they don't collide): this term's classes first, then the rest, by id.
export function courseColors(courses, visibleIds, term) {
  const shown = courses.filter(c => visibleIds.has(c.id))
    .sort((a, b) => (courseTerm(b) === term) - (courseTerm(a) === term) || a.id - b.id);
  return Object.fromEntries(shown.map((c, i) => [c.id, PALETTE[i % PALETTE.length]]));
}

// Ranges sort by their start until they begin, then by their end.
const sortKey = (i, now) => !i.due ? Infinity : i.rangeStart && new Date(i.rangeStart) > now ? +new Date(i.rangeStart) : +new Date(i.due);

// Every local day an item occupies on the calendar (ranges: each day, capped at 62).
export function itemDays(i) {
  if (!i.due) return [];
  if (!i.rangeStart) return [dayKey(i.due)];
  const out = [];
  for (let d = startOfDay(i.rangeStart); d <= new Date(i.due) && out.length < 62; d = addDays(d, 1)) out.push(dayKey(d));
  return out;
}

// ---- the whole view model (used by the page AND by the server's notifier) ----
export function viewModel({ items, tasks, courses, state, term }, now = new Date()) {
  const visible = new Set(courses.filter(c => isVisible(c, items, state, now, term)).map(c => c.id));
  const all = [...items, ...tasksToItems(tasks)]
    .filter(i => i.kind === 'task' ? (i.courseId == null || visible.has(i.courseId)) : visible.has(i.courseId))
    .map(i => {
      const done = isDone(i, state.done, now);
      return { ...i, done, st: status(i, now, done), opens: notOpenYet(i, now),
        isNew: !!i.firstSeen && now - new Date(i.firstSeen) < DAY && i.kind !== 'task' };
    })
    .sort((a, b) => sortKey(a, now) - sortKey(b, now) || a.title.localeCompare(b.title));
  return { now, visible, all };
}

// ---- notifications ----
// Sent at Windows start-up and after each scheduled refresh: unfinished items due today (including ones
// already past today) or early tomorrow morning (before this hour).
export const EARLY_MORNING_HOUR = 10;
export function digestItems(all, now) {
  const from = startOfDay(now);
  const until = addDays(from, 1); until.setHours(EARLY_MORNING_HOUR, 0, 0, 0);
  return all.filter(i => !i.done && i.due && (
    (new Date(i.due) >= from && new Date(i.due) < until) ||
    (i.rangeStart && new Date(i.rangeStart) < until && new Date(i.due) >= from))); // a range that covers today
}

// → {title, lines[]} or null when there's nothing to say.
export function digestMessage(items, now, label = i => '') {
  if (!items.length) return null;
  const today = dayKey(now);
  const n = new Date(now);
  const time = d => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const todays = items.filter(i => dayKey(i.due) === today);
  const tmrw = items.length - todays.length;
  const exams = items.filter(i => i.exam).length;
  const title = [todays.length && `${todays.length} due today`, tmrw && `${tmrw} early tomorrow`].filter(Boolean).join(' · ')
    + (exams ? ` (${exams} exam${exams > 1 ? 's' : ''})` : '');
  const lines = items.map(i => {
    const when = new Date(i.due) < n ? 'OVERDUE' : `${dayKey(i.due) === today ? '' : 'Tmrw '}${i.allDay ? 'all day' : time(i.due)}`;
    return `${i.exam ? 'EXAM ' : ''}${when} · ${label(i) ? label(i) + ': ' : ''}${i.title}`;
  });
  return { title, lines };
}

// Brightspace address, taken from any item link (so it works for any D2L school), and an announcement's page on it.
export const brightspaceOrigin = items => { for (const i of items || []) { try { if (i.url) return new URL(i.url).origin; } catch {} } return 'https://purdue.brightspace.com'; };
// Brightspace blocks an assignment's submission page (403) once it closes; the course's assignment list always opens.
export const assignmentListUrl = (origin, courseId) => `${origin}/d2l/lms/dropbox/user/folders_list.d2l?ou=${encodeURIComponent(courseId)}&isprv=0`;
export const announcementUrl = (origin, courseId, id) => `${origin}/d2l/le/news/${encodeURIComponent(courseId)}/${encodeURIComponent(id)}/view?ou=${encodeURIComponent(courseId)}`;

// Link a notification opens: one item → its details; several → those items highlighted.
export const digestLink = (base, items) => items.length === 1
  ? `${base}#item=${encodeURIComponent(items[0].id)}`
  : `${base}#due=${items.map(i => encodeURIComponent(i.id)).join(',')}`;
export function parseLink(hash) {
  const m = String(hash || '').match(/^#(item|due)=(.+)$/);
  if (!m) return null;
  const ids = m[2].split(',').map(s => { try { return decodeURIComponent(s); } catch { return null; } }).filter(Boolean);
  return ids.length ? { kind: m[1], ids } : null;
}

// ---- markdown for notes ----
// Returns blocks the page renders with createElement/textContent only, so a note can never inject HTML.
// Supports: # headings, **bold**, *italic*/_italic_, ~~strike~~, `code`, [links](https://…), bare URLs,
// - / * / 1. lists, - [ ] / - [x] checklists, > quotes, ``` code blocks, --- rules.
export function parseInline(text) {
  const out = [];
  const re = /(`[^`]+`)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|~~(.+?)~~|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)|(?<![\w_])_([^_\s](?:[^_]*[^_\s])?)_(?![\w_])|(https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'link', href: m[3], kids: parseInline(m[2]) });
    else if (m[4]) out.push({ t: 'b', kids: parseInline(m[4]) });
    else if (m[5]) out.push({ t: 's', kids: parseInline(m[5]) });
    else if (m[6] || m[7]) out.push({ t: 'i', kids: parseInline(m[6] || m[7]) });
    else if (m[8]) out.push({ t: 'link', href: m[8], kids: [{ t: 'text', v: m[8] }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

export function parseMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null, list = null;
  const endPara = () => { if (para) { blocks.push({ type: 'p', inline: parseInline(para.join('\n')) }); para = null; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/^\s*```/.test(line)) { // fenced code
      endPara(); endList();
      const code = [];
      while (++n < lines.length && !/^\s*```/.test(lines[n])) code.push(lines[n]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    let m;
    if (!line.trim()) { endPara(); endList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { endPara(); endList(); blocks.push({ type: 'h', level: m[1].length, inline: parseInline(m[2]) }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { endPara(); endList(); blocks.push({ type: 'hr' }); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { endPara(); endList(); blocks.push({ type: 'quote', inline: parseInline(m[1]) }); continue; }
    if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
      endPara();
      const kind = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.type !== kind) { endList(); list = { type: kind, items: [] }; }
      list.items.push({ inline: parseInline(m[3]), checked: m[2] == null ? null : m[2] !== ' ' });
      continue;
    }
    endList();
    (para ||= []).push(line);
  }
  endPara(); endList();
  return blocks;
}

// Month/week layout for one week row: multi-day items become bars (segments) packed into lanes.
// items: [{ id, startDay: Date(00:00), endDay: Date(00:00) }]; weekStart: Date(00:00) of the row's first day.
export function layoutSpans(items, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const dayIdx = d => Math.round((startOfDay(d) - weekStart) / DAY);
  const segs = [];
  for (const it of items) {
    if (it.endDay < weekStart || it.startDay > weekEnd) continue;
    const a = Math.max(0, dayIdx(it.startDay)), b = Math.min(6, dayIdx(it.endDay));
    segs.push({ ...it, col: a, span: b - a + 1, contLeft: it.startDay < weekStart, contRight: it.endDay > weekEnd });
  }
  segs.sort((x, y) => x.col - y.col || y.span - x.span);
  const laneEnds = [];
  for (const s of segs) {
    let lane = laneEnds.findIndex(end => end < s.col);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(-1); }
    laneEnds[lane] = s.col + s.span - 1;
    s.lane = lane;
  }
  return { segs, lanes: laneEnds.length };
}
// Boilerexams (boilerexams.com) keys courses as SUBJECT+5-digit number, e.g. "MA16200", "CHM11500".
// Brightspace may use a section-specific number ("CHM 11510" lecture) → match exact first, then same subject + first 3 digits.
export function boilerexamsKey(course, beCourses) {
  const m = String(course.code || '').match(SECTION_RE) || String(course.name || '').match(/\b()([A-Z]{2,5})\s*(\d{5})\b/);
  if (!m || !Array.isArray(beCourses)) return null;
  const subj = m[2].toUpperCase(), num = Number(m[3]);
  const exact = beCourses.find(c => c.abbreviation === subj && Number(c.number) === num);
  const near = exact || beCourses.find(c => c.abbreviation === subj && Math.floor(Number(c.number) / 100) === Math.floor(num / 100));
  return near ? `${near.abbreviation}${near.number}` : null;
}
export const boilerexamsUrl = key => `https://boilerexams.com/courses/${encodeURIComponent(key)}/exams`;

// Day view: place timed blocks [{id, start, end}] side by side when they overlap. Returns [{...b, col, cols}].
export function layoutDayBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => new Date(a.start) - new Date(b.start) || new Date(b.end) - new Date(a.end));
  const out = [];
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const colEnds = [];
    for (const b of cluster) {
      let col = colEnds.findIndex(end => end <= +new Date(b.start));
      if (col < 0) { col = colEnds.length; colEnds.push(0); }
      colEnds[col] = +new Date(b.end);
      b.col = col;
    }
    for (const b of cluster) out.push({ ...b, cols: colEnds.length });
    cluster = [];
  };
  for (const b of sorted) {
    if (+new Date(b.start) >= clusterEnd && cluster.length) flush(), clusterEnd = -Infinity;
    cluster.push({ ...b });
    clusterEnd = Math.max(clusterEnd, +new Date(b.end));
  }
  if (cluster.length) flush();
  return out;
}

export const sundayOf = d => { d = startOfDay(d); return addDays(d, -d.getDay()); };

// ---- optional features (⚙ Settings → Features) ----
// Each entry is off unless the user turns it on (state.features[id] === true). Add future features here.
export const GCAL_WINDOW = { back: 7, ahead: 42 }; // days around today that a sync reads
export const FEATURES = [
  { id: 'googleCalendar', name: 'Google Calendar', description: `See and manage events from Google calendars you choose, next to your Brightspace work. Syncs events from ${GCAL_WINDOW.back / 7} week back to ${GCAL_WINDOW.ahead / 7} weeks ahead; other months load when you ask. Uses the Google Calendar connector in Claude (Claude Code required).` },
  { id: 'grades', name: 'Grades', beta: true, description: 'A Grades tab with each class\'s grade worked out the way its syllabus says (weights or points), what-ifs, and "what do I need on the final". Leaves out Brightspace\'s category totals, which count work not graded yet as 0. Works without Claude; Syllabus scan fills in the grading schemes.' },
  { id: 'syllabusScan', name: 'Syllabus scan', description: 'Reads each class\'s syllabus (from Brightspace, or files you add) and puts its exams and deadlines on your calendar, the same careful way Smart Announcements does. It also reads the grading scheme for the Grades tab. Uses Claude (Claude Code required).' },
  { id: 'smartAnnouncements', name: 'Smart Announcements', description: 'Finds dated events in new announcements (review sessions, help rooms, exams, deadlines, class changes). Class events it is sure about are added to your calendar; the rest wait for you to accept, edit or decline. Uses Claude (Claude Code required).' },
];
export const featureOn = (state, id) => state?.features?.[id] === true && FEATURES.some(f => f.id === id);

// ---- Google Calendar (optional feature; see spec-google-calendar.md) ----
const pad2 = n => String(n).padStart(2, '0');
// Local ISO with offset, e.g. 2026-09-24T20:00:00-04:00 (what the connector expects).
export function localIso(d) {
  d = new Date(d);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}
export const htmlToText = s => String(s || '')
  .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/h[1-6]>|<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, ' ').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\n{3,}/g, '\n\n').trim();
const dateOnly = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };

// Connector event → dashboard event (null for cancelled). All-day end dates become exclusive: Google's API
// sends "2026-10-15" (exclusive) for a one-day event on the 14th, but the claude.ai connector sends
// "2026-10-14T00:00:00Z" (inclusive, same as the start), so a date with a time part gets one day added.
export function normalizeEvent(raw, calendarId) {
  if (!raw || raw.status === 'cancelled' || !raw.start) return null;
  const allDay = !raw.start.dateTime && !!raw.start.date;
  const start = allDay ? dateOnly(raw.start.date) : new Date(raw.start.dateTime);
  const allDayEnd = d => addDays(dateOnly(d), d.length > 10 ? 1 : 0);
  let end = raw.end ? (allDay ? allDayEnd(raw.end.date || raw.start.date) : new Date(raw.end.dateTime || raw.end.date)) : new Date(+start + 3600_000);
  if (allDay && end <= start) end = addDays(start, 1);
  if (isNaN(start) || isNaN(end)) return null;
  return {
    id: `g:${calendarId}:${raw.id}`, eventId: raw.id, calendarId, kind: 'gcal',
    title: raw.summary || '(no title)', start: start.toISOString(), end: end.toISOString(), allDay,
    location: raw.location || '', description: htmlToText(raw.description), htmlLink: raw.htmlLink || null,
    recurring: !!raw.recurringEventId, updated: raw.updated || null,
  };
}

// Local days an event covers (all-day: [start, end) exclusive; timed: each day it touches).
export function eventDays(ev) {
  const out = [];
  const last = ev.allDay ? addDays(new Date(ev.end), -1) : new Date(new Date(ev.end) - 1);
  for (let d = startOfDay(ev.start); d <= last && out.length < 62; d = addDays(d, 1)) out.push(dayKey(d));
  return out.length ? out : [dayKey(ev.start)];
}

// "CHM 11510 Exam 1" / "CHM115" / "MA 16200 lecture" → "CHM115" (subject + first 3 digits)
export const titleCourseKey = t => { const m = String(t || '').toUpperCase().match(/\b([A-Z]{2,5})\s?(\d{3})(\d{2})?\b/); return m ? m[1] + m[2] : null; };
export const shortCourseKey = short => { const m = String(short || '').toUpperCase().match(/^([A-Z]{2,5})\s(\d{3})\b/); return m ? m[1] + m[2] : null; };
const STOP = new Set(['the', 'and', 'for', 'due', 'with', 'from', 'lecture', 'lec', 'lab', 'section', 'sec']);
const words = t => new Set(String(t || '').toLowerCase().replace(/\b[a-z]{2,5}\s?\d{3,5}\b/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)));

// A Google event and a Brightspace item are the same thing when: same local day, the event title names the
// item's course, and either both are exams or the titles share at least 60% of their meaningful words.
// Returns { byItem: Map(itemId → event), merged: Set(eventId) }; each event merges with at most one item.
export function matchGoogle(items, events, shortById) {
  const byItem = new Map(), merged = new Set();
  for (const ev of events) {
    const key = titleCourseKey(ev.title);
    if (!key) continue;
    const day = dayKey(ev.start);
    const cands = items.filter(i => i.kind !== 'gcal' && i.due && !byItem.has(i.id) && dayKey(i.due) === day && shortCourseKey(shortById[i.courseId]) === key);
    const examEv = /\b(exam|midterm|final)\b/i.test(ev.title);
    const pick = cands.find(i => i.exam && examEv) || cands.find(i => {
      const a = words(i.title), b = words(ev.title);
      if (!a.size || !b.size) return false;
      let common = 0; for (const w of a) if (b.has(w)) common++;
      return common / Math.min(a.size, b.size) >= 0.6;
    });
    if (pick) { byItem.set(pick.id, ev); merged.add(ev.id); }
  }
  return { byItem, merged };
}

// Split plain text into text/link segments. Rendering uses textContent, so no HTML is ever interpreted.
export function linkify(text) {
  const out = [], re = /https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g; // don't swallow trailing punctuation
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---- Smart Announcements (optional feature; see spec-smart-announcements.md) ----
export const SMART_DAYS = 14;          // announcements posted this recently are scanned
export const SMART_KINDS = ['exam', 'review', 'help', 'deadline', 'class-change', 'optional'];
// Plain text of an announcement for the model (and for checking its quotes).
export const annText = a => `${a.title || ''}\n${htmlToText(a.body)}`.slice(0, 4000);
const squash = t => String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

// What's missing that should stop an event being added without asking: the date, always; the time, for an exam (not a
// quiz), a review session or a help session. A missing room never does ("Midterm 2, 8 PM" is worth adding without one).
export const blocksAdding = (missing, kind, title) => missing.some(m => /^date$/i.test(m) || (/^time$/i.test(m) && ['exam', 'review', 'help'].includes(kind) && !/quiz/i.test(title || '')));

// One suggestion from the model → a checked event, or null. The model read untrusted text, so nothing it says is
// trusted: the quote must be in the announcement, the date must be real and near the posting, times well-formed.
export function verifyFound(ev, ann, now = new Date()) {
  if (!ev || !ann || !SMART_KINDS.includes(ev.kind)) return null;
  const quote = squash(ev.quote);
  if (quote.length < 8 || !squash(annText(ann)).includes(quote)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return null;
  const day = dateOnly(ev.date);
  if (dayKey(day) !== ev.date) return null; // e.g. 2026-02-30
  const posted = startOfDay(ann.date || ann.createdDate || now);
  if (day < addDays(posted, -2) || day > addDays(posted, 300)) return null;
  const start = HM.test(ev.start || '') ? ev.start : null;
  const end = start && HM.test(ev.end || '') && ev.end > start ? ev.end : null;
  const at = hm => { const d = new Date(day); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
  const due = start ? at(start) : (() => { const d = new Date(day); d.setHours(23, 59, 0, 0); return d; })();
  if ((end ? at(end) : due) < new Date(now)) return null; // already over
  const missing = [...new Set((Array.isArray(ev.missing) ? ev.missing : []).map(String).filter(m => /^(date|time|start|end|location|place)$/i.test(m)))];
  return {
    annId: ann.id, courseId: ann.courseId, kind: ev.kind,
    title: String(ev.title || ann.title || 'Event').replace(/\s+/g, ' ').trim().slice(0, 120),
    date: ev.date, start, end, allDay: !start, location: String(ev.location || '').trim().slice(0, 120),
    quote: String(ev.quote).trim().slice(0, 500), missing,
    sure: ev.confidence === 'high' && !blocksAdding(missing, ev.kind, ev.title) && ev.kind !== 'optional',
  };
}

// Same event found twice (a reminder re-announcing it, or the exam detector already has it)? `words` is the
// Google-merge helper above (drops course codes and filler words).
// Timed events at the same course/day/minute are rarely two things, so half the words in common is enough; deadlines
// pile up at 11:59 PM ("PreLab Quiz – How Can We…" vs "Procedure – How Can We…"), so they must nearly match.
// `lenient`: comparing with a real Brightspace item, whose name announcements paraphrase.
export function sameEvent(a, b, lenient = false) {
  if (a.courseId !== b.courseId || a.date !== b.date) return false;
  if (a.start && b.start && a.start !== b.start) return false;
  const x = words(a.title), y = words(b.title);
  const shared = [...x].filter(w => y.has(w)).length;
  if (lenient || (a.start && b.start && a.start !== '23:59')) return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5;
  return shared / Math.max(1, x.size, y.size) >= 0.75;
}

// Where a checked event goes. Only sure events from this term's classes are added without asking. A deadline is also
// held for review when the same course already has a found deadline that day: two announcements often word one
// deadline differently ("Unit 1 coursework deadline" / "Complete remaining Unit 1 work"), and title words can't tell
// that apart from two real deadlines on one night, so the student decides (nothing is dropped).
export function smartStatus(f, found, isClass) {
  if (!f.sure || !isClass) return { status: 'review' };
  if (f.kind === 'deadline') {
    const other = found.find(x => x.status !== 'declined' && x.kind === 'deadline' && x.courseId === f.courseId && x.date === f.date);
    if (other) return { status: 'review', maybe: other.title };
  }
  return { status: 'added' };
}

// Added / accepted found events → dashboard items (kind 'event').
export function smartItems(found) {
  return found.filter(f => f.status === 'added').map(f => {
    const at = hm => { const d = dateOnly(f.date); if (hm) { const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); } else d.setHours(23, 59, 0, 0); return d; };
    return {
      id: f.id, courseId: f.courseId, kind: 'event', eventKind: f.kind, exam: f.kind === 'exam', title: f.title,
      due: at(f.start).toISOString(), end: f.end ? at(f.end).toISOString() : null, allDay: !f.start, start: null,
      location: f.location || '', points: null, timeLimit: null, url: null, submitted: false, graded: false,
      source: f.source || 'announcement', // 'syllabus' events come from Syllabus scan
      instructions: `From the ${f.source === 'syllabus' ? 'syllabus' : 'announcement'}:\n“${f.quote}”`, sourceAnnouncement: f.source === 'syllabus' ? null : f.annId,
    };
  });
}

// ---- Syllabus scan (optional feature; see spec-next-features.md §2) ----
// Is `quote` really in `text`? Syllabi are PDFs whose tables come out of text extraction in odd orders, so the model's
// quote may join pieces that aren't adjacent. Accept it when, ignoring case and punctuation, it's there verbatim, or
// all of its words appear in order within a short stretch of the text. Invented quotes still fail.
const plainWords = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function quoteInText(quote, text) {
  const q = plainWords(quote), hay = plainWords(text);
  if (q.length < 6) return false;
  if (hay.includes(q)) return true;
  const words = q.split(' ');
  if (words.length < 3) return false;
  for (let from = hay.indexOf(words[0]); from >= 0; from = hay.indexOf(words[0], from + 1)) {
    let at = from, ok = true;
    for (const w of words.slice(1)) { at = hay.indexOf(w, at + 1); if (at < 0 || at - from > 400 + q.length) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}

// One event suggested from a class's syllabus text → a checked event (same shape as verifyFound's), or null.
export function verifySyllabusEvent(ev, text, courseId, now = new Date()) {
  if (!ev || !SMART_KINDS.includes(ev.kind) || !quoteInText(ev.quote, text)) return null;
  // "class-change" only for days without class; a regular session ("Workshop 5") is not an event
  if (ev.kind === 'class-change' && !/\b(no (class|lecture|lab|recitation)|cancel|break|holiday|no school|not meet)/i.test(`${ev.title} ${ev.quote}`)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return null;
  const day = dateOnly(ev.date);
  if (dayKey(day) !== ev.date || day > addDays(now, 300)) return null;
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const start = HM.test(ev.start || '') ? ev.start : null;
  const end = start && HM.test(ev.end || '') && ev.end > start ? ev.end : null;
  const at = hm => { const d = new Date(day); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
  const last = end ? at(end) : start ? at(start) : (() => { const d = new Date(day); d.setHours(23, 59, 0, 0); return d; })();
  if (last < new Date(now)) return null; // already over
  const missing = [...new Set((Array.isArray(ev.missing) ? ev.missing : []).map(String).filter(m => /^(date|time|location)$/i.test(m)))];
  return {
    annId: `syl:${courseId}`, courseId, kind: ev.kind, source: 'syllabus',
    title: String(ev.title || 'Event').replace(/\s+/g, ' ').trim().slice(0, 120),
    date: ev.date, start, end, allDay: !start, location: String(ev.location || '').trim().slice(0, 120),
    quote: String(ev.quote).replace(/\s+/g, ' ').trim().slice(0, 500), missing,
    sure: ev.confidence === 'high' && !blocksAdding(missing, ev.kind, ev.title) && ev.kind !== 'optional',
  };
}

// The grading scheme the model read → checked, or null. Every component must be quoted from the text; weights are
// percents (weighted) or points (points). The student still confirms it before Grades uses it.
export function verifyGrading(g, text) {
  if (!g || !['weighted', 'points'].includes(g.type)) return null;
  const components = (Array.isArray(g.components) ? g.components : []).map(c => ({
    name: String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    value: Number(g.type === 'weighted' ? c?.weight : c?.points),
    ok: quoteInText(c?.quote || c?.name, text),
  })).filter(c => c.name && c.ok && Number.isFinite(c.value) && c.value > 0 && (g.type === 'points' || c.value <= 100))
    .map(({ name, value }) => ({ name, value }));
  if (!components.length) return null;
  const LETTER = /^[A-F][+-]?$/;
  const scale = (Array.isArray(g.scale) ? g.scale : [])
    .map(s => ({ letter: String(s?.letter || '').replace(/[−–]/g, '-').trim(), min: Number(s?.min) }))
    .filter(s => LETTER.test(s.letter) && Number.isFinite(s.min) && s.min >= 0 && s.min <= 100)
    .sort((a, b) => b.min - a.min);
  return { type: g.type, components, scale, total: Math.round(components.reduce((s, c) => s + c.value, 0) * 100) / 100 };
}

// Fields the student typed when accepting/editing a found event (Smart Announcements, Syllabus scan) → checked values.
export function eventFields(b, f) {
  const title = String(b.title ?? f.title).replace(/\s+/g, ' ').trim().slice(0, 120);
  const date = String(b.date ?? f.date);
  const hm = v => (v === '' || v == null ? null : /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);
  const start = 'start' in b ? hm(b.start) : f.start, end = 'end' in b ? hm(b.end) : f.end;
  if (!title) throw Object.assign(new Error('A title is required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dayKey(new Date(`${date}T12:00`)) !== date) throw Object.assign(new Error('Pick a valid date.'), { status: 400 });
  if (start === undefined || end === undefined) throw Object.assign(new Error('Times must look like 14:30.'), { status: 400 });
  if (end && (!start || end <= start)) throw Object.assign(new Error('The end must be after the start.'), { status: 400 });
  return { title, date, start, end, allDay: !start, location: String(b.location ?? f.location ?? '').trim().slice(0, 120), missing: [] };
}

// ---- Grades (optional feature; see spec-next-features.md §3) ----
// Purdue's common cutoffs, used when a syllabus doesn't give its own scale.
export const DEFAULT_SCALE = [['A', 93], ['A-', 90], ['B+', 87], ['B', 83], ['B-', 80], ['C+', 77], ['C', 73], ['C-', 70], ['D+', 67], ['D', 63], ['D-', 60]].map(([letter, min]) => ({ letter, min }));
export const letterFor = (pct, scale) => (pct == null ? null : ((scale?.length ? scale : DEFAULT_SCALE).find(s => pct >= s.min - 1e-9)?.letter || 'F'));

// Gradebook shorthand ("HW01", "Wk 2 REC", "Lec 3 EC", "Attn Qz") → the words a syllabus uses.
const ABBR = { hw: 'homework', rec: 'recitation', lec: 'lecture', qz: 'quiz', attn: 'attendance', ec: 'extra', lab: 'lab', proj: 'project', pres: 'presentation', mt: 'midterm' };
const gradeWords = t => new Set(String(t || '').toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w))
  .map(w => ABBR[w] || w).map(w => w.replace(/zzes$/, 'z').replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/([^s])s$/, '$1'))); // quizzes → quiz, exams → exam
// Is this row named like the category itself ("Quizzes", "Chapter Quizzes - 114 F26", "Rec attendance") rather than one
// item in it ("Quiz 1", "HW01_due_Sept_2", "Wk 3 REC")? Items carry a small number; category rows don't.
const namesCategory = (rowName, compName) => {
  const r = gradeWords(rowName), c = gradeWords(compName);
  return [...c].filter(w => r.has(w)).length / Math.max(1, Math.min(c.size, r.size)) >= 0.5
    && !/(^|\s)\d{1,2}(\s|$)/.test(String(rowName).replace(/[^A-Za-z0-9]+/g, ' '));
};
// Brightspace lists category totals next to the items ("Homework 27.5/50" = HW01+HW02+HW03, and counting the homework
// not graded yet as 0; "Wellness Wisdom 0/95" before anything in it is graded). Counting them too double-counts and
// drags the grade down, which is much of why Brightspace's number looks wrong. Mark at most one per category.
function markCategoryTotals(list) {
  for (const comp of new Set(list.map(r => r.component).filter(Boolean))) {
    const rows = list.filter(r => r.component === comp);
    const total = rows.find(r => { const others = rows.filter(o => o !== r); return others.length && Math.abs(others.reduce((s, o) => s + o.real, 0) - r.real) < 0.05 && r.possible >= others.reduce((s, o) => s + o.possible, 0) - 1e-9; })
      || rows.find(r => { const others = rows.filter(o => o !== r); return namesCategory(r.name, comp) && (others.length ? r.possible >= Math.max(...others.map(o => o.possible)) : r.real === 0); });
    if (total) total.summary = true;
  }
}
// Which grading component a Brightspace row belongs to, by shared words ("Midterm Exam 1" → "Midterm Exam 1",
// "WebAssign 3" → "WebAssign", "Exam 1" → "Exams"). null when nothing matches.
export function guessComponent(rowName, components) {
  const r = gradeWords(rowName);
  let best = null, score = 0;
  for (const c of components || []) {
    const w = gradeWords(c.name);
    const shared = [...w].filter(x => r.has(x)).length; // more words in common wins; then the closer fit
    const s = shared ? shared + shared / Math.max(1, w.size) + (String(rowName).toLowerCase().includes(String(c.name).toLowerCase()) ? 1 : 0) : 0;
    if (s > score) { best = c.name; score = s; }
  }
  return score > 0 ? best : null;
}

// rows: Brightspace grade rows ({ name, pointsNumerator, pointsDenominator }); cfg: { scheme: { type: 'weighted'|'points',
// components: [{ name, value }], scale }, assign: { rowName: componentName }, ignore: { rowName: true } }; whatIf: { rowName: percent }.
// → { pct, letter, basis, share (0..1 of the course already graded, when known), categories: [...], rows: [...] }
export function gradeFor(rows, cfg = {}, whatIf = {}) {
  const scheme = cfg.scheme && ['weighted', 'points'].includes(cfg.scheme.type) ? cfg.scheme : null;
  const components = scheme?.components || [];
  const list = (rows || []).filter(r => Number(r.pointsDenominator) > 0).map(r => {
    const den = Number(r.pointsDenominator), tried = whatIf[r.name] != null && whatIf[r.name] !== '' && Number.isFinite(Number(whatIf[r.name]));
    const earned = tried ? Number(whatIf[r.name]) / 100 * den : Number(r.pointsNumerator) || 0;
    // extra credit adds to what you earned, never to what was possible
    const extra = /(^|[^a-z])EC([^a-z]|$)|extra credit|bonus/i.test(r.name); // "Lec 3 EC", "(1 pt EC)" (not "Rec")
    return { name: r.name, earned, possible: extra ? 0 : den, extra, real: Number(r.pointsNumerator) || 0, whatIf: tried, zero: !tried && !(Number(r.pointsNumerator) > 0),
      ignored: !!cfg.ignore?.[r.name], component: scheme ? (cfg.assign?.[r.name] ?? guessComponent(r.name, components)) : null };
  });
  if (scheme) { markCategoryTotals(list); for (const r of list) if (r.summary && !cfg.include?.[r.name]) r.ignored = true; }
  const counted = list.filter(r => !r.ignored);
  const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
  const scale = scheme?.scale?.length ? scheme.scale : DEFAULT_SCALE;
  if (scheme?.type === 'weighted') {
    const categories = components.map(c => {
      const rs = counted.filter(r => r.component === c.name);
      const possible = sum(rs, 'possible');
      return { name: c.name, weight: c.value, earned: sum(rs, 'earned'), possible, pct: possible ? sum(rs, 'earned') / possible * 100 : null, rows: list.filter(r => r.component === c.name) };
    });
    const graded = categories.filter(c => c.pct != null);
    const total = sum(categories, 'weight'), gw = sum(graded, 'weight');
    const pct = gw ? graded.reduce((s, c) => s + c.weight * c.pct, 0) / gw : null;
    return { pct, letter: letterFor(pct, scale), basis: 'weighted', share: total ? gw / total : null, categories, rows: list,
      unassigned: list.filter(r => !r.component || !components.some(c => c.name === r.component)), scale, total };
  }
  const possible = sum(counted, 'possible'), pct = possible ? sum(counted, 'earned') / possible * 100 : null;
  const coursePoints = scheme?.type === 'points' ? components.reduce((s, c) => s + c.value, 0) : 0;
  return { pct, letter: letterFor(pct, scale), basis: scheme ? 'points' : 'simple', share: coursePoints ? Math.min(1, possible / coursePoints) : null,
    categories: [], rows: list, unassigned: [], scale, total: coursePoints };
}

// What average on everything not graded yet gets the course to `target` percent? → { need, on } or null when unknown.
// on: the name of the only category still ungraded (e.g. "Final Exam"), else null ("everything left").
export function needFor(target, g) {
  if (g.basis === 'weighted') {
    const left = g.categories.filter(c => c.pct == null), leftWeight = left.reduce((s, c) => s + c.weight, 0);
    if (!leftWeight) return null;
    const have = g.categories.filter(c => c.pct != null).reduce((s, c) => s + c.weight * c.pct, 0);
    return { need: (target * g.total - have) / leftWeight, on: left.length === 1 ? left[0].name : null };
  }
  if (g.basis === 'points' && g.total) {
    const counted = g.rows.filter(r => !r.ignored), earned = counted.reduce((s, r) => s + r.earned, 0), possible = counted.reduce((s, r) => s + r.possible, 0);
    const left = g.total - possible;
    if (left <= 0) return null;
    return { need: (target / 100 * g.total - earned) / left * 100, on: null };
  }
  return null;
}

// A grading setup the student saved (POST /api/state { grades: { courseId: … } }) → checked, or throws.
export function cleanGradeConfig(v) {
  const bad = m => { throw Object.assign(new Error(m), { status: 400 }); };
  const out = {};
  if (v.scheme != null) {
    const s = v.scheme;
    if (!['weighted', 'points'].includes(s.type)) bad('Pick weighted or points.');
    const components = (Array.isArray(s.components) ? s.components : []).slice(0, 30).map(c => ({ name: String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60), value: Number(c?.value) }));
    if (!components.length || components.some(c => !c.name || !Number.isFinite(c.value) || c.value <= 0 || c.value > 10000)) bad('Each part needs a name and a number above 0.');
    if (new Set(components.map(c => c.name.toLowerCase())).size !== components.length) bad('Two parts have the same name.');
    const scale = (Array.isArray(s.scale) ? s.scale : []).slice(0, 15).map(x => ({ letter: String(x?.letter || '').slice(0, 3), min: Number(x?.min) }))
      .filter(x => /^[A-F][+-]?$/.test(x.letter) && Number.isFinite(x.min) && x.min >= 0 && x.min <= 100).sort((a, b) => b.min - a.min);
    out.scheme = { type: s.type, components, scale, from: s.from === 'syllabus' ? 'syllabus' : 'you' };
  }
  const map = (o, f) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 300).map(([k, x]) => [String(k).slice(0, 200), f(x)]).filter(([, x]) => x != null));
  if (v.assign != null) out.assign = map(v.assign, x => (typeof x === 'string' ? x.slice(0, 60) : null));
  if (v.ignore != null) out.ignore = map(v.ignore, x => (x === true ? true : null));
  if (v.include != null) out.include = map(v.include, x => (x === true ? true : null)); // category-total rows counted anyway
  return out;
}
