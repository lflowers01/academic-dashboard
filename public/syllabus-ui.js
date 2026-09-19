// Syllabus scan feature, page side: the "Found in syllabi" review card (shared with Smart Announcements), and the
// settings section: one row per class (what was read, what was found, the grading scheme), Rescan, and adding syllabus
// files (pick or drop; matched to a class by the course code in the file name). See spec-next-features.md §2.
import { foundUI, courseShort } from '/found-ui.js';

const D = window.dash;
const { h, hooks } = D;
const on = () => !!D.data?.syllabus && D.data?.state?.features?.syllabusScan === true;
const S = () => D.data.syllabus;
const TYPES = '.pdf,.docx,.html,.htm,.txt';

foundUI({
  kind: 'syllabus', title: 'Found in syllabi', pref: 'syreview', api: '/api/syllabus', on, source: 'syllabus',
  list: m => S().review.filter(f => m.visible.has(f.courseId)),
  from: f => `From the ${courseShort(f.courseId) || 'class'} syllabus`,
  removeNote: '✦ Found in the syllabus by Syllabus scan.',
});

// "WL-Fall-2026-CHM-(WL)-11520-123-General-Chemistry-I-Lab.pdf" → the class whose code is CHM 11520 (not CHM 11510)
const NOT_SUBJECT = new Set(['WL', 'FALL', 'SPRING', 'SUMMER', 'WINTER', 'LEC', 'LAB', 'REC', 'SEC']);
export function classForFile(name, classes) {
  // subject + number, skipping "WL", term words ("Fall-2026") and a "(WL)" between them; 5-digit numbers first
  const hits = [...String(name).toUpperCase().matchAll(/\b([A-Z]{2,5})[\s_\-]*(?:\(WL\)[\s_\-]*)?(\d{5}|\d{3})\b/g)]
    .filter(m => !NOT_SUBJECT.has(m[1])).sort((a, b) => b[2].length - a[2].length);
  if (!hits.length) return null;
  const [, subj, num] = hits[0];
  const code = c => (String(D.data.courses.find(x => x.id === c.id)?.code || '').match(/\.([A-Z]{2,5})\.(\d{5})\./i) || []).slice(1);
  const exact = classes.filter(c => { const [s, n] = code(c); return s?.toUpperCase() === subj && n && (num.length === 5 ? n === num : n.startsWith(num)); });
  if (exact.length === 1) return exact[0];
  const loose = classes.filter(c => { const [s, n] = code(c); return s?.toUpperCase() === subj && n?.startsWith(num.slice(0, 3)); });
  return loose.length === 1 ? loose[0] : null;
}

const toBase64 = file => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => fail(r.error); r.readAsDataURL(file); });
let unmatched = []; // dropped files we couldn't place: [{ file }]
let status = '';
async function addFile(file, courseId) {
  status = `Adding ${file.name}…`; rerender();
  try { await D.api('/api/syllabus/file', { courseId, name: file.name, data: await toBase64(file) }); status = `Added ${file.name}; reading it now.`; }
  catch (e) { status = `Couldn’t add ${file.name}: ${e.message}`; }
  await D.reload(); rerender();
}
async function addFiles(files) {
  for (const file of files) {
    const c = classForFile(file.name, S().classes);
    if (c) await addFile(file, c.id); else unmatched.push({ file });
  }
  rerender();
}
const rerender = () => { if (document.querySelector('#dlgSettings').open) D.showSettingsSection('syllabus'); };

