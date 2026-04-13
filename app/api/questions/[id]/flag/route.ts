import { getAppDb } from "@/lib/db";
import { flagQuestion } from "@/lib/study/coverage";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return Response.json({ error: "missing question id" }, { status: 400 });
  }
  const result = flagQuestion(id, getAppDb());
  if (!result.ok) {
    return Response.json(
      { error: `question "${id}" not found` },
      { status: 404 },
    );
  }
  return Response.json({
    ok: true,
    id,
    previousStatus: result.previousStatus,
    status: "retired",
  });
}
