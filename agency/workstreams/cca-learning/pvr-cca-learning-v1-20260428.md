---
type: pvr
workstream: cca-learning
principal: bren-squared
slug: v1
version: v1
status: complete
date: 2026-04-28
inputs:
  - spec.md (will be replaced by this PVR upon completion)
  - agency/workstreams/cca-learning/research/repo-analysis-20260428-1230.md
  - agency/workstreams/cca-learning/research/spec-coverage-20260428-1300.md
completeness:
  problem_statement: complete
  target_users: complete
  use_cases: complete
  functional_requirements: complete
  non_functional_requirements: complete
  constraints: complete
  success_criteria: complete
  non_goals: complete
  open_questions: complete
---

# CCA-Learning — Product Vision & Requirements

> **Status:** Draft, in-progress. Each section below is filled by the `/define` 1B1 cycle. When complete, this PVR replaces `spec.md` as the canonical workstream definition.

## 1. Problem Statement

A software engineer preparing for the **Claude Certified Architect (CCA) — Foundations** certification needs an interactive, multi-modality study environment built on the official exam guide. The system must teach all 5 exam domains and 30 task statements, identify the user's weak areas, adapt what it asks next based on demonstrated performance, and let the user take full-length mock exams that mirror real conditions — so that by the time the certification is generally available, the user has high, calibrated confidence they will pass on the first attempt.

**Mastery is tracked along Bloom's Taxonomy levels per task statement** rather than a single score. The system maintains six independent level scores per task statement (Remember → Create) so it can tell the user which cognitive level they have demonstrated and serve items at the next-up level. The exam itself sits in the Apply–Evaluate band, so "exam-ready" means mastered through Evaluate.

**Why now:** the certification is in pre-GA. The user wants the app ready before sitting the exam. Building the app also dogfoods the exact Claude API patterns the exam tests — agentic loops, tool use, structured output, prompt caching, MCP, Batches API, multi-instance review — so building it doubles as hands-on practice with the material.

**For whom (in priority order):**
- **Primary:** the builder, studying for the CCA Foundations exam (single local user is the whole story for v1).
- **Secondary:** other software developers preparing for the same certification (post-v1).
- **Tertiary:** anyone interested in structured, LLM-powered self-study tooling for technical certifications.

## 2. Target Users

### Primary user — the builder

- Software engineer preparing for the CCA Foundations exam.
- Comfortable with TypeScript, Next.js, SQLite, the Anthropic SDK.
- Building the app while studying — fluent in the target material as well as the building material.
- Single local user; runs the app on their own dev hardware.
- Wants calibrated readiness signals, not vibes.
- Reads the official exam guide as the source of truth.

### Behavioral characteristics that shape the design

- **UI must be modern, intuitive, and follow current industry standards.** User-friendliness is a first-class concern — that means thoughtful empty / loading / error states, sensible defaults, clear visual hierarchy, accessible interactions (keyboard and mouse, focus indicators, ARIA where needed), and a UX that doesn't require reading documentation to use. This raises the bar across the whole app, accepted in exchange for a long-run quality floor.
- Wants dark mode and comfortable long-form reading pages.
- Wants to see API spend and cache hit-rate (cost-aware, observability-minded).
- Wants the app to refuse to run without an API key configured (no silent failures).
- Keyboard shortcuts and other power-user affordances are present where they accelerate flow (drill, mock exam, flashcard grading) but are not the defining UX paradigm.

### Secondary users (post-v1, not designed for in v1)

- Other CCA Foundations candidates with similar technical backgrounds.
- Would access via clone-and-run; same single-user model multiplied.

### Tertiary users (post-v1, signal of openness)

- Anyone interested in structured, LLM-powered self-study tooling for technical certifications.

### Explicitly NOT a user persona

- Multi-tenant / multi-user (no auth, no accounts in v1).
- Mobile-first user (v1 is desktop-only by design — see Constraints).
- Certification candidates for other vendors (Anthropic-specific).

## 3. Use Cases

### A. Onboarding (first run)

- Set up Anthropic API key + default model in a guided wizard.
- Run the curriculum ingest (parses the official PDF, seeds the DB).
- Land on the dashboard with empty state + clear next-step prompts.

### B. Daily study session (the golden path)

