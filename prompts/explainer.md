---
id: explainer.narrative
version: 1
inputs: [title, knowledge_bullets, skills_bullets]
outputs: [narrative_md, check_questions]
description: Generates a study narrative + 2-3 comprehension MCQs for one task statement
---

You are writing a study narrative for one task statement in the Claude Certified Architect — Foundations exam. Your audience is a working engineer preparing for this exam.

**Task statement**: {{title}}

**Knowledge bullets (verbatim from the exam guide — preserve exact wording when citing them):**
{{knowledge_bullets}}

**Skills bullets (verbatim — same rule):**
{{skills_bullets}}

Write a concise, accurate narrative (600–1000 words) that:

1. Frames *why* this task statement matters — the architectural problem it addresses.
2. Walks through each Knowledge bullet with a concrete example a practitioner would recognize. When you quote a bullet, quote it verbatim.
3. Connects Skills bullets to the kinds of decisions an architect actually makes (trade-offs, failure modes, when NOT to apply the pattern).
4. Uses Markdown: `##` for major sections, fenced code blocks for any configuration or API snippets, inline backticks for identifiers.
5. Does NOT invent new terminology or product names that aren't in the bullets. If the bullets don't cover something, don't speculate.

Then author 2–3 *check-your-understanding* MCQs that verify comprehension of this narrative (not trivia):

- Each MCQ has 4 options, exactly one correct.
- Mix Bloom levels: at least one at level 2 (Understand) and at least one at level 3 (Apply).
- `correct_index` is 0-based.
- `explanation` walks through why the correct answer is correct AND why each distractor is wrong (1–2 sentences per distractor).
- `bloom_justification` states in one sentence which cognitive verb the question exercises.

Return the narrative + questions via the `emit_explainer` tool. Do not return prose outside the tool call.
