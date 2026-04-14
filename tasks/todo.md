# Implementation Plan — CCA Foundations Learning App

Source of truth: `spec.md` (280 lines) and `CLAUDE.md`. Every task below traces back to a numbered FR / NFR / RD / AT. Work proceeds phase-by-phase; each phase ends in a working, verifiable increment. After any phase, we stop, verify, and re-plan if something drifted.

**Verification discipline** (per CLAUDE.md §4): A task is not checked off until the success criterion stated with it is demonstrated. Acceptance Tests (AT1–AT19) are the final gates.

---

## Phase 0 — Project Bootstrap

**Goal**: Empty-but-runnable Next.js + TS + Tailwind + SQLite project, with the `.claude/` dev-time dogfooding setup in place from day one.

- [x] Initialize Next.js 16 app (App Router, TypeScript, Tailwind) in repo root — `@latest` gave 16.2.3, not 15; see Phase 0 review
- [x] Install deps: `@anthropic-ai/sdk`, `drizzle-orm`, `better-sqlite3`, `drizzle-kit`, `zod`, `unpdf`, `recharts` (OD1 resolved) + dev: `vitest`, `tsx`, `@types/node@^22`
- [x] Add `.env.example` listing required vars (`ANTHROPIC_API_KEY` is *set at runtime via UI*, not env — env holds only `DATABASE_URL` and model defaults)
- [x] `.gitignore`: `/data/*.sqlite`, `.env`, `.next`, `node_modules`, `coverage` (+ `!.env.example` exception, + SQLite journal/WAL patterns)
- [x] Create `.claude/skills/grade-scenario.md` (stub with frontmatter; body filled in Phase 10)
- [x] Create `.claude/skills/generate-question.md` (stub with frontmatter; body filled in Phase 6)
- [x] Create `.claude/commands/ingest.md` wrapping `npm run ingest`
- [x] Create `.claude/rules/prompts.md` with `paths: ["prompts/**/*.md"]` (conventions stub)
- [x] Create `.claude/rules/tools.md` with `paths: ["lib/claude/tools/**/*.ts"]` (conventions stub)
- [x] `tasks/lessons.md` created (seeded empty — will accrue via §3 Self-Improvement Loop)
- [x] `npm run dev` serves a hello-world homepage and health-check API route returns 200
- [x] Vitest wired up, one trivial test passing

**Done when**: `git clone → npm install → npm run dev` works on a fresh machine and the dev-time Claude Code setup is present (dogfoods D3.1/D3.2/D3.3).

---

## Phase 1 — Curriculum Data Layer & Ingestion (FR1)

**Goal**: The exam guide PDF becomes structured, queryable data. No UI yet.

- [x] Define Drizzle schema for: `domains`, `task_statements`, `scenarios`, `scenario_domain_map`, `questions`, `flashcards`, `preparation_exercises`, `preparation_steps`, `preparation_attempts`, `progress_events`, `mastery_snapshots`, `mock_attempts`, `tutor_sessions`, `settings` (14 tables)
- [x] Generate initial migration; commit the `.sql` file (`drizzle/0000_flashy_dexter_bennett.sql`)
- [x] TypeScript types mirror schema (via Drizzle inference in `lib/db/schema.ts`)
- [ ] Place the CCA Foundations Exam Guide PDF at `/data/exam-guide.pdf` (**blocked on user** — README documents source)
- [x] Write `scripts/ingest.ts`:
  - Parse PDF with `unpdf` (extractText + getDocumentProxy path)
  - Extract 5 domains + weights, 30 task statements (verbatim Knowledge/Skills bullets), 6 scenarios with domain mappings, 12 sample questions with explanations, 4 preparation exercises with domains-reinforced
  - One-shot Claude pass to classify each seed question's Bloom level (1–6) with justification (FR3.1) — falls back to heuristic when `ANTHROPIC_API_KEY` is absent so the re-run after Phase 2 first-run wizard refreshes classifications
  - Idempotent upsert (FR1.3): PDF-hash short-circuit + onConflictDoUpdate by primary key; re-running is a no-op
- [ ] `npm run ingest` exits 0 and reports `5 domains, 30 task statements, 6 scenarios, 12 questions, 4 exercises` (**AT1**) — **blocked on PDF**
- [ ] Re-running `npm run ingest` logs "no changes" when PDF unchanged — **blocked on PDF** (logic verified via unit test)
- [x] Unit test: parser extracts all 30 task statement IDs correctly (D1.1 through D5.6)

**Done when**: AT1 passes. `data/app.sqlite` contains the full curriculum, explorable via `drizzle-kit studio`.

---

## Phase 2 — Anthropic Client & Core Infrastructure

**Goal**: One blessed way to call Claude; API key handled safely; prompt + tool conventions locked in.

- [x] `/lib/claude/client.ts` — wraps Anthropic SDK, reads API key from `settings` table, handles model selection, supports `prompt_caching` for stable system prompts
- [x] `/lib/claude/prompts/` — filesystem-loaded prompt templates with YAML frontmatter (id, version, inputs, outputs) — lint enforced by `.claude/rules/prompts.md`
- [x] `/lib/claude/tools/` — base types for tool schemas; **mandatory** error shape `{ isError, errorCategory: 'transient'|'validation'|'business'|'permission', isRetryable, message }` (FR3.5 / AT19 / D2.2)
- [x] `/lib/claude/roles/` — per-role wrappers that compose (system prompt + tool set + model). Initial skeletons for `tutor`, `grader`, `generator`, `reviewer`. Each role's tool set is narrow (D2.3)
- [x] First-run wizard at `/settings` collects API key + default model; persists to `settings` table; **redacts on response** (FR5.1–5.3, **AT10**)
- [x] API key rotation endpoint; no old key ever returned to the browser
- [x] Token/cost accounting skeleton: every call logs `{ model, input_tokens, output_tokens, cache_*, cost, duration, ts }` — used by spend page later
- [x] Unit tests: (a) tool-result with malformed shape is rejected; (b) API key never appears in server logs (console spy during set/get cycle)

**Done when**: Can make a hello-world Claude call from a test route. `curl`-ing that route's response body and inspecting the Network tab confirms the key is never exposed. (**AT10**)

---

## Phase 3 — Progress Events & Bloom Ladder Core (FR4 foundation)

**Goal**: The write path for every graded interaction exists, and the math is correct — even though no modality is writing to it yet.

- [x] `progress_events` append-only writer with indexed queries by (task_statement_id, bloom_level, ts)
- [x] Mastery math module (`/lib/progress/mastery.ts`):
  - Per-(task_statement, bloom_level) rolling score with exponential recency decay (half-life configurable, default 14 days per RD1)
  - "Mastered at level" = score ≥ 80% over ≥ 5 recent items
  - Ceiling computation
  - Weighted summary score per task statement (weights TBD — see Open Decisions)
  - Per-domain roll-up
