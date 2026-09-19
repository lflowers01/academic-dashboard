// Smart Announcements feature, page side: the "Found in announcements" review card above the to-do list, a Remove
// button on found events, and the settings section. Does nothing while the feature is off (data.smart is null).
// See spec-smart-announcements.md.
import { announcementUrl, brightspaceOrigin } from '/logic.mjs';

const D = window.dash;
const { h, hooks } = D;
const on = () => !!D.data?.smart && D.data?.state?.features?.smartAnnouncements === true;
const S = () => D.data.smart;
const KIND = { exam: 'Exam', review: 'Review session', help: 'Help session', deadline: 'Deadline', 'class-change': 'Class change', optional: 'Optional' };
const annLink = f => announcementUrl(brightspaceOrigin(D.data.items), f.courseId, f.annId);
const annTitle = f => D.data.announcements.find(a => String(a.id) === String(f.annId))?.title || 'the announcement';
const courseShort = id => D.data.courses.find(c => c.id === id)?.short || '';
const at = (date, hm) => new Date(`${date}T${hm || '12:00'}`);
const when = f => `${D.fmtDay(at(f.date))} · ${f.start ? `${D.fmtTime(at(f.date, f.start))}${f.end ? '–' + D.fmtTime(at(f.date, f.end)) : ''}` : f.missing.includes('time') ? 'time?' : 'all day'}`;

async function decide(id, action, fields) {
  try { await D.api('/api/smart/decide', { id, action, fields }); } catch { return false; }
  await D.reload();
  return true;
}

// ---------- review card ----------
let open = D.pref('sreview') === 'open'; // collapsed until you open it (remembered)
hooks.todoTop.push(m => {
  const list = on() ? S().review.filter(f => m.visible.has(f.courseId)) : []; // unticking a course hides its items at once
  if (!list.length) return null;
  return h('section', { class: 'today-strip smart-card' },
    h('button', { type: 'button', class: 'strip-head', 'aria-expanded': open, onclick: () => { open = !open; D.pref('sreview', open ? 'open' : 'closed'); D.render(); } },
      h('span', {}, open ? '▾' : '▸'), h('strong', {}, 'Found in announcements'), h('span', { class: 'muted' }, ` · ${list.length} to review`)),
    open ? h('div', { class: 'smart-list' }, list.map(f => h('div', { class: 'smart-row' },
      h('div', { class: 'smart-main' },
        h('span', { class: 'tag', style: { '--c': D.data.colors?.[f.courseId] || '#cbd5e1' } }, courseShort(f.courseId) || 'Other'), ' ',
        h('strong', {}, f.title),
        h('div', { class: 'muted smart-meta' }, `${KIND[f.kind] || 'Event'} · ${when(f)}${f.location ? ' · ' + f.location : ''}`),
        f.maybe ? h('div', { class: 'smart-meta smart-maybe' }, `Might be the same as “${f.maybe}”`) : null,
        h('div', { class: 'muted smart-meta' }, 'From ', h('a', { href: annLink(f), target: '_blank', rel: 'noopener noreferrer' }, `“${annTitle(f)}” ↗`))),
      h('div', { class: 'smart-actions' },
        f.missing.length ? null : h('button', { type: 'button', class: 'primary', onclick: e => { e.currentTarget.disabled = true; decide(f.id, 'accept'); } }, 'Accept'),
        h('button', { type: 'button', class: f.missing.length ? 'primary' : '', onclick: () => openForm(f) }, f.missing.length ? 'Fill in & accept' : 'Edit'),
        h('button', { type: 'button', onclick: e => { e.currentTarget.disabled = true; decide(f.id, 'decline'); } }, 'Decline'))))) : null);
});

