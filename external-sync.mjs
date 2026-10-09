import { randomBytes, createHash } from 'node:crypto';

export const EXTERNAL_PROVIDERS = new Set(['labflow', 'macmillan', 'pearson']);
const PROVIDER_NAMES = { labflow: 'Labflow', macmillan: 'Macmillan Achieve', pearson: 'Pearson MyLab' };
const ORIGINS = {
  labflow: 'https://courses.catalystedu.com',
  macmillan: 'https://achieve.macmillanlearning.com',
  pearson: 'https://mylab.pearson.com',
};

const cleanText = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function cleanExternalUrl(provider, value) {
  try {
    const url = new URL(String(value));
    if (url.origin !== ORIGINS[provider]) return null;
    url.hash = '';
    return url.href.slice(0, 1000);
  } catch { return null; }
}

export function cleanExternalRows(provider, body) {
  if (!EXTERNAL_PROVIDERS.has(provider) || !Array.isArray(body.rows) || body.rows.length > 500) return null;
  const courseId = Number(body.courseId);
  const sourceUrl = cleanExternalUrl(provider, body.url);
  if (!Number.isInteger(courseId) || courseId <= 0 || !sourceUrl) return null;
  const seen = new Set(), rows = [];
  for (const raw of body.rows) {
    const title = cleanText(raw?.title, 200);
    const due = new Date(raw?.due);
    if (!title || Number.isNaN(+due)) continue;
    const externalId = cleanText(raw.id || hash(`${title}|${due.toISOString()}`), 200);
    const id = `external:${provider}:${hash(`${sourceUrl}|${externalId}`)}`;
    const rowUrl = cleanExternalUrl(provider, raw?.url) || sourceUrl;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id, externalId, title, due: due.toISOString(), courseId, source: provider,
      sourceName: PROVIDER_NAMES[provider], sourceUrl: rowUrl,
      status: cleanText(raw.status, 80),
      submitted: (provider === 'macmillan' || provider === 'pearson') && /^complete(?:d)?$/i.test(cleanText(raw.status, 80)),
    });
  }
  return { courseId, url: sourceUrl, rows };
}

export function createExternalSync({ readJson, writeJson, log }) {
  const stored = readJson('external.json', {});
  let data = {
    token: typeof stored.token === 'string' && stored.token.length >= 32 ? stored.token : randomBytes(24).toString('hex'),
    automatic: stored.automatic !== false,
    providers: stored.providers && typeof stored.providers === 'object' ? stored.providers : {},
  };
  const save = () => writeJson('external.json', data);
  if (data.token !== stored.token) save();

  const payload = (includeToken = false) => ({
    automatic: data.automatic,
    providers: Object.fromEntries([...EXTERNAL_PROVIDERS].map(provider => [provider, {
      name: PROVIDER_NAMES[provider], scannedAt: data.providers[provider]?.scannedAt || null,
      error: data.providers[provider]?.error || null, count: data.providers[provider]?.rows?.length || 0,
      courseId: data.providers[provider]?.courseId || null, url: data.providers[provider]?.url || null,
    }])),
    ...(includeToken ? { token: data.token } : {}),
  });

  const items = () => Object.values(data.providers).flatMap(p => p?.rows || []).map(row => ({
    id: row.id, courseId: row.courseId, kind: 'assignment', exam: false, title: row.title,
    due: row.due, start: null, end: null, allDay: false, points: null, timeLimit: null,
    url: row.sourceUrl, instructions: `Imported from ${row.sourceName}${row.status ? ` · ${row.status}` : ''}`,
    submitted: !!row.submitted, graded: false, source: row.source, sourceName: row.sourceName,
  }));

  async function handle(req, res, path, { readBody, send }) {
    if (path === '/api/external' && req.method === 'GET') {
      const origin = String(req.headers.origin || '');
      return send(res, 200, payload(!origin || origin.startsWith('chrome-extension://') || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
    }
    if (!path.startsWith('/api/external/') || req.method !== 'POST') return false;
    if (req.headers['x-dashboard-token'] !== data.token) return send(res, 401, { error: 'invalid pairing token' });
    const provider = path.slice('/api/external/'.length);
    if (!EXTERNAL_PROVIDERS.has(provider)) return send(res, 404, { error: 'unknown provider' });
    const body = await readBody(req);
    if (body.error) {
      data.providers[provider] = { ...(data.providers[provider] || {}), error: cleanText(body.error, 300), attemptedAt: new Date().toISOString() };
      save(); log(`external ${provider}: ${data.providers[provider].error}`);
      return send(res, 200, { ok: true });
    }
    const clean = cleanExternalRows(provider, body);
    if (!clean || !clean.rows.length) return send(res, 400, { error: 'no valid dated assignments were found' });
    data.providers[provider] = { ...clean, scannedAt: new Date().toISOString(), error: null };
    save(); log(`external ${provider}: ${clean.rows.length} assignments`);
    return send(res, 200, { ok: true, count: clean.rows.length });
  }

  return { items, payload, handle };
}
