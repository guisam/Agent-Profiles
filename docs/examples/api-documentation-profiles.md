# Saved API documentation profiles and run evidence

Experiments are stopped. This work demonstrates saving, loading and comparing
distinct model/role configurations. It does **not** establish that Luna matches
Sol's quality or that the latest examples are optimized or production-qualified.

## Distinct skill assignments

The [preset](../../examples/presets/api-documentation/preset.yaml) contains two
model instruction profiles and two explicit roles:

| Runtime model | Profile | Assigned role | Required skills |
| --- | --- | --- | --- |
| gpt-6-luna | api-docs-luna | api-documentation-luna | api-documentation, source-evidence-audit |
| gpt-6.1-sol | api-docs-sol | api-documentation-sol | api-documentation, api-contract-review |

Agent Profiles associates skills with roles, independently of model-profile
selection. Use the complete model/role pair. Both roles share the base API
documentation skill, and each adds a different review skill. Neither exposes
available skills or requires an external skill source. Other roles do not load
these skill bodies through the resolver. Host system instructions and native
skill catalogs are outside that guarantee.

These final assignments were **saved and resolved offline after model runs
stopped**. They are configuration examples, not the exact instruction layout of
earlier quality experiments. Do not transfer earlier scores to them.

From a trusted source checkout with Node 24, inspect and import the preset:

~~~powershell
node bin/agent-profiles.ts preset inspect examples/presets/api-documentation --root C:\path\to\project --contents
node bin/agent-profiles.ts preset import examples/presets/api-documentation --root C:\path\to\project
~~~

Review conflicts before replacing local files or mappings. The preset declares
no defaults. Verify the selected profile, role and required skill list:

~~~powershell
node bin/agent-profiles.ts resolve --root C:\path\to\project --host codex --model gpt-6-luna --identity-source user --role api-documentation-luna --json --contents
node bin/agent-profiles.ts resolve --root C:\path\to\project --host codex --model gpt-6.1-sol --identity-source user --role api-documentation-sol --json --contents
~~~

Use host-stated identity when the host supplies the runtime ID. Model mappings
do not assign a role automatically. See [preset conflict behavior](../presets.md).

## Evidence beside every task run

The owner's local evidence index is:

~~~text
%LOCALAPPDATA%\AgentProfiles\evaluations\profile-evidence-index.md
~~~

It links all 25 task rollouts, including failed/timed-out attempts, plus two new
offline configuration examples. Twenty-three grading/readiness sessions are
classified separately: they did not apply Agent Profiles configurations, so no
historical YAML is invented for them.

Every task run now contains:

| Artifact | Purpose |
| --- | --- |
| agent-profile.yaml | Visible portable YAML for the run's selected model, profile, role and skill associations |
| profile-evidence/README.md | Run card with skills, versions, content hashes and restore notes |
| profile-evidence/project/.agent-profiles/ | Self-contained local configuration and referenced instruction files |
| profile-evidence/native-stamp.json | Retained native selection and package provenance |
| profile-evidence/retained-source-agents.yaml | Exact retained project YAML, separately labeled as a post-run source copy |
| profile-evidence/retained-native/ | Preserved native workspace instructions where present |
| profile-evidence/manifest.json | YAML/file hashes, original package versions, required/available associations and runtime settings |

The portable YAML is reconstructed from verified immutable stamp data and exact
instruction bytes, not guessed from remembered prompts. The original project YAML
can differ from a candidate's effective selection because candidate previews
overlaid package bindings. Both are retained and labeled. Historical controls
that shared a skill remain shared; revised content is distinguished by its
package version and SHA-256 even when the skill ID did not change.

All 27 saved YAMLs were checked with the actual resolver for their recorded model,
profile, role and required/available skill associations. Archived files retain
hashes for offline integrity checking. No live project was reverted.

## Restore a previous selection

Start in a **new empty project**. Copy the chosen run's
profile-evidence/project/.agent-profiles directory there. Resolve its recorded
model and role, compare selected instruction hashes with the manifest, and inspect
the result before using it. Review a merge into an existing project rather than
overwriting current configuration blindly.

This portable v1 configuration restores selected instruction bodies. It does not
reconstruct original package locks, migration history, host permissions, service
settings or model state. Keep the original native store and stamp for that
provenance. Importing a preset copies files; it is not automatic synchronization.

Reasoning effort belongs to the host, not this YAML format. Historical commands
used low or high effort as recorded per run. Codex exposes it through
[model_reasoning_effort](https://learn.chatgpt.com/docs/config-file/config-reference).
Restoring instruction files alone does not restore runtime conditions.

For future source-checkout runs, the offline exporter can create the same bundle:

~~~powershell
py -3 integrations/harness2/archive_profile_evidence.py --run C:\path\to\rollout --store C:\path\to\store --stamp <stamp-sha256> --source-config C:\path\to\project\.agent-profiles\agents.yaml
~~~

It verifies the native stamp and refuses to overwrite existing evidence. It makes
no model calls. Freeze configuration before future execution as well; a later
source copy is not proof that the complete project YAML existed unchanged before
a historical run.

## What the stopped experiments established

The latest optimization sequence used 16 subscription sessions: eight task/draft
or repair sessions, six blind Sol grading sessions and two readiness checks.
Both models completed the development tasks with valid CSV structure. Under the
revised five-criterion source-grounded review, the first Luna profiles scored
1/5 and 0/5 on Petstore/TaskFlow; the Sol profile scored 5/5 on each. Revised Luna
instructions plus high reasoning scored 0/5 and 3/5. A fresh-context repair
experiment scored 0/5 and 2/5 and was not adopted.

These counts use different criteria from the earlier
[Luna/Sol diagnostic](luna-sol-qualification.md). They are selective model-judge
assessments, with possible Sol-judge bias, not statistical qualification.
Higher reasoning alone and a fresh self-review did not establish Luna parity.
Fresh controlled cases were prepared but **not run** after the user stopped
experiments. The separate configuration-only examples prove distinct skill
routing and persistence; they do not prove improved model performance.

Use the [qualification workflow](../agent-qualification.md) for any future
evaluation, adoption and guarded restoration decision.
