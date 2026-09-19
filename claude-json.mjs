// Asks Claude (headless `claude -p`, Haiku) to read untrusted text and answer with JSON. Shared by Smart Announcements
// and Syllabus scan. The model gets NO tools, its instructions go in a file, the text goes in through stdin (never a
// command line, which passes through cmd.exe for an npm-installed claude.cmd), and extended thinking is off (it made
// runs ~10x slower). Callers must still check everything the model says against the text itself.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = 'claude-haiku-4-5-20251001';

export class ClaudeError extends Error {
  // kind: 'no-claude' | 'auth' | 'agent' | 'timeout'
  constructor(kind, message) { super(message); this.kind = kind; }
}

const resolved = new Map();
function resolveClaude(cmdVar) {
  if (process.env[cmdVar]) return Promise.resolve(JSON.parse(process.env[cmdVar])); // tests: a fake runner
  if (resolved.has('claude')) return Promise.resolve(resolved.get('claude'));
  return new Promise(resolve => execFile('where', ['claude'], { windowsHide: true }, (err, out) => {
    const first = String(out || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (err || !first) return resolve(null);
    const cmd = /\.(cmd|bat)$/i.test(first) ? ['cmd', '/c', first] : [first];
    resolved.set('claude', cmd);
    resolve(cmd);
  }));
}
const killTree = pid => { if (pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); };

// `claude -p --output-format json` output → { body (the JSON object in the model's reply), cost }
export function parseJsonReply(out, errText = '') {
  let j;
  try { j = JSON.parse(String(out).trim().split(/\r?\n/).filter(Boolean).pop()); } catch { j = null; }
  if (!j || j.type !== 'result') {
    const text = (errText || out || '').trim();
    if (/log ?in|not logged|authenticat|\/login|api key/i.test(text)) throw new ClaudeError('auth', 'Claude Code is not signed in. Run `claude` once in a terminal to sign in.');
    throw new ClaudeError('agent', `Claude didn't run: ${text.slice(0, 200) || 'no output'}`);
  }
  if (j.is_error) {
    if (/log ?in|authenticat/i.test(String(j.result))) throw new ClaudeError('auth', 'Claude Code is not signed in. Run `claude` once in a terminal to sign in.');
    throw new ClaudeError('agent', `Claude reported an error: ${String(j.result || j.subtype).slice(0, 200)}`);
  }
  const text = String(j.result || '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let body = null;
  try { body = JSON.parse(text.slice(a, b + 1)); } catch {}
  if (!body || typeof body !== 'object') throw new ClaudeError('agent', 'Claude did not answer in the expected format.');
  return { body, cost: Number(j.total_cost_usd) || 0 };
}

// name: a short folder name for the (empty) working directory, so no project instructions get loaded
export async function askClaude({ system, input, name, cmdVar, timeout = 120_000 }) {
  const cmd = await resolveClaude(cmdVar);
  if (!cmd) throw new ClaudeError('no-claude', 'Claude Code is not installed (the `claude` command was not found).');
  const cwd = path.join(os.tmpdir(), `academic-dashboard-${name}`);
  fs.mkdirSync(cwd, { recursive: true });
  const sysFile = path.join(cwd, 'system.txt');
  fs.writeFileSync(sysFile, system);
  const args = [...cmd.slice(1), '-p', '--model', MODEL, '--output-format', 'json', '--max-turns', '2',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--settings', '{"disableAllHooks":true,"alwaysThinkingEnabled":false}', '--system-prompt-file', sysFile];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], args, { cwd, env: { ...process.env, MAX_THINKING_TOKENS: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errText = '', done = false;
    const finish = f => { if (!done) { done = true; clearTimeout(timer); f(); } };
    const timer = setTimeout(() => finish(() => { killTree(child.pid); reject(new ClaudeError('timeout', `Claude didn't finish within ${timeout / 1000} s.`)); }), timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errText += d; });
    child.on('error', e => finish(() => reject(new ClaudeError(e.code === 'ENOENT' ? 'no-claude' : 'agent', e.message))));
    child.on('close', () => finish(() => { try { resolve(parseJsonReply(out, errText)); } catch (e) { reject(e); } }));
    child.stdin.on('error', () => {}); // the child may exit before reading everything
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
