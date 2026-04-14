import { z } from "zod";
import { getAppDb } from "@/lib/db";
import { NoApiKeyError } from "@/lib/claude/client";
import { sendTutorTurn, TutorSessionError } from "@/lib/tutor/sessions";
import { CaseFactsError } from "@/lib/tutor/case-facts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  userMessage: z.string().min(1).max(4000),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
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
    const { session, result } = await sendTutorTurn(id, parsed.data.userMessage, {
      db: getAppDb(),
    });
    return Response.json({
      sessionId: session.id,
      topicId: session.topicId,
      finalAssistantText: result.finalAssistantText,
      finalStopReason: result.finalStopReason,
      iterationCount: result.iterationCount,
      reachedIterationCap: result.reachedIterationCap,
      toolCalls: result.toolCalls.map((c) => ({
        iteration: c.iteration,
        name: c.name,
        isError: "isError" in c.result,
      })),
      messageCount: session.messageCount,
      updatedAt: session.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, code: err.code, settings_url: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof TutorSessionError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.code === "not_found" ? 404 : 500 },
      );
    }
    if (err instanceof CaseFactsError) {
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
