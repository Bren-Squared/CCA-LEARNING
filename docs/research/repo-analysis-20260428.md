---
type: research
workstream: cca-learning
principal: bren-squared
date: 2026-04-28 12:30
phase: 1 of 3 (analysis → gap → PVR)
inputs: light-pass parallel structural read
agents: 2 Explore subagents (frontend + backend)
---

# CCA-Learning — Repo Structural Analysis

Light-pass map of the codebase produced by two parallel Explore subagents. Descriptive only — no spec comparison, no fixes proposed. Phase 2 produces the gap matrix from this map.

---

## Frontend — `app/`

### Page routes

| Path | Purpose | Server/Client | Notable imports |
|------|---------|---------------|-----------------|
| `/` | Dashboard: heatmap + trend + weak areas + budget | Server (force-dynamic) | `buildDashboard`, `buildTrendSeries`, `computeReadiness`, `readBudgetStatus` |
| `/drill` | Drill launcher: scope counts + due MCQ | Server | `countQuestionsByScope`, `countDueMcqs` |
| `/drill/run` | Drill session runner | Server + DrillSession client | `buildDrillPool`, `parseScope`, `DrillSession` |
| `/mock` | Mock exam launcher | Server + MockStartButton | `mockExamConfig`, `MockStartButton` |
| `/mock/[id]` | Mock exam runner (40 questions, timed) | Client (MockExamRunner) | `MockExamRunner` |
| `/mock/[id]/review` | Attempt review side-by-side | Server | — |
| `/study/scenarios` | Scenario index | Server | `listScenarios` |
| `/study/scenarios/[promptId]` | Scenario response grader | Client (ScenarioGrader) | `ScenarioGrader` |
| `/study/exercises` | Exercise index | Server | `listExercises`, `preparationSteps`, `preparationAttempts` |
| `/study/exercises/[id]` | Exercise step grader | Client | `ExerciseStepGrader` |
| `/study/flashcards` | Flashcard review queue (SM-2) | Server | `countDueCards`, `FlashcardReview` |
| `/study/tutor` | Tutor session launcher | Server | `NewSessionForm` |
| `/study/tutor/[id]` | Tutor chat (multi-turn, tools) | Client | `TutorChat` |
| `/study/task/[id]` | Task statement detail | Client | `StudyTaskDetail` |
| `/admin/coverage` | Coverage matrix + bulk + dedup admin | Server | `buildCoverageReport`, `BulkSection`, `CoverageFillForm`, `DedupSection` |
| `/settings` | API key + model + budget config | Server + SettingsForm | `getSettingsStatus`, `SettingsForm` |
| `/spend` | Spend dashboard: role/model/cache stats | Server | `computeSpendSummary`, `CacheEfficiencyPanel` |
| `/shortcuts` | Static keyboard reference | Static | — |

### API routes (21)

| Path | Method | Purpose | Calls |
|------|--------|---------|-------|
| `/api/progress` | POST | Append progress event | `writeProgressEvent` |
| `/api/claude/hello` | GET | Smoke test wiring | `callClaude` |
| `/api/debug/mastery` | GET | Mastery snapshot debug | `readMasterySnapshot` |
| `/api/exercises/[stepId]/grade` | POST | Grade exercise artifact | `gradeExerciseStep` |
| `/api/flashcards/grade` | POST | Grade flashcard recall | `updateFlashcardGrade` |
| `/api/mock/[id]` | GET | Fetch mock attempt | `getMockAttempt` |
| `/api/mock/[id]/answer` | POST | Submit MCQ answer | `submitAnswer` |
| `/api/mock/[id]/finish` | POST | Finalize attempt | `finishAttempt` |
| `/api/questions/[id]/flag` | POST | Flag question | `flagQuestion` |
| `/api/scenario/grade` | POST | Grade scenario response | `gradeScenarioResponse` |
| `/api/scenario/prompts` | GET | Bulk prompt load | `listScenarioPrompts` |
| `/api/study/explainer` | POST | Generate explanation | `generateExplainer` |
| `/api/study/generate-question` | POST | Generate one question | `generateOneQuestion` |
| `/api/admin/coverage/fill` | POST | Sync fill (≤10) | `generateOneQuestion`, `selectFillTargets` |
| `/api/admin/coverage/bulk` | POST | Async bulk via Batches API | `submitBulkJob`, `selectFillTargets` |
| `/api/admin/coverage/bulk/[id]` | GET | Bulk job status | `getBulkJob` |
| `/api/admin/coverage/bulk/[id]/poll` | GET | Poll batches API | (Batches wrapper) |
| `/api/admin/coverage/dedup` | POST | Run dedup pipeline | `deduplicateQuestions` |
| `/api/tutor/sessions` | POST | Create tutor session | `createTutorSession` |
| `/api/tutor/sessions/[id]` | GET | Fetch session state | `getTutorSession` |
| `/api/tutor/sessions/[id]/turn` | POST | Send tutor turn (loop) | `sendTutorTurn` |

### Shared/layout

