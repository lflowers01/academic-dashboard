import { PROVIDERS, PROVIDER_IDS, providerUrl, validProviderSettings } from './config.js';

const dashboard = 'http://localhost:4321';
const status = document.querySelector('#status');
const providerRoot = document.querySelector('#providers');
const automatic = document.querySelector('#automatic');
const controls = {};
let courses = [];

const setStatus = (message, good = null) => {
  status.textContent = message;
  status.className = good === true ? 'ok' : good === false ? 'bad' : '';
};

function courseLabel(course) {
  return course.short || course.name || course.code || `Course ${course.id}`;
}

function fillCourseSelect(select, selected) {
  select.replaceChildren(new Option('Choose dashboard course…', ''));
  for (const course of courses) select.append(new Option(courseLabel(course), String(course.id)));
  select.value = selected ? String(selected) : '';
}

function drawProvider(id, saved) {
  const provider = PROVIDERS[id];
  const box = document.createElement('section');
  box.className = 'provider';
  const name = document.createElement('strong');
  name.textContent = provider.name;
  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = saved?.url || provider.example;
  url.title = saved?.url || '';
  const row = document.createElement('div');
  row.className = 'row';
  const select = document.createElement('select');
  select.className = 'course';
  select.setAttribute('aria-label', `${provider.name} dashboard course`);
  fillCourseSelect(select, saved?.courseId);
  const useTab = document.createElement('button');
  useTab.type = 'button';
  useTab.className = 'secondary';
  useTab.textContent = 'Use current tab';
  useTab.onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const found = providerUrl(tab?.url);
    if (found?.id !== id) return setStatus(`${provider.example} first.`, false);
    url.textContent = found.url;
    url.title = found.url;
    controls[id].url = found.url;
    setStatus(`Captured ${provider.name}. Now choose its dashboard course.`);
  };
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'secondary';
  clear.textContent = 'Clear';
  clear.onclick = () => { controls[id].url = ''; url.textContent = provider.example; url.title = ''; select.value = ''; };
  row.append(select, useTab, clear);
  box.append(name, url, row);
  providerRoot.append(box);
  controls[id] = { url: saved?.url || '', select };
}

async function load() {
  const saved = await chrome.storage.local.get(['automatic', ...PROVIDER_IDS]);
  automatic.checked = saved.automatic !== false;
  try {
    const [dataResponse, externalResponse] = await Promise.all([
      fetch(`${dashboard}/api/external/courses`),
      fetch(`${dashboard}/api/external`),
    ]);
    if (!dataResponse.ok || !externalResponse.ok) throw Error();
    const data = await dataResponse.json();
    const external = await externalResponse.json();
    courses = (data.courses || []).filter(course => Number(course.id) > 0);
    if (!courses.length) throw Error();
    const recovered = {};
    for (const id of PROVIDER_IDS) {
      const existing = validProviderSettings(id, saved[id]);
      const previous = validProviderSettings(id, external.providers?.[id]);
      if (!existing && previous) saved[id] = recovered[id] = previous;
    }
    if (Object.keys(recovered).length) await chrome.storage.local.set(recovered);
  } catch {
    setStatus('Start the dashboard and refresh Brightspace before setup.', false);
  }
  for (const id of PROVIDER_IDS) drawProvider(id, validProviderSettings(id, saved[id]));
  if (courses.length) setStatus('Ready. Configure any providers you use.');
}

async function save() {
  const update = { automatic: automatic.checked };
  let configured = 0;
  for (const id of PROVIDER_IDS) {
    const raw = { url: controls[id].url, courseId: Number(controls[id].select.value) };
    const valid = validProviderSettings(id, raw);
    if ((raw.url || raw.courseId) && !valid) throw Error(`${PROVIDERS[id].name}: capture its course tab and choose a dashboard course`);
    update[id] = valid;
    if (valid) configured++;
  }
  if (!configured) throw Error('Configure at least one provider first');
  await chrome.storage.local.set(update);
  const enabled = await fetch(`${dashboard}/api/state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features: { externalAssignments: true } }),
  });
  if (!enabled.ok) throw Error('Dashboard could not enable external assignments');
  return configured;
}

function showResult(result) {
  const active = PROVIDER_IDS.filter(id => !result[id]?.skipped);
  const lines = active.map(id => {
    const value = result[id];
    return `${PROVIDERS[id].name}: ${value?.ok ? `${value.count} assignments` : value?.error || 'failed'}`;
  });
  const ok = active.length > 0 && active.every(id => result[id]?.ok);
  setStatus(lines.join('\n') || 'No providers configured.', ok);
}

document.querySelector('#save').onclick = async () => {
  try {
    const count = await save();
    setStatus(`Saved ${count} provider configuration${count === 1 ? '' : 's'}.`, true);
  } catch (error) { setStatus(error.message, false); }
};

document.querySelector('#sync').onclick = async () => {
  try {
    await save();
    setStatus('Scanning signed-in course pages…');
    showResult(await chrome.runtime.sendMessage({ type: 'SYNC_NOW' }));
  } catch (error) { setStatus(error.message, false); }
};

load();
