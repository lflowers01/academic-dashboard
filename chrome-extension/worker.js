import { PROVIDER_IDS, validProviderSettings } from './config.js';

const DEFAULTS = { dashboard: 'http://localhost:4321', automatic: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = async () => {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get([...Object.keys(DEFAULTS), ...PROVIDER_IDS])) };
  if (PROVIDER_IDS.some(provider => validProviderSettings(provider, settings[provider]))) return settings;
  try {
    const previous = await fetch(`${settings.dashboard}/api/external`).then(response => response.json());
    const recovered = {};
    for (const provider of PROVIDER_IDS) {
      const value = validProviderSettings(provider, previous.providers?.[provider]);
      if (value) settings[provider] = recovered[provider] = value;
    }
    if (Object.keys(recovered).length) await chrome.storage.local.set(recovered);
  } catch {}
  return settings;
};

async function waitLoaded(tabId, timeout = 30000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(Error('page load timed out')); }, timeout);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function dashboardToken(base) {
  const response = await fetch(`${base}/api/external`);
  if (!response.ok) throw Error('dashboard is not running');
  const body = await response.json();
  if (!body.token) throw Error('dashboard did not provide a pairing token');
  return body.token;
}

async function scanProvider(provider, settings, token) {
  const wanted = validProviderSettings(provider, settings[provider]);
  if (!wanted) throw Error('not configured; open the course page and use the extension setup');
  let [tab] = await chrome.tabs.query({ url: `${wanted.url}*` });
  if (!tab) tab = await chrome.tabs.create({ url: wanted.url, active: false });
  await waitLoaded(tab.id);
  await sleep(1200);
  let scan;
  try { scan = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_ASSIGNMENTS' }); }
  catch { throw Error('scanner was not available; reload the course tab after installing the extension'); }
  if (!scan?.rows?.length) throw Error(scan?.error || 'no dated assignments found; sign in and open the course list');
  const response = await fetch(`${settings.dashboard}/api/external/${provider}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
    body: JSON.stringify({ ...scan, url: wanted.url, courseId: wanted.courseId }),
  });
  if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || `dashboard returned ${response.status}`);
  return (await response.json()).count;
}

async function reportError(provider, settings, token, error) {
  await fetch(`${settings.dashboard}/api/external/${provider}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
    body: JSON.stringify({ error: String(error?.message || error) }),
  }).catch(() => {});
}

async function syncAll() {
  const settings = await config();
  const result = {};
  const configured = PROVIDER_IDS.filter(provider => validProviderSettings(provider, settings[provider]));
  if (!configured.length) {
    for (const provider of PROVIDER_IDS) result[provider] = { ok: false, skipped: true, error: 'not configured' };
    await chrome.storage.local.set({ lastResult: result, lastSync: new Date().toISOString() });
    return result;
  }
  try {
    const token = await dashboardToken(settings.dashboard);
    for (const provider of PROVIDER_IDS) {
      if (!validProviderSettings(provider, settings[provider])) {
        result[provider] = { ok: false, skipped: true, error: 'not configured' };
        continue;
      }
      try { result[provider] = { ok: true, count: await scanProvider(provider, settings, token) }; }
      catch (error) { result[provider] = { ok: false, error: String(error.message || error) }; await reportError(provider, settings, token, error); }
    }
  } catch (error) { for (const provider of PROVIDER_IDS) result[provider] = { ok: false, error: String(error.message || error) }; }
  await chrome.storage.local.set({ lastResult: result, lastSync: new Date().toISOString() });
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('assignment-sync', { periodInMinutes: 180 });
});
chrome.runtime.onStartup.addListener(async () => { const c = await config(); if (c.automatic) syncAll(); });
chrome.alarms.onAlarm.addListener(async alarm => { const c = await config(); if (alarm.name === 'assignment-sync' && c.automatic) syncAll(); });
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'SYNC_NOW') return;
  syncAll().then(reply); return true;
});
