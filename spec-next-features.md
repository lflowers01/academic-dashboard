# Next features: updates, syllabus scan, grades

Written 2026-09-19 after looking at real data (one student's 7 classes, their Brightspace grade rows, their
syllabi as PDFs, and what the Brightspace MCP server can fetch). Priority order is by how much each one helps a
student, weighed against risk. Two are **optional features** (⚙ Settings → Features, off by default); the updater is
**always on**, because friends running old versions is the main way this project fails them.

| # | Feature | Kind | Why it's first/second/third |
|---|---|---|---|
| 1 | Updates in the app | always on | Every fix only helps friends who update, and nobody remembers to. Smallest, and it protects everything else. |
| 2 | Syllabus scan | optional | One scan at the start of term fills the calendar with every exam and deadline the syllabus lists, weeks before any announcement repeats them. It also reads the grading scheme, which feature 3 needs. |
| 3 | Grades | optional | Brightspace's gradebook is often misleading (below). A per-course grade computed the way the syllabus says, plus "what do I need on the final", is what students actually want to know. |

---

## Research notes (what the data really looks like)

**Grades (from `get_my_grades`, cached every refresh):** rows are `{name, displayGrade, pointsNumerator,
pointsDenominator, weightedNumerator, weightedDenominator, comments, lastModified}`. Across 7 classes:
- **No row is an overall/final grade.** Brightspace isn't telling us the course grade; we'd have to compute it.
- **Weights are almost never there:** only an engineering-technology class (all rows) and a calculus class (9 of 11) have `weighted*`; 5 classes have none.
- **Zeros are ambiguous:** several `0/x` rows per class. Some are real zeros,
  some are "not graded yet" or "not counted", and the row alone can't say which. Averaging them in is a big reason a
  student's Brightspace number feels wrong.
- **Syllabi use two different schemes:** a calculus class is *weighted categories* (Quizzes 1%, Workshop Notes 15%, Midterms
  14/15/15%, Final 15%, and a 25% row whose label is lost in text extraction); a chemistry and a speech class are *total points*
  ("Total score ≥ 93% → A"). A plain points average is wrong for a calculus class; a plain average of percentages is wrong for chemistry.
- **Letter scales differ** between classes (e.g. an A from 92% in one class and 93% in another; one class has A+), so "what do I need
  for a B" must use the course's own scale, with a common default when unknown.

**Syllabi:**
- `get_syllabus` (course overview) had real text for only 1 of 7 classes (a chemistry class's schedule with exam dates).
- The real syllabi are **files in course content**, found by title: a "Simple Syllabus" export (a **.docx**),
  a calculus class "Course Schedule" (an **.html** page, has the midterm dates), engineering "Simple Syllabus" (a link), plus "Course
  Information" / "Syllabus" modules. `download_file` works for them. Formats: PDF, DOCX, HTML.
- Students also download the **Simple Syllabus PDFs** themselves (the student whose data was studied keeps a folder of them). Those are the most
  complete source for grading schemes and letter scales, so the page should accept dropped files too.
- Text extraction: **unpdf** (2 MB, no dependencies, Node ≥ 22) reads all 8 of those PDFs in < 0.1 s each (the 69-page
  calculus syllabus → 45k characters). DOCX: it's a zip; Windows' own .NET `ZipFile` (via PowerShell) reads `word/document.xml`
  with no new dependency. HTML: the existing `htmlToText`. Tables come out scrambled (a percentage row can lose its label), so
  **a person must confirm weights**; Claude reads the text, the student approves the result.
- Exam dates in syllabi are often "TBA" (finals) or live in a separate schedule; the scan must accept "no date".

**Updates:** `https://github.com/lflowers01/academic-dashboard/releases/latest` answers with a 302 to the newest
tag (no API, no rate limit); the API (`/repos/…/releases/latest`, 60 requests/hour unauthenticated) gives the notes and
asset URL. The release asset is `academic-dashboard.zip` containing one `academic-dashboard/` folder (made with
`git archive`, so no `data/`).

---

## 1. Updates in the app (always on)

**Goal:** a friend never has to know how updating works. Being out of date is visible but quiet, and updating is one click.

**UX**
- When a newer release exists: a small gold **"Update available"** pill in the header (left of ↻ Refresh), and the
  Settings dot. Nothing modal, nothing on the calendar.
- Click it → a dialog: "v1.4.2 is available (you have v1.4.1)", the release notes (rendered as plain text, not HTML),
  and one primary button **Update now**. Secondary: **Later** (hides the pill for 3 days, then it's back; you can't
  permanently dismiss updates, on purpose) and "or ask Claude/Codex in the folder: *update the dashboard*".
- **Update now** → the dialog shows steps with a spinner: Downloading → Checking → Installing → Restarting. The page then
  waits for the server to come back and reloads itself, showing "Updated to v1.4.2 ✓".
- Once per new version, the next Windows notification digest gets one extra line, "Dashboard update available", so
  friends who rarely open the page still hear about it.
- Settings → a small "About" line: "Version 1.4.1 · up to date (checked 9:14 AM) · Check now".

**How it works**
- Server checks at start-up and every 24 h (and on "Check now"): follow the `/releases/latest` redirect, read the tag,
  compare with `package.json` as semver. On a newer tag, fetch the API once for notes and the asset URL. Cached in
  `data/update.json`. Offline or GitHub errors → keep quiet, try again next time.
- **Update now** (`POST /api/update`, JSON-only like every write):
  1. Download the asset, only from `github.com` / `objects.githubusercontent.com` (follow redirects only to those hosts),
     size cap 20 MB.
  2. Extract to a temp folder with PowerShell `Expand-Archive`. It must contain `academic-dashboard/package.json` whose
     version equals the tag. Otherwise stop.
  3. Back up the current install (everything except `data/` and `node_modules/`) to `data/backup-<version>/`, so a
     broken update can be rolled back by hand (AGENTS.md explains how).
  4. Copy the new files over the install folder with `robocopy`, excluding `data` and `node_modules`. Delete files that
     are no longer in the release? **No**: leftovers are harmless, a wrong delete isn't.
  5. If `package-lock.json` changed, run `npm install` (hidden). If it fails, restore the backup and report the error.
  6. Restart: start `start-hidden.vbs` detached, then exit. The new server takes the port once the old one is gone
     (the start script already waits/retries).
- **Never self-update a git checkout** (a developer folder has `.git`): the pill says "Update available (this is a git
  checkout — pull instead)" and the button is disabled. This protects the author's own working folder.
