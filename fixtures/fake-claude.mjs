// A fake `claude -p` for tests and demo mode: prints stream-json like the real CLI and keeps a small fake Google
// Calendar in FAKE_GCAL_STATE (a JSON file; created with made-up calendars around today on first use).
// FAKE_GCAL_MODE: ok | notloggedin | noconnector | wrongargs | refuse | skippage | persist | hang   (default ok)
// persist: like Claude Code with a large result, save it to a file under CLAUDE_CONFIG_DIR and show only a preview.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = 'mcp__claude_ai_Google_Calendar__';
const MODE = process.env.FAKE_GCAL_MODE || 'ok';
const FILE = process.env.FAKE_GCAL_STATE || path.join(os.tmpdir(), 'academic-dashboard-fake-gcal.json');
const PAGE = Number(process.env.FAKE_GCAL_PAGE) || 250;
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');


function seed() {
  const day = (n, h = 0, m = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); d.setHours(h, m); return d; };
  const iso = d => d.toISOString();
  const dateZ = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00Z`;
  const ev = (id, summary, s, e, extra = {}) => ({ id, summary, status: 'confirmed', start: { dateTime: iso(s) }, end: { dateTime: iso(e) }, htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`, ...extra });
  const events = { classes: [], clubs: [], holidays: [] };
  for (let n = -7; n <= 42; n++) {
    const w = day(n).getDay();
    if (w === 1 || w === 3 || w === 5) events.classes.push(ev(`lec_${n}`, 'MA 16100 Lecture', day(n, 10, 30), day(n, 11, 20), { location: 'BHEE 129', recurringEventId: 'lec' }));
    if (w === 2 || w === 4) events.classes.push(ev(`cs_${n}`, 'CS 15900 Lecture', day(n, 13, 30), day(n, 14, 20), { location: 'WALC 1055', recurringEventId: 'cs' }));
    if (w === 3) events.clubs.push(ev(`club_${n}`, 'Robotics Club meeting', day(n, 18), day(n, 19, 30), { location: 'ARMS 1010', description: 'Bring your <b>laptop</b>.' }));
  }
  events.classes.push(ev('mid1', 'CS 15900 Midterm 1', day(8, 19), day(8, 21), { location: 'ELLT 116' })); // same as the demo's Brightspace quiz → merges
  events.holidays.push({ id: 'break', summary: 'October Break', status: 'confirmed', start: { date: dateZ(day(16)) }, end: { date: dateZ(day(17)) } }); // the connector's all-day form: time part, inclusive end
  events.holidays.push({ id: 'fair', summary: 'Club fair', status: 'confirmed', start: { date: dateZ(day(10)) }, end: { date: dateZ(day(10)) } });
  return {
    calendars: [
      { id: 'classes@group.calendar.google.com', summary: 'Classes', timeZone: 'America/Indiana/Indianapolis' },
      { id: 'clubs@group.calendar.google.com', summary: 'Clubs', timeZone: 'America/Indiana/Indianapolis' },
      { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays in United States', timeZone: 'America/Indiana/Indianapolis' },
    ],
    events: { 'classes@group.calendar.google.com': events.classes, 'clubs@group.calendar.google.com': events.clubs, 'holidays@group.v.calendar.google.com': events.holidays },
  };
}
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { const s = seed(); fs.writeFileSync(FILE, JSON.stringify(s)); return s; } };
const store = s => fs.writeFileSync(FILE, JSON.stringify(s));

