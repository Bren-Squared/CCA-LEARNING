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
  const [halfLife, setHalfLife] = useState(initial.reviewHalfLifeDays);
  const [ceiling, setCeiling] = useState(initial.bulkCostCeilingUsd);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    setModel(status.defaultModel);
    setHalfLife(status.reviewHalfLifeDays);
    setCeiling(status.bulkCostCeilingUsd);
  }, [status.defaultModel, status.reviewHalfLifeDays, status.bulkCostCeilingUsd]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {};
      if (apiKey.length > 0) body.apiKey = apiKey;
      if (model !== status.defaultModel) body.defaultModel = model;
      if (halfLife !== status.reviewHalfLifeDays)
        body.reviewHalfLifeDays = halfLife;
      if (ceiling !== status.bulkCostCeilingUsd)
        body.bulkCostCeilingUsd = ceiling;
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

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="half-life">
          Review intensity{" "}
          <span className="font-mono text-xs text-zinc-500">
            ({halfLife.toFixed(0)}-day half-life)
          </span>
        </label>
        <input
          id="half-life"
          type="range"
          min={3}
          max={60}
          step={1}
          value={halfLife}
          onChange={(e) => setHalfLife(Number(e.target.value))}
          className="accent-zinc-900 dark:accent-zinc-100"
        />
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Shorter = recent answers weigh more; you re-review topics more often.
          Longer = older wins stay on the books longer.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="ceiling">
          Bulk cost ceiling{" "}
          <span className="font-mono text-xs text-zinc-500">
            (${ceiling.toFixed(2)} / batch)
          </span>
        </label>
        <input
          id="ceiling"
          type="range"
          min={0}
          max={10}
          step={0.25}
          value={ceiling}
          onChange={(e) => setCeiling(Number(e.target.value))}
          className="accent-zinc-900 dark:accent-zinc-100"
        />
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Question generation and other bulk jobs will pause for confirmation
          if the projected cost exceeds this ceiling.
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
