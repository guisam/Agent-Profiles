# OpenCode host setup

The bootstrap adapter targets **OpenCode v2.1.3**, source commit
`bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1`. Native loading and a real bootstrap
resolver invocation were observed on Windows with `opencode/big-pickle`, agent
`build`. See the [observation record](opencode-observations.md). Earlier v1 source
research describes a different host implementation.

The live paired smoke also passed: four actual rollouts, measured base/candidate
answers, cache/conflict checks, retained results, read-only preview and explicit
promotion. Reproduction and evidence are in the observation record.

## Install and select context

Requires Node 24 and an OpenCode CLI. From a trusted Agent Profiles checkout,
build a tarball with `npm pack --pack-destination <existing-output-directory>`.
The package is not published; install the actual tested tarball in your project.

```powershell
npm install --save-dev C:\artifacts\agent-profiles-0.1.0.tgz
npx --no agent-profiles inspect --json
npx --no agent-profiles init --agent opencode
npx --no agent-profiles doctor
npx --no agent-profiles configure
npx --no agent-profiles resolve --host opencode --model opencode/big-pickle --identity-source user --role reviewer
npx --no agent-profiles proof --host opencode --model opencode/big-pickle --role reviewer --json
```

Setup, routing, proof and stamp operations do not launch models or configure
credentials. A live OpenCode request uses the provider configured in OpenCode and
may incur its normal charges. Start a new OpenCode session in the project root
after setup. The repository's selected profile, role and required instruction
skills are resolved by the bootstrap command; native skills are invoked separately.

`init` adds an OpenCode-specific marker pair to root `AGENTS.md`. Codex retains
its own managed pair, including when both use that same file. Repeated setup is
idempotent. Neither host's setup edits `opencode.json`, JSONC, providers, agents,
permissions, global instructions or credentials. Existing bytes outside managed
blocks survive update and uninstall, including BOM and CRLF. `uninstall` removes
all installed Agent Profiles blocks while retaining routing configuration by
default; it is not an OpenCode CLI uninstall command.

Both hosts can read `AGENTS.md`; the host condition inside each bootstrap tells
other hosts to skip it. Markers establish installer ownership, not a prompt or
permission sandbox. `AGENTS.override.md` is a Codex selection; this OpenCode
adapter uses `AGENTS.md`. In v2, native global/project `AGENTS.md` and configured
instruction files are additive. More-specific/ancestor rules, configured
instructions and host plugins remain controlled by OpenCode. Start from the
installation root; nested working directories require their own loading check.

## Identity, agents and sessions

Keep the exact **provider/model** string. An operator-supplied ID uses
`--identity-source user`; `host-stated` means the host actually stated the ID to
the agent. If it states no ID, omit model and provenance rather than inventing
them. Unknown model IDs use the existing configured fallback; they do not cause
automatic model selection or substitution. Aliases/families work only when
explicitly configured in Agent Profiles.

An OpenCode agent maps to an Agent Profiles role only through an explicit user
assignment or agent prompt. `build` does not automatically mean `worker`; `plan`
does not imply a role. A child must resolve its own role and actual model.
Resuming a child retains history. Model variants belong in external evaluation
conditions; they are not a separate stamp assignment field.

**Start a new native session after changing model, agent or role when clean
context is required.** Switching within a session, compaction, or rerunning
`resolve` cannot erase earlier profile text. Reload OpenCode after modifying
native configuration/skill files, then start the new session. Agent Profiles
cannot enforce host session lifecycle or attest that an arbitrary external run
followed this protocol. Do not label a resumed or switched session as fresh.

## Native skills

Canonical project bindings address `.opencode/skills/<id>/SKILL.md` by **directory
ID**, not frontmatter display name:

```yaml
skills:
  review:
    host: opencode
    scope: project
    id: check-changes
```

This addresses `.opencode/skills/check-changes/SKILL.md`. The file is verified
locally and captured in a stamp; its body is not injected as a portable skill.
User bindings use `scope: user` and remain host-provided, invocation-unverified.
External inventory is opt-in and reads bounded metadata from native global
`skill`/`skills` roots under the OpenCode configuration directory. It honors
`OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME` for inventory; explicitly approved roots
can describe additional local sources. Directory IDs with multiple inventoried
origins are not independently selectable. Project/user duplicate IDs are also
reported as ambiguous instead of promising an origin the native ID cannot name.

This is a bounded inventory, not a replacement for OpenCode's resolver. V2 also
loads compatible `.agents`/`.claude` sources, configured paths/URLs, singular
directories, flat markdown and nested skills. Those layouts are not canonical
project bindings here; use unique IDs and inspect OpenCode's actual inventory.
Host overrides and additional roots can change invocation. Roles do not hide
native skills or restrict their permissions, and metadata discovery does not
prove a native tool invocation.

## Stamps and evaluated changes

Use `--host opencode` consistently for `stamp` and `migrate start`, retaining the
same exact provider/model and explicit role. OpenCode assignments use the existing
skill-entrypoint fork, proposal, candidate, paired plan/results and explicit
preview/promotion commands; no Codex alias or new record format is involved.
See [skill migrations](../skill-migrations.md) and the
[Harness² conversion reference](harness2.md). Broader profile/role candidates
remain outside the supported candidate contract.

Harness² OpenCode captures now retain host `opencode`, and paired plans bind that
assignment to substrate `opencode`. Its pinned executor is distinct from the
standalone v2 CLI. Old null-host captures and old run IDs are immutable historical
evidence: recapture under fresh namespaces instead of relabeling them. Models,
search, judgment and promotion remain explicit external/user actions.

## Assistant setup prompt

> Set up Agent Profiles for OpenCode v2.1.3 in this project. Inspect first, then
> use the trusted local package to initialize `--agent opencode`. Preserve user
> instructions and all OpenCode JSON/JSONC and credentials. Ask for the exact
> provider/model and explicit Agent Profiles role if absent; never infer a role
> from build/plan or a model from a display name. Run doctor, resolve and proof
> with host opencode and honest identity provenance. Report unknown-model fallback
> and any unsatisfied native skills. Require a new OpenCode session for clean
> model/agent/role changes. Do not launch a model without authorization or claim
> role-based native skill isolation. Use fresh evidence for migration/evaluation.
