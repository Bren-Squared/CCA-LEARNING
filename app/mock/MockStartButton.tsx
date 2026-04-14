"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function MockStartButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onStart() {
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/mock", { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      const body = (await resp.json()) as { attempt: { id: string } };
      router.push(`/mock/${body.attempt.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onStart}
        disabled={submitting}
        className="self-start rounded-md bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Allocating…" : "Start mock exam"}
      </button>
      {error ? (
        <p className="text-xs text-red-700 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
