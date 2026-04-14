import type Anthropic from "@anthropic-ai/sdk";
import { resolve } from "node:path";
import type { Db } from "../db";
import { getAppDb } from "../db";
import { callClaude } from "../claude/client";
import { loadPromptFile } from "../claude/prompts/loader";
import {
  buildTutorToolSet,
  tutorRole,
  type AnyTutorTool,
  type TutorToolSet,
} from "../claude/roles/tutor";
import { serializeToolResult } from "../claude/tools";
import { buildCaseFacts, caseFactsToPromptInputs } from "./case-facts";

/**
 * Agentic loop driver for the Socratic tutor (FR2.5 / D1.1).
 *
 * The loop is **stop_reason-driven** and never parses assistant text to infer
 * intent. Each iteration:
 *
 *   1. Rebuild the system prompt from case facts (D5.1 — always current).
 *   2. Call Claude with the current transcript + tutor tool set.
 *   3. Branch on `response.stop_reason`:
 *        - "tool_use": execute every tool_use block, append a user message
 *          carrying the corresponding tool_result blocks, continue.
 *        - "end_turn" / "max_tokens": stop.
 *        - "stop_sequence" / anything else: stop (we don't set stop sequences).
 *   4. Hard iteration cap ({@link DEFAULT_MAX_ITERATIONS}) to prevent a
 *      runaway loop if the model keeps calling tools.
 *
 * The caller (Phase 9b session layer) persists the returned `messages` to
 * `tutor_sessions.messages` so the next user turn resumes mid-transcript.
 */

export const DEFAULT_MAX_ITERATIONS = 10;

export type AssistantContentBlock = Anthropic.ContentBlock;

export type TutorMessage =
  | { role: "user"; content: string | Anthropic.ContentBlockParam[] }
  | { role: "assistant"; content: Anthropic.ContentBlockParam[] };

export interface ToolCallRecord {
  iteration: number;
  toolUseId: string;
  name: string;
  input: unknown;
  result:
    | { ok: true; data: unknown }
    | {
        isError: true;
        errorCategory: string;
        isRetryable: boolean;
        message: string;
      };
}

export interface RunTutorTurnParams {
  topicId: string;
  /** Prior transcript (empty array for a new session). */
  priorMessages: TutorMessage[];
  /** The new user message to append + send. */
  userMessage: string;
  db?: Db;
  maxIterations?: number;
  now?: number;
  /** Override for tests — factory returning a bound tool set. */
  toolSetFactory?: (db: Db) => TutorToolSet;
}

export interface RunTutorTurnResult {
  /** Full updated transcript including the new user turn and all loop activity. */
  messages: TutorMessage[];
  /** Text content of the model's FINAL assistant turn (empty if none). */
  finalAssistantText: string;
  /** Tool invocations executed during this loop, in order. */
  toolCalls: ToolCallRecord[];
  /** Number of assistant turns (1 + tool_use iterations). */
  iterationCount: number;
  /** stop_reason of the final (terminating) assistant response. */
  finalStopReason: string | null;
  /** True if the loop hit maxIterations without an end_turn. */
  reachedIterationCap: boolean;
}

function toAnthropicTool(def: AnyTutorTool): Anthropic.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.inputSchema as Anthropic.Tool["input_schema"],
  };
}

function assistantContentToParam(
  blocks: AssistantContentBlock[],
): Anthropic.ContentBlockParam[] {
  // The SDK's returned ContentBlock is a superset of ContentBlockParam for
  // input; stripping server-only fields (e.g. citations tracking on text blocks)
  // keeps the next request lean.
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use") {
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      };
    }
    // Other block types (thinking, server_tool_use) — pass through structurally.
    return b as unknown as Anthropic.ContentBlockParam;
  });
}

function extractText(blocks: AssistantContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") {
      if (out.length > 0) out += "\n\n";
      out += b.text;
    }
  }
  return out;
}

function buildSystemPrompt(topicId: string, db: Db, now: number): string {
  const cf = buildCaseFacts(topicId, { db, now });
  const promptPath = resolve(process.cwd(), "prompts/tutor.md");
  const tpl = loadPromptFile(promptPath);
  return tpl.render(caseFactsToPromptInputs(cf));
}

/**
 * Execute one tool_use block against the bound tool set. Returns the
 * content-block-shaped tool_result (including is_error=true for errors) plus
 * a record for the caller's audit log.
 */
