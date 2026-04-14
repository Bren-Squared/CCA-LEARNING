import { z } from "zod";
import { getAppDb } from "@/lib/db";
import {
  MockAllocationError,
  listMockAttempts,
  startMockAttempt,
} from "@/lib/mock/attempts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startSchema = z
  .object({
    durationMs: z.number().int().positive().optional(),
  })
  .optional();

export async function POST(req: Request) {
  let body: unknown = undefined;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const attempt = startMockAttempt({
      db: getAppDb(),
      durationMs: parsed.data?.durationMs,
    });
    return Response.json({ attempt }, { status: 201 });
  } catch (err) {
    if (err instanceof MockAllocationError) {
      const status =
        err.code === "insufficient_questions" ||
        err.code === "insufficient_scenarios"
          ? 409
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

export async function GET() {
  const attempts = listMockAttempts({ db: getAppDb(), limit: 50 });
  return Response.json({ attempts });
}
