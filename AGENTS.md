# Academic Dashboard: instructions for AI coding agents (Claude Code, Codex, and others)

A local Brightspace dashboard for Purdue students. **Windows only.** It runs a small Node server on `http://localhost:4321` that reads Brightspace through `brightspace-mcp-server`, refreshes every 3 hours plus at midnight, and sends Windows notifications. Design: `spec.md`. User docs: `README.md`.

## When the user asks to "set up" / "install" the dashboard

Walk them through it step by step. Keep messages short and plain; the user may not be technical. Run the commands yourself. Stop and explain if a step fails. Don't skip ahead. Work from **this folder** (the one containing `package.json`).

### Sandboxes and approvals (read this first; it matters for Codex)
Several steps need the **internet**, or must run **outside a sandbox**, or both:

| Step | Needs |
|---|---|
| `winget …`, `npm install`, `npm run check`, the Brightspace sign-in window | internet access |
| starting the dashboard (`install-autostart.cmd` / `start.cmd`) | outside the sandbox: the server has to keep running after you finish, and it needs the internet to reach Brightspace |

- **Codex:** these commands will ask for approval (network or escalated permissions), and the user should approve them. If the sandbox blocks a step anyway, don't work around it. Tell the user to either run `/permissions` and allow network/full access for this session, or do that one step themselves (each step below says how). **Never start the server from inside a network-less sandbox**: it would look like it's running but could never reach Brightspace.
- **Claude Code:** approve the permission prompts; nothing else is special.
- If you're unsure whether a step worked, check it (each step has a check). Don't assume.

### 1. Check Windows and Node.js
- Run `node --version`. Need **v20 or newer**.
- If Node is missing or too old, install it (needs internet and approval):
  `winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements`
  - The current shell won't see `node` afterwards. For the rest of setup, either prepend `C:\Program Files\nodejs` to PATH in each command or call `"C:\Program Files\nodejs\node.exe"` / `"C:\Program Files\nodejs\npm.cmd"` directly.
  - If `winget` is unavailable or blocked, send the user to https://nodejs.org (LTS installer, default options), wait until they confirm, and ask them to restart the agent session so `node` is on PATH.

### 2. Install and self-test
- `npm install` (one dependency, `@modelcontextprotocol/sdk`; needs internet).
- `npm test`. **Every test must pass.** The tests use a fake Brightspace and don't touch the user's account, the internet, or their screen.

