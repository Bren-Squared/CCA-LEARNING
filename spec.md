# Claude Certified Architect — Foundations Learning Application

## User Story
As a software engineer preparing for the Claude Certified Architect (CCA) — Foundations certification, I want a single-user web application that turns the official exam guide into an interactive, multi-modality study environment. The app should teach me the five exam domains, identify my weak areas, adapt what it asks next based on my performance, and let me take full-length mock exams that mirror the real thing — so that by the time the certification is generally available, I have high, calibrated confidence that I will pass on the first attempt. The path to building this also doubles as hands-on practice with the Claude API, tool use, structured output, and agentic patterns — all of which the exam itself covers.

## Stakeholders
- **Primary**: Myself — the builder and first user, studying for the CCA Foundations exam.
- **Secondary**: Other software developers preparing for the same certification. v1 is optimized for a single local user; later versions may open up to this audience.
- **Tertiary**: Anyone interested in structured, LLM-powered self-study tooling for technical certifications.

## Success Criteria
- **S1** — I can complete a full end-to-end study session (pick a topic → read explainer → drill flashcards → answer MCQs → get scored feedback) without leaving the app.
- **S2** — A full-length mock exam (60 questions, 120 minutes, 4 of 6 scenarios drawn at random) runs and scores on the same scaled 100–1000 model (720 = pass) the real exam uses.
- **S3** — After ≥ 5 study sessions, the app surfaces a ranked list of my weakest task statements and can launch a targeted drill for any of them in one click.
- **S4** — Per-domain mastery scores update after every graded interaction and trend over time on a dashboard.
- **S5** — My Anthropic API key is entered once, stored only on the server (never sent to the browser after initial submit), and all Claude calls are proxied through the backend.
- **S6** — All 30 task statements from the exam guide are represented as first-class entities the app can drill, tutor, and track mastery against.
- **S7** — The app runs locally with a single command after `.env` setup; no external database or auth service required for v1.
- **S8** — Mastery is tracked along Bloom's Taxonomy levels per task statement, not as a single score. The app can tell me for each task statement the highest cognitive level I have demonstrated, and adapts what it serves next to push me up that ladder.

## Functional Requirements

### FR1 — Content Ingestion & Curriculum Model
- FR1.1 Ingest the official CCA Foundations Exam Guide PDF (Version 0.1, Feb 10 2025) as canonical source material.
- FR1.2 Parse and persist the curriculum into a structured model:
  - 5 **Domains** with weights (D1 27%, D2 18%, D3 20%, D4 20%, D5 15%)
  - 30 **Task Statements** (D1: 1.1–1.7, D2: 2.1–2.5, D3: 3.1–3.6, D4: 4.1–4.6, D5: 5.1–5.6), each with its verbatim "Knowledge of" and "Skills in" bullets
  - 6 **Scenarios** (Customer Support Resolution Agent, Code Generation with Claude Code, Multi-Agent Research System, Developer Productivity with Claude, Claude Code for Continuous Integration, Structured Data Extraction) with their primary-domain mappings
  - 12 **Sample Questions** with correct answer + explanation
  - 4 **Preparation Exercises** with domains-reinforced metadata
  - Appendix concepts (Technologies, In-Scope Topics, Out-of-Scope Topics)
- FR1.3 Re-ingestion is idempotent: pointing the ingester at an updated guide version replaces content without duplicating records.
- FR1.4 Exam guide PDF lives in the repo (or a known local path) and is the single source of truth — explainers, tutor prompts, and question generators cite task statement IDs from this model.

### FR2 — Study Modalities
All modalities read from and write to the same progress model (FR4) so mastery updates are consistent across modes. Every graded item carries a Bloom's Taxonomy level (see FR4.B) so modalities can be filtered and sequenced by cognitive depth:
- **MCQ (FR2.3)** covers Bloom levels 1–5 (Remember, Understand, Apply, Analyze, Evaluate).
- **Scenario free-response (FR2.4)** and **preparation exercises (FR2.7)** are the only modalities that can test level 6 (Create).
- **Flashcards (FR2.2)** target levels 1–2 primarily.
- **Tutor (FR2.5)** ranges across all six levels adaptively.

