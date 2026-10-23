# Harness² materialization

For a step-by-step workflow, start with [Using Agent Profiles with Harness²](../harness2.md).
This reference covers adapter mappings, identities and converter formats.

`harness2-tree` contract version 1 exports a stamp for Harness²'s Codex or OpenCode
surface, pinned to upstream commit `1cfe254e8d25b15f37048c3730134686abe60335`.

```powershell
node bin/agent-profiles.ts materialize <stamp-digest> --adapter harness2-tree --surface codex --root C:\project --store C:\profile-store --output-root C:\exports --destination C:\exports\run --json
```

The destination must be absent and outside protected project, store and host
directories. The harness root passed to Harness² is **`C:\exports\run\content`**;
the adjacent `receipt.json` belongs to Agent Profiles. Use `--surface opencode`
for the OpenCode layout. A surface selects a file layout; it does not create an
OpenCode host assignment.

## Mapping and provenance

Resolved injected instructions, including dependency and workflow companions,
remain in composition order in Codex `AGENTS.md` or OpenCode `systemprompt.md`.
Repository `AGENTS.md` rules are reported as unmapped and are never composed.
Captured required and available skills go in `.agents/skills/<name>/SKILL.md`
or `skills/<name>/SKILL.md`. Every exported skill gets a trigger line in the
always-on prompt. Explicit frontmatter names determine directory names; otherwise
the binding ID is used. OpenCode adds a missing `name:` field. Incompatible names
or descriptions outside the first 600 characters fail before writing.

Package companions and explicit local resources map at their surface paths.
Root Python scripts use `scripts/<name>.py`. Skill-package `scripts/` companions
go under that skill's directory; references must name their harness-relative
paths. Different bytes targeting the same file fail. Non-surface files and
companion skills without their own binding are reported as unmapped.

Mappings in both the plan and receipt contain `operation`, `binding`, `source`,
`outputPath`, and `reason`. Operations are `copy`, `compose`, `trigger`,
`skill-name`, and `unmapped`. Sources retain their captured blob or package
backing. Composed files and skills with an added name use generated backing
with a SHA-256 of the output bytes; they do not claim to copy one source file.
Composition normalizes CRLF to LF and joins parts with two newlines. Verification
reconstructs output and provenance from the stamp and receipt's adapter options.
Unmapped rows have a reason and no output path; text CLI output lists them too.

## Limits and decisions

- Codex always-on text must be nonempty and at most 8,000 Unicode code points.
  OpenCode's four always-on files together, including their separators and skill
  triggers, must fit within 24,000. Oversized trees fail rather than truncate.
- Guardrails, tool guidance and `LongTermMEMORY.md` are copied only when explicitly
  captured at their OpenCode surface paths. Memory is pinned for that export;
  changes made during a run require a new capture and stamp.
- Session roles stay in the composed prompt. Subagents are only explicit
  `sub_agents/<name>/AGENT.md` companion/resource files, with `description:` and,
  for OpenCode, `mode: subagent`. No role is automatically converted into a subagent.
- Codex hooks and OpenCode plugins are archived bytes. Agent Profiles never runs
  package scripts, hooks, plugins, models or Harness². Host-only skills without
  captured bytes are explicitly unmapped. Native invocation stays unsupported.
- Node checks layout, caps, metadata, hooks and script references. Python syntax
  compilation is checked only by the opt-in upstream validator; native layout,
  invocation and runtime rendering are not certified by a receipt.

## Upstream validation

The manual **Harness2 compatibility (opt-in)** GitHub Actions workflow creates
both trees and runs the pinned upstream `tree.validate()`, including Python
compilation without script execution. Normal CI remains Node 24 only.

To run locally with Node 24, Python 3.12 and an unchanged checkout of the pinned
Harness² commit:

```powershell
$env:HARNESS2_VALIDATION_DIR = 'C:\temp\harness2-trees'
node --test test/harness2-tree.test.js
$env:PYTHONPATH = 'C:\source\harness2'
python integrations/harness2/validate_trees.py $env:HARNESS2_VALIDATION_DIR
```

## Adoption capture and stamp seeding

The Python package in `integrations/harness2/` is named
`agent-profiles-harness2`, distinct from upstream's `harness2-bridge`. It has no
Python runtime dependencies beyond the unchanged pinned Harness² checkout and
the standard library. Add that checkout and `integrations/harness2` to
`PYTHONPATH`, or install this package in your Harness² environment. Use Python
3.12 or newer and a Node 24 CLI; normal Agent Profiles CI remains Node-only.

