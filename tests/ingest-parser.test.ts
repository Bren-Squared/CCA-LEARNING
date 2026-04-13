import { describe, expect, it } from "vitest";
import {
  EXPECTED_EXERCISE_COUNT,
  EXPECTED_QUESTION_COUNT,
  EXPECTED_SCENARIO_COUNT,
  EXPECTED_TASK_STATEMENT_IDS,
} from "../lib/curriculum/expected";
import { parseCurriculumText } from "../lib/curriculum/parser";
import { buildSyntheticGuide } from "./fixtures/exam-guide-synthetic";

describe("parseCurriculumText", () => {
  const text = buildSyntheticGuide();
  const curriculum = parseCurriculumText(text);

  it("extracts all 30 task statement IDs (D1.1 through D5.6)", () => {
    const ids = curriculum.taskStatements.map((t) => t.id).sort();
    const expected = [...EXPECTED_TASK_STATEMENT_IDS].sort();
    expect(ids).toEqual(expected);
  });

  it("assigns every task statement to the correct domain", () => {
    for (const ts of curriculum.taskStatements) {
      expect(ts.domainId).toBe(ts.id.slice(0, 2));
    }
  });

  it("preserves Knowledge and Skills bullets verbatim (per DO-NOT #6)", () => {
    for (const ts of curriculum.taskStatements) {
      expect(ts.knowledgeBullets.length).toBeGreaterThan(0);
      expect(ts.skillsBullets.length).toBeGreaterThan(0);
      for (const bullet of [...ts.knowledgeBullets, ...ts.skillsBullets]) {
        expect(bullet).not.toMatch(/^[•●▪∙·\-\u2022]/);
        expect(bullet.length).toBeGreaterThan(5);
      }
    }
  });

  it("extracts 5 domains with weights summing to 10000 bps", () => {
    expect(curriculum.domains.length).toBe(5);
    const sum = curriculum.domains.reduce((a, d) => a + d.weightBps, 0);
    expect(sum).toBe(10000);
  });

  it(`extracts ${EXPECTED_SCENARIO_COUNT} scenarios`, () => {
    expect(curriculum.scenarios.length).toBe(EXPECTED_SCENARIO_COUNT);
  });

  it(`extracts ${EXPECTED_QUESTION_COUNT} seed questions with valid 4-option shape`, () => {
    expect(curriculum.questions.length).toBe(EXPECTED_QUESTION_COUNT);
    for (const q of curriculum.questions) {
      expect(q.options.length).toBe(4);
      expect(q.correctIndex).toBeGreaterThanOrEqual(0);
      expect(q.correctIndex).toBeLessThan(4);
      expect(EXPECTED_TASK_STATEMENT_IDS).toContain(q.taskStatementId);
    }
  });

  it(`extracts ${EXPECTED_EXERCISE_COUNT} preparation exercises with at least one step each`, () => {
    expect(curriculum.exercises.length).toBe(EXPECTED_EXERCISE_COUNT);
    for (const e of curriculum.exercises) {
      expect(e.steps.length).toBeGreaterThan(0);
      expect(e.domainsReinforced.length).toBeGreaterThan(0);
    }
  });
});
