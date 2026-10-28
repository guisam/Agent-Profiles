# Run the prepared Windows JobBench pilot

This pilot compares two technical-writing agents on JobBench's
`technical_writers/task1`: turn DataSync API data, developer notes and support
tickets into a migration guide, API reference, troubleshooting guide and release
notes. It uses the same managed instructions and documentation skill for both
models, with separate stamps and fresh run directories.

The deployment uses Harness²'s public `CodexSubstrate` and Agent Profiles'
`seeded_adapter`, with a Windows launcher running **Codex 0.163.0**. This is not
the stock Linux JobBench runner, whose Harness² release pins Codex 0.144.6.
The external Markdown styling reference is pre-provisioned for both models, so
web-search ability is not measured. Do not report this as an unmodified official
JobBench run. It is a baseline feasibility pilot, not skill tuning or proof that
a candidate improves unseen tasks.

## Before running

Your coordinating assistant prepares a durable pilot directory outside the
project, keeping secrets out of its records. It contains:

| Item | Purpose |
| --- | --- |
| `settings.json` | Installed Node/Codex and source paths, model IDs, provider selection and skill source; no tokens |
| `source/task_folder/` | The five original task input files |
| `source/references/` | The downloaded external style example |
| `dataset.json`, `reference.json` | Immutable source revisions/URLs and file SHA-256 values |
| `grader/RUBRICS.json` | Original grading criteria, excluded from solver workspaces |
| `prepared.json`, `captures/`, `store/` | Verified baseline captures, exported harnesses and retained package backing |

The current selected dataset revision is
`d43a66575635da0d3f6cb9a20976dc1a60f3ffc9`. Preparation downloads only the selected
task and style reference, not the full dataset. Use Node 24, Python 3.12+, the
pinned Harness² source checkout, and the prepared source checkout of Agent
Profiles. No Linux runtime installation is needed for this Windows deployment.
The launcher reads only `windows.sandbox` from the active Codex user
`config.toml` and passes that selection explicitly while excluding unrelated
user settings. Select a working native sandbox in your normal Codex session
first; missing or unsupported selections stop before any model call. The chosen
implementation is recorded in the run summary and command metadata.

For Luna, use your existing ChatGPT/Codex login. For Strata, the prepared local
provider uses `http://127.0.0.1:8080/v1`, advertises
`qwen3.8-flash-next-iq2_xs`, and must support Responses streaming and tool calls.
The local provider explicitly disables OpenAI authentication. Its settings apply
only to the invoked process; no credential copying or persistent provider edits
are performed. Requests using the ChatGPT login consume subscription allowance;
this pilot does not configure a separately billed OpenAI API key.

## Check preparation without model calls

From the Agent Profiles checkout in PowerShell, replace the pilot path:

```powershell
py -3 -B integrations/harness2/jobbench_pilot.py --self-check
py -3 -B integrations/harness2/jobbench_pilot.py --root 'C:\path\to\prepared-pilot'
```

Expected output includes `Prepared and verified both baseline stamps. No model
calls.` Preparation refuses changed task/reference manifests, invalid backing,
unexpected versions or different managed baseline bytes between the models.

## Run from your own PowerShell session

The original launcher omitted the configured Windows sandbox while ignoring
user settings, causing even a file-read probe to be refused. The corrected
launcher carries forward the configured sandbox implementation. A plain `READY`
response is not sufficient evidence that a task can run. Use your ordinary
terminal with a working native sandbox; do not add approval-bypass flags or
disable rules to make the probe pass.

```powershell
py -3 -B integrations/harness2/jobbench_pilot.py --root 'C:\path\to\prepared-pilot' --run
```

The launcher first gives each model a harmless file-read probe. Both must return
`READY` **and** produce a successful shell-read event with that file's contents.
If either fails, the launcher records `preflight-blocked` and starts no task
rollouts. Follow any normal approval flow your executor supports; if a policy
refuses the action, report that result rather than weakening it.

If both pass, it runs the original task once per model, sequentially. Each probe
has a three-minute timeout and each task rollout a ten-minute timeout. A timeout
stops only that launcher's owned process tree. The launcher uses
`workspace-write`, disables hosted web search, and does not use unrestricted
sandbox or hook-trust flags. Checkpoints and sandbox/tool controls remain host
behavior; the launcher does not certify complete runtime isolation.

## Inspect the result

### Recorded pilot status

The owner-terminal attempt `20261023T181113Z-640e19` on October 23, 2026 ended
with `preflight-blocked`. Both models contacted their providers, but Codex
rejected `Get-Content readiness.txt` with `blocked by policy`. Neither task
rollout started and no grading occurred. Running outside the coordinating
agent did not resolve the refusal.

The owner then reported a successful file read from a normal interactive Codex
session. Retaining the existing `windows.sandbox` selection in the corrected
launcher produced successful shell-read events for both models in run
`20261023T181934Z-5edcde`. Both then completed all four task deliverables with
unchanged inputs and harnesses. No saved security settings or allow rules were
changed. Preserve the failed attempt as diagnostic evidence, rather than a task
score.

