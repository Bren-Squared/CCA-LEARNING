import { z } from "zod";
import { getAppDb } from "@/lib/db";
import {
  gradeScenarioAttempt,
  ScenarioGradeError,
} from "@/lib/scenarios/grade";
import { ScenarioPromptError } from "@/lib/scenarios/prompts";
import { NoApiKeyError } from "@/lib/claude/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  promptId: z.string().min(1),
  answerText: z.string().min(1),
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
    const result = await gradeScenarioAttempt(
      parsed.data.promptId,
      parsed.data.answerText,
      { db: getAppDb() },
    );
    return Response.json({
      attemptId: result.attemptId,
      overallScore: result.overallScore,
      success: result.success,
      perCriterion: result.perCriterion,
      strengths: result.strengths,
      gaps: result.gaps,
      modelAnswer: result.modelAnswer,
      rubric: result.rubric,
      masteryScore: result.masteryScore,
      masteryItemCount: result.masteryItemCount,
    });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    if (err instanceof ScenarioPromptError) {
      const status = err.code === "not_found" ? 404 : 502;
      return Response.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    if (err instanceof ScenarioGradeError) {
      const status =
        err.code === "answer_too_short" || err.code === "answer_too_long"
          ? 400
          : err.code === "not_found"
            ? 404
            : err.code === "no_tool_use" || err.code === "bad_tool_output"
              ? 502
              : 500;
      return Response.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
