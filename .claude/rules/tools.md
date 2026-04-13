---
paths: ["lib/claude/tools/**/*.ts"]
---

# Tool Schema Conventions

All tool definitions under `lib/claude/tools/` extend the shared base types in `lib/claude/tools/base.ts`. These rules load automatically when editing any tool file.

## 1. Detailed description (D2.1)

The `description` field must explicitly differentiate this tool from siblings.

- Bad: `"Records a grade."`
- Good: `"Records the final rubric grade for a scenario free-response attempt and writes a progress event at the prompt's target Bloom level. Does NOT evaluate the candidate answer — that is done by the grader prompt before this tool is called. Callers must have already produced the { score, strengths[], gaps[], model_answer } payload."`

Describe *when* to call, *when not to*, and *what contract* the tool enforces.

## 2. Mandatory structured error shape (D2.2, AT19)

Every tool returns either a success payload or:

```ts
{
  isError: true,
  errorCategory: 'transient' | 'validation' | 'business' | 'permission',
  isRetryable: boolean,
  message: string,
}
```

No bare error strings. No undifferentiated failures. Callers branch on `errorCategory` and honor `isRetryable`.

## 3. Narrow tool distribution per role (D2.3)

Each role (`tutor`, `grader`, `generator`, `reviewer`) gets only the tools it needs. Do not add a tool to a role's set "just in case." Prefer a new purpose-built tool over widening an existing one. The grader, in particular, must never be handed tutor or generator tools (AT17).

## 4. Zod input schemas

Tool inputs are defined as `zod` schemas and exported for reuse — type inference, test fixtures, and API route validation all pull from the same source.

## Rationale

Domain 2 of the CCA Foundations exam tests exactly these conventions. Enforcing them via a path rule turns every tool-file edit into a reinforcement opportunity.