```python
from pathlib import Path
from agent_profiles_harness2 import ProfilesBridge, seeded_adapter, run_task

profiles = ProfilesBridge(
    Path("/exports/harness2-captures"),
    cli=["node", "/source/Agent-Profiles/bin/agent-profiles.ts"],
    store=Path("/exports/profile-store"),
    model="my-model",
    role="worker",
)
adopted = profiles.capture(
    Path("/runs/task/harnesses/agg1"),
    surface="opencode",
    run_id="run-1/task/agg1",
    task_id="task",
    label="agg1",
    evidence={"adoption.json": Path("/runs/task/adoption.json").read_bytes()},
)

# Subclass your existing benchmark adapter; its constructor still runs normally.
SeededAdapter = seeded_adapter(YourBenchmarkAdapter)
adapter = SeededAdapter(
    profiles=profiles,
    seed_stamp=adopted["stampDigest"],
    seed_project=adopted["project"],
    # ...arguments required by YourBenchmarkAdapter...
)
```

`base_harness()` redirects to a fresh verified materialization after the original
constructor completes. This accommodates the demo constructor rewriting its own
baseline. Seeded base calls pass the materialized directory explicitly to native
`execute()` and `execute_many()`: some upstream adapters interpret `None` as an
instruction to use their built-in baseline, bypassing `base_harness()`. Native
batching stays in use. Each completed execution gets a sidecar in `rollouts/`,
with the harness's SHA-256 observed **before** execution and its upstream content
fingerprint. Seeded bases use a real fingerprint, not upstream's constant
`"base"` marker, so native cache checks include the supplied harness bytes.
Only an unchanged materialized seed receives its stamp attribution. If its bytes
change, later rollouts under fresh IDs have no stamp attribution.
Throwaway candidate rollouts have `stampDigest: null`; successful adoptions link
their `runId` to a captured stamp through the adoption index.

Before launching, `rollout-inputs/` reserves each run ID against its exact input
identity. Conflicting reuse refuses before native output can be overwritten.
A failed launch leaves its input reservation, but no completed `rollouts/`
sidecar; the same input may retry. Use new run IDs after changing the harness,
task or stamp, including when retrying a previously failed launch. Old sidecars
with the literal `"base"` fingerprint cannot establish which seed ran and are
refused by paired conversion; collect fresh evidence under new run namespaces.

Use this package's `run_task(..., profiles=profiles, adapter=adapter, prop=proposer,
runs_root=..., library_root=...)` wrapper when driving Harness². It delegates to
the public upstream scheduler, then captures every successful selection,
including selections with no experience entry and resumed tasks. The upstream
scheduler skips `Library.add()` entirely for no-experience selections, so a
library hook alone cannot cover them. `CapturingLibrary` is also available for
callers that invoke `Library.add()` directly, preserving upstream validation and
return values. No global classes or upstream files are patched.

For task streams, retain only earlier tasks in each mode's library before each
call, as upstream `run_domain()` does. Use separate run directories per arm or
independent sweep. Run IDs identify immutable input claims, not reusable labels
for different seeds. The opt-in test runs the real deterministic
demo for two tasks and both modes twice, checking all adoptions and repeated
package and stamp identities. The unchanged scheduler needs POSIX `fcntl`;
run that demo on Linux, WSL Ubuntu, or the manual workflow.

### Captured artifacts and identity

- `projects/` holds isolated config-v3 projects and lockfiles. Capture never binds
  packages into the caller's active project. Codex captures select host `codex`;
  OpenCode captures leave host unset while retaining explicit model and role.
- Each skill becomes an instruction-delivery skill package with its exact
  entrypoint and scripts. Primary always-on text becomes a profile entrypoint
  named `PROMPT.md`, allowing later proposals to target that file instead of
  repository `AGENTS.md`. Other always-on files, including pinned memory, become
  instruction dependencies. Root scripts, subagents and extensions remain
  companions of the profile package. A separate empty role package satisfies
  the configuration's required role binding and is labelled `structureOnlyRole`.
- Manifests and revision records are deterministic JSON, accepted as YAML by the
  Node CLI. Package names identify the surface and component. Versions encode
  156 bits of the component-content hash as three safe integer release fields;
  dependency pins also affect a parent's version. They are identity versions,
  not chronological releases. A collision is refused by the content store.
- `adoptions/<eventId>.json` preserves each capture and caller evidence, including
  adoption JSON, decision notes and available `EXPERIENCE.md`, as exact base64
  bytes. Records map every original surface path to its package digest and
  package path. Atomic `index.json` indexes run, task, label, fingerprint, full
  tree SHA-256, package pins and stamp. Evidence and component labels remain
  `external-claim`; they do not authenticate a Harness² judgment.
- Run IDs and evidence do not enter package or stamp inputs. Identical adopted
  bytes reuse identities under the same namespace, configuration and selection,
  even in a different capture directory. `profiles.diff(before, after)` includes
  the existing verified Node stamp diff and names changed original component
  paths from the capture records, marked as external component mappings.

Captured source bytes are preserved in packages. Re-materialization uses the
adapter's instruction composition and trigger rules above, so it is not a
byte-for-byte reconstruction of the original surface layout. Generated
instructions, identity, native execution and runtime behavior remain separate
claims.

Capture serializes local writer threads and refuses a concurrent process via
`.capture-lock`. A killed process can leave that directory behind; inspect it
and confirm no writer is active before removing it. Failed imports may retain
immutable packages in the store, but no completed adoption index entry is
published. No captured script, hook or plugin runs during capture or seeding.
Only explicitly running Harness² executes a harness.

### Convert adopted edits into proposals (Codex)

The Python package also exports `start_migration`, `proposal_batch`,
`evaluation_plan` and `evaluation_results`. These use existing proposal-v1 and
evaluation-v1 formats. OpenCode capture and materialization remain supported,
but phases 3–4 require host `codex`; an OpenCode surface is not a host assignment.

```python
from agent_profiles_harness2 import start_migration, proposal_batch
from agent_profiles_harness2.bridge import encoded, read_tree
from harness2.substrate.codex import CODEX_SURFACE

