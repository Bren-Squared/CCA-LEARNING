"use client";

import { useEffect, useState } from "react";

type Status = {
  apiKeyConfigured: boolean;
  apiKeyRedacted: string | null;
  defaultModel: string;
  cheapModel: string;
  tokenBudgetMonthUsd: number;
  bulkCostCeilingUsd: number;
  reviewHalfLifeDays: number;
};

const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6"];

export default function SettingsForm({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.defaultModel);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    setModel(status.defaultModel);
  }, [status.defaultModel]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {};
      if (apiKey.length > 0) body.apiKey = apiKey;
      if (model !== status.defaultModel) body.defaultModel = model;
      if (Object.keys(body).length === 0) {
        setMessage({ kind: "err", text: "Nothing changed." });
        setPending(false);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as
        | Status
        | { error: string; details?: unknown };
      if (!res.ok) {
        const errText =
          "error" in data
            ? data.error
            : "unexpected response";
        setMessage({ kind: "err", text: errText });
      } else {
        setStatus(data as Status);
        setApiKey("");
        setMessage({ kind: "ok", text: "Settings saved." });
      }
    } catch (err) {
      setMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "request failed",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex w-full max-w-xl flex-col gap-6 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800"
    >
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="api-key">
          Anthropic API key
        </label>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {status.apiKeyConfigured
            ? `Configured — ${status.apiKeyRedacted}. Enter a new key to rotate; leave blank to keep the current one.`
            : "Not set. Your key is stored encrypted on disk and never sent to the browser after this form."}
        </p>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-..."
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="model">
          Default model
        </label>
        <select
          id="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Cheap model (reviewer + bulk): {status.cheapModel}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        {message ? (
          <span
            className={
              message.kind === "ok"
                ? "text-sm text-green-600 dark:text-green-400"
                : "text-sm text-red-600 dark:text-red-400"
            }
          >
            {message.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
