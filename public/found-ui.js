// The "Found in …" review card, its Add-to-calendar form, and the Remove button on a found event. Shared by
// Smart Announcements (public/smart-ui.js) and Syllabus scan (public/syllabus-ui.js), so both behave the same.
const D = window.dash;
const { h, hooks } = D;
export const KIND = { exam: 'Exam', review: 'Review session', help: 'Help session', deadline: 'Deadline', 'class-change': 'Class change', optional: 'Optional' };
export const courseShort = id => D.data.courses.find(c => c.id === id)?.short || '';
const at = (date, hm) => new Date(`${date}T${hm || '12:00'}`);
export const when = f => `${D.fmtDay(at(f.date))} · ${f.start ? `${D.fmtTime(at(f.date, f.start))}${f.end ? '–' + D.fmtTime(at(f.date, f.end)) : ''}` : f.missing.includes('time') ? 'time?' : 'all day'}`;

// kind: 'smart' | 'syllabus'. list(m) → review entries; from(f) → nodes naming where it came from; api: '/api/smart' …
export function foundUI({ kind, title, pref, api, on, list, from, source, removeNote }) {
  async function decide(id, action, fields) {
    try { await D.api(`${api}/decide`, { id, action, fields }); } catch { return false; }
    await D.reload();
    return true;
  }

  let open = D.pref(pref) === 'open'; // collapsed until you open it (remembered)
  hooks.todoTop.push(m => {
    const rows = on() ? list(m) || [] : [];
    if (!rows.length) return null;
    return h('section', { class: `today-strip smart-card ${kind}-card` },
      h('button', { type: 'button', class: 'strip-head', 'aria-expanded': open, onclick: () => { open = !open; D.pref(pref, open ? 'open' : 'closed'); D.render(); } },
        h('span', {}, open ? '▾' : '▸'), h('strong', {}, title), h('span', { class: 'muted' }, ` · ${rows.length} to review`)),
      open ? h('div', { class: 'smart-list' }, rows.map(f => h('div', { class: 'smart-row' },
        h('div', { class: 'smart-main' },
          h('span', { class: 'tag', style: { '--c': D.data.colors?.[f.courseId] || '#cbd5e1' } }, courseShort(f.courseId) || 'Other'), ' ',
          h('strong', {}, f.title),
          h('div', { class: 'muted smart-meta' }, `${KIND[f.kind] || 'Event'} · ${when(f)}${f.location ? ' · ' + f.location : ''}`),
          f.maybe ? h('div', { class: 'smart-meta smart-maybe' }, `Might be the same as “${f.maybe}”`) : null,
          h('div', { class: 'muted smart-meta' }, from(f))),
        h('div', { class: 'smart-actions' },
          f.missing.length ? null : h('button', { type: 'button', class: 'primary', onclick: e => { e.currentTarget.disabled = true; decide(f.id, 'accept'); } }, 'Accept'),
          h('button', { type: 'button', class: f.missing.length ? 'primary' : '', onclick: () => openForm(f) }, f.missing.length ? 'Fill in & accept' : 'Edit'),
          h('button', { type: 'button', onclick: e => { e.currentTarget.disabled = true; decide(f.id, 'decline'); } }, 'Decline'))))) : null,
      // a syllabus can list a dozen lab deadlines: accept everything that isn't missing anything in one go
      open && rows.filter(f => !f.missing.length).length >= 3 ? h('div', { class: 'smart-bulk' }, h('button', { type: 'button', onclick: async e => {
        const ready = rows.filter(f => !f.missing.length), btn = e.currentTarget; // (currentTarget is gone after the first await)
        btn.disabled = true;
        for (const [n, f] of ready.entries()) { btn.textContent = `Accepting… ${n + 1}/${ready.length}`; try { await D.api(`${api}/decide`, { id: f.id, action: 'accept' }); } catch { break; } }
        await D.reload();
      } }, `Accept all ${rows.filter(f => !f.missing.length).length} complete ones`)) : null);
  });

  // edit form (saving = accept)
  const dlg = h('dialog', { id: kind === 'smart' ? 'dlgSmart' : `dlgFound-${kind}` });
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
      try { await D.api(`${api}/decide`, { id: f.id, action: 'accept', fields: v }); dlg.close(); await D.reload(); }
      catch (err) { openForm({ ...f, ...v }, err.message); }
    });
    dlg.replaceChildren(form);
    if (!dlg.open) dlg.showModal();
  }

  // details of a found event from this source: remove it (asks twice)
  hooks.itemDetails.push(i => {
    if (!on() || i.kind !== 'event' || (i.source || 'announcement') !== source) return [];
    let armed = false;
    const b = h('button', { type: 'button', class: 'smart-remove', onclick: async () => {
      if (!armed) { armed = true; b.textContent = 'Click again to remove'; return; }
      document.querySelector('#dlgItem').close();
      decide(i.id, 'remove');
    } }, 'Remove from calendar');
    return [h('p', { class: 'muted' }, removeNote, ' ', b)];
  });
}
