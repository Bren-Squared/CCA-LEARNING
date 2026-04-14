#!/usr/bin/env tsx
/**
 * Seed the scenario free-response prompt catalog: 2 prompts per scenario
 * (S1-S6), 12 total. Each prompt is bound to a specific task statement id
 * and Bloom level so the rubric-drafter (called lazily on first grading)
 * can anchor its criteria to that statement's Knowledge/Skills bullets.
 *
 * Rubrics are NOT authored here — they're generated the first time a user
 * submits an answer (see lib/scenarios/prompts.ts `getOrGenerateRubric`).
 * This means seeding is fast, offline, and free.
 *
 * Idempotent via `upsertScenarioPromptByOrder` — re-running refines text
 * without duplicating rows. If the prompt text itself changes, the rubric
 * is invalidated (it was drafted against the old stem).
 *
 * Usage:
 *   npm run seed:scenarios
 */
import { isNull } from "drizzle-orm";
import { getAppDb, schema } from "../lib/db";
import { upsertScenarioPromptByOrder } from "../lib/scenarios/prompts";

interface SeedPrompt {
  scenarioId: string;
  orderIndex: number;
  taskStatementId: string;
  bloomLevel: number;
  promptText: string;
}

const PROMPTS: SeedPrompt[] = [
  // S1 — Customer Support Resolution Agent (primary domains D1, D2, D5)
  {
    scenarioId: "S1",
    orderIndex: 0,
    taskStatementId: "D5.2",
    bloomLevel: 4,
    promptText:
      "The support agent has just proposed issuing a refund, but the customer's account shows an open billing dispute from last month and the order in question is flagged as possibly fraudulent. Design the escalation policy that decides whether the agent completes the refund itself, asks a clarifying question, or calls `escalate_to_human`. Your answer should name (a) the distinct triggers that move the decision to each branch, (b) the information the agent hands to the human on escalation, and (c) how the policy avoids over-escalating low-ambiguity cases.",
  },
  {
    scenarioId: "S1",
    orderIndex: 1,
    taskStatementId: "D1.4",
    bloomLevel: 4,
    promptText:
      "The support agent has called `lookup_order` and `get_customer` and is about to call `process_refund`. Between the lookup and the refund, a downstream system emits a webhook flagging the order as disputed. Design the multi-step workflow that ensures the agent re-reads the order state before the refund tool runs, and show how you would enforce that handoff using Agent SDK mechanisms. Describe what the agent does if the re-read contradicts the prior tool results, and why your design still converges rather than looping forever.",
  },

  // S2 — Code Generation with Claude Code (primary domains D3, D5)
  {
    scenarioId: "S2",
    orderIndex: 0,
    taskStatementId: "D3.4",
    bloomLevel: 4,
    promptText:
      "Your team uses Claude Code for refactors, bug fixes, and one-line config tweaks. A junior engineer is asking when they should switch to plan mode versus just letting Claude run directly. Give them a decision rule grounded in the actual properties of plan mode — what it costs, what it buys, and the signals in the task itself that tip the balance. Include at least one example where plan mode is the right call and one where it is waste.",
  },
  {
    scenarioId: "S2",
    orderIndex: 1,
    taskStatementId: "D3.1",
    bloomLevel: 4,
    promptText:
      "Your monorepo has a root `CLAUDE.md`, two framework conventions (Next.js app, Go API), and a legacy service that doesn't follow either convention. Design the CLAUDE.md hierarchy — which rules live at which level, how you keep the root small enough to stay useful, and how the legacy service's quirks are scoped so they don't contaminate the rest of the repo. Justify where you'd use path-specific rules instead of nested CLAUDE.md files.",
  },

  // S3 — Multi-Agent Research System (primary domains D1, D2, D5)
  {
    scenarioId: "S3",
    orderIndex: 0,
    taskStatementId: "D1.2",
    bloomLevel: 5,
    promptText:
      "Design the coordinator-subagent architecture for the research system. Specify (a) what context each subagent receives and what it MUST NOT receive, (b) how the coordinator decides which subagent to spawn for a given sub-question, and (c) how results flow back so the coordinator can cite them. Explain why distributing the work this way beats a single large agent that does everything in one loop.",
  },
  {
    scenarioId: "S3",
    orderIndex: 1,
    taskStatementId: "D5.6",
    bloomLevel: 4,
    promptText:
      "The report synthesizer receives findings from three subagents that sometimes contradict each other — one says a drug trial reported a 12% improvement, another says 8%, a third says 'no significant effect.' Design the provenance and uncertainty-handling scheme the synthesizer uses. Your answer should name the metadata the coordinator must attach to every subagent finding, how the synthesizer marks contradictions in the final report, and how it distinguishes 'two sources agree' from 'one source repeated twice.'",
  },

  // S4 — Developer Productivity with Claude (primary domains D1, D2, D3)
  {
    scenarioId: "S4",
    orderIndex: 0,
    taskStatementId: "D2.3",
    bloomLevel: 4,
    promptText:
      "The productivity agent has three roles in its architecture: an explorer that maps unfamiliar code, a boilerplate-generator that writes files, and a reviewer that grades the output. Decide which built-in tools and MCP tools each role should see. Justify each choice in terms of blast radius and least privilege, and explain why giving all three roles the same 'god-bag' of tools is the wrong default.",
  },
  {
    scenarioId: "S4",
    orderIndex: 1,
    taskStatementId: "D2.5",
    bloomLevel: 3,
    promptText:
      "A new engineer is about to answer the question 'what files implement our rate-limiting logic?' by running `cat` over every file under `src/`. Teach them which built-in tool is the right one for this task — and for the follow-up task of then understanding what that code does. Name the tools you'd use in order and explain what each one is good at that the others are not.",
  },

  // S5 — Claude Code for CI/CD (primary domains D3, D4)
  {
    scenarioId: "S5",
    orderIndex: 0,
    taskStatementId: "D3.6",
    bloomLevel: 4,
    promptText:
      "Design the CI job that runs Claude Code on every pull request. Cover (a) what files the job sees, (b) how its comments reach the PR author, (c) how you keep the CI cost predictable when a PR touches thousands of files, and (d) how the job degrades gracefully if the Claude API is down. Explain at least one tradeoff you made and what you'd change if false-positive complaints were the top developer pain point.",
  },
  {
    scenarioId: "S5",
    orderIndex: 1,
    taskStatementId: "D4.1",
    bloomLevel: 4,
    promptText:
      "The current automated-review prompt flags too many cosmetic issues and not enough real bugs. Rewrite the core instructions using explicit criteria so the reviewer stays quiet on low-signal items and speaks up on high-signal ones. Show the specific language that distinguishes 'flag this' from 'do not flag this' for at least three different issue classes, and explain why hedging language like 'be conservative' makes the precision problem worse, not better.",
  },

  // S6 — Structured Data Extraction (primary domains D4, D5)
  {
    scenarioId: "S6",
    orderIndex: 0,
    taskStatementId: "D4.3",
    bloomLevel: 4,
    promptText:
      "The extractor pulls invoices out of PDF scans into a typed record (vendor, total, line items, due date). Design the tool-use interface you expose to Claude so the output is structured JSON the downstream system can trust. Specify the JSON schema's must-haves, how you handle optional fields (a scan may miss the due date), and why tool-use enforcement outperforms 'ask the model to return JSON in the text response.'",
  },
  {
    scenarioId: "S6",
    orderIndex: 1,
    taskStatementId: "D4.4",
    bloomLevel: 5,
    promptText:
      "An extraction for a noisy PDF returns a schema-valid JSON object where the `total` is $8.00 and the sum of line items is $812.33 — clearly one of them dropped a decimal. Schema validation passed, but the data is wrong. Design the validation + retry loop that catches this kind of semantic-but-not-structural failure. Describe the checks you add, how you feed the failure back to the next attempt so it converges, and how you bound the retry budget to keep runaway loops from burning through tokens.",
  },
];

