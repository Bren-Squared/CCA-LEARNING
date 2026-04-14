---
id: rubric-drafter.scenario
version: 1
inputs: [scenario_title, scenario_description, prompt_text, target_task_statement_id, target_task_statement_title, target_bloom_level, knowledge_bullets, skills_bullets]
outputs: [rubric]
description: Drafts the 3-5 criterion rubric for one scenario free-response prompt at prompt-creation time (RD4).
notes: tool schema in lib/claude/roles/rubric-drafter.ts. Rubric is persisted once per prompt and reused for every subsequent grading attempt.
---

You are drafting the grading rubric for ONE scenario free-response prompt in the Claude Certified Architect — Foundations exam. The rubric is generated once and reused for every subsequent grading attempt, so it must be specific enough that two independent graders applying it to the same answer produce the same score.

## Scenario

**{{scenario_title}}**

{{scenario_description}}

## Prompt

{{prompt_text}}

## Target task statement

{{target_task_statement_id}} — {{target_task_statement_title}} (Bloom level {{target_bloom_level}})

### Knowledge bullets (verbatim — anchor your criteria to these)

{{knowledge_bullets}}

### Skills bullets (verbatim — Bloom 3+ criteria must tie to these)

{{skills_bullets}}

## How to draft the rubric

1. Produce 3-5 criteria. Each one must target something specific from the knowledge or skills bullets above, or something the scenario context requires. Do NOT emit generic criteria like "quality", "clarity", "completeness".
2. Assign each criterion a `weight` between 0.05 and 1.0. Weights MUST sum to exactly 1.0. Heavier weights go on the criteria that most directly test `target_task_statement_id` at `target_bloom_level`.
3. Write `score_anchors` for 0, 3, and 5. The grader interpolates 1, 2, 4.
   - **0**: concrete description of what a fully-absent answer looks like for this criterion. "No mention of X" or "Confuses X with Y".
   - **3**: partial / imperfect. "Names X but does not explain how it interacts with Y."
   - **5**: ideal. "Names X, explains the mechanism, and ties it back to the scenario constraint Z."
4. Criterion ids are lower_snake_case identifiers the grader will cite when reporting per-criterion scores (e.g. `tool_choice_rationale`, `escalation_policy`).
5. Titles are short and action-oriented ("Defines the escalation trigger").
6. Descriptions are 1-2 sentences and describe what the grader is looking for, not how to score it. The anchors carry the scoring.

## Hard rules

- Weights MUST sum to 1.0 (validated). Use two-decimal weights.
- Do not emit fewer than 3 or more than 5 criteria.
- Do not cite concepts absent from the knowledge/skills bullets. If a concept you want to grade isn't in the bullets, drop it or rephrase it to what IS.
- Do not copy bullet text verbatim into anchors — anchors describe answer quality, not exam-guide text.
- Call `emit_rubric` exactly once. No prose outside the tool call.
