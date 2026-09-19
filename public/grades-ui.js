// Grades feature, page side: a Grades tab with one card per class, and a window per class with how the grade is
// worked out, what-ifs, "what do I need", and setting up the grading scheme. See spec-next-features.md §3.
import { gradeFor, needFor, DEFAULT_SCALE } from '/logic.mjs';

const D = window.dash;
const { h, hooks } = D;
const $ = s => document.querySelector(s);
const on = () => !!D.data?.grades && D.data?.state?.features?.grades === true;
const cfgOf = id => D.data.state.grades?.[id] || {};
const whatIf = {}; // courseId → { rowName: percent } — only in this page, never saved
const pct = x => (x == null ? '—' : `${(Math.round(x * 10) / 10).toFixed(1)}%`);
let target = null; // the grade picked in "What do I need for …" (re-picked when the setup changes)
const save = (id, patch) => { if (patch.scheme) target = null; return D.patchState({ grades: { [id]: patch } }); };

// tab + panel
const tab = h('button', { role: 'tab', id: 'tabGrades', 'data-tab': 'grades', 'aria-selected': 'false', 'aria-controls': 'panelGrades', hidden: true,
  onclick: () => { D.view.tab = 'grades'; D.pref('tab', 'grades'); D.render(); } }, 'Grades');
$('#tabAnn').after(tab);
const panel = h('section', { id: 'panelGrades', role: 'tabpanel', hidden: true });
$('#panelAnn').after(panel);

function render() {
  const shown = on();
  tab.hidden = !shown;
  if (!shown && D.view.tab === 'grades') { D.view.tab = 'cal'; D.render(); return; }
  const active = shown && D.view.tab === 'grades';
  tab.setAttribute('aria-selected', String(active));
  panel.hidden = !active;
  if (active) renderPanel();
  if (dlg.open && openId != null) fillDialog(openId);
}

function classesShown() {
  const visible = D.model?.visible || new Set();
  return D.data.grades.filter(c => visible.has(c.id));
}
const gradeOf = c => gradeFor(c.rows, cfgOf(c.id), whatIf[c.id] || {});
const basisText = (c, g) => {
  const s = cfgOf(c.id).scheme;
  if (g.basis === 'weighted') return `Weighted by ${s?.from === 'syllabus' ? 'your syllabus' : 'your setup'}`;
  if (g.basis === 'points') return `Total points (${s?.from === 'syllabus' ? 'from your syllabus' : 'your setup'})`;
  return c.suggestion ? 'Your syllabus has a grading scheme: open to use it' : 'Rough: set up how this class is graded';
};

function renderPanel() {
  const list = classesShown();
  panel.replaceChildren(
    h('p', { class: 'muted grades-note' }, 'Estimates from your Brightspace scores, worked out the way each syllabus says. Brightspace’s own category totals count work that isn’t graded yet as 0, so they’re left out. Your instructor’s gradebook is the official grade.'),
    list.length ? h('div', { class: 'grade-grid' }, list.map(c => {
      const g = gradeOf(c);
      return h('button', { type: 'button', class: 'grade-card', onclick: () => openDialog(c.id) },
        h('div', { class: 'grade-head' }, h('span', { class: 'tag', style: { '--c': D.data.colors?.[c.id] || '#cbd5e1' } }, c.short)),
        h('div', { class: 'grade-big' }, pct(g.pct), g.letter ? h('span', { class: 'grade-letter' }, g.letter) : null),
        h('div', { class: 'muted grade-basis' }, g.pct == null ? 'No grades yet' : basisText(c, g)),
        g.share != null ? h('div', { class: 'grade-share', title: `${Math.round(g.share * 100)}% of the course grade is in` },
          h('div', { class: 'grade-share-bar', style: { width: `${Math.round(g.share * 100)}%` } })) : null,
        g.share != null ? h('div', { class: 'muted grade-basis' }, `${Math.round(g.share * 100)}% of the grade is in`) : null);
    })) : h('p', { class: 'muted' }, 'No classes with grades yet.'));
}

