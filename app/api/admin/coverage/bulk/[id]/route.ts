import { getAppDb } from "@/lib/db";
import { getBulkJob } from "@/lib/study/bulk-gen";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getBulkJob(id, getAppDb());
  if (!job) {
    return Response.json({ error: `job "${id}" not found` }, { status: 404 });
  }
  return Response.json({ job });
}
