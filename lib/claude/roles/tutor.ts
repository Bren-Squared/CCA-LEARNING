import type { RoleDefinition } from "./types";

/**
 * Socratic tutor (FR2.5 / D1.1). Runs a full agentic loop: stop_reason →
 * execute tool_use → append tool_result → continue until end_turn. See
 * Phase 9 in tasks/todo.md for the loop implementation. Tool handlers are
 * stubbed here so the role contract compiles; they're wired up in Phase 9.
 */
export const tutorRole: RoleDefinition = {
  name: "tutor",
  description:
    "Asks Socratic questions grounded in a single task statement's Knowledge/Skills bullets. Calls record_mastery when the user demonstrates understanding at a specific Bloom level; calls spawn_practice_question to probe the next level up; calls lookup_bullets to cite the exam-guide text verbatim.",
  systemPromptText:
    "You are a Socratic tutor for the Claude Certified Architect — Foundations exam. (Phase 9 will replace this with the full system prompt.)",
  cacheSystem: true,
  modelTier: "default",
  tools: [],
};
