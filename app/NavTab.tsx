"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavTab({
  href,
  label,
  exact,
  badge,
}: {
  href: string;
  label: string;
  exact?: boolean;
  badge?: number;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm transition-colors ${
        active
          ? "text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      {label}
      {badge != null && badge > 0 ? (
        <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white">
          {badge}
        </span>
      ) : null}
      {active ? (
        <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-zinc-900 dark:bg-zinc-100" />
      ) : null}
    </Link>
  );
}