### 3. Connect Brightspace (the user signs in; you never see their password)
- Run `npm run check`. If it prints `OK: connected to Brightspace …`, skip to step 4.
- Otherwise open the sign-in wizard in its **own visible window** (it's interactive and needs a real console):
  `cmd /c start "Brightspace setup" cmd /k npx -y brightspace-mcp-server@latest setup --purdue`
  If your sandbox can't open windows, have the user open **Command Prompt** (Start → type `cmd`) and paste that same `npx -y brightspace-mcp-server@latest setup --purdue` command themselves.
- Tell the user:
  1. A black window opened. Type `y` if it asks to install anything.
  2. Enter your Purdue username and password **in that window**, never in this chat. They're saved in Windows Credential Manager.
  3. For MFA pick **number matching / approval**, then approve the number on your phone.
  4. If it offers to configure AI apps, that's optional (it lets you ask your AI assistant about your courses).
  5. Tell me when it says it's done.
- Then run `npm run check` again. It must print `OK … N active course(s)`. If it reports a sign-in problem, repeat with `npx -y brightspace-mcp-server@latest auth` in a new window.
- **Never** ask for, type, log, or read the user's password, MFA codes, or Windows Credential Manager entries.

### 4. Start it (outside the sandbox)
- Ask: "Start the dashboard automatically whenever you log in? (recommended)"
  - Yes → run `install-autostart.cmd` (adds a Startup-folder shortcut, no admin needed; also starts it now and opens the browser).
  - No → run `start.cmd`.
  - If you can't run these outside a sandbox, ask the user to **double-click** `install-autostart.cmd` (or `start.cmd`) in File Explorer instead.
- **Check** that it's up: `curl -s http://localhost:4321/api/data`. The first refresh takes **about 2 minutes**; poll until `"refreshing":false`.
  - `refreshedAt` set and `lastError` null → report how many courses and items loaded.
  - `lastError.kind == "auth"` → back to step 3.
  - `lastError.kind == "network"` and the server was started from a sandbox → it has no internet. Run `stop.cmd`, then have the user double-click `start.cmd`.
- If nothing answers on port 4321, read `data\server.log`.

### 5. Wrap up
Tell them briefly:
- Bookmark **http://localhost:4321**.
- **⚙ Settings → Notifications**: when Windows starts and after every 3-hour refresh they get one Windows notification listing what's due today and early tomorrow (before 10 AM). "Send a test notification" is there too. Optional features live in ⚙ Settings → Features. If nothing appears: Windows Settings → System → Notifications → allow "Windows PowerShell".
- **+ Add task** (or press N) for things Brightspace doesn't track, like homework on WebAssign/Achieve. Tick "This is an exam" for exams.
- Exams found in Brightspace (quizzes named "Exam 2", "Midterm"…, or exam dates in announcements) show in gold on the calendar.
- When the Brightspace sign-in expires, a sign-in window opens by itself: approve the number on the phone and the dashboard refreshes when it closes. If it was dismissed, the red "sign-in needed" banner's **Sign in** button reopens it.

## When the user asks to "update" the dashboard
The dashboard updates itself: when a newer release exists, an **Update available** button appears in its header; **Update now** downloads the release, keeps `data\`, backs up the old files to `data\backup-v<old version>\`, and restarts. Point the user there first. Do it by hand (below) only if that fails, or if they ask you to.

Latest release: https://github.com/lflowers01/academic-dashboard/releases/latest (asset `academic-dashboard.zip`). Their data lives in `data\` and must be kept.
1. Compare `"version"` in this folder's `package.json` with the latest release's tag. If they match, say it's up to date and stop.
2. Run `stop.cmd`.
3. Download `https://github.com/lflowers01/academic-dashboard/releases/latest/download/academic-dashboard.zip` to a temp folder and extract it (it contains one `academic-dashboard\` folder).
4. Copy everything from the extracted `academic-dashboard\` over this folder. **Never delete or overwrite `data\`** (the release has no `data\` folder, so a plain copy keeps it). Don't delete `node_modules\`.
5. `npm install`, then `npm test` (every test must pass).
6. Start it again: `start.cmd` (outside any sandbox, same as setup step 4). Check `http://localhost:4321/api/data` responds, and tell them what's new (the release notes on GitHub).

## Everyday questions users may ask you
- "Is it running?" → `curl -s http://localhost:4321/api/data`. Otherwise run `start.cmd` (outside the sandbox).
- "Stop it" / "uninstall" → `stop.cmd` / `uninstall-autostart.cmd` (then the folder can be deleted).
- "Port 4321 is taken" → `setx DASH_PORT 5055` (any free port), then `stop.cmd` and `start.cmd` in a **new** window (setx only affects new windows) and use http://localhost:5055. All scripts and the server honor `DASH_PORT`.
- Logs: `data\server.log`. The user's cache, tasks and settings: `data\` (never share or commit it).

## If the user wants Google Calendar
Optional, off by default: ⚙ Settings → Features → Google Calendar → Connect. It runs `claude -p` headless (Haiku) with the claude.ai Google Calendar connector, so it needs Claude Code on PATH, signed in, and the connector connected at claude.ai → Settings → Connectors. Codex isn't supported for this feature yet. Settings shows exactly what's missing. Design: `spec-google-calendar.md`.

## If the user wants Grades
Optional, off by default: ⚙ Settings → Features → Grades (a Grades tab). No Claude needed. The math is `gradeFor` / `needFor` in `logic.mjs`; the student's setup per class lives in `state.grades`. Brightspace grade rows include category totals that count ungraded work as 0; `markCategoryTotals` leaves them out. Design: `spec-next-features.md` §3.

## If the user wants Syllabus scan
Optional, off by default: ⚙ Settings → Features → Syllabus scan. Same requirement as Smart Announcements (Claude Code, signed in). Sources: Brightspace (`get_syllabus`, plus course-content files titled like a syllabus/schedule, downloaded to `data\syllabi\brightspace\`) and files the user adds (`data\syllabi\added\<courseId>\`). Text: `syllabus-text.mjs` (PDF via **unpdf**, which needs Node.js 22+; .docx via PowerShell's zip reader; HTML). Design: `spec-next-features.md` §2.

## If the user wants Smart Announcements
Optional, off by default: ⚙ Settings → Features → Smart Announcements. Same requirement as Google Calendar (Claude Code on PATH and signed in; no connector needed). It runs `claude -p` on Haiku with no tools, announcement text on stdin, and checks every suggestion in `verifyFound` (`logic.mjs`). Design: `spec-smart-announcements.md`.

## Working on the code
- The **Study on Boilerexams** button is automatic: the server fetches Boilerexams' course list (`api.boilerexams.com/courses`) on start-up, every 6 h, and whenever a new exam appears, then matches courses in `boilerexamsKey` (`logic.mjs`). Never hard-code a course list; if a course exists there, its exams get the button, otherwise none.
- `npm test` must pass: `test.mjs` holds the unit tests, `test-server.mjs` runs the real server against `fixtures/fake-mcp.mjs`, `test-gcal.mjs` runs the Google bridge against `fixtures/fake-claude.mjs`, `test-smart.mjs` runs Smart Announcements against `fixtures/fake-smart.mjs`, `test-syllabus.mjs` runs Syllabus scan against `fixtures/fake-syllabus.mjs` (demo syllabi: `fixtures/demo-syllabi/`), `test-grades.mjs` checks the grade math on the shapes of real gradebooks. Browser tests: `test-e2e.mjs`, `test-e2e-gcal.mjs`, `test-e2e-smart.mjs`, `test-e2e-syllabus.mjs`, `test-e2e-grades.mjs`, `test-e2e-update.mjs`.
- Headless Claude runs (Smart Announcements, Syllabus scan) go through `claude-json.mjs`: no tools, input on stdin, thinking off. Every answer is checked against the source text (`verifyFound`, `verifySyllabusEvent`, `verifyGrading` in `logic.mjs`). `npm run demo` serves fictional data from `data-demo/`.
- `logic.mjs` is shared by the server, the browser and the tests (`viewModel`, status, exams, digest). Keep rules there, in one place.
- In-app updates live in `update.mjs` (checks the GitHub releases API daily; never updates a folder with `.git`). Tests: `test-update.mjs` does a real update of a throwaway copy against a fake GitHub.
- Test hooks (env vars): `DASH_PORT`, `DASH_DATA`, `DASH_MCP_CMD` (JSON array command for a fake MCP server), `DASH_TOAST_LOG` (write notifications to a file), `DASH_NOTIFY_BLOCK` (pretend Windows blocks them), `DASH_TOTAL_TIMEOUT`, `DASH_COURSE_TIMEOUT`, `DASH_GCAL_CMD` (fake Claude runner), `DASH_GCAL_TIMEOUT`, `DASH_SMART_CMD`, `DASH_SMART_TIMEOUT`, `DASH_SYLLABUS_CMD`, `DASH_SYLLABUS_TIMEOUT`, `DASH_UPDATE_API` (fake releases API; also enables update checks in demo/test servers).
- The page builds DOM with `h()` / `textContent` only. **Never** use `innerHTML` with Brightspace content (announcements, instructions and titles are external input). Notification text is XML-escaped and passed to PowerShell through environment variables, never interpolated into the command.
- Theme: pure black, high contrast, neutral white accents (no blue UI chrome), Purdue logo top-left at 26px, gold `#cfb991` exams and favicon. Course colors come from `PALETTE` in `logic.mjs` (bright, black text, ≥ 7:1 contrast).
- Windows only by design (cmd/npx, taskkill, PowerShell toasts, .vbs/.cmd launchers).
