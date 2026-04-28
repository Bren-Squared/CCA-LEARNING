# Lessons Learned

Per `CLAUDE.md` §3 (Self-Improvement Loop):

- After any correction from the user, append the pattern below.
- Write a rule for future-self that prevents the same mistake.
- Review this file at the start of every session.

Format for each entry:

```
## <short title>
**Date:** YYYY-MM-DD
**Trigger:** What the user corrected or confirmed.
**Rule:** The behavior change for future work.
**Why:** The underlying reason (incident, preference, principle).
```

---

## Always use `drizzle-kit generate` for new migrations
**Date:** 2026-04-26
**Trigger:** Hand-wrote `drizzle/0008_*.sql`, `0009_*.sql`, `0010_*.sql` for Phases 15–17. Tests passed (the test harness reads every `.sql` file directly), but `npx tsx scripts/backfill-bullet-coverage.ts` against the live `data/app.sqlite` failed with `no such column: knowledge_bullet_idxs`.
**Rule:** Never hand-write Drizzle migration SQL. Always run `npx drizzle-kit generate` after a schema change. The tool writes both the SQL file AND the matching entry in `drizzle/meta/_journal.json` plus the `NNNN_snapshot.json`. Drizzle's runtime migrator (`migrate()` in `drizzle-orm/better-sqlite3/migrator`) only applies migrations listed in the journal.
**Why:** Without a journal entry, `getAppDb()` thinks all migrations are already applied — the new SQL file is invisible to it. Tests don't catch this because the test harness in `tests/*.test.ts` reads every `*.sql` file directly to seed the in-memory DB; only a real run against the production SQLite file surfaces the gap.
**How to apply:** Whenever you edit `lib/db/schema.ts`, your next command is `npx drizzle-kit generate`. Inspect the generated SQL, run `npm test` to verify, and commit both the `.sql` file AND `drizzle/meta/_journal.json` + the new `NNNN_snapshot.json`.
