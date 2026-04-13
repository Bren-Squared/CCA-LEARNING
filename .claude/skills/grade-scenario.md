---
description: Dev-time iteration on the Scenario Free-Response grader (FR2.4). Forks context, runs the grading prompt end-to-end against a stored rubric and candidate answer, prints the structured result, and leaves no residue in the main conversation. Use when tuning rubric wording or verifying AT17 grader-isolation behavior.
allowed-tools: [Read, Edit, Bash]
context: fork
argument-hint: <scenario-id> <candidate-answer-path>
---

<!--
Stub — body filled in Phase 10 (see tasks/todo.md).

Implementation checklist for Phase 10:
1. Load scenario prompt + stored rubric for <scenario-id> from the DB.
2. Read the candidate answer from <candidate-answer-path>.
3. Invoke the `grader` role in an isolated context (matches runtime FR2.4 isolation).
4. Offer only the `record_grade` tool — no tutor or generator tools.
5. Print the returned { score, strengths[], gaps[], model_answer } structure.

Dogfoods: D3.2 (Skill with `context: fork` + `allowed-tools`), AT17 (grader isolation), AT18 (dev-time skill execution).
-->
