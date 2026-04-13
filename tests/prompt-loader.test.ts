import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllPrompts, parsePromptFile } from "../lib/claude/prompts/loader";

describe("prompt loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cca-prompts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses frontmatter and renders placeholders", () => {
    const raw = [
      "---",
      "id: demo.one",
      "version: 2",
      "inputs: [name, level]",
      "outputs: [text]",
      "---",
      "Hello {{name}}, level {{level}}.",
    ].join("\n");
    const tpl = parsePromptFile(raw, "inline.md");
    expect(tpl.frontmatter.id).toBe("demo.one");
    expect(tpl.frontmatter.version).toBe(2);
    expect(tpl.frontmatter.inputs).toEqual(["name", "level"]);
    expect(tpl.render({ name: "Bren", level: 3 })).toBe(
      "Hello Bren, level 3.",
    );
  });

  it("throws when a placeholder is not supplied", () => {
    const tpl = parsePromptFile(
      "---\nid: x\ninputs: [name]\n---\nHi {{name}}",
      "inline.md",
    );
    expect(() => tpl.render({})).toThrow(/name/);
  });

  it("throws when the file is missing frontmatter", () => {
    expect(() =>
      parsePromptFile("just a body, no frontmatter", "bad.md"),
    ).toThrow(/frontmatter/);
  });

  it("indexes prompts by id under a directory", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(
      join(dir, "a.md"),
      "---\nid: a\n---\nBody A",
    );
    writeFileSync(
      join(dir, "sub", "b.md"),
      "---\nid: b.nested\n---\nBody B",
    );
    const map = loadAllPrompts(dir);
    expect(map.size).toBe(2);
    expect(map.get("a")!.body.trim()).toBe("Body A");
    expect(map.get("b.nested")!.body.trim()).toBe("Body B");
  });

  it("rejects duplicate ids across files", () => {
    writeFileSync(join(dir, "a.md"), "---\nid: dup\n---\nA");
    writeFileSync(join(dir, "b.md"), "---\nid: dup\n---\nB");
    expect(() => loadAllPrompts(dir)).toThrow(/duplicate/);
  });

  it("returns an empty map when the prompts dir does not exist", () => {
    const map = loadAllPrompts(join(dir, "does-not-exist"));
    expect(map.size).toBe(0);
  });
});
