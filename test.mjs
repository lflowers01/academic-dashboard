import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from './logic.mjs';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('refresh slots: every 3h aligned to local midnight', () => {
  assert.equal(L.lastSlot(at(2026, 9, 18, 14, 59)).getHours(), 12);
  assert.equal(L.nextSlot(at(2026, 9, 18, 14, 59)).getHours(), 15);
  const n = L.nextSlot(at(2026, 9, 18, 23, 59));
  assert.deepEqual([n.getDate(), n.getHours()], [19, 0]); // 23:59 → midnight next day
});

test('refreshDue: once per slot, catches up after sleep', () => {
  assert.equal(L.refreshDue(at(2026, 9, 18, 12, 1), null), true);
  assert.equal(L.refreshDue(at(2026, 9, 18, 14, 0), at(2026, 9, 18, 12, 1)), false);
  assert.equal(L.refreshDue(at(2026, 9, 19, 0, 0), at(2026, 9, 18, 23, 0)), true); // midnight
  assert.equal(L.refreshDue(at(2026, 9, 20, 9, 5), at(2026, 9, 18, 21, 0)), true); // woke after 2 days
});

test('status boundaries use local days', () => {
  const now = at(2026, 9, 18, 13, 0);
  const s = due => L.status({ due: due.toISOString() }, now, false);
  assert.equal(s(at(2026, 9, 18, 23, 59)), 'today');
  assert.equal(s(at(2026, 9, 19, 0, 0)), 'tomorrow');
  assert.equal(s(at(2026, 9, 20, 0, 0)), 'week');
  assert.equal(s(at(2026, 9, 25, 0, 0)), 'later');
  assert.equal(s(at(2026, 9, 18, 12, 0)), 'overdue');
  assert.equal(s(at(2026, 9, 4, 12, 0)), 'expired'); // > 14 days old
  assert.equal(L.status({ due: null }, now, false), 'nodate');
  assert.equal(L.status({ due: at(2026, 9, 1).toISOString() }, now, true), 'done');
});

test('UTC 03:59:59Z shows on the previous local evening (EDT)', () => {
  const d = new Date('2026-09-19T03:59:59.000Z');
  if (-d.getTimezoneOffset() === -240) assert.equal(L.dayKey(d), '2026-09-18');
});

test('done rules: submission, grade match, manual override wins', () => {
  const raw = {
    assignments: { 7: { assignments: [
      { type: 'assignment', id: 1, name: 'Essay', submission: { files: [] } },
      { type: 'assignment', id: 2, name: 'Essay 2', submission: null },
      { type: 'quiz', id: 3, name: 'Homework 4: Circuits' },
      { type: 'quiz', id: 4, name: 'Week 2 Quiz' },
    ] } },
    grades: { 7: { grades: [
      { name: 'homework 4 circuits', pointsNumerator: 9, pointsDenominator: 10 },
      { name: 'Week 2 Quiz', pointsNumerator: 0, pointsDenominator: 0 }, // placeholder, not graded
    ] } },
  };
  const [a1, a2, q3, q4] = L.buildItems(raw);
  assert.equal(L.isDone(a1), true);
  assert.equal(L.isDone(a2), false);
  assert.equal(L.isDone(q3), true);
  assert.equal(L.isDone(q4), false);
  assert.equal(L.isDone(a1, { [a1.id]: false }), false);
  assert.equal(L.isDone(a2, { [a2.id]: true }), true);
});

test('all-day task counts as due 23:59 local', () => {
  const d = L.taskDue({ date: '2026-09-23' });
  assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [23, 23, 59]);
  assert.equal(L.taskDue({ date: '2026-09-23', time: '20:00' }).getHours(), 20);
});

