---
description: Ingest the CCA Foundations Exam Guide PDF into the curriculum database (FR1). Idempotent — safe to re-run when the guide is updated.
---

!npm run ingest

After the ingester completes, verify the output counts match AT1:

- 5 domains
- 30 task statements
- 6 scenarios
- 12 seed questions
- 4 preparation exercises

If any count is off, stop and investigate — do not re-run with different flags.
