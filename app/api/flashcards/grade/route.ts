import { z } from "zod";
import { getAppDb } from "@/lib/db";
import {
  applyFlashcardGrade,
  FlashcardGradeError,
} from "@/lib/study/flashcard-grade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  cardId: z.string().min(1),
  grade: z.enum(["again", "hard", "good", "easy"]),
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
    const result = applyFlashcardGrade(
      parsed.data.cardId,
      parsed.data.grade,
      { db: getAppDb() },
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof FlashcardGradeError) {
      const status = err.code === "not_found" ? 404 : 500;
      return Response.json({ error: err.message, code: err.code }, { status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