| Baseline | Deliverables | Output size | Approximate task time |
| --- | --- | ---: | ---: |
| Luna (`gpt-6-luna`) | 4/4 | 26,337 bytes | 105 seconds |
| Strata (`qwen3.8-flash-next-iq2_xs`) | 4/4 | 88,465 bytes | 524 seconds |

Times come from command/event file timestamps and exclude preflight. Output
bytes are not token counts. Strata's unknown-model metadata and model-catalog
warnings remain a compatibility limitation.

An initial coordinator review against the supplied rubric found unsupported
legacy-header examples in both outputs. Luna also missed a pagination constraint
and usage-endpoint version attribution. Strata contradicted the parallel-auth
transition in its troubleshooting guide, exposed internal issue references,
invented webhook-validation behavior, and supplied a bulk example that silently
truncates inputs over 1,000 records. The separate local `review.md` retains the
findings and evidence; original outputs remain unchanged.

This is a non-blinded rubric-guided content review, not the stock JobBench
judge or a calibrated weighted score. The original result remains
`completed-ungraded`; formal judging, baseline/candidate pairs and held-out
qualification have not run. Neither model's output is ready to publish as-is.

The final line prints a new `runs/<timestamp-and-suffix>/summary.json` path.
Each model has separate events, stderr, last-message output, command metadata and
workspace artifacts. Successful task runs also have four Markdown deliverables,
output hashes, a Harness² completion marker and an Agent Profiles pre-execution
rollout sidecar bound to the baseline stamp. Source and managed harness bytes are
checked again before completion is recorded. Failed or interrupted runs are not
given successful completion attribution.

`completed-ungraded` means both runs produced the four ordinary, nonempty output
files with unchanged inputs. It does **not** establish factual correctness or a
winner. Return the printed summary path to the coordinating assistant for review
and a separately recorded, common grading procedure. The stock Linux judge has
not run, baseline rollouts do not publish candidates, and promotion is not
authorized by this pilot.

If a model/server/executor changes, retain the old evidence and prepare a fresh
pilot directory with the new exact identities. No configuration schema migration
is introduced by this launcher.

## Strata verification-step experiment

Run `20261023T191152Z-06b1ba` tested a candidate adding a source fact list,
cross-document consistency checks, audience filtering and lossless-example
checks to the documentation skill. Native proposal acceptance and candidate
publication occurred only in an isolated evaluation project/store. The installed
skill and active project assignments were unchanged.

Native migration selects the skill as required, composing its text into
`AGENTS.md` as well as retaining `SKILL.md`. The earlier on-demand baseline
therefore could not serve as the matched control. Both new arms used required
loading; preparation verified that the skill source and its generated
composition were the only rendered changes.

| Strata arm | Result | Deliverables | Task time |
| --- | --- | --- | --- |
| Fresh control | Completed; integrity verified | 4/4 | Approximately 361 seconds |
| Verification candidate | Timed out | 2/4 partial | Stopped at 600 seconds |

The candidate built a fact list and recognized the unknown legacy header, yet
still used an invented header in copyable examples. It also retained an
unsupported webhook-validation claim. Its chunking example was more careful
about processing or reporting records, but that partial observation does not
establish a completed-task improvement. No internal issue ID was found in the
two candidate files inspected; the missing troubleshooting and release-note
documents prevent a complete audience-filtering comparison.

Keep this candidate unadopted. No native evaluation eligibility plan/results,
stock judge, held-out run or promotion was produced. A single timeout does not
prove the added instructions caused it; this trial simply does not support
adoption under the tested budget. Retain the exact candidate, protocol, runner,
failed-arm forensic hashes and separate `review.md` before testing another
version. A next candidate should be smaller rather than silently extending
this attempt's deadline.

### Twenty-minute follow-up

The maintainer explicitly requested more time for the same candidate. Fresh run
`20261023T212200Z-25fcaa` used a 1,200-second task limit and completed all four
documents in approximately **691 seconds (11 minutes 31 seconds)**, excluding
preflight. All task/reference and harness integrity checks passed, and retained
output hashes verified. This was a fresh candidate-only attempt, not a resumed
partial rollout or a new equal-budget control comparison. The original
ten-minute failure remains unchanged; the normal pilot default is still ten
minutes.

The longer limit was enough for this attempt to finish. Content review found
mixed results: the complete set omitted the checked internal issue and excluded
SDK markers, and offline fake-transport checks verified chunking at 0, 1, 1,000
and 1,001 records plus retrying the same chunk after 429. No API was contacted.
However, the documents incorrectly labeled confirmed parallel-auth support as
unknown, still invented a legacy-header name, and assumed an undocumented
signature format. A separate offline check confirmed that the migration's sync
helper rejects the endpoint's valid `202` success response.

Keep this candidate unadopted. Completion under the exploratory twenty-minute
budget is established for one attempt; improved deliverable quality and held-out
qualification are not. The run retains a separate `review.md`, the exact runner,
and reproducible offline example checks. The installed skill and active project
assignments were unchanged.

Continue with the [guided evaluation workflow](guided-evaluation.md) when ready
to split tuning and held-out tasks and compare each model's baseline/candidate.