prepared = start_migration(profiles, adopted, binding="skills.review")
base, migration = prepared["base"], prepared["migration"]
project = Path(base["project"])
seed = profiles.seed(base["stampDigest"], surface="codex", project=project)
before = read_tree(seed, CODEX_SURFACE)  # save before the external search starts

# Run Harness² separately, seeded with this stamp; chosen points to its adoption.
batch = proposal_batch(
    base, read_tree(chosen, CODEX_SURFACE), migration,
    before_tree=before,
    run_id=chosen_run_id,
    excerpt=decision_note,
    draft_case={"input": task_input, "expected": task_expected},
)
Path("unsupported.json").write_bytes(encoded(batch["unsupported"]))
for number, proposal in enumerate(batch["proposals"]):
    Path(f"proposal-{number}.json").write_bytes(encoded(proposal))
```

Capture initially makes skills available. `start_migration` selects the named
skill as required in a **new isolated project**, installs offline, stamps that
evaluation context, and starts a fork migration. It preserves the captured
configuration. Use the returned base stamp to seed search and evaluation;
it differs from the original capture stamp because skill selection changed.

Keep exact pre-search bytes in `before_tree`. Generated/composed text is not
reversible: an unchanged generated `AGENTS.md` is ignored, and edits to it are
reported as unsupported. The converter maps copied skill entrypoints back to
`packages/<digest>/SKILL.md`, verifies workspace bytes against the migration
inventory and capture, and emits `classification: package`. It refuses stale
workspaces or a mismatched migration base. Paths, bytes and line endings remain
exact. Each changed entrypoint produces a separate proposal.

When comparing edits directly against the **original captured tree**, omit
`before_tree`. Its primary instruction file maps to the profile's `PROMPT.md`
as `model-specific`; selected role entrypoints map as `role`. These can stop at
workspace acceptance. They cannot become candidates under the current native
candidate contract. Additions, deletions, scripts, subagents, plugins, companions,
binary/NUL text and generated text without a single source mapping appear in
`unsupported`; review that report before continuing. No proposal targets the
repository's `AGENTS.md`, config, lock or package manifest.

Import and review proposals using `migrate propose <migration-id> <file>` and
`migrate accept <migration-id> <proposal-id>`. Acceptance is an explicit caller
action. For a skill-only task change, use the existing `migrate candidate`
manifest contract: name one skill binding, accepted proposal IDs, the migration
and evaluation base stamps, current lock `configSha256`, exact workspace package
`expectedTreeSha256`, a distinct unpublished release version of the same name,
and a `task-only` workflow-change explanation. Compute package hashes with the
Node `readPackage` API; do not substitute the Harness² tree hash. The converters
never accept proposals, publish candidates or promote bindings automatically.

### Convert fixed-arm evaluation evidence (Codex)

```python
from agent_profiles_harness2 import evaluation_plan, evaluation_results

