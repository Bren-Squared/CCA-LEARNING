import { z } from "zod";
import { getAppDb } from "@/lib/db";
import { listTutorSessions, startTutorSession, TutorSessionError } from "@/lib/tutor/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  topicId: z.string().min(1),
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
    const session = startTutorSession(parsed.data.topicId, getAppDb());
    return Response.json(
      {
        sessionId: session.id,
        topicId: session.topicId,
        createdAt: session.createdAt.toISOString(),
      },
      { status: 201 },
    );
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const topicId = url.searchParams.get("topicId") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(100, Number(limitParam))) : undefined;
  const rows = listTutorSessions(getAppDb(), { topicId, limit });
  return Response.json({
    sessions: rows.map((r) => ({
      id: r.id,
      topicId: r.topicId,
      messageCount: r.messageCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}
