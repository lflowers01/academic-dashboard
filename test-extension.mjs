import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { providerUrl, validProviderSettings } from './chrome-extension/config.js';

test('provider course pages are recognized and normalized without user-specific defaults', () => {
  assert.deepEqual(providerUrl('https://courses.catalystedu.com/app/course/demo-course/'), {
    id: 'labflow', url: 'https://courses.catalystedu.com/app/course/demo-course',
  });
  assert.deepEqual(providerUrl('https://achieve.macmillanlearning.com/courses/demo-course/mycourse?view=assignments'), {
    id: 'macmillan', url: 'https://achieve.macmillanlearning.com/courses/demo-course/mycourse',
  });
  assert.deepEqual(providerUrl('https://mylab.pearson.com/Student/IntegratedAssignmentOverview.aspx?homeworkId=123'), {
    id: 'pearson', url: 'https://mylab.pearson.com/Student/DoAssignments.aspx?view=all',
  });
  assert.equal(providerUrl('https://example.com/course/123'), null);
});

test('provider setup requires its own URL and a positive dashboard course id', () => {
  assert.deepEqual(validProviderSettings('labflow', { url: 'https://courses.catalystedu.com/app/course/demo', courseId: '101' }), {
    url: 'https://courses.catalystedu.com/app/course/demo', courseId: 101,
  });
  assert.equal(validProviderSettings('pearson', { url: 'https://courses.catalystedu.com/app/course/demo', courseId: 101 }), null);
  assert.equal(validProviderSettings('labflow', { url: 'https://courses.catalystedu.com/app/course/demo', courseId: 0 }), null);
});

test('extension source contains no hard-coded course mapping or fixed Macmillan year', () => {
  const worker = fs.readFileSync(new URL('./chrome-extension/worker.js', import.meta.url), 'utf8');
  const macmillan = fs.readFileSync(new URL('./chrome-extension/scan-macmillan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /app\/course\/\d+|courses\/[0-9a-f-]{20,}\/mycourse|courseId:\s*\d+/i);
  assert.doesNotMatch(macmillan, /new Date\(2026\b/);
});
