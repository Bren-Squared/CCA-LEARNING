import { z } from "zod";
import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import { generateOneQuestion, GeneratorError } from "@/lib/study/generator";
import type { BloomLevel } from "@/lib/progress/mastery";

export const runtime = "nodejs";

const postSchema = z.object({
  taskStatementId: z.string().min(1),
  bloomLevel: z.number().int().min(1).max(6),
  scenarioId: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const result = await generateOneQuestion({
      taskStatementId: parsed.data.taskStatementId,
      bloomLevel: parsed.data.bloomLevel as BloomLevel,
      scenarioId: parsed.data.scenarioId,
      db: getAppDb(),
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, settings_url: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof GeneratorError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "exhausted"
            ? 422
            : err.code === "bad_generator_output" || err.code === "bad_reviewer_output"
              ? 502
              : err.code === "no_tool_use"
                ? 502
                : 500;
      return Response.json(
        { error: err.message, code: err.code, detail: err.detail },
        { status },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
