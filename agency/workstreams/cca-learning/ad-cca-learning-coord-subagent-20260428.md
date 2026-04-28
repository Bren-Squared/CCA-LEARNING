---
type: ad
workstream: cca-learning
principal: bren-squared
slug: coord-subagent
version: v1
status: complete
date: 2026-04-28
scope: FR3.8 only — coordinator-subagent question generation pipeline refactor
inputs:
  - agency/workstreams/cca-learning/pvr-cca-learning-v1-20260428.md (FR3.8)
  - lib/study/generator.ts (current single-call implementation)
  - lib/claude/roles/generator.ts (emit_question tool schema)
  - lib/claude/roles/reviewer.ts (existing reviewer pass)
  - prompts/generator.md (current coordinator-style prompt, v3)
  - prompts/reviewer.md (existing reviewer prompt)
completeness:
  architecture_overview: complete
  data_model: complete
  interfaces: complete
  dependencies: complete
  technology_choices: complete
  trade_offs: complete
  failure_modes: complete
  security_considerations: complete
  deployment_operations: complete
  open_technical_questions: complete
---

# CCA-Learning — A&D for the Coordinator-Subagent Generator Refactor

> **Scope:** PVR §FR3.8 only. This A&D drives architecture for the question-generation pipeline refactor — refactoring the single-call generator into a coordinator + N subagents + reviewer. Other Group A items (chmod, dedup tests, flashcard preseed, spawn_practice_question) are out of scope for this A&D.

## 1. Architecture Overview

### Pipeline shape

```
loadGeneratorContext
        │
        ▼
   ┌─────────────┐
   │ coordinator │ (orchestration code, not a Claude call)
   └─────┬───────┘
         │
         ├── (1) stem writer        ── Sonnet ──► stem string
         │
         ├── (2) key & distractor designer ── Sonnet ──► 4 options + correct_index + 1-sentence rationales
         │
         ├── (3) explanation writer ── Sonnet ──► 4 polished per-option explanations
         │
         ▼
   ┌─────────────┐
   │ coordinator │ assembles emit_question payload
   │             │ (stem + options + correct_index + explanations + bloom_level + bullet_idxs)
   │             │ runs validateBulletIdxs locally
   └─────┬───────┘
         │
         ▼
     reviewer ── Haiku ── approve | reject(violations[])
         │
         ├── approve ──► persistApprovedQuestion
         └── reject  ──► route violation to relevant subagent → re-run that subagent (NOT full pipeline)
```

The **coordinator is orchestration code, not a Claude call**. It runs in `lib/study/generator.ts` (or a new `lib/study/generator-pipeline.ts`), invokes each subagent sequentially, validates outputs, and synthesizes the final `emit_question` payload. The coordinator's job is *control flow + assembly*, not LLM inference.

### Subagents

1. **Stem writer** (`stem-writer` role)
   - **Model tier:** default (Sonnet)
   - **Inputs:** task statement bullets (verbatim, indexed), target Bloom level + verb, scenario block, retry-feedback block (when re-running on reviewer-routed violation)
   - **Tool:** `emit_stem` — emits one string field (`stem`) plus `bullet_idxs` (knowledge + skills indices the stem touches)
   - **Cache:** system prompt cached (`cacheSystem: true`)
   - **Prompt focus:** scenario framing, Bloom-level cognitive demand calibration, situation specificity, no fabricated APIs/products

2. **Key & distractor designer** (`key-distractor-designer` role)
   - **Model tier:** default (Sonnet)
   - **Inputs:** task statement bullets, the stem from §1, target Bloom level, scenario block, retry-feedback block
   - **Tool:** `emit_options` — emits `options[4]`, `correct_index`, `option_rationales[4]` (one terse sentence per option: why-correct or why-specifically-wrong). NOT user-facing prose.
   - **Cache:** system prompt cached
   - **Prompt focus:** key plausibility (one defensible answer), parallel option structure, distractors that are *plausible AND specifically wrong* with named failure modes

3. **Explanation writer** (`explanation-writer` role)
   - **Model tier:** default (Sonnet) — see §5 / §6 for whether Haiku is acceptable here
   - **Inputs:** stem (§1), options + correct_index + rationales (§2), task statement bullets
   - **Tool:** `emit_explanations` — emits `explanations[4]` (10–600 chars each, user-facing didactic prose)
   - **Cache:** system prompt cached
   - **Prompt focus:** expand the §2 rationales into learner-facing explanations that teach the distinction, reference the same criterion across key + distractors

### Coordinator (orchestration code in TypeScript)

Sequential invocation, data flowing forward:

```typescript
// pseudocode
async function generateOneQuestion(params): Promise<GenerateResult> {
  const ctx = loadGeneratorContext(params, db);
  const log: AttemptLogEntry[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stemOut = await invokeStemWriter(ctx, params.bloomLevel, log, db);
    const optionsOut = await invokeKeyDistractorDesigner(ctx, stemOut, params.bloomLevel, log, db);
    const explanationsOut = await invokeExplanationWriter(ctx, stemOut, optionsOut, db);

    const candidate = assembleQuestion({
      stem: stemOut.stem,
      options: optionsOut.options,
      correct_index: optionsOut.correct_index,
      explanations: explanationsOut.explanations,
      bloom_level: params.bloomLevel,
      bloom_justification: stemOut.bloom_justification ?? optionsOut.bloom_justification,
      difficulty: optionsOut.difficulty ?? estimateDifficulty(...),
      knowledge_bullet_idxs: stemOut.knowledge_bullet_idxs,
      skills_bullet_idxs: stemOut.skills_bullet_idxs,
    });

    const bulletViolation = validateBulletIdxs(candidate, ctx.ts);
    if (bulletViolation) {
      log.push({ attempt, verdict: "reject", subagent: "stem-writer", ... });
      continue; // re-run stem-writer on next attempt
    }

    const review = await callReviewer(ctx.ts, params.bloomLevel, candidate, db);
    if (review.verdict === "approve") {
      const id = persistApprovedQuestion(ctx.ts, ctx.scenario?.id, candidate, db);
      return { questionId: id, attemptsUsed: attempt, ... };
    }

    // reject: route violation to relevant subagent
    log.push({ attempt, verdict: "reject", subagent: routeViolation(review.violations), ... });
  }

  throw new GeneratorError("exhausted", ...);
}
```