test('course names + default visibility (fictional fixture)', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url)));
  const byId = Object.fromEntries(raw.courses.map(c => [c.id, c]));
  assert.equal(L.shortName(byId[101]), 'MA 161');
  assert.equal(L.shortName(byId[103]), 'CHM 115 Lab');
  assert.equal(L.shortName(byId[204]), 'Robotics Club CAD Training');
  assert.equal(L.shortName({ name: 'Fundamentals of Mechanical Design (SOLIDWORKS)', code: 'x' }), 'SOLIDWORKS');
  assert.equal(L.shortName({ name: 'Fall 2026 - MA 16200  - Merge', code: 'wl.202710.MA.16200.100' }), 'MA 162');
  const term = L.currentTerm(raw.courses);
  assert.equal(term, '202710');
  const items = L.buildItems(raw), now = new Date(raw.anchor);
  const vis = id => L.defaultVisible(byId[id], items, {}, now, term);
  for (const id of [101, 102, 103, 104, 105, 106]) assert.equal(vis(id), true, byId[id].name);
  assert.equal(vis(107), false); // last term's course
  assert.equal(vis(201), false); // orientation, no deadlines
  assert.equal(vis(202), false); // newsletter
  assert.equal(vis(203), true);  // module with a deadline in 13 days
  assert.equal(vis(204), true);  // club training with deadlines
  assert.equal(L.isVisible(byId[202], items, { hiddenCourses: { 202: false }, done: {} }, now, term), true);
  assert.equal(L.isVisible(byId[101], items, { hiddenCourses: { 101: true }, done: {} }, now, term), false);
});

test('linkify never produces HTML, only text/href segments', () => {
  const segs = L.linkify('See <b>x</b> https://purdue.edu/a?b=1. done');
  assert.deepEqual(segs.map(s => s.href).filter(Boolean), ['https://purdue.edu/a?b=1']);
  assert.equal(segs.map(s => s.text).join(''), 'See <b>x</b> https://purdue.edu/a?b=1. done');
});

test('colors: distinct across shown courses, term classes first', () => {
  const courses = [{ id: 5, code: 'wl.202710.MA.16200.1' }, { id: 2, code: 'club' }, { id: 9, code: 'wl.202710.CS.15900.1' }, { id: 3, code: 'news' }];
  const c = L.courseColors(courses, new Set([5, 2, 9]), '202710');
  assert.equal(c[5], L.PALETTE[0]);
  assert.equal(c[9], L.PALETTE[1]);
  assert.equal(c[2], L.PALETTE[2]);
  assert.equal(c[3], undefined); // hidden → no color used up
  assert.equal(new Set(Object.values(c)).size, 3);
});

test('exam names: real exams yes, practice/info/reflection no', () => {
  for (const n of ['Exam 2', 'Midterm', 'Midterm Exam 1', 'Final Exam', 'EXAM 3 (Online)', 'Exams'])
    assert.equal(L.isExamName(n), true, n);
  for (const n of ['Exam 1 Practice Quiz', 'Exam Agreement', 'Midterm Exam Information', 'Final Reflection', 'Exam Wrapper', 'Homework 4', 'Examine the data', 'Final Project', 'Exam 1 Review', 'Syllabus Quiz'])
    assert.equal(L.isExamName(n), false, n);
});

test('announced exams: formats, abbreviations, noise', () => {
  const ref = '2026-09-18T15:00:00Z';
  const got = L.examsFromAnnouncements([
    { id: 1, courseId: 9, date: ref, title: 'Exam 1 Information', body: 'The first exam is on Wednesday, 23 September 2026 from 8:00-9:00PM.  For more information see:\r\n\r\nMidterm Exam Information\r\nExam Agreement' },
    { id: 2, courseId: 9, date: '2026-09-20T15:00:00Z', title: 'Reminder', body: 'Reminder: Exam 1 is 9/23 at 8 PM in ELLT 116.' }, // same exam → deduped
    { id: 3, courseId: 8, date: ref, title: 'Midterm 2 moved', body: 'Midterm 2 will now be held on Oct. 29th, 7-9 pm. Practice exam posted Oct 20.' },
    { id: 4, courseId: 6, date: ref, title: 'Exam', body: 'Exam 2 is Thurs. 11/5 at 8:00 p.m. in PHYS 112.' },
    { id: 5, courseId: 5, date: ref, title: 'Final exam', body: 'Our final exam is December 14.' },
    { id: 6, courseId: 7, date: ref, title: 'Grades', body: 'Exam 1 grades are posted as of September 24.' },
    { id: 7, courseId: 7, date: ref, title: 'Office hours', body: 'No office hours on 9/30.' },
    { id: 8, courseId: 7, date: ref, title: 'Old news', body: 'Remember the exam we had on September 1?' }, // in the past → ignored
    // A real-world style announcement: one true exam, three deadline sentences that only mention an exam.
    { id: 9, courseId: 4, date: '2026-09-09T15:00:00Z', title: 'Week 3 Update', body: 'Exam 1 is Thurs. Sept. 24, 8:00-9:00 PM (unless you have accommodations)\nIf you have a direct conflict with another exam or class, you must email chem-exams@example.edu no later than Thurs. Sept. 17 to request a reschedule.\nIf you need a left-handed desk for Exam 1, sign up at Exam 1 Left-handed seat request – Fill out form by Thurs. Sept. 10 at 11:59 PM.' },
    { id: 10, courseId: 3, date: '2026-09-09T15:00:00Z', title: 'Exam Agreement due September 16', body: 'Please complete the exam agreement.' },
  ]);
  const show = e => `${e.courseId} ${e.title} ${L.dayKey(e.due)} ${e.allDay ? 'all-day' : new Date(e.due).getHours() + ':' + String(new Date(e.due).getMinutes()).padStart(2, '0')}${e.end ? '-' + new Date(e.end).getHours() : ''}`;
  assert.deepEqual(got.map(show).sort(), [
    '9 Exam 1 2026-09-23 20:00-21',
    '8 Midterm 2 2026-10-29 19:00-21',
    '6 Exam 2 2026-11-05 20:00',
    '5 Final Exam 2026-12-14 all-day',
    '4 Exam 1 2026-09-24 20:00-21',
  ].sort());
});

