import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Prompt template files live under /prompts (repo root) so they're easy to
 * find and version separately from application code. Each file is plain
 * Markdown with a minimal YAML-ish frontmatter:
 *
 *   ---
 *   id: tutor.case-facts
 *   version: 1
 *   inputs: [task_statement_id, ceiling, recent_misses]
 *   outputs: [system_prompt_text]
 *   ---
 *   You are a Socratic tutor for ... {{task_statement_id}}
 *
 * The loader parses frontmatter and exposes `.render(inputs)` which
 * substitutes `{{var}}` placeholders. We deliberately avoid a full template
 * engine — the value of this layer is structure and lint-ability, not
 * conditionals in prompts.
 */

const frontmatterSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1).default(1),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export type PromptFrontmatter = z.infer<typeof frontmatterSchema>;

export interface PromptTemplate {
  frontmatter: PromptFrontmatter;
  body: string;
  filePath: string;
  render(inputs: Record<string, string | number>): string;
}

function parseScalar(raw: string): string | number {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`expected array literal, got: ${raw}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => {
    const val = parseScalar(part);
    return typeof val === "string" ? val : String(val);
  });
}

interface RawFrontmatter {
  id?: string;
  version?: number;
  inputs?: string[];
  outputs?: string[];
  description?: string;
}

function parseFrontmatter(raw: string): RawFrontmatter {
  const out: RawFrontmatter = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) throw new Error(`bad frontmatter line (no colon): ${line}`);
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (key === "inputs" || key === "outputs") {
      out[key] = parseArray(value);
    } else if (key === "version") {
      const num = parseScalar(value);
      out.version = typeof num === "number" ? num : Number(num);
    } else if (key === "id" || key === "description") {
      const v = parseScalar(value);
      out[key] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

export function parsePromptFile(
  content: string,
  filePath: string,
): PromptTemplate {
  if (!content.startsWith("---")) {
    throw new Error(
      `prompt file is missing YAML frontmatter: ${filePath} — see .claude/rules/prompts.md`,
    );
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    throw new Error(`prompt file frontmatter is not terminated: ${filePath}`);
  }
  const fmRaw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const parsed = frontmatterSchema.parse(parseFrontmatter(fmRaw));
  const template: PromptTemplate = {
    frontmatter: parsed,
    body,
    filePath,
    render(inputs) {
      return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (!(key in inputs)) {
          throw new Error(
            `prompt ${parsed.id}: missing input "${key}" (declared inputs: ${parsed.inputs.join(", ")})`,
          );
        }
        return String(inputs[key]);
      });
    },
  };
  return template;
}

export function loadPromptFile(filePath: string): PromptTemplate {
  const content = readFileSync(filePath, "utf8");
  return parsePromptFile(content, filePath);
}

function promptsRoot(): string {
  return resolve(process.cwd(), "prompts");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (extname(entry) === ".md") {
      out.push(full);
    }
  }
}

/**
 * Loads every .md prompt under /prompts and indexes by `id`. Throws on
 * duplicate ids so a rename/copy mistake can't silently shadow another
 * template.
 */
export function loadAllPrompts(
  root: string = promptsRoot(),
): Map<string, PromptTemplate> {
  const files: string[] = [];
  try {
    walk(root, files);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return new Map();
    }
    throw err;
  }
  const out = new Map<string, PromptTemplate>();
  for (const file of files) {
    const tpl = loadPromptFile(file);
    const existing = out.get(tpl.frontmatter.id);
    if (existing) {
      throw new Error(
        `duplicate prompt id "${tpl.frontmatter.id}" in ${file} (first seen in ${existing.filePath})`,
      );
    }
    out.set(tpl.frontmatter.id, tpl);
  }
  return out;
}