function main() {
  if (MODE === 'notloggedin') { process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); }
  const tools = MODE === 'noconnector' ? ['Bash', 'Read'] : ['list_calendars', 'list_events', 'create_event', 'update_event', 'delete_event'].map(t => T + t);
  const session = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  if (MODE === 'persist') { fs.mkdirSync(projectDir, { recursive: true }); fs.writeFileSync(path.join(projectDir, session + '.jsonl'), '{}\n'); }
  emit({ type: 'system', subtype: 'init', session_id: session, tools, mcp_servers: MODE === 'noconnector' ? [] : [{ name: 'claude.ai Google Calendar', status: 'connected' }] });
  if (MODE === 'noconnector') { emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'I do not have a Google Calendar tool.' }); return; }

  const name = (prompt.match(/Call the tool mcp__claude_ai_Google_Calendar__(\w+)/) || [])[1];
  let n = 0;
  const call = (tool, input, result, isError = false) => {
    const id = `toolu_${++n}`;
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: T + tool, input }] } });
    let content = isError ? String(result) : JSON.stringify(result);
    if (MODE === 'persist' && !isError) {
      const file = path.join(projectDir, session, 'tool-results', id + '.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
      content = `<persisted-output>
Output too large (${content.length} B). Full output saved to: ${file}

Preview (first 2KB):
${content.slice(0, 20)}
...
</persisted-output>`;
    }
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError || undefined }] } });
  };
  const db = load();
  const refuse = MODE === 'refuse';

  if (name === 'list_calendars') refuse ? call('list_calendars', {}, '403: The caller does not have permission', true) : call('list_calendars', {}, { calendars: db.calendars });
  else if (name === 'list_events') {
    const reqs = [...prompt.matchAll(/^\d+\. (\{.*\})$/gm)].map(m => JSON.parse(m[1]));
    for (const a of reqs) {
      const input = MODE === 'wrongargs' ? { ...a, calendarId: 'someone-else@gmail.com' } : a;
      if (refuse) { call('list_events', input, '403: The caller does not have permission', true); continue; }
      const from = new Date(a.startTime), to = new Date(a.endTime);
      const all = (db.events[a.calendarId] || []).filter(e => { const s = new Date(e.start.dateTime || e.start.date); return s >= from && s < to; });
      // one page per call, like the connector: the caller asks for the next one with pageToken
      const page = a.pageToken ? Number(a.pageToken.slice(1)) : 0;
      if (page && MODE === 'skippage') continue; // the model "forgets" the follow-up page
      const more = (page + 1) * PAGE < all.length;
      call('list_events', input, { events: all.slice(page * PAGE, (page + 1) * PAGE), ...(more ? { nextPageToken: `p${page + 1}` } : {}) });
    }
  } else {
    const a = JSON.parse((prompt.match(/unchanged: (\{.*\})\. Do not call/s) || [])[1] || '{}');
    const input = MODE === 'wrongargs' ? { ...a, calendarId: 'someone-else@gmail.com' } : a;
    if (refuse) call(name, input, '403: Forbidden', true);
    else if (name === 'create_event') {
      const e = { id: `new_${Date.now()}`, summary: a.summary, status: 'confirmed', location: a.location, description: a.description, htmlLink: 'https://calendar.google.com/calendar/event?eid=new',
        ...(a.allDay ? { start: { date: a.startTime.slice(0, 10) }, end: { date: a.endTime.slice(0, 10) } } : { start: { dateTime: a.startTime }, end: { dateTime: a.endTime } }) };
      (db.events[a.calendarId] ||= []).push(e); store(db);
      call(name, input, e);
    } else if (name === 'update_event') {
      const list = db.events[a.calendarId] || [];
      const e = list.find(x => x.id === a.eventId);
      if (!e) call(name, input, '404: Not Found', true);
      else {
        Object.assign(e, { summary: a.summary, location: a.location, description: a.description },
          a.allDay ? { start: { date: a.startTime.slice(0, 10) }, end: { date: a.endTime.slice(0, 10) } } : { start: { dateTime: a.startTime }, end: { dateTime: a.endTime } });
        store(db); call(name, input, e);
      }
    } else if (name === 'delete_event') {
      db.events[a.calendarId] = (db.events[a.calendarId] || []).filter(x => x.id !== a.eventId); store(db);
      call(name, input, '');
    }
  }
  emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'DONE' });
}

if (MODE === 'hang') setInterval(() => {}, 1e6);
else main();
