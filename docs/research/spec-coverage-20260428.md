---
type: research
workstream: cca-learning
principal: bren-squared
date: 2026-04-28 13:00
phase: 2 of 3 (analysis → gap → PVR)
inputs: spec.md (lines 1-287) + Phase 1 analysis + targeted file reads
---

# CCA-Learning — Spec-vs-Reality Gap Matrix

Verified by reading the actual code, not just trusting the structural map. Several Phase-1 "red flags" turned out to be false positives — they are noted as **REVISED** below.

**Legend**
- ✓ **Complete** — implemented, tested, observable in app
- ◐ **Partial** — implemented but with material gaps (missing tests, missing UI surface, missing edge cases)
- ✗ **Missing** — not implemented
- ⚠ **Divergent** — implemented but doesn't match spec contract
- ? **Unverified** — couldn't fully confirm in time budget

---

## Phase-1 red flag corrections

| Phase-1 claim | Reality | Verdict |
|---------------|---------|---------|
| Mock exam runs 40 questions, spec says 60 | `MOCK_TOTAL_QUESTIONS = 60` in `lib/mock/allocate.ts:18`; `finishMockAttempt` divides by 60 | **FALSE alarm** |
| Scaled scoring not implemented | `rawToScaled()` in `lib/mock/attempts.ts:91-101` is piecewise-linear pinned at 72%→720 | **FALSE alarm** |
| Card-writer role not wired into study loop | `lib/study/cards.ts:143` `getOrGenerateDeck` calls Claude with the card-writer role | **FALSE alarm** |
| MCP resource URIs not registered | `lib/mcp/curriculum-server.ts:198-221` registers one resource per TS at `cca://task-statement/{id}` | **FALSE alarm** |
| Scenario narrative generation missing | `lib/study/explainer.ts:158` `getOrGenerateExplainer` writes `taskStatements.narrativeMd` and check questions | **FALSE alarm** |
| Dedup feature has no tests | confirmed — `ls tests/dedup*` returns nothing | **CONFIRMED gap** |
| `/study/task/[id]` lightly linked | not verified in this pass | **Open** |

The light-pass agents were over-cautious about flagging things they didn't read end-to-end. Lesson: structural-map agents can hallucinate gaps that file reads disprove. Don't trust their negative findings without verification.

---

## FR1 — Content Ingestion & Curriculum Model

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| FR1.1 Ingest CCA Foundations PDF v0.1 | ✓ | `lib/curriculum/parser.ts` (16 KB), `lib/curriculum/ingest.ts`, `scripts/ingest.ts`, `tests/ingest-parser.test.ts`, `tests/ingest-persist.test.ts` | — |
| FR1.2 5 domains / 30 TS / 6 scenarios / 12 questions / 4 exercises | ✓ | `lib/curriculum/expected.ts` codifies counts; ingest fails on mismatch | — |
| FR1.3 Idempotent re-ingest | ? | ingest persists with stable IDs, but no explicit idempotency test seen — verify | Add explicit re-ingest test if missing |
| FR1.4 PDF lives in repo, single source of truth | ? | not directly verified | Check `data/` or repo root for PDF presence |

## FR2 — Study Modalities

### FR2.1 Reading / Explainers

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| Per-TS explainer page | ◐ | `lib/study/explainer.ts:158`, `prompts/explainer.md`, frontend agent did not list a `/study/task/[id]/explainer` route | UI surface unconfirmed — does the explainer get rendered on the TS detail page? |
| Inline check questions feed progress | ✓ | `explainer.ts:115-141` inserts check questions into `questions` table tagged `source:'generated'` | — |
| Cached after first generation (AT2 / AT11) | ✓ | `narrativeMd` + `narrativeGeneratedAt` cached on `taskStatements` | — |