// ---------- one class ----------
const dlg = h('dialog', { id: 'dlgGrade', class: 'grade-dlg' });
document.body.append(dlg);
let openId = null, editing = null; // editing: a draft scheme { type, components: [{ name, value }] }
function openDialog(id) { openId = id; editing = null; target = null; fillDialog(id); if (!dlg.open) dlg.showModal(); }
dlg.addEventListener('close', () => { openId = null; editing = null; });

function fillDialog(id) {
  const c = D.data.grades.find(x => x.id === id);
  if (!c) { dlg.close(); return; }
  const cfg = cfgOf(id), g = gradeOf(c), wi = whatIf[id] ||= {};
  const scale = g.scale || DEFAULT_SCALE;
  target ||= ([...scale].reverse().find(s => s.min > (g.pct ?? 0)) || scale[0]).letter; // the next grade up
  const nodes = [
    h('div', { class: 'grade-dlg-head' },
      h('h2', {}, h('span', { class: 'tag', style: { '--c': D.data.colors?.[id] || '#cbd5e1' } }, c.short), ' ', pct(g.pct), g.letter ? h('span', { class: 'grade-letter' }, g.letter) : null),
      h('p', { class: 'muted' }, g.pct == null ? 'No grades yet.' : basisText(c, g), g.share != null ? ` · ${Math.round(g.share * 100)}% of the grade is in` : '')),
    schemeSection(c, cfg),
    needSection(g, scale),
    rowsSection(c, cfg, g, wi),
    Object.keys(wi).length ? h('p', {}, h('button', { type: 'button', onclick: () => { whatIf[id] = {}; fillDialog(id); render(); } }, 'Reset what-ifs')) : null,
    h('p', { class: 'muted' }, h('small', {}, 'An estimate from Brightspace scores and your syllabus; what-ifs are only on this page. Your instructor’s gradebook is official.')),
    h('form', { method: 'dialog', class: 'dlg-actions' }, h('span', { class: 'spacer' }), h('button', {}, 'Close')),
  ];
  dlg.replaceChildren(...nodes.filter(Boolean));
}

