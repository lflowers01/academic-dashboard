// Grades (optional feature): the math, with the scheme shapes seen in real syllabi, and the saved-setup checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeFor, needFor, guessComponent, letterFor, cleanGradeConfig, DEFAULT_SCALE } from './logic.mjs';

const r = (name, n, d) => ({ name, pointsNumerator: n, pointsDenominator: d });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg || ''} ${a} ≈ ${b}`);

test('letters come from the course scale, else Purdue defaults', () => {
  assert.equal(letterFor(92.99, DEFAULT_SCALE), 'A-');
  assert.equal(letterFor(93, DEFAULT_SCALE), 'A');
  assert.equal(letterFor(59, DEFAULT_SCALE), 'F');
  assert.equal(letterFor(88, [{ letter: 'A', min: 92 }, { letter: 'B+', min: 88 }]), 'B+');
  assert.equal(letterFor(null), null);
});

test('rows are matched to components by name', () => {
  const comps = [{ name: 'Quizzes' }, { name: 'WebAssign' }, { name: 'Midterm Exam 1' }, { name: 'Midterm Exam 2' }, { name: 'Final Exam' }];
  assert.equal(guessComponent('Quiz 3: Limits', comps), 'Quizzes');
  assert.equal(guessComponent('WebAssign 3', comps), 'WebAssign');
  assert.equal(guessComponent('Midterm Exam 2', comps), 'Midterm Exam 2');
  assert.equal(guessComponent('Final Exam', comps), 'Final Exam');
  assert.equal(guessComponent('Exam 1', [{ name: 'Homework' }, { name: 'Exams' }]), 'Exams');
  assert.equal(guessComponent('Survey', comps), null);
});

test('points: total earned / possible; placeholders (x/0) are skipped; empty category rows and zeros can be counted or not', () => {
  const rows = [r('Homework', 27.5, 50), r('Pre-Rec Quiz', 8, 15), r('Rec Worksheet', 0, 20), r('Final', 0, 0)];
  const scheme = { type: 'points', components: [{ name: 'Homework', value: 130 }, { name: 'Quiz', value: 40 }, { name: 'Worksheets', value: 45 }], scale: [] };
  const g = gradeFor(rows, { scheme });
  assert.equal(g.rows.find(x => x.name === 'Rec Worksheet').summary, true, 'an empty category row (0, nothing graded in it)');
  near(g.pct, 35.5 / 65 * 100); assert.equal(g.basis, 'points'); near(g.share, 65 / 215);
  near(gradeFor(rows, { scheme, include: { 'Rec Worksheet': true } }).pct, 35.5 / 85 * 100, 'counted anyway when you say so');
  near(gradeFor(rows, { scheme, ignore: { 'Pre-Rec Quiz': true } }).pct, 27.5 / 50 * 100, 'a row left out');
  near(needFor(80, g).need, (0.8 * 215 - 35.5) / (215 - 65) * 100);
});

// the shapes of real Brightspace gradebooks (names made generic): category totals sit next to their items and count
// work not graded yet as 0; they must not be counted again
test('category total rows are recognized and left out (sum of items, or named like the category)', () => {
  // points class: "Homework" is HW01+HW02+HW03 out of all 5; "Rec attendance" is the weekly rows; extra credit only adds
  const chm = [r('Math Review', 4, 5), r('Intro Survey (1 pt EC)', 0, 1), r('Homework', 27.5, 50), r('Rec attendance', 15, 70), r('Rec Worksheet', 0, 20),
    r('HW01_due_Sept_2', 8.5, 10), r('Wk 1 REC', 5, 5), r('Wk 2 REC', 0, 5), r('Wk 3 REC', 5, 5), r('Wk 4 REC', 5, 5), r('HW02_due_Sept_9 (3.1, 3.3)', 9, 10), r('HW03_due_Sept_16', 10, 10), r('Lec 3 EC', 0.5, 0.5)];
  const chmScheme = { type: 'points', components: [['Math Review', 5], ['Homework', 130], ['Recitation Attendance', 50], ['Recitation Worksheet Completion/Upload', 45], ['Exams', 465]].map(([name, value]) => ({ name, value })) };
  const g1 = gradeFor(chm, { scheme: chmScheme });
  assert.deepEqual(g1.rows.filter(x => x.summary).map(x => x.name).sort(), ['Homework', 'Rec Worksheet', 'Rec attendance']);
  assert.equal(g1.rows.find(x => x.name === 'Rec Worksheet').component, 'Recitation Worksheet Completion/Upload', 'more words in common wins a tie');
  assert.equal(g1.rows.find(x => x.name === 'HW01_due_Sept_2').component, 'Homework', 'HW → homework');
  near(g1.pct, (4 + 27.5 + 15 + 0.5) / (5 + 30 + 20) * 100, 'extra credit adds to earned only');
  // weighted class: "Quizzes 8.89/100" is Brightspace's own average counting 8 ungraded quizzes as 0
  const ma = [r('Exam Agreement', 0, 100), r('Quizzes', 8.888888889, 100), r('Workshop Notes', 20, 100), r('Midterm Exams', 0, 0), r('Quiz 1', 8, 10), r('Workshop 1', 4, 5), r('Workshop 2', 5, 5), r('Workshop 3', 4, 5)];
  const maScheme = { type: 'weighted', components: [['Exam Agreement', 1], ['Quizzes', 15], ['Workshop Notes', 14], ['Midterm Exam 1', 15], ['Final Exam', 25]].map(([name, value]) => ({ name, value })) };
  const g2 = gradeFor(ma, { scheme: maScheme });
  assert.deepEqual(g2.rows.filter(x => x.summary).map(x => x.name).sort(), ['Exam Agreement', 'Quizzes', 'Workshop Notes']);
  near(g2.pct, (15 * 80 + 14 * (13 / 15 * 100)) / 29);
  // points class with sub-items: "Narrative 5/55" = Topic 2/2 + Framework 3/3; untouched assignments show as 0/total
  const com = [r('Chapter Quizzes - 101 F26', 35, 150), r('101 - Chapter 1 Quiz', 7, 10), r('101 - Chapter 3 Quiz', 9, 10), r('101 - Chapter 4 Quiz', 10, 10), r('101 - Chapter 5 Quiz', 0, 10), r('101 - Chapter 17 Quiz', 9, 10),
    r('Narrative', 4, 55), r('Narrative Topic', 2, 2), r('Narrative Framework', 2, 3), r('Explanation', 0, 105), r('Group', 0, 150)];
  const comScheme = { type: 'points', components: [['Narrative Presentation', 50], ['Explanation Presentation', 100], ['Group Presentation', 150], ['Quizzes', 150]].map(([name, value]) => ({ name, value })) };
  const g3 = gradeFor(com, { scheme: comScheme });
  assert.deepEqual(g3.rows.filter(x => x.summary).map(x => x.name).sort(), ['Chapter Quizzes - 101 F26', 'Explanation', 'Group', 'Narrative']);
  near(g3.pct, (35 + 4) / 55 * 100);
});

test('weighted: each category is its own average, weighted; ungraded categories wait', () => {
  const scheme = { type: 'weighted', components: [{ name: 'Quizzes', value: 15 }, { name: 'WebAssign', value: 15 }, { name: 'Midterm Exams', value: 40 }, { name: 'Final Exam', value: 30 }], scale: [] };
  const rows = [r('Quiz 1', 9, 10), r('Quiz 2', 7, 10), r('WebAssign 1', 18, 20), r('WebAssign 2', 20, 20), r('Midterm Exam 1', 82, 100), r('Final Exam', 0, 0)];
  const g = gradeFor(rows, { scheme });
  const have = 15 * 80 + 15 * 95 + 40 * 82;
  near(g.pct, have / 70); near(g.share, 0.7); assert.equal(g.letter, 'B');
  const need = needFor(83, g);
  assert.equal(need.on, 'Final Exam');
  near(need.need, (83 * 100 - have) / 30, 'what the final needs for a B');
  near(gradeFor(rows, { scheme }, { 'Midterm Exam 1': 100 }).pct, (15 * 80 + 15 * 95 + 40 * 100) / 70, 'what-if');
  near(gradeFor(rows, { scheme, assign: { 'Quiz 2': 'WebAssign' } }).categories.find(c => c.name === 'Quizzes').pct, 90, 'moved by hand');
  assert.deepEqual(gradeFor([...rows, r('Survey', 1, 1)], { scheme }).unassigned.map(x => x.name), ['Survey']);
});

test('no scheme: a simple points total, and "what do I need" is unknown', () => {
  const g = gradeFor([r('A', 8, 10), r('B', 0, 10)], {});
  assert.equal(g.basis, 'simple'); near(g.pct, 40); assert.equal(g.share, null);
  assert.equal(needFor(90, g), null);
  assert.equal(gradeFor([], {}).pct, null);
});

test('a saved grading setup is checked', () => {
  const ok = cleanGradeConfig({ scheme: { type: 'weighted', components: [{ name: ' Quizzes ', value: '15' }, { name: 'Final', value: 85 }], scale: [{ letter: 'A', min: 93 }, { letter: 'Z', min: 1 }], from: 'syllabus' }, assign: { 'Quiz 1': 'Quizzes', x: 5 }, ignore: { 'Lab 3': true, y: 'no' } });
  assert.deepEqual(ok, { scheme: { type: 'weighted', components: [{ name: 'Quizzes', value: 15 }, { name: 'Final', value: 85 }], scale: [{ letter: 'A', min: 93 }], from: 'syllabus' }, assign: { 'Quiz 1': 'Quizzes' }, ignore: { 'Lab 3': true } });
  assert.throws(() => cleanGradeConfig({ scheme: { type: 'vibes', components: [] } }), /weighted or points/);
  assert.throws(() => cleanGradeConfig({ scheme: { type: 'points', components: [{ name: '', value: 5 }] } }), /name/);
  assert.throws(() => cleanGradeConfig({ scheme: { type: 'points', components: [{ name: 'A', value: 5 }, { name: 'a', value: 1 }] } }), /same name/);
});