test('announced exam is skipped when the course already has an exam item that day', () => {
  const raw = {
    assignments: { 9: { assignments: [{ type: 'quiz', id: 1, name: 'Exam 1', dueDate: new Date(2026, 8, 23, 21).toISOString() }] } },
    announcements: [{ id: 1, courseId: 9, date: '2026-09-18T15:00:00Z', title: 'Exam 1', body: 'Exam 1 is September 23 at 8 PM.' }],
  };
  assert.equal(L.buildItems(raw).filter(i => i.exam).length, 1);
});

test('announced exams count as done once over; a manual toggle still wins', () => {
  const e = { id: 'ex:1', kind: 'exam', due: new Date(2026, 8, 23, 20).toISOString(), end: new Date(2026, 8, 23, 21).toISOString() };
  assert.equal(L.isDone(e, {}, new Date(2026, 8, 23, 20, 30)), false); // during
  assert.equal(L.isDone(e, {}, new Date(2026, 8, 23, 21, 1)), true);   // after
  assert.equal(L.isDone(e, { 'ex:1': true }, new Date(2026, 8, 22)), true);
});

test('digest: due today (incl. already past today) + before 10 AM tomorrow, nothing done', () => {
  const now = at(2026, 9, 18, 13, 0);
  const mk = (id, due, extra = {}) => ({ id, title: id, due: due.toISOString(), done: false, ...extra });
  const all = [
    mk('past-today', at(2026, 9, 18, 9, 30)),
    mk('tonight', at(2026, 9, 18, 23, 59)),
    mk('done-tonight', at(2026, 9, 18, 23, 59), { done: true }),
    mk('tmrw-830', at(2026, 9, 19, 8, 30)),
    mk('tmrw-959', at(2026, 9, 19, 9, 59)),
    mk('tmrw-1000', at(2026, 9, 19, 10, 0)),
    mk('yesterday', at(2026, 9, 17, 23, 59)),
    mk('exam', at(2026, 9, 18, 20, 0), { exam: true }),
    { id: 'nodate', title: 'x', due: null, done: false },
  ];
  assert.deepEqual(L.digestItems(all, now).map(i => i.id), ['past-today', 'tonight', 'tmrw-830', 'tmrw-959', 'exam']);
  const msg = L.digestMessage(L.digestItems(all, now), now, () => 'MA 162');
  assert.equal(msg.title, '3 due today · 2 early tomorrow (1 exam)');
  assert.match(msg.lines[0], /^OVERDUE · MA 162: past-today$/);
  assert.match(msg.lines.join('\n'), /Tmrw 8:30 AM · MA 162: tmrw-830/);
  assert.match(msg.lines.join('\n'), /EXAM 8:00 PM/);
  assert.equal(L.digestMessage([], now), null);
});

test('only current, active, accessible courses are fetched', () => {
  const t = '202710';
  assert.equal(L.shouldFetch({ code: 'wl.202710.MA.16200.1' }, t), true);
  assert.equal(L.shouldFetch({ code: 'wl.202620.MA.16100.1' }, t), false);
  assert.equal(L.shouldFetch({ code: 'club', isActive: false }, t), false);
  assert.equal(L.shouldFetch({ code: 'club', canAccess: false }, t), false);
  assert.equal(L.shouldFetch({ code: 'club' }, t), true);
});

