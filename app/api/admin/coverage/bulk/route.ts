import { z } from "zod";
import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import {
  BulkGenError,
  MAX_BULK_N,
  createBulkJob,
  listBulkJobs,
} from "@/lib/study/bulk-gen";

export const runtime = "nodejs";
export const maxDuration = 60;

const postSchema = z.object({
  n: z.number().int().min(1).max(MAX_BULK_N),
  confirm: z.boolean().optional(),
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
      {
        error: `invalid payload — n must be an integer in [1, ${MAX_BULK_N}]`,
        details: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const result = await createBulkJob({
      n: parsed.data.n,
      confirm: parsed.data.confirm,
      db: getAppDb(),
    });
    return Response.json({
      ok: true,
      jobId: result.jobId,
      anthropicBatchId: result.anthropicBatchId,
      projection: result.projection,
      targets: result.targets,
    });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, settings_url: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof BulkGenError) {
      const status =
        err.code === "bad_n"
          ? 400
          : err.code === "no_gaps"
            ? 409
            : err.code === "over_ceiling"
              ? 402
              : 500;
      return Response.json(
        { error: err.message, code: err.code, detail: err.detail ?? null },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    return Response.json(
      { error: message, code: "unknown" },
      { status: 500 },
    );
  }
}

export async function GET() {
  const jobs = listBulkJobs(getAppDb());
  return Response.json({ jobs });
}
