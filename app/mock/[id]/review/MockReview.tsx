"use client";

import { useMemo, useState } from "react";

export interface ReviewQuestion {
  index: number;
  id: string;
  stem: string;
  options: string[];
  correctIndex: number;
  explanations: string[];
  taskStatementId: string;
  taskStatementTitle: string;
  domainId: string;
  bloomLevel: number;
  selectedIndex: number | null;
  correct: boolean;
}

type OutcomeFilter = "all" | "correct" | "incorrect" | "unanswered";
type DomainFilter = "all" | string;
type BloomFilter = "all" | 1 | 2 | 3 | 4 | 5 | 6;

export default function MockReview({
  questions,
}: {
  questions: ReviewQuestion[];
}) {
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [domain, setDomain] = useState<DomainFilter>("all");
  const [bloom, setBloom] = useState<BloomFilter>("all");

  const domainIds = useMemo(
    () =>
      Array.from(new Set(questions.map((q) => q.domainId).filter(Boolean))).sort(),
    [questions],
  );
  const bloomLevels = useMemo(
    () =>
      Array.from(new Set(questions.map((q) => q.bloomLevel))).sort((a, b) => a - b),
    [questions],
  );

  const filtered = useMemo(
    () =>
      questions.filter((q) => {
        if (domain !== "all" && q.domainId !== domain) return false;
        if (bloom !== "all" && q.bloomLevel !== bloom) return false;
        if (outcome === "correct" && !q.correct) return false;
        if (outcome === "incorrect" && (q.correct || q.selectedIndex === null)) {
          return false;
        }
        if (outcome === "unanswered" && q.selectedIndex !== null) return false;
        return true;
      }),
    [questions, outcome, domain, bloom],
  );

  const stats = useMemo(() => {
    const total = questions.length;
    const correct = questions.filter((q) => q.correct).length;
    const unanswered = questions.filter((q) => q.selectedIndex === null).length;
    return { total, correct, unanswered };
  }, [questions]);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <FilterGroup label="Outcome">
          <FilterChip
            active={outcome === "all"}
            onClick={() => setOutcome("all")}
          >
            All ({stats.total})
          </FilterChip>
          <FilterChip
            active={outcome === "correct"}
            onClick={() => setOutcome("correct")}
          >
            Correct ({stats.correct})
          </FilterChip>
          <FilterChip
            active={outcome === "incorrect"}
            onClick={() => setOutcome("incorrect")}
          >
            Incorrect ({stats.total - stats.correct - stats.unanswered})
          </FilterChip>
          <FilterChip
            active={outcome === "unanswered"}
            onClick={() => setOutcome("unanswered")}
          >
            Unanswered ({stats.unanswered})
          </FilterChip>
        </FilterGroup>
        <FilterGroup label="Domain">
          <FilterChip active={domain === "all"} onClick={() => setDomain("all")}>
            All
          </FilterChip>
          {domainIds.map((d) => (
            <FilterChip
              key={d}
              active={domain === d}
              onClick={() => setDomain(d)}
            >
              {d}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup label="Bloom">
          <FilterChip active={bloom === "all"} onClick={() => setBloom("all")}>
            All
          </FilterChip>
          {bloomLevels.map((b) => (
            <FilterChip
              key={b}
              active={bloom === b}
              onClick={() => setBloom(b as BloomFilter)}
            >
              L{b}
            </FilterChip>
          ))}
        </FilterGroup>
      </div>

      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Showing {filtered.length} of {questions.length} questions.
      </p>

      <ul className="flex flex-col gap-3">
        {filtered.map((q) => (
          <QuestionCard key={q.id} q={q} />
        ))}
      </ul>
    </section>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 text-zinc-500 dark:text-zinc-400">{label}:</span>
      {children}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs transition ${
        active
          ? "bg-indigo-600 text-white"
          : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

function QuestionCard({ q }: { q: ReviewQuestion }) {
  const outcomeBadge = q.correct
    ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
    : q.selectedIndex === null
      ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";

  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-mono">Q{q.index + 1}</span>
          <span>·</span>
          <span>{q.domainId}</span>
          <span>·</span>
          <span>{q.taskStatementId}</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] dark:bg-zinc-800">
            L{q.bloomLevel}
          </span>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${outcomeBadge}`}
        >
          {q.correct
            ? "correct"
            : q.selectedIndex === null
              ? "unanswered"
              : "incorrect"}
        </span>
      </header>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{q.stem}</p>
      <ol className="mt-3 flex flex-col gap-1.5 text-sm">
        {q.options.map((opt, i) => {
          const isCorrect = i === q.correctIndex;
          const isSelected = i === q.selectedIndex;
          const base =
            "flex items-start gap-3 rounded-md border px-3 py-2 text-left";
          let color = "border-zinc-200 dark:border-zinc-800";
          if (isCorrect) {
            color =
              "border-green-500 bg-green-50 dark:border-green-700 dark:bg-green-950/30";
          } else if (isSelected) {
            color =
              "border-red-500 bg-red-50 dark:border-red-700 dark:bg-red-950/30";
          }
          return (
            <li key={i} className={`${base} ${color}`}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {i + 1}
              </span>
              <span className="flex-1">
                <span className="whitespace-pre-wrap">{opt}</span>
                {q.explanations[i] ? (
                  <span className="mt-1 block text-xs text-zinc-600 dark:text-zinc-400">
                    {q.explanations[i]}
                  </span>
                ) : null}
              </span>
              {isCorrect ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-green-700 dark:text-green-400">
                  correct
                </span>
              ) : isSelected ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-red-700 dark:text-red-400">
                  your pick
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </li>
  );
}