- Land on the dashboard → see weakest areas, flashcards due today, projected scaled score.
- Click a weak task statement → choose a modality (read, drill, tutor, scenario) → grind a short loop → see mastery move.
- Either pursue **depth** (one task statement across modalities) or **breadth** (one modality across many task statements).

### B′. Progress check-in

- Open the dashboard → look at the trend chart and Bloom heatmap → see scaled-score trajectory and per-domain mastery progression across calendar time.
- Answer the question "am I getting better?" — use the view as a forecast, a motivator, and a weak-area highlighter before deciding what to study next.

### C. Modality workflows (the core seven)

1. **Read explainer** — open a task statement → see verbatim Knowledge/Skills bullets + Claude-generated narrative + 3 inline check questions → grade them, mastery updates.
2. **Flashcard review** — open the deck → see cards due today → flip → grade Again/Hard/Good/Easy → SM-2 reschedules.
3. **MCQ drill** — pick scope (domain / TS / scenario / due-MCQ) → answer 5–20 questions → review explanations → mastery updates → ELO adjusts.
4. **Scenario free-response** — pick a scenario prompt → write a free-text answer → Claude grades against a dynamic rubric → see structured feedback.
5. **Socratic tutor** — pick a topic → multi-turn agentic chat → tutor probes via questions, never lectures → records mastery signals via tools → resumable.
6. **Preparation exercise** — open one of the 4 hands-on exercises → walk through steps → submit artifacts (code, configs, prompts) → Claude grades each step.
7. **Mock exam** — start full-length exam (60 q, 120 min, 4 of 6 scenarios) → server-anchored timer → submit → see scaled score + pass/fail + per-Bloom review.

### D. Maintenance & ops

- **Coverage admin** — open `/admin/coverage` → see (TS × Bloom) cell gaps + bullet blind spots → fill gaps via single-question generation OR submit a bulk Batches API job → poll until done.
- **Spend monitoring** — open `/spend` → see month-to-date cost, role/model breakdown, cache hit rate, recent calls.
- **Settings management** — rotate API key, change default model, set monthly budget, set review half-life.
- **Question flagging** — flag a wrong/ambiguous question to retire it from rotation.

### E. Resume / continuity

- **Resume mock exam** — page refresh / backend restart → attempt state survives, timer is server-anchored → continue where you left off.
- **Resume tutor session** — sessions persisted; reopen, continue chat.

### F. Dev-time integrations

- **MCP curriculum server** — Claude Code sessions running in this repo can call `read_curriculum` / `read_progress` and read `cca://task-statement/{id}` resources, querying the same SQLite DB the app uses. Read-only by tool surface (no write tools). This is a dev-tooling integration, not a user-facing study workflow.

## 4. Functional Requirements

The new FR numbering reorganizes the original `spec.md` taxonomy to fold in v1.1 enhancements and beyond-spec features that have already shipped. Where this PVR diverges from `spec.md`, the divergence is called out inline with **`[CHANGE]`**.

### FR1 — Curriculum Ingest

- **FR1.1** Ingest the official CCA Foundations Exam Guide PDF (Version 0.1, Feb 10 2025) as canonical source material.
- **FR1.2** Parse and persist into a structured model: 5 domains (with weights 27/18/20/20/15), 30 task statements (verbatim Knowledge/Skills bullets), 6 scenarios (with primary-domain mappings), 12 seed questions (with correct answer + explanation), 4 preparation exercises (with reinforced-domain metadata), appendix concepts.
- **FR1.3** Re-ingestion is idempotent — pointing the ingester at an updated guide replaces content without duplicating records.
- **FR1.4** PDF lives at a known local path; everything in the app is the structured/parsed model.

### FR2 — Study Modalities

All modalities read from and write to the same progress model (FR4). Every graded item carries a Bloom level (1–6).

- **FR2.1 Reading / Explainers** — per-TS explainer pages: verbatim bullets + Claude-generated narrative + 3 inline check questions. Cached after first generation; second visit makes zero Claude calls.

- **FR2.2 Flashcards (spaced repetition)**
  - One card per TS minimum, tied to that TS.
  - Front: short prompt; Back: canonical answer + 1–2 sentence "why."
  - SM-2 scheduler with grade buttons (Again/Hard/Good/Easy).
  - Daily review queue surfaces due cards across all domains.
  - **`[CHANGE]`** **Preseed at ingest time:** `npm run ingest` generates a starter card for each of the 30 task statements as a final step, so a fresh DB has ≥30 cards (satisfies AT3 on day one).
  - **`[CHANGE]`** **Admin regenerate:** `/admin/coverage` exposes a "Regenerate flashcards" control that lets the user re-author a deck for one or all task statements — used when the existing cards feel stale or off-target. Existing cards are NOT deleted (their SM-2 state has real user data); new cards are appended alongside.

