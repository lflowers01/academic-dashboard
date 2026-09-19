// A fake `claude -p` for Smart Announcements in tests and demo mode: reads the announcements JSON from stdin and
// answers like the real CLI (--output-format json), finding dated sentences with the dashboard's own date parsing.
// FAKE_SMART_MODE: ok | invented (adds an event whose quote isn't in the text) | notloggedin | garbage | hang
import fs from 'node:fs';
import { findDate, findTimes } from '../logic.mjs';

const MODE = process.env.FAKE_SMART_MODE || 'ok';
if (MODE === 'hang') setInterval(() => {}, 1000);
else main();

function main() {
  const list = JSON.parse(fs.readFileSync(0, 'utf8') || '[]');
  if (MODE === 'notloggedin') { process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); }
  const reply = result => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.004, result }) + '\n');
  if (MODE === 'garbage') return reply('Sure! Here are the events I found: none really.');
  const pad = n => String(n).padStart(2, '0');
  const hm = ([h, m]) => `${pad(h)}:${pad(m)}`;
  const events = [];
  for (const a of list) {
    for (const quote of a.text.split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)) {
      const d = findDate(quote, a.posted);
      if (!d) continue;
      const t = findTimes(quote);
      const kind = /career|fair|workshop|club|company|research/i.test(quote) ? 'optional'
        : /review|supplemental/i.test(quote) ? 'review' : /exam|midterm/i.test(quote) ? 'exam'
        : /office hours|help room/i.test(quote) ? 'help' : /due|deadline|submit|complete/i.test(quote) ? 'deadline' : 'class-change';
      events.push({
        announcement: a.id, title: a.text.split('\n')[0].trim(), kind, // the announcement's title, as a model would shorten it
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        ...(t ? { start: hm(t.start) } : {}), ...(t?.end ? { end: hm(t.end) } : {}),
        location: (quote.match(/\bin ([A-Z]{2,5} \d{2,4}|the [A-Z][\w ]+)/) || [])[1] || '',
        quote, confidence: t ? 'high' : 'low', missing: t ? [] : ['time'],
      });
    }
  }
  if (MODE === 'invented' && list[0]) events.push({ announcement: list[0].id, title: 'HACKED', kind: 'exam', date: events[0]?.date || '2030-01-01', start: '10:00', quote: 'A sentence that is not in the announcement.', confidence: 'high', missing: [] });
  reply(`\`\`\`json\n${JSON.stringify({ events })}\n\`\`\``); // wrapped like a chatty model would, to exercise the parser
}
