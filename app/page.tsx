import Link from "next/link";
import { getAppDb } from "@/lib/db";
import { getSettingsStatus } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function Home() {
  const status = getSettingsStatus(getAppDb());
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">
        CCA Foundations — Learning App
      </h1>
      <p className="max-w-xl text-zinc-600 dark:text-zinc-400">
        Single-user study environment for the Claude Certified Architect
        Foundations exam.
      </p>
      {status.apiKeyConfigured ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-green-700 dark:text-green-400">
            API key configured ({status.apiKeyRedacted}). Default model:{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
              {status.defaultModel}
            </code>
            .
          </p>
          <div className="flex gap-3">
            <Link
              href="/settings"
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Settings
            </Link>
            <a
              href="/api/claude/hello"
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Smoke test
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="max-w-md text-sm text-amber-700 dark:text-amber-400">
            First run — add your Anthropic API key to enable Claude-powered
            features.
          </p>
          <Link
            href="/settings"
            className="rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Set up API key
          </Link>
        </div>
      )}
    </main>
  );
}