The coordinator owns:
- Context injection (each subagent gets exactly what it needs — no shared "god prompt")
- Sequential dependency management (stem feeds options feeds explanations)
- Bullet-citation validation (local, no Claude call)
- Final payload assembly into the existing `emit_question` shape — preserving the unchanged DB schema and persistence path
- Bloom level + difficulty assignment (coordinator picks; subagents may suggest but coordinator decides)
- Routing reviewer violations to the relevant subagent for retry (see §7)

### Reviewer (unchanged)

- **Model tier:** cheap (Haiku)
- **Cache:** none (`cacheSystem: false`)
- Sees the assembled MCQ via the existing `prompts/reviewer.md`. Emits `emit_review` with verdict + violations.
- Fires **once per assembled candidate**, NOT per subagent. (Per-subagent review was rejected during /design — triples cost without proportional gain.)

### Retry strategy (preview — full design in §7)

Reviewer rejection routes the violation to the **most-relevant subagent**, not the whole pipeline. Routing rules:

| Violation kind | Re-run subagent |
|----------------|-----------------|
| Stem fabricates API / product / feature | stem writer |
| Stem doesn't match Bloom level | stem writer |
| Two correct options / no defensible key | key & distractor designer |
| Distractors not parallel / not plausible | key & distractor designer |
| Distractor not "specifically wrong" | key & distractor designer |
| Explanation too short / non-didactic | explanation writer |
| Bullet idxs out of range | stem writer (cited the wrong bullets) |
| Bloom-level mismatch | coordinator decides — may swap level or rerun stem writer |

Each re-run carries the prior subagent outputs as fixed context (e.g., explanation writer rerun receives unchanged stem + options). This avoids cascading the failure across the whole pipeline and keeps retry cost proportional to the actual violation.

Retry budget: same `MAX_GENERATION_ATTEMPTS = 3` as today, counted at the **pipeline level** (3 reviewer rejections → exhausted), not per subagent.

## 2. Data Model

The refactor is mostly a code change. The `questions` table, the `emit_question` tool schema, and the persistence path are **unchanged** — the coordinator assembles the same final payload that `generateOneQuestion` produces today. Only the *production* of that payload changes.

### Schema changes (minimal)

- **`claudeCallLog.correlation_id`** (new column, nullable text) — a UUID generated by the coordinator at the start of `generateOneQuestion`. Every Claude call inside that pipeline run (each subagent + reviewer + any retries) records the same `correlation_id`. Enables `/spend` and ad-hoc queries to show "all calls for one question generation" without a separate `generation_attempts` table.
  - Migration: one Drizzle migration adding the column. NULLable so historical rows continue to work.
  - Index: simple non-unique index on `correlation_id` (the join key for grouping).

### Role registration (no schema change, code change)

Three new roles registered in `lib/claude/roles/`:

| Role file | Role name | `cacheSystem` | Model tier | Tool |
|-----------|-----------|---------------|------------|------|
| `lib/claude/roles/stem-writer.ts` | `stem-writer` | `true` | default | `emit_stem` |
| `lib/claude/roles/key-distractor-designer.ts` | `key-distractor-designer` | `true` | default | `emit_options` |
| `lib/claude/roles/explanation-writer.ts` | `explanation-writer` | `true` | default *(see §5 — Haiku is a candidate)* | `emit_explanations` |

All three appended to `KNOWN_ROLES` in `lib/claude/roles/cache-policy.ts` so they show up on `/spend`'s cache-efficiency panel with their own hit rates.

The existing `generator` role is **deprecated but not removed** — kept for historical `claudeCallLog` rows to render correctly. New code paths do not call it.

### In-memory log (unchanged)

The coordinator keeps an in-memory `AttemptLogEntry[]` per `generateOneQuestion` invocation for retry-feedback construction (same as today). After return, the in-memory log is discarded. Persistence at the per-attempt level is handled by `claudeCallLog` rows linked via `correlation_id`.

### Storage strategy summary

- **Per-question persistence:** unchanged (`questions` table, `emit_question` shape).
- **Per-call observability:** unchanged columns + new `correlation_id` for grouping.
- **Per-attempt orchestration state:** in-memory only.
- **No new tables.** The decision to *not* introduce `generation_attempts` is deliberate — `claudeCallLog + correlation_id` answers 90% of likely questions without the schema cost. If we later need orchestration-decision provenance (e.g., "which violations got routed to which subagent"), revisit then.

## 3. Interfaces

Three boundaries: tool schemas (Claude-facing), TypeScript signatures (coordinator-facing), external caller contract (unchanged).

### A. Tool schemas (Claude-facing)

Each subagent has its own narrow `emit_*` tool. No shared "god tool" — each subagent only sees what it needs to know (D2.3 — tool distribution by role).

**`emit_stem`** (stem writer)
```ts
{
  stem: string                    // 10-1200 chars
  bloom_justification: string     // ≥10 chars — names the cognitive verb the stem exercises
  knowledge_bullet_idxs: number[] // 0-based, in range; at least one of the two
  skills_bullet_idxs: number[]    //   bullet arrays must be non-empty (Zod refine)
}
```

