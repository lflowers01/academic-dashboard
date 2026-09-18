// Native Windows toast notifications via the built-in Windows PowerShell 5.1 WinRT API. No dependencies.
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Windows PowerShell's own app id; always registered, so toasts show without installing anything.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
// fileURLToPath (not .pathname) so folders with spaces or accents resolve correctly.
const ICON = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'icon.png')).href;

// Control characters (code < 32, except newline) aren't allowed in XML, so they're dropped.
const esc = s => Array.from(String(s), ch => { const n = ch.charCodeAt(0); return n < 32 && n !== 10 ? '' : ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch] ?? ch); }).join('');

export function toastXml(title, lines, url) {
  const MAX = 5;
  const shown = lines.slice(0, MAX).concat(lines.length > MAX ? [`+${lines.length - MAX} more`] : []);
  return `<toast activationType="protocol" duration="long" launch="${esc(url)}"><visual><binding template="ToastGeneric">`
    + `<text>${esc(title)}</text><text>${esc(shown.join('\n'))}</text>`
    + `<image placement="appLogoOverride" src="${esc(ICON)}"/>`
    + `</binding></visual></toast>`;
}

// Text travels in environment variables, never in the command line, so nothing in a title can run as code.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml($env:DASH_TOAST_XML)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DASH_TOAST_APPID).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

export function showToast(title, lines, url) {
  // Tests write toasts to a file instead of your screen.
  if (process.env.DASH_TOAST_LOG) { appendFileSync(process.env.DASH_TOAST_LOG, JSON.stringify({ title, lines, url }) + '\n'); return Promise.resolve({ ok: true }); }
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true, timeout: 20_000,
      env: { ...process.env, DASH_TOAST_XML: toastXml(title, lines, url), DASH_TOAST_APPID: APP_ID },
    }, (err, _out, stderr) => resolve(err ? { ok: false, error: (stderr || err.message).trim().slice(0, 300) } : { ok: true }));
  });
}

// Windows accepts toasts silently even when notifications are switched off, so check the two switches that
// hide them: the master "Notifications" toggle and the per-app toggle for Windows PowerShell.
// → null (allowed) | 'system' | 'app'. Read-only.
// `reg query` prints e.g. "    ToastEnabled    REG_DWORD    0x0" → "0" (hex digits), or null if absent.
export const parseRegDword = (out, name) => (String(out).match(new RegExp(name + String.raw`\s+REG_DWORD\s+0x([0-9a-f]+)`, 'i')) || [])[1] ?? null;
const regValue = (key, name) => new Promise(resolve => execFile('reg', ['query', key, '/v', name], { windowsHide: true },
  (err, out) => resolve(err ? null : parseRegDword(out, name))));
export async function notificationBlock() {
  if (process.env.DASH_TOAST_LOG) return process.env.DASH_NOTIFY_BLOCK || null; // tests can pretend Windows blocks them
  const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion`;
  if (await regValue(String.raw`${KEY}\PushNotifications`, 'ToastEnabled') === '0') return 'system';
  if (await regValue(String.raw`${KEY}\Notifications\Settings\${APP_ID}`, 'Enabled') === '0') return 'app';
  return null;
}
export const openNotificationSettings = () => execFile('cmd', ['/c', 'start', '', 'ms-settings:notifications'], { windowsHide: true });