test('announcement links point at the item\'s Brightspace', () => {
  assert.equal(L.brightspaceOrigin([{ url: null }, { url: 'https://purdue.brightspace.com/d2l/lms/x?a=1' }]), 'https://purdue.brightspace.com');
  assert.equal(L.brightspaceOrigin([]), 'https://purdue.brightspace.com');
  assert.equal(L.assignmentListUrl('https://purdue.brightspace.com', 100200), 'https://purdue.brightspace.com/d2l/lms/dropbox/user/folders_list.d2l?ou=100200&isprv=0');
  assert.equal(L.announcementUrl('https://purdue.brightspace.com', 100300, 9000400), 'https://purdue.brightspace.com/d2l/le/news/100300/9000400/view?ou=100300');
});

test('notification links: one item → details, several → highlight; round-trips odd ids', () => {
  const base = 'http://localhost:4321/';
  const one = L.digestLink(base, [{ id: 'bs:1:quiz:2' }]);
  assert.equal(one, 'http://localhost:4321/#item=bs%3A1%3Aquiz%3A2');
  assert.deepEqual(L.parseLink(one.slice(base.length)), { kind: 'item', ids: ['bs:1:quiz:2'] });
  const many = L.digestLink(base, [{ id: 'ex:9:2026-09-23' }, { id: 'task:a,b#c' }]);
  assert.deepEqual(L.parseLink(many.slice(base.length)), { kind: 'due', ids: ['ex:9:2026-09-23', 'task:a,b#c'] });
  assert.equal(L.parseLink('#nothing'), null);
  assert.equal(L.parseLink('#item=%E0%A4%A'), null); // malformed encoding is ignored, not thrown
});

test('date-range tasks: today while inside, sorted by start before, every day on the calendar, in the digest', () => {
  const [t] = L.tasksToItems([{ id: 'task:r', title: 'Weekend project', date: '2026-09-19', endDate: '2026-09-20' }]);
  assert.equal(new Date(t.rangeStart).getDate(), 19);
  assert.deepEqual([new Date(t.due).getDate(), new Date(t.due).getHours()], [20, 23]);
  assert.equal(L.status(t, at(2026, 9, 17, 12), false), 'week');      // before: by its start
  assert.equal(L.status(t, at(2026, 9, 18, 12), false), 'tomorrow');  // starts tomorrow
  assert.equal(L.status(t, at(2026, 9, 19, 8), false), 'today');      // inside
  assert.equal(L.status(t, at(2026, 9, 20, 22), false), 'today');     // last day
  assert.equal(L.status(t, at(2026, 9, 21, 9), false), 'overdue');    // after
  assert.deepEqual(L.itemDays(t), ['2026-09-19', '2026-09-20']);
  assert.deepEqual(L.digestItems([{ ...t, done: false }], at(2026, 9, 19, 9)).map(i => i.id), ['task:r']);
  assert.deepEqual(L.digestItems([{ ...t, done: false }], at(2026, 9, 17, 9)), []);
  // single-day tasks are unchanged
  const [s] = L.tasksToItems([{ id: 'task:s', title: 'x', date: '2026-09-19' }]);
  assert.equal(s.rangeStart, null);
  assert.deepEqual(L.itemDays(s), ['2026-09-19']);
});

test('markdown notes: blocks and inline, never raw HTML', () => {
  const b = L.parseMarkdown('# Study\n**Ch 3** and *4*, ~~5~~ `eq 2`\n\n- [ ] flashcards\n- [x] read\n1. one\n2. two\n> room ELLT 116\n---\n<script>alert(1)</script> see [notes](https://x.com/a) or https://purdue.edu.\n```\n**not bold**\n```');
  assert.deepEqual(b.map(x => x.type), ['h', 'p', 'ul', 'ol', 'quote', 'hr', 'p', 'code']);
  assert.deepEqual(b[1].inline.map(t => t.t), ['b', 'text', 'i', 'text', 's', 'text', 'code']);
  assert.deepEqual(b[2].items.map(i => i.checked), [false, true]);
  const p = b[6].inline;
  assert.equal(p[0].v, '<script>alert(1)</script> see '); // stays text
  assert.deepEqual(p.filter(t => t.t === 'link').map(t => t.href), ['https://x.com/a', 'https://purdue.edu']);
  assert.equal(b[7].text, '**not bold**');
  assert.deepEqual(L.parseInline('[x](javascript:alert(1))').map(t => t.t), ['text']); // only http(s) links
  assert.deepEqual(L.parseInline('2*3*4 and snake_case_name').map(t => t.t), ['text']); // no false italics
});

