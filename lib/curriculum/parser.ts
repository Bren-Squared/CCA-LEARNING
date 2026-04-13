import {
  DOMAIN_WEIGHT_BPS,
  EXPECTED_DOMAINS,
  EXPECTED_TASK_STATEMENT_IDS,
  type DomainId,
} from "./expected";
import {
  ParsedCurriculum,
  type ParsedDomain,
  type ParsedExercise,
  type ParsedQuestion,
  type ParsedScenario,
  type ParsedTaskStatement,
} from "./types";

export class ParseError extends Error {
  constructor(
    message: string,
    readonly section?: string,
  ) {
    super(section ? `[${section}] ${message}` : message);
    this.name = "ParseError";
  }
}

const TASK_STATEMENT_HEADER = /^\s*(D?([1-5])\.(\d{1,2}))\s+(.+?)\s*$/;
const DOMAIN_HEADER = /^\s*Domain\s+([1-5])\s*[:—-]\s*(.+?)\s*(\(\d+%\))?\s*$/i;
const KNOWLEDGE_LABEL = /^Knowledge\s+of\b[:：]?/i;
const SKILLS_LABEL = /^Skills\s+in\b[:：]?/i;
const BULLET_PREFIX = /^\s*[•●▪∙·\-\u2022]\s*/;

function normalizeId(raw: string): string {
  const match = raw.match(/^D?([1-5])\.(\d{1,2})$/);
  if (!match) throw new ParseError(`not a task statement id: "${raw}"`);
  return `D${match[1]}.${Number(match[2])}`;
}

function normalizeDomainId(raw: string): DomainId {
  const match = raw.match(/^D?([1-5])$/);
  if (!match) throw new ParseError(`not a domain id: "${raw}"`);
  const id = `D${match[1]}` as DomainId;
  if (!EXPECTED_DOMAINS.includes(id)) {
    throw new ParseError(`unexpected domain: "${id}"`);
  }
  return id;
}

function cleanLine(s: string): string {
  return s.replace(BULLET_PREFIX, "").trim();
}

export interface ParserOptions {
  // Fallback weights used when the guide omits explicit percentages.
  defaultWeightsBps?: Record<DomainId, number>;
}

export function parseCurriculumText(
  fullText: string,
  opts: ParserOptions = {},
): ParsedCurriculum {
  const weights = opts.defaultWeightsBps ?? DOMAIN_WEIGHT_BPS;
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));

  const domains = extractDomains(lines, weights);
  const taskStatements = extractTaskStatements(lines);
  assertAllTaskStatementsPresent(taskStatements);

  const scenarios = extractScenarios(lines);
  const questions = extractQuestions(lines, taskStatements);
  const exercises = extractExercises(lines);

  return ParsedCurriculum.parse({
    domains,
    taskStatements,
    scenarios,
    questions,
    exercises,
  });
}

function extractDomains(
  lines: string[],
  weights: Record<DomainId, number>,
): ParsedDomain[] {
  const seen = new Map<DomainId, ParsedDomain>();
  let order = 0;
  for (const raw of lines) {
    const m = raw.match(DOMAIN_HEADER);
    if (!m) continue;
    const id = `D${m[1]}` as DomainId;
    if (seen.has(id)) continue;
    const title = m[2].trim();
    const pct = m[3]?.match(/(\d+)%/)?.[1];
    const weightBps = pct ? Number(pct) * 100 : weights[id];
    seen.set(id, { id, title, weightBps, orderIndex: order++ });
  }
  if (seen.size !== EXPECTED_DOMAINS.length) {
    throw new ParseError(
      `expected ${EXPECTED_DOMAINS.length} domains, got ${seen.size}`,
      "domains",
    );
  }
  return [...seen.values()];
}

function extractTaskStatements(lines: string[]): ParsedTaskStatement[] {
  const results: ParsedTaskStatement[] = [];
  let i = 0;
  const orderInDomain: Record<DomainId, number> = {
    D1: 0,
    D2: 0,
    D3: 0,
    D4: 0,
    D5: 0,
  };
  while (i < lines.length) {
    const header = lines[i].match(TASK_STATEMENT_HEADER);
    if (!header) {
      i++;
      continue;
    }
    const id = normalizeId(header[1]);
    const domainId = normalizeDomainId(`D${header[2]}`);
    const title = header[4].trim();

    const knowledge: string[] = [];
    const skills: string[] = [];
    let section: "none" | "knowledge" | "skills" = "none";

    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (TASK_STATEMENT_HEADER.test(next)) break;
      if (KNOWLEDGE_LABEL.test(next)) {
        section = "knowledge";
      } else if (SKILLS_LABEL.test(next)) {
        section = "skills";
      } else if (BULLET_PREFIX.test(next)) {
        const text = cleanLine(next);
        if (text) {
          if (section === "knowledge") knowledge.push(text);
          else if (section === "skills") skills.push(text);
        }
      }
      j++;
    }

    if (knowledge.length && skills.length) {
      results.push({
        id,
        domainId,
        title,
        knowledgeBullets: knowledge,
        skillsBullets: skills,
        orderIndex: orderInDomain[domainId]++,
      });
    }
    i = j;
  }
  return results;
}

function assertAllTaskStatementsPresent(items: ParsedTaskStatement[]): void {
  const ids = new Set(items.map((t) => t.id));
  const missing = EXPECTED_TASK_STATEMENT_IDS.filter((id) => !ids.has(id));
  if (missing.length) {
    throw new ParseError(
      `missing task statements: ${missing.join(", ")}`,
      "taskStatements",
    );
  }
}

