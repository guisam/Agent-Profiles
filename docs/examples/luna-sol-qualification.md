# Luna versus Sol: documentation evaluation

## Decision

**Needs evidence for adoption. Keep the verification candidate unadopted.**
The October 23, 2026 comparison completed, but this generic verification addition
did not demonstrate improved Luna performance or parity with Sol. It also exposed
rubric problems that must be addressed before making a service-tier decision.
No additional model runs, skill installation or routing changes were performed.

This is a subsequent diagnostic in the [qualification workflow](../agent-qualification.md),
following the [DataSync pilot](agent-qualification-pilot.md). It is not production
qualification or an official JobBench leaderboard result.

## What ran

The accepted direction was correctness first, using the existing ChatGPT/Codex
subscription, with OpenAI models while Anthropic access was unavailable. No
API-key billing fallback was used. Production quality, turnaround and cost gates
remain undecided.

- Role and host: `technical-writer` on Windows Codex 0.163.0, Node 24.20.0.
- Arms: `gpt-6-luna` baseline, the same model with a frozen verification-skill
  candidate, and `gpt-6.1-sol` with the baseline skill as a reference.
- Cases: fresh JobBench technical-writer task2, a Petstore migration/reference/
  impact-analysis task; and task3, a TaskFlow documentation reconciliation task.
- Coverage: two trials per case per arm, twelve task sessions at 600 seconds
  each maximum; two successful file-read probes; six Sol grading sessions at
  360 seconds each maximum. Exactly twenty Codex sessions, with no retries.
- Conditions: low reasoning effort, sequential task order shuffled with seed 0,
  identical supplied style references, no live web search. Both baseline
  harness exports were byte-identical. Required-skill loading was used throughout.

The candidate added generic directions to verify facts and examples, distinguish
unknown formats from confirmed facts, avoid private identifiers, process every
input, and cross-check documents. Its bytes were frozen before downloading these
cases. No task-specific answers were added. Only the skill and its generated
primary-instruction copy differed from the matched Luna baseline.

## Observations

All twelve task trials produced the expected files: 48 deliverables in total.
Original inputs and exported harnesses passed unchanged-input checks. None timed
out. Completion is separate from correctness.

The following are **unweighted counts of original rubric items satisfied**,
not accuracy percentages or official weighted JobBench scores. Each task2 trial
had 32 atomic criteria; each task3 trial had 41. Trial order below is 1, then 2.

| Arm | Petstore items | TaskFlow items | Total items | Mean execution | CSV shape checks |
| --- | --- | --- | --- | --- | --- |
| Luna baseline | 12/32, 11/32 | 20/41, 21/41 | 64/146 | 101.0 s | 3/4 passed |
| Luna verification candidate | 12/32, 13/32 | 20/41, 18/41 | 63/146 | 104.5 s | 2/4 passed |
| Sol reference | 16/32, 18/32 | 21/41, 20/41 | 75/146 | 292.9 s | 4/4 passed |

Every arm had zero all-pass trials out of four. The candidate gained two rubric
items across Petstore trials and lost three across TaskFlow trials. These small
counts do not establish an improvement or a general model ranking.

Independent format checks found inconsistent nonblank row widths in the Luna
baseline's first TaskFlow CSV, and in the candidate's first Petstore and first
TaskFlow CSVs. For example, a candidate Petstore file had a ten-column header
with twelve- and thirteen-field rows. Blank lines were ignored. These are actual
machine-readable deliverable defects, separate from disputed rubric judgments.
All six TaskFlow style guides exceeded 1,500 whitespace-separated tokens in their
Markdown; this was not a prose-only word-count audit. Output hashes were verified
again after execution. The installed documentation skill remained unchanged.

Execution time measures CLI launch through exit, including its tool work and
authentication check; it excludes preparation, queueing and coordinator/grader
review. Luna was faster on these cases, but no service latency target was tested.

| Arm, four task sessions | Reported input tokens | Cached input, included at left | Output tokens |
| --- | --- | --- | --- |
| Luna baseline | 1,125,004 | 948,096 | 48,149 |
| Luna candidate | 1,611,783 | 1,430,400 | 46,475 |
| Sol reference | 1,325,595 | 1,175,680 | 54,268 |

These are CLI `turn.completed` usage totals, including repeated context across
tool turns. They exclude probes and graders. Cached input is not added twice;
reasoning output is not added again to output tokens. They are not unique prompt
sizes, subscription charges or dollar costs. The candidate did not demonstrate
input-token savings. Monetary and end-to-end service costs remain unknown.

