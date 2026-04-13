#!/usr/bin/env tsx
import "../lib/polyfills";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const envFile of [".env.local", ".env"]) {
  const p = resolve(process.cwd(), envFile);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      // ignore malformed env files — surfacing later via the API key check
    }
  }
}
import { extractText, getDocumentProxy } from "unpdf";
import { classifySeedQuestionsBloom } from "../lib/curriculum/bloom-classify";
import {
  countIngested,
  persistCurriculum,
  readIngestHash,
  writeIngestHash,
} from "../lib/curriculum/ingest";
import { parseCurriculumText } from "../lib/curriculum/parser";
import { closeDb, getDb, runMigrations } from "../lib/db";
import {
  EXPECTED_DOMAINS,
  EXPECTED_EXERCISE_COUNT,
  EXPECTED_QUESTION_COUNT,
  EXPECTED_SCENARIO_COUNT,
  EXPECTED_TASK_STATEMENT_IDS,
} from "../lib/curriculum/expected";

const PDF_PATH = resolve(process.cwd(), "data/exam-guide.pdf");

async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const bytes = new Uint8Array(
    pdfBytes.buffer,
    pdfBytes.byteOffset,
    pdfBytes.byteLength,
  );
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

function printSummary(counts: ReturnType<typeof countIngested>): void {
  console.log(
    `   ${counts.domains} domains, ${counts.taskStatements} task statements, ${counts.scenarios} scenarios, ${counts.questions} questions, ${counts.exercises} exercises`,
  );
}

function assertCoverage(counts: ReturnType<typeof countIngested>): void {
  const problems: string[] = [];
  if (counts.domains !== EXPECTED_DOMAINS.length)
    problems.push(
      `expected ${EXPECTED_DOMAINS.length} domains, got ${counts.domains}`,
    );
  if (counts.taskStatements !== EXPECTED_TASK_STATEMENT_IDS.length)
    problems.push(
      `expected ${EXPECTED_TASK_STATEMENT_IDS.length} task statements, got ${counts.taskStatements}`,
    );
  if (counts.scenarios !== EXPECTED_SCENARIO_COUNT)
    problems.push(
      `expected ${EXPECTED_SCENARIO_COUNT} scenarios, got ${counts.scenarios}`,
    );
  if (counts.questions !== EXPECTED_QUESTION_COUNT)
    problems.push(
      `expected ${EXPECTED_QUESTION_COUNT} seed questions, got ${counts.questions}`,
    );
  if (counts.exercises !== EXPECTED_EXERCISE_COUNT)
    problems.push(
      `expected ${EXPECTED_EXERCISE_COUNT} preparation exercises, got ${counts.exercises}`,
    );
  if (problems.length) {
    throw new Error(
      `coverage mismatch (AT1 not satisfied):\n  - ${problems.join("\n  - ")}`,
    );
  }
}

async function main(): Promise<number> {
  if (!existsSync(PDF_PATH)) {
    console.error("exam guide PDF not found.");
    console.error(`   expected at: ${PDF_PATH}`);
    console.error(
      "   obtain the official CCA Foundations Exam Guide (v0.1, Feb 10 2025)",
    );
    console.error("   and place it at data/exam-guide.pdf (gitignored).");
    return 1;
  }

  const pdfBytes = await readFile(PDF_PATH);
  const hash = createHash("sha256").update(pdfBytes).digest("hex");
  const db = getDb();
  runMigrations(db);

  const force = process.argv.includes("--force");
  const priorHash = readIngestHash(db);
  if (priorHash === hash && !force) {
    console.log("no changes — PDF hash matches prior ingest");
    console.log(`   sha256: ${hash.slice(0, 16)}…`);
    console.log("   (pass --force to re-parse and re-classify anyway)");
    printSummary(countIngested(db));
    return 0;
  }

  console.log("parsing PDF…");
  const text = await extractPdfText(pdfBytes);
  const curriculum = parseCurriculumText(text);
  console.log(
    `   parsed ${curriculum.domains.length} domains, ${curriculum.taskStatements.length} task statements, ${curriculum.scenarios.length} scenarios, ${curriculum.questions.length} questions, ${curriculum.exercises.length} exercises`,
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    console.log("classifying seed question Bloom levels via Claude…");
  } else {
    console.log(
      "no ANTHROPIC_API_KEY in env — seed questions get heuristic Bloom levels (re-run after first-run wizard fills the key)",
    );
  }
  const bloom = await classifySeedQuestionsBloom(curriculum.questions, {
    apiKey,
  });

  console.log("upserting curriculum…");
  persistCurriculum(db, curriculum, bloom);
  writeIngestHash(db, hash, new Date());

  const counts = countIngested(db);
  console.log("ingestion complete");
  printSummary(counts);
  assertCoverage(counts);
  return 0;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error("ingest failed:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    closeDb();
    process.exit(1);
  });
