# Qualify an agent for a role

Use your coding assistant to establish whether a particular model and its
instructions meet your requirements for a job. Start with the prompt below.
The assistant handles the existing capture, migration and evaluation tools;
you choose requirements and review the adoption decision.

This is an assistant-assisted workflow. It produces a readable qualification
report from retained evidence; it does not add a model runner, queue, billing
system or automatic certification. Native plans/results remain the authoritative
evaluation records. The report is a human-readable view, not another import or
promotion format.

## Start here

Paste this into your coding assistant in a trusted Agent Profiles checkout:

```text
Guide me through docs/agent-qualification.md. If unavailable, use
https://github.com/guisam/Agent-Profiles/wiki/Agent-qualification
and its linked workflow/reference pages.

I want to qualify agents for: <describe the job in everyday language>.
Models I want to use: <names, exact IDs, or help me discover installed models>.
Optional service labels: <basic / premium, or omit>.
Existing project: <path, or help me select an isolated example>.

First inspect read-only and help me complete the intake below. Ask only for
missing decisions; discover paths, exact model IDs and compatibility where
possible. Show one small intake card before preparing execution. Do not assume
basic is cheaper or premium is more accurate from its name.

Use docs/guided-evaluation.md for native capture, isolated candidate preparation,
matched fixed-arm plans/results, explicit adoption and guarded restoration.
Generate the internal JSON and Python glue for me; do not ask me to author it.
Preserve existing project instructions, permissions and active configuration.

Retain the accepted intake and planned suite before evaluation. Keep tuning
separate from held-out/regression tasks. Freeze each model's configuration,
rubric, tools, trial counts, budgets and execution settings. Inspect the actual
exported context: changing available skills to required may require a fresh
matched baseline. Reuse existing execution approval only within its approved
scope; otherwise show concrete commands, calls, output locations and enforceable
budget limits before obtaining approval. Never silently extend a deadline.

Prepare a report using docs/templates/agent-qualification-report.md. Fill it
from validated native records and cited measurements. Preserve unknowns and
failed/timed-out attempts. Report native promotion eligibility separately from
my service requirements. Do not treat a completed rollout, one successful sample,
unchanged quality, a fixture, or an ungraded pilot as qualification.

Help me choose adopt, reject, gather evidence, or revise. Preview any proposed
change and obtain explicit adoption approval. A report never authorizes a
promotion or production installation. End with the report location, unresolved
gates, exact affected model/role/host tuples and next action.
```

The [worked pilot report](examples/agent-qualification-pilot.md) shows a valid
outcome when evidence is insufficient: a useful report without an adoption.

## Complete one intake card

The assistant records this card in a fresh durable experiment directory outside
the active project. Markdown is sufficient; the user does not write a schema.

| Decision | What to record |
| --- | --- |
| Job and scope | Responsibilities, deliverables, allowed inputs, and exclusions. |
| Selection | Exact provider/model ID, host and executor versions, role, available tools and selected skill binding for each agent. Discover these before asking the user. |
| Service labels | Optional basic/premium labels mapped to exact tuples. Labels are not new YAML selectors. |
| Quality | Versioned rubric, minimum pass requirement per case, critical failures that always reject an output, and regression limits. |
| Repetition | Required held-out/regression cases and trials per case. Record small-sample limitations. |
| Turnaround | Maximum permitted time and measurement boundary: execution only, or request through accepted deliverable including retries/review and queue time. A timeout is not observed latency. |
| Cost | Required metric and ceiling: provider charges, or a fuller resource/retry/review estimate. Mark unmeasured components unknown. Client price is separate from execution cost. |
| Execution budget | Approved calls, task/trial counts, executor/tool access, time limits, financial limits and how each is enforced. |
| Decision scope | Evaluation-only, isolated adoption review, or a later separately approved active-project change. |

Agree which requirements are gates. An explicitly optional cost measurement can
remain unknown without blocking a quality-only decision, but that agent cannot
be described as cost-qualified or cheaper. Subscription access and local hosting
alone do not establish total cost. Do not invent targets to fill an empty card.

For a small first suite, propose two held-out cases, one regression case and
three trials per case, subject to the user's budget. This is a starting proposal,
not evidence of statistical reliability. The native plan must cover all declared
workflow/collateral obligations, even if more cases are needed. Freeze acceptance
criteria before seeing evaluation outcomes. Later edits require a new recorded
decision and fresh evidence where the comparison changed.