## Judge calibration findings

Six fresh Sol sessions graded two anonymized samples each using the original
atomic rubrics. Samples carried no arm labels or candidate instructions. Solver
workspaces were not supplied rubrics. Every grade supplied a boolean and specific
evidence for every criterion, and grading inputs passed unchanged-input checks.
This was a custom subscription-backed judge, not the stock JobBench judge.

Coordinator spot checks confirmed missing migration example pairs and the CSV
defects. They also found reasons **not to treat the raw counts as decision-grade
quality evidence**:

- Petstore SDK criteria request affected/minimum versions despite missing exact
  SDK versions in the supplied sources. Some quantitative-priority expectations
  also penalize explicit unknowns for rows without supplied endpoint metrics.
- TaskFlow criteria penalize category names that are not specified in the task
  prompt, even when the underlying discrepancy is identified.
- TaskFlow criteria `r10.c1` and `r10.c2` expect no direct v2 equivalent for legacy
  comment/history reads. The supplied OpenAPI extract, lines 109–114, explicitly
  declares `include` expansions for comments and history. A penalty for documenting
  those expansions is not reliable evidence of incorrect migration advice.

The original [pinned dataset](https://huggingface.co/datasets/JobBench/job-bench/tree/d43a66575635da0d3f6cb9a20976dc1a60f3ffc9/dataset/technical_writers)
and grades are preserved. No criteria were silently changed or rescored after
seeing the outputs. This review was selective, not a human audit of all 438
criterion decisions. A Sol judge can introduce bias toward Sol even with blinded
sample names; two cases and two trials do not establish statistical equivalence.

## Native records and reproducibility

The native Luna plan was retained before model calls. Native results were
converted with rollout sidecars and imported successfully. The resulting report
says `eligible`, with no all-pass regressions: both Luna arms passed zero of two
trials on each case. This comparison gate does not detect a meaningful gain,
certify quality, or authorize adoption. Its evidence labels remain:
integrity `verified`, correctness `external-claim`, runtime `unverified`, promotion
`not-authorized`. Native cost/token metrics remain null; measured CLI observations
are a separate attachment. Sol is a reference arm, not a Sol candidate migration.

| Record | Identity |
| --- | --- |
| Run, UTC | `20261024T000108Z` (October 23 Pacific) |
| Harness² revision | `1cfe254e8d25b15f37048c3730134686abe60335` |
| JobBench revision | `d43a66575635da0d3f6cb9a20976dc1a60f3ffc9` |
| Candidate / release | `luna-writer-verification-v2` / `1.0.2` |
| Candidate skill SHA-256 | `131e60c2d06cab6358e780e0a4b9a96ba14779fdc0b6b6106f5d39a5bc54206c` |
| Candidate stamp | `0ba68a66874c81f7ad9d548fd66a90c52f5bae9a9fabfb6a3f75e3141f89c9e7` |
| Plan | `luna-sol-verification-plan` |
| Plan digest | `fcb6dafd6b0860019fab701ec8d55d35176239f0bfa476a223b0e366d1e47c54` |
| Results | `luna-sol-results-20261024t000108z` |
| Result digest | `6842875e0f41c89ba96a131ce45536512b6c909b23039b0b205fc51b4955b3a8` |

Raw evidence is local to the pilot owner under
`%LOCALAPPDATA%\AgentProfiles\evaluations\luna-sol-qualification-20261023`.
It includes `protocol.md`, `candidate-freeze.json`, original asset manifests,
`preparations/7c183cde0cd4/prepared.json` and the native store, plus
`runs/20261024T000108Z/summary.json`, exact runner copies, CLI events, commands,
output hashes, blind mappings, grade JSON, `observations.json`, native results
and report. These are local evidence references, not public download links.
The executor is a custom Windows launcher using the Harness² substrate and native
seeding, rather than the stock Linux runner. Source package metadata was `0.3.0`
during execution; the entire dirty application checkout was not attested.

## Next action

Keep the candidate unadopted. Review and freeze a source-grounded rubric with
explicit requirements and a policy for missing facts. Separately prepare a new
skill revision that inventories deliverables and validates structured output
with a parser before delivery, including field counts and quoting. Test it on
new cases under a newly accepted budget, preserving this experiment unchanged.
Do not optimize a skill to invent SDK versions or undocumented behavior for a
better benchmark score. Production service gates, adoption and guarded restoration
still need their own evidence and explicit decisions.