### FR2.2 Flashcards

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| One card per TS minimum | ◐ | `card-writer.ts` role + `cards.ts:143` generator | No seed pre-load script verified — cards generated on demand only |
| SM-2 scheduler | ✓ | `lib/progress/sm2.ts`, `tests/sm2.test.ts`, `tests/flashcards.test.ts` | — |
| Daily review queue | ✓ | `lib/study/cards.ts:207` `listDueCards`, `app/study/flashcards/` | — |
| AT3 (≥30 cards exist after seed) | ⚠ | Cards generated lazily per TS, no preseed; AT3 may fail until each of 30 TS has been visited or bulk-seeded | Add a preseed flow or an admin "generate all decks" button |

### FR2.3 MCQ Drill (untimed)

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| 4-option, 1 correct | ✓ | schema + `tests/generator-pipeline.test.ts` | — |
| Scope by domain/TS/scenario | ✓ | `app/drill/page.tsx`, `lib/study/drill.ts:selectNextDrill` | — |
| Adaptive by Bloom level | ✓ | `drill.ts` reads ceiling, biases pool | — |
| Force-level option | ? | unverified | Check `parseScope` in drill |
| Per-question explanation references TS + Bloom | ✓ | `questions.explanations[]` per option, `bloomLevel` column | — |

### FR2.4 Scenario Free-Response

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| Free-text answer + Claude grade | ✓ | `lib/scenarios/grade.ts`, `app/study/scenarios/[promptId]/ScenarioGrader.tsx` | — |
| Dynamic rubric (RD4) | ✓ | `lib/scenarios/prompts.ts` seeds rubrics; `rubric-drafter` role | — |
| Runtime isolation: only `record_grade` tool, no tutor history (AT17) | ✓ | `grader.ts` role narrowed to `record_grade`; verified by `tests/scenario-grader-tool.test.ts` | — |

### FR2.5 Socratic Tutor

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| Agentic loop (stop_reason driven) | ✓ | `lib/tutor/loop.ts:runTutorSession`, `tests/tutor-loop.test.ts` | — |
| Three tools: lookup_bullets / record_signal / spawn_practice_question | ◐ | tutor agent confirmed `lookup_bullets`, `record_signal`, **`exit`** — spec calls for `spawn_practice_question` | Tool surface diverges from spec; resolve which is correct |
| Sessions persisted + resumable | ✓ | `tutorSessions` table, `lib/tutor/sessions.ts`, `tests/tutor-sessions.test.ts` | — |
| AT6 (first message is question, not lecture) | ? | system prompt unverified | Read `prompts/tutor.md` |

### FR2.6 Mock Exam — fully verified

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| 60 questions, 120 min, 4 of 6 scenarios | ✓ | `lib/mock/allocate.ts:18-21`, `MOCK_DURATION_MS`, `pickScenarios` errors below 4 | — |
| Domain weighting via largest-remainder | ✓ | `allocateByLargestRemainder()` line 92 | — |
| Pause disabled, unanswered = wrong | ✓ | `submitAnswer` rejects on terminal status; `finishMockAttempt` counts `null` answers as wrong | — |
| Scaled score 100-1000, 720 pass (RD2) | ✓ | `rawToScaled` piecewise-linear pinned at 72%→720 | — |
| Filterable review (Bloom, correct/incorrect, domain) | ? | review page not deeply read | Confirm filter UI on `/mock/[id]/review` |
| Apply-Evaluate band | ✓ | `MOCK_BLOOM_BAND = [3,4,5]` line 20 | — |
| AT7 (full E2E timer + scaled score + history) | ✓ | covered by `tests/mock-attempts.test.ts`, `tests/mock-allocate.test.ts` | — |

### FR2.7 Preparation Exercises

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| 4 hands-on exercises, multi-step | ✓ | `lib/exercises/steps.ts`, `app/study/exercises/`, `tests/exercise-steps.test.ts` | — |
| Per-step Claude grading vs rubric | ✓ | `lib/exercises/grade.ts`, `tests/exercise-grader.test.ts` | — |
| Records Create-level progress (AT16) | ? | grader writes `progress_events` but Bloom-level=6 not directly verified | Check kind+bloom_level write path |