plan = evaluation_plan(
    id="review-plan", candidate=candidate,
    base_stamp=base["stampDigest"], assignment=base["selection"],
    binding="skills.review", member=base["packages"]["skill-review"]["name"],
    workflow_peers={"base": [], "candidate": []},
    tasks=[
        {"id": "fix", "taskId": "domain/failing-task", "kind": "motivating",
         "input": task_input, "expected": task_expected},
        {"id": "retain", "taskId": "domain/regression-task", "kind": "regression",
         "input": regression_input, "expected": regression_expected},
    ],
    k=3, mode="agg", seed=7,
    judge={"id": judge_model, "version": judge_revision, "settings": judge_settings},
    rubric={"id": rubric_id, "version": rubric_revision, "settings": rubric_settings},
)
Path("plan.json").write_bytes(encoded(plan))
retained = profiles.command("migrate", "plan", candidate["id"],
                            str(Path("plan.json").resolve()), project=project)
```

Retain the plan **before executing either arm**. Native `migrate plan` verifies
candidate/revision/stamp bindings, active evaluation context, selected member,
assignment and workflow obligations. Use the candidate's actual evaluation base
and both snapshots' exact `workflowPeers` (empty for packages captured here).
For workflow/collateral obligations, add task rows of those kinds with an explicit
native case `target` containing assignment, binding, member and protocol. Native
validation rejects omitted obligations. Task and case IDs must be unique; the
plan's subset records their mapping. At least one motivating and one regression
case is required. `trials` is `k`; the Harness² version is the pinned full commit.

Run two external Harness² sweeps, each with `seeded_adapter`: seed one with
`plan["baseStamp"]`, the other with `plan["candidateStamp"]`. Use distinct,
nonoverlapping `HARNESS2_RUNS_DIR` directories and unique run-ID namespaces
(for example different sweep tags). Keep task subset, substrate, seed, `k`, mode,
executor, judge and rubric identical. Record the actual conditions for each arm;
include executor/model settings in the judge or rubric settings as appropriate
to your experiment. Preserve each arm's pre-execution rollout sidecars. After
each sweep, run upstream `harness2-judge --bases` and retain its
`base_judged.json`, not selected-harness `judged.json`.

For each arm, supply a dictionary with:

- `runsRoot`: that arm's `HARNESS2_RUNS_DIR` absolute path;
- `stampDigest`: its pinned stamp, and `conditions`: its recorded conditions;
- `judged`: the parsed `base_judged.json` list;
- `rollouts`: parsed `ProfilesBridge` rollout sidecars for exactly those base
  rows, excluding improvement/selection rollouts;
- optional `costs`: individual recorded ledger entries with exactly
  `{runId, taskId, kind: "rollout", label: "baseN", usd}`. Preserve ledger entry
  USD values and attach their run/task identities while collecting evidence.
  Upstream `Ledger.to_dict()` retains totals, not individual entries; its totals
  cannot populate this field. Omit costs if individual evidence was not saved.

```python
result = evaluation_results(
    id="review-results", plan=plan, plan_digest=retained["planDigest"],
    base=base_arm, candidate=candidate_arm,
)
Path("results.json").write_bytes(encoded(result))
profiles.command("migrate", "results", plan["id"],
                 str(Path("results.json").resolve()), project=project)
report = profiles.command("migrate", "report", result["id"], project=project)
```

Conversion rejects duplicate/missing/foreign trials, non-base labels, ungraded
rows, inconsistent grade counts, mismatched arm conditions or stamps, missing
sidecars, changed fixed-arm bytes, overlapping roots and reused run IDs. Each
outcome uses the recorded boolean `all_pass` and `run_id` as `evidenceRef`.
Unavailable metrics remain `null`; costs are never allocated from task totals.
Only individual recorded USD cost is currently imported; other metrics stay
`null`. No threshold inference, sweeps, judges or model calls run in converters.
Arm metadata, sidecars and judgments remain external claims, not authenticated
proof of execution. Results ingestion checks the retained plan's authoritative
digest and conditions; reporting does not authorize promotion.

The opt-in workflow tests the real WorkBuddy, LAB and JobBench execution,
staging and launch paths on both surfaces, replacing only external launchers,
credential checks and dataset-location fixtures. It verifies supplied instruction
markers reach the launcher, matching native caches reuse results, changed inputs
refuse reused run IDs, failed launches create no completed attribution, and
partial native batches attribute only returned rollouts. WorkBuddy batching
remains one native launcher invocation. The demo covers actual offline execution.

Converter tests also materialize distinct base/candidate stamps, run both through
the native WorkBuddy path with a stub launcher, and pass their actual rollout
sidecars through retained plans, results ingestion and reporting using the real
Node CLI. Judgments are fixtures; this verifies routing and provenance, not model
quality. No credentials are required. Real Codex model execution and judge quality
need separate external validation.

References: [tree validation](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/tree.py),
[Codex surface](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/substrate/codex.py),
[OpenCode surface](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/substrate/opencode.py).
