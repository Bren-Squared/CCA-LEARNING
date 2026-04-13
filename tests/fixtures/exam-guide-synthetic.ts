import { EXPECTED_TASK_STATEMENT_IDS } from "../../lib/curriculum/expected";

const DOMAIN_HEADERS: Record<string, { title: string; pct: number }> = {
  D1: { title: "Agentic Architecture & Orchestration", pct: 27 },
  D2: { title: "Tool Design & MCP Integration", pct: 18 },
  D3: { title: "Claude Code Configuration & Workflows", pct: 20 },
  D4: { title: "Prompt Engineering & Structured Output", pct: 20 },
  D5: { title: "Context Management & Reliability", pct: 15 },
};

const SCENARIO_TITLES = [
  "Customer Support Resolution Agent",
  "Code Generation with Claude Code",
  "Multi-Agent Research System",
  "Developer Productivity with Claude",
  "Claude Code for Continuous Integration",
  "Structured Data Extraction",
];

const EXERCISE_TITLES = [
  "Build a Multi-Tool Agent with Escalation Logic",
  "Configure Claude Code for Team Workflow",
  "Build a Structured Data Extraction Pipeline",
  "Design and Debug a Multi-Agent Research Pipeline",
];

function tsBlock(id: string): string {
  return [
    `${id} Task statement title for ${id}`,
    "Knowledge of:",
    `• The agentic loop control flow relevant to ${id}`,
    `• Key failure modes associated with ${id}`,
    "Skills in:",
    `• Diagnosing issues attributable to ${id}`,
    `• Designing the control surface for ${id}`,
    "",
  ].join("\n");
}

export function buildSyntheticGuide(): string {
  const parts: string[] = [
    "Claude Certified Architect — Foundations Exam Guide",
    "Version 0.1 — Feb 10 2025",
    "",
  ];

  for (const [id, { title, pct }] of Object.entries(DOMAIN_HEADERS)) {
    parts.push(`Domain ${id.slice(1)}: ${title} (${pct}%)`);
    parts.push(
      "This domain covers the concepts outlined in the task statements below.",
    );
    parts.push("");
    for (const ts of EXPECTED_TASK_STATEMENT_IDS.filter(
      (x) => x.startsWith(`${id}.`),
    )) {
      parts.push(tsBlock(ts));
    }
  }

  parts.push("");
  parts.push("Scenarios");
  parts.push("");
  SCENARIO_TITLES.forEach((title, i) => {
    const domains = [`D${(i % 5) + 1}`];
    parts.push(`Scenario ${i + 1}: ${title}`);
    parts.push(`Description for ${title}.`);
    parts.push(`Primary domains: ${domains.join(", ")}`);
    parts.push("");
  });

  parts.push("Sample Questions");
  parts.push("");
  for (let q = 1; q <= 12; q++) {
    const ts = EXPECTED_TASK_STATEMENT_IDS[q % EXPECTED_TASK_STATEMENT_IDS.length];
    parts.push(`Sample Question ${q}. Example stem for question ${q}.`);
    parts.push("A) First candidate answer");
    parts.push("B) Second candidate answer");
    parts.push("C) Third candidate answer");
    parts.push("D) Fourth candidate answer");
    parts.push("Answer: A");
    parts.push(`Task Statement: ${ts}`);
    parts.push("Explanation follows with justification prose.");
    parts.push("");
  }

  parts.push("Preparation Exercises");
  parts.push("");
  EXERCISE_TITLES.forEach((title, i) => {
    parts.push(`Exercise ${i + 1}: ${title}`);
    parts.push(`Overview paragraph for ${title}.`);
    parts.push(`Domains reinforced: D${(i % 5) + 1}`);
    parts.push("Step 1. Read the scenario and identify the goal.");
    parts.push("Step 2. Produce an artifact satisfying the rubric.");
    parts.push("Step 3. Review the independent critique.");
    parts.push("");
  });

  return parts.join("\n");
}
