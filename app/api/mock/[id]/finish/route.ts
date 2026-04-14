import { getAppDb } from "@/lib/db";
import { MockAttemptError, finishMockAttempt } from "@/lib/mock/attempts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const attempt = finishMockAttempt(id, { db: getAppDb() });
    return Response.json({ attempt });
  } catch (err) {
    if (err instanceof MockAttemptError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.code === "not_found" ? 404 : 500 },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