function schemeSection(c, cfg) {
  const s = cfg.scheme, sug = c.suggestion;
  const list = sc => sc.components.map(x => `${x.name} ${x.value}${sc.type === 'weighted' ? '%' : ' pts'}`).join(' · ');
  if (editing) return schemeEditor(c);
  if (s) return h('div', { class: 'grade-scheme' },
    h('strong', {}, s.type === 'weighted' ? 'Weighted' : 'Points', s.from === 'syllabus' ? ' (from your syllabus)' : ''), ': ', list(s), ' ',
    h('button', { type: 'button', class: 'linklike', onclick: () => { editing = JSON.parse(JSON.stringify({ type: s.type, components: s.components, scale: s.scale })); fillDialog(c.id); } }, 'Edit'));
  if (sug) return h('div', { class: 'grade-scheme suggest' },
    h('strong', {}, 'Your syllabus says: '), `${sug.type === 'weighted' ? 'weighted' : 'total points'} — ${list({ type: sug.type, components: sug.components })}`,
    sug.type === 'weighted' && Math.abs(sug.total - 100) > 1 ? h('div', { class: 'warn' }, `These add up to ${sug.total}%, not 100%. Check them before using.`) : null,
    h('div', { class: 'grade-scheme-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => save(c.id, { scheme: { type: sug.type, components: sug.components, scale: sug.scale, from: 'syllabus' } }) }, 'Use this'), ' ',
      h('button', { type: 'button', onclick: () => { editing = { type: sug.type, components: sug.components.map(x => ({ ...x })), scale: sug.scale, from: 'syllabus' }; fillDialog(c.id); } }, 'Edit first')));
  return h('div', { class: 'grade-scheme suggest' },
    h('strong', {}, 'How is this class graded? '), 'Check the syllabus, then set it up once:',
    h('div', { class: 'grade-scheme-actions' },
      h('button', { type: 'button', onclick: () => { editing = { type: 'weighted', components: [{ name: '', value: '' }] }; fillDialog(c.id); } }, 'Categories with % weights'), ' ',
      h('button', { type: 'button', onclick: () => { editing = { type: 'points', components: [{ name: '', value: '' }] }; fillDialog(c.id); } }, 'Total points')),
    D.data.syllabus == null ? h('p', { class: 'muted' }, h('small', {}, 'Or turn on Syllabus scan (⚙ Settings → Features) to read it from the syllabus.')) : null);
}

function schemeEditor(c) {
  const e = editing, pctMode = e.type === 'weighted';
  const total = e.components.reduce((s, x) => s + (Number(x.value) || 0), 0);
  let error = '';
  const rows = e.components.map((x, i) => h('div', { class: 'scheme-row' },
    h('input', { 'aria-label': 'Category name', placeholder: pctMode ? 'e.g. Quizzes' : 'e.g. Homework', value: x.name, oninput: ev => { x.name = ev.target.value; } }),
    h('input', { 'aria-label': pctMode ? 'Weight in percent' : 'Points', type: 'number', min: 0, step: 'any', value: x.value, oninput: ev => { x.value = ev.target.value; sum.textContent = sumText(); } }),
    h('span', { class: 'muted' }, pctMode ? '%' : 'pts'),
    h('button', { type: 'button', class: 'linklike', 'aria-label': 'Remove', onclick: () => { e.components.splice(i, 1); fillDialog(c.id); } }, '✕')));
  const sumText = () => { const t = e.components.reduce((s, x) => s + (Number(x.value) || 0), 0); return pctMode ? `Total ${t}%${Math.abs(t - 100) > 0.01 ? ' (should be 100%)' : ' ✓'}` : `Total ${t} points`; };
  const sum = h('span', { class: 'muted' }, sumText());
  return h('div', { class: 'grade-scheme editing' },
    h('div', { class: 'seg' }, ...[['weighted', 'Weighted %'], ['points', 'Total points']].map(([t, label]) =>
      h('button', { type: 'button', 'aria-pressed': e.type === t, onclick: () => { e.type = t; fillDialog(c.id); } }, label))),
    ...rows,
    h('div', { class: 'scheme-foot' }, h('button', { type: 'button', onclick: () => { e.components.push({ name: '', value: '' }); fillDialog(c.id); } }, '+ Add'), ' ', sum),
    h('p', { class: 'warn', role: 'alert', hidden: true, id: 'schemeError' }),
    h('div', { class: 'grade-scheme-actions' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        const clean = { type: e.type, components: e.components.filter(x => String(x.name).trim() || x.value !== '').map(x => ({ name: String(x.name).trim(), value: Number(x.value) })), scale: e.scale || [], from: e.from || 'you' };
        try { await save(c.id, { scheme: clean }); editing = null; fillDialog(c.id); }
        catch (err) { const p = $('#schemeError'); p.hidden = false; p.textContent = err.message; }
      } }, 'Save'), ' ',
      h('button', { type: 'button', onclick: () => { editing = null; fillDialog(c.id); } }, 'Cancel'),
      cfgOf(c.id).scheme ? h('button', { type: 'button', class: 'linklike', style: { 'margin-left': 'auto' }, onclick: async () => { await D.patchState({ grades: { [c.id]: null } }); editing = null; fillDialog(c.id); } }, 'Forget this setup') : null));
}