The stem writer owns bullet citations + the Bloom justification because the **stem is what exercises the bullets and the cognitive verb**. Putting these on a different subagent would create cross-subagent coupling.

**`emit_options`** (key & distractor designer)
```ts
{
  options: string[4]           // each ≥1 char, parallel grammatical form
  correct_index: 0..3
  option_rationales: string[4] // 1 sentence per option — internal scratch, NOT user-facing
  difficulty: 1..5             // designer's estimate; coordinator may override
}
```

The `option_rationales` field is the **handoff payload** to the explanation writer — short "why this is right / why this is specifically wrong" notes. The designer thinks in terms of the failure-mode of each distractor, not the polished prose; the explanation writer expands those notes into didactic explanations.

**`emit_explanations`** (explanation writer)
```ts
{
  explanations: string[4] // each 10-600 chars, parallel to options[], user-facing
}
```

The explanation writer's only job is to render `option_rationales` into learner-quality prose. It receives the full assembled context (stem + options + correct_index + rationales + bullets) so it can reference the same criterion across key + distractors.

After all three subagents return, the **coordinator assembles into the unchanged `emit_question` shape** and passes the assembled candidate to the reviewer. The reviewer's `emit_review` schema and prompt are unchanged.

### B. TypeScript signatures (coordinator-facing)

A new file `lib/study/generator-pipeline.ts` owns the orchestration. The existing `lib/study/generator.ts` becomes a deprecation shim during migration (re-exporting `generateOneQuestion` and `GeneratorError` from the new file) so call sites continue to compile while the refactor lands. After the refactor merges with passing tests, the shim is removed in a follow-up commit.

```ts
// lib/study/generator-pipeline.ts (new)

// Top-level orchestration — drop-in replacement for the current generateOneQuestion
export async function generateOneQuestion(params: GenerateParams): Promise<GenerateResult>

// Subagent invokers (one per subagent)
export async function invokeStemWriter(
  ctx: GeneratorContext,
  bloomLevel: BloomLevel,
  retryLog: SubagentRetryEntry[],
  db: Db,
): Promise<EmitStemInput>

export async function invokeKeyDistractorDesigner(
  ctx: GeneratorContext,
  stem: EmitStemInput,
  bloomLevel: BloomLevel,
  retryLog: SubagentRetryEntry[],
  db: Db,
): Promise<EmitOptionsInput>

export async function invokeExplanationWriter(
  ctx: GeneratorContext,
  stem: EmitStemInput,
  options: EmitOptionsInput,
  db: Db,
): Promise<EmitExplanationsInput>

// Pure assembly — no Claude call
export function assembleQuestion(parts: {
  stem: EmitStemInput
  options: EmitOptionsInput
  explanations: EmitExplanationsInput
  bloomLevel: BloomLevel
}): EmitQuestionInput

// Pure violation routing — no Claude call
export function routeViolation(
  violations: EmitReviewInput["violations"],
): "stem-writer" | "key-distractor-designer" | "explanation-writer" | "coordinator"
```

```ts
// lib/study/generator.ts (existing — becomes deprecation shim)

/** @deprecated import from generator-pipeline instead. Removed once all callers migrate. */
export { generateOneQuestion, GeneratorError, callReviewer, persistApprovedQuestion } from "./generator-pipeline"
export type { GenerateParams, GenerateResult, AttemptLogEntry } from "./generator-pipeline"
```

`callReviewer`, `persistApprovedQuestion`, `validateBulletIdxs`, `loadGeneratorContext` move from `generator.ts` to `generator-pipeline.ts` since they're pipeline-internal utilities. They re-export from the shim during migration.

### C. External caller contract (unchanged)

Callers continue to use `generateOneQuestion(params)` and receive `GenerateResult`. No call-site changes:
- `app/api/study/generate-question/route.ts`
- `app/api/admin/coverage/fill/route.ts`
- `lib/study/bulk-gen.ts` (with §D below)

```ts
// unchanged
{
  questionId: string
  attemptsUsed: number      // reviewer-rejection retries at the pipeline level (1..3)
  question: EmitQuestionInput
  reviewerSummary: string
}
```

The pipeline change is opaque to all external consumers. This is the single most important constraint on the refactor — preserving the contract means the existing API routes, UI surfaces, and bulk-gen flow keep working without coordination.

### D. Bulk generation (Batches API)