- `app/layout.tsx` — Root server layout, dark-mode FOUC prevention
- `app/AppNav.tsx` — Top sticky nav, tabs, API-key pill (gated on configured)
- `app/NavTab.tsx` — Active-path nav link with optional badge
- `app/BloomHeatmap.tsx` — 30×6 grid, mastery-colored, drill-clickable
- `app/TrendChart.tsx` — Inline SVG domain + readiness lines

### Frontend observations

- All pages use `force-dynamic` (no ISR caching)
- Server components dominate; client only where interactive
- Custom Error subclasses with status-code mapping (`MockAttemptError`, `ExerciseError`, `NoApiKeyError`)
- Zod validation on every POST payload
- `/study/task/[id]` is lightly linked from nav — possibly under-surfaced

---

## Backend — `lib/`, `drizzle/`, `prompts/`, `scripts/`, `tests/`

### Schema (20 tables, 9 migrations through `0008_rich_tyger_tiger`)

| Table | Purpose | Notes |
|-------|---------|-------|
| `domains` | D1–D5 metadata | parent of taskStatements |
| `taskStatements` | 30 TS w/ K/S bullets | parent of questions, flashcards, scenarioPrompts |
| `scenarios` | 6 scenario contexts | linked via scenarioDomainMap |
| `scenarioDomainMap` | N:M with `isPrimary` | — |
| `questions` | MCQs + Bloom + ELO + bullet idxs | E3 (bullet coverage) + E4 (Elo) implemented |
| `flashcards` | SM-2 cards (ease, interval) | — |
| `preparationExercises` | Exercises + reinforced domains | parent of preparationSteps |
| `preparationSteps` | Per-step prompt + rubric | parent of preparationAttempts |
| `progressEvents` | Append-only event log | references TS, Bloom, success |
| `masterySnapshots` | Per (TS, Bloom) score + count | derived from progressEvents |
| `mockAttempts` | Mock exam state | statuses: in_progress / submitted / timeout / reviewed |
| `scenarioPrompts` | Per (scenario, TS, Bloom) prompt + rubric | — |
| `scenarioAttempts` | Free-response answers + score + feedback | — |
| `tutorSessions` | Chat history JSON + topic | — |
| `userSkill` | ELO 1500 default, 350 vol, per Bloom | E4 |
| `mcqReviewState` | SM-2 schedule for missed MCQs (`due_at` indexed) | E2 |
| `bulkGenJobs` | Batches API job tracking | — |
| `claudeCallLog` | Per-call tokens, cost, role, model, cache stats | NFR4.3 / E1 source |
| `settings` | Singleton: encrypted API key, models, budgets, ingest hash | — |

Mastery threshold: score ≥ 0.80 AND itemCount ≥ 5. Bloom weights 1–6 → {1, 2, 4, 8, 16, 32}.

### lib/claude/ (the heart)

| Role | Tier | Cache | Tools | System prompt |
|------|------|-------|-------|---------------|
| tutor | default | no | lookup_bullets, record_signal, exit | `prompts/tutor.md` |
| generator | default | yes | emit_question | `prompts/generator.md` |
| reviewer | cheap | no | (sync, no tools) | `prompts/reviewer.md` |
| grader | default | no | record_grade | `prompts/grader.md` |
| rubric-drafter | default | no | emit_rubric | `prompts/rubric-drafter.md` |
| explainer | default | yes | (output only) | `prompts/explainer.md` |
| card-writer | cheap | yes | emit_card | `prompts/card-writer.md` |
| deduplicator | cheap | yes | (output only — verdict in JSON) | `prompts/deduplicator.md` |

Pricing: Sonnet 4.6 ($3 in / $15 out), Haiku 4.5 ($1 in / $5 out). Batch discount 0.5×. Cache writes 1.25×, reads 0.1×, TTL 5 min.

Tool error categories enforced: transient | validation | business | permission, with `isError`, `isRetryable`. (D2.2)

### lib/ subdirs (selected — see file for full)

- `lib/curriculum/` — PDF parser + ingest (ingest.ts seeds DB; parser.ts is 16 KB; classify-bloom calls Claude)
- `lib/progress/` — `mastery.ts` decay math, `events.ts` append, `elo.ts` Glicko-1, `sm2.ts`, `dashboard.ts`, `trend.ts`
- `lib/study/` — `bulk-gen.ts` (Batches), `generator.ts` (single-q + reviewer), `coverage.ts`, `drill.ts`, `dedup.ts`, `cards.ts`, `mcq-srs.ts`, `explainer.ts`
- `lib/scenarios/` — `prompts.ts` seed + load, `grade.ts` Claude grading
- `lib/exercises/` — `steps.ts` load + rubric seed, `grade.ts` artifact grading
- `lib/tutor/` — `loop.ts` agentic loop (stop_reason driven), `case-facts.ts` context block, `sessions.ts` persist
- `lib/mock/` — `allocate.ts`, `attempts.ts`
- `lib/settings/` — `crypto.ts` AES, accessors
- `lib/spend/` — `summary.ts` aggregation + cache hit rate + budget warnings
- `lib/mcp/` — `curriculum-server.ts` read-only MCP (E5)