function needSection(g, scale) {
  if (g.pct == null) return null;
  const pick = h('select', { 'aria-label': 'Target grade', onchange: ev => { target = ev.target.value; fillDialog(openId); } },
    scale.map(s => h('option', { value: s.letter, selected: s.letter === target }, `${s.letter} (${s.min}%)`)));
  const t = scale.find(s => s.letter === target) || scale[0];
  const n = needFor(t.min, g);
  const say = !n ? (g.basis === 'simple' ? 'Set up how the class is graded to see this.' : 'Nothing is left to grade.')
    : n.need <= 0 ? `You have it even with 0% on ${n.on ? `the ${n.on}` : 'everything left'}.`
    : n.need > 100 ? `Out of reach: it would take ${pct(n.need)} on ${n.on ? `the ${n.on}` : 'everything left'}.`
    : [`You need `, h('strong', {}, pct(n.need)), ` on ${n.on ? `the ${n.on}` : 'everything left'}.`];
  return h('div', { class: 'grade-need' }, h('strong', {}, 'What do I need for '), pick, h('strong', {}, '?'), ' ', h('span', {}, say));
}

function rowsSection(c, cfg, g, wi) {
  const comps = cfg.scheme?.components || [];
  const row = r => {
    const counted = !r.ignored;
    const toggle = h('input', { type: 'checkbox', checked: counted, 'aria-label': `Count ${r.name}`, onchange: ev => {
      const patch = r.summary ? { include: { ...(cfg.include || {}), [r.name]: ev.target.checked || undefined } } : { ignore: { ...(cfg.ignore || {}), [r.name]: !ev.target.checked || undefined } };
      for (const m of Object.values(patch)) for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
      save(c.id, patch);
    } });
    const score = h('input', { type: 'number', class: 'whatif', min: 0, max: 200, step: 'any', 'aria-label': `What-if score for ${r.name} in percent`,
      placeholder: r.possible ? String(Math.round(r.real / r.possible * 1000) / 10) : '', value: wi[r.name] ?? '',
      onchange: ev => { if (ev.target.value === '') delete wi[r.name]; else wi[r.name] = Number(ev.target.value); fillDialog(c.id); render(); } });
    return h('tr', { class: [r.ignored && 'off', r.whatIf && 'tried'].filter(Boolean).join(' ') },
      h('td', {}, toggle),
      h('td', {}, r.name, r.summary ? h('span', { class: 'muted' }, ' · Brightspace category total') : r.extra ? h('span', { class: 'muted' }, ' · extra credit') : null),
      h('td', { class: 'num' }, `${Math.round(r.real * 100) / 100}/${r.extra ? 0 : r.possible}`),
      h('td', { class: 'num' }, score, '%'),
      comps.length ? h('td', {}, h('select', { 'aria-label': `Category for ${r.name}`, onchange: ev => save(c.id, { assign: { ...(cfg.assign || {}), [r.name]: ev.target.value } }) },
        h('option', { value: '' }, '—'), comps.map(x => h('option', { value: x.name, selected: r.component === x.name }, x.name)))) : null);
  };
  const head = h('tr', {}, h('th', {}, 'Count'), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Score'), h('th', { class: 'num' }, 'What if'), comps.length ? h('th', {}, 'Category') : null);
  if (g.basis === 'weighted') {
    return h('div', {}, ...g.categories.map(cat => h('div', { class: 'grade-cat' },
      h('h3', {}, `${cat.name} · ${cat.weight}%`, h('span', { class: 'muted' }, cat.pct == null ? ' · nothing graded yet' : ` · ${pct(cat.pct)}`)),
      cat.rows.length ? h('table', { class: 'grade-rows' }, h('thead', {}, head.cloneNode(true)), h('tbody', {}, cat.rows.map(row))) : null)),
      g.unassigned.length ? h('div', { class: 'grade-cat' }, h('h3', {}, 'Not in a category', h('span', { class: 'muted' }, ' · not counted until you pick one')),
        h('table', { class: 'grade-rows' }, h('thead', {}, head.cloneNode(true)), h('tbody', {}, g.unassigned.map(row)))) : null);
  }
  return g.rows.length ? h('table', { class: 'grade-rows' }, h('thead', {}, head), h('tbody', {}, g.rows.map(row))) : h('p', { class: 'muted' }, 'Brightspace has no scores for this class yet.');
}

hooks.afterRender.push(render);
