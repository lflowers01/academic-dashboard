import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanExternalRows, cleanExternalUrl } from './external-sync.mjs';

test('external assignment rows are sanitized, deduplicated and stable', () => {
  const body = { courseId: 1001, url: 'https://courses.catalystedu.com/app/course/example#x', rows: [
    { id: 'same', title: ' Lab 4   report ', due: '2026-09-30T03:59:00.000Z', status: 'Not started' },
    { id: 'same', title: 'duplicate', due: '2026-10-01T03:59:00.000Z' },
    { title: '', due: 'nope' },
  ] };
  const first = cleanExternalRows('labflow', body);
  const second = cleanExternalRows('labflow', body);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].title, 'Lab 4 report');
  assert.equal(first.rows[0].id, second.rows[0].id);
  assert.equal(first.rows[0].submitted, false);
});

test('only expected provider origins and valid course ids are accepted', () => {
  assert.equal(cleanExternalUrl('labflow', 'https://evil.example/course'), null);
  assert.equal(cleanExternalRows('macmillan', { courseId: 0, url: 'https://achieve.macmillanlearning.com/courses/a/mycourse', rows: [] }), null);
  assert.equal(cleanExternalUrl('pearson', 'https://mylab.pearson.com/Student/DoAssignments.aspx?view=all'), 'https://mylab.pearson.com/Student/DoAssignments.aspx?view=all');
  assert.equal(cleanExternalUrl('pearson', 'https://console.pearson.com/courses/1'), null);
});

test('explicit Macmillan and Pearson completion is submitted but Labflow Attempted is not', () => {
  const base = { courseId: 1, rows: [{ id: 'a', title: 'HW', due: '2026-09-24T03:59:00Z', status: 'Complete' }] };
  assert.equal(cleanExternalRows('macmillan', { ...base, url: 'https://achieve.macmillanlearning.com/courses/x/mycourse' }).rows[0].submitted, true);
  const pearson = cleanExternalRows('pearson', { ...base, url: 'https://mylab.pearson.com/Student/DoAssignments.aspx?view=all', rows: [{ ...base.rows[0], url: 'https://mylab.pearson.com/Student/IntegratedAssignmentOverview.aspx?homeworkId=123' }] });
  assert.equal(pearson.rows[0].submitted, true);
  assert.equal(pearson.rows[0].sourceUrl, 'https://mylab.pearson.com/Student/IntegratedAssignmentOverview.aspx?homeworkId=123');
  assert.equal(cleanExternalRows('labflow', { ...base, rows: [{ ...base.rows[0], status: 'Attempted' }], url: 'https://courses.catalystedu.com/app/course/1' }).rows[0].submitted, false);
});
