import { getAppDb } from "@/lib/db";
import { deleteTutorSession, getTutorSession, TutorSessionError } from "@/lib/tutor/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const s = getTutorSession(id, getAppDb());
    return Response.json({
      id: s.id,
      topicId: s.topicId,
      messageCount: s.messageCount,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messages: s.messages,
    });
  } catch (err) {
    if (err instanceof TutorSessionError && err.code === "not_found") {
      return Response.json({ error: err.message, code: err.code }, { status: 404 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const res = deleteTutorSession(id, getAppDb());
  return Response.json(res, { status: res.deleted ? 200 : 404 });
}
