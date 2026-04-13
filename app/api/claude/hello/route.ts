import { callClaude, firstText, NoApiKeyError } from "@/lib/claude/client";
import { getAppDb } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Phase 2 smoke test (AT10). Confirms the full wiring:
 *   settings → client → Anthropic → token log.
 *
 * The response body and server logs are scrubbed — only tokens + model +
 * the literal text we asked for come back. The raw API key never appears
 * anywhere the browser can see.
 */
export async function GET() {
  getAppDb();
  try {
    const response = await callClaude({
      role: "smoke_test",
      system:
        "You are a terse assistant used only for a wiring smoke test. Reply with at most 12 words.",
      messages: [
        {
          role: "user",
          content: 'Say "phase 2 wiring is live" and nothing else.',
        },
      ],
      maxTokens: 64,
      temperature: 0,
    });
    return Response.json({
      ok: true,
      model: response.model,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      text: firstText(response),
    });
  } catch (err) {
    if (err instanceof NoApiKeyError) {
      return Response.json(
        {
          ok: false,
          code: "no_api_key",
          message: err.message,
          settings_url: "/settings",
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        ok: false,
        code: "claude_call_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 500 },
    );
  }
}
