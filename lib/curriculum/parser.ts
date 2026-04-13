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

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// The published PDF prints a recurring confidential footer on every page;
// unpdf with mergePages: true splices it into the middle of bullet lists and
// scenario descriptions. Strip it before we parse.
const FOOTER_RE =
  /\s*Anthropic,\s*PBC\s*·\s*Confidential\s*Need\s*to\s*Know\s*\(NTK\)\s*/g;

function normalize(raw: string): string {
  return raw
    .replace(FOOTER_RE, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Bullets in this PDF are " - " separators inside a continuous line.
// Splitting on " - " is safe because prose never uses that exact triad.
function splitBullets(s: string): string[] {
  return s
    .split(/\s-\s/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParserOptions {
  defaultWeightsBps?: Record<DomainId, number>;
}

export function parseCurriculumText(
  fullText: string,
  opts: ParserOptions = {},
): ParsedCurriculum {
  const text = normalize(fullText);
  const weights = opts.defaultWeightsBps ?? DOMAIN_WEIGHT_BPS;

  const domains = extractDomains(text, weights);
  const domainByTitle = new Map<string, DomainId>(
    domains.map((d) => [d.title.toLowerCase(), d.id as DomainId]),
  );

  const taskStatements = extractTaskStatements(text);
  assertAllTaskStatementsPresent(taskStatements);

  const scenarios = extractScenarios(text, domainByTitle);
  const questions = extractQuestions(text, taskStatements, scenarios);
  const exercises = extractExercises(text, domainByTitle);

  return ParsedCurriculum.parse({
    domains,
    taskStatements,
    scenarios,
    questions,
    exercises,
  });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

function extractDomains(
  text: string,
  fallbackWeights: Record<DomainId, number>,
): ParsedDomain[] {
  const re = /Domain\s+([1-5])\s*[:—-]\s*(.+?)\s*\((\d{1,3})%\s*of\s*scored\s*content\)/gi;
  const seen = new Map<DomainId, ParsedDomain>();
  let order = 0;
  for (const m of text.matchAll(re)) {
    const id = `D${m[1]}` as DomainId;
    if (seen.has(id)) continue;
    const title = m[2].trim().replace(/\s+[-–—]\s*$/, "");
    const weightBps = Number(m[3]) * 100;
    seen.set(id, { id, title, weightBps, orderIndex: order++ });
  }
  if (seen.size !== EXPECTED_DOMAINS.length) {
    // Fall back to the weights map if the PDF format diverged.
    if (seen.size === 0) {
      return EXPECTED_DOMAINS.map((id, idx) => ({
        id,
        title: id,
        weightBps: fallbackWeights[id],
        orderIndex: idx,
      }));
    }
    throw new ParseError(
      `expected ${EXPECTED_DOMAINS.length} domains, got ${seen.size}`,
      "domains",
    );
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Task statements
// ---------------------------------------------------------------------------

function extractTaskStatements(text: string): ParsedTaskStatement[] {
  const markerRe = /Task\s+Statement\s+(\d)\.(\d{1,2})\s*:\s*/gi;
  const markers: Array<{ id: string; start: number; end: number }> = [];
  for (const m of text.matchAll(markerRe)) {
    const idx = m.index ?? 0;
    markers.push({
      id: `D${m[1]}.${Number(m[2])}`,
      start: idx,
      end: idx + m[0].length,
    });
  }
  if (markers.length === 0) {
    throw new ParseError("no Task Statement markers found", "taskStatements");
  }

  const results: ParsedTaskStatement[] = [];
  const orderInDomain: Record<DomainId, number> = {
    D1: 0,
    D2: 0,
    D3: 0,
    D4: 0,
    D5: 0,
  };

  for (let i = 0; i < markers.length; i++) {
    const current = markers[i];
    const nextStart = markers[i + 1]?.start ?? text.length;
    const body = text.slice(current.end, nextStart);

    const knowledgeIdx = body.search(/Knowledge\s+of\s*:/i);
    const skillsIdx = body.search(/Skills\s+in\s*:/i);
    if (knowledgeIdx < 0 || skillsIdx < 0) {
      throw new ParseError(
        `${current.id}: missing Knowledge/Skills sections`,
        "taskStatements",
      );
    }

    const title = body.slice(0, knowledgeIdx).trim().replace(/[.,;:]\s*$/, "");
    const knowledgeText = body.slice(
      knowledgeIdx + body.slice(knowledgeIdx).indexOf(":") + 1,
      skillsIdx,
    );
    const skillsText = body.slice(
      skillsIdx + body.slice(skillsIdx).indexOf(":") + 1,
    );

    const knowledgeBullets = splitBullets(knowledgeText);
    const skillsBullets = splitBullets(skillsText);

    if (!knowledgeBullets.length || !skillsBullets.length) {
      throw new ParseError(
        `${current.id}: empty Knowledge or Skills bullet list`,
        "taskStatements",
      );
    }

    const domainId = current.id.slice(0, 2) as DomainId;
    results.push({
      id: current.id,
      domainId,
      title,
      knowledgeBullets,
      skillsBullets,
      orderIndex: orderInDomain[domainId]++,
    });
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

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function extractScenarios(
  text: string,
  domainByTitle: Map<string, DomainId>,
): ParsedScenario[] {
  const markerRe = /Scenario\s+(\d)\s*:\s*/gi;
  const markers: Array<{ idx: number; start: number; end: number }> = [];
  // Only count the scenarios that appear in the Exam Scenarios table — the
  // Sample Questions section uses "Scenario:" (no number) as a heading before
  // each question cluster, which is a different marker.
  for (const m of text.matchAll(markerRe)) {
    markers.push({
      idx: Number(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  const out: ParsedScenario[] = [];
  const primaryDomainsRe =
    /Primary\s+domains\s*:\s*(.+?)(?=(?:Scenario\s+\d\s*:)|(?:Sample\s+Questions)|(?:Preparation\s+Exercises)|(?:Exam\s+Scenarios)|$)/i;

  for (let i = 0; i < markers.length; i++) {
    const current = markers[i];
    const nextStart = markers[i + 1]?.start ?? text.length;
    const body = text.slice(current.end, nextStart);

    const titleEnd = findScenarioTitleEnd(body);
    const title = body.slice(0, titleEnd).trim().replace(/[.,;:]$/, "");

    const domainsMatch = body.match(primaryDomainsRe);
    const primaryDomainIds = domainsMatch
      ? resolveDomainTitles(domainsMatch[1], domainByTitle)
      : ["D1"];

    const descEnd = domainsMatch?.index ?? body.length;
    const description = body.slice(titleEnd, descEnd).trim();

    out.push({
      id: `S${current.idx}`,
      title,
      description,
      primaryDomainIds,
      orderIndex: current.idx - 1,
    });
  }
  return out;
}

// Scenario titles are short Title-Case phrases immediately followed by
// description prose ("You are building…"). Detect the boundary at the first
// description-starter, falling back to the first sentence break or 80 chars.
function findScenarioTitleEnd(body: string): number {
  const starters = [
    /\sYou\s+are\b/,
    /\sYou\s+have\b/,
    /\sYou\s+need\b/,
    /\sYour\s+team\b/,
    /\sThe\s+system\b/,
    /\sDescription\s*:/i,
  ];
  let best = -1;
  for (const re of starters) {
    const m = body.match(re);
    if (m && m.index !== undefined && (best === -1 || m.index < best)) {
      best = m.index;
    }
  }
  if (best > 0) return best;
  const dot = body.indexOf(". ");
  if (dot > 0 && dot < 100) return dot;
  return Math.min(body.length, 80);
}

function resolveDomainTitles(
  raw: string,
  domainByTitle: Map<string, DomainId>,
): string[] {
  const pieces = raw
    .split(/\s*,\s*/)
    .map((p) => p.trim().toLowerCase().replace(/[.;:]+$/, ""));
  const out: DomainId[] = [];
  for (const p of pieces) {
    const hit =
      domainByTitle.get(p) ??
      [...domainByTitle.entries()].find(
        ([title]) => title.startsWith(p) || p.startsWith(title),
      )?.[1];
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.length ? out : ["D1"];
}

// ---------------------------------------------------------------------------
// Sample questions
// ---------------------------------------------------------------------------

function extractQuestions(
  text: string,
  taskStatements: ParsedTaskStatement[],
  scenarios: ParsedScenario[],
): ParsedQuestion[] {
  const sampleStart = text.search(/Sample\s+Questions\b/i);
  if (sampleStart < 0) {
    throw new ParseError("no Sample Questions section", "questions");
  }
  const prepStart = text.search(/Preparation\s+Exercises\b/i);
  const region = text.slice(
    sampleStart,
    prepStart > sampleStart ? prepStart : text.length,
  );

  // Track which scenario title precedes each question cluster inside the
  // sample-questions region. Scenarios here appear as "Scenario: <Title>"
  // headers before each group.
  type ClusterHeader = { start: number; title: string };
  const clusterRe = /Scenario\s*:\s*([^?]+?)(?=\s+Question\s+\d+:)/gi;
  const clusters: ClusterHeader[] = [];
  for (const m of region.matchAll(clusterRe)) {
    clusters.push({ start: m.index ?? 0, title: m[1].trim() });
  }
  const scenarioByTitle = new Map(
    scenarios.map((s) => [s.title.toLowerCase(), s]),
  );

  const qMarkerRe = /Question\s+(\d+)\s*:\s*/gi;
  const markers: Array<{ n: number; start: number; end: number }> = [];
  for (const m of region.matchAll(qMarkerRe)) {
    markers.push({
      n: Number(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }

  const out: ParsedQuestion[] = [];
  for (let i = 0; i < markers.length; i++) {
    const mk = markers[i];
    const nextStart = markers[i + 1]?.start ?? region.length;
    const body = region.slice(mk.end, nextStart);

    const optStart = body.search(/\sA\)\s/);
    if (optStart < 0) continue;
    const stem = body.slice(0, optStart).trim();

    const optionsAndTail = body.slice(optStart);
    const optionRegex = /\s([A-D])\)\s+([\s\S]+?)(?=\s[A-D]\)\s+|\s+Correct\s+Answer)/g;
    const options: string[] = ["", "", "", ""];
    for (const om of optionsAndTail.matchAll(optionRegex)) {
      const idx = om[1].charCodeAt(0) - 65;
      if (idx >= 0 && idx < 4) options[idx] = om[2].trim().replace(/\.$/, ".");
    }
    if (options.some((o) => !o)) continue;

    const answerMatch = body.match(/Correct\s+Answer\s*:\s*([A-D])/i);
    if (!answerMatch) continue;
    const correctIndex = answerMatch[0].slice(-1).toUpperCase().charCodeAt(0) - 65;

    const explanationStart =
      body.indexOf(answerMatch[0]) + answerMatch[0].length;
    const explanationText = body.slice(explanationStart).trim();
    const explanations = ["", "", "", ""];
    explanations[correctIndex] = explanationText;

    // Pick the nearest scenario header before this question
    const absoluteQStart = mk.start;
    let scenarioId: string | null = null;
    for (const c of clusters) {
      if (c.start < absoluteQStart) {
        scenarioId = scenarioByTitle.get(c.title.toLowerCase())?.id ?? null;
      } else break;
    }

    out.push({
      id: `SEED-Q${String(mk.n).padStart(2, "0")}`,
      stem,
      options,
      correctIndex,
      explanations,
      // Guide doesn't name an explicit TS per question; default to first TS
      // of the scenario's first primary domain. Bloom classifier (Phase 2)
      // narrows this. Ingestion-time defaults are safe to refine later.
      taskStatementId: pickDefaultTaskStatement(
        scenarioId,
        scenarios,
        taskStatements,
      ),
      scenarioId,
      difficulty: 3,
    });
  }
  return out;
}

function pickDefaultTaskStatement(
  scenarioId: string | null,
  scenarios: ParsedScenario[],
  taskStatements: ParsedTaskStatement[],
): string {
  if (scenarioId) {
    const s = scenarios.find((x) => x.id === scenarioId);
    const preferredDomain = s?.primaryDomainIds[0];
    if (preferredDomain) {
      const first = taskStatements.find((t) => t.domainId === preferredDomain);
      if (first) return first.id;
    }
  }
  return taskStatements[0]?.id ?? "D1.1";
}

// ---------------------------------------------------------------------------
// Preparation exercises
// ---------------------------------------------------------------------------

function extractExercises(
  text: string,
  domainByTitle: Map<string, DomainId>,
): ParsedExercise[] {
  const prepStart = text.search(/Preparation\s+Exercises\b/i);
  if (prepStart < 0) return [];
  const region = text.slice(prepStart);

  const exRe = /Exercise\s+(\d+)\s*:\s*/gi;
  const markers: Array<{ n: number; start: number; end: number }> = [];
  for (const m of region.matchAll(exRe)) {
    markers.push({
      n: Number(m[1]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }

  const out: ParsedExercise[] = [];
  for (let i = 0; i < markers.length; i++) {
    const current = markers[i];
    const nextStart = markers[i + 1]?.start ?? region.length;
    const body = region.slice(current.end, nextStart);

    const objIdx = body.search(/Objective\s*:/i);
    const stepsIdx = body.search(/Steps\s*:/i);
    const reinforceIdx = body.search(/Domains?\s+reinforced\s*:/i);

    const title =
      objIdx > 0
        ? body.slice(0, objIdx).trim().replace(/[.,;:]\s*$/, "")
        : body.slice(0, 80).trim();

    const description =
      objIdx >= 0 && stepsIdx > objIdx
        ? body
            .slice(objIdx + body.slice(objIdx).indexOf(":") + 1, stepsIdx)
            .trim()
        : title;

    const stepsBody =
      stepsIdx >= 0
        ? body.slice(
            stepsIdx + body.slice(stepsIdx).indexOf(":") + 1,
            reinforceIdx > stepsIdx ? reinforceIdx : body.length,
          )
        : "";
    const steps = splitNumberedSteps(stepsBody);

    const reinforcedText =
      reinforceIdx >= 0
        ? body.slice(
            reinforceIdx + body.slice(reinforceIdx).indexOf(":") + 1,
          )
        : "";
    const domainsReinforced = reinforcedText
      ? resolveDomainTitles(reinforcedText, domainByTitle)
      : ["D1"];

    if (!steps.length) continue;

    out.push({
      id: `EX${current.n}`,
      title,
      description,
      domainsReinforced,
      orderIndex: current.n - 1,
      steps,
    });
  }
  return out;
}

function splitNumberedSteps(
  body: string,
): Array<{ stepIdx: number; prompt: string }> {
  const out: Array<{ stepIdx: number; prompt: string }> = [];
  const re = /(?:^|\s)(\d{1,2})\.\s+([\s\S]+?)(?=\s+\d{1,2}\.\s+|$)/g;
  for (const m of body.matchAll(re)) {
    const n = Number(m[1]);
    const prompt = m[2].trim();
    if (prompt) out.push({ stepIdx: n - 1, prompt });
  }
  return out;
}
