import { getAppDb } from "@/lib/db";
import { getSettingsStatus } from "@/lib/settings";
import { countDueCards } from "@/lib/study/cards";
import NavTab from "./NavTab";

export default async function AppNav() {
  const db = getAppDb();
  const status = getSettingsStatus(db);

  if (!status.apiKeyConfigured) return null;

  const dueFlashcards = countDueCards({ db });

  return (
    <nav className="sticky top-0 z-40 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-4">
        {/* Brand */}
        <NavTab href="/" label="CCA Foundations" exact />

        {/* Separator */}
        <span className="mx-1 h-4 w-px shrink-0 bg-zinc-200 dark:bg-zinc-800" />

        {/* Study */}
        <NavTab href="/drill" label="Drill" />
        <NavTab href="/study/tutor" label="Tutor" />
        <NavTab href="/study/scenarios" label="Scenarios" />
        <NavTab href="/study/exercises" label="Exercises" />
        <NavTab href="/study/flashcards" label="Flashcards" badge={dueFlashcards} />
        <NavTab href="/mock" label="Mock Exam" />

        {/* Separator */}
        <span className="mx-1 h-4 w-px shrink-0 bg-zinc-200 dark:bg-zinc-800" />

        {/* Admin / utility */}
        <NavTab href="/admin/coverage" label="Coverage" />
        <NavTab href="/spend" label="Spend" />
        <NavTab href="/shortcuts" label="Shortcuts" />
        <NavTab href="/settings" label="Settings" />

        {/* Status pill — pushed right */}
        <span className="ml-auto shrink-0 whitespace-nowrap pl-3 text-xs text-green-700 dark:text-green-400">
          {status.apiKeyRedacted} · {status.defaultModel}
        </span>
      </div>
    </nav>
  );
}
