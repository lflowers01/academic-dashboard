// Plain text from a syllabus file: PDF (unpdf), Word .docx (Windows' own zip reader via PowerShell), HTML, text.
// Used by the Syllabus scan feature; nothing here runs unless it's on.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { htmlToText } from './logic.mjs';

export const SYLLABUS_TYPES = ['.pdf', '.docx', '.html', '.htm', '.txt'];
const MAX = 120_000; // characters per class sent to Claude (the longest real syllabus seen was ~56k)

// .docx is a zip; word/document.xml holds the text. The path reaches PowerShell through the environment.
const DOCX = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead($env:DASH_DOCX)
try { $e = $z.GetEntry('word/document.xml'); $r = New-Object IO.StreamReader($e.Open()); [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($r.ReadToEnd()) } finally { $z.Dispose() }`;
const docxXml = file => new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', DOCX],
  { env: { ...process.env, DASH_DOCX: file }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  (err, out) => (err ? reject(new Error('could not open the Word file')) : resolve(out))));

export async function fileText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    let unpdf;
    try { unpdf = await import('unpdf'); } catch { throw new Error('reading PDFs needs Node.js 22 or newer (and `npm install`)'); }
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
    const { text } = await unpdf.extractText(pdf, { mergePages: true });
    return clean(text);
  }
  if (ext === '.docx') {
    const xml = await docxXml(file);
    return clean(htmlToText(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')));
  }
  if (ext === '.html' || ext === '.htm') return clean(htmlToText(fs.readFileSync(file, 'utf8')));
  if (ext === '.txt') return clean(fs.readFileSync(file, 'utf8'));
  throw new Error(`can't read ${ext || 'this kind of'} files`);
}

const clean = t => String(t || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// All of a class's sources → one text for Claude, each part headed with where it came from, capped.
export function joinSources(parts) {
  let out = '';
  for (const p of parts) {
    if (!p.text) continue;
    const block = `=== ${p.name} ===\n${p.text}\n\n`;
    if (out.length + block.length > MAX) { out += block.slice(0, Math.max(0, MAX - out.length)); break; }
    out += block;
  }
  return out.trim();
}
