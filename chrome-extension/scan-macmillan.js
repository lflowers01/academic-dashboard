const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function macmillanDate(value) {
  const match = String(value).match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?,?\s*([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const hour = Number(match[3]) % 12 + (/pm/i.test(match[5]) ? 12 : 0);
  const now = new Date();
  const candidates = [-1, 0, 1].map(offset => new Date(now.getFullYear() + offset, month, Number(match[2]), hour, Number(match[4])));
  const due = candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  return Number.isNaN(+due) ? null : due.toISOString();
}
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'SCAN_ASSIGNMENTS') return;
  (async () => {
    const view = [...document.querySelectorAll('button')].find(el => /Viewing by/i.test(el.innerText));
    if (view && !/Assignments/i.test(view.innerText)) {
      view.click(); await new Promise(resolve => setTimeout(resolve, 250));
      [...document.querySelectorAll('[role=menuitem],button,li')].find(el => /^Assignments$/i.test(el.innerText.trim()))?.click();
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    const rows = [];
    for (const element of document.querySelectorAll('[id]')) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(element.id)) continue;
      const lines = (element.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      const dueLine = lines.find(line => /^Due\b/i.test(line));
      const due = dueLine && macmillanDate(dueLine);
      if (!due || !lines[0]) continue;
      const status = lines.find(line => /^(Complete|In Progress|Overdue|Not Started)$/i.test(line)) || '';
      rows.push({ id: element.id, title: lines[0], due, status });
    }
    return { rows };
  })().then(reply); return true;
});
