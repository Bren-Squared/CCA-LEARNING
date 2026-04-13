import { z } from "zod";
import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import {
  buildCoverageReport,
  selectFillTargets,
  type CoverageBloomLevel,
} from "@/lib/study/coverage";
import { generateOneQuestion, GeneratorError } from "@/lib/study/generator";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Upper bound for synchronous admin fills. 6b is the sync path only;
 * 6c wires the Batches API for larger bulk runs via Anthropic's async
 * batch endpoint. Anything over this limit would time out the HTTP
 * request before the batch settled.
 */
const MAX_SYNC_FILL = 10;

const postSchema = z.object({
  n: z.number().int().min(1).max(MAX_SYNC_FILL),
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
      {
        error: `invalid payload — n must be an integer in [1, ${MAX_SYNC_FILL}]`,
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const db = getAppDb();
  const report = buildCoverageReport(db);
  const targets = selectFillTargets(report, parsed.data.n);

  if (targets.length === 0) {
    return Response.json({
      requested: parsed.data.n,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      note: "coverage is already at target — no gaps to fill",
    });
  }

  const results: Array<{
    taskStatementId: string;
    bloomLevel: CoverageBloomLevel;
    status: "ok" | "error";
    questionId?: string;
    attemptsUsed?: number;
    errorCode?: string;
    errorMessage?: string;
  }> = [];

  for (const target of targets) {
    try {
      const gen = await generateOneQuestion({
        taskStatementId: target.taskStatementId,
        bloomLevel: target.bloomLevel,
        db,
      });
      results.push({
        taskStatementId: target.taskStatementId,
        bloomLevel: target.bloomLevel,
        status: "ok",
        questionId: gen.questionId,
        attemptsUsed: gen.attemptsUsed,
      });
    } catch (err) {
      if (err instanceof NoApiKeyError) {
        return Response.json(
          { error: err.message, settings_url: "/settings" },
          { status: 400 },
        );
      }
      const errorCode =
        err instanceof GeneratorError ? err.code : "unknown";
      const errorMessage =
        err instanceof Error ? err.message : "unknown error";
      results.push({
        taskStatementId: target.taskStatementId,
        bloomLevel: target.bloomLevel,
        status: "error",
        errorCode,
        errorMessage,
      });
    }
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  return Response.json({
    requested: parsed.data.n,
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}
