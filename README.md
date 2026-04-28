# CCA Foundations Learning App

A single-user local study app for the Claude Certified Architect — Foundations certification. Turns the official exam guide into an interactive, Bloom-ladder-aware study environment. See `spec.md` for the full requirements and `tasks/todo.md` for the phase plan.

## Prerequisites

- Node.js ≥ 22 (tested on 22.22.2)
- The official **CCA Foundations Exam Guide** PDF (v0.1, Feb 10 2025). Place it at `data/exam-guide.pdf` — the file is gitignored.
- An Anthropic API key (entered later via the in-app first-run wizard; not required to bootstrap the repo)

## Quick start

```bash
npm install
cp .env.example .env.local      # adjust if you want non-default paths/models
npm run dev                     # localhost:3000
```

## Scripts

| script | what it does |
| --- | --- |
| `npm run dev` | Next.js + Turbopack dev server |
| `npm run build` / `npm start` | production build + serve |
| `npm run lint` | ESLint (flat config) |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run ingest` | parses `data/exam-guide.pdf` into the SQLite curriculum (idempotent) |
| `npm run db:generate` | generate a Drizzle migration from schema changes |
| `npm run db:push` | push schema to the SQLite file (dev shortcut) |
| `npm run db:studio` | open Drizzle Studio to browse the DB |

## Ingestion

`npm run ingest` expects the exam guide PDF at `data/exam-guide.pdf`. It:

1. Hashes the PDF and compares against the last-ingested hash (idempotent per FR1.3).
2. Parses the text with `unpdf` into domains, task statements, scenarios, sample questions, and preparation exercises.
3. Optionally classifies each seed question's Bloom level via a single Claude call if `ANTHROPIC_API_KEY` is in the environment. Without the key, seed questions get a heuristic Bloom level; re-run after the in-app wizard fills the key to refresh classifications.
4. Upserts into SQLite (`data/app.sqlite` by default).
5. Verifies coverage: **5 domains, 30 task statements, 6 scenarios, 12 questions, 4 exercises** (AT1).

Re-running with an unchanged PDF logs `no changes` and exits 0.

## Layout

- `/app` — Next.js routes (App Router)
  - `/study/tutor/[id]` — agentic task-statement tutor (streaming, D2)
  - `/study/exercises` — preparation exercises with RD4 lazy rubrics
  - `/study/flashcards` — spaced-review queue (keyboard-driven)
  - `/drill` — untimed single-topic MCQ drill
  - `/mock/[id]` — full timed mock exam
  - `/admin/coverage` — Bloom × task-statement coverage matrix
  - `/spend` — Claude API spend dashboard (FR5.4 / NFR4.2)
  - `/shortcuts` — in-app keyboard reference (NFR5.2)
  - `/settings` — API key, default model, review intensity, **dark mode** (NFR5.3)
- `/lib/db` — Drizzle schema and client
- `/lib/curriculum` — PDF parser, ingest persistence, Bloom classifier
- `/lib/claude` — Anthropic client, prompts, roles, tool schemas (D2.2 / D2.3)
- `/lib/progress` — mastery math + append-only event writer
- `/lib/tutor` — agentic loop (stop_reason-driven control flow)
- `/lib/exercises` — rubric generator + step grader
- `/lib/spend` — MTD + session-aware spend summaries
- `/lib/settings` — AES-256-GCM key crypto + singleton accessors
- `/scripts/ingest.ts` — one-shot PDF → DB
- `/drizzle` — migration SQL + metadata
- `/prompts` — versioned prompt templates with YAML frontmatter
- `/data` — SQLite file + exam guide PDF (both gitignored)
- `.claude/` — project-scoped Claude Code skills, commands, and path rules (dogfooding Domain 3)

## Spend tracking (FR5.4 / NFR4.2)

Every Claude call is logged to `claude_call_log` with tokens, cost, stop_reason, and duration. `/spend` shows:

- month-to-date cost vs. the configured monthly budget (the bar turns amber at 80% — the NFR4.2 soft warning — and red at 100%);
- current session (a burst of calls with no gap > 30 min);
- breakdowns by role and model;
- a table of the last 20 calls with timings + stop reasons.

The dashboard home page carries a banner when the soft warning is tripped, linking to `/settings` to raise the budget. Estimates are derived from the rate card in `lib/claude/tokens.ts`; they don't replace the Anthropic console invoice.

### Reading the cache panel (E1, NFR4.3)

The `/spend` page also renders a per-role **cache efficiency** panel. Each row shows hit rate (`cache_read / (cache_read + cache_creation)`), total tokens saved, and dollar savings against the model's rate card.

- **Cache-enabled roles** are roles whose `RoleDefinition` declares `cacheSystem: true` (`tutor`, `generator`, `explainer`, `card-writer`, `rubric-drafter`). They should show a hit rate ≥ 50% after the first warm-up call within the cache TTL. An amber "low hit rate" pill appears when an enabled role drops below 50% over ≥ 10 calls — typically a sign that the system prompt is being inadvertently mutated per call.
- **No-cache roles** (`reviewer`, `grader`, `deduplicator`) are listed under a separate subgroup. They never trigger the warning — caching is intentionally disabled because each call carries unique data in the system prompt.

The single source of truth for which roles expect cache hits is `lib/claude/roles/cache-policy.ts`; if you add a new role, register it there.

## MCP server (E5, Phase 18)

A read-only MCP server exposes the curriculum SQLite to Claude Code sessions running in this repo. Two tools (`read_curriculum`, `read_progress`) and one resource template (`cca://task-statement/{id}`).

To register the server with Claude Code, the `.mcp.json` at the repo root is detected automatically when CC starts in this directory. To verify:

```bash
# In the project root, with Claude Code installed:
claude mcp list
# cca-curriculum should appear with status "connected"
```

Sample queries you can run from a Claude Code session in this repo:

- "What are the Knowledge bullets for D1.2?" → resolves via `read_curriculum`.
- "What's my mastery on D3.4?" → resolves via `read_progress`.
- "Show me task statement D2.1" → resolves via the `cca://task-statement/D2.1` resource.

Read-only is enforced by the *absence* of write tools on the server surface — the database connection is shared with the app, and better-sqlite3 doesn't expose a per-query read-only mode through Drizzle. Stray Claude Code sessions cannot mutate user progress because no `write_*` tools are registered.

## Known limitations / approximations

- **Scaled score** (100–1000, 720 pass) is a two-segment linear approximation (RD2). Anthropic doesn't publish the official raw-to-scaled formula; the app shows a banner on mock exam results.
- **Spend estimates are indicative.** The token-to-dollar math uses the rate card baked into `lib/claude/tokens.ts` as of the last deployment. If Anthropic updates pricing, edit that file.
- **Bloom classification for seed questions is heuristic without an API key.** Re-run `npm run ingest` after pasting your key in `/settings` to replace heuristic classifications with real Claude calls.
- `data/exam-guide.pdf` is the single source of truth. Re-ingesting an updated PDF replaces curriculum content but preserves user progress (append-only events).
- Single local user, no auth, no deployment — by design.
