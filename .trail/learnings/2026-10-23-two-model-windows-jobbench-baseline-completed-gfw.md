---
title: Two-model Windows JobBench baseline completed with content findings
author: Gfw
date: 2026-10-23
---

## Decided
The corrected Windows Codex launcher completed JobBench technical_writers/task1 for both gpt-6-luna (ChatGPT subscription) and local qwen3.8-flash-next-iq2_xs in run 20261023T181934Z-5edcde. Both native shell-read preflights passed, both sets of four outputs passed unchanged-input/harness and output-hash checks, and the exact runner source was retained with its recorded hash. Approximate task wall times were 105 and 524 seconds; output sizes 26,337 and 88,465 bytes. These are not token metrics.

## Tried and ruled out
A coordinator rubric-guided review was saved separately as review.md without modifying the original completed-ungraded summary or solver outputs. No stock JobBench judge or new paid API key was used. Both outputs invented legacy-header examples. Luna missed a records pagination constraint and usage endpoint version attribution. Strata additionally contradicted dual auth, exposed internal issue IDs, invented validation behavior, and supplied bulk code that silently slices away records over the limit.

## Watch out
This validates one custom Windows baseline adapter path, not the stock Linux runner, tuned-skill improvement, global skill isolation, token savings, or a general model ranking. Strata still emitted fallback metadata/catalog warnings. Issue 33 needs baseline/candidate pairing and fresh held-out qualification before claiming skill improvement; do not promote or close it from this baseline alone.
