---
id: rubric-drafter.exercise
version: 1
inputs: [exercise_title, exercise_description, exercise_domains_reinforced, step_idx, step_total, step_prompt, reinforced_bullets]
outputs: [rubric]
description: Drafts the 3-5 criterion rubric for one preparation-exercise step. Rubric is persisted once per step and reused for every subsequent grading attempt (FR2.7 lazy rubric pattern).
---

You are drafting the grading rubric for ONE step of a hands-on Preparation Exercise in the Claude Certified Architect — Foundations exam. The rubric is generated once per step and reused for every subsequent grading attempt, so it must be specific enough that two independent graders applying it to the same artifact produce the same score.

## Exercise

**{{exercise_title}}**

{{exercise_description}}

Domains reinforced: **{{exercise_domains_reinforced}}**

## Step

Step {{step_idx}} of {{step_total}}.

{{step_prompt}}

## Reinforced knowledge & skills (verbatim — anchor your criteria to these)

{{reinforced_bullets}}

## How to draft the rubric

1. Produce 3–5 criteria. Each one must target something concrete the candidate's artifact must demonstrate — a specific mechanism, policy, interface, or structural property named in the step prompt or backed by the reinforced bullets. Do NOT emit generic criteria like "quality", "clarity", "completeness".
2. This is a Bloom level 6 (Create) task. Criteria should score the artifact as a produced work product — designs, configs, code, prompts — not as a written explanation.
3. Assign each criterion a `weight` between 0.05 and 1.0. Weights MUST sum to exactly 1.0. Heavier weights go on the criteria that most directly exercise the step's core skill.
4. Write `score_anchors` for 0, 3, and 5. The grader interpolates 1, 2, 4.
   - **0**: concrete description of what a fully-absent artifact looks like for this criterion ("No tool definitions", "Does not differentiate tool purposes").
   - **3**: partial / imperfect ("Defines tools but descriptions overlap so the agent could confuse them").
   - **5**: ideal ("Defines 3–4 tools with distinct, bounded descriptions that cite input shape and failure mode for each").
5. Criterion ids are lower_snake_case identifiers the grader will cite when reporting per-criterion scores (e.g. `tool_differentiation`, `error_shape_completeness`).
6. Titles are short and action-oriented ("Differentiates overlapping tools").
7. Descriptions are 1–2 sentences and describe what the grader is looking for, not how to score it. The anchors carry the scoring.

## Hard rules

- Weights MUST sum to 1.0 (validated). Use two-decimal weights.
- Do not emit fewer than 3 or more than 5 criteria.
- Do not cite concepts absent from the step prompt or reinforced bullets. If a concept you want to grade isn't in the inputs, drop it.
- Do not copy bullet text verbatim into anchors — anchors describe artifact quality, not exam-guide text.
- Call `emit_rubric` exactly once. No prose outside the tool call.
