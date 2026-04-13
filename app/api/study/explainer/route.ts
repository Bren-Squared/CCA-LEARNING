import { z } from "zod";
import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import { ExplainerError, getOrGenerateExplainer } from "@/lib/study/explainer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  taskStatementId: z.string().min(1),
  forceRegenerate: z.boolean().optional(),
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
    const artifact = await getOrGenerateExplainer(parsed.data.taskStatementId, {
      db: getAppDb(),
      forceRegenerate: parsed.data.forceRegenerate,
    });
    return Response.json(artifact);
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, code: err.code, settings_url: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof ExplainerError) {
      const status = err.code === "not_found" ? 404 : 502;
      return Response.json({ error: err.message, code: err.code }, { status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
