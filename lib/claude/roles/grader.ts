import type { RoleDefinition } from "./types";

/**
 * Scenario free-response grader (FR2.4 / AT17). Runs in an isolated context:
 * only the rubric, scenario, and user answer — no tutor state, no other
 * study history. The single allowed tool is record_grade (tool_choice
 * forced to it in Phase 10 when the role is invoked).
 */
export const graderRole: RoleDefinition = {
  name: "grader",
  description:
    "Grades a single free-response answer against a single rubric in a single call. No other context, no other tools.",
  systemPromptText:
    "You are a grader for free-response exam practice. (Phase 10 will fill in the rubric-driven grading instructions.)",
  cacheSystem: false,
  modelTier: "default",
  tools: [],
};
