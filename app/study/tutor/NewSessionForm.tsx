"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

interface TaskStatementOption {
  id: string;
  title: string;
  domainId: string;
}

export default function NewSessionForm({
  taskStatements,
}: {
  taskStatements: TaskStatementOption[];
}) {
  const router = useRouter();
  const [topicId, setTopicId] = useState<string>(taskStatements[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const byDomain = new Map<string, TaskStatementOption[]>();
    for (const t of taskStatements) {
      const bucket = byDomain.get(t.domainId) ?? [];
      bucket.push(t);
      byDomain.set(t.domainId, bucket);
    }
    return Array.from(byDomain.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [taskStatements]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!topicId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/tutor/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `start failed (${res.status})`);
      }
      router.push(`/study/tutor/${encodeURIComponent(body.sessionId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setSubmitting(false);
    }
  }

  if (taskStatements.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No task statements seeded yet. Run the seed script first.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">Topic</span>
        <select
          value={topicId}
          onChange={(e) => setTopicId(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          {grouped.map(([domainId, items]) => (
            <optgroup key={domainId} label={domainId}>
              {items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} — {t.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!topicId || submitting}
          className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitting ? "Starting…" : "Start session"}
        </button>
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </form>
  );
}
