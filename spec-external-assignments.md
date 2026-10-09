# Labflow, Macmillan, and Pearson assignment sync

Written before implementation, 2026-09-21, and extended before Pearson implementation on 2026-09-22. Each provider course is mapped during extension setup to one of the user's Brightspace courses. Provider URLs and Brightspace course IDs are stored only in that user's Chrome profile and local dashboard data.

## Observed websites

- Labflow course home has an Expand All button. Each dated activity displays its title, opening and closing dates, and EDT/EST. The sidebar duplicates the next two weeks. Use the expanded main course list, not both lists. A check icon / See results means attempted, not necessarily finished. Locked prerequisites must not hide future deadlines. One makeup activity is dated in 2027, outside this Fall 2026 course; exclude it with an explicit term range.
- Macmillan Achieve's Assignments view lists This Week, Next Week, Future, Past and No Due Dates. Past and undated groups can have View All. Assignment containers expose stable UUIDs, due dates and Complete/In Progress/Overdue/Not Started status. Only currently published assignments can be imported. Do not invent later homework.
- Pearson MyLab's Homework and Tests page at `/Student/DoAssignments.aspx?view=all` renders a single table with all 42 published assignments. Each row exposes a due date and time, assignment title, type, and stable homework ID in either `doHomework(ID, ...)` or the score callback container ID `H_ID_...`. A `see score` link means the work has a recorded submission and can be marked complete; `past due` without a score remains incomplete. Build the assignment URL from the stable homework ID. Ignore non-assignment tables and fail visibly if the assignment table is absent.
- Sign-in and idle-session locks require the user's normal browser login. No native MCP dependency for any provider.

## User experience

Add an External assignments page linked from the dashboard. Configure each provider by opening its course tab and choosing the matching dashboard course by name; never require a user to find or edit numeric IDs. Show last successful scan, errors, counts and freshness independently of Brightspace. Offer Sync now through a local Chrome extension plus automatic scans every three hours while Chrome is open. Users can disable automatic scans and exclude an imported item. Existing checkboxes and notes continue to work.

The extension uses dedicated course-list tabs for scanning and never navigates an assessment or submits answers. Reuse only extension-owned tabs; normal homework tabs remain untouched. Scan at browser start and scheduled intervals, with bounded waits and a busy guard. Open sign-in/course pages for user action on request; show a clear stale/login-needed state when unattended authentication fails. Chrome being closed means scans resume next time it opens; the dashboard retains its last data.

## Data and integration

Persist external connections and imported assignments in ignored data/external.json. Stable identity is provider + external course + provider assignment UUID when present, otherwise normalized title. Due-date changes update the same item. Each row records source URL, original date/status text, scan time, mapped course and normalized due instant. Dates use explicit EDT/EST or configured IANA timezone with daylight-saving handling; ambiguous/missing dates are skipped and reported. Do not infer completion from a grade or attempted status. Preserve local completion overrides and notes.

Imported items join itemsOf() so calendar, to-do list and notification digest share existing logic. Keep source attribution and an external link. Filter dates to the configured term, skip undated practice, and preserve existing items on failed/partial scans. Never delete an item simply because it disappeared from a partial page. Deduplicate repeated snapshots and the initial manual task import. Keep manual tasks and Brightspace items intact.

## Browser bridge

Manifest V3 extension, restricted to courses.catalystedu.com, achieve.macmillanlearning.com, mylab.pearson.com and localhost. Read rendered assignment metadata only; no cookie, password or grade-value collection. Use visible DOM labels and bounded expansion of course/assignment lists. A parser mismatch produces a visible error, not an empty success. Local routes use a random pairing token for the extension; do not allow arbitrary web origins, remove existing host checks, or expose the server beyond loopback. Local dashboard owns configuration; extension cannot choose arbitrary remote URLs to fetch.

## Validation and delivery

Tests: Labflow close versus open date and sidebar deduplication; EDT/EST; Macmillan year inference constrained by term; Pearson origin and explicit completion semantics; invalid URL/date input; stable updates without duplicates; preserving local state; failed scans retaining data; bridge authentication and origin rejection. Run the existing full suite. Verify an initial live import against the observed lists and render the new page in Chrome. Validate scheduling/extension behavior separately from parsers. Document any activation step that requires the Chrome extensions UI.
