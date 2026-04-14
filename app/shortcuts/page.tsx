import Link from "next/link";

export const metadata = {
  title: "Keyboard shortcuts · CCA Foundations",
};

type Binding = { keys: string[]; action: string };
type Group = { title: string; subtitle: string; bindings: Binding[] };

const GROUPS: Group[] = [
  {
    title: "Mock exam",
    subtitle: "Timed 40-question run · /mock",
    bindings: [
      { keys: ["←"], action: "Previous question" },
      { keys: ["→"], action: "Next question" },
      { keys: ["1", "2", "3", "4"], action: "Pick option A – D" },
      { keys: ["0", "Backspace"], action: "Clear current answer" },
    ],
  },
  {
    title: "Drill",
    subtitle: "Untimed single-topic practice · /drill",
    bindings: [
      { keys: ["A", "B", "C", "D"], action: "Pick option" },
      { keys: ["Enter"], action: "Submit (answering) / advance (reviewing)" },
      { keys: ["Esc"], action: "End drill early" },
    ],
  },
  {
    title: "Flashcards",
    subtitle: "Spaced-review queue · /study/flashcards",
    bindings: [
      { keys: ["Space"], action: "Flip card" },
      { keys: ["1"], action: "Again (once flipped)" },
      { keys: ["2"], action: "Hard" },
      { keys: ["3"], action: "Good" },
      { keys: ["4"], action: "Easy" },
    ],
  },
  {
    title: "Tutor chat",
    subtitle: "Task-statement deep-dive · /study/tutor/[id]",
    bindings: [
      { keys: ["⌘", "Enter"], action: "Send message (macOS)" },
      { keys: ["Ctrl", "Enter"], action: "Send message (Windows / Linux)" },
    ],
  },
];

function Kbd({ label }: { label: string }) {
  return (
    <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-zinc-300 bg-white px-2 py-0.5 font-mono text-xs text-zinc-700 shadow-[0_1px_0_rgba(0,0,0,0.08)] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
      {label}
    </kbd>
  );
}

export default function ShortcutsPage() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <Link
            href="/"
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            ← Dashboard
          </Link>
          <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">
            Keyboard reference · NFR5.2
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Every keybind, in one place
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Shortcuts are disabled while the focus is inside an input, textarea,
            or select so you can type freely. Everywhere else, the keys below
            take priority.
          </p>
        </header>

        {GROUPS.map((g) => (
          <section
            key={g.title}
            className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
          >
            <div className="flex flex-col">
              <h2 className="text-sm font-mono uppercase tracking-widest text-zinc-500">
                {g.title}
              </h2>
              <p className="text-xs text-zinc-500">{g.subtitle}</p>
            </div>
            <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
              {g.bindings.map((b) => (
                <li
                  key={b.action}
                  className="flex items-center justify-between gap-4 py-2 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-1">
                    {b.keys.map((k, i) => (
                      <span key={`${b.action}-${k}-${i}`} className="flex items-center gap-1">
                        <Kbd label={k} />
                        {i < b.keys.length - 1 ? (
                          <span className="text-xs text-zinc-400">
                            {b.keys.length === 2 &&
                            (b.keys[0] === "⌘" || b.keys[0] === "Ctrl")
                              ? "+"
                              : "/"}
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {b.action}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 p-5 text-xs text-zinc-500 dark:border-zinc-700">
          <p>
            Found a binding that&apos;s undocumented or broken? This page is the
            source of truth — grep the codebase for <code className="font-mono">onKeyDown</code>{" "}
            / <code className="font-mono">window.addEventListener(&quot;keydown&quot;</code>{" "}
            and compare.
          </p>
        </section>
      </div>
    </main>
  );
}