## FR3 — Question & Content Generation

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| FR3.1 12 seed questions tagged + Bloom-classified | ✓ | `lib/curriculum/bloom-classify.ts`, ingest writes them | — |
| FR3.2 Generated bank w/ tool_use + JSON schema | ✓ | `emitQuestionTool` + Zod schema in `roles/generator.ts` | — |
| FR3.3 Cached in DB, stable IDs | ✓ | `questions.id` UUID, no re-gen on view | — |
| FR3.4 Question shape: stem, 4 options, correct, explanations, TS, scenario, difficulty, bloom_level, justification | ✓ | schema columns all present | — |
| FR3.5 Independent reviewer pass (AT12) | ✓ | `roles/reviewer.ts`, called sync from `bulk-gen.ts` and `generator.ts` | — |
| FR3.6 Flag wrong/ambiguous → retired | ✓ | `coverage.ts:flagQuestion` line 217, `app/api/questions/[id]/flag` | — |
| FR3.7 Per-(TS×Bloom) coverage targets, gap maintenance view | ✓ | `coverage.ts:buildCoverageReport`, `/admin/coverage` UI | — |
| Dedup pipeline (Phase 13c) | ◐ | `lib/study/dedup.ts`, `prompts/deduplicator.md`, role + tool, route, UI all present | **No tests** — `tests/dedup.test.ts` does not exist |

## FR4 — Progress Tracking & Analytics

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| FR4.1 Append-only progress events w/ Bloom level + success | ✓ | `progressEvents` table, `lib/progress/events.ts` | — |
| FR4.B Bloom Ladder: 6 levels × 30 TS, score 0-100, mastery ≥0.80 + ≥5 items (AT13) | ✓ | `mastery.ts` constants `MASTERY_SCORE_THRESHOLD=0.8`, `MASTERY_ITEM_FLOOR=5` | — |
| FR4.2 Per-TS summary (OD2-weighted) | ✓ | `mastery.ts:taskStatementSummary` uses `OD2_BLOOM_WEIGHTS={1,2,4,8,16,32}` | — |
| FR4.3 Per-domain mastery rollup | ✓ | `mastery.ts:domainSummary` (unweighted mean across TS in domain) | — |
| FR4.4 Weak-area ranked list w/ ceiling annotation + drill button (AT8) | ◐ | dashboard renders weak areas; ceiling annotation + one-click drill not deeply verified | Open `/` page render path to confirm |
| FR4.5 Improvement-over-time (AT9) | ✓ | `lib/progress/trend.ts`, `app/TrendChart.tsx` | — |
| FR4.6 Bloom heatmap (30×6, AT15) | ✓ | `app/BloomHeatmap.tsx` | — |
| Adaptive serving (AT14): drills at next-up Bloom | ✓ | `mastery.ts:nextLevel` returns ceiling+1, used by `drill.ts` | — |

## FR5 — Settings & API Key

| Item | Status | Evidence | Gap |
|------|--------|----------|-----|
| FR5.1 First-run wizard | ✓ | `app/settings/SettingsForm.tsx`, status pill in nav | — |
| FR5.2 Server-side only, never returned | ✓ | `getSettingsStatus()` returns redacted only; `getApiKey()` never exposed to client routes | — |
| FR5.3 All Claude calls proxied through backend | ✓ | `lib/claude/client.ts` is server-only; no client-side Anthropic SDK import | — |
| FR5.4 Rotate key + spend view (AT10) | ✓ | `setApiKey`, `clearApiKey`, `/spend` page | — |

## NFR — Non-functional

