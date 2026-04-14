---
description: Dev-time iteration on the Scenario Free-Response grader (FR2.4). Forks context, runs the grading prompt end-to-end against a stored rubric and candidate answer, prints the structured result, and leaves no residue in the main conversation. Use when tuning rubric wording or verifying AT17 grader-isolation behavior.
allowed-tools: [Read, Edit, Bash]
context: fork
argument-hint: <prompt-id> <candidate-answer-path>
---

Run the Scenario Free-Response grader against a stored prompt + rubric and a candidate answer, and print the structured verdict.

Arguments

1. `<prompt-id>` — UUID of a row in `scenario_prompts`. Grab one from the
   `/study/scenarios` index page or from `curl -s http://localhost:3000/api/scenario/prompts`.
2. `<candidate-answer-path>` — relative or absolute path to a text file
   containing the free-response answer to grade.

Procedure

1. Sanity-check both arguments are present and the answer file is readable.
   If either is missing, stop and report the expected call shape.
2. Show the first ~300 characters of the answer file with `Read` so the
   dev can confirm they picked the right file.
3. Run the grader via the prepared driver script:
   ```bash
   npx tsx scripts/run-grade-scenario.ts <prompt-id> <candidate-answer-path>
   ```
   The script invokes `gradeScenarioAttempt` — the exact same code path the
   `/api/scenario/grade` route uses in production. It:
   - loads the prompt + target task statement from the DB,
   - generates the rubric on first call and caches it (RD4),
   - calls Claude with a system prompt containing ONLY the scenario, prompt
     stem, target task statement, rubric, and candidate answer — no tutor
     transcript, no progress snapshots, no other study state (AT17),
   - offers exactly one tool (`record_grade`) with `tool_choice` forced to
     it, so the API call has a single legal exit,
   - persists the attempt + a `scenario_grade` progress event, and
   - emits the full `ScenarioGradeResult` as pretty JSON on stdout.
   The `[AT17]` diagnostic line on stderr confirms the call was isolated:
   it reports `tools=1 (record_grade) tool_choice=record_grade`.
4. Present the result: `overallScore` (pass threshold is 3.0), pass/fail,
   per-criterion reasoning, strengths, gaps, and the model answer. If the
   score is surprising, diff the criterion reasoning against the rubric
   anchors — that is usually where a wording tune-up belongs.

Failure modes

- `not_found` — prompt id does not exist. Re-list prompts and retry.
- `answer_too_short` / `answer_too_long` — candidate answer falls outside
  20–20,000 chars. Fix the file and retry.
- `bad_tool_output` / `no_tool_use` — Claude returned a malformed or
  missing `record_grade` call. Inspect the stderr for the exact Zod path
  that failed; usually a cap (`model_answer` max, `reasoning` min) needs
  loosening in `lib/claude/roles/grader.ts` or the rubric drafter needs
  a nudge.
- Missing `ANTHROPIC_API_KEY` — the grader short-circuits before calling
  Claude. Set the key in `.env.local` and retry.

Dogfoods D3.2 (Skill with `context: fork` + narrowed `allowed-tools`),
AT17 (grader isolation), AT18 (dev-time skill execution).
