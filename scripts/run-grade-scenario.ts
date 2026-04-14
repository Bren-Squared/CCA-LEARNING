#!/usr/bin/env tsx
/**
 * Dev-time driver for the Scenario Free-Response grader (FR2.4 / AT18).
 *
 * Usage: tsx scripts/run-grade-scenario.ts <prompt-id> <answer-path>
 *
 * Invokes `gradeScenarioAttempt` end-to-end against the same isolated
 * Claude context the production route uses. Prints the structured grade
 * as pretty JSON and exits 0 on success, non-zero on any error.
 *
 * Backs the `/grade-scenario` skill (.claude/skills/grade-scenario.md).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gradeScenarioAttempt, ScenarioGradeError } from "../lib/scenarios/grade";

function die(message: string, code = 1): never {
  process.stderr.write(`grade-scenario: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const [promptId, answerPath] = process.argv.slice(2);
  if (!promptId || !answerPath) {
    die("usage: tsx scripts/run-grade-scenario.ts <prompt-id> <answer-path>", 2);
  }

  const absAnswerPath = resolve(process.cwd(), answerPath);
  const answerText = await readFile(absAnswerPath, "utf8").catch((err) => {
    die(`failed to read answer file ${absAnswerPath}: ${(err as Error).message}`);
  });

  const started = Date.now();
  const result = await gradeScenarioAttempt(promptId, answerText, {
    onGraderCall: (call) => {
      process.stderr.write(
        `[AT17] tools=${call.tools.length} (${call.tools
          .map((t) => t.name)
          .join(",")}) tool_choice=${
          call.toolChoice && "name" in call.toolChoice ? call.toolChoice.name : "(auto)"
        } system_prompt_chars=${call.systemPrompt.length}\n`,
      );
    },
  }).catch((err: unknown) => {
    if (err instanceof ScenarioGradeError) {
      die(`grader failed (${err.code}): ${err.message}`);
    }
    die(`grader failed: ${(err as Error).message}`);
  });

  const elapsed = Math.round((Date.now() - started) / 100) / 10;
  process.stderr.write(`[ok] graded in ${elapsed}s\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