async function main(): Promise<void> {
  const db = getAppDb();

  const scenarios = db
    .select({ id: schema.scenarios.id })
    .from(schema.scenarios)
    .all();
  const scenarioIds = new Set(scenarios.map((s) => s.id));
  if (scenarioIds.size === 0) {
    console.error(
      "No scenarios found. Run `npm run ingest` first to populate the curriculum.",
    );
    process.exit(1);
  }

  const missing = PROMPTS.filter((p) => !scenarioIds.has(p.scenarioId));
  if (missing.length > 0) {
    console.error(
      `Seed refers to unknown scenario ids: ${[...new Set(missing.map((m) => m.scenarioId))].join(", ")}`,
    );
    process.exit(1);
  }

  const tsIds = new Set(
    db.select({ id: schema.taskStatements.id }).from(schema.taskStatements).all()
      .map((r) => r.id),
  );
  const missingTs = PROMPTS.filter((p) => !tsIds.has(p.taskStatementId));
  if (missingTs.length > 0) {
    console.error(
      `Seed refers to unknown task statement ids: ${[...new Set(missingTs.map((m) => m.taskStatementId))].join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Seeding ${PROMPTS.length} scenario prompts…`);
  let created = 0;
  let updated = 0;
  for (const p of PROMPTS) {
    const { created: wasCreated } = upsertScenarioPromptByOrder(p, db);
    if (wasCreated) created++;
    else updated++;
    console.log(
      `  ${p.scenarioId} #${p.orderIndex + 1}  ${p.taskStatementId} (B${p.bloomLevel})  ${wasCreated ? "created" : "updated"}`,
    );
  }

  const byScenario = new Map<string, number>();
  for (const p of PROMPTS) {
    byScenario.set(p.scenarioId, (byScenario.get(p.scenarioId) ?? 0) + 1);
  }
  const uneven = [...byScenario.entries()].filter(([, n]) => n !== 2);
  if (uneven.length > 0) {
    console.warn(
      `warning: expected exactly 2 prompts per scenario, got mismatches: ${uneven
        .map(([id, n]) => `${id}=${n}`)
        .join(", ")}`,
    );
  }

  // Report rubric-generation backlog — the user can warm the cache by
  // hitting each prompt's grading page, or leave it cold and let the first
  // real attempt author the rubric.
  const withoutRubric = db
    .select({ id: schema.scenarioPrompts.id })
    .from(schema.scenarioPrompts)
    .where(isNull(schema.scenarioPrompts.rubric))
    .all();
  console.log(
    `\ncreated ${created} / updated ${updated}. Prompts without a rubric yet: ${withoutRubric.length} (generated lazily on first grading).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
