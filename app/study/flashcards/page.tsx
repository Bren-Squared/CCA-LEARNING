import Link from "next/link";
import { getAppDb } from "@/lib/db";
import { listDueCards } from "@/lib/study/cards";
import FlashcardReview from "./FlashcardReview";

export const dynamic = "force-dynamic";

export default async function FlashcardsPage() {
  const db = getAppDb();
  const due = listDueCards({ db });

  if (due.length === 0) {
    return (
      <main className="flex flex-1 flex-col items-center px-6 py-12">
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
              Flashcards
            </p>
            <h1 className="text-2xl font-semibold">Nothing due right now</h1>
          </header>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Your review queue is empty. New cards become due as their SM-2
            intervals elapse. Generate a deck from the{" "}
            <Link href="/" className="underline">
              dashboard
            </Link>
            , or come back later.
          </p>
          <Link
            href="/"
            className="self-start rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  // Serialize Date → ms for the client; the client reconstructs from numbers.
  const serializable = due.map((c) => ({
    id: c.id,
    taskStatementId: c.taskStatementId,
    front: c.front,
    back: c.back,
    bloomLevel: c.bloomLevel,
    intervalDays: c.intervalDays,
    dueAt: c.dueAt.getTime(),
    reviewsCount: c.reviewsCount,
  }));

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Flashcards · review queue
          </p>
          <h1 className="text-2xl font-semibold">
            {due.length} card{due.length === 1 ? "" : "s"} due
          </h1>
          <p className="text-xs text-zinc-500">
            SM-2 spaced repetition · grades:{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              1
            </kbd>{" "}
            again ·{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              2
            </kbd>{" "}
            hard ·{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              3
            </kbd>{" "}
            good ·{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              4
            </kbd>{" "}
            easy ·{" "}
            <kbd className="rounded bg-zinc-200 px-1 font-mono dark:bg-zinc-800">
              space
            </kbd>{" "}
            flip
          </p>
        </header>
        <FlashcardReview queue={serializable} />
      </div>
    </main>
  );
}
