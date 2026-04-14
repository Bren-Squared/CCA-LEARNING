import { z } from "zod";
import { getAppDb } from "@/lib/db";
import {
  clearApiKey,
  getSettingsStatus,
  setApiKey,
  setBulkCostCeilingUsd,
  setDarkMode,
  setDefaultModel,
  setReviewHalfLifeDays,
} from "@/lib/settings";

export const runtime = "nodejs";

export async function GET() {
  const db = getAppDb();
  return Response.json(getSettingsStatus(db));
}

const postSchema = z
  .object({
    apiKey: z.string().min(20).optional(),
    defaultModel: z.string().min(1).optional(),
    clearApiKey: z.boolean().optional(),
    reviewHalfLifeDays: z.number().min(1).max(120).optional(),
    bulkCostCeilingUsd: z.number().min(0).max(50).optional(),
    darkMode: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.apiKey !== undefined ||
      v.defaultModel !== undefined ||
      v.clearApiKey === true ||
      v.reviewHalfLifeDays !== undefined ||
      v.bulkCostCeilingUsd !== undefined ||
      v.darkMode !== undefined,
    { message: "at least one field required" },
  );

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "request body must be valid JSON" },
      { status: 400 },
    );
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const db = getAppDb();
  try {
    if (parsed.data.clearApiKey) clearApiKey(db);
    if (parsed.data.apiKey) setApiKey(parsed.data.apiKey, db);
    if (parsed.data.defaultModel) setDefaultModel(parsed.data.defaultModel, db);
    if (parsed.data.reviewHalfLifeDays !== undefined)
      setReviewHalfLifeDays(parsed.data.reviewHalfLifeDays, db);
    if (parsed.data.bulkCostCeilingUsd !== undefined)
      setBulkCostCeilingUsd(parsed.data.bulkCostCeilingUsd, db);
    if (parsed.data.darkMode !== undefined)
      setDarkMode(parsed.data.darkMode, db);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
  // Never include the raw key in the response.
  return Response.json(getSettingsStatus(db));
}
