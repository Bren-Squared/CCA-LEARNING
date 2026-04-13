import type { RoleDefinition } from "./types";

/**
 * Independent review pass (FR3.5 / D4.6 / AT12). Runs in a fresh context
 * with no generator state — sees only the candidate question and returns
 * pass/fail + structured feedback via emit_review. Uses the cheap model.
 */
export const reviewerRole: RoleDefinition = {
  name: "reviewer",
  description:
    "Reviews a single candidate MCQ for correctness, unambiguous single answer, plausible distractors, and Bloom-level accuracy. Emits pass/fail via emit_review.",
  systemPromptText:
    "You are an independent reviewer of exam-practice MCQs. (Phase 6 will supply the full review rubric.)",
  cacheSystem: false,
  modelTier: "cheap",
  tools: [],
};
