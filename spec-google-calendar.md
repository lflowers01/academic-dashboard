# Spec — Google Calendar integration (optional feature) + Settings + Day view

Status: v1 draft → reviewed → final (see §13). Decisions below are from Lucas (2026-09-18) unless marked *design*.

## 0. Goals and non-goals
**Goals**
- See chosen Google calendars next to Brightspace work, clearly distinguished, and hide/show either side in one click.
- Create, edit and delete Google events (only on calendars the user allowed) and push Brightspace items into Google.
- Completely **optional** and **off by default**. With it off, the dashboard looks and behaves exactly like v1.2.x.
- Easy to remove: the feature lives in its own module and its own commit; turning it off removes it from the UI.

**Non-goals (v1)**: inviting guests / RSVPs, Google Meet links, reminders editing, editing whole recurring series (single occurrences only), Google Tasks, non-Google calendars, pushing tasks (manual tasks) to Google automatically.

## 1. How the dashboard reaches Google Calendar (the "bridge")
The dashboard never holds a Google password or OAuth token. It uses the **Google Calendar connector of the user's AI app**, by launching a short **headless agent run**:

- **Claude (supported):** `claude -p <prompt> --model claude-haiku-4-5-20251001 --output-format stream-json --verbose --max-turns N --allowedTools ToolSearch,<only the calendar tool(s) this operation needs> --settings {"disableAllHooks":true} --disable-slash-commands`, run from an **empty temp folder** (so no project instructions load), with a hard timeout.
  - Measured: with hooks and skills disabled a list_calendars run is **~10 s and ~$0.02**, versus $0.41 with defaults (the user's own hooks and project instructions were most of it). `--bare` and `--strict-mcp-config` can't be used: both drop the claude.ai connectors (and `--bare` drops the OAuth login).
  - Reaches the claude.ai Google Calendar connector the user already connected in Claude. Usage counts toward the user's Claude plan limits (or real money on an API key).
  - The connector's tools are *deferred*, so the model first calls `ToolSearch` to load them; `ToolSearch` is therefore always allowed.
- **Codex: not in v1.** Codex has a Google Calendar connector, but it couldn't be installed or verified here (and has a known start-up issue, openai/codex#27844). The bridge keeps runners behind one interface so a Codex runner can be added once someone verifies it; until then the Settings status says "Google Calendar needs Claude Code" rather than offering something untested. Setup and use of the *dashboard itself* still work from Codex.
- **Data is read from the tool result itself**, not from the model's reply: the stream contains each `tool_result` verbatim, and the bridge parses those JSON payloads. The model is never asked to transcribe events, so it can't mistype one. Tool-result `content` may be a string or a list of text parts; both are handled.
- **Least privilege per run (prompt-injection guard):** event titles/descriptions are untrusted text the model reads. Each run allows **only** the tools that operation needs: sync runs allow `list_calendars`/`list_events` (read-only), so an injected "delete everything" can't do anything; a create run allows only `create_event`; and so on. Arguments are fixed by the dashboard (given verbatim as JSON in the prompt), and the bridge **verifies** the tool call it gets back (right tool, right calendar id, right event id) before trusting the result.
- **Server-side permission check:** every write is rejected unless the target calendar has *Allow edits* on, regardless of what the page sends.
- **One run at a time** (a small queue; writes jump ahead of syncs). A stuck run is killed after 120 s.

## 2. Settings (⚙, top right): new core UI, not part of the Google feature
The header becomes `↻ Refresh · ⚙ Settings`. Settings is one window with sections:
1. **Features**: a list of optional features, each with an on/off switch and a one-line description. v1 has one: **Google Calendar**. (Built as a registry so future features just add an entry.)
2. **Google Calendar**: shown only when the feature is on (§3).
3. **Notifications**: the existing Windows-notification settings (moved from the 🔔 button).
4. **Courses**: the existing course show/hide list (moved from the Courses button).

The old 🔔 and Courses header buttons are removed (their content lives in Settings). The "Notifications blocked" warning still surfaces: the ⚙ button gets a small orange dot while something in Settings needs attention.

## 3. Google Calendar settings (inside ⚙ Settings)
- **Status line:** "Connected via Claude · last sync 10:02 AM (used ~$0.07) · next 4:02 PM · [Sync now]", or a clear problem + fix:
  - `claude` not found → "Google Calendar needs Claude Code (claude.com/claude-code), signed in to the account where you connected Google Calendar."
  - connector not connected → "In Claude (claude.ai → Settings → Connectors) connect Google Calendar, then click Retry."
  - not signed in → "Run `claude` once in a terminal to sign in."
- **Privacy line:** "Syncing passes your selected calendars' events through Claude (your account, Haiku model)."
- **Calendars:** the list from the connector. Each has **Show** and **Allow edits** switches (**both off by default**; *Allow edits* requires *Show*) and a **color** swatch (auto-assigned, changeable; the connector doesn't expose Google's own colors).
- **Show Google events on the calendar** (default on) and **Show "Today" schedule strip** (default on).
- **Include today's Google events in the Windows digest** (default **off**).
- **Sync window:** 2 weeks back → 8 weeks ahead (*design*, keeps each sync small). Navigating outside it shows a subtle "Load Google events for October" button (never automatic, since it costs usage).

## 4. Sync
- **When:** on start-up, every **6 h**, right after any change made from the dashboard (that calendar only), and on **Sync now**. Independent of the 3-hour Brightspace refresh.
- **What:** for each calendar with *Show* on: `list_events(calendarId, startTime, endTime, pageSize 250, orderBy startTime)`, following `nextPageToken` pages. Cancelled events are dropped.
- **Stored** in `data/gcal.json` (crash-safe like the rest): calendars, normalized events, window, `syncedAt`, `lastError`, `lastCostUsd`. Failures keep the last good events and show the error in the status line only (no global banner, *design*: non-intrusive).
- **Normalized event:** `{ id: "g:<calendarId>:<eventId>", eventId, calendarId, title, start, end, allDay, location, description (text, HTML stripped), htmlLink, recurring (bool), updated }`.

## 5. How Google events look (clearly different from Brightspace)
- **Brightspace items stay filled** (course color). **Google events are outlined/hollow** in their calendar's color, with a **◷** mark and a time range (`◷ 4–5p Purdue Orbital`). All-day events are an outlined bar with no time.
- Legend gains a "Google" group (calendar swatches, outlined).
- Event details window: calendar name, date/time range, location, description (plain text, links clickable), "Open in Google Calendar ↗", plus **Edit** / **Delete** when the calendar allows edits. Recurring occurrences say "Changes apply to this occurrence only."

## 6. Show/hide: one click
- A **source filter** in the calendar toolbar, visible only when the feature is on: **All · Brightspace · Google**. "Brightspace" = Brightspace items + your tasks. The choice is remembered.
- The Today strip has its own collapse toggle; both can be disabled in Settings.

## 7. Today strip
Above the To-do list when there are Google events today: "**Today** · 10:30 MA 162 Lecture (BHEE 129) · 3:30 CHM 115 Lecture …". Compact list: time · title · location, the next one highlighted, past ones dimmed. Click → event details. Hidden when empty, when the feature is off, or when disabled.

## 8. Duplicates → merged
A Google event and a Brightspace item are **the same thing** when: same local day **and** the event title names the item's course (e.g. `CHM 11510`, `CHM 115`, `CHM11510`) **and** either both are exams, or the titles share ≥ 60% of their meaningful words. Then:
- one entry is shown: the Brightspace item (filled), with a small **◷ In Google** badge;
- its details show the Google time/location/description and an "Open in Google Calendar" link alongside the Brightspace info (notes, Boilerexams);
- the Google copy isn't drawn separately. (Example: Google "CHM 11510 Exam 1" 9/24 8 PM + dashboard "CHM 115 Exam 1" 9/24 8 PM → one entry.)

## 9. Actions (only on calendars with *Allow edits*)
- **Create:** "+ Add" becomes a small menu when the feature is on: **Task** (existing) or **Google event**. Clicking an empty calendar day offers the same choice. Event form: title, calendar (editable ones only), date, all-day or start/end time, location, description.
- **Edit:** same form, prefilled. **Delete:** asks "Delete '<title>' from <calendar>?" first.
- **Add Brightspace item to Google:** button on assignment/quiz/exam details, shown when at least one calendar allows edits. The calendar defaults to one named like "Exams" for exams, otherwise the first editable one, and can be changed.
  - Exams → timed event (start/end from the item; 1 h if no end).
  - Deadlines → a 15-minute event ending at the due time, titled "Due: <title> (<course>)".
  - Description links back to Brightspace.
  - If the item is already merged with a Google event (§8), the button reads "In Google Calendar ✓" and opens it instead. No duplicates.
- **Pending state:** after saving, the entry appears immediately with a "Saving to Google…" shimmer. On success it's replaced by the real event returned by the tool. On failure it's removed and the error is shown in the form/details ("Couldn't save to Google: …", with Retry). Nothing is silently lost.

## 10. Notifications
Default unchanged: the digest lists deadlines only. With **Include today's Google events** on, the digest adds one line: "Events: 10:30 MA 162 Lecture, 3:30 CHM 115 Lecture (+2)".

## 11. Day view (core; works without Google)
Toolbar: **Month · Week · Day**. Day view = one day:
- an **all-day row** (all-day Google events, multi-day tasks, items with no time),
- an **hour timeline** (auto-fits the day's items, default 7 AM–11 PM) where Google events are outlined blocks sized by duration (overlaps side by side) and Brightspace deadlines/tasks are **pins** at their due time ("▸ 11:59p HW 4");
- ‹ › moves a day; **Today** returns; a red "now" line on today.
Clicking an empty hour creates a task (or event, when Google is on) at that time.

## 12. Architecture & files
- `gcal.mjs`: the bridge (runner detection, headless run, stream parsing, argument verification, queue). The only file that knows about Claude/Codex.
- `server.mjs`: `/api/gcal/*` routes (status, calendars, settings, sync, create, update, delete, add-from-item), sync scheduler, permission checks. All of it is inert unless `state.features.googleCalendar` is true.
- `logic.mjs`: pure helpers (normalize events, merge duplicates, day-view layout, filter).
- `public/`: Settings window, filter, Today strip, event chips/details/forms, day view.
- Test hooks: `DASH_GCAL_CMD` (a fake runner that emits stream-json like Claude), `DASH_GCAL_TIMEOUT`.

## 13. Review of this spec (holes found and fixed)
0. *Measured cost/speed* (2026-09-18): list_calendars ≈ $0.02 / 10 s; one week of a 17-lectures/week calendar ≈ 6k tokens.
1. *Cost runaway*: an 8-week window of a busy "Classes" calendar is about 50k tokens. Mitigations: 6 h cadence, Haiku, per-calendar sync after edits, explicit "Load events for <month>", and the last run's cost shown in Settings.
2. *Prompt injection via event text*: least-privilege tools per run, fixed arguments, and verification of the actual tool call (§1).
3. *Model doesn't call the tool / loops*: max-turns cap, and the bridge checks a matching `tool_result` exists; otherwise the run fails with "the assistant didn't complete the call" and the error is shown.
4. *Time zones*: send ISO times with the user's UTC offset; read back `start.dateTime`/`start.date`; all-day uses dates (end exclusive per Google), rendered in local time.
5. *Recurring*: occurrences have unique instance ids (`…_20260921T123000Z`); edits/deletes target the occurrence only; the UI says so.
6. *Stale edits*: Google is the source of truth; after any write, that calendar resyncs.
7. *Feature off*: no runs, no routes doing work, no UI (the filter, strip, legend group and actions all disappear); `data/gcal.json` is kept so re-enabling is instant.
8. *Hidden launch*: the server runs hidden at login; the bridge resolves `claude` via `where claude` (handles `.exe` and `.cmd`) and passes the user's environment so the Claude login is found.
9. *Rollback*: Settings + Day view are separate commits from the Google feature; the Google feature is a single commit, revertable with `git revert`.

## 14. Tests
- Unit: normalization, merge rules (incl. the real "CHM 11510 Exam 1" case and non-matches), filter, day-view layout (overlaps, all-day, pins), argument verification.
- Integration (fake runner): sync incl. pagination, cancelled events, per-calendar Show; create/update/delete round-trips; **writes rejected on non-editable calendars**; runner missing / connector error / timeout; queue ordering; feature off → nothing runs.
- Browser: Settings toggles, filter All/Brightspace/Google, outlined vs filled chips, Today strip, create/edit/delete flow with pending state, add-from-item, day view.
