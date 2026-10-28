---
title: "Luna Sol diagnostic: rubric calibration and CSV validation before adoption"
author: Gfw
date: 2026-10-24
touches:
  - docs/examples/luna-sol-qualification.md
---

## Decided
Ran the approved correctness-first Luna/Sol documentation diagnostic using the existing ChatGPT/Codex subscription: two fresh pinned JobBench cases, two trials for each of Luna baseline, Luna verification candidate and Sol reference; 12 task sessions, two file probes and six blind Sol grading sessions. All 20 sessions completed. Native Luna plan/results/report and per-rollout evidence are retained locally; docs/examples/luna-sol-qualification.md records the comparison. Source documentation patch 0.3.1 changes no runtime behavior or configuration schema.

## Tried and ruled out
The generic verification candidate did not establish an improvement: 63/146 original unweighted rubric items versus baseline 64/146 and Sol 75/146; more reported input usage and two malformed CSVs versus one in baseline and none in Sol. Do not adopt it or infer API dollar costs from subscription usage. Native no-regression eligibility remained eligible because both Luna arms had zero all-pass trials; it is not absolute quality qualification. Preserve the raw rubric/grades rather than silently repairing the scoring after seeing outcomes.

## Watch out
Calibrate rubrics against source facts before decision-grade runs. TaskFlow rubric r10 expects no v2 equivalent for comment/history reads while its OpenAPI extract explicitly provides include expansions; other expectations require unspecified CSV category names or unavailable SDK/version/impact details. Add independent structured-output parsing: nonblank CSV rows must match header width, with quoted commas. CLI usage includes repeated cached context; report cached input as a subset, not added tokens or a price. Custom Windows RunRequest uses task_ref, and every rollout ID must include its arm to avoid native identity collisions. Keep the installed skill and existing profile assignments unchanged until separately authorized adoption. Full novice walkthrough, service gates and guarded adoption/restoration remain unproven.