`lib/study/bulk-gen.ts` uses **strategy (ii) — coordinator inside each batch row**. Each Batches API row submits a *coordinator invocation* that internally runs the 3 subagent calls + reviewer synchronously inside the batch worker (when the batch lands, each row's processor calls `generateOneQuestion` end-to-end).

Trade-offs accepted:
- **Lost subagent discount.** The 3 Sonnet subagent calls inside a batch row run as regular API calls, not Batches API calls. The Batches discount applies only to the outer row's billing, not to nested calls. Cost effect: bulk gen costs roughly the same as sync gen (no discount on the heavy calls).
- **Wall-clock preserved.** The user's bulk-gen experience is unchanged — submit a job, poll, see results in the same time window. No 3× wait.
- **Reviewer placement unchanged.** Reviewer fires once per assembled candidate, same as the sync path.

The Batches discount on **bulk gen specifically** was always partial cost optimization on an admin-only flow. Losing it preserves user experience on a path that's run rarely (not on the user-facing hot path). Accepted.

Implementation: `lib/study/bulk-gen.ts` row processor calls `generateOneQuestion` from `generator-pipeline.ts` exactly as the sync paths do. `bulkGenJobs` table shape is unchanged. Cost projection in `projectBulkCost` updates to reflect the new per-question call count (~4 calls vs current 2) so the user sees an honest pre-submit estimate.

## 4. Dependencies

The refactor introduces **no new external dependencies and no new infrastructure**.

### Direct external dependencies (all already in `package.json`)

| Dependency | Use | New? |
|------------|-----|------|
| `@anthropic-ai/sdk` | Claude API client (subagents + reviewer) | no |
| `zod` | Schema validation for tool inputs | no |
| `drizzle-orm` | DB queries (`loadGeneratorContext`, `persistApprovedQuestion`) | no |
| `better-sqlite3` | SQLite driver | no |

### Internal modules used (already in codebase)

| Module | Role |
|--------|------|
| `lib/claude/client.ts` (`callClaude`) | subagents call this |
| `lib/claude/prompts/loader.ts` (`loadPromptFile`) | loads each subagent's prompt template |
| `lib/claude/roles/types.ts` (`RoleDefinition`) | new role definitions conform |
| `lib/claude/roles/cache-policy.ts` | adds three new role registrations |
| `lib/claude/tools/types.ts` (`ToolDefinition`, `toolError`) | three new tool defs conform |
| `lib/db/index.ts` (`getAppDb`, `Db`) | DB access |
| `lib/db/schema.ts` | adds `correlation_id` column to `claudeCallLog` |
| `lib/curriculum/types.ts` | task statement / scenario types |
| `lib/progress/mastery.ts` (`BloomLevel`) | shared type |
| `lib/settings/index.ts` (`getCheapModel`) | reviewer model selection |

### New internal modules introduced

- `lib/claude/roles/stem-writer.ts` — role definition + `emit_stem` tool schema
- `lib/claude/roles/key-distractor-designer.ts` — role definition + `emit_options` tool schema
- `lib/claude/roles/explanation-writer.ts` — role definition + `emit_explanations` tool schema
- `lib/study/generator-pipeline.ts` — orchestration code; replaces `lib/study/generator.ts` after migration shim is removed
- `prompts/stem-writer.md` — new prompt template, frontmatter id `stem-writer.subagent`
- `prompts/key-distractor-designer.md` — new, id `key-distractor-designer.subagent`
- `prompts/explanation-writer.md` — new, id `explanation-writer.subagent`

Three separate prompt files (one per subagent) — matches the existing role-per-file convention, enables independent per-subagent prompt versioning via `version:` frontmatter.

### No new infrastructure

- No new background workers, queues, or services
- No new network endpoints
- No new MCP servers; `.mcp.json` unchanged
- No new CI requirements
- No new environment variables
- No tracing, circuit-breaker, or retry libraries (in-loop retry + `correlation_id` cover observability needs)

### Anthropic API constraints relevant here

- **Prompt cache TTL: 5 minutes.** Each subagent's system prompt is cached independently. Sequential subagent calls within one `generateOneQuestion` invocation fall well within the TTL — second-and-later invocations get cache hits on subagent prompts. The *first* invocation in any 5-minute window pays cache writes (1.25× input pricing) on all three subagent prompts.
- **Tool-use limits:** standard. One tool registered per subagent, one call per invocation. No batch-size constraints.
- **Rate limits:** standard tier-1/2/3 apply. ~4 calls per question (3 subagents + reviewer) → effective question-per-minute throughput drops by roughly 2× under tight rate limits compared to the current 2-call pipeline. Flagged in §6 (Trade-offs).

## 5. Technology Choices

Specific technical knobs: model tier per subagent, temperature, max tokens, prompt caching, sequencing, error handling.

### A. Model tier per subagent

| Subagent | Tier | Reasoning |
|----------|------|-----------|
| Stem writer | **Sonnet (default)** | Creative authoring + must avoid fabrication. Highest quality bar. |
| Key & distractor designer | **Sonnet (default)** | Correctness-critical: one defensible answer, three plausible-but-specifically-wrong distractors. |
| Explanation writer | **Haiku (cheap)** | Bounded task — expand 4 rationales into 4 didactic paragraphs. No reasoning leap required. Reviewer pass catches if explanations are bad. ~3× cost reduction on this subagent. |
| Reviewer (unchanged) | Haiku (cheap) | Verification, not generation. |

**Net cost vs. current single-call pipeline:** ~1.6× per question (3 subagent calls + 1 reviewer; 2 Sonnet + 2 Haiku) vs. current ~1× (1 Sonnet + 1 Haiku). Acceptable in exchange for proper D1.2 dogfooding (FR3.8 / PVR).

### B. Prompt caching

All three subagents declare `cacheSystem: true`. Each subagent's system prompt is cached independently at `cache_control: ephemeral`. Same caching infrastructure as the current generator — no new code paths.

Each subagent gets its own row on `/spend` and is subject to the same FR6.3 cache hit rate target (amber pill below 50%).

### C. Sequential vs parallel subagent invocation

**Sequential.** stem → options → explanations is a true data dependency: options need the stem to design distractors against; explanations need the options + correct_index. No meaningful parallelism. Implementation is a straightforward `await` chain.

### D. Temperature per subagent

| Subagent | Temperature | Reasoning |
|----------|-------------|-----------|
| Stem writer | 0.5 | Creative — needs variety in scenarios; not too random (must avoid fabrication). |
| Key & distractor designer | 0.3 | Correctness-critical — want consistency on plausible distractors. |
| Explanation writer | 0.2 | Low — task is constrained expansion, not creative. |
| Reviewer (unchanged) | 0 | Deterministic verification. |

Current generator runs at 0.4. Per-subagent values bracket that, biased by each subagent's creativity needs.

### E. Max tokens per subagent

| Subagent | maxTokens | Reasoning |
|----------|-----------|-----------|
| Stem writer | 800 | Stem ≤1200 chars + `bloom_justification` + bullet idx arrays. Headroom for reasoning before tool call. |
| Key & distractor designer | 1000 | 4 options + 4 rationales + correct_index + difficulty. |
| Explanation writer | 1500 | 4 explanations × up to 600 chars = ~600 tokens of polished prose + JSON overhead. |

Current generator runs at 2048. Tighter per-subagent caps catch runaway generations earlier and reduce worst-case cost.

### F. Tool choice

Each subagent uses `toolChoice: { type: "tool", name: "emit_*" }` — forces tool emission, prevents prose-only responses. Same pattern as the current generator.

### G. Error handling per subagent

Three categories, mapped to existing `ToolDefinition` error semantics in `lib/claude/tools/types.ts`:

- **Schema validation failure** (model emits invalid `emit_*` payload). `errorCategory: "validation"`, `isRetryable: true`. The coordinator re-runs the offending subagent with the validation error appended to its retry-feedback block. Counts against the pipeline retry budget.
- **No tool call** (`stop_reason !== "tool_use"`). Same as schema validation failure — `errorCategory: "validation"`, `isRetryable: true`.
- **Anthropic API transient failure** (rate limit, 5xx, network). `errorCategory: "transient"`, `isRetryable: true`. The coordinator retries the same subagent up to 2 times with exponential backoff *before* counting against the pipeline retry budget. Transient retries are silent — they don't increment `attemptsUsed` in the final `GenerateResult`.

This three-category model preserves the existing tool-error contract (D2.2 dogfooding); no new error categories introduced.

## 6. Trade-offs

What was considered and rejected, with reasoning. Single audit point for "why didn't we just X?"

### T1 — Single-call generator vs. coordinator-subagent pipeline

**Considered:** keep the current single-call generator with its existing coordinator-style prompt. It works, it's tested, it's cheap.

**Rejected because:** the PVR commits to D1.2 dogfooding (Domain 1.2 — Coordinator-subagent pattern). The single-call prompt approximates the pattern mentally but doesn't actually fan out. Anyone reviewing the codebase looking for D1.2 would see a single call and conclude checkbox dogfooding. The whole point of the cca-learning project is to *demonstrably build* what the exam tests; a coordinator-style prompt that doesn't fan out fails that bar.

**Cost accepted (principal-confirmed):** ~1.6× per-question cost, ~2× call count, ~2× wall-clock latency, more code surface.

### T2 — Decomposition shape

**Considered:**
- (A) Literal PVR text: scenario-context writer / rubric drafter / model-answer drafter.
- (B) MCQ-fit: stem writer / key & distractor designer / explanation writer.
- (C) Phase-based: scenario framer / key identifier / distractor constructor — promoting the current prompt's mental phases.

**Chose (B).** (A) was scenario-grading-flavored and didn't fit MCQs (no real "rubric" for an MCQ). (C) put too much work on the coordinator (writing explanations, assigning Bloom, deriving bullet citations — by volume, more than any subagent). (B) gives each subagent a clear, testable artifact.

**Cost accepted:** PVR amendment to FR3.8 (logged in PVR Amendments section).

### T3 — Reviewer placement

**Considered:**
- Per-subagent review (3 reviewer calls + 1 final = 4)
- Once on assembled candidate (1)
- Hybrid: lightweight per-subagent sanity check + full review at end

**Chose: once on assembled candidate.** Per-subagent review triples reviewer cost without proportional gain — most violations are visible only on the assembled question (e.g., "two correct options" requires seeing all 4 options against the stem). The hybrid offered no clear path to meaningful per-subagent checks without duplicating reviewer logic.

### T4 — Sequential vs parallel subagent invocation

**Considered:** firing options designer in parallel against a "preliminary stem"; firing explanation writer in parallel against preliminary options.

**Rejected because:** real data dependencies — options need the actual stem; explanations need the actual options + correct_index. "Preliminary" introduces re-iteration if upstream changes meaningfully. **Sequential `await` chain.**

**Cost accepted:** ~3× single-subagent latency. Acceptable because admin and bulk paths are not user-blocking.

### T5 — Persisting orchestration state

**Considered:**
- New `generation_attempts` table capturing every subagent invocation + violation-routing decision
- In-memory log only (current pattern)
- `correlation_id` column on `claudeCallLog`

**Chose: `correlation_id`.** Smallest schema change, sufficient for "show me all calls for one generation." Doesn't capture orchestration decisions (which violation routed where), but those are reproducible from calls + violations + the pure routing function. Revisit if the gap proves real.

### T6 — Bulk gen Batches strategy

**Considered:**
- (i) Per-subagent batches (3 sequential batch jobs per pipeline run)
- (ii) Coordinator-inside-each-row (one batch row per question; sync subagent calls inside each row's worker)
- (iii) Disable Batches for the new pipeline (sync only)

**Chose (ii).** Preserves user wall-clock expectation. (i) tripled wall-clock; (iii) lost the cost discount entirely on the rare bulk path's outer accounting.

**Cost accepted:** subagent and reviewer calls inside each batch row run as regular API calls (no Batches discount). Net: bulk gen cost ≈ sync gen cost on the new pipeline.

### T7 — Explanation writer model tier

**Considered:**
- Sonnet across all 3 subagents (~2× cost)
- Haiku for explanation writer (~1.6× cost)
- Configurable in settings (UI complexity)

**Chose: Haiku for explanation writer.** Bounded task (expand 4 rationales into 4 didactic paragraphs); Haiku handles this within its known capabilities. Reviewer pass catches degradation. Configurable would add settings + UI surface for negligible gain.

**Cost accepted:** ~3× cost reduction on this one subagent.

### T8 — Existing `lib/study/generator.ts` — modify in place vs. new file

**Considered:**
- Modify `generator.ts` in place (smaller diff)
- Create `generator-pipeline.ts`; `generator.ts` becomes a deprecation shim, removed later

**Chose: new file with shim.** Clean separation between old and new, easy to compare during review, single rollback unit. Shim removes the merge risk on call sites mid-refactor.

**Cost accepted:** two commits to land — one to add the pipeline + shim; one to remove the shim after callers verified.

## 7. Failure Modes

The pipeline has more failure surface than the current single-call generator (5 things can fail vs. 2). The existing error model extends cleanly; a few cases need explicit policy.

### F1 — Single subagent transient API failure

**Symptom:** Anthropic API returns 5xx, rate-limit, or network drop mid-call. Affects one subagent.

**Behavior:** the coordinator wraps each subagent invocation in a small retry loop — up to 2 internal retries with exponential backoff (250ms, 500ms) before giving up. **Transient retries are silent** — they do NOT increment `attemptsUsed` or appear in the reviewer-rejection log. After 2 retries the failure surfaces as `GeneratorError("subagent_unavailable", { subagent: "..." })`.

**Caller behavior:** HTTP route returns 503 with the structured error. Bulk-gen marks the row as failed with the transient flag set so it can be retried later.

### F2 — Single subagent emits invalid tool input

**Symptom:** model fires the right tool but the payload fails Zod validation (e.g., `options.length !== 4`, `correct_index === 5`, missing required field).

**Behavior:** coordinator catches the validation error, writes the violation into the subagent's retry-feedback block, re-runs **the same subagent**. **Counts against the pipeline retry budget.** Mirrors the existing `bad_generator_output` path; just scoped to the offending subagent rather than the whole pipeline.

### F3 — Single subagent doesn't emit the tool

**Symptom:** model returns text instead of a `tool_use` block (`stop_reason !== "tool_use"`).

**Behavior:** same as F2. Coordinator surfaces this as a `no_tool_use` violation, re-runs the subagent with explicit instruction to emit via the tool. Counts against pipeline retry budget.

### F4 — Reviewer rejects assembled candidate

**Symptom:** reviewer's `emit_review` verdict is `reject` with one or more violations. Reviewer's actual violation codes (verified against `lib/claude/roles/reviewer.ts:11-19`):

```
wrong_key, ambiguous_stem, implausible_distractor,
weak_explanation, bloom_mismatch, fabricated_content, other
```

**Behavior:** coordinator routes violations to the most-relevant subagent per the table below. The chosen subagent re-runs with the violation injected into its retry-feedback block. Other subagents do NOT re-run on this attempt — their prior outputs are reused.

**Routing table (deterministic, lives in `routeViolation()` — pure function, easy to unit-test):**

| Reviewer violation code | Re-run subagent | Reasoning |
|---|---|---|
| `fabricated_content` | stem writer | Stem invented an API/product not in bullets — fix at the source |
| `bloom_mismatch` | stem writer | Stem doesn't exercise the target Bloom level — recalibrate the stem |
| `ambiguous_stem` | stem writer | Stem admits more than one defensible answer — clarify framing |
| `wrong_key` | key & distractor designer | `correct_index` doesn't identify a single best answer |
| `implausible_distractor` | key & distractor designer | A distractor is nonsensical / out-of-domain — redesign options |
| `weak_explanation` | explanation writer | Explanation doesn't justify the key or name distractor faults |
| `other` | **stem writer (conservative default)** | Unknown category → re-run from upstream so all downstream subagents re-run too |

The `other` policy is conservative — re-running upstream means the entire pipeline runs again from the offending point, which is wasteful but safe. Refining this requires the reviewer to expand its violation taxonomy; flagged in §10 Open Questions.

### F5 — Multiple violations across categories

**Symptom:** reviewer rejects with violations spanning multiple subagents (e.g., `fabricated_content` AND `implausible_distractor`).

**Behavior:** pick the **most-upstream** subagent among the routed candidates and re-run from there. Downstream subagents automatically re-run because their inputs change.

Upstream order: stem writer > key & distractor designer > explanation writer.

This is the conservative policy. Cheaper alternative — re-run only the offending subagents in parallel and re-assemble — was rejected: data dependencies mean re-running options designer alone after a stem rewrite is wasted work.

### F6 — Pipeline retry budget exhausted

**Symptom:** reviewer rejects 3 attempts in a row.

**Behavior:** throw `GeneratorError("exhausted", { log })` carrying the per-attempt log. **Candidate NOT persisted.** Caller sees a structured error with the last reviewer summary. Same external contract as today.

Retry budget stays at `MAX_GENERATION_ATTEMPTS = 3`. Counted at the **pipeline level** (3 reviewer rejections), not per subagent — subagent reruns are part of attempting to produce one passing candidate.

### F7 — Schema migration fails (`correlation_id` add)

**Symptom:** Drizzle migration to add `correlation_id` fails on user's local DB (locked DB, disk full).

**Behavior:** migration framework already handles this — startup fails loudly, app refuses to serve. User sees a clear error in the dev server output. No partial state.

### F8 — Coordinator code bug

**Symptom:** bug in the coordinator's assembly logic produces invalid `emit_question` payload (e.g., wrong `correct_index` transcription, mismatched array lengths).

**Behavior:** the reviewer's existing checks catch most assembly errors (`correct_index` out-of-range, two correct options visible). Edge cases that slip through reach the user as malformed questions; the existing `flagQuestion` UX (FR3.6) lets the user retire a bad question.

**Mitigation:** comprehensive unit tests on `assembleQuestion()` — pure function, easy to test exhaustively. Listed in §10 Open Questions as a test-plan item.

### F9 — Cache invalidation across subagents

**Symptom:** a subagent's prompt is bumped (`version: 2`); cached system prompt under `version: 1` becomes stale.

**Behavior:** `cache_control: ephemeral` keys on the exact system prompt content. Bumping the prompt invalidates the cache automatically — next invocation pays a cache write. Same as today's generator role.

### F10 — Bulk gen batch row mid-failure

**Symptom:** a batch row's coordinator invocation fails (any of F1–F6) inside the batch worker.

**Behavior:** the batch row records the failure in its result entry. `processBulkJob` aggregates: succeeded count + failed count + failed-question metadata. UI on `/admin/coverage` surfaces the failed count with reasons. Other rows continue independently.

## 8. Security Considerations

The refactor is entirely inside the existing trust boundary. It introduces no new attack surface — same Anthropic API client, same DB access, no new endpoints, no new auth. This section is short for that reason.

### S1 — API key handling

**Unchanged.** The Anthropic API key remains server-only, encrypted in `settings.api_key_encrypted`, accessed via `getApiKey()` in `lib/settings/index.ts`. Each subagent invocation goes through the same `callClaude` wrapper that handles key access. The new pipeline does not see, log, or expose the key.

### S2 — Prompt injection via curriculum content

**Surface:** task statement bullets are sourced from the official PDF and stored verbatim. If the PDF were ever replaced with a malicious one, those bullets would be rendered into every subagent's prompt.

**Behavior:** the curriculum is local and ingested by the user from their own copy of the PDF. There is no untrusted upload path. This is a permanent trust assumption documented in PVR §6 C8 ("verbatim curriculum text") — pre-existing, outside this refactor's scope.

### S3 — Data leak through subagent logs

**Surface:** the new `claudeCallLog.correlation_id` allows linking calls within one generation. The existing call log records token counts, model, role, and call-level metadata — but **not** prompt or completion content (`lib/claude/tokens.ts` — content is on-the-wire only).

**Behavior:** the refactor preserves this. `correlation_id` is metadata only, not content. Subagent prompts and completions remain on-the-wire only.

### S4 — Tool input validation

**Surface:** each subagent's `emit_*` tool input is fed through Zod validation before the coordinator uses it. A malformed tool input cannot bypass schema constraints (the validation is on the *consumer* side, not just trusting Anthropic to enforce).

**Behavior:** existing pattern applied uniformly to the three new tools. Schema-level refines guard structural invariants (`correct_index ∈ [0,3]`, at least one bullet array non-empty, etc.).

### S5 — DB writes from subagent output

**Surface:** subagent outputs flow through the coordinator and ultimately reach `persistApprovedQuestion`, which writes to the `questions` table. Drizzle ORM uses parameterized queries throughout; subagent strings are bound parameters, not interpolated SQL.

**Behavior:** unchanged. Same insert path as today.

### S6 — Cache poisoning

**Surface:** the `cache_control: ephemeral` mechanism keys on exact system prompt content. A subagent's cached prompt is reused for any call with the same prompt content.

**Behavior:** system prompts are static (built from prompt templates + task statement bullets), so the cache key is well-defined. No path for an attacker to influence the cache key in this single-user app. Pre-existing assumption.

### S7 — Cost-based DoS

**Surface:** an attacker (or runaway code) could trigger many `generateOneQuestion` calls, racking up Anthropic costs. Pre-existing concern with the single-call generator.

**Behavior:** the refactor multiplies cost per question by ~1.6×, slightly increasing the blast radius if abused. Existing mitigations apply: single-user local app, no public endpoint, monthly budget warning, `bulkCostCeilingUsd` (max $50) caps Batches API spend per job.

**No new mitigation needed** — single-user local app is not internet-facing. If the threat model ever expands, rate-limiting and per-IP token-bucket would go on the API routes, not in this pipeline.

## 9. Deployment & Operations

For a single-user local app, "deployment" mostly means "the user runs `npm run dev`." This section captures operational concerns that survive the refactor — observability, rollout, rollback, and the few user-visible behavior changes.

### O1 — Rollout (two PRs)

Code change with **one schema migration** (`claudeCallLog.correlation_id`). Sequence:

1. **PR #1** — adds `lib/study/generator-pipeline.ts`, three new role files, three new prompt files, schema migration, full test suite. `lib/study/generator.ts` becomes a deprecation shim re-exporting from the new file.
2. Test pass + reviewer pass on PR #1.
3. Merge PR #1. Run migration locally (`npm run db:migrate`).
4. **PR #2** (follow-up, smaller) — removes the deprecation shim from `lib/study/generator.ts`. Updates all import paths to reference `generator-pipeline` directly.
5. Test pass + reviewer pass on PR #2.
6. Merge PR #2.

Two PRs because PR #1 is the high-risk change (new pipeline, new model, ~5 days of work) and PR #2 is mechanical cleanup. Splitting them keeps PR #1 focused and makes rollback simpler if a regression appears.

### O2 — Rollback

The pipeline change is **fully reversible** by `git revert` of PR #1 (or PR #2 if the shim was already removed). The schema migration is forward-only — `correlation_id` column stays, NULLable, no data loss. Reverted code simply ignores the column.

If a bug ships and `generateOneQuestion` is broken, the user-visible failure is `/admin/coverage` fill returning 503 + bulk-gen jobs failing. Rollback is `git revert` + restart. No state corruption — the pipeline either fully succeeds and persists, or throws and persists nothing.

### O3 — Observability changes the user will see

- **`/spend` page gains 3 new role rows:** `stem-writer`, `key-distractor-designer`, `explanation-writer`. Each gets its own cost, token, and cache hit-rate display (per FR6.3).
- **`generator` role row stays** for historical `claudeCallLog` rows; new questions do not add to it. Eventually removable from the role registry when the user wants to declutter `/spend`.
- **`/admin/coverage` cost projection (FR6.5)** for bulk gen updates to reflect the ~1.6× per-question cost: 2 Sonnet (stem + key/distractor) + 1 Haiku (explanation) + 1 Haiku (reviewer) per question.

### O4 — Behavior changes the user will see (besides cost)

- **Per-question latency goes up.** Today: 1 Sonnet round-trip + 1 Haiku round-trip ≈ 5–15 s. New pipeline: 3 sequential subagent round-trips + 1 Haiku reviewer ≈ 15–30 s.
- **`/admin/coverage` fill button feedback** keeps the existing "Generating..." spinner for v1. A per-subagent progress indicator ("stem written → designing options → writing explanations → reviewing") is **deferred** — revisit if the longer wall-clock causes UX complaints.
- **Bulk-gen latency** is unchanged per-question (T6/(ii) keeps all calls inside one batch row's worker). Total bulk-job wall-clock unchanged from the user's perspective.

### O5 — Logging & monitoring

The refactor introduces no new monitoring infrastructure. Existing observability covers it:

- `claudeCallLog` records every call with token counts, cost, role, model, cache-hit metadata.
- `correlation_id` lets ad-hoc queries answer "what did this generation cost in total?"
- `/spend` page renders per-role cost, cache hit rate, budget warnings.
- Errors propagate via the existing structured-error path (NFR2.3 `{isError, errorCategory, isRetryable, message}`).

No alerting / paging changes. Single-user app — the user notices when generation breaks.

### O6 — Testing strategy at deploy time

- **Unit tests:** every new module gets unit tests. `assembleQuestion` (pure function), `routeViolation` (pure function), each subagent's tool schema validation, prompt rendering with mocked Claude responses.
- **Integration tests:** new `tests/generator-pipeline.test.ts` covers the full sequential-subagent flow with a fake Claude client — approve path, reject path with each violation routing, retry-budget exhaustion, transient-failure retry.
- **Contract preservation:** existing `tests/at19-structured-errors.test.ts` and `tests/generator-tool.test.ts` continue to pass — the external `generateOneQuestion` contract is unchanged.
- **No new e2e:** existing high-level tests (`tests/mock-attempts`, etc.) don't touch generator internals; they continue to work via the deprecation shim then directly via `generator-pipeline`.

### O7 — Production-equivalent path

There is no production. Single-user local-only app per PVR §6 C1. Operations consist of:

- `npm run dev` — start the app.
- `npm run db:migrate` — run pending migrations (one-time after PR #1 merges).
- `npm run test` — run the test suite (~290 cases today; expected +30–50 for the new pipeline).
- `/admin/coverage` UI — submit bulk-gen jobs, watch cost projections.
- `/spend` UI — monitor cache hit rates and budget.

## 10. Open Technical Questions

Unresolved items that surfaced during this A&D. Three groups: implementation-time (resolve while building), post-deployment (after first real run), and cleanup (after PR #2).

### Implementation-time

**Q1 — Per-subagent retry-feedback prompt structure.** Each subagent has its own retry-feedback block when re-run after a reviewer rejection routed its way. The format differs per subagent — stem-writer feedback should focus on stem rewrites; key-designer feedback should focus on options. These prompt-template fragments need to be designed when the prompts are written. Not a blocking design question, but a real implementation task.

**Q2 — Comprehensive `assembleQuestion()` test coverage.** Pure function, easy to test exhaustively, but the test plan isn't yet enumerated. Edge cases include short stems, max-length stems, mismatched array lengths, and unusual `correct_index` values. Listed as a test-plan item under §9 / O6.

**Q3 — Per-subagent retry-feedback wording.** Related to Q1 — the actual text injected into the retry prompt when a violation routes to that subagent. Wording should reference the specific reviewer violation code so the model knows exactly what to fix. Resolve at implementation time.

**Q4 — Migration timing for in-flight bulk jobs.** Policy: in-flight bulk-gen jobs (`in_progress` status when PR #1 merges) continue using whatever code path is loaded by their row-processor at runtime. New jobs after merge use the new pipeline. Single-user local app — the user controls restart timing. Document this expectation in PR #1's description.

### Post-deployment

**Q5 — Actual cost vs estimate.** "~1.6× per question" is an estimate based on call count + model pricing. Verify by generating **5 questions** against the new pipeline post-merge, querying `claudeCallLog`, and comparing to the estimate. Update PVR §FR3.8 if reality diverges materially.

**Q6 — Cache hit rate on three new cached roles.** Each subagent's system prompt is cached. Hit rate target ≥50% per FR6.3. Verify after ~10+ generations across the cache TTL window. If a subagent's hit rate is low, debug whether its prompt key is too dynamic (e.g., includes per-request context that should be in the user message instead of the system prompt).

**Q7 — Reviewer violation taxonomy expansion.** F4's `other` code routes conservatively to the stem writer. If `other` ends up routing to stem writer often (visible in `claudeCallLog` after real usage), the reviewer's taxonomy needs more specific codes (e.g., `non_parallel_options`, `weak_distractor`, `inconsistent_explanation`) so routing can be precise. Future enhancement, not blocking the refactor.

### Cleanup (after PR #2)

**Q8 — Remove `generator` role from `cache-policy.ts`.** The role stays in the registry to render historical `claudeCallLog` rows correctly. After enough time has passed (or the user clears the call log), the entry can be removed. Not urgent.

### PVR cross-references

**Q9 — Verifies PVR §9.B.7 (D4.4 validation-retry dogfooding).** The new pipeline has explicit, structured validation-retry per subagent — exactly what D4.4 wants demonstrated. After the refactor lands, §9.B.7's verification can be marked resolved in the PVR.

**Q10 — Closes PVR §FR3.8 / §9.A.2 (D1.2 dogfooding).** Once this refactor merges, the PVR's biggest open implementation commitment closes. PVR's Group A counter drops from 5 to 4.