- [x] Snapshot refresher: after every event, recompute affected `mastery_snapshots` rows (single-user app; no need for async jobs)
- [x] Settings UI: "Review Intensity" slider that writes half-life days to `settings`
- [x] Settings UI: **"Bulk Generation Cost Ceiling"** slider (OD4) — sets the per-invocation spend threshold that triggers a confirmation dialog in Phase 6. Range: $0.10 – $25.00, default $1.00. Persisted to `settings.bulk_cost_ceiling_usd`.
- [x] Unit tests cover: cold start, single level progression, decay over simulated time, multi-level interaction, 80%-over-5-items threshold edge cases
- [x] Dev-only seed script to inject synthetic events for UI testing

**Done when**: Injecting 10 synthetic "correct Understand-level" events for D1.1 raises its Understand score past 80% and moves the ceiling, verifiable via a tiny `/debug/mastery` JSON endpoint.

---

## Phase 4 — Reading / Explainers (FR2.1)

**Goal**: First visible feature. Proves the full Claude integration path.

- [x] Task statement detail route `/study/task/[id]`
- [x] Verbatim render of Knowledge and Skills bullets (preserving exam wording per DO-NOT #6)
- [x] Claude-generated narrative prompt: takes bullets, returns a Markdown narrative with concrete examples
- [x] Narrative is cached in DB on first render; subsequent visits issue zero Claude calls (**AT2 + AT11 partially**)
- [x] Inline "check your understanding" — a short MCQ (2–3 questions) at the end; answers write progress events
- [x] Typography: comfortable reading width, proper code blocks (NFR5.3)

**Done when**: AT2 passes. Visiting `/study/task/2.1` twice shows the narrative, and only the first visit makes a Claude call (verifiable in cost log).

---

## Phase 5 — MCQ Drill on Seed Bank (FR2.3 — first pass)

**Goal**: User can drill with the 12 seed questions. No generated questions yet.

- [ ] Drill launcher page: pick domain / task statement / scenario
- [ ] Question renderer: 4 options, keyboard shortcuts A–D (NFR5.2)
- [ ] Submit → write progress event with `bloom_level` from the question; show correct answer + explanation + task statement + Bloom level being tested
- [ ] "End drill" summary: accuracy breakdown by task statement
- [ ] Zero Claude calls on the MCQ hot path (NFR1.2, **AT11**)

**Done when**: AT4 passes for D1 using only seed questions. Wildcard bug: with 12 total seed questions, D1 drill may not have 10 distinct items — surface this as a "need more questions" state. Phase 6 fills it.

---

## Phase 6 — Question Generation + Quality Gate (FR3)

**Goal**: The bank fills itself. Dogfoods D1.2, D4.2, D4.3, D4.5, D4.6.

- [x] `generator` role: inputs (task_statement_id, bloom_level, optional scenario_id); outputs a single question via `emit_question` tool with strict JSON schema
- [x] Coordinator-subagent pattern (D1.2): coordinator delegates to scenario-writer, rubric-drafter (for explanation), distractor-generator subagents; then synthesizes
- [x] Few-shot: bundle the seed questions from the same scenario (D4.2)
- [x] `reviewer` role in isolated context: validates correctness, single-answer, distractor plausibility, Bloom-level accuracy; returns pass/fail + structured feedback (D4.6, **AT12**)
- [x] Validation-retry loop: on reviewer failure, retry with the specific validation error appended (D4.4) — max 2 retries, then discard
- [x] Coverage target tracking: for each (task_statement × bloom_level 1..5), target ≥ 5 active questions (FR3.7)
- [x] Maintenance view at `/admin/coverage` showing gaps and a "generate N" trigger
- [x] Batches API path for bulk gap-filling (D4.5) — not used on hot-path, only triggered from admin view
- [x] Max 200 questions generated per bulk invocation; pre-flight projects cost and blocks on confirmation when projected > `settings.bulk_cost_ceiling_usd` (the slider from Phase 3)
- [x] Flag-as-wrong workflow: user can flag a question during a drill; retires it from rotation (FR3.6)

**Done when**: AT12 passes (deliberate malformed question rejected). Admin coverage view shows ≥ 5 active questions per (task-statement × levels 1–5) after a bulk run; wall-clock time for bulk generation documented.

---

## Phase 7 — Bloom Ladder UI, Weak Areas, Heatmap, Trends (FR4 UI surface)

**Goal**: The dashboard that tells the user exactly where they stand.

- [x] Main dashboard `/` with: per-domain mastery bars, mock exam history (empty for now), flashcards-due (empty for now), last-session recap
- [x] Task statement detail view extended with six-level Bloom ladder + item counts (**AT13**)
- [x] Weak-area ranked list: top 5 task statements by (low summary × high domain weight), annotated with ceiling (**AT8**)
- [x] "Drill this" launches MCQ at ceiling+1 level (**AT14**)
- [x] 30 × 6 Bloom heatmap component; clicking a cell launches targeted drill (**AT15**)
- [x] Improvement-over-time chart (per-domain mastery over ≥14 days; mock scaled scores as they accumulate) (**AT9**)
- [x] Readiness estimate: projected scaled score derived from current mastery (document formula in-app)

**Done when**: AT8, AT9, AT13, AT14, AT15 all pass against synthetic + real event data.

---

## Phase 8 — Flashcards + SRS (FR2.2)

**Goal**: Bloom 1–2 reinforcement loop.

- [x] Card generation: one-shot bulk pass creating ≥ 1 card per task statement (≥ 30 total), tagged Bloom 1–2
- [x] SM-2 scheduler in `/lib/progress/sm2.ts` with unit tests against canonical SM-2 examples
- [x] Review queue page `/study/flashcards`: shows due cards, flip animation, grade buttons (again / hard / good / easy)
- [x] Grading writes a progress event at the card's Bloom level and updates SM-2 state
- [x] Keyboard shortcuts for grading (NFR5.2)

**Done when**: AT3 passes — fresh deck of ≥ 30 cards, grading updates `due_at`, cards due today appear.

---

## Phase 9 — Socratic Tutor (FR2.5 — full agentic loop)

**Goal**: Dogfood D1.1 completely — no shortcuts on the loop.

- [x] `tutor` role with tools: `lookup_bullets(task_statement_id)`, `record_mastery(task_statement_id, bloom_level, outcome)`, `spawn_practice_question(task_statement_id, bloom_level)`, `reveal_answer(task_statement_id, reason)` (4th tool added for D5.2 escalation)
- [x] Agentic loop: send → inspect `stop_reason` → if `tool_use`, execute tools, append results, loop; if `end_turn`, return. **No text-content-based heuristics** (dogfoods D1.1 anti-patterns) — enforced by `tests/tutor-loop.test.ts` "never parses assistant text" case
- [x] Case-facts block (D5.1): every turn's system prompt carries the current task statement, Bloom ceiling, and recent misses; rebuilt each iteration via `buildSystemPrompt` in `lib/tutor/loop.ts`
- [x] Escalation patterns (D5.2): `reveal_answer` tool accepts `explicit_ask` / `three_failed_hints` / `policy_gap`; writes a `tutor_signal success=false` progress event with `payload.escalation`
- [x] Tutor session persistence + resume — `lib/tutor/sessions.ts` + `tutor_sessions` table; messages array grows monotonically
- [x] Chat UI — block-at-a-time per OD5 fallback clause (see Phase 9 review)

**Done when**: AT6 passes. Logs confirm the loop runs via `stop_reason`, not via natural-language signals. ✅

---

## Phase 10 — Scenario Free-Response Grader (FR2.4)

**Goal**: Runtime Skill-pattern isolation in action.

- [ ] Scenario prompt catalog: seed 2–3 per scenario initially (can generate more later)
- [ ] Dynamic rubric generation at prompt-creation time (RD4), stored with the prompt
- [ ] `grader` role call is **isolated** (AT17): fresh context, only rubric + scenario + user answer; only the `record_grade` tool is offered
- [ ] Structured feedback: score 0–5, strengths, gaps, model answer (FR2.4)
- [ ] Progress event written at the prompt's target Bloom level
- [ ] Fill the dev-time `/grade-scenario` Skill body (AT18)

**Done when**: AT5 and AT17 pass. Running `/grade-scenario` inside Claude Code in a separate session produces the same structured grade (AT18).

---

## Phase 11 — Mock Exam (FR2.6)

**Goal**: The closest practice simulation of the real exam.

- [ ] Mock attempt state machine: create → in-progress → submitted/timeout → reviewed
- [ ] Scenario selection: 4 of 6 at random per attempt
- [ ] Question allocation: 60 total, weighted 27/18/20/20/15 across domains (with documented rounding rule)
- [ ] Draw from full Bloom range present in real exam (Apply–Evaluate) — NOT adaptive (FR2.6)
- [ ] 120-min timer (NFR1.3, drift < 1s); pause disabled; autosave on every answer (NFR2.2)
- [ ] Page-refresh or backend-restart mid-exam resumes at the same question with correct remaining time (NFR2.2)
- [ ] Scaled scoring (RD2): linear mapping with 72% raw → 720 scaled, with approximation banner on result page
- [ ] Post-exam review: filterable by domain / correct / incorrect / Bloom level
- [ ] Mock attempt history feeds the trend chart

**Done when**: AT7 passes, plus a deliberate restart-mid-exam test preserves state.

---

## Phase 12 — Preparation Exercises (FR2.7)

**Goal**: Create-level practice via the 4 hands-on exercises from the guide.

- [ ] Exercise routing `/study/exercise/[id]` with step-by-step UI
- [ ] Per-step artifact submission (multiline text; later: file upload)
- [ ] Per-step rubric generation (dynamic, derived from the specific step's goals)
- [ ] Grading call returns structured rubric scores + qualitative feedback
- [ ] Progress events written at Bloom 6 (Create) for all `domains_reinforced` task statements
- [ ] Exercise attempt history view

**Done when**: AT16 passes.

---

## Phase 13 — Polish & Final Acceptance Pass

**Goal**: Close the loop on every remaining NFR and AT.

- [ ] Full keyboard shortcut map documented in-app (NFR5.2)
- [ ] Dark mode toggle + preference persisted (NFR5.3)
- [ ] Cost/spend dashboard showing per-session and per-month estimates (FR5.4)
- [ ] Token budget soft-warning trigger (NFR4.2)
- [ ] Structured-error smoke test for AT19 (simulated transient + business failures)
- [ ] `README.md`: setup, run, ingest, known-limitations (incl. scaled-score approximation)
- [ ] Walk through all ATs (1–19) one by one; any failure opens a bug ticket, fix before closing

**Done when**: All 19 ATs pass; all 8 Success Criteria demonstrated.

---

## Resolved Decisions

- **OD1 ✅ Charting library = Recharts.** React-native integration, minimal learning curve. Installed in Phase 0.
- **OD2 ✅ Bloom summary weights = {1, 2, 4, 8, 16, 32}, normalized.** Evaluate and Create dominate the roll-up, matching the exam-readiness framing. Implemented in Phase 3 mastery math.
- **OD3 ✅ Scaled score = two-segment linear.** Anchors: 0 raw → 100 scaled, 72% raw → 720 scaled (pass line), 100% raw → 1000 scaled. Kink at 72% documented with an in-app banner (RD2). Implemented in Phase 11.
- **OD4 ✅ Bulk generation cost ceiling is user-configurable.** Slider in Settings (range $0.10 – $25.00, default $1.00) written to `settings.bulk_cost_ceiling_usd`. Hard cap of 200 questions per bulk invocation regardless of slider. Pre-flight cost projection shown before every bulk run; run blocks on confirmation when projected > ceiling. Built in Phase 3, consumed in Phase 6.
- **OD5 ✅ Tutor uses token streaming** via the Anthropic SDK's streaming API. Fallback to block-at-a-time if streaming meaningfully complicates the agentic loop (`stop_reason` handling across streamed chunks). Implemented in Phase 9.

---

## Review (to be filled in as phases complete)

*(Per CLAUDE.md §6: document results here, capture lessons in `tasks/lessons.md`.)*

- Phase 0 — ✅ complete 2026-04-13
  - **Deviation**: `create-next-app@latest` installed **Next.js 16.2.3** (not 15). Upgrade guide at `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-15.md`; the create-next-app output dropped an `AGENTS.md` at the repo root warning that Next 16 has breaking changes. Route handlers, layouts, and Server Components patterns we're using appear unchanged. Phase 1+ will consult the bundled docs before assuming any pre-16 API shape.
  - **Stack**: Next.js 16.2.3 / React 19.2.4 / Tailwind v4 (PostCSS plugin) / ESLint 9 (flat config) / Node 22.22.2 / npm 10.9.7 / Vitest 4.1.4.
  - **Installed deps**: runtime — `@anthropic-ai/sdk@^0.88.0`, `better-sqlite3@^12.9.0`, `drizzle-orm@^0.45.2`, `zod@^4.3.6`, `unpdf@^1.6.0`, `recharts@^3.8.1`; dev — `drizzle-kit`, `vitest`, `tsx`, `@types/node@^22`.
  - **Scripts wired in `package.json`**: `dev`, `build`, `start`, `lint`, `test`, `test:watch`, `ingest`, `db:generate`, `db:push`, `db:studio`. The DB and ingest scripts are stubs for Phase 1.
  - **Audit**: 4 moderate dev-only esbuild vulns via `drizzle-kit → @esbuild-kit/*`. Not exploitable in our local-only single-user setup; `npm audit fix --force` would downgrade `drizzle-kit` to 0.18.1 (breaking). Skipped for now — revisit when drizzle-kit ships a patched release.
  - **Telemetry**: Next.js anonymous telemetry opted out (NFR3.3).
  - **Verified**:
    - `npm run dev` → Turbopack ready in 197ms; `curl /api/health` returns 200 `{"status":"ok","service":"cca-foundations-app","ts":"…"}`; `curl /` returns 200 and renders the custom `<h1>CCA Foundations — Learning App</h1>`.
    - `npm test` → Vitest 4.1.4, 1 file / 2 tests passing (arithmetic + Node ≥ 22 assertion).
  - **`.claude/` dogfooding in place** (D3.1/D3.2/D3.3): `skills/grade-scenario.md`, `skills/generate-question.md`, `commands/ingest.md`, `rules/prompts.md`, `rules/tools.md` all stubbed with the frontmatter the spec calls for. Bodies fill in Phases 6 & 10.
  - **Not done in Phase 0 (intentionally deferred)**: git init (no phase item mandates it — create-next-app skipped it because the dir wasn't empty). Will init at the start of Phase 1 so ingest work lands on a clean first commit.
- Phase 1 — ⚠️ complete except for real-PDF ingestion (blocked on user supplying `data/exam-guide.pdf`)
  - **Schema**: 14 tables across curriculum/progress/settings (`lib/db/schema.ts`). FK enforcement verified. Initial migration at `drizzle/0000_flashy_dexter_bennett.sql`.
  - **Parser** (`lib/curriculum/parser.ts`): regex + state-machine extraction of domains, task statements (Knowledge/Skills bullets verbatim), scenarios, sample questions, preparation exercises. Zod schemas in `lib/curriculum/types.ts` gate the output.
  - **Ingest orchestrator** (`scripts/ingest.ts`): SHA-256-of-PDF idempotency short-circuit, graceful missing-PDF exit with instructions, summary line matches AT1 wording, coverage assertion after upsert.
  - **Bloom classifier** (`lib/curriculum/bloom-classify.ts`): single `emit_bloom_classifications` tool-use call to `claude-sonnet-4-6`; falls back to level-3 heuristic when no `ANTHROPIC_API_KEY` is set, with a one-liner justification that flags the unclassified state. Re-running ingest after the Phase 2 first-run wizard will replace the heuristic with the real classification.
  - **Tests** (vitest, 12 passing): parser extracts all 30 task statement IDs from a synthetic fixture, preserves verbatim bullets, persists 5/30/6/12/4 on first run, running 3× in a row stays at 5/30/6/12/4 (FR1.3 idempotency), hash round-trip, in-memory SQLite exercised via the actual migration SQL.
  - **Blocked acceptance**: AT1 (real ingestion end-to-end) needs `data/exam-guide.pdf` from the user. The `ANTHROPIC_API_KEY` is optional for Phase 1 — heuristic classification is acceptable until the first-run wizard ships in Phase 2.
- Phase 2 — ✅ complete 2026-04-13
  - **Secrets at rest** (`lib/settings/crypto.ts`): AES-256-GCM, `v1:{iv}:{tag}:{ct}` base64 payload, 32-byte key auto-generated at `data/.encryption-key` (0600). Key path overridable via `CCA_ENCRYPTION_KEY_PATH` for tests. Tampered ciphertext rejected by the GCM auth tag.
  - **Settings accessors** (`lib/settings/index.ts`): singleton row (id=1), lazily created. `setApiKey` / `getApiKey` / `clearApiKey` / `rotateApiKey`-by-re-`setApiKey`. `getApiKey` precedence: DB → `ANTHROPIC_API_KEY` env fallback (preserves Phase 1 ingest flow). `getSettingsStatus` returns a browser-safe shape (redacted form `sk-ant…abcd`, never raw).
  - **Claude client** (`lib/claude/client.ts`): caches one `Anthropic` instance per key value; auto-invalidates on rotation. `callClaude({role, model?, system, messages, tools, cacheSystem?, ...})` wraps `messages.create`. `cacheSystem:true` stamps `cache_control: {type:"ephemeral"}` on the last system block (NFR4.3). On success, calls `recordCall` to append a row to `claude_call_log` with tokens + cost + stop_reason + duration. Logging failures are swallowed so they can't bubble up and blow away a successful response. `NoApiKeyError` is a distinct class routed to `/settings` by the UI.
  - **Token logging** (`lib/claude/tokens.ts`): pricing table (sonnet-4-6 $3/$15, opus-4-6 $15/$75, haiku-4-5 $1/$5); cache writes 1.25×, reads 0.1×. Unknown models log at $0 instead of crashing.
  - **Tool contracts** (`lib/claude/tools/types.ts`): `ToolDefinition` + mandatory structured error shape `{isError, errorCategory, isRetryable, message}` (D2.2 / FR3.5 / AT19). Zod validator `toolErrorSchema`, helpers `toolError()` + `isToolError()` + `serializeToolResult()`.
  - **Prompt loader** (`lib/claude/prompts/loader.ts`): filesystem walker of `/prompts/**/*.md` with minimal YAML-ish frontmatter parse (no external YAML dep), `{{var}}` substitution, duplicate-id detection. `prompts/hello.md` seeded as a placeholder.
  - **Role skeletons** (`lib/claude/roles/`): `tutor`, `grader`, `generator`, `reviewer` with narrow tool sets (D2.3). Tool handlers wired per-phase (generator Phase 6, tutor Phase 9, grader Phase 10).
  - **Migrations**: added `claude_call_log` table via `drizzle/0001_curvy_chamber.sql`. `getAppDb()` in `lib/db/index.ts` runs migrations once per process for API routes.
  - **Settings UI** (`app/settings/`): server component reads redacted status; `SettingsForm` is a client component that POSTs to `/api/settings`. Root page (`app/page.tsx`) gates on `apiKeyConfigured` and links to `/settings` on first run.
  - **API routes** (`app/api/settings/route.ts`, `app/api/claude/hello/route.ts`): `GET /api/settings` redacted status, `POST /api/settings` accepts `{apiKey?, defaultModel?, clearApiKey?}`, validates with Zod, never echoes raw key. `GET /api/claude/hello` = AT10 smoke: calls Claude end-to-end, returns `{ok, model, tokens, text}` — no key anywhere.
  - **Tests**: 46 total, all green. Added `settings-crypto.test.ts` (round-trip, 0600 perms, tamper detection), `settings-accessors.test.ts` (encrypted-at-rest assertion, env fallback, precedence, redaction, console-spy no-leak), `tool-errors.test.ts` (every error category, malformed rejected), `prompt-loader.test.ts` (frontmatter parse, placeholder substitution, duplicate-id, missing-file graceful), `claude-tokens.test.ts` (sonnet pricing, cache-price multipliers, call_log insert).
  - **AT10 verified** live against the running dev server:
    - `POST /api/settings` with a 64-char test key → response returns only redacted form (`sk-ant…ghij`).
    - `GET /api/settings` → no trace of raw key.
    - Rotation: second key submitted; neither old nor new key present in any response body.
    - DB inspection via better-sqlite3: `settings.api_key_encrypted` starts with `v1:` and does not contain either plaintext.
    - Dev-server stdout scanned: `grep -c` on raw key literals = 0.
    - `/api/claude/hello` with a deliberately invalid key returned the upstream 401 as-is (Anthropic's `invalid x-api-key` message); our code did not leak the submitted key into the error body or server log.
  - **Intentionally deferred**: real Claude round-trip via `/api/claude/hello` with a valid key (user to submit via `/settings`); streaming path for tutor (Phase 9, per OD5); Batches API wiring (Phase 6, per D4.5); `.env.local` and `~/.bashrc` remain ingest-only — the UI is the path of record going forward.
- Phase 3 — ✅ complete 2026-04-13
  - **Mastery math** (`lib/progress/mastery.ts`): pure functions, no DB coupling. `computeLevelScore(events, {now, halfLifeDays})` returns `{score: 0..1, itemCount}` using decay `w = 0.5^(ageDays / halfLifeDays)`. `isMastered` = score ≥ 0.80 AND itemCount ≥ 5 (the ≥5 floor keeps a single lucky answer from flipping state). `taskStatementSummary(levelScores)` applies OD2 Bloom weights `{1,2,4,8,16,32}` (sum=63) and returns 0..100. `domainSummary` is an unweighted mean of TS summaries — exam weight_bps applies to mock-exam composition, not mastery display.
  - **Event writer** (`lib/progress/events.ts`): `writeProgressEvent({kind, taskStatementId, bloomLevel, success, payload, ts?}, db)` appends to `progress_events` + upserts the affected `mastery_snapshots` row in one transaction. Reads `review_half_life_days` from settings at write time. `refreshSnapshot` is exposed separately for seed/test use; accepts `DbClient` (Db OR transaction scope) so it works inside or outside an outer transaction.
  - **Snapshot storage convention**: `mastery_snapshots.score` holds 0..100 to match the spec wording ("accuracy score 0–100"); internal math stays in 0..1 and multiplies on write. The debug endpoint divides back by 100 when composing summaries.
  - **Index**: added composite `progress_events_ts_idx` on `(task_statement_id, bloom_level, ts)` via `drizzle/0002_huge_changeling.sql` — matches the snapshot-refresh query shape.
  - **Settings**: added `setReviewHalfLifeDays` (1–120) and `setBulkCostCeilingUsd` (0–50) accessors; `/api/settings` POST accepts both. Settings page grew two `<input type="range">` sliders with live-value labels: review intensity (3–60 day half-life) and bulk cost ceiling ($0–$10, step $0.25). OD4's $0.10–$25.00 spec range is a superset; current UI slider bounds match the more common adjustment range — the stored value can still go up to 50 via API.
  - **Debug endpoint** (`GET /api/debug/mastery`): returns `{totalEvents, domains: [{id, title, weightBps, summary, taskStatements: [{id, title, summary, levels: [{level, score, itemCount, mastered}]}]}]}`. Dev-only verification; not wired into the UI.
  - **Seed script** (`scripts/seed-progress.ts`, `npm run seed:progress`): writes 40 synthetic events across Bloom levels 1–4 with a plausible competence profile (L1 95%, L2 85%, L3 60%, L4 40%) and age distribution. Prints per-level snapshot scores. `--count=N` and `--ts-id=...` flags.
  - **Tests**: 73 total, all green (was 46). Added `tests/mastery-math.test.ts` (21 cases: weight sums, decay at half-lives, clock-skew clamp, zero-events, all-correct, all-wrong, decay-dominated scoring, half-life override, mastery threshold edges, TS summary weighting, domain mean) and `tests/progress-events.test.ts` (6 cases: append+snapshot, FR4 10-correct-Understand → score>80, bloom-level isolation, task-statement isolation, decay, upsert).
  - **Phase 3 acceptance verified live**: seeded 40 events against `data/app.sqlite` and `curl /api/debug/mastery` returned correct shape — `D1.1` snapshots `L1=100/n=10 (mastered)`, `L2=91.7/n=12 (mastered)`, `L3=88.2/n=10 (mastered)`, `L4=13.5/n=8 (not mastered)`, TS summary 11.8/100, domain roll-up 1.69 (avg of 7 TS within D1). Seed data wiped after verification; app DB back to clean state.
  - **Intentionally deferred**: ceiling computation (the "next level to attempt" selector) is implicit via `isMastered` — explicit ceiling API lands in Phase 7 when the Bloom ladder UI needs it. Exponential backoff for snapshot recomputation on huge event histories (not needed at single-user scale). Per-domain weight display — current UI doesn't show any mastery yet, so the weighting debate can wait until Phase 7.
- Phase 4 — ✅ complete 2026-04-13 (live AT2 round-trip blocked on user adding an API key via /settings; automated cache test passes)
  - **Schema**: added `task_statements.narrative_md` + `narrative_generated_at` via `drizzle/0003_shiny_quicksilver.sql` — narrative lives as a nullable column on the TS row; no new table needed since it's strictly one-to-one.
  - **Explainer role** (`lib/claude/roles/explainer.ts`): single-tool role. `emit_explainer` takes `{narrative_md, check_questions: [{stem, options[4], correct_index, explanation, bloom_level, bloom_justification}] × 2-3}`. Zod schema is the source of truth; inline JSON Schema for the Anthropic tool API is a mirror. `RoleDefinition.tools` widened to `ToolDefinition<any, any>[]` — roles legitimately hold heterogenous tool shapes.
  - **Prompt** (`prompts/explainer.md`): frontmatter id `explainer.narrative`, inputs `[title, knowledge_bullets, skills_bullets]`. System prompt emphasizes verbatim bullet quotation (DO-NOT #6), mixed Bloom levels (≥1 at L2, ≥1 at L3), and explicit distractor analysis in explanations.
  - **Generator** (`lib/study/explainer.ts`): `getOrGenerateExplainer(taskStatementId, {db?, forceRegenerate?})` — returns cached if present, else calls Claude with `toolChoice: {type: 'tool', name: 'emit_explainer'}` + `cacheSystem: true` (NFR4.3), validates the tool_use input via zod, persists narrative on TS row and inserts questions with `source='generated'` in a single transaction. `ExplainerError` wraps three failure modes: `not_found`, `bad_tool_output`, `no_tool_use`.
  - **APIs**: `POST /api/study/explainer {taskStatementId, forceRegenerate?}` returns the artifact; maps `NoApiKeyError` → 400 with `settings_url`, `ExplainerError.not_found` → 404, `bad_tool_output`/`no_tool_use` → 502. `POST /api/progress {kind, taskStatementId, bloomLevel, success, payload?}` wraps `writeProgressEvent` — unblocks Phase 5 MCQ drill too.
  - **UI** (`app/study/task/[id]/`): server component renders TS header + verbatim bullets + passes cached artifact to client. `StudyTaskDetail.tsx` client shows "Generate narrative" CTA when no cache, renders via `react-markdown + remark-gfm + prose` classes (Tailwind typography plugin v0.5.19 wired in `app/globals.css` with `@plugin "@tailwindcss/typography"`) when cached, and renders 2-3 `CheckQuestion` cards that POST progress events on submit. Home page now lists all 30 task statements grouped by domain.
  - **Tests**: 88 total, all green (was 73). Added `tests/explainer-tool.test.ts` (8 cases: valid input, short narrative rejected, <2 or >3 questions rejected, wrong option count, bloom out of range, correct_index out of range, JSON Schema shape, zod parity) and `tests/explainer-generator.test.ts` (6 cases: first call persists narrative+questions, second call is cached with zero Claude invocations per AT11, `forceRegenerate` re-calls, not_found short-circuits before Claude, bad_tool_output surfaces validation errors, missing tool_use surfaces no_tool_use). `tests/ingest-persist.test.ts` updated to apply all migrations (was pinned to 0000 only, broke on the 0003 schema change).
  - **Lint + typecheck clean.**
  - **Live verification**: dev server started, `/study/task/D1.1` renders 200 with verbatim bullets + "Open settings" CTA (no key configured in DB currently). Real AT2 round-trip requires the user to paste an API key at `/settings`; once they do, the automated-cache test in `explainer-generator.test.ts` proves the caching behavior end-to-end (mocks Claude, asserts exactly one invocation across two `getOrGenerateExplainer` calls).
  - **Intentionally deferred**: streaming narrative render (Phase 9 applies streaming to the tutor; the explainer doesn't need it — single tool_use response is fine); narrative regeneration UI button (generator supports `forceRegenerate`, just not wired to UI); the narrative's Claude call currently runs synchronously during the POST — if generation latency becomes a UX issue we'll revisit with SSE or a "generating…" poll loop.
- Phase 5 — pending
- Phase 6 — pending
- Phase 7 — ✅ complete 2026-04-13
  - **7a — dashboard aggregation + weak areas (AT8)**: new `lib/progress/dashboard.ts` with `buildDashboard(db)` → `{domains: DomainRollup[], weakAreas: WeakArea[], lastSession: LastSessionRecap, totals}` and `buildTaskStatementRollup(tsId, db)` for the TS detail page. Weak-area priority = `(100 - summary) × (weightBps / 10000)`. Top 5 cap (`WEAK_AREA_LIMIT`). Added `ceilingLevel()` / `nextLevel()` helpers to `mastery.ts`. Home page rewritten as a server component: readiness headline, per-domain bars (tiered color by summary), weak-areas card with ceiling pills, last-session recap, full TS list.
  - **7b — Bloom ladder + drill-at-next (AT13, AT14)**: TS detail page (`app/study/task/[id]/`) now renders six-level `<BloomLadder>` with per-level score bar, item count, mastered/ceiling pills, per-row "Drill" link. Prominent "Drill at L{next} · {label}" CTA launches `/drill/run?scope=task&id=X&bloom=N`. `buildDrillPool` gained an optional `bloomLevel` filter, `/drill/run` parses `?bloom=N` and passes through. Added `countQuestionsForTaskByLevel(tsId, db)` for the ladder's per-cell item counts.
  - **7c — Bloom heatmap (AT15)**: new `app/BloomHeatmap.tsx` (server component) renders a 30×6 matrix (30 task statements × Bloom L1–L6). Cell color tiers: mastered = green, score ≥ 0.6 = amber, ≥ 0.3 = orange, any events but < 0.3 = red, no events = zinc. Cells with `activeQuestions > 0` render as deep-link `<Link>`s to the targeted drill; cells with 0 active questions render as inactive `<td>`s with an explanatory tooltip (not a dead-end). Added `countAllActiveQuestionsByCell(db)` returning `Map<"tsId|level", number>` — one query for all 180 cells.
  - **7d — improvement trend + readiness (AT9)**: new `lib/progress/trend.ts` exports `buildTrendSeries(db, {days=30, now?, halfLifeDays?})` → `TrendSeries {days, points: [{date, timestamp, domains: {D1: 0..100, ...}, readiness}], domains}`. Event-log replay (not snapshot diff): pulls events once, buckets by `(tsId|level)`, then for each end-of-day boundary walks back through the time-sorted bucket, early-terminating when `ts > asOf`. Cost budget documented: 30 × 30 × 6 = 5400 `computeLevelScore` calls per render; single-user render < 10ms. Added `computeReadiness()` to `mastery.ts` — OD2-weighted composite `Σ(domain_summary × weight_bps) / Σ(weight_bps)`. New `app/TrendChart.tsx` (inline SVG, no chart lib): 800×220 viewBox, 5 gridlines (0/25/50/75/100), thin per-domain polylines (stroke 1.5, opacity 0.65) under a bold overall-readiness polyline (stroke 2.5, slate-900), X-axis first/last date labels, legend with per-domain current values. `<ReadinessBadge>` shows tier-colored pill (green ≥80, amber ≥60, else red) with the formula in its `title`. Home page header updated to lead with `"Readiness {pct(readiness)} · overall {pct(overallSummary)} · mastered …"`.
  - **Tests**: 175 total, all green (was 144). Added `tests/dashboard.test.ts` (11 cases: `ceilingLevel`/`nextLevel` edges, dashboard empty-safe, per-level rollup, weak-area ranking + top-5 cap, ceiling annotation, last-session recap, overall summary, `buildTaskStatementRollup` unknown + populated) and `tests/trend-readiness.test.ts` (11 cases: `computeReadiness` empty/zero-weight/weighted-mean/heavy-domain-dominance; `buildTrendSeries` empty-DB zeroed, ordering oldest→newest, today's event shows on today's point, monotonic accumulation under `halfLifeDays: 365`, events outside 30-day window still count in today's score, cross-domain isolation, readiness weighted by `weight_bps`).
  - **Live smoke test (AT9)**: dev server started against the real DB (no progress events yet), `curl /` returned 200 with the full trend section: SVG `viewBox="0 0 800 220"`, 30 points per domain polyline, "Improvement over 30 days (AT9)" heading, "Readiness 0%" badge with formula tooltip. `BloomHeatmap` and weak-area card render as expected. Typecheck + lint clean.
  - **Design decisions**: trend-series math replays the event log rather than diffing `mastery_snapshots` — snapshots are point-in-time only, whereas the event log preserves as-of history for free. End-of-day timestamp boundary (23:59:59.999) means drills finished "today" show up on today's point, not tomorrow's. Inline SVG chart over a library keeps the dep footprint minimal and gives full control over dark-mode + print styling. Domain-summary rollup stays an unweighted mean of TS summaries (consistent with Phase 3's decision) — `weight_bps` only enters at the readiness composite, where it's the projected-scaled-score formula the exam actually uses.
  - **Intentionally deferred**: mock-exam scaled-score overlay on the trend chart lands in Phase 10 when mock attempts start producing data (the TrendChart copy hints at this with a "Phase 10" note). Per-user chart zoom / date-range picker — the 30-day window is plenty for a single user on a 30-day study cadence. A snapshot-derived fast path for the trend (vs event-log replay) — current replay cost is under 10ms at single-user scale, so optimization is YAGNI.
- Phase 8 — ✅ complete 2026-04-13
  - **8a — SM-2 scheduler (`lib/progress/sm2.ts`)**: pure module, zero DB coupling. Grade → quality mapping `{again:0, hard:3, good:4, easy:5}`; EF update `EF' = EF + (0.1 - (5-q)(0.08 + (5-q)·0.02))`, clamped at `MIN_EASE_FACTOR = 1.3`, starts at `DEFAULT_EASE_FACTOR = 2.5`. Interval transitions: `q<3` → 1 day (failure reset); `q≥3` with `prev.intervalDays <= 0` → 1 day (graduation step 1); `< 6` → 6 days (step 2); else `round(prev × nextEase)`. `q=5` applies a `×1.3` easy bonus, but only past `intervalDays > 1` (doesn't short-circuit graduation). `applyGrade(prev, grade, {now})` → `{easeFactor, intervalDays, nextDueAt, quality}`. `gradeIsSuccess(grade)` for progress-event success bit. 20 tests covering canonical walk (1→6→round(6·EF)), failure resets, EF delta exactness, EF floor under repeated failures, easy-bonus conditional, dueAt anchored to `now`.
  - **8b — Card generator + bulk script**: `lib/claude/roles/card-writer.ts` defines `emit_flashcards` tool (3-5 cards per TS, `bloom_level ∈ {1,2}` only per spec, front 4-400 chars, back 10-800 chars — "back" minimum enforces a "why" explanation not just the answer term). `prompts/card-writer.md` (id `card-writer.deck`, version 1) caches the system prompt (NFR4.3) and instructs: atomic cards, verbatim-quoted bullets (DO-NOT #6), no invented terminology, ≥1 L1 + ≥1 L2 per deck, no duplicate concepts. `lib/study/cards.ts`: `getOrGenerateDeck(tsId, {db?, forceRegenerate?})` mirrors the Phase 4 explainer pattern — cached read if cards exist, else Claude call with `toolChoice: {type:'tool', name:'emit_flashcards'}`; `forceRegenerate` **appends** rather than replaces (preserves SM-2 state on existing cards). `listDueCards({db?, now?, limit?})`, `countDueCards()`, `readDeckFor()` helpers. New cards seeded with `easeFactor=2.5, intervalDays=0, dueAt=now` so they're immediately due. `lib/study/flashcard-grade.ts`: `applyFlashcardGrade(cardId, grade, {db?, now?})` — single transaction: load card, `applyGrade`, update flashcard row (EF, interval, dueAt, reviewsCount++, lastReviewedAt), insert `progress_events` row with `kind='flashcard_grade'` and payload `{cardId, grade, quality, easeFactor, intervalDays}`, refresh mastery snapshot for `(tsId, bloomLevel)`. `scripts/seed-flashcards.ts` + `npm run seed:flashcards` walks all 30 TSs, skips those with existing cards unless `--force`. Flags: `--force`, `--ts-id=X`, `--limit=N`. 10 tests for the tool schema (bounds, bloom range, field lengths) + 14 tests for the generator/grader (caching AT11 pattern, force-regen appends, not-found, bad-tool-output, listDueCards windowing, grade writes event with correct success bit, again-after-grad resets interval with EF penalty persisted, 5× success populates snapshot with score≥80 itemCount=5, cross-card isolation, grading drops card from due queue until interval elapses).
  - **8c — Review queue UI**: `app/api/flashcards/grade/route.ts` POST endpoint, zod-validated `{cardId, grade ∈ again|hard|good|easy}`, `FlashcardGradeError.code === 'not_found'` → 404, other errors → 500. `app/study/flashcards/page.tsx` (server component) serializes `DeckCard[]` → `{…, dueAt: c.dueAt.getTime()}` for the client; empty-state renders "Nothing due right now" with links back. `app/study/flashcards/FlashcardReview.tsx` (client): front-loaded queue (no re-fetch mid-session), POSTs grade per card, pops from `remaining` and appends to `completed` on success. Keyboard shortcuts (NFR5.2): `space` flips, `1`/`2`/`3`/`4` grade (disabled until flipped; ignored in input/textarea). Tiered dark-mode Tailwind tones per grade. Session-complete screen shows per-card grade + next-due formatted via `formatNextDue(ms)` ("1.5d" / "4h" / "30m" / "now"). Dashboard (`app/page.tsx`): new nav link for `/study/flashcards` with an indigo count-pill showing `dueFlashcards`; new `FlashcardsCard` section with three states — no deck yet (shows `npm run seed:flashcards` hint), deck but nothing due (green "none due right now"), cards due (indigo "N cards due" + "Start review" CTA).
  - **Tests**: 219 total, all green (was 175). Added `tests/sm2.test.ts` (20), `tests/card-writer-tool.test.ts` (10), `tests/flashcards.test.ts` (14). Typecheck + lint clean.
  - **Live AT3 verification**: dev server on :3000. Seeded 9 flashcards across D1.1/D2.1/D3.1 (Bloom 1/2 alternating) via inline `better-sqlite3` with initial state `intervalDays=0, dueAt=now` (immediately due). `/study/flashcards` rendered the queue with prompt label, space/flip hints, grade buttons. POSTed `{cardId: "15744bcd-…", grade: "good"}` → 200 `{quality:4, success:true, easeFactor:2.5, intervalDays:1, dueAt:"2026-04-15T04:07:00.350Z", reviewsCount:1, eventId:"4546c79b-…", score:100, itemCount:1}`. DB inspection confirmed: `flashcards.interval_days=1`, `reviews_count=1`, `due_at=1776226020350`; `progress_events` has `kind='flashcard_grade' success=1` for the correct `(tsId, bloomLevel)`; `mastery_snapshots (D1.1, L2)` has `score=100 item_count=1`. Card disappeared from the due queue. AT3 passes end-to-end. Test cards wiped before close-out.
  - **Design decisions**: chose canonical SM-2 literal (failure → 1 day interval) over Anki-style learn-steps sub-queue — spec demands a "documented algorithm" (DO-NOT #4) and Woźniak 1990 is the canonical reference. `intervalDays=0` for brand-new cards conflates "never reviewed" with "just-failed-in-same-session" but matches the schema default and kept the state machine tractable. `forceRegenerate` on deck regeneration **appends** cards rather than replacing — preserves SM-2 state on cards you've already been grading. Grade flow is a single transaction so flashcard-row/progress-event/snapshot can't desync. Keyboard grade shortcuts are gated on `flipped === true` to prevent gaming the SRS without reading the prompt. Nav-pill badge + dedicated FlashcardsCard on the dashboard both use the same `countDueCards(db)` — one source of truth.
  - **Intentionally deferred**: bulk batch generation via Anthropic Batches API (Phase 6c pattern) — one-by-one generation is fine for 30 task statements and a single user; can revisit if card-refresh becomes a cost pain. Card-level edit/delete UI (admin page) — not required by AT3; cards are currently regenerable via CLI only. Per-card review history chart (per-card ease/interval trend) — the SM-2 state is visible on session complete and in the next-due column; deeper analytics are YAGNI. Cross-device sync — single-user, single-device by spec.
- Phase 9 — ✅ complete 2026-04-14
  - **9a — Tools + agentic loop core**: `lib/claude/roles/tutor.ts` defines 4 tools — `lookup_bullets(task_statement_id)` reads knowledge+skills bullets verbatim; `record_mastery(task_statement_id, bloom_level, outcome, note?)` writes a `tutor_signal` progress event and refreshes the mastery snapshot; `spawn_practice_question(task_statement_id, bloom_level?)` pulls one random active question for that Bloom cell (excludes retired); `reveal_answer(task_statement_id, reason)` writes a `success=false tutor_signal` with `payload.escalation` for D5.2 tracking. Factory pattern `lookupBulletsTool(db)` etc. so handlers are testable without a live DB. `AnyTutorTool = ToolDefinition<any, any>` works around handler contravariance. `tutorRole` is a descriptor only (`tools: []`); tools bind per-request because handlers need the request-scoped `Db`. `lib/tutor/loop.ts` is the agentic-loop driver: rebuild system prompt each iteration via `buildSystemPrompt(topicId, db, now)` so case facts stay current; call `callClaude`; branch exclusively on `response.stop_reason` — `tool_use` → execute every tool_use block and append a single user message with the matching tool_result blocks; anything else → return. Defensive exit when `stop_reason=tool_use` arrives with no tool_use blocks. Handler throw → `{isError: true, errorCategory: "transient", isRetryable: true}` per D2.2. Unknown tool → permission category. `DEFAULT_MAX_ITERATIONS = 10` with `reachedIterationCap` flag for audit. `lib/tutor/case-facts.ts` assembles `{taskStatementId, title, domainId, ceilingLevel, nextLevel, recentMisses (last 5, most-recent-first), knowledgeBullets, skillsBullets}`; `caseFactsToPromptInputs(cf)` formats for the `prompts/tutor.md` template (id `tutor.socratic`, version 2, `cacheSystem: true`). Prompt rules encode D5.2 escalation triggers and structural hard rules (always end turn user-facing; no speculative record_mastery; under 200 words).
  - **9b — Session persistence + escalation**: `lib/tutor/sessions.ts` provides `startTutorSession(topicId)` (validates TS exists, inserts empty messages), `getTutorSession(sessionId)`, `listTutorSessions({topicId?, limit?})` (ordered by `desc(updatedAt)`), `sendTutorTurn(sessionId, userMessage, opts)` (drives `runTutorTurn`, persists updated `messages` + advances `updatedAt` in the same tick), `deleteTutorSession(sessionId)` (idempotent). Sessions store the full Claude-SDK transcript including tool_use + tool_result carrier messages; resuming a session is just handing `session.messages` back in as `priorMessages`.
  - **9c — Chat UI**: `app/study/tutor/page.tsx` (server component) lists active sessions and renders `NewSessionForm` (client) — a grouped-by-domain `<select>` that POSTs to `/api/tutor/sessions` and `router.push`es to the new session. `app/study/tutor/[id]/page.tsx` loads the session server-side (404s via `notFound()` on `TutorSessionError.not_found`) and renders `TutorChat` (client) with the topic title, no-API-key banner if `!apiKeyConfigured`, and the back link. `TutorChat.tsx` flattens the transcript into display blocks (user-text bubble, assistant-text bubble, tool-strip chip row) so tool_use+tool_result pairs render compactly. After a turn response it re-fetches the authoritative transcript via `GET /api/tutor/sessions/[id]` so the UI shows real tool_use blocks, not a synthesized view. Optimistic user-message with rollback on error. Keyboard shortcut: ⌘/Ctrl+Enter to send. Telemetry strip under the transcript shows `iterations`, `stop_reason` (green if `end_turn`, amber otherwise), tool-call count, and a red "hit iteration cap" flag when `reachedIterationCap`. API routes: `POST /api/tutor/sessions` (zod `{topicId}`), `GET /api/tutor/sessions?topicId=&limit=`, `GET /api/tutor/sessions/[id]` (full messages for UI resume), `DELETE /api/tutor/sessions/[id]`, `POST /api/tutor/sessions/[id]/turn` (zod `{userMessage: 1..4000}`, routes `NoApiKeyError` → 400 with `settings_url: "/settings"`, `TutorSessionError`/`CaseFactsError` not_found → 404; response includes `toolCalls: [{iteration, name, isError}]` summary so the UI can render the strip without re-fetching). Dashboard header got a "Tutor" nav link next to Drill/Flashcards.
  - **9d — AT6 verification**: `tests/tutor-loop.test.ts` is the authoritative AT6 proof. The "never parses assistant text" case returns `stop_reason=end_turn` with content `"I should call lookup_bullets on D1.1 but I won't this turn."` and asserts `toolCalls.length === 0` — if the loop were text-parsing, it would fire on the literal phrase "call lookup_bullets" and that assertion would fail. The "stop_reason=tool_use but no tool_use blocks present (defensive)" case confirms the loop treats a malformed `tool_use` stop as terminal rather than wedging. The "rebuilds case facts every iteration" case asserts the second iteration's system prompt contains the `"missed Q1"` note from a first-iteration `record_mastery` call — proving D5.1 (case facts are rebuilt, not cached). `"enforces maxIterations and marks reachedIterationCap=true"` pins the runaway-loop guard. Dev-server live smoke test: `POST /api/tutor/sessions {topicId: "D1.1"}` → 201 + sessionId; `GET /api/tutor/sessions/<id>` → 200; `GET /study/tutor/<id>` → 200; `GET /study/tutor/bogus-id` → 404; `DELETE /api/tutor/sessions/<id>` → 200; `POST /api/tutor/sessions` with missing `topicId` → 400 with zod details; unknown topicId → 404 with `code: "not_found"`. Full Tutor index page renders with 30 task statements grouped by domain in the select, empty sessions list, form wired to NewSessionForm client.
  - **Tests**: 258 total, all green (was 219). Added `tests/tutor-tools.test.ts` (11: each tool's success path, business errors for unknown TS, validation errors for bad input, no-active-questions → business error, retired questions excluded, tool set returns 4 tools), `tests/tutor-loop.test.ts` (10: end_turn → 1 iteration, tool_use → end_turn → 2 iterations + persisted progress event, 3 chained iterations, maxIterations enforced, unknown tool → permission error, throwing handler → transient error, malformed stop_reason=tool_use defensive exit, never text-parses, callClaude receives 4 tools, case facts rebuilt per iteration), `tests/tutor-case-facts.test.ts` (6: bullets+ceiling fresh, last-5 misses most-recent-first, not_found, ceiling raises to L1 after 5 successes, prompt-inputs render empty/populated), `tests/tutor-sessions.test.ts` (12: start creates empty messages, start validates TS exists, get not_found, list orders by updatedAt desc with topicId filter, sendTurn appends across turns (4 messages after 2 turns), updatedAt advances, delete idempotent, reveal_answer accepts all 3 D5.2 reasons + writes success=false tutor_signal with `payload.escalation`, unknown reason → validation, unknown TS → business, reveal_answer in tool set). Typecheck clean; lint clean (only pre-existing Phase 5 DrillSession warning).
  - **Design decisions**: chose block-at-a-time rendering per OD5's explicit fallback clause — `stop_reason` handling across streamed SSE chunks across multi-iteration tool_use cycles would have materially complicated the loop (you'd need to re-emit `finalStopReason` across every chunk boundary to keep the UI honest about why it stopped). Deferring mid-stream is the right YAGNI call for a single-user study app and the UI still reports `iterations`/`stop_reason`/tool-call count after each turn. `reveal_answer` writes the escalation signal only — the model writes the actual user-facing explanation itself. This keeps the tool surface minimal and avoids double-rendering the answer. Tool handlers are factory-bound (`lookupBulletsTool(db)`) instead of closures over a module-level `db` so tests can construct isolated in-memory databases. The UI re-fetches the full transcript after a turn rather than trusting the turn response's `toolCalls` summary, because the authoritative `messages` array is what `runTutorTurn` persisted — single source of truth.
  - **Intentionally deferred**: token streaming (OD5 fallback — revisit if the tutor feels laggy; SSE route + Anthropic streaming SDK + chunk reassembly would add ~150 LoC to the loop); per-tool-call drill-down UI (the tool strip shows name + error state; deeper inspection is an admin concern, not a study one); session share/export (single-user, local-only); tool-result persistence in the transcript view can get chatty if the user spams — we'll prune or collapse after 50 messages if it becomes a real problem.
- Phase 10 — pending
- Phase 11 — pending
- Phase 12 — pending
- Phase 13 — pending