hooks.settings.push({
  id: 'syllabus', title: 'Syllabus scan', visible: on,
  render(box) {
    const s = S();
    const t = d => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
    const picker = h('input', { type: 'file', multiple: true, accept: TYPES, hidden: true, onchange: e => addFiles([...e.target.files]) });
    const grading = g => !g ? '—' : `${g.type === 'weighted' ? 'Weighted' : 'Points'} · ${g.components.length} part${g.components.length > 1 ? 's' : ''}${g.type === 'weighted' ? ` · ${g.total}%` : ''}`;
    const rows = s.classes.map(c => h('tr', {},
      h('td', {}, h('strong', {}, c.short)),
      h('td', {}, c.sources?.length ? c.sources.map(x => x.name).join(', ') : h('span', { class: 'muted' }, c.note || (c.scannedAt ? 'Nothing found' : 'Not read yet')),
        ...(c.files || []).map(f => h('div', { class: 'syl-file' }, `📎 ${f} `, h('button', { type: 'button', class: 'linklike', 'aria-label': `Remove ${f}`, onclick: async () => {
          await D.api('/api/syllabus/file-remove', { courseId: c.id, name: f }); await D.api('/api/syllabus/scan', { courseId: c.id }); await D.reload(); rerender();
        } }, 'remove'))),
        c.problems?.length ? h('div', { class: 'warn syl-problem' }, c.problems.join('; ')) : null),
      h('td', {}, c.counts ? `${c.counts.added} added · ${c.counts.review} to review` : '—'),
      h('td', {}, grading(c.grading)),
      h('td', {}, h('button', { type: 'button', disabled: s.running, onclick: async () => { await D.api('/api/syllabus/scan', { courseId: c.id }); await D.reload(); rerender(); } }, 'Rescan'))));
    const drop = h('div', { class: 'syl-drop', tabindex: 0, role: 'button', onclick: () => picker.click(), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') picker.click(); },
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('over'); }, ondragleave: e => e.currentTarget.classList.remove('over'),
      ondrop: e => { e.preventDefault(); e.currentTarget.classList.remove('over'); addFiles([...e.dataTransfer.files]); } },
      h('strong', {}, 'Add syllabus files'), ' — drop them here or click to choose (PDF, Word, web page). The class is found from the file name.');
    const ask = unmatched.map(({ file }) => {
      const sel = h('select', { 'aria-label': `Class for ${file.name}` }, h('option', { value: '' }, 'Which class?'), ...s.classes.map(c => h('option', { value: c.id }, c.short)));
      return h('div', { class: 'syl-ask' }, `${file.name}: `, sel, ' ',
        h('button', { type: 'button', onclick: () => { if (!sel.value) return; unmatched = unmatched.filter(u => u.file !== file); addFile(file, Number(sel.value)); } }, 'Add'), ' ',
        h('button', { type: 'button', class: 'linklike', onclick: () => { unmatched = unmatched.filter(u => u.file !== file); rerender(); } }, 'skip'));
    });
    box.replaceChildren(...[
      h('p', {}, 'Reads each class’s syllabus (from Brightspace, or files you add), puts its exams and deadlines on your calendar the same careful way as Smart Announcements, and reads how the class is graded for the Grades tab. Sure items from your classes are added; the rest wait in “Found in syllabi” above your to-do list.'),
      h('p', { class: 'gstatus' }, s.running ? [h('span', { class: 'spin' }, '↻'), ' Reading syllabi… (about 10–30 s per class)']
        : [`Last read ${t(s.lastRun) || 'never'}`, s.lastCostUsd ? ` · used about $${s.lastCostUsd.toFixed(3)} of Claude usage` : '', ' ',
          h('button', { type: 'button', onclick: async () => { await D.api('/api/syllabus/scan', {}); await D.reload(); rerender(); } }, 'Rescan all')]),
      s.lastError ? h('p', { class: 'warn', role: 'alert' }, s.lastError.message) : null,
      status ? h('p', { class: 'muted', role: 'status' }, status) : null,
      h('table', { class: 'gcal-table syl-table' }, h('thead', {}, h('tr', {}, ...['Class', 'Read from', 'Found', 'Grading', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows)),
      drop, picker, ...ask,
      h('p', { class: 'muted' }, 'Syllabus text is sent to Claude (your account, Haiku model) with no tools; each date and grading rule is checked against the syllabus before it is used. Grading schemes are only used after you confirm them in Grades. Needs Claude Code on this PC.'),
    ].filter(Boolean));
  },
});

// While reading, poll so results (and the settings rows) update.
setInterval(async () => { if (on() && S().running) { await D.reload(); rerender(); } }, 3000);
