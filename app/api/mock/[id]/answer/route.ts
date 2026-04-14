import { z } from "zod";
import { getAppDb } from "@/lib/db";
import { MockAttemptError, submitAnswer } from "@/lib/mock/attempts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  qIdx: z.number().int().min(0),
  optionIdx: z.number().int().min(0).max(3).nullable(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const attempt = submitAnswer(
      id,
      parsed.data.qIdx,
      parsed.data.optionIdx,
      { db: getAppDb() },
    );
    return Response.json({ attempt });
  } catch (err) {
    if (err instanceof MockAttemptError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "not_in_progress"
            ? 409
            : 400;
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