- **FR2.3 Multiple-Choice Quizzes (untimed drill)** — 4-option questions, scope by domain / TS / scenario / due-MCQ, adaptive serving by Bloom level (drill at ceiling+1 by default; force-level option), per-question explanation references TS *and* Bloom level.

- **FR2.4 Scenario / Free-Response Practice** — scenario context + open-ended prompt → free-text answer → Claude grades against a dynamic rubric (RD4) → structured feedback (score 0–5, strengths, gaps, model answer). Grading runtime is isolated — system prompt contains only the rubric, scenario, and user answer; tool surface narrowed to a single `record_grade` tool. Mirrors the Claude Code `context: fork` + `allowed-tools` isolation pattern API-side.

- **FR2.5 Socratic Tutor Chat**
  - Turn-based agentic loop (inspect `stop_reason`, execute `tool_use`, append results, continue until `end_turn`).
  - Tutor adapts question depth to the user's current Bloom ladder position.
  - Sessions persisted and resumable.
  - **`[CHANGE]`** **Tool surface = `lookup_bullets`, `record_signal`, `spawn_practice_question`, `exit`** — original spec listed three tools; this PVR locks in four. `exit` lets the tutor cleanly terminate when a session has accomplished its goal; `spawn_practice_question` lets the tutor generate a targeted question at a chosen Bloom level inline (rather than handing off to drill mode). Both add agency; both must be implemented before this FR is fully satisfied. (Note: `spawn_practice_question` is **not yet implemented** — see Open Question 9.a.)

- **FR2.6 Mock Exam**
  - 60 questions, 120 minutes, 4 of 6 scenarios randomly selected per attempt, multiple choice only.
  - Per-domain weighting follows 27/18/20/20/15 via largest-remainder apportionment.
  - Apply–Evaluate Bloom band (levels 3–5) — exam-realistic, NOT adapted to user ceiling.
  - Server-anchored timer; pause disabled; unanswered = incorrect.
  - **Scaled score 100–1000 with 720 pass line**, computed via piecewise-linear `rawToScaled` pinned at 72%→720 (RD2).
  - Post-exam review filterable by domain, by correct/incorrect, AND by Bloom level.
  - State persisted after every answer (NFR2.2 — survives refresh / backend restart).

- **FR2.7 Preparation Exercises (Create-level practice)** — the 4 hands-on exercises walk through their steps; user submits artifacts at each step; Claude grades against per-step rubric and returns structured feedback. These are the primary Create-level events.

### FR3 — Question & Content Generation

