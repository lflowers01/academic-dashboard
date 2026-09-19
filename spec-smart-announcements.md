# Smart Announcements (optional feature)

Finds dated events in new Brightspace announcements (review sessions, help rooms, exams, deadlines, extensions,
class changes, optional events) and puts them on the calendar: class events it is sure about are **added
automatically**; everything else waits in a **Review** card for Accept / Edit / Decline. Off by default
(⚙ Settings → Features). Decisions from the user, 2026-09-18: course events auto + optional ones to review;
review card at the top of the To-do column; on enable, scan the last 14 days once.

## 1. What it reads, and how
- **Input:** announcements posted in the **last 14 days**, from courses ticked in ⚙ Settings → Courses, that haven't been scanned yet (an unticked course is never sent to Claude and its found events are hidden; ticking it again scans it right away) (so enabling it backfills
  14 days once, then each 3-hour refresh only sends new ones). Title + body as plain text (HTML stripped,
  max 4 000 characters each), course short name, posted date. At most 15 announcements per run; more → several runs.
- **How:** one headless `claude -p` run (Haiku) with **no tools at all** (`--tools ""`, `--strict-mcp-config`),
  its own short system prompt (not Claude Code's; that is most of the saving), `--json-schema` structured output,
  `--no-session-persistence` (announcements aren't written to disk), hooks and slash commands off.
  **Extended thinking is turned off** (`alwaysThinkingEnabled: false`, `MAX_THINKING_TOKENS=0`): with it, 15 real
  announcements took ~150 s (past the 120 s timeout); without, ~12 s.
  Measured on 43 real announcements (2 weeks, 3 runs): ~45 s, **$0.03–0.06** in total.
- **Output:** the reply is JSON in the text, parsed tolerantly and then validated strictly. (`--json-schema` works but only
  takes inline JSON, which is fragile through an npm `claude.cmd` wrapper; the system prompt goes in a file for the same reason.)
- **Announcements are untrusted input.** The model has no tools, so text inside an announcement can at worst
  produce a wrong suggestion, never an action. Every suggestion is checked by the server:
  - its `quote` must appear **verbatim** in that announcement (whitespace/case-insensitive), else it's dropped;
  - the date must be valid and between 2 days before the posting and 300 days after it;
  - only events that haven't ended yet are kept;
  - the announcement id must be one we sent.

## 2. What happens to each event
| Found | Where it goes |
|---|---|
| kind `exam` / `review` / `help` / `deadline` / `class-change`, confidence **high**, verified, **from one of this term's classes** | **Added** (calendar + to-do) |
| kind `optional` (career, workshops, clubs, research…), confidence **low** (missing time/place/date detail), or from a non-class site (honors program, clubs, newsletters) | **Review** card |
| an exam on the same course + day as one already known; the same thing as an existing Brightspace item (same course, day, time, title paraphrased); or a repeat of an event already found | skipped |

**Reworded repeats of a deadline** ("Unit 1 coursework deadline" / "Complete remaining Unit 1 work") can't be told apart from two
real deadlines by title words, so a second sure deadline on a course and day that already has one goes to review with
"Might be the same as “…”" instead of being added (`smartStatus`); the student decides and nothing is dropped. Data
saved by v1.4.0 is fixed the same way once on start-up (events the student accepted are never moved).

Repeats: timed events at the same course/day/minute need half their title words in common; deadlines (no time or
11:59 PM) must nearly match, because several things are often due the same night (a real pattern: "PreLab Quiz – How Fast
Does It React" and "Procedure – How Fast Does It React", from a lab whose work isn't in Brightspace; both kept).

Added and accepted events are items of kind `event`: they look like announced exams (a ✦ "from announcement"
badge instead of EXAM, gold if the kind is exam), open a details window with the quote and
"Open the announcement in Brightspace ↗", and a **Remove** button (→ declined, never re-added).
Events end automatically once over; `deadline` events behave like assignments (check them off).

## 3. Review card (top of the To-do column, hidden when empty)
"Found in announcements · N to review", collapsible like the Today strip. Each row: title, date/time
(or "time?"), course, the announcement title (click → opens it). Buttons: **Accept** (if nothing is missing),
**Edit** (form with title, date, start/end or all-day, location; pre-filled; saving = accept), **Decline**.

## 4. Settings → Smart Announcements
Status line (last scan, events found, cost of last run, errors with the fix), **Scan now**, and a privacy line:
"New announcements' text is sent to Claude (your account, Haiku model) with no tools; nothing else leaves your PC."
Requires Claude Code (same check/messages as Google Calendar; Codex not supported for this feature yet).

## 5. Storage and API
- `data/smart-ann.json`: `{ scanned: {annId: iso}, found: [{ id: "sa:<annId>:<n>", annId, courseId, title, kind,
  date, start, end, allDay, location, quote, missing, status: "added"|"review"|"declined" }], lastRun, lastError, lastCostUsd }`.
- `POST /api/smart/scan` (on demand) · `POST /api/smart/decide {id, action: accept|decline|edit, fields?}`.
  Both answer 409 while the feature is off. Payload: `smart` (null while off).
- Test hooks: `DASH_SMART_CMD` (a fake runner, `fixtures/fake-smart.mjs`; `FAKE_SMART_MODE` = ok | invented | notloggedin | garbage | hang), `DASH_SMART_TIMEOUT`.
- Tests: `test-smart.mjs` (unit + integration, part of `npm test`), `test-e2e-smart.mjs` (browser).

## 6. Rollback
One commit, `git revert`-able. Turning the feature off hides all of it (added events, the card, the settings
section) and stops runs; `data/smart-ann.json` is kept so turning it back on is instant.
