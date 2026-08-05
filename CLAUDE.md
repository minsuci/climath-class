# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

**CLIMATH 수업** — a class-management web app for a Korean high-school math academy
(학원). Students check in, submit questions, track homework progress, and get AI hints;
teachers run attendance, notices, consultation records, progress plans, lecture notes,
and monthly parent-facing reports.

The entire UI is **one file**. There is no build system, no `package.json`, no test suite.

```
climath-class/
├── index.html      # the whole app: CSS + React source + bootstrap (~4,100 lines)
└── api/hint.js     # Vercel serverless function → Google Gemini (AI hint tutor)
```

Everything is in Korean: UI strings, comments, and domain terms. Keep it that way — write
new user-facing strings and code comments in Korean, matching the existing tone (친근한
반말/존댓말 혼용 as already used per screen).

## Architecture: build-less React

`index.html` is loaded directly by the browser and has four parts:

| Lines (approx) | Part |
|---|---|
| 7–292 | `<style>` — all CSS, hand-written, no framework |
| 297–308 | CDN `<script>` tags: React 18.3.1 UMD, Babel standalone 7.25.6, Firebase 10.12.0 compat, KaTeX 0.16.9 |
| 310–322 | Inline `firebaseConfig` + `firebase.initializeApp` → `window.db` |
| 324–4077 | **`<script type="text/plain" id="__appSource">`** — the actual app source (JSX) |
| 4079–4103 | Bootstrap: reads `#__appSource`, runs `Babel.transform(src, {presets:["react"], sourceType:"script"})`, injects the output as a real `<script>` |

### Rules that fall out of this

- **Edit `index.html` in place.** Do not introduce a bundler, npm, TypeScript, or split the
  file into modules unless explicitly asked. A "small refactor into src/" would break
  deployment.
- The app source is transformed with the **`react` preset only** and `sourceType: "script"`.
  That means:
  - **No `import` / `export`.** Everything is a top-level `const` / `function` in one
    shared scope.
  - Only JSX is compiled. Any other syntax must be natively supported by the target
    browsers. Optional chaining (`activeDms[r.id]?.active`), spread, and async/await are
    already used and are fine; don't rely on anything newer without checking.
  - Names collide globally — check before adding a new top-level identifier.
- React is used via globals: `const { useState, useEffect, useRef } = React;` at the top of
  the app source. `React.useMemo`, `React.useRef`, `React.createContext` etc. are called
  through the `React` namespace elsewhere; both styles exist.
- Because the source lives inside a `text/plain` block, an unbalanced `</script>` anywhere
  in a string will terminate the block early and blank the app. Avoid literal `</script>`
  in the app source.
- Startup is: anonymous Firebase auth → `loadClasses()` → `ReactDOM.createRoot(...).render(<App />)`,
  with a 4-second `setTimeout(loadAndRender, 4000)` fallback if auth never resolves.
  `renderApp()` is idempotent via the `rendered` flag.

## Routing & entry points

There is no router. `App()` reads `window.location.search`:

- `?admin=1` → `<AdminView />` (teacher console)
- `?class=<classId>` → `<StudentView cls=… />` (direct link into one class)
- otherwise → `<StudentGate />` (name + PIN login, then pick class if the student is in several)

## Auth model (client-side only — treat as convenience, not security)

- **Students**: name (whitespace-stripped via `normName`) + 4-digit PIN.
  `verifyPersonPin(name, pin, candidates)` checks, in order:
  1. unified PIN at `userPins/{normalizedName}`
  2. per-class PIN at `classes/{cid}/students/{sid}.pin` — on success it is **migrated** up
     to `userPins`
  3. `member.defaultPin` or `DEFAULT_PIN` ("1234"), which is deliberately *not* persisted
- **Teachers**: `teachers` collection, `{name, pin, classIds, role, status, time}`.
  `role: "owner"` sees everything and can manage teachers; other teachers only edit classes
  in `classIds` (`canEdit()` in `AdminView`). `status: "pending"` blocks login until an
  owner approves. Session survives reloads via `sessionStorage["climath_teacher"] = tid`.
  If the `teachers` collection is empty, an owner "한민수" is auto-created with `ADMIN_PIN`.
- `DEFAULT_PIN = "1234"` and `ADMIN_PIN = "2030"` are hardcoded constants, and the Firebase
  web config is inline in `index.html`. All checks run in the browser. **Do not add anything
  that needs real secrecy to `index.html`** — server-side secrets belong in `api/` behind
  Vercel environment variables (see `api/hint.js`).

## Firestore data model

Firebase **compat** SDK (`firebase.firestore()`), reached through the module-level `db`.
Helper accessors are grouped at `index.html` ~line 405 onward — prefer them over writing raw
paths.