### Tests — 38 files, ~290 cases

Coverage hot spots: generator pipeline, tutor loop, bulk-gen, scenario grader, exercise grader, mastery math, mock allocate, MCQ SRS, ELO, bullet coverage, spend summary.

Coverage cold spots: API routes (integration), MCP resource URIs, scenario narrative generation, mock raw → scaled scoring.

### Scripts (8)

`ingest.ts`, `seed-flashcards.ts`, `seed-progress.ts`, `seed-scenario-prompts.ts`, `run-grade-scenario.ts`, `dump-pdf.ts`, `backfill-bullet-coverage.ts`, `mcp-curriculum.ts`

### MCP server

Read-only via tool surface (no write tools). Exposes:
- `read_curriculum({ taskStatementId | scenarioId | domainId })` (exactly one)
- `read_progress({ taskStatementId })` → mastery snapshot rows

stdio transport, `.mcp.json` registers `node scripts/mcp-curriculum.ts`. Resources (`cca://task-statement/{id}`) appear NOT exposed.

---

## Cross-cutting observations (red flags for Phase 2)

These will likely show up as gaps when compared against `spec.md`:

1. **Mock exam: 40 vs 60 questions.** Frontend agent observed `MockExamRunner` references 40 questions. Spec FR2.6 + AT7 require 60. Need to verify in `lib/mock/allocate.ts` and `mockExamConfig`.
2. **Scaled scoring (raw → 100-1000).** Schema has `rawScore` + `scaledScore` columns; backend agent did not see scaling math implemented.
3. **Card-writer role.** Defined and tested, but no caller wires it into a study loop — Phase 15 prep that hasn't shipped a flashcard-generation flow.
4. **Deduplicator integration.** Role + prompt + tool + scan/retire pipeline + UI all exist; this is the in-progress feature now committed to main. Tests for `lib/study/dedup.ts` were not observed.
5. **MCP resource URIs.** Tools exposed; `cca://task-statement/{id}` resources mentioned in spec are NOT registered.
6. **Scenario narrative generation.** `taskStatements.narrativeMd` field exists; generation pipeline not observed.
7. **Tutor session UI.** DB + tests + UI components present but the backend agent flagged "UI not confirmed active" — worth verifying in Phase 2.
8. **`/study/task/[id]`.** Lightly linked; may be a stub or under-surfaced.

---

## Files & paths the gap analysis (Phase 2) will need to read

For each spec line item, the most likely evidence locations:

| Spec section | Evidence files |
|--------------|----------------|
| FR1 (ingest) | `lib/curriculum/parser.ts`, `lib/curriculum/ingest.ts`, `scripts/ingest.ts`, `tests/ingest-*.test.ts` |
| FR2.1 (explainer) | `lib/study/explainer.ts`, `lib/claude/roles/explainer.ts`, `prompts/explainer.md` |
| FR2.2 (flashcards) | `lib/study/cards.ts`, `lib/progress/sm2.ts`, `app/study/flashcards/`, `lib/claude/roles/card-writer.ts` |
| FR2.3 (MCQ drill) | `lib/study/drill.ts`, `app/drill/`, `tests/drill-pool.test.ts` |
| FR2.4 (scenarios) | `lib/scenarios/`, `app/study/scenarios/`, `tests/scenario-grader*.test.ts` |
| FR2.5 (tutor) | `lib/tutor/`, `app/study/tutor/`, `tests/tutor-*.test.ts` |
| FR2.6 (mock exam) | `lib/mock/`, `app/mock/`, `tests/mock-*.test.ts` |
| FR2.7 (prep exercises) | `lib/exercises/`, `app/study/exercises/`, `tests/exercise-*.test.ts` |
| FR3 (generation) | `lib/study/generator.ts`, `lib/study/bulk-gen.ts`, `lib/claude/roles/generator.ts`, `lib/claude/roles/reviewer.ts` |
| FR4 (progress / mastery) | `lib/progress/`, `app/page.tsx`, `app/BloomHeatmap.tsx`, `app/TrendChart.tsx` |
| FR5 (settings / API key) | `lib/settings/`, `app/settings/` |
| NFR4 (cost) | `lib/claude/tokens.ts`, `lib/spend/summary.ts`, `app/spend/page.tsx` |
| NFR6 (prompts centralized) | `prompts/*.md`, `.claude/rules/prompts.md` |
| E1 (cache hit-rate) | `lib/spend/summary.ts`, `lib/claude/roles/cache-policy.ts`, `app/spend/` |
| E2 (MCQ SRS) | `lib/study/mcq-srs.ts`, `mcqReviewState` table, drill scope `due-mcq` |
| E3 (bullet coverage) | `lib/study/coverage.ts`, `app/admin/coverage/`, `scripts/backfill-bullet-coverage.ts` |
| E4 (Elo) | `lib/progress/elo.ts`, `userSkill` table |
| E5 (MCP) | `lib/mcp/curriculum-server.ts`, `scripts/mcp-curriculum.ts`, `.mcp.json` |
