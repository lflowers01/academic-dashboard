// Google Calendar bridge: reaches the user's Google Calendar through the Claude Google Calendar connector by
// launching a short headless `claude -p` run. The only file that knows about Claude. See spec-google-calendar.md §1.
//
// Safety: every run allows ONLY the tools that operation needs (sync = read-only), arguments are fixed by us,
// and the tool call Claude actually made is checked against what we asked before its result is trusted.
// Data is read from the tool results in the stream, never from Claude's own reply.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T = 'mcp__claude_ai_Google_Calendar__';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT = Number(process.env.DASH_GCAL_TIMEOUT) || 120_000;
// An empty working folder, so no project instructions (CLAUDE.md etc.) are loaded into the run.
const CWD = path.join(os.tmpdir(), 'academic-dashboard-gcal');
// Where Claude Code keeps this folder's session transcripts and large tool results.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECT_DIR = path.join(CLAUDE_DIR, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));

// Claude Code saves a large tool result to a file and shows the model only a 2 KB preview. We read the full
// result from that file: nothing is lost, and the model never reads the events (that's where the tokens went).
const PERSISTED = /^<persisted-output>[\s\S]*?saved to: (.+?\.txt)\s*$/m;
function fullResult(text) {
  const m = String(text).match(PERSISTED);
  if (!m) return text;
  const file = path.resolve(m[1]);
  if (!file.toLowerCase().startsWith(path.resolve(CLAUDE_DIR, 'projects').toLowerCase() + path.sep)) return text; // only Claude's own folder
  try { return fs.readFileSync(file, 'utf8'); } catch { return text; }
}
// Each run leaves a transcript (and saved results) with the user's events in it; remove this run's copy.
function forgetSession(out) {
  const id = String(out).match(/"session_id":"([0-9a-f-]{36})"/)?.[1];
  if (!id) return;
  fs.rmSync(path.join(PROJECT_DIR, id + '.jsonl'), { force: true });
  fs.rmSync(path.join(PROJECT_DIR, id), { recursive: true, force: true });
}

export class GcalError extends Error {
  // kind: 'no-claude' | 'no-connector' | 'auth' | 'agent' (didn't do what we asked) | 'google' (Google refused) | 'timeout'
  constructor(kind, message) { super(message); this.kind = kind; }
}

// ---------- finding claude ----------
let resolved = null;
function resolveClaude() {
  if (process.env.DASH_GCAL_CMD) return Promise.resolve(JSON.parse(process.env.DASH_GCAL_CMD)); // tests: a fake runner
  if (resolved) return Promise.resolve(resolved);
  return new Promise(resolve => execFile('where', ['claude'], { windowsHide: true }, (err, out) => {
    const first = String(out || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (err || !first) return resolve(null);
    resolved = /\.(cmd|bat)$/i.test(first) ? ['cmd', '/c', first] : [first];
    resolve(resolved);
  }));
}

// ---------- one headless run ----------
function killTree(pid) { if (pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); }

async function run({ prompt, tools, maxTurns }) {
  const cmd = await resolveClaude();
  if (!cmd) throw new GcalError('no-claude', 'Claude Code is not installed (the `claude` command was not found).');
  fs.mkdirSync(CWD, { recursive: true });
  // The prompt goes in through stdin, never the command line: it can hold text the user typed (event titles), and
  // with an npm-installed claude.cmd the command line passes through cmd.exe, where & | ^ would be special.
  const args = [...cmd.slice(1), '-p', '--model', MODEL, '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns), '--allowedTools', ['ToolSearch', ...tools.map(t => T + t)].join(','),
    '--settings', '{"disableAllHooks":true}', '--disable-slash-commands'];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], args, { cwd: CWD, env: { ...process.env, MAX_MCP_OUTPUT_TOKENS: '200000' }, // a full page (250 events) is ~85k tokens; the default 25k cap refuses it
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // it may exit before reading
    child.stdin.end(prompt);
    let out = '', errText = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; killTree(child.pid); reject(new GcalError('timeout', `Claude didn't finish within ${TIMEOUT / 1000} s.`)); } }, TIMEOUT);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errText += d; });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(new GcalError(e.code === 'ENOENT' ? 'no-claude' : 'agent', e.message)); } });
    child.on('close', () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { resolve(parseStream(out, errText)); } catch (e) { reject(e); } finally { try { forgetSession(out); } catch {} }
    });
  });
}