```
classes/{cid}                       { name, classDays:[0-6], roster:[…], books:[…],
                                      type:"regular"|"individual", order, merge:{partnerId,days}, time }
  days/{YYYY-MM-DD}                 { updated }              ← touchDay() marks a date as "used"
    attendance/{sid}                { name, time, byTeacher? }
    questions/{auto}                { sid, name, book, num, memo, time, resolved, fromCid, fromClass }
    scores/{auto}                   { … }
  homework/{sid}                    { name, books: { [bookName]: [numbers…] } }   ← cumulative
  questioned/{sid}                  { name, books: { [bookName]: [numbers…] } }   ← arrayUnion/Remove
  students/{sid}                    { pin }                  ← legacy per-class PIN
  config/notice                     { text, time, active }   ← class-wide banner
  dms/{sid}                         { text, time, active }   ← per-student banner
  makeups/{sid}_{date}              { sid, sname, date, planned?, videoDone?, updated }
  dailyNotes/{sid}_{date}           { sid, sname, date, text, teacher, time }
  progress/{key}                    { name, mime, size, chunks, time }  + parts/{i}.data
  noteUnits/{uid}                   { title, time }
    files/{fid}                     same file-chunk shape as progress
  aiLogs/{auto}                     { sid, name, q, a, img, time }

userPins/{normalizedName}           { pin, time }
teachers/{tid}                      { name, pin, classIds, role, status, time }
consultations/{auto}                { cid, sid, sname, date, cat, withWho, content, risk,
                                      needFollow, followDone, followNote, teacher, time }
reports/{cid}_{sid}_{YYYY-MM}       { …buildReportData output, comment, hwSnapshot }
```

Notes:

- **Dates are `"YYYY-MM-DD"` strings everywhere.** Comparison and month filtering are done
  with string `<`, `>`, and `.startsWith(ym)`. `ymd(Date)` produces them; `todayStr` is
  computed once at load. Parse back with `new Date(d + "T00:00:00")` to stay in local time.
- **No Firebase Storage.** Files (PDF/HTML/image, progress plans and lecture notes) are
  base64-encoded and split into 700,000-char chunks written to a `parts` subcollection, with
  metadata on the parent doc. `PROGRESS_MAX_BYTES = 4.5MB` is the hard cap. Use
  `saveFileToDoc` / `loadFileB64FromDoc` / `deleteFileDoc`; deleting a doc without its parts
  leaks orphans.
- **`CLASSES` is a module-level mutable array**, not React state. `loadClasses()` refills it
  and every mutating class helper (`createClass`, `saveClassRoster`, `saveClassBooks`,
  `saveClassOrder`, `saveClassMeta`, `setMerge`, `deleteClass`) awaits it before returning.
  Components force a re-render afterwards with a version counter (`bumpVer`) or by resetting
  local state. If you add a class-level write, call `loadClasses()` too.
- **Seeding**: if `classes` is empty on first load, `SEED_CLASSES` is written once. Those
  seed rosters contain real student names — don't extend the seed list with new people.
- **Migration pattern**: `loadClasses()` backfills a missing `books` field in place. Follow
  the same shape (read → detect missing → write) for future schema additions; there are no
  migration scripts.
- Class-day / enrollment logic: `isActiveOn` (startDate/endDate window), `isEnded`,
  `attendsOn` (weekday for `type:"individual"` classes, always true for regular classes),
  `getStudentBooks` (per-student books for individual classes, class books otherwise).
- **합반 (merged classes)**: on merge days, questions are funnelled into a single
  "representative" class — `questionCid(cls, date)` returns the alphabetically-first of the
  two ids. Always route question reads/writes through it; `fromCid`/`fromClass` on the
  question preserve the origin.

## The AI hint endpoint

`api/hint.js` is a Vercel serverless function (`export default async function handler`).

- Model: `gemini-2.5-flash-lite`, called over plain `fetch` — no SDK dependency.
- Key: `process.env.GEMINI_API_KEY`, set in Vercel → Settings → Environment Variables.
  Never inline it or ship it to the client.
- The client (`AIChat`) sends **Anthropic-shaped** `messages` (`content` as a string, or an
  array of `{type:"text"}` / `{type:"image", source:{type:"base64",…}}`). The handler
  converts to Gemini `contents` (`assistant`→`model`, `image`→`inline_data`). If you change
  one side's message shape, change the other.
- History is trimmed to the last 12 messages; `maxOutputTokens: 700`, `temperature: 0.7`.
- The system prompt's core constraint: **give hints only, never the final answer**, even when
  the student insists. Preserve that behavior in any edit.
- Non-teacher chats are logged to `classes/{cid}/aiLogs` and shown to teachers under
  "AI 질문"; students are told so in the UI. Teacher chats are not logged.
- Client-side image cap is 4MB.

## UI conventions

- CSS class prefixes: `cm-` for the app, `rp-` for the printable report sheet. All styles are
  in the single `<style>` block, scoped loosely under `#root`.
- Palette lives in CSS variables on `#root`: `--navy`, `--navy2`, `--cream`, `--paper`,
  `--clay`, `--ink`, `--muted`, `--green`, `--line`. Use them instead of new hex values.
  Fonts: Fraunces (logo/headings), Noto Sans KR (body).
