import type { RoleDefinition } from "./types";

/**
 * Question generator (FR3 / D1.2 / D4.2 / D4.3). A coordinator that will
 * delegate to scenario-writer, distractor-generator, and rubric-drafter
 * subagents in Phase 6 and emit the final question via emit_question
 * (strict JSON schema, only tool offered). Uses the seed questions from
 * the same scenario as few-shot examples.
 */
export const generatorRole: RoleDefinition = {
  name: "generator",
  description:
    "Generates one new MCQ per invocation for a given (task_statement, bloom_level, optional scenario). Must emit via the emit_question tool; string output is rejected.",
  systemPromptText:
    "You generate exam-practice MCQs. (Phase 6 will supply the full coordinator + subagent prompt set.)",
  cacheSystem: true,
  modelTier: "default",
  tools: [],
};
