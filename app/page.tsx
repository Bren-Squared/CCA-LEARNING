export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">
        CCA Foundations — Learning App
      </h1>
      <p className="max-w-xl text-zinc-600 dark:text-zinc-400">
        Single-user study environment for the Claude Certified Architect
        Foundations exam. Phase 0 bootstrap complete — curriculum ingestion and
        study modalities arrive in later phases.
      </p>
      <a
        className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        href="/api/health"
      >
        /api/health
      </a>
    </main>
  );
}
