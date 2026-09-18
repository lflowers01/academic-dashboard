# Academic Dashboard — Spec (v4, as built)

A local dashboard for Purdue Brightspace, for **Windows**, opened in any browser at `http://localhost:4321`. Function first, easy to read, colored by course.

It answers at a glance:
1. What's overdue, due today, tomorrow, and this week?
2. When is each thing due, when does it **open**, and when are **exams**?
3. What did instructors announce? (separate tab)

## 1. Data source
- The server spawns **`brightspace-mcp-server`** (`cmd /c npx -y brightspace-mcp-server@latest`, env `D2L_NO_UPDATE_CHECK=1`) and talks to it over MCP stdio with `@modelcontextprotocol/sdk`. Sign-in is the MCP server's saved session in Windows Credential Manager; the dashboard never sees credentials.
- Tools used: `get_my_courses` (all), `get_assignments` and `get_my_grades` (**once per course, in parallel**), `get_announcements` (50).
- **Measured (2026-09):** `get_assignments` without a course id times out (> 170 s); per course it takes 20–76 s, and some newsletter-type sites take > 120 s. A full refresh takes about 1.5–2.5 min.
- **Not used:** `get_upcoming_due_dates`. It omits real, unfinished items, so it's neither a to-do list nor a completion signal.
- **Only fetched:** courses that are active, accessible, and not from a past term (`shouldFetch`). Keeps refreshes fast for students with years of old courses.
- **Failure isolation:** per-course timeout 150 s. A course that fails keeps its last cached items. One course refusing access is never treated as "signed out"; only a failed course list, or every course failing with a sign-in error, is. A hard 4-minute limit kills the whole MCP process tree (`taskkill /T`).

## 2. Refresh schedule
- Slots at local 00:00, 03:00, …, 21:00, plus one on start-up. A **60 s tick** compares against the last attempt, so sleep, hibernate and late boots catch up with exactly one refresh.
- Network failure → retries after 5, 15, then 30 min. **Sign-in failure → scheduled refreshes pause** (no MFA pushes to the phone at 3 AM) until the user clicks **Sign in** (opens a visible `npx … auth` window) and then **Refresh**.
- Single-flight: a refresh requested during one joins it.
- The page polls every 60 s (5 s while refreshing) and recomputes today/tomorrow/overdue from its own clock, so it stays right past midnight.

## 3. Items, status, exams
- **Item** = Brightspace assignment/quiz, **announced exam**, or manual task.
- **Done** = assignment submitted, quiz graded (a grade item with the same normalized name has a score), announced exam already over, or ticked by hand. A manual tick/untick always wins.
- **Status:** overdue (≤ 14 days; older ones auto-expire) · today · tomorrow · this week (7 days) · later · no due date.
- **Opens:** a future `startDate` shows an "OPENS …" badge and a dashed "Opens:" chip on the calendar.
- **Exams**, shown gold and labelled EXAM everywhere:
  - quizzes/assignments whose name is an exam ("Exam 2", "Midterm", "Final Exam") but not practice, review, info, agreement, reflection and similar (`isExamName`);
  - exam dates **in announcements**: a sentence must *schedule* an exam ("Exam 1 is Thurs. Sept. 24, 8:00-9:00 PM", "Midterm 2 will now be held on Oct. 29th, 7-9 pm"). Deadline sentences that only mention an exam ("request a reschedule no later than…", "sign up for a seat by…", "Exam Agreement due…") are ignored. Handles "23 September 2026", "Sept. 24", "9/23", time ranges and single times, and abbreviations like "Oct." / "Thurs." / "p.m.". One event per course per day, skipped if the course already has an exam item that day;
  - manual tasks with "This is an exam" ticked.
- Dates are UTC from Brightspace and shown in the PC's local time zone.

