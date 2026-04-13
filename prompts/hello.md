---
id: hello
version: 1
inputs: [name]
outputs: [greeting]
description: Smoke-test prompt used by /api/claude/hello to verify end-to-end wiring.
---
Reply with exactly one short sentence greeting {{name}}. No preamble, no emoji.
