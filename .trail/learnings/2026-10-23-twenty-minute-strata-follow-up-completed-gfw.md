---
title: Twenty-minute Strata follow-up completed but content defects remain
author: Gfw
date: 2026-10-23
---

## Decided
The user explicitly requested a fresh twenty-minute follow-up for the same Strata verification candidate. Kept the 600-second attempt failed and unchanged; the 1200-second override lives only in a retained candidate-only experiment driver. Run 20261023T212200Z-25fcaa completed all four documents in approximately 691 seconds with unchanged source/reference/harness checks and verified output hashes. Same candidate stamp 0848811098f86df16b3e82f9582f729f56f7ed2ff472bafce055a7e3716bae5f; installed skill and default pilot timeout unchanged.

## Tried and ruled out
More time was sufficient for completion in this fresh attempt, but not for adoption. All four files omitted known forbidden internal issue/SDK markers, and selected offline tests preserved 0/1/1000/1001 records and retried the same chunk after 429. A separate fake-response test confirmed the migration helper raises an error on the sync endpoint's valid 202 response. Documents also mislabeled confirmed parallel-auth support as unknown and still guessed a legacy header and signature format. No real API calls were made by the example checks.

## Watch out
Budget experiments are permitted when explicitly requested; preserve their changed conditions and never relabel the old timeout or claim a newly matched same-budget comparison. Completion is separate from correctness. Internal technical notes remain factual evidence even when their private identifiers should be omitted. Keep this candidate unadopted; no stock judge, held-out qualification, native evaluation eligibility results or promotion occurred. Source patch 0.2.2 records the follow-up without application/schema changes.