## 4. Courses
- Shown by default: **this term's registrar courses** (code `wl.{term}.{SUBJ}.{number}.{section}`, newest term present) plus any other site with a not-done item due in the next 30 days. Everything else is hidden. **⚙ Settings → Courses** overrides either way ("Reset to automatic" clears the overrides).
- Short names come from the code (`CHM 11510` → `CHM 115`, "Lab" kept), a short parenthetical (`… (SOLIDWORKS)`), or the name.
- Colors: a 13-hue palette assigned **only to shown courses**, this term's first, so they don't repeat. Black text on every color, ≥ 7:1 contrast.

## 5. Layout
- Header: Purdue logo (links to myPurdue in a new tab) · "Academic Dashboard" · last/next refresh · Refresh · ⚙ Settings (Features · Notifications · Courses, with an orange dot when something needs attention). Banner row only when something is wrong.
- Tabs: **Calendar & To-do** and **Announcements** (unread badge).
- To-do column: Overdue · Today (including items done today) · Tomorrow · This week · Later ▸ · No due date ▸, plus "+ Add task". Rows have a checkbox, course tag, title and badges (urgency, EXAM, OPENS, timed, points, NEW).
- Calendar: **Month · Week · Day**. Day = an all-day row + an hour timeline (7 AM–11 PM, stretched to fit): items with a duration (announced exams) are blocks side by side when they overlap, deadlines are pins at their due time (same-minute pins share a row), a red now-line on today, the timeline (never the page) scrolls to now/the first item, and clicking an empty hour adds a task at that time; clicking a day number in Month/Week opens that day. Month (**Sunday** start, 3 boxes per day then "+N more"; **multi-day tasks are one bar across their days**, packed into lanes above the day's boxes, with the title repeated on each week row they continue onto) or week (everything). Clicking an empty day adds a task on it; clicking an item opens its details (dates, points, time limit, instructions as plain text, link to Brightspace, done toggle). **Past-due assignments** link to the course's assignment list (Brightspace answers 403 on a closed submission page), plus a secondary "Submission page (may be closed)" link. Announced exams and announcements link to the announcement page (`/d2l/le/news/{course}/{id}/view`).
- Footer credits: "Made by Lucas Flowers · lucasflowers.net" with the site's icon.
- Theme: one pure-black, high-contrast theme; neutral white accents; gold `#cfb991` for exams and the dashboard icon. Stacks into one column under 900 px.

## 6b. Boilerexams
Every exam (exam quiz, announced exam, or exam task with a course) in a course that exists on [Boilerexams](https://boilerexams.com/courses) gets a **Study on Boilerexams ↗** button linking to `https://boilerexams.com/courses/{SUBJ}{NUMBER}/exams`. If the course isn't there, no button. The list comes from `https://api.boilerexams.com/courses` (published courses only) and is cached in `data/boilerexams.json`: refreshed on start-up, every 6 h, and immediately when a new exam appears or a task becomes an exam. Failures keep the last list. Matching is exact on subject+number, else subject + first 3 digits (Brightspace's `CHM 11510` lecture → Boilerexams `CHM11500`).

## 6a. My notes
Every Brightspace item (assignment, quiz, exam, announced exam) has a **My notes** box in its details window. It supports **Markdown** (headings, bold/italic/strike, code, lists, `- [ ]` checklists, quotes, links; rendered with DOM nodes only, http(s) links only) and shows formatted until clicked to edit. It saves as you type (500 ms), on blur, and when the window closes, and stores to `state.notes[itemId]` (5,000 chars; blank = delete; never pruned). Items with a note show "📝 note" in the to-do list and 📝 on calendar chips, with the note in the hover text. Manual tasks keep their notes on the task.

## 6. Manual tasks
Title (required), date (required), **end date (optional, for a range like Sat–Sun)**, time (optional; blank = all day, due 23:59), course (optional), exam flag, notes. Create / edit / delete / tick. Enter saves; Esc and Cancel don't.
- A **range** shows on every day of it in the calendar (capped at 62 days) and once in the to-do list with a "Sat 9/19 – Sun 9/20" badge. While today is inside the range it counts as **today** (and goes in that day's digest); before it starts it sorts by its start date; it's due at the end of its last day. End before start is rejected (400).

## 7. Notifications (native Windows)
- Sent by the **server** as Windows toast notifications (built-in Windows PowerShell 5.1 WinRT API, no extra installs), so they work with the browser closed.
- **When:** after the start-up refresh (i.e. when Windows starts) and after every scheduled 3-hour refresh; also from cached data while signed out.
- **What:** one digest of unfinished items due **today** (including ones already past today) or **before 10:00 AM tomorrow** (`EARLY_MORNING_HOUR`). Nothing due → nothing sent. The same digest isn't repeated within 90 minutes.
- Clicking the notification opens the dashboard: a digest with **one** item opens that item's details (`#item=<id>`); **several** items are highlighted in the to-do list (`#due=<id>,…`). Notifications stay on screen ~25 s (`duration="long"`), then sit in the notification center.
- If Windows notifications are switched off (the master toggle, or the per-app toggle for Windows PowerShell), Windows drops them silently. The server reads both switches (read-only) and ⚙ Settings → Notifications says so, with an "Open Windows notification settings" button.
- On/off and "Send a test notification" live in ⚙ Settings → Notifications.
- Safety: text is XML-escaped (control characters dropped) and passed to PowerShell in environment variables, never in the command line.

## 8. Announcements
Newest first, filter by course, unread dot and badge, marked read after 2 s on screen, "Mark all read". Bodies are plain text: tags are stripped, URLs linked, and nothing goes through `innerHTML`. Announcements scheduled for the future stay hidden until their start date.

## 9. Server & API
- `server.mjs`: `node:http`, bound to **127.0.0.1** only. Host-header check (DNS-rebinding guard); non-GET requests must be JSON (CORS preflight never answered, so other sites can't call it); bodies capped at 1 MB (413); static files confined to `public/`.
- Data in `data/`: `cache.json`, `tasks.json`, `state.json`, `server.log` (capped at 1 MB). Saves write a temp file, fsync it, keep the previous version as `*.bak`, then rename it into place (atomic). A damaged file is set aside as `*.bad` and restored from `*.bak`; only if that is unusable too does it start from defaults. Everything survives restarts and reboots.
- API: `GET /api/data` · `POST /api/refresh` · `POST /api/tasks` · `DELETE /api/tasks/:id` · `POST /api/state` (done, hiddenCourses, seenAnnouncements, notes, notifications) · `POST /api/notify-test` · `POST /api/notification-settings` · `POST /api/signin`.
- Env overrides: `DASH_PORT`, `DASH_DATA`; test hooks `DASH_MCP_CMD`, `DASH_TOAST_LOG`, `DASH_NOTIFY_BLOCK`, `DASH_TOTAL_TIMEOUT`, `DASH_COURSE_TIMEOUT`.

## 10. Install & run
- Guided setup by an AI agent (Claude Code or Codex) following `AGENTS.md` (`CLAUDE.md` imports it): Node via winget → `npm install` → `npm test` → Brightspace sign-in in its own window, typed by the user and never through the agent → `npm run check` → `install-autostart.cmd`. Sandboxed agents (Codex) must start the server **outside** the sandbox, or the user double-clicks the script.
- Manual path in `README.md`.
- Auto-start: a Startup-folder shortcut → `wscript start-hidden.vbs` → `node server.mjs` with no window. Paths travel through environment variables, so spaces, apostrophes and accents are safe.

## 11. Tests
- `npm test`: unit tests (`test.mjs`: scheduling, status, done rules, courses, colors, exam detection including real-world negative cases, digest window, escaping) plus integration tests (`test-server.mjs`: the real server against `fixtures/fake-mcp.mjs` covering normal, expired sign-in, hang + process kill, one course refusing, API guards, persistence across restarts, corrupt files, busy port).
- `test-e2e.mjs`: clicks through the page in Firefox and Chromium with Playwright (dev-only, not a dependency).

## 12. Out of scope
Grades view, discussions, multi-user, macOS/Linux.
