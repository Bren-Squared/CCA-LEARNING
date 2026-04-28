import { z } from "zod";
import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import { hasApiKey } from "@/lib/settings";
import { retireDuplicates, scanForDuplicates } from "@/lib/study/dedup";

export const runtime = "nodejs";
export const maxDuration = 600;

const analyzeSchema = z.object({ action: z.literal("analyze") });
const retireSchema = z.object({
  action: z.literal("retire"),
  retireIds: z.array(z.string().min(1)).min(1),
});
const postSchema = z.discriminatedUnion("action", [analyzeSchema, retireSchema]);

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
        error: "invalid payload — action must be 'analyze' or 'retire'",
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const db = getAppDb();

  if (!hasApiKey(db)) {
    return Response.json(
      { error: "API key not configured — add one in /settings" },
      { status: 403 },
    );
  }

  if (parsed.data.action === "analyze") {
    try {
      const result = await scanForDuplicates(db);
      return Response.json(result);
    } catch (err) {
      if (err instanceof NoApiKeyError) {
        return Response.json({ error: "API key not configured" }, { status: 403 });
      }
      const message = err instanceof Error ? err.message : "scan failed";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // action === "retire"
  const { retired } = retireDuplicates(parsed.data.retireIds, db);
  return Response.json({ ok: true, retired });
}