async function executeToolUse(
  block: Extract<AssistantContentBlock, { type: "tool_use" }>,
  toolSet: TutorToolSet,
  iteration: number,
): Promise<{
  resultBlock: Anthropic.ToolResultBlockParam;
  record: ToolCallRecord;
}> {
  const def = toolSet.byName.get(block.name);
  if (!def) {
    // D2.2 permission category — the model tried to call a tool outside
    // its set. We surface the structured error so the model can correct.
    const err = {
      isError: true as const,
      errorCategory: "permission",
      isRetryable: false,
      message: `tool "${block.name}" is not available to the tutor role`,
    };
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: block.id,
        is_error: true,
        content: JSON.stringify(err),
      },
      record: {
        iteration,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        result: err,
      },
    };
  }

  const validated = def.validateInput(block.input);
  if ("isError" in validated) {
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: block.id,
        is_error: true,
        content: JSON.stringify(validated),
      },
      record: {
        iteration,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        result: validated,
      },
    };
  }

  try {
    const handled = await Promise.resolve(def.handler(validated.value));
    if ("isError" in handled) {
      return {
        resultBlock: {
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: JSON.stringify(handled),
        },
        record: {
          iteration,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          result: handled,
        },
      };
    }
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: block.id,
        content: serializeToolResult(handled),
      },
      record: {
        iteration,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        result: handled,
      },
    };
  } catch (err) {
    const wrapped = {
      isError: true as const,
      errorCategory: "transient",
      isRetryable: true,
      message: err instanceof Error ? err.message : String(err),
    };
    return {
      resultBlock: {
        type: "tool_result",
        tool_use_id: block.id,
        is_error: true,
        content: JSON.stringify(wrapped),
      },
      record: {
        iteration,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        result: wrapped,
      },
    };
  }
}

export async function runTutorTurn(
  params: RunTutorTurnParams,
): Promise<RunTutorTurnResult> {
  const db = params.db ?? getAppDb();
  const maxIter = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const now = params.now ?? Date.now();
  const factory = params.toolSetFactory ?? buildTutorToolSet;
  const toolSet = factory(db);

  const messages: TutorMessage[] = [...params.priorMessages];
  messages.push({ role: "user", content: params.userMessage });

  const toolCalls: ToolCallRecord[] = [];
  let iterationCount = 0;
  let finalStopReason: string | null = null;
  let finalAssistantText = "";
  let reachedIterationCap = false;

  const tools = toolSet.tools.map(toAnthropicTool);

  for (let i = 0; i < maxIter; i++) {
    iterationCount = i + 1;

    const system = buildSystemPrompt(params.topicId, db, now);
    const response = await callClaude({
      role: tutorRole.name,
      system,
      cacheSystem: tutorRole.cacheSystem,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content as Anthropic.MessageParam["content"],
      })),
      tools,
      maxTokens: 2048,
      db,
    });

    const assistantBlocks = response.content as AssistantContentBlock[];
    messages.push({
      role: "assistant",
      content: assistantContentToParam(assistantBlocks),
    });
    finalStopReason = response.stop_reason;
    finalAssistantText = extractText(assistantBlocks);

    // The ONLY control-flow signal is stop_reason (D1.1). We do not parse
    // assistant text for "I'll call the tool" phrases or similar.
    if (response.stop_reason !== "tool_use") {
      return {
        messages,
        finalAssistantText,
        toolCalls,
        iterationCount,
        finalStopReason,
        reachedIterationCap: false,
      };
    }

    const toolUseBlocks = assistantBlocks.filter(
      (b): b is Extract<AssistantContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    );
    if (toolUseBlocks.length === 0) {
      // Defensive: stop_reason=tool_use with no tool_use blocks is malformed.
      // Treat as a terminal response — don't wedge the loop.
      return {
        messages,
        finalAssistantText,
        toolCalls,
        iterationCount,
        finalStopReason,
        reachedIterationCap: false,
      };
    }

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const { resultBlock, record } = await executeToolUse(tu, toolSet, i + 1);
      resultBlocks.push(resultBlock);
      toolCalls.push(record);
    }

    messages.push({
      role: "user",
      content: resultBlocks,
    });

    if (i === maxIter - 1) {
      reachedIterationCap = true;
    }
  }

  return {
    messages,
    finalAssistantText,
    toolCalls,
    iterationCount,
    finalStopReason,
    reachedIterationCap,
  };
}