- Test hooks: `DASH_UPDATE_URL` (a fake "latest" endpoint), `DASH_UPDATE_DRYRUN` (no restart).

**Risks and answers:** a half-copied update → the backup + the fact that the copy only overwrites files; a bad release →
same trust as installing it by hand, and the version check refuses a mismatched zip; running from a read-only or
OneDrive-locked folder → the copy fails, nothing restarts, and the error says what to do.

**As built (2026-09-19)** — differences from the plan above: the check uses the releases API only (one call a day is far
under the limit); no Settings dot (it would fight the notifications dot; the header pill is enough); the restart starts
`node server.mjs` detached with `DASH_WAIT_PORT=1`, and the new server retries the port for up to 30 s while the old one
exits; a failure after copying restores the backup automatically; demo and test servers never call GitHub unless
`DASH_UPDATE_API` points them at a fake. `test-update.mjs` performs a real update of a throwaway install (download →
check → backup → copy → restart as the new version, ~5 s) and checks the refusals (mismatched version, git checkout).

---

## 2. Syllabus scan (optional feature)

**Goal:** at the start of term (or whenever the student turns it on), every dated item in each class's syllabus lands on
the calendar the same careful way Smart Announcements does it, and each class's grading scheme is captured for Grades.

**UX**
- ⚙ Settings → Features → **Syllabus scan**. Its settings section lists this term's classes, one row each:
  `a chemistry class · Found in Brightspace: "Course Information" · scanned Sep 19 · 3 exams, 12 deadlines, grading ✓ confirmed`
  with **Rescan**, and **Add a syllabus file** (PDF/DOCX/HTML, or drag files onto the section). Dropped files are
  matched to classes by the course code in the file name (e.g. `…-chemistry-(WL)-11510-…` → a chemistry class), else a picker asks.
- Found events go through the same review card, titled **Found in syllabi** (collapsed by default, like announcements),
  with the same Accept / Edit / Decline and "Might be the same as". Sure events from a class are added directly, marked ✦.
- Found grading schemes are **never used silently**: Grades shows "Syllabus says: Quizzes 1%, Workshop Notes 15%, … ·
  Use this" until the student confirms or edits it.

**How it works**
- Sources per class, in order, all optional: (a) `get_syllabus` text; (b) course content topics whose title looks like a
  syllabus/schedule (`/syllabus|course (schedule|information|info)|schedule of/i`), downloaded with `download_file`
  into `data/syllabi/<courseId>/`; (c) files the student added. Text: unpdf / DOCX-via-PowerShell / htmlToText, capped
  at 120k characters per class.
