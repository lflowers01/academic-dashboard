function pearsonDate(value) {
  const match = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!match) return null;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  const hour = Number(match[4]) % 12 + (/pm/i.test(match[6]) ? 12 : 0);
  const due = new Date(year, Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]));
  return Number.isNaN(+due) ? null : due.toISOString();
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'SCAN_ASSIGNMENTS') return;
  const rows = [];
  for (const header of document.querySelectorAll('th.assignmentlink, th.assignmentNameColumn')) {
    const row = header.closest('tr');
    const title = header.querySelector('a')?.textContent?.trim();
    const due = pearsonDate(row?.querySelector('td')?.innerText);
    const markup = row?.innerHTML || '';
    const id = markup.match(/doHomework\((\d+)/i)?.[1] || markup.match(/\bH_(\d+)_/i)?.[1];
    if (!title || !due) continue;
    const hasScore = [...row.querySelectorAll('a')].some(link => /see score/i.test(link.textContent || ''));
    const pastDue = /past due/i.test(row.innerText || '');
    rows.push({
      id: id || `${title}|${due}`,
      title,
      due,
      status: hasScore ? 'Complete' : pastDue ? 'Overdue' : 'Not Started',
      ...(id ? { url: `https://mylab.pearson.com/Student/IntegratedAssignmentOverview.aspx?homeworkId=${id}` } : {}),
    });
  }
  reply(rows.length ? { rows } : { error: 'Pearson assignment table was not found; sign in and open Homework and Tests' });
});