- **FR2.1 Reading / Explainers**
  - Per-task-statement explainer pages built from the guide's Knowledge/Skills bullets, expanded by Claude into a readable narrative with concrete examples.
  - Inline "check your understanding" questions at the end of each explainer; answering them feeds progress tracking.

- **FR2.2 Flashcards (spaced repetition)**
  - Each flashcard is tied to one task statement.
  - Front: a short prompt (concept, code snippet, scenario fragment). Back: the canonical answer plus a 1–2 sentence "why."
  - SRS scheduler using SM-2 (or equivalent). User grades recall (again/hard/good/easy) after flipping.
  - Daily review queue surfaces due cards across all domains.

- **FR2.3 Multiple-Choice Quizzes (untimed drill)**
  - 4-option questions (1 correct, 3 distractors) — matches exam format.
  - User selects a domain, task statement, or scenario to drill; the app serves 5–20 questions from that slice.
  - Questions are **adaptively served by Bloom level**: the drill starts at the user's current highest-mastered level for that task statement and mixes in items one level above to probe readiness for promotion. A "force level" option lets the user drill at a specific Bloom level on demand.
  - After each question: show correct answer, the user's choice, and an explanation referencing the underlying task statement **and the Bloom level being tested**.

- **FR2.4 Scenario / Free-Response Practice**
  - User is shown a scenario context and an open-ended prompt (e.g., "Design a coordinator-subagent breakdown for this research task").
  - User writes a free-text answer. Claude grades it against a dynamic rubric (RD4) derived from the task statement's Skills bullets and returns structured feedback (score 0–5, strengths, gaps, model answer).
  - This modality is the primary vehicle for **Apply, Analyze, Evaluate, and Create** practice.
  - **Runtime isolation (Skill-pattern on the API side)**: the grading call runs in a fresh, single-purpose Claude API context. System prompt contains only the rubric, scenario, and user answer — no tutor chat history, no other study state. Tool access is narrowed to a single `record_grade` tool with a strict JSON schema. This mirrors the Claude Code `context: fork` + `allowed-tools` isolation pattern but is an API-side implementation (dogfoods Domain 3.2 conceptually; Domain 2.3 in practice via scoped tool access).

- **FR2.5 Socratic Tutor Chat**
  - Turn-based chat. User picks a topic (domain or task statement) and the tutor probes understanding via questions, hints, and follow-ups rather than lecturing.
  - Tutor has tool access to: pull the current task statement's Knowledge/Skills bullets, record a mastery signal **tagged with the Bloom level demonstrated** when the user shows understanding, and generate a targeted practice question at a specified Bloom level on demand.
  - Tutor adapts question depth to the user's current Bloom ladder position for that task statement.
  - Sessions are persisted and resumable.

- **FR2.6 Mock Exam**
  - **Format mirrors the real exam**: 60 questions, 120 minutes, 4 of 6 scenarios selected at random per attempt, multiple choice only.
  - Weighted to match domain percentages (27/18/20/20/15) as closely as 60 questions allow.
  - Timer with pause disabled; unanswered questions scored as incorrect (matches exam rule).
  - **Scaled score 100–1000 with 720 pass line**, computed from raw percentage using a transparent mapping (documented in the app).
  - Post-exam review: every question with explanation, filterable by domain, by correct/incorrect, **and by Bloom level** (so the user can see, e.g., whether they lost points mostly on Evaluate-level items).
  - Mock attempts are first-class records used for longitudinal tracking.
  - Mock exams draw from the **full Bloom range present in the real exam** (empirically: Apply through Evaluate) rather than adapting to the user's ladder — they must simulate real conditions.

