const labflowDate = value => {
  const match = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*\((EDT|EST)\)/i);
  if (!match) return null;
  let hour = Number(match[4]) % 12 + (/PM/i.test(match[6]) ? 12 : 0);
  const offset = match[7].toUpperCase() === 'EDT' ? '-04:00' : '-05:00';
  return new Date(`${match[3]}-${match[1]}-${match[2]}T${String(hour).padStart(2, '0')}:${match[5]}:00${offset}`).toISOString();
};
const cleanLabTitle = text => text.split('\n').map(s => s.trim()).filter(Boolean)
  .find(line => !/^(done|arrow_forward|see results|attempts remaining|not available until|opened?|closed?|closes?|cut-off)/i.test(line));

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'SCAN_ASSIGNMENTS') return;
  (async () => {
    const expand = [...document.querySelectorAll('button,[role=button]')].find(el => /^expand all$/i.test(el.innerText.trim()));
    if (expand) { expand.click(); await new Promise(resolve => setTimeout(resolve, 900)); }
    if (/Idle Session Lock/i.test(document.body.innerText)) return { error: 'Labflow is locked after inactivity; unlock the course tab' };
    const rows = [];
    for (const element of document.querySelectorAll('.activity-content,[role=button],button')) {
      const text = element.innerText || '';
      const close = text.match(/(?:Closed?|Closes?|Cut-Off:)\s*([^\n]+)/i)?.[1];
      const title = close && cleanLabTitle(text);
      const due = close && labflowDate(close);
      if (!title || !due || /Makeup Version/i.test(title)) continue;
      rows.push({ title, due, status: /^done\b/i.test(text.trim()) ? 'Attempted' : /not available until/i.test(text) ? 'Locked' : 'Available' });
    }
    const unique = [...new Map(rows.map(row => [`${row.title}|${row.due}`, row])).values()];
    return { rows: unique };
  })().then(reply); return true;
});
