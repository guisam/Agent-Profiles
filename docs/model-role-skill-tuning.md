# Tune skills for an exact model and role

Use this guide to prepare and evaluate skill variants for a role such as
implementer or reviewer. The goal is the best tested instruction set for that
model's work, not the shortest file. Agent Profiles (AP) selects and delivers
versions; your evaluation runner measures behavior.

The [Skill Compaction preset](../examples/presets/skill-compaction/preset.yaml)
provides the editing procedure. The
[Superpowers companion workflow](https://github.com/guisam/agent-profiles-superpowers/tree/main/workflow)
provides a worked evaluation and distribution example. Neither automatically
tunes or promotes your project's skills.

## 1. Establish the target and baseline

Record the project, assigned role, exact target model ID, host/version, tools,
permissions, delivery route, active plugins/hooks and AP version. The agent
doing the compaction may be a different model from the model being tuned.
Use the target identity supplied by its host or recorded launch configuration;
do not infer it from a display label or behavior.

Resolve and explain the target selection in an isolated consumer. If the
current MCP server is bound to another assignment, use a separately configured
consumer rather than overriding its selectors. Record:

| Item | Record |
| --- | --- |
| Governing instructions | Repository rules, model profile, role contract |
| Each required skill | Binding ID, source revision/package version, digest, delivered body |
| Each available skill | Binding ID, description, reference and activation condition |
| Dependencies | Linked skills, scripts, templates, resources and their access paths |
| Delivery | Resolve completion marker; actual text received in the target session |

Required instruction skills are included by resolve. Available skills are
listed for use when relevant; their full bodies are not loaded by default.
Native skill references have host-specific delivery. Assess all attached skills,
but do not move required skills to available merely to reduce context: that
changes activation policy and needs its own proposal and tests.

Keep the baseline immutable. Store candidate content and evidence in your skill
repository, such as `agent-profiles-superpowers`, not in AP's engine repository.
Keep private session logs, local configuration and signing material out of shared
examples. Record an explicit baseline selection for rollback.

## 2. Inspect and load Skill Compaction

From a trusted AP checkout containing the preset, with Node 24 and dependencies
installed, inspect it without changing a consumer:

```powershell
node bin/agent-profiles.ts preset inspect examples/presets/skill-compaction --contents
```

Read the complete `skills/skill-compaction/SKILL.md`. Importing the preset is
optional and requires reviewing the target-specific preview. Preset schema 1
does not copy supporting resource trees and is not a substitute for full-tree
skill packages. Use the configuration workflow supported by your consumer;
do not convert its schema solely to run this guide.

The preset's `skill-compactor` role always requires the compaction skill. Its
standalone discovery cases do not qualify that role's delivery behavior.

## 3. Prepare one candidate at a time

Inventory each skill's triggers, decisions, order, exceptions, authority,
verification and output contract. Read supporting files and incoming references.
Separate four kinds of content: decision guidance, execution explanation, local
knowledge, and constraints/checks.

Remove equivalent duplication first. Then consider shortening mechanics the
target may already know. Preserve instructions about *when* to use those
mechanics. Knowing how to write a test does not establish that a model will
choose to write and run it before editing code.

For each edit record its source, replacement, preserved requirement and evidence:

- **Editorial:** explain why meaning and reminders at action points survive.
- **Capability-dependent:** label evidence demonstrated, knowledge-probe-only,
  or unknown. An assumption can justify drafting an unvalidated candidate, not
  adopting it.

Keep scripts, resources, licenses, exact interfaces and cross-skill links intact.
Inspection does not authorize running bundled executables. Fixing contradictory
policy is a separate change, not compaction. An unchanged skill is a valid result.

Assess the whole role, then edit and compare one skill at a time. After individual
candidates pass, evaluate their combined role context: individually good edits
can interact badly. Preserve upstream versions for other models and roles.

## 4. Evaluate before changing active selections

Freeze the cases, grading criteria, repetition count, permitted usage and adoption
rule before running the target model. Use the existing runner; if none is
configured, prepare the cases and report execution as pending. Do not invent
passing results or buy API capacity to finish the exercise.

Within each baseline/candidate pair keep model, host, effort, tools, permissions,
task and delivery route fixed. Start fresh contexts, alternate arm order, verify
delivered bytes and keep graders blind to arm labels. Test:

- spontaneous activation and correct non-activation;
- execution quality, verification and error handling;
- exceptions, approval boundaries and competing instructions;
- available-skill selection and access to scripts/templates;
- recovery after clear/compaction, if the deployment relies on it;
- the complete role workflow, including explicitly assigned child roles.

Use held-out tasks for confirmation after candidate development. A shared failure
in both arms remains a quality gap; tied scores alone do not prove that a safety
or approval requirement works. Keep setup failures separate from behavior scores.

Measure entrypoint size, deferred resources, complete task usage and quality
separately. Name the tokenizer for token counts; otherwise use bytes. Account
for coordinator and grading usage as well as workers. API-equivalent estimates
are not personal subscription charges.

The companion's Sonnet TDD screening reported 18/21 accepted outcomes per arm
and 9.31% fewer total execution tokens. It also recorded shared failures and
did not run held-out confirmation. The candidate remains **not adopted**. See
the [close-out](https://github.com/guisam/agent-profiles-superpowers/blob/main/experiments/tdd-compaction/CLOSEOUT.md).
These findings do not establish benefits for another model, host or skill.

## 5. Save a version and select it narrowly

Saving a skill version is different from editing a model profile. A profile
holds model-level instructions; a role defines duties and skill bindings; a
versioned skill package holds the candidate's instruction/resource tree. An
assignment chooses that package for the intended model and role.

For a package-backed consumer, prepare a new immutable package version with
source provenance, change map, resource hashes and evidence. Keep the baseline
as the default. This **illustrative fragment** uses fictional packages; merge
into a compatible existing configuration only after validation:

```yaml
skills:
  testing: {package: "@example/testing", version: "1.0.0"}
assignments:
  sonnet-implementer-tested:
    when: {model: claude-sonnet-5-5, role: implementer, host: claude}
    bindings:
      skills.testing: {package: "@example/testing", version: "1.1.0"}
```

The role still references `testing`. Other selectors keep their existing
selection; check precedence against any existing assignments. An unknown,
unstated or near-match model must retain the intended baseline. A local-only
skill file is not a library version: prepare packaging explicitly rather than
pretending a file edit produced a versioned pin.

Use the installed AP version's supported update or configuration workflow.
For a supported library update, show `update_preview`, **every edit** it returns,
and its exact `applyCommand`. The operator runs host-denied commands. If a
cross-package change is unsupported, report that limit and prepare an explicit
reviewable configuration proposal; do not silently substitute commands.
Preserve trust policy and obtain any required package approvals normally.

After authorized adoption, refresh the lock through the supported install
workflow, run doctor, resolve and explain, and verify the selected package,
digest, role and completion marker. Test the exact target, another role, a
near-match model, an unknown model and a second project whose pins should not
change. Save the configuration diff, evidence and rollback instructions. Revert
the assignment and refresh/verify the lock to roll back; start a fresh agent
context so old candidate instructions do not linger.

## Copyable tuning prompt

Replace the bracketed values. This authorizes preparation, not model runs or
live adoption.

```text
Prepare skill-tuning candidates for:
  project: [path]
  role: [role ID]
  target model: [exact host/launcher-stated model ID]
  host and delivery route: [host/version; MCP, shell, or launcher]
  candidate/evidence directory: [separate skill repository/path]
  allowed session evidence: [specific session/log, or none]
  evaluation runner and authorized budget: [runner/limits, or not authorized]

Read the complete Agent Profiles skill-compaction skill and follow it. If it is
unavailable, report the missing source instead of improvising its procedure.
Respect repository instructions and existing permissions. Do not assume that
you, the compactor, are the target model.

Inventory the role's required and available skills, profile, resolved package
versions/digests, resources, callers and active plugins/hooks. Verify the target
selection with resolve/explain in an isolated consumer. Do not overwrite bound
MCP selectors or change live configuration. Stop on incomplete resolution.

Assess every attached skill. Recommend keep, editorial compaction,
capability-dependent candidate, or separate policy/tooling repair. Preserve
triggers, order, exceptions, authority, verification, scripts and references.
Do not change required/available classification inside a compaction.

Prepare the highest-value candidate first as a separate version/copy. Include
the preserved contract, change map, source/candidate sizes, assumptions and
behavioral cases. Label knowledge probes as leads, not proof of execution.
Use approved session corrections as evidence for new cases, not as automatic
permanent instructions. Keep task-specific facts out of reusable skills.

Compare baseline and candidate only within the stated evaluation authorization.
Otherwise deliver a runnable evaluation plan marked not run. Freeze grading
and adoption criteria before trials, retain failures, and reserve held-out
confirmation. Test individual edits and then the combined role environment.

Prepare an adoption proposal only when evidence meets the frozen criteria.
Show the new package/version, exact model+role(+host) assignment, all config and
lock effects, trust requirements, fallback and rollback. For supported library
updates show every update_preview edit and the exact applyCommand. Do not apply
live pins, sign, publish or run host-denied commands on my behalf under this
preparation request. Finish with what is ready, tested, unvalidated and blocked.
```

## Use retro after a build worth learning from

Matt Pocock places retro after code review in his main chain:
`grill-with-docs → to-spec → to-tickets → implement → code-review → retro`.
Run it in the same session or point it at that session's log; skip it after a
smooth build when there is nothing useful to investigate. The
[retro skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md)
loads `writing-for-agents` first and proposes environment improvements from
primary session evidence. It is user-invoked, not automatic transcript mining.

In that workflow, reviewer standards belong where code-review's Standards axis
reads them. Mechanically enforceable mistakes belong in deterministic checks;
judgment calls may need reviewer guidance. Retro can also identify navigation,
tooling and information-access problems. It does not establish which model
variant is best, and this guide does not install either skill.

For AP, use its findings as inputs to the next tuning cycle. Preserve this
record for each proposed improvement:

| Evidence | Interpretation | Destination | Validation |
| --- | --- | --- | --- |
| Session ID/turn or log span; actual model, role and loaded version | Expected vs observed behavior; correction; uncertainty about cause | Test/lint, project convention, role contract, model profile or specific skill | Regression case, competing-instruction case and held-out confirmation |

A one-off task request is not a universal rule. A repeated correction might
reflect missing delivery, stale context or bad tooling rather than missing
skill text. Diagnose that first. Keep retro's proposed policy changes separate
from meaning-preserving compaction, and give each a testable outcome.

Optional prompt after code review:

```text
Run retro on [this session / specific log]. Load its writing-for-agents
dependency first; report if either skill is unavailable. Use only the named
session and distinguish primary evidence from summaries or missing history.
Present findings before changing instructions. For each correction, identify
the model, role, skill version, expected behavior and observed behavior.
Prefer deterministic checks for mechanical errors and put reviewer standards
where this project's review contract reads them. Separate task-specific facts,
delivery failures, tooling fixes, policy changes and compaction candidates.
For proposed skill changes, prepare regression cases and a handoff to the AP
model/role tuning workflow. Do not automatically edit global instructions,
change active pins or publish session content.
```

Credit: Matt Pocock for retro and writing-for-agents; Jesse Vincent/obra for
Superpowers; Nikolay Petrov (@napetrov) and Intel's dokimi for the knowledge
probes that helped nominate the companion's candidates. Behavioral findings
belong to the companion experiments. No endorsement is implied.