- One headless `claude -p` run **per class** (Haiku, no tools, text on stdin, thinking off; same runner rules as Smart
  Announcements). It returns `{events: [...same shape as Smart Announcements...], grading: {type: "weighted"|"points",
  components: [{name, weight?, points?, quote}], scale: [{letter, min}], quote}}`.
- Every event is checked with `verifyFound` against the syllabus text (quote must be in it), skipped if it repeats a
  Brightspace item / known exam / earlier find (`sameEvent`), and placed with `smartStatus`. Grading components must have
  their quote in the text and weights 0–100; the sum is shown (warn if it isn't 100 ± 1).
- Runs: once per class when the feature is turned on, again only on Rescan or a new file (syllabi don't change weekly).
  Cost estimate: ~$0.01–0.05 per class (calculus's 45k characters ≈ 12k tokens in).
- Storage `data/syllabus.json`; events become items of kind `event` with `source: 'syllabus'`.
- **Shared code with Smart Announcements:** the runner and the review card are reused, not copied.

---

### As built (2026-09-19), and what the real-data runs changed
Run end-to-end against a real Brightspace account and 7 real syllabi (on a throwaway data folder): 7 classes read in
~3.5 min for ~$0.10–0.25, grading schemes for 5 of 7 classes (one weighted = 100%, four by points, with letter scales), and the calculus class's 3 midterms, final and 7 quizzes, chemistry's Exams 2–3, the engineering class's deadlines and the lab's
no-lab weeks placed on the calendar; exams already known from announcements and deadlines already in Brightspace were skipped.
- **Quotes from PDF tables** don't come out in reading order, so the syllabus quote check (`quoteInText`) accepts a quote whose
  words all appear, in order, within a short stretch of the text (still no invented text).
- **Regular sessions aren't events:** a "class-change" must say no class / cancelled / break (calculus listed 14 "Workshop N" rows).
- **What blocks adding without asking** (`blocksAdding`, also used by Smart Announcements now): a missing date always; a
  missing time only for exams (not quizzes), review and help sessions; a missing room never.
- **Accept all** in the review card (both features) for long lists — a chemistry lab's syllabus has 18 prelab/report deadlines
  that aren't in Brightspace.
- Counts per class are current totals, not the last scan's additions.
- The shared runner is `claude-json.mjs`; the prompt is `syllabus-prompt.mjs`.

## 3. Grades (optional feature)

**Goal:** answer "what's my grade in each class, really, and what do I need?" with the syllabus's own rules, and be
honest about what's uncertain.

**UX**
- ⚙ Settings → Features → **Grades** adds a **Grades** tab next to Announcements.
- One card per class: big current grade (e.g. **88.4% · B+**), a one-line basis ("Weighted by your syllabus" / "Total
  points" / "Simple average — set up weights for a real number"), and how much of the course is graded so far
  ("37% of your grade is in").
- Open a card → its rows grouped by category, each with score, % and a small **"not graded yet?"** toggle on 0-score rows
  (turning it on leaves the row out). **What-if:** click any score to try a different one (never saved to Brightspace,
  shown in italics with a Reset).
- **What do I need?** Pick a target letter from the course's scale → "You need **81%** on everything left" or, when a
  final exam category exists and is ungraded, "**74%** on the Final gets you a B+". Impossible (> 100%) and already safe
  (≤ 0%) are said in words.
- **Set up weights** (per class): categories with a %; each Brightspace row assigned to a category (auto-guessed by name,
  changeable). Pre-filled from the syllabus scan when available ("Use syllabus weights"). Or "This class uses total points".
- Always visible fine print: "An estimate from Brightspace scores and your syllabus; your instructor's gradebook is official."

**How it works**
- Pure math in `logic.mjs` (`gradeFor(rows, scheme, overrides)`), unit-tested with the three real scheme shapes:
  - points: Σ earned / Σ possible over counted rows;
  - weighted: per category, Σ earned / Σ possible; course = Σ(weight × category%) / Σ(weights of categories with grades);
  - need: `(target × totalWeight − earnedWeighted) / remainingWeight`.
- Rows with `pointsDenominator` 0 are ignored (they're placeholders). Per-row overrides (ignore / what-if) and schemes
  live in `state.grades` (the student's own data, saved like notes).
- Default letter scale when the syllabus doesn't give one: Purdue's common 93/90/87/83/80/77/73/70/67/63/60.

---

## Build order and rollback
1. Updates (always on) — one commit.
2. Syllabus scan — one commit (+ unpdf dependency, loaded only when the feature runs).
3. Grades — one commit.
Each is revertable on its own; features 2 and 3 are off by default. Nothing is released until the author says so.