| NFR | Status | Evidence | Gap |
|-----|--------|----------|-----|
| NFR1.1 Render <500ms | ? | not benchmarked | Add lighthouse or instrument timings |
| NFR1.2 MCQ submit <150ms when cached | ? | not benchmarked | Add an HTTP timing test |
| NFR1.3 Timer drift <1s/120min | ✓ | server-anchored deadline (`startedAt + durationMs`), client renders `remainingMs` from server | — |
| NFR2.1 Failed Claude returns structured error | ✓ | `NoApiKeyError`, tool error categories | — |
| NFR2.2 Mock exam survives refresh | ✓ | `submitAnswer` persists every keystroke; `getMockAttempt` reconstructs | — |
| NFR3.1 Key never logged/sent | ✓ | `redactApiKey` helper, status types exclude raw key | — |
| NFR3.2 SQLite file permissions user-only | ? | `data/` permissions not verified at runtime | Check ingest.ts or db init for chmod |
| NFR3.3 No third-party telemetry | ✓ | no telemetry imports in `package.json` | — |
| NFR4.1 Cached generated content (AT11) | ✓ | explainer cache, generated-question cache, no on-view regen | — |
| NFR4.2 Per-session token budget warning | ✓ | `tokenBudgetMonthUsd` setting, spend page warning | — |
| NFR4.3 Prompt caching where supported | ✓ | `cache-policy.ts` declares 4 cached roles (generator, card-writer, explainer, deduplicator) | — |
| NFR5.1 Single-command run | ✓ | `npm run dev` standard Next.js | — |
| NFR5.2 Keyboard shortcuts | ✓ | drill, mock, flashcards all have shortcuts; `/shortcuts` reference page | — |
| NFR5.3 Dark mode | ✓ | `setDarkMode` setting, layout FOUC prevention | — |
| NFR6.1 Curriculum model in code w/ types | ✓ | `lib/curriculum/types.ts`, `expected.ts` | — |
| NFR6.2 Prompts centralized & versioned | ✓ | `prompts/*.md` all carry frontmatter `id` + `version`; `.claude/rules/prompts.md` enforces | — |

## Acceptance Tests (AT1-AT24)

| AT | Status | Notes |
|----|--------|-------|
| AT1 Ingestion | ✓ | `tests/ingest-*.test.ts` |
| AT2 Explainer | ◐ | Cached generation works; UI render path needs visual confirmation |
| AT3 Flashcards ≥30 cards exist | ⚠ | Lazy generation only — fresh DB has 0 cards until visit. Add preseed |
| AT4 MCQ Drill | ✓ | `tests/drill-pool.test.ts` |
| AT5 Scenario grading <10s | ? | speed not benchmarked, correctness verified in tests |
| AT6 Tutor first message is a question | ? | depends on `prompts/tutor.md` content |
| AT7 Mock exam 60-q / 120-min / scaled / pass flag | ✓ | `tests/mock-*.test.ts` cover all branches |
| AT8 Weak areas after ≥50 events | ◐ | dashboard renders, drill-link UI needs confirmation |
| AT9 Improvement over time | ✓ | TrendChart + tests/trend-readiness |
| AT10 API key not in browser | ✓ | code review confirms server-only |
| AT11 Zero Claude calls on cached items | ✓ | explainer + question cache logic |
| AT12 Malformed question caught by reviewer | ✓ | reviewer rejects; tested in `tests/generator-pipeline.test.ts` |
| AT13 Bloom ladder display | ✓ | mastery.ts + BloomHeatmap |
| AT14 Adaptive serving | ✓ | `nextLevel(ceiling+1)` |
| AT15 Heatmap clickable cells | ✓ | BloomHeatmap component |
| AT16 Prep exercise grades & records | ◐ | grading works; Create-level event write path needs verification |
| AT17 Grader isolation | ✓ | grader role, single tool, no chat history |
| AT18 Dev-time skill `/grade-scenario` | ? | `.claude/skills/grade-scenario.md` not directly verified — was in spec section "Dev-Time Claude Code Setup" |
| AT19 Structured tool errors | ✓ | `tests/at19-structured-errors.test.ts`, `tests/tool-errors.test.ts` |
| AT20 Cache hit-rate panel | ✓ | `lib/spend/summary.ts`, `cache-policy.ts`, `tests/spend-summary.test.ts` |
| AT21 MCQ re-test queue | ✓ | `lib/study/mcq-srs.ts`, `tests/mcq-srs.test.ts`, drill scope `due-mcq` |
| AT22 Bullet-level coverage | ✓ | `coverage.ts` builds blind-spot list, generator + reviewer enforce idx range |
| AT23 ELO calibration | ✓ | `lib/progress/elo.ts`, `tests/elo.test.ts`, `userSkill` table, `targetSuccessRate` knob |
| AT24 MCP curriculum server | ✓ | `lib/mcp/curriculum-server.ts`, `.mcp.json` registered, 30 resources + 2 tools, `tests/mcp-server.test.ts` |