- **FR2.7 Preparation Exercises (Create-level practice)**
  - The 4 hands-on exercises from the guide (Build a Multi-Tool Agent, Configure Claude Code for Team Workflow, Build a Structured Data Extraction Pipeline, Design and Debug a Multi-Agent Research Pipeline) are first-class modalities.
  - Each exercise walks through its steps; the user submits artifacts (code snippets, configs, prompts) at each step.
  - Claude grades the artifact against a per-step rubric and returns structured feedback.
  - These are the primary **Create-level** interactions and reinforce multiple domains per exercise (per the guide's "Domains reinforced" metadata).

### FR3 — Question & Content Generation (Hybrid Bank)
- FR3.1 **Seed bank**: the 12 sample questions from the guide are imported verbatim and tagged with domain, task statement, scenario, **and a Bloom level classified by a one-shot Claude pass** (verified manually during ingestion).
- FR3.2 **Generated bank**: Claude generates additional questions on demand from task statement bullets, constrained via tool-use + JSON schema (itself a topic on the exam — dogfood it). Generation takes a **target Bloom level** as an input parameter so the bank fills evenly across levels.
- FR3.3 Generated questions are **cached in the database**, not regenerated each time; every question has a stable ID.
- FR3.4 Each generated question includes: stem, 4 options, correct index, per-option explanation, source task statement ID, source scenario (if any), a model-reported difficulty (1–5), and a **`bloom_level` (1–6)** with a one-line justification.
- FR3.5 Quality gate: a second independent Claude call reviews each generated question for correctness, unambiguous single answer, plausible distractors, **and Bloom-level accuracy** (rejecting items whose claimed level doesn't match the cognitive demand) before it enters the active bank. Mirrors Domain 4's "multi-instance review" task statement.
- FR3.6 User can flag a question as "wrong/ambiguous" or "mis-leveled"; flagged questions are retired from active rotation and queued for review.
- FR3.7 The generator maintains **per-task-statement level coverage targets** (e.g., at least 5 active questions at each of levels 1–5 per task statement). Coverage gaps are surfaced in a maintenance view and can trigger targeted generation.

### FR4 — Progress Tracking & Analytics
- FR4.1 Every graded interaction (MCQ answer, flashcard grade, scenario score, tutor-signaled mastery, preparation-exercise step grade) writes an immutable event to the progress log. Each event records the **Bloom level of the item** and whether the user succeeded at that level.
- **FR4.B Bloom Ladder (per task statement)** — The core mastery model. For each of the 30 task statements, the app tracks an **independent accuracy score (0–100) at each of Bloom's 6 levels**: Remember, Understand, Apply, Analyze, Evaluate, Create. Scores use the same user-configurable recency-decayed rolling window (RD1).
  - A level is considered **mastered** when its score is ≥ 80% over at least 5 recent items at that level.
  - A user's **current ceiling** for a task statement is the highest level they have mastered.
  - A user is considered **exam-ready** for a task statement when they have mastered through **Evaluate** (level 5). Create (level 6) is aspirational / beyond-the-exam reinforcement.
- FR4.2 **Per-task-statement mastery score** is a derived summary = weighted sum across the six Bloom levels (higher levels weighted more), producing a single 0–100 roll-up for list views. The underlying ladder is always available on the detail view.
- FR4.3 **Per-domain mastery score** aggregated from its task statements' summary scores.
- FR4.4 **Weak-area identification**: ranked list of the 5 task statements with the lowest summary mastery × highest domain weight. The list also annotates each item with its current Bloom ceiling (e.g., "D1.2 — ceiling: Understand, target: Evaluate"). One-click "drill this" launches a targeted MCQ set at the next level above the ceiling.
- FR4.5 **Improvement over time** view: per-domain summary mastery, per-task-statement Bloom ceiling progression, and mock-exam scaled scores plotted over calendar time.
- FR4.6 Dashboard shows: overall readiness estimate (projected scaled score), per-domain mastery bars, mock exam history, flashcards due today, last-session recap, **and a "Bloom heatmap" — a 30 × 6 grid (task statements × Bloom levels) colored by mastery, giving an at-a-glance view of where the user stands across the whole ladder**.

### FR5 — Settings & API Key Management
- FR5.1 First-run wizard collects the Anthropic API key and a preferred default model.
- FR5.2 Key is persisted server-side only (SQLite or local `.env` with file-permission guidance); it is never returned to the browser after submission.
- FR5.3 All Claude API calls are proxied through the backend; the frontend never sees the key.
- FR5.4 Settings page lets the user rotate the key, choose the default model, and view approximate API spend for the current session/month (token usage × published price, best-effort).

## Non-Functional Requirements

### NFR1 — Performance
- NFR1.1 Dashboard and study pages render in < 500ms on local dev hardware.
- NFR1.2 MCQ "submit answer" round trip < 150ms when the question is pre-cached (no Claude call on the hot path).
- NFR1.3 Mock exam timer drift < 1 second over 120 minutes.

### NFR2 — Reliability
- NFR2.1 Any Claude call that fails mid-generation returns a structured error to the UI and does not corrupt progress state.
- NFR2.2 In-progress mock exams survive a page refresh or backend restart (state persisted after every answer).

### NFR3 — Security & Privacy
- NFR3.1 API key never leaves the backend after initial submission; never logged; never sent in telemetry.
- NFR3.2 SQLite database file permissions set to user-only read/write.
- NFR3.3 No third-party analytics or telemetry in v1.

### NFR4 — Cost Control
- NFR4.1 Generated content is cached and reused; no Claude call is made for already-answered MCQs or already-rendered explainers.
- NFR4.2 Per-session token budget configurable in settings, with a soft warning when exceeded.
- NFR4.3 Prompt caching is used where supported to reduce cost on repeated calls with large stable context (e.g., the ingested guide).

### NFR5 — Usability
- NFR5.1 Single command to run (`npm run dev` or equivalent) after `.env` setup.
- NFR5.2 Keyboard shortcuts for flashcard grading and MCQ selection.
- NFR5.3 Dark mode available; long-form reading pages use a comfortable line length.

### NFR6 — Maintainability
- NFR6.1 Curriculum model is defined in code with types; adding a new task statement or scenario is a single-file change plus a re-ingest.
- NFR6.2 Claude prompts used for generation, grading, and tutoring are centralized (not scattered across feature code) so they can be tuned and versioned.

## Explicit Constraints (DO NOT)
- **DO NOT** store the Anthropic API key in browser storage, cookies, or any client-side location. Backend-only.
- **DO NOT** call the Claude API from the frontend. All calls proxy through the backend.
- **DO NOT** regenerate MCQ questions or explainers on every view — everything generated is cached with a stable ID.
- **DO NOT** add authentication, user accounts, or multi-tenant support in v1. Single local user is the whole story.
- **DO NOT** deploy to any hosted environment in v1. Local-only. Design must not preclude later deployment, but don't build for it now.
- **DO NOT** paraphrase the exam guide's task statement titles, Knowledge bullets, or Skills bullets when storing them — preserve verbatim so we can cite them and detect updates.
- **DO NOT** fabricate questions that rely on out-of-scope topics (fine-tuning, cloud provider specifics, OAuth/billing, vision, token-counting internals — see the guide's Out-of-Scope list).
- **DO NOT** implement spaced repetition, scoring, or mastery math by hand-wavy heuristics — use a documented algorithm (SM-2 for SRS; explicit formula for mastery decay) so results are reproducible.
- **DO NOT** build features not specified here (leaderboards, social sharing, gamified badges, mobile apps, exporters). If tempted, write it down as a v2 candidate and move on.

## Technical Context

### Recommended Stack (no strong preference from user — pick for velocity)
- **Frontend**: Next.js (App Router) + TypeScript + Tailwind. Server components for reading pages; client components for interactive study modes.
- **Backend**: Next.js API routes (or a thin separate Node/TypeScript server if cleaner) calling the Anthropic TypeScript SDK.
- **Database**: SQLite via Drizzle or Prisma. Single file on disk. No migrations service needed for v1.
- **Claude model**: Default `claude-sonnet-4-6` for generation/grading/tutoring; `claude-haiku-4-5-20251001` for cheap review passes and bulk question generation. User-configurable in settings.
- **PDF parsing**: A node PDF library (e.g., `pdf-parse`, `unpdf`) for initial extraction; one-shot pass at ingestion time — not on the hot path.

### Data Model (sketch)
- `domains(id, title, weight)`
- `task_statements(id, domain_id, title, knowledge_bullets[], skills_bullets[])`
- `scenarios(id, title, description, primary_domain_ids[])`
- `questions(id, stem, options[], correct_index, explanations[], task_statement_id, scenario_id?, difficulty, bloom_level: 1..6, bloom_justification, source: 'seed'|'generated', status: 'active'|'flagged'|'retired')`
- `flashcards(id, task_statement_id, front, back, bloom_level: 1..2, sm2_state{ease, interval, due_at})`
- `progress_events(id, ts, kind, task_statement_id, bloom_level, success: bool, payload_json)` — append-only
- `mastery_snapshots(task_statement_id, bloom_level, score, item_count, updated_at)` — one row per (task_statement, bloom_level); the FR4.2 summary is derived
- `preparation_exercises(id, title, domains_reinforced[], steps[])`
- `preparation_attempts(id, exercise_id, step_idx, artifact_text, grade, feedback, ts)`
- `mock_attempts(id, started_at, finished_at, question_ids[], answers[], raw_score, scaled_score, passed)`
- `tutor_sessions(id, topic_id, messages[], created_at, updated_at)`
- `settings(api_key_encrypted, default_model, token_budget_month)`

### Claude Integration Patterns
- **Structured output**: use `tool_use` with strict JSON schemas for question generation, grading rubrics, and flashcard generation (dogfoods Domain 4 — Task Statement 4.3).
- **Prompt caching**: cache the ingested guide content in the system prompt for tutor and generation calls (reduces cost on repeat calls).
- **Independent review pass**: a second Claude call, in a fresh context, reviews each generated question before activation (dogfoods Domain 4 — Task Statement 4.6).
- **Few-shot examples**: the 12 seed sample questions serve as few-shot examples when generating new questions for the same scenario (dogfoods Domain 4 — Task Statement 4.2).

### Repo Layout (proposed)
- `/app` — Next.js routes (dashboard, study, mock, settings)
- `/lib/claude` — Anthropic client, prompts, tool schemas
- `/lib/curriculum` — ingested guide model and helpers
- `/lib/progress` — mastery math, SRS scheduler
- `/data` — SQLite file (gitignored), ingested guide artifacts
- `/scripts/ingest.ts` — one-shot PDF → DB
- `/prompts` — versioned prompt templates
- `tasks/todo.md`, `tasks/lessons.md` — per CLAUDE.md workflow

### Dev-Time Claude Code Setup
The repo itself is configured as a learning artifact. These files dogfood Domain 3 and make the codebase easier to work on with Claude Code:

- **`CLAUDE.md`** (project root) — already present; project workflow rules.
- **`.claude/skills/grade-scenario.md`** — custom Skill for iterating on the scenario grader. Frontmatter: `context: fork` (isolates grading experimentation from the main session), `allowed-tools: [Read, Edit, Bash]`, `argument-hint: <scenario-id> <candidate-answer-path>`. Running `/grade-scenario` loads the rubric, runs the grading prompt, and prints a structured result — ideal for tuning rubric wording without polluting the main conversation.
- **`.claude/skills/generate-question.md`** — custom Skill for iterating on question generation. Frontmatter: `context: fork`, `argument-hint: <task-statement-id> <bloom-level>`. Lets the developer generate and review a question end-to-end (including the second-pass review) without affecting main-session context.
- **`.claude/commands/ingest.md`** — project-scoped slash command wrapping `npm run ingest`.
- **`.claude/rules/prompts.md`** — YAML frontmatter `paths: ["prompts/**/*.md"]`. Enforces prompt-file conventions (header with ID, inputs, outputs, versioning note) so editing any prompt loads the right rules.
- **`.claude/rules/tools.md`** — YAML frontmatter `paths: ["lib/claude/tools/**/*.ts"]`. Enforces tool-schema conventions (detailed descriptions differentiating similar tools, structured error shape with `isError`, `errorCategory`, `isRetryable`).
- **`.mcp.json`** (optional, v2) — exposes the curriculum SQLite as an MCP server so Claude Code sessions can query the same data the app uses. Deferred until the app is running end-to-end.

## Dogfooding Strategy
A first-class design principle: **the implementation of this app should exercise as many exam-relevant concepts as possible**, so that building it reinforces what the app teaches. Choices below are made for learning value as much as for function. The matrix maps each exam concept to where it shows up in the codebase — runtime, dev-time, or both. `[Natural]` = falls out of good design anyway; `[Deliberate]` = chosen specifically to dogfood; `[Deferred]` = valuable but can wait for v2.

**Domain 1 — Agentic Architecture & Orchestration**
- **D1.1 Agentic loops** `[Deliberate]` — The Socratic tutor (FR2.5) is implemented as a full agentic loop: inspect `stop_reason`, execute `tool_use` calls (`lookup_bullets`, `record_mastery`, `spawn_practice_question`), append tool results, continue until `end_turn`. No ad-hoc control flow.
- **D1.2 Coordinator-subagent pattern** `[Deliberate]` — Question generation uses a coordinator that delegates to three subagents: (a) scenario-context writer, (b) rubric drafter, (c) model-answer drafter. The coordinator synthesizes and hands off to the review pass. The reviewer is itself a distinct subagent with isolated context.
- **D1.4 Multi-step workflows with handoffs** `[Natural]` — Preparation exercises (FR2.7) are multi-step workflows where each step's artifact is the input to the next step's grading context.
- **D1.5 Hooks** `[Deferred]` — Not applicable at API runtime; revisit for v2 CI integration.
- **D1.6 Task decomposition** `[Deliberate]` — Mock exam generation uses prompt chaining (deterministic decomposition): pick scenarios → allocate question counts by domain weight → request batches per (scenario, task_statement, bloom_level) cell.

**Domain 2 — Tool Design & MCP Integration**
- **D2.1 Tool descriptions** `[Deliberate]` — All internal tool schemas (`record_grade`, `generate_question`, `record_mastery`, `lookup_bullets`, etc.) carry detailed descriptions that explicitly differentiate them from siblings. Enforced via `.claude/rules/tools.md`.
- **D2.2 Structured errors** `[Deliberate]` — Every tool returns `{ isError, errorCategory: 'transient'|'validation'|'business'|'permission', isRetryable, message }` rather than bare strings. The tutor agent handles each category appropriately.
- **D2.3 Tool distribution** `[Deliberate]` — Each API role gets only its relevant tools: tutor has `lookup_bullets`/`record_mastery`/`spawn_practice_question`; grader has only `record_grade`; generator has only `emit_question`. No shared god-bag.
- **D2.4 MCP servers** `[Deferred]` — Curriculum SQLite exposed as an MCP server for dev-time Claude Code sessions (see Dev-Time Claude Code Setup). v2.
- **D2.5 Built-in tools (Read, Write, Edit, Bash, Grep, Glob)** `[Natural]` — Used constantly during development with Claude Code.

**Domain 3 — Claude Code Configuration & Workflows**
- **D3.1 CLAUDE.md hierarchy** `[Natural]` — Project-level `CLAUDE.md` already in repo.
- **D3.2 Custom slash commands & Skills** `[Deliberate]` — `.claude/skills/grade-scenario.md` and `.claude/skills/generate-question.md` with `context: fork` + `allowed-tools` for isolated dev-time iteration. `.claude/commands/ingest.md` wraps the ingester.
- **D3.3 Path-specific rules** `[Deliberate]` — `.claude/rules/prompts.md` and `.claude/rules/tools.md` with YAML `paths` frontmatter for conditional convention loading.
- **D3.4 Plan mode vs direct execution** `[Natural]` — Mandated by `CLAUDE.md` for non-trivial tasks.
- **D3.5 Iterative refinement** `[Natural]` — Interview pattern + test-driven iteration during build.
- **D3.6 Claude Code in CI/CD** `[Deferred]` — v2: GitHub Action that runs `claude -p` against PRs for automated review.

**Domain 4 — Prompt Engineering & Structured Output**
- **D4.1 Explicit criteria** `[Deliberate]` — Rubric prompts use category-specific criteria, never "be conservative" / "high-confidence" hedges.
- **D4.2 Few-shot prompting** `[Deliberate]` — The 12 seed questions serve as few-shot examples when generating new questions for the same scenario.
- **D4.3 Structured output via `tool_use` + JSON schemas** `[Deliberate]` — Every Claude call that returns structured data uses `tool_use` with a strict schema. No string-parsing.
- **D4.4 Validation-retry loops** `[Deliberate]` — Question generator's review pass is the validation step; failures are resubmitted with the specific validation error (e.g., "two options marked correct" or "claimed Apply-level but stem only requires recall").
- **D4.5 Message Batches API** `[Deliberate]` — Bulk generation to fill per-(task-statement × bloom-level) coverage gaps uses the Batches API for 50% cost savings; not used for user-facing hot-path calls.
- **D4.6 Multi-instance review** `[Deliberate]` — Every generated question goes through an independent Claude instance for review before activation (FR3.5).

**Domain 5 — Context Management & Reliability**
- **D5.1 Context management** `[Deliberate]` — Tutor sessions extract transactional facts (current task statement, bloom ceiling, recent misses) into a persistent "case facts" block in every turn. Tool outputs are trimmed to relevant fields before being added to context.
- **D5.2 Escalation patterns** `[Deliberate]` — The tutor escalates to "show the answer and explain" when the user explicitly asks, when three consecutive Socratic hints have failed, or when the user hits a policy-gap case (item the tutor can't resolve).
- **D5.3 Error propagation** `[Deliberate]` — Subagents in the question-generation coordinator return structured error context (failure type, attempted query, partial results) rather than generic failures.
- **D5.4 Large-session context** `[Natural]` — Dev-time: Explore subagent for codebase exploration, `/compact` during long sessions.
- **D5.6 Information provenance** `[Deliberate]` — Every generated explainer, question, and flashcard is stored with its source task statement ID (and relevant bullets) so origin is always traceable.

**Explicitly not dogfooded** (out of scope or not useful here): fine-tuning, embedding models / vector DBs, vision, browser automation, cloud provider configs, OAuth. These align with the guide's Out-of-Scope list and are excluded by constraint.

## Acceptance Tests

- **AT1 — Ingestion**: Running `npm run ingest` against the official guide PDF populates exactly 5 domains, 30 task statements, 6 scenarios, and 12 seed questions. Re-running is a no-op (no duplicates).
- **AT2 — Explainer**: Opening Task Statement 2.1 renders a reading page containing the verbatim Knowledge/Skills bullets plus a Claude-generated narrative. The narrative is cached; a second visit makes no Claude call.
- **AT3 — Flashcards**: A fresh deck of ≥ 30 cards exists (≥ 1 per task statement). Grading a card updates its SM-2 interval and the next due date. Cards due today appear in the review queue.
- **AT4 — MCQ Drill**: Selecting "Drill Domain 1" serves 10 questions weighted across D1's task statements. Submitting each answer shows the correct option and explanation. Answers are persisted and update mastery.
- **AT5 — Scenario Grading**: Submitting a free-text response to a Scenario 3 prompt returns a structured grade (0–5), strengths, gaps, and a model answer within 10 seconds.
- **AT6 — Tutor**: Starting a tutor session on Task Statement 1.2 produces a question (not a lecture) as the first message. The tutor can call its "record mastery" tool and the signal appears in progress events.
- **AT7 — Mock Exam**: Starting a mock exam produces 60 questions over 4 distinct scenarios with a 120-minute timer. Submitting (or timing out) yields a scaled score in 100–1000 and a pass/fail flag (720 threshold). The attempt appears in history.
- **AT8 — Weak Areas**: After ≥ 50 graded events, the dashboard surfaces a ranked list of the 5 weakest task statements weighted by domain. Clicking one launches a targeted MCQ drill.
- **AT9 — Improvement Over Time**: Dashboard chart shows per-domain mastery across at least the last 14 days, and every completed mock attempt's scaled score.
- **AT10 — API Key Security**: After first-run setup, the API key is not present in any frontend bundle, network response body, or browser storage. Rotating the key in settings works without exposing the previous one.
- **AT11 — Cost Control**: Viewing an already-generated explainer or answering an already-cached MCQ issues zero Claude API calls.
- **AT12 — Question Quality Gate**: A deliberately malformed generated question (e.g., two correct options) is caught by the review pass and does not enter the active bank.
- **AT13 — Bloom Ladder**: For any task statement, the progress detail view shows six independent level scores (Remember → Create), each with item count. Answering five correct Understand-level MCQs for a cold task statement moves its Understand score above the mastery threshold and raises its ceiling.
- **AT14 — Adaptive Serving**: Drilling a task statement whose current ceiling is Understand serves MCQs predominantly at Apply (next-up level), with a minority sprinkled at Understand (reinforcement) and not yet at Analyze+.
- **AT15 — Bloom Heatmap**: The dashboard renders a 30 × 6 grid of task statements × Bloom levels, colored by mastery score, and clicking any cell launches a drill at that level.
- **AT16 — Preparation Exercise**: Starting Exercise 1 (Build a Multi-Tool Agent with Escalation Logic) walks through its steps; submitting a tool-description artifact returns a graded rubric and records a Create-level progress event for the task statements the exercise reinforces.
- **AT17 — Grader Isolation**: The FR2.4 grading call, inspected via backend logs, contains only the rubric, scenario, and user answer — no tutor chat messages, no unrelated study events. A single `record_grade` tool is the only tool offered.
- **AT18 — Dev-Time Skill**: Running `/grade-scenario <scenario-id> <answer-file>` inside Claude Code executes in an isolated forked context and prints a structured grade without polluting the main session transcript.
- **AT19 — Structured Tool Errors**: A simulated transient failure in the question generator produces `{ isError: true, errorCategory: 'transient', isRetryable: true }`, and the coordinator retries; a simulated business-rule failure produces `{ errorCategory: 'business', isRetryable: false }` and surfaces a user-facing message.

## Resolved Design Decisions
- **RD1 — Mastery decay is user-configurable.** Settings exposes a "review intensity" knob that controls the recency half-life. App ships with a sensible default (tuned against real session data once available; provisional: events older than 14 days weighted at 0.5). Users who want more frequent review can shorten the half-life; users who want to space things out can lengthen it.
- **RD2 — Scaled score is an approximation.** App uses a linear mapping anchored at 72% raw → 720 scaled (pass line). The settings and mock-exam result pages display a clear banner: "Anthropic does not publish the exam's raw-to-scaled formula. Scores here are an approximation for practice only."
- **RD3 — Parsed explainers only, no in-app PDF viewer.** The original guide stays on disk for the user to open separately; everything in the app is the structured/parsed model.
- **RD4 — Scenario free-response rubrics are dynamic.** Each rubric is derived from the specific Skills bullets being tested for that prompt, generated once at prompt-creation time and stored alongside the prompt so grading is deterministic across attempts.
- **RD5 — Mastery is tracked along Bloom's Taxonomy, not a single score.** Every question, flashcard, tutor signal, and exercise submission is tagged with a Bloom level (1–6). Per task statement, the app maintains six independent level scores that form a ladder the user climbs. MCQ covers levels 1–5; Create (level 6) lives in scenario free-response and preparation exercises. The exam itself sits in the Apply–Evaluate band, so "exam-ready" = mastered through Evaluate. Rationale: a single mastery score can't distinguish "knows the definitions" from "can diagnose a broken multi-agent pipeline," which is exactly the gap the CCA exam tests. The extra modeling cost is accepted in exchange for sharper readiness signals.