// stream-json → { calls: [{ id, name, input, result, resultText, isError }], cost, final }
export function parseStream(out, errText = '') {
  const lines = String(out).split(/\r?\n/).filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = lines.find(l => l.type === 'system' && l.subtype === 'init');
  const final = lines.find(l => l.type === 'result');
  if (!lines.length || !final) {
    const text = (errText || out || '').trim();
    if (/log ?in|not logged|authenticat|\/login|api key/i.test(text)) throw new GcalError('auth', 'Claude Code is not signed in. Run `claude` once in a terminal to sign in.');
    throw new GcalError('agent', `Claude didn't run: ${text.slice(0, 200) || 'no output'}`);
  }
  if (init) {
    const server = (init.mcp_servers || []).find(s => /google calendar/i.test(s.name));
    const hasTools = (init.tools || []).some(t => t.startsWith(T));
    if (!hasTools || (server && server.status !== 'connected'))
      throw new GcalError('no-connector', 'Google Calendar is not connected in Claude. In Claude (claude.ai → Settings → Connectors) connect Google Calendar, then try again.');
  }
  const calls = new Map();
  for (const l of lines) {
    for (const c of l.message?.content || []) {
      if (l.type === 'assistant' && c.type === 'tool_use' && c.name.startsWith(T)) calls.set(c.id, { id: c.id, name: c.name.slice(T.length), input: c.input || {} });
      if (l.type === 'user' && c.type === 'tool_result' && calls.has(c.tool_use_id)) {
        const text = fullResult(typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join(''));
        const call = calls.get(c.tool_use_id);
        call.resultText = text;
        call.isError = !!c.is_error;
        try { call.result = JSON.parse(text); } catch { call.result = null; }
      }
    }
  }
  if (final.is_error && final.subtype !== 'error_max_turns' && ![...calls.values()].some(c => c.result)) {
    const msg = String(final.result || final.subtype || 'error');
    if (/log ?in|authenticat/i.test(msg)) throw new GcalError('auth', 'Claude Code is not signed in. Run `claude` once in a terminal to sign in.');
    throw new GcalError('agent', `Claude reported an error: ${msg.slice(0, 200)}`);
  }
  return { calls: [...calls.values()], cost: Number(final.total_cost_usd) || 0 };
}

// A tool call that failed: Google's refusal, or Claude Code rejecting malformed arguments (kind 'invalid', retried once).
const malformed = call => !!call?.isError && /InputValidationError/.test(call.resultText || '');
const refused = call => new GcalError(malformed(call) ? 'invalid' : 'google',
  `Google Calendar refused: ${String(call.resultText || 'no result').slice(0, 200)}`);

// ---------- a tiny queue: one run at a time, writes before syncs ----------
const queue = [];
let busy = false;
function enqueue(priority, job) {
  return new Promise((resolve, reject) => {
    queue.push({ priority, job, resolve, reject });
    queue.sort((a, b) => b.priority - a.priority);
    pump();
  });
}
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { job, resolve, reject } = queue.shift();
  // A malformed tool call (Haiku occasionally sends broken JSON) is rejected by Claude Code before it reaches Google,
  // so running the job again is safe even for writes.
  try { resolve(await job().catch(e => (e.kind === 'invalid' ? job() : Promise.reject(e)))); } catch (e) { reject(e); } finally { busy = false; pump(); }
}
export const isBusy = () => busy || queue.length > 0;

const only = name => `Do not call any other tool. If the tool is not loaded yet, load it first with ToolSearch using the query "select:${T}${name}". When finished, reply with only the word DONE.`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function checkedCall(calls, name, expected, keys) {
  const call = calls.find(c => c.name === name && keys.every(k => same(c.input[k], expected[k])));
  if (!call) {
    const other = calls.find(c => c.name === name);
    if (malformed(other)) throw refused(other);
    throw new GcalError('agent', other ? `Claude called ${name} with different arguments than asked; nothing was trusted.` : `Claude didn't make the ${name} call.`);
  }
  if (call.isError || !call.result) throw refused(call);
  return call.result;
}

