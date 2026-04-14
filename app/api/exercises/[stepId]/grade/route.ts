import { z } from "zod";
import { getAppDb } from "@/lib/db";
import {
  ExerciseGradeError,
  gradeExerciseStep,
} from "@/lib/exercises/grade";
import { ExerciseError } from "@/lib/exercises/steps";
import { NoApiKeyError } from "@/lib/claude/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  artifactText: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ stepId: string }> },
) {
  const { stepId } = await ctx.params;
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
    const result = await gradeExerciseStep(stepId, parsed.data.artifactText, {
      db: getAppDb(),
    });
    return Response.json({
      attemptId: result.attemptId,
      stepId: result.stepId,
      exerciseId: result.exerciseId,
      overallScore: result.overallScore,
      success: result.success,
      perCriterion: result.perCriterion,
      strengths: result.strengths,
      gaps: result.gaps,
      modelAnswer: result.modelAnswer,
      rubric: result.rubric,
      reinforcedTaskStatementIds: result.reinforcedTaskStatementIds,
      masterySnapshots: result.masterySnapshots,
    });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, code: err.code, settingsUrl: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof ExerciseError) {
      const status = err.code === "not_found" ? 404 : 502;
      return Response.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    if (err instanceof ExerciseGradeError) {
      const status =
        err.code === "artifact_too_short" || err.code === "artifact_too_long"
          ? 400
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