test('week layout: Sunday start, multi-day bars packed into lanes, continuation flags', () => {
  assert.equal(L.sundayOf(at(2026, 9, 18)).getDay(), 0);
  assert.equal(L.dayKey(L.sundayOf(at(2026, 9, 18))), '2026-09-13');
  assert.equal(L.dayKey(L.sundayOf(at(2026, 9, 13))), '2026-09-13');
  const ws = at(2026, 9, 13);
  const { segs, lanes } = L.layoutSpans([
    { id: 'a', startDay: at(2026, 9, 18), endDay: at(2026, 9, 21) }, // Fri → next Mon: continues right
    { id: 'b', startDay: at(2026, 9, 10), endDay: at(2026, 9, 14) }, // from last week: continues left
    { id: 'c', startDay: at(2026, 9, 15), endDay: at(2026, 9, 16) }, // Tue–Wed: fits in b's lane
    { id: 'd', startDay: at(2026, 9, 16), endDay: at(2026, 9, 18) }, // overlaps c → new lane
    { id: 'z', startDay: at(2026, 9, 25), endDay: at(2026, 9, 26) }, // not this week
  ], ws);
  const by = Object.fromEntries(segs.map(s => [s.id, s]));
  assert.deepEqual([by.b.col, by.b.span, by.b.contLeft, by.b.contRight], [0, 2, true, false]);
  assert.deepEqual([by.a.col, by.a.span, by.a.contLeft, by.a.contRight], [5, 2, false, true]);
  assert.equal(by.c.lane, by.b.lane);
  assert.notEqual(by.d.lane, by.c.lane);
  assert.equal(by.z, undefined);
  assert.equal(lanes, 2);
});

test('Boilerexams matching: exact, lecture/lab section numbers, missing courses', () => {
  const be = [{ abbreviation: 'MA', number: 16200 }, { abbreviation: 'CHM', number: 11500 }, { abbreviation: 'CS', number: 15900 }];
  assert.equal(L.boilerexamsKey({ code: 'wl.202710.MA.16200.100', name: 'Fall 2026 - MA 16200' }, be), 'MA16200');
  assert.equal(L.boilerexamsKey({ code: 'wl.202710.CHM.11510.001', name: 'CHM 11510' }, be), 'CHM11500'); // lecture section → course
  assert.equal(L.boilerexamsKey({ code: 'wl.202710.ENGT.18200.SC1', name: 'ENGT 182' }, be), null);
  assert.equal(L.boilerexamsKey({ code: 'club', name: 'Robotics Club' }, be), null);
  assert.equal(L.boilerexamsKey({ code: 'x', name: 'Fall 2026 CS 15900 - Merge' }, be), 'CS15900'); // from the name
  assert.equal(L.boilerexamsUrl('MA16200'), 'https://boilerexams.com/courses/MA16200/exams');
});

test('Windows notification switch is read from reg output', async () => {
  const { parseRegDword } = await import('./toast.mjs');
  assert.equal(parseRegDword('HKEY_CURRENT_USER\\x\r\n    ToastEnabled    REG_DWORD    0x0\r\n', 'ToastEnabled'), '0');
  assert.equal(parseRegDword('    ToastEnabled    REG_DWORD    0x1', 'ToastEnabled'), '1');
  assert.equal(parseRegDword('ERROR: The system was unable to find the specified registry key', 'ToastEnabled'), null);
});

test('notification XML escapes everything and drops control characters', async () => {
  const { toastXml } = await import('./toast.mjs');
  const x = toastXml(`a${String.fromCharCode(1)}<b>&"'`, ['<script>'], 'http://localhost:4321/?a=1&b=2');
  assert.ok(x.includes('a&lt;b&gt;&amp;&quot;&apos;'));
  assert.ok(x.includes('&lt;script&gt;'));
  assert.ok(x.includes('launch="http://localhost:4321/?a=1&amp;b=2"'));
  assert.ok(!x.includes(String.fromCharCode(1)));
});