## Resolved Design Decisions (RD1-RD5)

| RD | Status | Evidence |
|----|--------|----------|
| RD1 Mastery decay user-configurable, 14-day default | ✓ | `mastery.ts:DEFAULT_HALF_LIFE_DAYS=14`, `setReviewHalfLifeDays` setting |
| RD2 Linear scaled score, 72%→720 anchor | ✓ | `rawToScaled` piecewise-linear |
| RD3 No in-app PDF viewer | ✓ | parsed model only |
| RD4 Dynamic rubrics from Skills bullets | ✓ | `rubric-drafter` role, prompts seeded per scenario |
| RD5 Bloom ladder mastery model | ✓ | mastery.ts implementation |

## v1.1 Enhancements (E1-E5)

| E | Status | Evidence |
|----|--------|----------|
| E1 Cache hit-rate observability | ✓ | spend page renders per-role rate, amber pill < 50% |
| E2 SRS re-test missed MCQs | ✓ | `mcq-srs.ts`, `mcqReviewState` table |
| E3 Bullet-level coverage | ✓ | `knowledgeBulletIdxs`/`skillsBulletIdxs` cols, blind-spot view |
| E4 Elo calibration | ✓ | `userSkill` table, `lib/progress/elo.ts`, drill `targetSuccessRate=0.7` |
| E5 MCP curriculum server | ✓ | full implementation (tools + resources + .mcp.json) |

## Dogfooding strategy items (Domains 1-5)

Most are observable from the implementation already counted above. Highlights:

| Item | Status |
|------|--------|
| D1.1 Agentic loops in tutor | ✓ |
| D1.2 Coordinator-subagent in question gen | ◐ — single-call generator + sync reviewer; coordinator-subagent breakdown not literally implemented |
| D1.6 Prompt chaining for mock | ✓ — allocate.ts decomposes scenarios → domain quotas → cells |
| D2.1 Tool descriptions differentiate siblings | ✓ — enforced by `.claude/rules/tools.md` |
| D2.2 Structured errors | ✓ |
| D2.3 Tool distribution per role | ✓ |
| D2.4 MCP server | ✓ (E5) |
| D3.2 Custom skills `grade-scenario` / `generate-question` | ? — `.claude/skills/` dir not verified |
| D3.3 Path-specific rules | ✓ — `.claude/rules/prompts.md` and `tools.md` confirmed |
| D4.1 Explicit criteria | ✓ — enforced |
| D4.2 Few-shot from seed questions | ? — seed-as-fewshot wiring unverified in generator prompt |
| D4.3 Tool_use + schemas everywhere | ✓ |
| D4.4 Validation-retry loops | ◐ — schema validation present; explicit retry on validation failure not seen |
| D4.5 Batches API for bulk | ✓ — `lib/study/bulk-gen.ts` |
| D4.6 Multi-instance review | ✓ |

---

## Concrete gaps to address (prioritized)

These are the real, actionable gaps where the code does not match the spec contract or where coverage is thin enough to risk regression.

### High priority (correctness or contract divergence)

