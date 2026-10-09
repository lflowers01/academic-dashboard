import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clubName, createSlack, eventFromSlack, slackDate } from './slack.mjs';
import { dayKey, isVisible } from './logic.mjs';

const later = new Date(); later.setDate(later.getDate() + 3);
const date = later.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const ts = String(Date.now() / 1000);

test('dated mentions become club events, unrelated messages do not', () => {
  const account = { teamId: 'T1', teamName: 'Purdue Orbital', userId: 'U1' };
  const message = { ts, text: `<@U1> Orbital meeting on ${date} at 6:00 PM in WALC.`, channel: { id: 'C1', name: 'general' }, permalink: 'https://purdue.slack.com/archives/C1/p123' };
  const event = eventFromSlack(message, account);
  assert.equal(event.club, 'Orbital');
  assert.equal(new Date(event.due).getHours(), 18);
  assert.equal(event.source, 'slack');
  assert.equal(eventFromSlack({ ...message, text: message.text.replace('<@U1>', '<@U2>') }, account), null);
  assert.equal(eventFromSlack({ ...message, text: '<@U1> please review the document' }, account), null);
  assert.equal(clubName('Student groups', 'per-events'), 'PER');
  const today = eventFromSlack({ ...message, text: '<!channel> Meeting locations for today from 7-9', ts }, account, new Date(0));
  assert.equal(dayKey(today.due), dayKey(new Date(Number(ts) * 1000)));
  assert.equal(slackDate('Meeting next Monday', new Date(2026, 9, 9)).getDate(), 12);
});

test('multiple Slack accounts sync separately and a disabled feature hides events', async () => {
  const state = { features: { slack: true } };
  let stored = {};
  const request = async (url, options) => {
    const user = options.headers.Authorization.includes('aaa') ? 'U1' : 'U2';
    const team = user === 'U1' ? 'T1' : 'T2';
    const name = user === 'U1' ? 'Purdue Orbital' : 'PER';
    const body = url.pathname.endsWith('auth.test')
      ? { ok: true, user_id: user, user: user, team_id: team, team: name }
      : { ok: true, messages: { matches: url.searchParams.get('count') === '1' ? [] : [url.searchParams.get('query').startsWith('channel ')
        ? { ts: String(Number(ts) + 1), text: '<!channel> Meeting tomorrow at 7:00 PM', channel: { id: `C${user}`, name: 'events' } }
        : { ts, text: `<@${user}> Meeting ${date} at 7:00 PM`, channel: { id: `C${user}`, name: 'events' }, permalink: `https://purdue.slack.com/archives/C${user}/p123` }], paging: { pages: 1 } } };
    return { ok: true, json: async () => body };
  };
  const slack = createSlack({ state, readJson: () => stored, writeJson: (_name, value) => { stored = structuredClone(value); }, log: () => {}, request,
    seal: s => `encrypted:${s}`, open: s => s.slice(10), claude: async () => ({ body: { event: null } }) });
  await assert.rejects(slack.connect('xoxb-bot-token'), /User OAuth Token.*xoxp-/);
  await slack.connect('xoxp-aaaaaaaaaaaaaaaaaaaa');
  await slack.connect('xoxp-bbbbbbbbbbbbbbbbbbbb');
  assert.equal(slack.payload().accounts.length, 2);
  assert.ok(stored.accounts.every(a => a.secret.startsWith('encrypted:')));
  assert.ok(!JSON.stringify(slack.payload()).includes('xoxp-'));
  await slack.sync();
  assert.deepEqual(slack.items().map(e => e.club).sort(), ['Orbital', 'Orbital', 'PER', 'PER']);
  assert.equal(slack.courses().length, 2);
  assert.ok(slack.courses().every(c => isVisible(c, slack.items(), { done: {} }, new Date(), '202710')));
  state.features.slack = false;
  assert.equal(slack.items().length, 0);
  state.features.slack = true;
  assert.equal(slack.disconnect('T1:U1'), true);
  assert.equal(slack.items().length, 2);
});

test('Codex connector messages import without a Slack app token', () => {
  const state = { features: { slack: true } };
  let stored = {};
  const slack = createSlack({ state, readJson: () => stored, writeJson: (_name, value) => { stored = structuredClone(value); }, log: () => {} });
  const message = { ts, text: '<!channel> Mark your calendars for a mix on November 21st.', channel: { id: 'C12345', name: 'mixing' }, permalink: 'https://purdueorbital.slack.com/archives/C12345/p123' };
  const importData = { teamId: 'T12345', teamName: 'Purdue Orbital', userId: 'U12345', messages: [message] };
  assert.deepEqual(slack.importMessages(importData), { added: 1 });
  assert.deepEqual(slack.importMessages(importData), { added: 1 });
  assert.equal(slack.items().length, 1);
  assert.equal(slack.items()[0].club, 'Orbital');
  assert.match(dayKey(slack.items()[0].due), /-11-21$/);
  assert.equal(slack.payload().accounts.length, 0);
  assert.equal(slack.payload().connectorAccounts[0].teamName, 'Purdue Orbital');
  assert.throws(() => slack.importMessages({ ...importData, userId: 'bad' }), /Invalid Slack import/);
});

test('Windows Slack notifications become club events without AI or tokens', async () => {
  const state = { features: { slack: true } };
  let stored = {};
  const row = { id: '1', arrival: '123456789', teamId: 'T12345', teamName: 'Purdue Electric Racing', channelId: 'C12345',
    channelName: '#software', ts, text: 'Alex: @channel Software meeting tomorrow at 7:00 PM', url: 'slack://channel?id=C12345&message=123&team=T12345' };
  const slack = createSlack({ state, readJson: () => stored, writeJson: (_name, value) => { stored = structuredClone(value); }, log: () => {}, notifications: async () => [row] });
  assert.deepEqual(await slack.scanWindows(), { added: 1 });
  assert.deepEqual(await slack.scanWindows(), { added: 0 });
  assert.equal(slack.items()[0].club, 'PER');
  assert.match(slack.items()[0].url, /^slack:\/\/channel\?/);
  assert.equal(slack.payload().notificationAccounts[0].teamName, 'Purdue Electric Racing');
  assert.equal(eventFromSlack({ text: '<@WINDOWS> No meeting tomorrow', ts, channel: { id: 'C12345' } }, { userId: 'WINDOWS', teamId: 'T12345' }), null);
  state.features.slack = false;
  assert.deepEqual(await slack.scanWindows(), { added: 0 });
});
