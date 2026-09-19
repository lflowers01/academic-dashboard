// In-app updates, page side (always on): a quiet "Update available" pill in the header, a dialog to install it with
// progress, and a version line at the bottom of Settings. See spec-next-features.md §1.
const D = window.dash;
const { h } = D;
const $ = s => document.querySelector(s);
const U = () => D.data?.update;
const snoozed = () => { const s = D.data?.state?.updateSnooze; return !!s && s.version === U()?.latest && new Date(s.until) > new Date(); };

const pill = h('button', { type: 'button', id: 'btnUpdate', class: 'update-pill', hidden: true, onclick: () => openDialog() }, 'Update available');
$('#btnRefresh').before(pill);
const about = h('p', { class: 'settings-about muted', id: 'aboutLine' });
$('#dlgSettings').append(about);
const dlg = h('dialog', { id: 'dlgUpdate', class: 'update-dlg' });
document.body.append(dlg);

const t = d => new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
function render() {
  const u = U();
  if (!u) return;
  pill.hidden = !(u.available && !snoozed()) && !u.job?.step;
  pill.textContent = u.job?.step ? `Updating… ${u.job.step}` : `Update available · v${u.latest}`;
  about.replaceChildren(`Version ${u.current}`,
    u.available ? ` · v${u.latest} is available` : u.checkedAt ? ` · up to date (checked ${t(u.checkedAt)})` : '',
    ' · ', h('button', { type: 'button', class: 'linklike', onclick: async e => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = 'Checking…';
      try { await D.api('/api/update/check', {}); } catch {}
      await D.reload();
    } }, 'Check for updates'));
  if (dlg.open) fillDialog();
}

function openDialog() { fillDialog(); if (!dlg.open) dlg.showModal(); }
function fillDialog() {
  const u = U();
  const steps = ['Downloading', 'Checking', 'Installing', 'Restarting'];
  const busy = !!u.job?.step;
  dlg.replaceChildren(...[ // (filtered: replaceChildren would print "null" for the empty slots)
    h('h2', {}, busy ? `Updating to v${u.job.to}` : `Version ${u.latest} is available`),
    h('p', { class: 'muted' }, `You have v${u.current}. Your tasks, notes and settings are kept.`),
    busy ? h('ol', { class: 'update-steps' }, steps.map(s => {
      const i = steps.indexOf(s), at = steps.indexOf(u.job.step);
      return h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, i === at ? [h('span', { class: 'spin' }, '↻'), ' ', s] : i < at ? `✓ ${s}` : s);
    })) : null,
    u.job?.error ? h('p', { class: 'warn', role: 'alert' }, `The update didn't finish: ${u.job.error}`) : null,
    !busy && u.notes ? h('div', { class: 'update-notes' }, D.renderMarkdown(u.notes)) : null,
    !busy && u.git ? h('p', { class: 'warn' }, 'This folder is a git checkout, so it isn’t updated from here. Use git pull.') : null,
    h('div', { class: 'dlg-actions' },
      busy ? null : h('button', { type: 'button', onclick: async () => { dlg.close(); await D.patchState({ updateSnooze: { version: u.latest } }); render(); } }, 'Later'),
      h('span', { class: 'spacer' }),
      u.url ? h('a', { href: u.url, target: '_blank', rel: 'noopener noreferrer', class: 'minor' }, 'Release page ↗') : null,
      busy ? null : h('button', { type: 'button', class: 'primary', disabled: !u.canInstall, onclick: install }, 'Update now')),
    busy ? null : h('p', { class: 'muted' }, h('small', {}, 'Or ask Claude Code / Codex in the dashboard folder: “update the dashboard”.')),
  ].filter(Boolean));
}

// The server restarts itself at the end, so the page waits for it to come back as the new version, then reloads.
async function install() {
  try { await D.api('/api/update', {}); } catch { await D.reload(); return; }
  const from = U().current;
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 1000));
    let d = null;
    try { d = await (await fetch('/api/data')).json(); } catch { continue; } // down while restarting
    if (d.update?.current && d.update.current !== from) { location.reload(); return; }
    if (d.update?.job?.error) { await D.reload(); return; }
    D.data.update = d.update; render();
  }
}

D.hooks.afterRender.push(render);
