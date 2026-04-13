import { describe, expect, it } from "vitest";

describe("sanity", () => {
  it("arithmetic works (vitest is wired up)", () => {
    expect(1 + 1).toBe(2);
  });

  it("environment is Node >= 22", () => {
    const [major] = process.versions.node.split(".");
    expect(Number(major)).toBeGreaterThanOrEqual(22);
  });
});
