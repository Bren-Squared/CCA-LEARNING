import { NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";
import {
  BulkGenError,
  getBulkJob,
  processBulkJob,
  refreshBulkJob,
} from "@/lib/study/bulk-gen";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Refresh the batch status from Anthropic. When the batch has ended and
 * results have not yet been processed, also stream + score them. Returns
 * the updated job row plus any processing summary.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const db = getAppDb();
    const refreshed = await refreshBulkJob(id, { db });
    let processed: Awaited<ReturnType<typeof processBulkJob>> | null = null;
    if (refreshed.status === "ended" && !refreshed.processedAt) {
      processed = await processBulkJob(id, { db });
    }
    const job = getBulkJob(id, db);
    return Response.json({ ok: true, job, processed });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        { error: err.message, settings_url: "/settings" },
        { status: 400 },
      );
    }
    if (err instanceof BulkGenError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "not_ended"
            ? 409
            : 500;
      return Response.json(
        { error: err.message, code: err.code },
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