## Run the existing evaluation workflow

Follow [guided evaluation](guided-evaluation.md) for preparation, tuning,
proposal acceptance, native candidate publication, plans, fixed-arm evidence,
reporting, adoption preview and restoration. Its compatibility and budget checks
apply to this flow. Preparing a report does not authorize model calls.

Evaluate baseline and candidate separately for each model. Preserve matched
conditions within each pair. If comparing models, use the same task/rubric and
make material condition differences visible. The two model IDs are not the
baseline and candidate of a single native skill migration.

After import, retain the actual JSON from `migrate report` and its plan/result
IDs and digests. Check each case's pass counts and regressions. Native reports
mark correctness as an external claim and runtime as unverified; preserve those
labels. An `eligible` report can still have poor absolute quality if both arms
failed, so it is only one gate.

The Harness² converter currently imports individual recorded rollout USD costs;
latency, tokens, turns and tool calls remain null through that converter. Show
null as unknown. Retain any additional measurements separately with units,
method, complete attempt coverage and evidence references; do not rewrite native
results to manufacture measurements. Native aggregate totals are not worst-case
or percentile latency. Approximate file timestamps from our pilot are not a
production turnaround measurement. Include retries, timeouts and review effort
according to the accepted intake; do not silently omit failed attempts.

## Produce the qualification report

Copy the [report template](templates/agent-qualification-report.md) into the
experiment directory as `qualification-report.md`. The assistant fills it and
keeps links to the accepted intake, exact candidate diff, native records,
measurement attachments and outputs. Missing evidence is itself a report result.

Use these decisions in order, per model and proposed service label:

| Decision | When it applies | Next action |
| --- | --- | --- |
| Blocked | Integrity/freshness validation fails, evidence has conflicting identities/conditions, or required execution capability is unsupported. | Repair preparation or collect fresh valid evidence. Do not promote. |
| Does not meet requirements | A known required quality, regression, completion, turnaround or cost gate fails. Missing other data does not erase the failure. | Reject or prepare a separately identified revision. |
| Needs evidence | Requirements are unset, or required coverage, grading, repetitions, metrics or runtime observations are missing. | Name the exact missing evidence and propose a bounded next run. |
| Ready for adoption review | Every accepted gate has supporting evidence, required coverage is complete, and the native report is eligible with no waived regressions. | Present the evidence and prepare an exact read-only adoption preview. |

For example, if a tier requires five-minute accepted turnaround, an otherwise
correct eleven-minute run fails that gate. If cost is required but unknown, it
needs evidence. If both baseline and candidate fail a critical correctness case,
native no-regression eligibility does not make the tier ready. Fixtures verify
mechanics and never qualify a live model. A changed twenty-minute run does not
rewrite a ten-minute timeout. Preserve each outcome and condition.

## Make the adoption and routing decision

The user can choose reject, revise, gather evidence or review adoption. Readiness
does not authorize a change. Use the existing native decision, `migrate preview`
and explicit promotion flow; separately preview installation into an active
project. Preserve before/after configuration and lock bytes, and rehearse the
existing guarded restoration procedure in the isolated project first.

After an approved installation, resolve both model/role/host tuples and record
their pins, managed context and deployment stamps. Check that changing one tuple
preserved the other. Distinguish tested evaluation stamps from new deployment
stamps; compare managed bytes and environment, and requalify material changes.
Host/repository instructions and tools can alter behavior beyond managed pins.

The report may provide a proposed routing table with service label, approved
tuple, limits and fallback/escalation policy. Only an adopted, verified deployment
belongs in an enabled routing row. The caller chooses a tuple; Agent Profiles
resolves its instructions. Queuing, tier pricing, live output checks and fallback
execution belong to the client/orchestrator and need their own implementation
and validation. Selecting a profile does not enforce an SLA or tool isolation.
If two tiers need different pins for an otherwise identical tuple, choose
distinct supported selections or configuration contexts explicitly; a tier label
alone cannot switch the configuration.

Keep a dated report and its exact evidence when a model, skill, prompt, host,
tool environment or service requirement changes. Mark the affected qualification
as needing review; the current project does not automatically monitor drift,
invalidate routing rows or switch agents.