1. **Tutor tool surface diverges from spec.** Spec calls for `spawn_practice_question`; code has `exit` instead. Decide which is correct. Either spec wording was aspirational or `exit` is undocumented behavior.
2. **Dedup feature has no unit tests.** `lib/study/dedup.ts` (229 lines), `lib/claude/roles/deduplicator.ts` (122 lines), `app/api/admin/coverage/dedup/route.ts` (62 lines) all merged with no test coverage. The hallucination guard, schema refinement, and `retireDuplicates` count logic are all untested.
3. **AT3 fails on a fresh DB.** Spec requires ≥30 cards exist; current code generates lazily per visit. Either change AT3 to "generate-on-demand" semantics, or add a preseed flow that seeds at least one card per TS during `npm run ingest`.
4. **AT16 Create-level event recording.** The exercise grader writes progress events, but it isn't directly verified that exercise grades persist with `bloom_level=6` (Create). Add an explicit test or read the grade.ts path end-to-end.

### Medium priority (UI surface / observability)

5. **`/study/task/[id]` route purpose unclear.** Frontend agent flagged it as "lightly linked." Verify it's the intended explainer + drill-link landing page (FR2.1) or repurpose it.
6. **Weak-area ranked list: ceiling annotation + one-click drill.** Spec calls for "D1.2 — ceiling: Understand, target: Evaluate" annotation and a "drill this" button. UI implementation not verified.
7. **Mock exam review filter UI.** Spec calls for filterable by domain, by correct/incorrect, AND by Bloom. Filter implementation on `/mock/[id]/review` not verified.

### Low priority (verification only — no code change expected)

8. **AT5 (<10s scenario grading) — benchmark.** Tests verify correctness but not latency.
9. **AT18 dev-time skill `/grade-scenario` exists.** `.claude/skills/grade-scenario.md` and `.claude/skills/generate-question.md` not directly inspected.
10. **NFR3.2 SQLite file permissions.** Code does not chmod the SQLite file on init. Risk is low for local-only v1, but a one-line `fs.chmodSync(dbPath, 0o600)` would close it.
11. **D1.2 Coordinator-subagent pattern** — spec describes a 3-subagent decomposition for question gen (scenario writer, rubric drafter, model-answer drafter). Current implementation is a single generator + sync reviewer. Decide whether to refactor or revise the spec to match what shipped.
12. **D4.2 Few-shot seeding from the 12 seed questions.** Spec promises it; not verified in `prompts/generator.md`.
13. **D4.4 Validation-retry loops.** Schema validation exists; explicit retry-on-validation-failure with the specific error not observed.
14. **FR1.3 idempotent re-ingest.** Tests cover ingest; explicit "re-run is no-op" assertion not seen.

---

## Spec items the code goes BEYOND

Worth noting — these will need to be reflected in the new PVR:

- **`bulkGenJobs` table + Anthropic Batches API** — spec only mentions `D4.5` Batches API for bulk gen; the implementation is more substantial (full job tracking, polling, cost projection)
- **`claudeCallLog`** — full per-call observability table (tokens, cost, role, model, cache stats). Spec doesn't require this; the spend dashboard depends on it
- **Generator self-reported difficulty + per-question Bloom justification** — spec promises it; both are persisted
- **Dark mode setting** — implemented but not in spec
- **`cca-curriculum` MCP server with stdio + 30 task-statement resources** — implementation is more complete than the spec requires (only AT24 calls for tools)

---

## Summary stats

- Spec line items reviewed: **~70** (FR + NFR + AT + RD + E + dogfooding)
- ✓ Complete: **~52**
- ◐ Partial: **~6**
- ⚠ Divergent: **~2**
- ✗ Missing: **0**
- ? Unverified: **~10**

The application is **substantively implemented** against `spec.md`. There are no major missing features. The actionable work is:
- 1 contract divergence (tutor tools)
- 1 missing test suite (dedup)
- 1 acceptance-test mismatch (AT3 / lazy card generation)
- 10-ish minor verifications

Phase 3 — `/define` — should produce a PVR that:
- Reflects what actually shipped (incl. the "beyond spec" items above)
- Resolves the divergences (tutor tools, AT3 semantics, coordinator-subagent intent)
- Trims aspirational dogfooding language to what is actually demonstrated
- Replaces `spec.md` as the canonical workstream definition
