"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TutorMessage } from "@/lib/tutor/loop";

interface ToolCallSummary {
  iteration: number;
  name: string;
  isError: boolean;
}

interface TurnResponse {
  sessionId: string;
  topicId: string;
  finalAssistantText: string;
  finalStopReason: string | null;
  iterationCount: number;
  reachedIterationCap: boolean;
  toolCalls: ToolCallSummary[];
  messageCount: number;
  updatedAt: string;
}

interface TurnRecord {
  toolCalls: ToolCallSummary[];
  iterationCount: number;
  finalStopReason: string | null;
  reachedIterationCap: boolean;
}

/**
 * A compact render of the Claude-SDK transcript. We flatten the messages into
 * display turns so tool_use / tool_result pairs render as a single strip,
 * and long assistant text blocks keep formatting. OD5: block-at-a-time — we
 * only update the view when a turn completes (no token streaming).
 */

interface DisplayBlock {
  key: string;
  kind: "user-text" | "assistant-text" | "tool-strip";
  text?: string;
  tools?: Array<{ id: string; name: string; isError: boolean }>;
}

function flatten(messages: TutorMessage[]): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  messages.forEach((m, mi) => {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({
          key: `m${mi}-u`,
          kind: "user-text",
          text: m.content,
        });
      } else {
        // tool_result carrier — summarize as a tool strip
        const tools = m.content
          .filter(
            (b): b is Extract<typeof b, { type: "tool_result" }> =>
              (b as { type?: string }).type === "tool_result",
          )
          .map((b, bi) => ({
            id: `${mi}-${bi}`,
            name: "tool_result",
            isError: Boolean(b.is_error),
          }));
        if (tools.length > 0) {
          out.push({
            key: `m${mi}-tr`,
            kind: "tool-strip",
            tools,
          });
        }
      }
      return;
    }
    // assistant
    const textParts: string[] = [];
    const tools: Array<{ id: string; name: string; isError: boolean }> = [];
    m.content.forEach((b, bi) => {
      const t = (b as { type?: string }).type;
      if (t === "text") {
        const tb = b as { type: "text"; text: string };
        if (tb.text) textParts.push(tb.text);
      } else if (t === "tool_use") {
        const tu = b as { type: "tool_use"; id: string; name: string };
        tools.push({ id: `${mi}-${bi}-${tu.id}`, name: tu.name, isError: false });
      }
    });
    if (textParts.length > 0) {
      out.push({
        key: `m${mi}-at`,
        kind: "assistant-text",
        text: textParts.join("\n\n"),
      });
    }
    if (tools.length > 0) {
      out.push({
        key: `m${mi}-au`,
        kind: "tool-strip",
        tools,
      });
    }
  });
  return out;
}

export default function TutorChat({
  sessionId,
  topicId,
  initialMessages,
}: {
  sessionId: string;
  topicId: string;
  initialMessages: TutorMessage[];
}) {
  const [messages, setMessages] = useState<TutorMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTurn, setLastTurn] = useState<TurnRecord | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const blocks = useMemo(() => flatten(messages), [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks.length, submitting]);

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);

    // Optimistic: show the user message immediately.
    const optimistic: TutorMessage = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");

    try {
      const res = await fetch(
        `/api/tutor/sessions/${encodeURIComponent(sessionId)}/turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userMessage: trimmed }),
        },
      );
      const body: TurnResponse | { error: string; settings_url?: string } =
        await res.json().catch(() => ({ error: "bad response" }));
      if (!res.ok) {
        const msg = "error" in body ? body.error : `turn failed (${res.status})`;
        throw new Error(msg);
      }
      const turn = body as TurnResponse;
      setLastTurn({
        toolCalls: turn.toolCalls,
        iterationCount: turn.iterationCount,
        finalStopReason: turn.finalStopReason,
        reachedIterationCap: turn.reachedIterationCap,
      });
      // Fetch the authoritative transcript so we render the real tool_use
      // + tool_result blocks (not a synthesized view).
      const sres = await fetch(
        `/api/tutor/sessions/${encodeURIComponent(sessionId)}`,
        { cache: "no-store" },
      );
      if (sres.ok) {
        const sbody = (await sres.json()) as { messages: TutorMessage[] };
        setMessages(sbody.messages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      // Roll back the optimistic message on error.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.role === "user" &&
          typeof last.content === "string" &&
          last.content === trimmed
        ) {
          return prev.slice(0, -1);
        }
        return prev;
      });
      setInput(trimmed);
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div
        ref={scrollRef}
        className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
      >
        {blocks.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No messages yet. Send a first prompt — something like &ldquo;quiz
            me on {topicId} at L1&rdquo;.
          </p>
        ) : (
          blocks.map((b) => <DisplayRow key={b.key} block={b} />)
        )}
        {submitting && (
          <p className="text-xs text-zinc-500">Tutor is thinking…</p>
        )}
      </div>

      {lastTurn && (
        <div className="flex flex-wrap items-baseline gap-3 rounded-md border border-zinc-200 px-3 py-2 font-mono text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          <span>
            iterations <strong>{lastTurn.iterationCount}</strong>
          </span>
          <span>
            stop_reason{" "}
            <strong
              className={
                lastTurn.finalStopReason === "end_turn"
                  ? "text-green-700 dark:text-green-400"
                  : "text-amber-700 dark:text-amber-400"
              }
            >
              {lastTurn.finalStopReason ?? "—"}
            </strong>
          </span>
          <span>
            tool calls <strong>{lastTurn.toolCalls.length}</strong>
          </span>
          {lastTurn.reachedIterationCap && (
            <span className="text-red-600 dark:text-red-400">
              hit iteration cap
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the tutor… (⌘/Ctrl+Enter to send)"
          rows={3}
          className="w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-100"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-zinc-500">
            {error ? (
              <span className="text-red-600 dark:text-red-400">{error}</span>
            ) : (
              <>Turn drives the agentic loop — may run multiple tool calls.</>
            )}
          </span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || submitting}
            className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {submitting ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}

function DisplayRow({ block }: { block: DisplayBlock }) {
  if (block.kind === "user-text") {
    return (
      <div className="flex flex-col gap-1 self-end max-w-[85%]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          you
        </span>
        <div className="whitespace-pre-wrap rounded-xl bg-indigo-600 px-3 py-2 text-sm text-white">
          {block.text}
        </div>
      </div>
    );
  }
  if (block.kind === "assistant-text") {
    return (
      <div className="flex flex-col gap-1 max-w-[85%]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          tutor
        </span>
        <div className="whitespace-pre-wrap rounded-xl bg-zinc-100 px-3 py-2 text-sm text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
          {block.text}
        </div>
      </div>
    );
  }
  // tool-strip
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-zinc-500">
      <span className="uppercase tracking-wider">tool</span>
      {block.tools?.map((t) => (
        <span
          key={t.id}
          className={
            t.isError
              ? "rounded-full bg-red-100 px-2 py-0.5 text-red-800 dark:bg-red-950/40 dark:text-red-300"
              : "rounded-full bg-zinc-200 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          }
        >
          {t.name}
          {t.isError ? " · error" : ""}
        </span>
      ))}
    </div>
  );
}
