// A fake `claude -p` for Syllabus scan in tests and demo mode: reads {course, year, today, text} from stdin and answers
// like the real CLI, finding dated sentences and "Name NN%" / "Name NNN points" grading lines with plain parsing.
// FAKE_SYLLABUS_MODE: ok | invented (adds an event and a grading part that aren't in the text) | notloggedin | hang
import fs from 'node:fs';
import { findDate, findTimes } from '../logic.mjs';

const MODE = process.env.FAKE_SYLLABUS_MODE || 'ok';
if (MODE === 'hang') setInterval(() => {}, 1000);
else main();

function main() {
  const { text = '', today } = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (MODE === 'notloggedin') { process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); }
  const pad = n => String(n).padStart(2, '0');
  const hm = ([h, m]) => `${pad(h)}:${pad(m)}`;
  const events = [];
  for (const quote of text.split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)) {
    if (/^=== /.test(quote) || /%|points/i.test(quote)) continue;
    const d = findDate(quote, today);
    if (!d) continue;
    const t = findTimes(quote);
    const kind = /no class|cancel|break/i.test(quote) ? 'class-change' : /exam|midterm|quiz/i.test(quote) ? 'exam' : /due|deadline|submit/i.test(quote) ? 'deadline' : 'optional';
    events.push({ title: quote.split(/\s+(is|are|will)\b/)[0].slice(0, 60), kind, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      ...(t ? { start: hm(t.start) } : {}), ...(t?.end ? { end: hm(t.end) } : {}), quote,
      confidence: kind === 'exam' && !t ? 'low' : 'high', missing: kind === 'exam' && !t ? ['time'] : [] });
  }
  const pct = [...text.matchAll(/([A-Z][A-Za-z ]+?) (\d{1,3})%/g)].map(m => ({ name: m[1].trim(), weight: +m[2], quote: m[0] }));
  const pts = [...text.matchAll(/([A-Z][A-Za-z ]+?) (\d{1,4}) points/g)].map(m => ({ name: m[1].trim(), points: +m[2], quote: m[0] }));
  const grading = pct.length ? { type: 'weighted', components: pct, scale: [] } : pts.length ? { type: 'points', components: pts, scale: [] } : { type: null, components: [], scale: [] };
  if (MODE === 'invented') {
    events.push({ title: 'HACKED', kind: 'exam', date: events[0]?.date || '2030-01-01', start: '10:00', quote: 'This sentence is not in the syllabus at all.', confidence: 'high', missing: [] });
    grading.components.push({ name: 'Made up', weight: 50, points: 50, quote: 'Made up category worth half' });
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: JSON.stringify({ events, grading }) }) + '\n');
}
