// In-app updates (always on): notices a newer GitHub release and installs it on request. See spec-next-features.md §1.
//
// Check: the GitHub releases API once a day (60 requests/hour unauthenticated is plenty). Install: download the release
// zip (GitHub hosts only), check it's the version it claims, back up the current files, copy the new ones over
// (data/ and node_modules/ are never touched), `npm install` only if the lockfile changed, restart.
// A git checkout (a developer's folder) is never updated in place.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.DASH_UPDATE_API || 'https://api.github.com/repos/lflowers01/academic-dashboard/releases/latest';
const CHECK_EVERY = 24 * 3600_000;
const HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
if (process.env.DASH_UPDATE_API) HOSTS.add(new URL(process.env.DASH_UPDATE_API).host); // tests: a local fake
const MAX_ZIP = 20 * 1024 * 1024;

// "1.10.0" > "1.9.3"
export function newer(a, b) {
  const p = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// fetch that follows redirects itself, only to allowed hosts
async function get(url, init = {}) {
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(process.env.DASH_UPDATE_API && u.protocol === 'http:')) throw new Error(`refusing ${u.protocol} download`);
    if (!HOSTS.has(u.host)) throw new Error(`refusing to download from ${u.host}`);
    const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'academic-dashboard', ...(init.headers || {}) } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue; }
    if (!r.ok) throw new Error(`${u.host} answered ${r.status}`);
    return r;
  }
  throw new Error('too many redirects');
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err && !opts.ok?.(err) ? reject(Object.assign(err, { stderr })) : resolve(stdout))));
// robocopy: exit codes below 8 mean success (1 = files copied)
const robocopy = (from, to, extra = []) => run('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1', ...extra], { ok: e => e.code < 8 });
const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

export function createUpdater({ root, dataDir, readJson, writeJson, log, onRestart }) {
  const version = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const isGit = fs.existsSync(path.join(root, '.git'));
  let info = { checkedAt: null, latest: null, notes: '', asset: null, url: null, error: null, ...readJson('update.json', {}) };
  let job = null; // { step, error } while installing

  async function check(reason = 'scheduled') {
    try {
      const j = await (await get(API, { headers: { Accept: 'application/vnd.github+json' } })).json();
      const asset = (j.assets || []).find(a => a.name === 'academic-dashboard.zip');
      info = { checkedAt: new Date().toISOString(), latest: String(j.tag_name || '').replace(/^v/, '') || null, notes: String(j.body || '').slice(0, 8000),
        asset: asset?.browser_download_url || null, url: j.html_url || null, error: null };
      if (newer(info.latest, version())) log(`update (${reason}): v${info.latest} is available (running v${version()})`);
    } catch (e) {
      info = { ...info, checkedAt: new Date().toISOString(), error: String(e.message).slice(0, 200) };
    }
    writeJson('update.json', info);
    return info;
  }
  const tick = () => { if (!job && (!info.checkedAt || Date.now() - new Date(info.checkedAt) >= CHECK_EVERY)) check(); };

  async function install() {
    const target = info.latest, from = version();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-update-'));
    const step = s => { job.step = s; log(`update: ${s}`); };
    const backup = path.join(dataDir, `backup-v${from}`);
    let copied = false;
    try {
      step('Downloading');
      const r = await get(info.asset);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ZIP) throw new Error('the download is too big');
      const zip = path.join(tmp, 'update.zip');
      fs.writeFileSync(zip, buf);

      step('Checking');
      // paths go to PowerShell through the environment, never through the command text
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DASH_ZIP -DestinationPath $env:DASH_OUT -Force'],
        { env: { ...process.env, DASH_ZIP: zip, DASH_OUT: path.join(tmp, 'x') } });
      const src = path.join(tmp, 'x', 'academic-dashboard');
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
      if (pkg.version !== target) throw new Error(`the download says it is v${pkg.version}, not v${target}`);
      if (!fs.existsSync(path.join(src, 'server.mjs'))) throw new Error('the download is not a dashboard release');

      step('Installing');
      fs.rmSync(backup, { recursive: true, force: true });
      await robocopy(root, backup, ['/XD', path.join(root, 'data'), path.join(root, 'node_modules'), path.join(root, '.git')]);
      const lockChanged = !sameFile(path.join(src, 'package-lock.json'), path.join(root, 'package-lock.json'));
      copied = true;
      await robocopy(src, root, ['/XD', 'data', 'node_modules']);
      if (lockChanged) await run('cmd', ['/c', 'npm', 'install', '--no-fund', '--no-audit'], { cwd: root, timeout: 5 * 60_000 });

      step('Restarting');
      log(`update: v${from} → v${target} installed (backup in ${backup})`);
      onRestart();
    } catch (e) {
      log(`update to v${target} failed: ${e.message}`);
      if (copied) { await robocopy(backup, root).catch(() => {}); log('update: previous version restored'); }
      job.error = copied ? `${e.message}. Your previous version was restored.` : e.message;
      job.step = null;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function handle(req, res, p, { send }) {
    if (p === '/api/update/check' && req.method === 'POST') { await check('manual'); send(res, 200, payload()); return true; }
    if (p === '/api/update' && req.method === 'POST') {
      if (isGit) { send(res, 409, { error: 'This folder is a git checkout; update it with git pull.' }); return true; }
      if (!newer(info.latest, version()) || !info.asset) { send(res, 409, { error: 'There is no newer version to install.' }); return true; }
      if (job?.step) { send(res, 409, { error: 'Already updating.' }); return true; }
      job = { step: 'Starting', error: null, to: info.latest };
      install();
      send(res, 202, { ok: true }); return true;
    }
    return false;
  }

  const payload = () => ({
    current: version(), latest: info.latest, available: newer(info.latest, version()), notes: info.notes, url: info.url,
    checkedAt: info.checkedAt, error: info.error, canInstall: !isGit && !!info.asset, git: isGit, job,
  });
  return { check, tick, handle, payload, available: () => newer(info.latest, version()) ? info.latest : null };
}

// Restart: start a new server that waits for the port, then this one exits.
export function restartServer(root, closeServer) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, DASH_WAIT_PORT: '1' } });
  child.unref();
  closeServer(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