// ---------- edit form (saving = accept) ----------
const dlg = h('dialog', { id: 'dlgSmart' });
document.body.append(dlg);
function openForm(f, error) {
  const form = h('form', { method: 'dialog', class: 'event-form' },
    h('h2', {}, 'Add to your calendar'),
    h('p', { class: 'muted' }, '“', f.quote, '”'),
    error ? h('p', { class: 'warn', role: 'alert' }, error) : null,
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 120, value: f.title })),
    h('div', { class: 'row' },
      h('label', {}, 'Date', h('input', { type: 'date', name: 'date', required: true, value: f.date })),
      h('label', {}, 'Start', h('input', { type: 'time', name: 'start', value: f.start || '' })),
      h('label', {}, 'End', h('input', { type: 'time', name: 'end', value: f.end || '' }))),
    h('p', { class: 'muted' }, 'Leave the start empty for an all-day event.'),
    h('label', {}, 'Location', h('input', { name: 'location', maxlength: 120, value: f.location || '' })),
    h('div', { class: 'dlg-actions' },
      h('button', { value: 'cancel', formnovalidate: true }, 'Cancel'), h('span', { class: 'spacer' }),
      h('button', { class: 'primary', value: 'save' }, 'Add to calendar')));
  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try { await D.api('/api/smart/decide', { id: f.id, action: 'accept', fields: v }); dlg.close(); await D.reload(); }
    catch (err) { openForm({ ...f, ...v }, err.message); }
  });
  dlg.replaceChildren(form);
  if (!dlg.open) dlg.showModal();
}

// ---------- details of a found event: remove it ----------
hooks.itemDetails.push(i => {
  if (!on() || i.kind !== 'event') return [];
  let armed = false;
  const b = h('button', { type: 'button', class: 'smart-remove', onclick: async () => {
    if (!armed) { armed = true; b.textContent = 'Click again to remove'; return; }
    document.querySelector('#dlgItem').close();
    decide(i.id, 'remove');
  } }, 'Remove from calendar');
  return [h('p', { class: 'muted' }, '✦ Found in an announcement by Smart Announcements. ', b)];
});

// ---------- settings ----------
hooks.settings.push({
  id: 'smart', title: 'Smart Announcements', visible: on,
  render(box) {
    const s = S();
    const t = d => (d ? new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
    const err = s.lastError ? h('p', { class: 'warn', role: 'alert' }, s.lastError.message) : null;
    box.replaceChildren(...[
      h('p', {}, 'Finds dated events in announcements from the last 2 weeks and new ones as they arrive: review sessions, help rooms, exams, deadlines, class changes. Class events it is sure about go straight on your calendar; optional events (career fairs, workshops, clubs) and anything with missing details wait in “Found in announcements” above your to-do list.'),
      h('p', { class: 'gstatus' }, s.running ? [h('span', { class: 'spin' }, '↻'), ' Reading announcements…'] : [
        'Last scan ', h('strong', {}, t(s.lastRun)), ` · ${s.counts.added} added · ${s.review.length} to review`,
        s.lastCostUsd ? ` · last run used about $${s.lastCostUsd.toFixed(3)} of Claude usage` : ''],
        ' ', h('button', { type: 'button', disabled: s.running || !s.pending, title: s.pending ? '' : 'Every recent announcement has been read', onclick: async e => {
          e.currentTarget.disabled = true; e.currentTarget.replaceChildren(h('span', { class: 'spin' }, '↻'), ' Scanning…');
          try { await D.api('/api/smart/scan', {}); } catch {}
          await D.reload(); D.showSettingsSection('smart');
        } }, s.pending ? `Scan ${s.pending} new` : 'Up to date')),
      err,
      h('p', { class: 'muted' }, 'Announcement text is sent to Claude (your account, Haiku model) with no tools, so it can only suggest events; each one is checked against the announcement before it is used. Needs Claude Code on this PC.'),
    ].filter(Boolean));
  },
});

// While a scan is running, poll so the results show up promptly.
setInterval(() => { if (on() && S().running) D.reload(); }, 3000);
