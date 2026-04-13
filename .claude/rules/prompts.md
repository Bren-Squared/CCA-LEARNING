---
paths: ["prompts/**/*.md"]
---

# Prompt File Conventions

Files under `prompts/` are Claude prompt templates versioned with the app (NFR6.2). These rules load automatically when editing any `prompts/**/*.md` file.

## Required frontmatter

Every prompt file begins with:

```yaml
---
id: <kebab-case-id>             # Stable identifier; changing this is a breaking change for callers
version: <integer>              # Bump on every functional change (no semver — integers are simpler here)
inputs:
  - <name>: <short description>
outputs:
  - <name>: <short description>
notes: <optional — e.g., linked tool schema>
---
```

## Body rules

- **One prompt per file.** Do not concatenate multiple unrelated prompts.
- **Extract duplication.** If a snippet repeats across prompts, move it to `prompts/_shared/` and reference it.
- **Be explicit, not hedging (D4.1).** Use concrete criteria; avoid "be conservative" or "high-confidence" language.
- **Link structured-output schemas.** If the prompt relies on a tool schema, reference the matching file in `lib/claude/tools/` in a `notes:` line — keeps schema and prompt in sync.

## Rationale

Centralizing prompts here satisfies NFR6.2: prompts are tunable without feature-code surgery. Integer versioning enables cheap diff and rollback independent of code. Domain 4 of the exam tests exactly these habits.