// ---------- operations ----------
export function listCalendars() {
  return enqueue(1, async () => {
    const { calls, cost } = await run({ prompt: `Call the tool ${T}list_calendars exactly once with arguments {}. ${only('list_calendars')}`, tools: ['list_calendars'], maxTurns: 5 });
    const r = checkedCall(calls, 'list_calendars', {}, []);
    return { calendars: (r.calendars || []).map(c => ({ id: c.id, summary: c.summary || c.id, timeZone: c.timeZone || null })), cost };
  });
}

// requests: [{ calendarId, startTime, endTime }] → { byCalendar: { id: rawEvents[] }, cost }
export function listEvents(requests) {
  return enqueue(1, async () => {
    // We follow page tokens ourselves (the model may only see a preview of a page): one run per round of pages.
    let pending = requests.map(r => ({ calendarId: r.calendarId, startTime: r.startTime, endTime: r.endTime, pageSize: 250, orderBy: 'startTime' }));
    const byCalendar = Object.fromEntries(pending.map(a => [a.calendarId, []]));
    let cost = 0;
    for (let round = 0; pending.length; round++) {
      if (round === 8) throw new GcalError('google', 'Google Calendar returned too many pages; try fewer calendars.');
      const prompt = `Call the tool ${T}list_events once for each of these argument objects, exactly as written (in parallel is fine):\n`
        + pending.map((a, n) => `${n + 1}. ${JSON.stringify(a)}`).join('\n') + `\n${only('list_events')}`;
      const r = await run({ prompt, tools: ['list_events'], maxTurns: 4 + pending.length * 2 });
      cost += r.cost;
      const next = [];
      for (const a of pending) {
        const call = r.calls.find(c => c.name === 'list_events' && ['calendarId', 'startTime', 'endTime', 'pageToken'].every(k => same(c.input[k], a[k])));
        if (!call) { const bad = r.calls.find(c => c.name === 'list_events' && malformed(c)); throw bad ? refused(bad) : new GcalError('agent', `Claude didn't read the calendar ${a.calendarId}.`); }
        if (call.isError || !call.result) throw refused(call);
        byCalendar[a.calendarId].push(...(call.result.events || []));
        if (call.result.nextPageToken) next.push({ ...a, pageToken: call.result.nextPageToken });
      }
      pending = next;
    }
    return { byCalendar, cost };
  });
}

// args are the connector's own fields (summary, startTime, endTime, allDay, location, description, calendarId, …)
export function createEvent(args) {
  return enqueue(2, async () => {
    const { calls, cost } = await run({ prompt: `Call the tool ${T}create_event exactly once with exactly these arguments, unchanged: ${JSON.stringify(args)}. ${only('create_event')}`, tools: ['create_event'], maxTurns: 5 });
    return { event: checkedCall(calls, 'create_event', args, ['calendarId', 'summary', 'startTime', 'endTime']), cost };
  });
}
export function updateEvent(args) {
  return enqueue(2, async () => {
    const { calls, cost } = await run({ prompt: `Call the tool ${T}update_event exactly once with exactly these arguments, unchanged: ${JSON.stringify(args)}. ${only('update_event')}`, tools: ['update_event'], maxTurns: 5 });
    return { event: checkedCall(calls, 'update_event', args, ['calendarId', 'eventId', 'summary', 'startTime', 'endTime']), cost };
  });
}
export function deleteEvent(args) {
  return enqueue(2, async () => {
    const { calls, cost } = await run({ prompt: `Call the tool ${T}delete_event exactly once with exactly these arguments, unchanged: ${JSON.stringify(args)}. ${only('delete_event')}`, tools: ['delete_event'], maxTurns: 5 });
    const call = calls.find(c => c.name === 'delete_event' && same(c.input.calendarId, args.calendarId) && same(c.input.eventId, args.eventId));
    if (!call) throw new GcalError('agent', "Claude didn't make the delete call.");
    if (call.isError) throw refused(call);
    return { ok: true, cost };
  });
}
