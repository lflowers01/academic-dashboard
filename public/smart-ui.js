// Smart Announcements feature, page side: the "Found in announcements" review card above the to-do list, a Remove
// button on found events, and the settings section. Does nothing while the feature is off (data.smart is null).
// See spec-smart-announcements.md.
import { announcementUrl, brightspaceOrigin } from '/logic.mjs';
import { foundUI } from '/found-ui.js';

const D = window.dash;
const { h, hooks } = D;
const on = () => !!D.data?.smart && D.data?.state?.features?.smartAnnouncements === true;
const S = () => D.data.smart;
const annLink = f => announcementUrl(brightspaceOrigin(D.data.items), f.courseId, f.annId);
const annTitle = f => D.data.announcements.find(a => String(a.id) === String(f.annId))?.title || 'the announcement';

// review card ("Found in announcements"), its form, and Remove on found events: shared with Syllabus scan
foundUI({
  kind: 'smart', title: 'Found in announcements', pref: 'sreview', api: '/api/smart', on, source: 'announcement',
  list: m => S().review.filter(f => m.visible.has(f.courseId)), // unticking a course hides its items at once
  from: f => ['From ', h('a', { href: annLink(f), target: '_blank', rel: 'noopener noreferrer' }, `“${annTitle(f)}” ↗`)],
  removeNote: '✦ Found in an announcement by Smart Announcements.',
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