- **FR3.1** Seed bank: 12 sample questions imported verbatim from the guide; Bloom-classified by a one-shot Claude pass.
- **FR3.2** Generated bank: Claude generates additional questions on demand, constrained via `tool_use` + JSON schema; takes target Bloom level as input.
- **FR3.3** Generated questions cached in the database with stable IDs; never regenerated on view (NFR4.1).
- **FR3.4** Each question stores: stem, 4 options, correct index, per-option explanations, source TS, source scenario (if any), model-reported difficulty, **Bloom level + one-line justification**, **knowledge_bullet_idxs / skills_bullet_idxs** (E3 — bullet-level provenance).
- **FR3.5** **Independent reviewer pass** — second Claude call in fresh context reviews each generated question for correctness, unambiguous single answer, plausible distractors, and Bloom-level accuracy. Rejected items don't enter the active bank. Mirrors D4.6 (multi-instance review).
- **FR3.6** User can flag → retired from active rotation; flagged items are queued for review.
- **FR3.7** Per-(TS × Bloom) coverage targets (≥5 active questions per cell at levels 1–5); coverage gaps surfaced in `/admin/coverage` and trigger targeted gap-fill.
- **FR3.8** **`[CHANGE]`** **Coordinator-subagent generation pipeline** — original spec promised a 3-subagent decomposition for question generation (D1.2 dogfooding) but the implementation collapsed to single-generator + reviewer. This PVR commits to refactoring the generator into the coordinator-subagent pattern: three specialized subagents tuned for MCQ generation — **(a) stem writer** (drafts the question stem given task statement + Bloom + scenario), **(b) key & distractor designer** (correct answer + 3 plausible-but-specifically-wrong distractors), **(c) explanation writer** (per-option didactic explanations) — plus an **orchestration-code coordinator** that injects per-subagent context, validates bullet citations locally, assembles the `emit_question` payload, and routes reviewer violations to the relevant subagent for targeted retry. Reviewer pass (FR3.5) runs once on the synthesized output, not per subagent. Cost: ~2× more Claude calls per question (3 Sonnet subagents + 1 Haiku reviewer ≈ 4 calls vs. current 2). Payoff: real D1.2 dogfooding rather than checkbox dogfooding. **Not yet implemented** — see Open Question 9.A.2. *(Amended 2026-04-28 during /design — original literal language inherited from spec.md was scenario-grading-flavored and didn't fit MCQ generation; see Amendments log below.)*
- **FR3.9** **Bullet-level coverage tracking** (E3) — `/admin/coverage` renders a "Bullet blind spots" view listing every `(TS, kind, idx)` tuple with zero active questions. Generator pipeline rejects candidates whose declared `knowledge_bullet_idxs` / `skills_bullet_idxs` are out of range.
- **FR3.10** **Bulk generation via Anthropic Batches API** — for cost-efficient backfill of coverage gaps. 50% Batches discount applied to cost calculations.
- **FR3.11** **Question deduplication pipeline** — admin can trigger a Claude-driven scan for semantically duplicate questions within each (TS × Bloom) cell. Duplicates retire the redundant items, keep the best (preferring seed-sourced, then clearer wording). Test coverage is currently absent — see Open Question 9.c.

### FR4 — Progress Tracking & Analytics

- **FR4.1** Append-only progress events; every interaction (MCQ, flashcard, scenario, tutor signal, exercise step grade) records `{kind, taskStatementId, bloomLevel, success, payload}`.
- **FR4.2 — Bloom Ladder (per task statement)** — six independent level scores (Remember → Create), each computed as a decay-weighted success rate. Mastery threshold: score ≥ 0.80 AND ≥5 events. User's "ceiling" = highest mastered level. "Exam-ready" = mastered through Evaluate (level 5). Decay half-life is user-configurable (default 14 days).
- **FR4.3** Per-TS summary = OD2-weighted sum across the 6 levels (weights 1/2/4/8/16/32). Per-domain summary = unweighted mean of TS summaries within domain.
- **FR4.4** Weak-area ranked list — top 5 lowest-summary × highest-domain-weight TS, annotated with current Bloom ceiling, with one-click drill button targeting ceiling+1.
- **FR4.5** Improvement-over-time view: per-domain summary mastery + projected scaled score over calendar time.
- **FR4.6** Dashboard: readiness estimate, per-domain mastery bars, mock exam history, flashcards-due tile, last-session recap, **30 × 6 Bloom heatmap** (TS × Bloom levels) with click-to-drill.
- **FR4.7** **ELO calibration (E4)** — per-question Glicko-1 rating drifted by every MCQ event; per-(user, TS, Bloom) skill rating maintained in `userSkill` table. Drill allocator accepts a `targetSuccessRate` parameter (default 0.7) to pick questions in the desirable-difficulty zone.

### FR5 — Settings & API Key Management

- **FR5.1** First-run wizard collects API key + default model.
- **FR5.2** Key encrypted at rest (AES-256-GCM), server-only, never returned to client (status responses redact to `prefix…suffix`).
- **FR5.3** All Claude API calls proxied through backend; frontend never sees the key.
- **FR5.4** Rotate key, choose default + cheap model tiers, set monthly token budget, set bulk-job cost ceiling.
- **FR5.5** Settings page exposes review-half-life knob (RD1, OD4 review intensity) and dark-mode toggle (FR10.1).

### FR6 — Cost & Spend Observability

- **FR6.1** Every Claude call logged to `claudeCallLog` table: input/output/cache_creation/cache_read tokens, estimated cost, role, model, batch flag, timestamp.
- **FR6.2** `/spend` page renders: month-to-date USD, role/model breakdown tables, recent-calls table, cache efficiency panel.
- **FR6.3 — Cache hit-rate observability (E1)** — per-role hit rate computed as `cache_read / (cache_read + cache_creation + uncached_input)`. Roles declared `cacheSystem: true` (tutor, generator, explainer, card-writer, deduplicator) get a hit rate; roles with `cacheSystem: false` are labelled "no-cache" and omitted from warning logic. A cached role with hit rate < 50% over ≥10 calls renders an amber pill.
- **FR6.4** Soft warnings when monthly budget exceeded.
- **FR6.5** Bulk job cost projection — before submitting a Batches API job, the user sees the projected cost (with 50% Batches discount applied) and the configurable `bulkCostCeilingUsd` (0–50 USD) as a hard ceiling.

### FR7 — Coverage & Bulk Generation Maintenance

- **FR7.1** `/admin/coverage` renders the (TS × Bloom 1–5) coverage matrix with cell counts, gap counts, and totals.
- **FR7.2** Sync fill: generate up to 10 questions on the server, sequentially, with per-question reviewer pass (used for small ad-hoc fills).
- **FR7.3** Async bulk: submit a Batches API job to fill coverage gaps; the UI persists job state in `bulkGenJobs` and polls until complete. Cost is projected and bounded by `bulkCostCeilingUsd`.
- **FR7.4** Bullet blind-spot panel (E3) — see FR3.9.
- **FR7.5** Question dedup admin (FR3.11) — admin trigger, results summary, retire-confirmation.
- **FR7.6** Flashcard regeneration admin — see FR2.2.

### FR8 — SRS Re-test for Missed MCQs (E2)

- **FR8.1** Every missed MCQ feeds the SM-2 scheduler that drives flashcards (`lib/progress/sm2.ts`). Correct = `quality=4` ("good"); wrong = `quality=1` ("again").
- **FR8.2** `mcq_review_state` table tracks ease, interval, next due. Drill scope `due-mcq` returns due items in due-soonest order.
- **FR8.3** Dashboard "MCQs due" tile with click-through to `/drill/run?scope=due-mcq`.

### FR9 — MCP Curriculum Server (E5)

- **FR9.1** Stdio MCP server registered in `.mcp.json` as `cca-curriculum`; launched via `npx tsx scripts/mcp-curriculum.ts`.
- **FR9.2** Two read-only tools: `read_curriculum({taskStatementId|scenarioId|domainId})` (exactly one), `read_progress({taskStatementId})`.
- **FR9.3** 30 read-only resources at `cca://task-statement/{id}` returning rendered Markdown of verbatim Knowledge/Skills bullets.
- **FR9.4** Read-only enforcement is by tool surface (no write tools registered) — documented constraint.

### FR10 — User Preferences

- **FR10.1** Dark mode toggle persisted in settings; layout uses class-based theme with FOUC prevention.
- **FR10.2** Review-half-life knob (1–120 days; default 14) controls mastery decay.
- **FR10.3** Keyboard shortcuts implemented across drill, mock exam, flashcard grading; `/shortcuts` reference page lists them.

## 5. Non-Functional Requirements

### NFR1 — Performance

- **NFR1.1** Dashboard and study pages should render in <500ms on local dev hardware. **Aspirational, not blocking** — verified by feel until a regression appears or a benchmark is added.
- **NFR1.2** MCQ "submit answer" round trip should be <150ms when the question is pre-cached (no Claude call on the hot path). **Aspirational, not blocking** — same rule as NFR1.1.
- **NFR1.3** Mock exam timer drift <1 second over 120 minutes. Server-anchored deadline; already satisfied.

### NFR2 — Reliability

- **NFR2.1** Any Claude call that fails mid-generation returns a structured error to the UI; progress state is never corrupted.
- **NFR2.2** In-progress mock exams survive page refresh and backend restart (state persisted after every answer).
- **NFR2.3** Tool errors carry `{isError, errorCategory, isRetryable, message}` shape across all roles (dogfoods D2.2).

### NFR3 — Security & Privacy

- **NFR3.1** Anthropic API key never leaves the backend after initial submission. Never logged. Never returned to the client (status responses redact to `prefix…suffix`).
- **NFR3.2** **`[CHANGE]`** SQLite database file permissions set to `0o600` (user-only read/write) at db-init time via `fs.chmodSync(dbPath, 0o600)`. Closes the gap on day one rather than relying on umask defaults.
- **NFR3.3** No third-party analytics or telemetry in v1.

### NFR4 — Cost Control

- **NFR4.1** Generated content cached and reused; no Claude call on already-answered MCQs or already-rendered explainers (AT11).
- **NFR4.2** Per-month token budget configurable in settings, with a soft warning when exceeded.
- **NFR4.3** Prompt caching used where supported — system prompts on tutor, generator, explainer, card-writer, deduplicator are eligible for `cache_control: ephemeral`.
- **NFR4.4** Bulk generation uses the Anthropic Batches API for the 50% Batches discount.

### NFR5 — Usability

- **NFR5.1** Single command to run (`npm run dev`) after `.env` setup. No external services required for v1.
- **NFR5.2** Modern, intuitive UI following current industry standards (per Target Users §2). Includes thoughtful empty / loading / error states, accessible interactions (keyboard + mouse, focus indicators, ARIA where appropriate), sensible defaults so the app is usable without reading docs first.
- **NFR5.3** Dark mode available; long-form reading pages use comfortable line length.
- **NFR5.4** Keyboard shortcuts present where they accelerate flow (drill, mock exam, flashcard grading); not the defining UX paradigm.

### NFR6 — Maintainability

- **NFR6.1** Curriculum model defined in code with types; adding a task statement or scenario is a one-file change plus a re-ingest.
- **NFR6.2** Claude prompts centralized in `prompts/` with YAML frontmatter (`id`, `version`, `inputs`, `outputs`, `notes`); tunable without feature-code surgery.
- **NFR6.3** Path-specific rules enforce conventions (`.claude/rules/prompts.md`, `.claude/rules/tools.md`) — autoload when files matching those paths are edited.
- **NFR6.4** Tool schemas carry detailed descriptions explicitly differentiating siblings (dogfoods D2.1).

### NFR7 — Observability

- **NFR7.1** Every Claude API call recorded in `claudeCallLog` (FR6.1).
- **NFR7.2** Cost projection visible before bulk operations (FR6.5).
- **NFR7.3** Structured tool errors visible in API responses with category and retryability (NFR2.3).

## 6. Constraints

### Technical

- **C1 Local-only deployment.** v1 runs locally; no hosted environment, no deployment target. Design must not preclude later deployment, but v1 is built for local first.
- **C2 Single-user data model.** No authentication, no user accounts, no multi-tenant support. The whole app is keyed on "the one user." (Also stated as a Non-Goal in §8 — appears in both because it's both an architectural constraint shaping every downstream decision and a thing we are explicitly not doing in v1.)
- **C3 SQLite as the only persistence layer.** No external database, no caching service, no message queue. One file on disk via Drizzle ORM.
- **C4 Anthropic SDK as the only LLM integration.** No OpenAI, no Gemini, no local models. Anthropic-specific patterns (`tool_use`, prompt caching, Batches API) are dogfooded on purpose.
- **C5 Next.js (App Router) + TypeScript + Tailwind.** Frontend stack is fixed. Server components for reading pages; client components for interactive study modes.
- **C6 No vector DB / embeddings.** Out of scope per the guide; not used.
- **C7 No fine-tuning.** Out of scope per the guide; not used.

### Content

- **C8 Verbatim curriculum text.** Exam-guide task statement titles, Knowledge bullets, and Skills bullets are stored verbatim — never paraphrased — so we can cite them and detect updates when the guide is republished.
- **C9 No fabricated questions on out-of-scope topics.** Generation must not produce questions about fine-tuning, cloud provider specifics, OAuth/billing, vision, or token-counting internals (per the guide's Out-of-Scope list).

### Algorithmic

- **C10 SM-2 for spaced repetition.** Documented algorithm; used by both flashcards and missed-MCQ re-test (FR8). No hand-wavy heuristics.
- **C11 Glicko-1 for question difficulty + user skill calibration.** Documented algorithm; used by FR4.7.
- **C12 Decay-weighted mastery scoring.** Explicit formula (`0.5^(age/halfLife)`); not hand-wavy.

### Regulatory / Privacy

- **C13 No third-party telemetry or analytics.** All observability is internal (call log, spend dashboard). Sensitive data (API key, prompts, completions, progress) stays on the local machine.
- **C14 No browser-side API key.** All Claude calls proxy through the backend; the key never reaches the client.

### Operational

- **C15 Anthropic API key is the only credential.** No additional API keys, OAuth flows, or external service auth in v1.
- **C16 Default models track the latest stable Claude tiers.** Generation / grading / tutoring use the **latest stable Sonnet**; cheap-tier review passes and bulk generation use the **latest stable Haiku**. Both are user-configurable in settings; the defaults move forward as Anthropic ships new model versions rather than pinning to a specific ID.

## 7. Success Criteria

Reorganized from `spec.md` S1–S8 into two groups: user outcomes (the "why we built this") and system properties (the "did we build it right"). Both groups must be satisfied for v1 to be considered done.

### Group A — User outcomes

- **S1** I can complete a full end-to-end study session (pick a topic → read explainer → drill flashcards → answer MCQs → get scored feedback) without leaving the app.
- **S2** A full-length mock exam (60 questions, 120 minutes, 4 of 6 scenarios drawn at random) runs and scores on the same scaled 100–1000 model (720 = pass) the real exam uses.
- **S3** After ≥5 study sessions, the app surfaces a ranked list of my weakest task statements and can launch a targeted drill for any of them in one click.
- **S6** All 30 task statements from the exam guide are represented as first-class entities the app can drill, tutor, and track mastery against.
- **S8** Mastery is tracked along Bloom's Taxonomy levels per task statement, not as a single score. The app can tell me for each TS the highest cognitive level I have demonstrated and adapts what it serves next to push me up that ladder.

### Group B — System properties

- **S4** Per-domain mastery scores update after every graded interaction and trend over time on the dashboard.
- **S5** My API key is entered once, stored only on the server, **never sent to the browser after submission**, and **all Claude calls are made by the backend** (the frontend never invokes the Anthropic SDK directly).
- **S7** The app runs locally with a single command after `.env` setup; no external database, queue, or auth service required for v1.

## 8. Non-Goals

Explicit "we are not doing this in v1" statements that prevent scope creep. Constraints (architectural rules) live in §6; this section captures features we are choosing to skip.

- **N1 — No multi-user / authentication / accounts.** Single local user is the whole story for v1. (Also stated as Constraint C2 — it appears in both because it shapes the architecture and explicitly excludes a feature class.)

- **N2 — No hosted deployment.** Local-only for v1. Design must not preclude later deployment, but no Docker images, no CI/CD pipeline, no domain, no SSL provisioning.

- **N3 — No mobile app, no responsive layout for phones.** Desktop-only for v1. Tablets may work incidentally; not designed for.

- **N4 — No leaderboards or social-comparison gamification.** No global rankings, no XP-vs-other-users, no shared badges. Lightweight **self-streaks** (consecutive study days) and other personal-progress motivators are not committed in v1 but are not ruled out for later — they don't violate any other principle if added with care.

- **N5 — No in-app data export UI in v1.** The SQLite file IS the export — any analysis (spreadsheet, dashboard, ad-hoc query) happens with external tooling against that file. A first-class export UI may come later if there's real demand.

- **N6 — No real-time collaboration.** No shared sessions, no co-tutoring with another human, no chat-with-other-learners.

- **N7 — No fine-tuning of Claude.** Out of scope per the guide; never used.

- **N8 — No vector DB or embedding-based retrieval.** Out of scope per the guide; not used. The curriculum is small enough (30 task statements, 6 scenarios, 12 seed questions) that exact-match lookup suffices.

- **N9 — No browser automation, vision tooling, or audio I/O.** Out of scope per the guide.

- **N10 — No questions on out-of-scope topics.** Generation never produces questions about cloud-provider specifics, OAuth/billing, fine-tuning internals, vision, or token-counting (per the guide's Out-of-Scope list). Enforced in `prompts/generator.md` and the reviewer pass.

- **N11 — No in-app PDF viewer.** The original guide PDF stays on disk for the user to open separately. Everything in the app is the structured/parsed model (RD3).

- **N12 — No paraphrased curriculum text in storage.** Task statement titles, Knowledge bullets, and Skills bullets are stored verbatim. Paraphrasing happens at presentation time (narratives, explanations) but never overwrites canonical text.

- **N13 — No regeneration on every view.** Generated content (MCQs, explainers, flashcards, rubrics) is cached in the DB with stable IDs and reused. Regeneration is opt-in via admin controls (FR2.2 admin regenerate, FR3.11 dedup retire).

- **N14 — No third-party telemetry, analytics, or user tracking.** All observability is internal.

## 9. Open Questions

Open questions are tracked in three groups: implementation commitments not yet shipped (A), verification items that are believed satisfied but not directly confirmed during Phase 2 of `/define` (B), and strategic / process questions about how this PVR evolves (C).

### Group A — Implementation gaps to close (priority order)

Worked in **most-load-bearing-first** order. v1 is considered closed when this group is empty (see §9.C.1).

1. **9.A.5 — SQLite file permissions (NFR3.2).** Add `fs.chmodSync(dbPath, 0o600)` to db init. Estimate: 5 minutes. Free win.
2. **9.A.4 — Dedup test coverage (FR3.11).** Add unit tests for `scanForDuplicates`, `retireDuplicates`, the `emitDedupVerdictInputSchema.refine()` validation, the hallucination guard, and the API route's payload schema. Estimate: ~½ day. Closes a real risk in shipped code.
3. **9.A.3 — Flashcard preseed at ingest + admin regenerate (FR2.2).** Final step in `npm run ingest` generates ≥1 card per TS via Haiku (~$0.30). Plus a "Regenerate flashcards" control on `/admin/coverage`. Estimate: 1 day. Fixes AT3 on day one.
4. **9.A.1 — `spawn_practice_question` tutor tool (FR2.5).** New tool in the tutor's tool surface; tutor can generate a targeted question at a chosen Bloom level inline. Estimate: 1–2 days. Completes the four-tool tutor agent.
5. **9.A.2 — Coordinator-subagent question generation pipeline (FR3.8).** Refactor the single-generator into 3 subagents (scenario-context writer, rubric drafter, model-answer drafter) + a coordinator that synthesizes. Reviewer pass (FR3.5) runs against the synthesized output. Estimate: ~5 days. Largest single piece of unfinished work in this PVR; properly dogfoods D1.2.

### Group B — Verification items (believed satisfied, not directly confirmed)

These are quick verifications — typically reading one file, running one test, or skimming one UI surface.

- **9.B.1** Weak-area drill button + ceiling annotation on dashboard (FR4.4).
- **9.B.2** Mock exam review filter UI: by domain, correct/incorrect, AND by Bloom level (FR2.6).
- **9.B.3** Preparation exercise grading writes `progress_events` rows with `bloomLevel = 6` (Create) — AT16.
- **9.B.4** Latency benchmark for scenario grading: response within 10 seconds (AT5).
- **9.B.5** `/study/task/[id]` purpose: confirm whether it's the canonical TS detail page or stale scaffolding.
- **9.B.6** Generator prompt uses the 12 seed questions as few-shot examples for matching scenarios (D4.2 dogfooding).
- **9.B.7** Generator pipeline retries on validation failure with the specific validation error in the retry prompt (D4.4 dogfooding).
- **9.B.8** Re-running `npm run ingest` against an unchanged guide produces zero new rows (FR1.3 idempotency).
- **9.B.9** Dev-time custom skills `.claude/skills/grade-scenario.md` and `.claude/skills/generate-question.md` exist with the documented frontmatter (D3.2 dogfooding, AT18).

### Group C — Strategic / process

- **9.C.1 — v2 trigger.** v1 is closed when **all of Group A is empty** (every implementation commitment in this PVR is shipped). v2 begins as a separate PVR at that point.
- **9.C.2 — PVR evolution model.** This PVR is a **fixed v1 snapshot**. It is amended only to mark Group A items resolved, Group B items verified, or to correct language errors discovered during `/design` / `/plan` — never to add new requirements. New requirements live in v2's PVR. `/design` and `/plan` work against this stable v1 PVR; the framework expects this discipline.

---

## Amendments

Auditable record of post-publication edits to this PVR. Each amendment includes the date, the section affected, and the reason.

| Date | Section | Change | Reason |
|------|---------|--------|--------|
| 2026-04-28 | FR3.8 | Replaced literal subagent list (`scenario-context writer`, `rubric drafter`, `model-answer drafter`) with MCQ-fit list (`stem writer`, `key & distractor designer`, `explanation writer`) + clarified the coordinator is orchestration code, not a Claude call. Updated cost estimate from "~2.5× / 5 calls" to "~2× / 4 calls". | Original literal language was scenario-grading-flavored and inherited verbatim from `spec.md` D1.2; it did not fit MCQ generation. Discovered during `/design` Item 1 (architecture overview). Decision driven via 1B1; full rationale in `agency/workstreams/cca-learning/ad-cca-learning-coord-subagent-20260428.md` §1. |
