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
  if (item.kind === 'exam' || (item.kind === 'task' && item.exam)) return new Date(item.end || item.due) < new Date(now);
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

export const sundayOf = d => { d = startOfDay(d); return addDays(d, -d.getDay()); };

// ---- optional features (⚙ Settings → Features) ----
// Each entry is off unless the user turns it on (state.features[id] === true). Add future features here.
export const FEATURES = [];
export const featureOn = (state, id) => state?.features?.[id] === true && FEATURES.some(f => f.id === id);

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
