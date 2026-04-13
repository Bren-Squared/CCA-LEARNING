export const EXPECTED_DOMAINS = ["D1", "D2", "D3", "D4", "D5"] as const;

export type DomainId = (typeof EXPECTED_DOMAINS)[number];

export const EXPECTED_TASK_STATEMENT_IDS: ReadonlyArray<string> = [
  "D1.1", "D1.2", "D1.3", "D1.4", "D1.5", "D1.6", "D1.7",
  "D2.1", "D2.2", "D2.3", "D2.4", "D2.5",
  "D3.1", "D3.2", "D3.3", "D3.4", "D3.5", "D3.6",
  "D4.1", "D4.2", "D4.3", "D4.4", "D4.5", "D4.6",
  "D5.1", "D5.2", "D5.3", "D5.4", "D5.5", "D5.6",
];

export const DOMAIN_WEIGHT_BPS: Record<DomainId, number> = {
  D1: 2700,
  D2: 1800,
  D3: 2000,
  D4: 2000,
  D5: 1500,
};

export const EXPECTED_SCENARIO_COUNT = 6;
export const EXPECTED_QUESTION_COUNT = 12;
export const EXPECTED_EXERCISE_COUNT = 4;
