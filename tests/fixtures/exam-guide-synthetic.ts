import { EXPECTED_TASK_STATEMENT_IDS } from "../../lib/curriculum/expected";

const DOMAIN_TITLES: Record<string, { title: string; pct: number }> = {
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

function tsSegment(id: string): string {
  return (
    `Task Statement ${id.slice(1)}: Example title for ${id} ` +
    `Knowledge of: - The agentic loop control flow relevant to ${id} - Key failure modes associated with ${id} - A third knowledge bullet for ${id} ` +
    `Skills in: - Diagnosing issues attributable to ${id} - Designing the control surface for ${id} - Articulating tradeoffs for ${id}`
  );
}

export function buildSyntheticGuide(): string {
  const parts: string[] = [
    "Claude Certified Architect – Foundations Certification Exam Guide",
    "The exam has the following content domains and weightings:",
  ];

  for (const [id, { title, pct }] of Object.entries(DOMAIN_TITLES)) {
    parts.push(`- Domain ${id.slice(1)}: ${title} (${pct}% of scored content)`);
  }

  parts.push("Exam Scenarios");
  SCENARIO_TITLES.forEach((title, i) => {
    const picks = [DOMAIN_TITLES[`D${(i % 5) + 1}`].title];
    parts.push(
      `Scenario ${i + 1}: ${title}. Description paragraph for ${title}. Primary domains: ${picks.join(", ")}`,
    );
  });

  for (const ts of EXPECTED_TASK_STATEMENT_IDS) {
    parts.push(tsSegment(ts));
  }

  parts.push("Sample Questions");
  parts.push(
    "The following sample questions illustrate the format and difficulty level of the exam.",
  );
  for (let q = 1; q <= 12; q++) {
    const scenarioTitle = SCENARIO_TITLES[(q - 1) % SCENARIO_TITLES.length];
    if ((q - 1) % 2 === 0) parts.push(`Scenario: ${scenarioTitle}`);
    parts.push(
      `Question ${q}: Example stem for question ${q}. A) First candidate. B) Second candidate. C) Third candidate. D) Fourth candidate. Correct Answer: A Explanation for question ${q} with reasoning.`,
    );
  }

  parts.push("Preparation Exercises");
  EXERCISE_TITLES.forEach((title, i) => {
    const reinforced = DOMAIN_TITLES[`D${(i % 5) + 1}`].title;
    parts.push(
      `Exercise ${i + 1}: ${title} Objective: Practice the core behavior for ${title}. Steps: 1. Read the scenario and identify the goal. 2. Produce an artifact satisfying the rubric. 3. Review the independent critique. Domains reinforced: ${reinforced}`,
    );
  });

  return parts.join(" ");
}
