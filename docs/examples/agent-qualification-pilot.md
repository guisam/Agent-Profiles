# Worked qualification report: DataSync documentation pilot

This example uses the live October 23, 2026 pilot, not a successful fictional
basic/premium deployment. It shows how the guided flow reports insufficient and
negative evidence without inventing qualification. Raw records are retained on
the pilot owner's machine; run IDs below identify that evidence, not public
download links. See the [pilot guide](../jobbench-pilot.md) for deployment details.

## Decision

**Needs evidence for a service-tier decision. No adoption or routing enabled.**
No basic/premium quality, cost, turnaround or repetition requirements were
accepted for these exploratory runs. Confirmed content defects also remain.
The assistant's next action is to complete the intake with the user, not turn
these observations into a passing tier score.

| Agent / role / host | What was observed | What this establishes |
| --- | --- | --- |
| `gpt-6-luna` / technical-writer / Codex | Four files, approximately 105 seconds; content defects in coordinator review | Baseline feasibility on one task; not qualification |
| `qwen3.8-flash-next-iq2_xs` / technical-writer / Codex | Original baseline completed; a fresh required-skill control completed in approximately 361 seconds; verification candidate timed out at 600 seconds with two partial files | A failed bounded candidate attempt, not an improvement |
| Same Strata verification candidate / same role and host | Fresh candidate-only follow-up completed four files in approximately 691 seconds under a 1,200-second limit | Completion under changed conditions; not a matched equal-budget comparison |

## Gates and gaps

| Gate | Evidence | Decision |
| --- | --- | --- |
| Identity / integrity | Retained task revision, model IDs, captured/exported harnesses, native candidate and hashes; completed runs passed integrity checks | Preparation and runtime feasibility observed within the custom Windows deployment |
| Correctness | Non-blinded coordinator reviews and selected offline code tests; no stock judge or retained native evaluation plan/results for these experiments | Formal qualification needs evidence; known defects must be addressed |
| Fresh repeated coverage | One JobBench task; no repeated frozen held-out/regression suite | Needs evidence |
| Turnaround | Approximate execution times from command/event file timestamps; no queue, retry/review end-to-end service measurement or agreed target | Needs evidence |
| Cost | Subscription and local provider access; no complete charge/resource/review accounting or agreed cost metric | Unknown; no cheaper-agent claim |
| Native promotion eligibility | Isolated advisory candidate exists; no native qualification report/eligibility result for these pilot runs | Unknown; no promotion authorized |

The longer Strata run omitted checked internal issue/SDK markers and passed
selected fake-transport chunking/retry checks. It also marked confirmed
parallel-auth support unknown and used a helper that rejects the sync endpoint's
valid `202` response. Completion does not erase those findings. No numeric pass
rate is inferred from four files, and missing metrics are not zero.

## Retained evidence

- `20261023T181934Z-5edcde`: Luna/Strata available-skill baselines, summaries,
  outputs, exact runner and separate coordinator review.
- `20261023T191152Z-06b1ba`: fresh required-skill Strata control and candidate;
  600-second limit; exact candidate, protocol, runner, review and failed-arm hashes.
- `20261023T212200Z-25fcaa`: explicitly authorized 1,200-second candidate-only
  follow-up, completion summary, review and offline `202`/chunking checks.

The executor was Windows Codex 0.163.0 using a custom launcher and Harness²
`1cfe254e8d25b15f37048c3730134686abe60335`, not the stock Linux JobBench runner.
Per-run application build/revision is unknown in this report; retained runner
hashes identify the custom drivers without attesting the entire source checkout.
Strata emitted fallback model metadata/catalog warnings. Required-skill native
migration changed generated context, so the earlier available-skill baseline
was not reused as the matched control. These limits stay attached to the report.

## Next action

Agree on service gates and budget; prepare a separately identified correction;
then retain a native plan before matched repeated held-out/regression runs for
each model. Generate the complete report from validated native results and
measurement attachments. The user can reject it or explicitly review adoption.
The installed skill, active project assignments and routing remain unchanged.

Return to [Qualify an agent](../agent-qualification.md).

The subsequent [Luna/Sol comparison](luna-sol-qualification.md) completed repeated
task execution and retained native results. It did not establish candidate
improvement and exposed rubric calibration and CSV-format problems.
