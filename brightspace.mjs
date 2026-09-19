// Fetches everything from brightspace-mcp-server (the same one Claude Code / Codex can use), over MCP stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { currentTerm, shouldFetch } from './logic.mjs';

const PKG = 'brightspace-mcp-server@latest';
// Windows-only: npx is npx.cmd, so it has to go through cmd. DASH_MCP_CMD (JSON array) swaps in a fake server for tests.
const MCP = process.env.DASH_MCP_CMD ? JSON.parse(process.env.DASH_MCP_CMD) : ['cmd', '/c', 'npx', '-y', PKG];
const COURSE_TIMEOUT = Number(process.env.DASH_COURSE_TIMEOUT) || 150_000;
const TOTAL_TIMEOUT = Number(process.env.DASH_TOTAL_TIMEOUT) || 4 * 60_000;
const AUTH_RE = /sign[- ]?in|log ?in|authenticat|mfa|credential|keychain|password|session (has )?expired|re-?auth|setup/i;

export class FetchError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // kind: 'auth' | 'network'
}

// npx starts node as a grandchild; closing stdio alone can leave it running, so kill the whole tree.
function killTree(pid) {
  if (pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
}

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: MCP[0], args: MCP.slice(1), stderr: 'pipe',
    env: { ...process.env, D2L_NO_UPDATE_CHECK: '1' },
  });
  const client = new Client({ name: 'academic-dashboard', version: '1.0.0' });
  const call = async (name, args, timeout = 60_000) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const text = (r.content || []).map(p => p.text || '').join('');
    if (r.isError) throw new FetchError(AUTH_RE.test(text) ? 'auth' : 'network', text.slice(0, 300) || `${name} failed`);
    try { return JSON.parse(text); } catch { throw new FetchError(AUTH_RE.test(text) ? 'auth' : 'network', text.slice(0, 300) || `${name}: empty reply`); }
  };
  // Hard stop: kills the server, which makes every pending call reject, so nothing is left running.
  let timedOut = false;
  let timer;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(transport.pid);
      transport.close().catch(() => {});
      reject(new FetchError('network', `Brightspace took longer than ${Math.round(TOTAL_TIMEOUT / 60000)} minutes`));
    }, TOTAL_TIMEOUT);
  });
  try {
    return await Promise.race([(async () => { await client.connect(transport); return fn(call); })(), stop]);
  } catch (e) {
    if (timedOut) throw new FetchError('network', `Brightspace took longer than ${Math.round(TOTAL_TIMEOUT / 60000)} minutes`);
    if (e instanceof FetchError) throw e;
    throw new FetchError(AUTH_RE.test(e.message) ? 'auth' : 'network', e.message);
  } finally {
    clearTimeout(timer);
    killTree(transport.pid);
    // close() can hang once the child is gone; never let it block.
    await Promise.race([client.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  }
}

// prev = last good raw data; a course whose call fails keeps prev's entry.
export function fetchAll(prev = {}) {
  return withClient(async call => {
    // Courses first: if this fails it's almost always sign-in.
    const courses = await call('get_my_courses', { activeOnly: false });
    if (!Array.isArray(courses)) throw new FetchError('network', 'Unexpected course list from Brightspace');
    const term = currentTerm(courses);
    const wanted = courses.filter(c => shouldFetch(c, term));
    const raw = { courses, assignments: {}, grades: {}, announcements: prev.announcements || [] };
    const failed = [];
    let authFailures = 0;

    await Promise.all([
      ...wanted.map(async c => {
        try { raw.assignments[c.id] = await call('get_assignments', { courseId: c.id }, COURSE_TIMEOUT); }
        catch (e) {
          // One course refusing (e.g. a closed club site) must not look like an expired login.
          if (e.kind === 'auth') authFailures++;
          failed.push(c.id);
          if (prev.assignments?.[c.id]) raw.assignments[c.id] = prev.assignments[c.id];
        }
      }),
      ...wanted.map(async c => {
        try { raw.grades[c.id] = await call('get_my_grades', { courseId: c.id }); }
        catch { if (prev.grades?.[c.id]) raw.grades[c.id] = prev.grades[c.id]; }
      }),
      (async () => { try { const a = await call('get_announcements', { count: 50 }); if (Array.isArray(a)) raw.announcements = a; } catch {} })(),
    ]);

    if (wanted.length && failed.length === wanted.length)
      throw new FetchError(authFailures === wanted.length ? 'auth' : 'network', authFailures === wanted.length ? 'Brightspace sign-in failed for every course' : 'No course responded in time');
    return { raw, failedCourses: failed };
  });
}

// Quick connection test for setup: lists courses only (a few seconds when signed in).
export function checkConnection() {
  return withClient(call => call('get_my_courses', { activeOnly: true }));
}

// Syllabus scan (optional feature): for each class, the course overview text plus up to 3 files whose titles look like
// a syllabus or schedule, downloaded into dir/<courseId>/. A class that fails just gets fewer sources.
// → { [courseId]: [{ name, text } | { name, file }] }
const SYLLABUS_TITLE = /syllab|course (schedule|information|info|calendar)|schedule of|class schedule/i;
export function fetchSyllabusSources(courseIds, dir) {
  return withClient(async call => {
    const out = {};
    for (const id of courseIds) {
      const sources = out[id] = [];
      try {
        const o = await call('get_syllabus', { courseId: id });
        const text = [o?.syllabusText, o?.description?.markdown].filter(Boolean).join('\n\n').trim();
        if (text.length > 40) sources.push({ name: 'Course overview (Brightspace)', text });
      } catch {}
      try {
        const topics = [];
        const walk = n => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.topicType === 'file' && SYLLABUS_TITLE.test(n.title || '')) topics.push(n); for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v); } };
        walk(await call('get_course_content', { courseId: id, maxDepth: 4 }));
        const target = path.join(dir, String(id));
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        for (const t of topics.slice(0, 3)) {
          const r = await call('download_file', { courseId: id, topicId: t.topicId || t.id, downloadPath: target }).catch(() => null);
          if (r?.filePath && fs.existsSync(r.filePath)) sources.push({ name: `${t.title} (Brightspace)`, file: r.filePath });
        }
      } catch {}
    }
    return out;
  });
}

// Opens a visible terminal for number-matching MFA. Only ever called from a user click.
export function openSignInWindow() {
  execFile('cmd', ['/c', 'start', 'Brightspace sign-in', 'cmd', '/k', `npx -y ${PKG} auth`]);
}
