---
description: Dev-time iteration on the question generator (FR3). Forks context to generate a single MCQ for <task-statement-id> at <bloom-level>, runs the independent reviewer pass (D4.6), and prints the final question plus reviewer verdict. Use when tuning generator or reviewer prompts without affecting the main session.
context: fork
argument-hint: <task-statement-id> <bloom-level>
---

<!--
Stub — body filled in Phase 6 (see tasks/todo.md).

Implementation checklist for Phase 6:
1. Load the task statement's Knowledge/Skills bullets (verbatim from the ingested model).
2. Gather same-scenario seed questions as few-shot examples (D4.2).
3. Run the `generator` role with the coordinator-subagent pattern (D1.2).
4. Run the `reviewer` role in a second isolated context (D4.6).
5. Print: { question, reviewer_verdict, retry_count }.

Dogfoods: D3.2, D1.2 (coordinator-subagent), D4.2 (few-shot), D4.3 (tool_use structured output), D4.6 (multi-instance review).
-->