function extractScenarios(lines: string[]): ParsedScenario[] {
  const out: ParsedScenario[] = [];
  const scenarioHeader = /^Scenario\s+(\d+)\s*[:—-]\s*(.+?)\s*$/i;
  const domainsTag = /(?:primary\s+domains?|domains?\s+reinforced)\s*[:：]\s*([D0-9,.\s]+)/i;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(scenarioHeader);
    if (!m) {
      i++;
      continue;
    }
    const idx = Number(m[1]) - 1;
    const id = `S${m[1]}`;
    const title = m[2].trim();
    const descLines: string[] = [];
    const primary: string[] = [];
    let j = i + 1;
    while (j < lines.length && !scenarioHeader.test(lines[j])) {
      const dm = lines[j].match(domainsTag);
      if (dm) {
        for (const piece of dm[1].split(/[,\s]+/)) {
          const p = piece.trim();
          if (!p) continue;
          try {
            primary.push(normalizeDomainId(p));
          } catch {
            // skip non-domain tokens
          }
        }
      } else if (lines[j].trim()) {
        descLines.push(lines[j].trim());
      }
      j++;
    }
    out.push({
      id,
      title,
      description: descLines.join(" ").trim(),
      primaryDomainIds: primary.length ? Array.from(new Set(primary)) : ["D1"],
      orderIndex: idx,
    });
    i = j;
  }
  return out;
}

function extractQuestions(
  lines: string[],
  taskStatements: ParsedTaskStatement[],
): ParsedQuestion[] {
  const out: ParsedQuestion[] = [];
  const qHeader = /^(?:Q|Question|Sample\s+Question)\s*(\d+)\s*[.:—-]\s*(.*)$/i;
  const optLine = /^\s*([A-D])[).:-]\s*(.+?)\s*$/;
  const answerLine = /^Answer\s*[:：]\s*([A-D])\b/i;
  const tsLine = /Task\s+Statement\s*[:：]?\s*(D?[1-5]\.\d{1,2})/i;

  const firstTsId = taskStatements[0]?.id ?? "D1.1";

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(qHeader);
    if (!m) {
      i++;
      continue;
    }
    const qid = `SEED-Q${m[1].padStart(2, "0")}`;
    const stemParts: string[] = [m[2].trim()].filter(Boolean);
    const options: string[] = [];
    let correctIndex = -1;
    const explanations: string[] = ["", "", "", ""];
    let taskStatementId = firstTsId;

    let j = i + 1;
    let mode: "stem" | "options" | "post" = "stem";
    while (j < lines.length && !qHeader.test(lines[j])) {
      const line = lines[j];
      const op = line.match(optLine);
      if (op && options.length < 4) {
        options.push(op[2].trim());
        mode = "options";
      } else if (answerLine.test(line)) {
        correctIndex =
          line.match(answerLine)![1].toUpperCase().charCodeAt(0) - 65;
        mode = "post";
      } else if (tsLine.test(line)) {
        try {
          taskStatementId = normalizeId(line.match(tsLine)![1]);
        } catch {
          // ignore malformed
        }
      } else if (mode === "stem" && line.trim()) {
        stemParts.push(line.trim());
      } else if (mode === "post" && line.trim()) {
        const idx = options.length - 4 < 0 ? 0 : 0;
        explanations[idx] = (explanations[idx] + " " + line.trim()).trim();
      }
      j++;
    }

    if (options.length === 4 && correctIndex >= 0) {
      out.push({
        id: qid,
        stem: stemParts.join(" ").trim(),
        options,
        correctIndex,
        explanations,
        taskStatementId,
        scenarioId: null,
        difficulty: 3,
      });
    }
    i = j;
  }
  return out;
}

function extractExercises(lines: string[]): ParsedExercise[] {
  const out: ParsedExercise[] = [];
  const exHeader =
    /^(?:Exercise|Preparation\s+Exercise)\s+(\d+)\s*[.:—-]\s*(.+?)\s*$/i;
  const stepHeader = /^(?:Step|Part)\s+(\d+)\s*[.:—-]?\s*(.+?)\s*$/i;
  const reinforceTag =
    /(?:domains?\s+reinforced|reinforces)\s*[:：]?\s*([D0-9,.\s]+)/i;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(exHeader);
    if (!m) {
      i++;
      continue;
    }
    const idx = Number(m[1]) - 1;
    const id = `EX${m[1]}`;
    const title = m[2].trim();
    const reinforced: string[] = [];
    const steps: ParsedExercise["steps"] = [];
    const descParts: string[] = [];

    let j = i + 1;
    while (j < lines.length && !exHeader.test(lines[j])) {
      const line = lines[j];
      const r = line.match(reinforceTag);
      const s = line.match(stepHeader);
      if (r) {
        for (const piece of r[1].split(/[,\s]+/)) {
          const p = piece.trim();
          if (!p) continue;
          if (/^D?[1-5](\.\d+)?$/.test(p)) {
            reinforced.push(p.startsWith("D") ? p : `D${p}`);
          }
        }
      } else if (s) {
        steps.push({
          stepIdx: Number(s[1]) - 1,
          prompt: s[2].trim(),
        });
      } else if (line.trim() && steps.length === 0) {
        descParts.push(line.trim());
      }
      j++;
    }

    if (steps.length) {
      out.push({
        id,
        title,
        description: descParts.join(" ").trim() || title,
        domainsReinforced: reinforced.length ? reinforced : ["D1"],
        orderIndex: idx,
        steps,
      });
    }
    i = j;
  }
  return out;
}