- Mobile-first: content column is `max-width: 560px`; the breakpoint is **860px**, above
  which the sidebar is always visible and below which it becomes a hamburger + backdrop.
- Navigation is a `Sidebar` component driven by an `items` array (`{key, ico, label, disabled}`,
  plus `{sep:true}` and `{group:"…"}`), coordinated through the `SideCtx` React context.
  Icons are plain unicode glyphs, not an icon font.
- `useSwipeBack(onBack)` returns a **ref callback** (not a hook result to spread) that adds
  right-swipe-to-go-back on touch devices. Opt a subtree out with `data-no-swipe`.
- `MathText` renders `$…$`, `$$…$$`, `\(…\)`, `\[…\]` through KaTeX with HTML-escaping of
  everything else, then `dangerouslySetInnerHTML`. It degrades to escaped plain text if KaTeX
  failed to load (`window.__katexFailed`). Any new AI/teacher free text that may contain math
  should go through it.
- The monthly report (`ReportSheet`) is designed for **A4 print**: `@media print` hides chrome,
  sets `@page { size: A4; margin: 14mm }`, and page-breaks between sheets. Mark anything that
  shouldn't print with `rp-noprint`.
- Realtime data uses `onSnapshot` inside `useEffect` and **always returns the unsubscribe**.
  Follow that pattern; leaked listeners are the easiest bug to introduce here.

## Component map

Rough reading order inside `#__appSource`:

- Helpers & Firestore accessors — dates, class/enrollment predicates, all `*Col`/`*Doc`
  builders, auth helpers, file chunking, `buildReportData`, `computeRiskData`, merge logic
- Shared UI — `HwGrid`, `BookHwCard` (drag/long-press homework number grids), `Sidebar`, `MathText`
- Student side — `StudentGate`, `StudentView`, `StudentHome` (tabs: 출석 / 질문 / 과제 / 점수 /
  진도계획표 / 강의노트 / AI 힌트), `ChangePin`, `QuestionForm`, `StudentHomework`, `ScoreForm`,
  `StudentProgressView`, `AIChat`
- Teacher side — `AdminView` (login, class list, global menu), `AdminDays` (per-class views:
  날짜별 / 월간 출석부 / 공지 / 진도표 / 강의노트 / AI 질문 / 상담 / 반 설정), `AdminDay`,
  `StudentDetail`, `AttendanceBook`, `QuestionQueue`, `DailyNoteCard`
- Cross-class tools — `ReportCenter` / `ReportSheet` / `ReportNoteEdit`, `MakeupCenter`,
  `RiskDashboard`, `ConsultView` / `ConsultForm`, `AILogView`, `TeacherManage` / `TeacherRegister`
- Config — `BookManager`, `RosterManager`, `StudentConfig`, `MergeManager`, `ClassMetaEditor`,
  `ClassCreate`, `ProgressManager`, `NotesManager`
- `App` root + bootstrap

Two gating concepts worth knowing: students must check in before 질문/과제/점수 tabs unlock
(`noGateTabs = ["prog","notes","ai"]` are always open), and teachers with view-only access get
`canEdit={false}` threaded down into every editor component.

## Development workflow

- **No build, no install, no tests.** There is nothing to run before committing.
- To preview the UI, open `index.html` in a browser (or serve the directory). It talks to the
  **live production Firebase project** — any write you make while testing is real data. Be
  careful with roster, class, and delete operations.
- `/api/hint` only exists when served by Vercel; use `vercel dev` from the repo root if you
  need the AI tab. Locally without it, the chat shows an error bubble — that's expected.
- Deployment is Vercel from the repo root (static `index.html` + `api/` functions), triggered
  by pushes to `main`. There is no `vercel.json`.
- Verify changes by reading the diff carefully and reasoning through the flow; a syntax error
  inside `#__appSource` produces the "앱 로딩 오류" screen rather than a build failure, so
  double-check JSX and string escaping.
- History is mostly single-file edits with messages like `Update index.html` /
  `index.html 업데이트`. Prefer a short descriptive message over that pattern.

## Gotchas

- `index.html` is ~214KB; read the region you need rather than the whole file.
- `todayStr` is captured at page load. A session left open across midnight keeps the old date.
- Homework and 질문 numbers are **cumulative and never reset per day** — that is intended.
- Firestore has no security rules enforcing the roles above; the same anonymous auth user can
  read everything. Don't build UI that implies stronger guarantees than exist, and flag it
  rather than silently "fixing" it with client-side checks.
- `deleteClass` only deletes the class document and scrubs the id from every teacher's
  `classIds` — all subcollections (`days`, `homework`, `progress`, `noteUnits`, …) are left
  orphaned in Firestore. Only `deleteNoteUnit` / `deleteFileDoc` do proper recursive cleanup
  of their `parts`. Keep that in mind before adding new nested data.
