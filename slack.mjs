// Optional Slack mention sync. Each account is authorized once; workspaces/channels supply club names automatically.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { askClaude } from './claude-json.mjs';
import { addDays, dayKey, featureOn, findDate, findTimes } from './logic.mjs';

const EVENT_WORD = /\b(meet(?:ing)?|event|workshop|social|practice|rehearsal|training|session|presentation|competition|volunteer|fundraiser|dinner|lunch|party|orientation|deadline|due)\b/i;
const SLACK_API = 'https://slack.com/api/';
const CLUB_WORDS = /\b(orbital|per)\b/i;
const GROUP_PING = /<!(?:channel|here|everyone)(?:\|[^>]+)?>/;
const localDate = (date, hm) => { const d = new Date(date); d.setHours(hm?.[0] ?? 23, hm?.[1] ?? 59, 0, 0); return d; };
const hashId = s => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 7), 16);
const cleanSlack = s => String(s || '').replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '').replace(/<!(?:channel|here|everyone)(?:\|[^>]+)?>/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/\s+/g, ' ').trim();
const mentioned = (text, userId) => text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`) || GROUP_PING.test(text);
export function slackDate(text, posted) {
  const explicit = findDate(text, posted);
  if (explicit) return explicit;
  if (/\btoday\b/i.test(text)) return new Date(posted);
  if (/\btomorrow\b/i.test(text)) return addDays(posted, 1);
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const word = text.match(/\b(?:(next|this)\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  if (!word) return null;
  const day = weekdays.findIndex(x => x.startsWith(word[2].toLowerCase().slice(0, 3)));
  let offset = (day - posted.getDay() + 7) % 7;
  if (word[1]?.toLowerCase() === 'next' && offset === 0) offset = 7;
  return addDays(posted, offset);
}

export function clubName(team, channel) {
  const match = String(channel || '').match(CLUB_WORDS) || String(team || '').match(CLUB_WORDS);
  return match ? (match[1].toLowerCase() === 'per' ? 'PER' : 'Orbital') : String(team || channel || 'Club').slice(0, 60);
}

export function eventFromSlack(message, account, now = new Date()) {
  const raw = String(message?.text || '');
  if (!mentioned(raw, account.userId)) return null;
  const posted = new Date(Number(message.ts) * 1000);
  if (Number.isNaN(+posted)) return null;
  const date = slackDate(raw, posted);
  if (!date || date < addDays(posted, -2) || date > addDays(posted, 300)) return null;
  const times = findTimes(raw);
  if (!EVENT_WORD.test(raw) && !times) return null;
  const due = localDate(date, times?.start);
  if (due < now) return null;
  const title = cleanSlack(raw.split(/\n/).find(line => EVENT_WORD.test(line)) || raw).slice(0, 120);
  const club = clubName(account.teamName, message.channel?.name);
  return { id: `slack:${account.teamId}:${message.channel?.id}:${message.ts}`, courseId: -hashId(`${account.teamId}:${club}`),
    kind: 'event', source: 'slack', club, title: title || `${club} event`, due: due.toISOString(),
    end: times?.end ? localDate(date, times.end).toISOString() : null, allDay: !times,
    start: null, points: null, timeLimit: null, url: /^https:\/\/[^/]+\.slack\.com\/archives\//.test(message.permalink || '') ? message.permalink : null,
    instructions: cleanSlack(raw).slice(0, 2000), submitted: false, graded: false };
}

// Windows DPAPI keeps Slack tokens readable only by this Windows user. The token is passed in an environment variable,
// never interpolated into PowerShell code or logged.
const protect = token => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:DASH_SLACK_TOKEN),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'],
  { env: { ...process.env, DASH_SLACK_TOKEN: token }, windowsHide: true, encoding: 'utf8' }).trim();
const unprotect = value => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:DASH_SLACK_SECRET),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'],
  { env: { ...process.env, DASH_SLACK_SECRET: value }, windowsHide: true, encoding: 'utf8' }).trim();

export function createSlack({ state, readJson, writeJson, log, request = fetch, seal = protect, open = unprotect, claude = askClaude }) {
  const store = { accounts: [], events: [], seen: {}, ...readJson('slack.json', {}) };
  let running = false, lastRun = null, lastError = null, lastTick = 0, claudeUnavailableUntil = 0;
  const on = () => featureOn(state, 'slack');
  const save = () => writeJson('slack.json', store);
  async function api(token, method, params = {}) {
    const url = new URL(method, SLACK_API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await request(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(`Slack ${method}: ${body.error || res.status}`);
    return body;
  }
  async function connect(token) {
    if (!/^xoxp-[A-Za-z0-9-]{20,}$/.test(token)) throw new Error('Use a Slack user token with search:read permission.');
    const identity = await api(token, 'auth.test');
    if (!identity.user_id || !identity.team_id) throw new Error('Slack did not identify this account.');
    await api(token, 'search.messages', { query: `<@${identity.user_id}> after:${dayKey(addDays(new Date(), -1))}`, count: 1 });
    const id = `${identity.team_id}:${identity.user_id}`;
    const account = { id, teamId: identity.team_id, teamName: identity.team || 'Slack', userId: identity.user_id,
      userName: identity.user || '', secret: seal(token), error: null };
    store.accounts = [...store.accounts.filter(a => a.id !== id), account];
    save();
    return { id, team: account.teamName, user: account.userName };
  }
  function disconnect(id) {
    const before = store.accounts.length;
    store.accounts = store.accounts.filter(a => a.id !== id);
    store.events = store.events.filter(e => e.accountId !== id);
    if (store.accounts.length === before) return false;
    save(); return true;
  }
  async function modelEvent(message, account) {
    if (Date.now() < claudeUnavailableUntil) return null;
    try {
      const { body } = await claude({ name: 'slack', cmdVar: 'DASH_SLACK_CMD', timeout: 45_000,
        system: 'Extract one upcoming club event from a Slack message. Return JSON {event:{title,date,start,end,quote}} or {event:null}. date YYYY-MM-DD, times HH:MM 24-hour or null. Quote must be an exact substring of the message. No tools. Ignore non-events.',
        input: { today: dayKey(new Date()), posted: new Date(Number(message.ts) * 1000).toISOString(), text: message.text } });
      const e = body.event;
      if (!e || typeof e.quote !== 'string' || e.quote.length < 8 || !message.text.includes(e.quote) || !/^\d{4}-\d\d-\d\d$/.test(e.date || '')) return null;
      const date = new Date(`${e.date}T12:00:00`);
      if (dayKey(date) !== e.date || date < addDays(new Date(), -1) || date > addDays(new Date(), 300)) return null;
      const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(e.start || '') ? e.start.split(':').map(Number) : null;
      const base = eventFromSlack({ ...message, text: `<@${account.userId}> Event on ${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` }, account, new Date(0));
      if (!base) return null;
      const due = localDate(date, hm);
      if (due < new Date()) return null;
      return { ...base, title: cleanSlack(e.title).slice(0, 120) || base.title, instructions: cleanSlack(message.text).slice(0, 2000), due: due.toISOString(), allDay: !hm,
        end: /^([01]\d|2[0-3]):[0-5]\d$/.test(e.end || '') ? localDate(date, e.end.split(':').map(Number)).toISOString() : null };
    } catch (e) { claudeUnavailableUntil = Date.now() + 6 * 3600_000; log(`slack: Claude unavailable (${e.kind || 'error'}); using date parser`); return null; }
  }
  async function sync() {
    if (!on() || running) return;
    running = true; lastTick = Date.now();
    try {
      for (const account of store.accounts) {
        try {
          const token = open(account.secret);
          const after = dayKey(addDays(new Date(), -14));
          let modelCalls = 0;
          for (const term of [`<@${account.userId}>`, 'channel', 'here', 'everyone']) {
          let page = 1;
          while (page <= 10) {
            const result = await api(token, 'search.messages', { query: `${term} after:${after}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
            const matches = result.messages?.matches || [];
            for (const message of matches) {
              if (!mentioned(String(message.text || ''), account.userId)) continue;
              const id = `slack:${account.teamId}:${message.channel?.id}:${message.ts}`;
              const fingerprint = createHash('sha256').update(String(message.text)).digest('hex');
              if (store.seen[id] === fingerprint) continue;
              let event = eventFromSlack(message, account);
              if (!event && modelCalls < 10 && Date.now() >= claudeUnavailableUntil) { modelCalls++; event = await modelEvent(message, account); }
              if (!event && modelCalls >= 10 && Date.now() >= claudeUnavailableUntil) continue;
              store.events = store.events.filter(e => e.id !== id);
              if (event) store.events.push({ ...event, accountId: account.id });
              if (Date.now() >= claudeUnavailableUntil) store.seen[id] = fingerprint;
            }
            if (matches.length < 100 || page >= (result.messages?.paging?.pages || 1)) break;
            page++;
          }
          }
          account.error = null; account.syncedAt = new Date().toISOString();
          save();
        } catch (e) { account.error = String(e.message).slice(0, 160); log(`slack sync failed for ${account.teamName}: ${account.error}`); save(); }
      }
      store.events = store.events.filter(e => new Date(e.due) >= addDays(new Date(), -14));
      if (Object.keys(store.seen).length > 5000) store.seen = Object.fromEntries(Object.entries(store.seen).slice(-3000));
      save(); lastError = null;
    } catch (e) { lastError = String(e.message).slice(0, 160); }
    finally { running = false; lastRun = new Date().toISOString(); }
  }
  return { connect, disconnect, sync, tick: () => { if (on() && !running && Date.now() - lastTick > 5 * 60_000) sync(); },
    items: () => on() ? store.events : [],
    courses: () => on() ? [...new Map(store.events.map(e => [e.courseId, { id: e.courseId, name: `Club · ${e.club}`, short: e.club, code: `club.${e.club}` }])).values()] : [],
    payload: () => on() ? { running, lastRun, lastError, accounts: store.accounts.map(({ id, teamName, userName, syncedAt, error }) => ({ id, teamName, userName, syncedAt, error })) } : null };
}
