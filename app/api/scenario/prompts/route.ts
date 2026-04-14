import { getAppDb } from "@/lib/db";
import { listAllScenariosWithPrompts } from "@/lib/scenarios/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getAppDb();
  const scenarios = listAllScenariosWithPrompts(db);
  return Response.json({ scenarios });
}
