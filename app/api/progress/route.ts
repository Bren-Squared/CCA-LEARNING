import { z } from "zod";
import { getAppDb } from "@/lib/db";
import { writeProgressEvent } from "@/lib/progress/events";
import type { BloomLevel } from "@/lib/progress/mastery";

export const runtime = "nodejs";

const EVENT_KINDS = [
  "mcq_answer",
  "flashcard_grade",
  "scenario_grade",
  "tutor_signal",
  "exercise_step_grade",
  "explainer_check",
] as const;

const postSchema = z.object({
  kind: z.enum(EVENT_KINDS),
  taskStatementId: z.string().min(1),
  bloomLevel: z.number().int().min(1).max(6),
  success: z.boolean(),
  payload: z.record(z.string(), z.unknown()).optional(),
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
    const result = writeProgressEvent(
      {
        kind: parsed.data.kind,
        taskStatementId: parsed.data.taskStatementId,
        bloomLevel: parsed.data.bloomLevel as BloomLevel,
        success: parsed.data.success,
        payload: parsed.data.payload,
      },
      getAppDb(),
    );
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
