# Hermes Agent adapter

Agent Profiles supports Hermes through a **repository-local bootstrap adapter**.
It composes additional model instructions, an assigned role, and portable skills.
It does not create, select, or configure Hermes runtime profiles.

## Two different meanings of profile

| Term | Owner and purpose | Where it lives |
| --- | --- | --- |
| **Model instruction profile** | Agent Profiles: accommodations for the model performing a repository task | `.agent-profiles/profiles/*.md`, selected by `agents.yaml` |
| **Hermes runtime profile** | Hermes: an assistant's persistent configuration, personality, memory, credentials, sessions, skills, and other state | The active Hermes home, selected by Hermes |

One Hermes runtime profile can consume different Agent Profiles model instruction
profiles in different projects or fresh contexts. Multiple Hermes runtime profiles
can use the same checked-in Agent Profiles configuration. A role such as `reviewer`
is another independent input; it is not either kind of profile.

The existing YAML field `profile` and JSON result `profile` continue to mean
**model instruction profile**. Their names are unchanged for compatibility.
They are never passed to `hermes -p`, `hermes profile`, or a Hermes configuration command.

## Install from a checkout or a shared package

Requires Node.js 22 or newer. Until publication, use a tarball built from the
checkout containing this adapter; an older `0.1.0` tarball does not contain it.
The development package version is still `0.1.0`: equality of version strings is
not proof that two tarballs contain the same code. Share the actual tested artifact.

From the Agent Profiles checkout, `npm pack --pack-destination <output-directory>`
builds that artifact without publishing it. The output directory must exist.
In the target repository, install the tarball, then initialize only the host you want:

```sh
npm install --save-dev /path/to/agent-profiles-0.1.0.tgz
npx --no agent-profiles init --agent hermes
npx --no agent-profiles doctor
npx --no agent-profiles configure
```

The tarball may have a descriptive local filename; npm reads the package name and
version from inside it. On Windows, use a quoted path when it contains spaces.

Alternatively, from the checkout:

```sh
node bin/agent-profiles.js init --root /path/to/project --agent hermes --package /path/to/agent-profiles-0.1.0.tgz
```

To enable all supported hosts, repeat `--agent` for `claude`, `codex`, and `hermes`.
Initialization preserves existing supported instruction files and routing
configuration. Review the generated files before committing, and start a new
Hermes session afterward. Nothing is published or sent to another person by init.

## Project instructions and working directory

The adapter installs its managed block into:

1. Root `.hermes.md`, if that file already exists, even if empty.
2. Otherwise root `HERMES.md`, if that file exists.
3. Otherwise a new root `.hermes.md`.

This follows Hermes's priority between the two spellings. When both exist,
`.hermes.md` wins. Doctor reports a bootstrap in `HERMES.md` shadowed by a newly
added `.hermes.md`; uninstall followed by init relocates the managed block.
Existing bytes, BOMs, line endings, and content outside the markers are preserved.
Uninstall removes only the managed blocks and retains the routing configuration.

Hermes searches for the nearest `.hermes.md` / `HERMES.md` up to the Git root.
A more-specific Hermes context file can shadow the root bootstrap. This adapter
installs at the selected root only; it does not edit every package in a monorepo.
Start in that root, or explicitly supply the bootstrap in the fresh task context.
For non-Git projects, start at the installation directory; do not assume a parent
instruction file will be discovered.

Hermes loads only one project context type. Adding `.hermes.md` can therefore
replace automatic loading of an `AGENTS.md` chain, `CLAUDE.md`, or Cursor rules.
The managed block explicitly asks the agent to preserve the host's shared-rule
selection and fallback boundaries:

1. Walk from the Git root through the working directory (working directory only
   outside Git). At each directory, read the first readable **nonempty** file in
   order: `AGENTS.override.md`, `AGENTS.md`, `agents.md`. Empty or unreadable files
   fall through to the next name; keep deeper, more-specific repository rules.
2. If the **entire** AGENTS chain has no nonempty content, try `CLAUDE.md` then
   `claude.md` in the working directory only, skipping empty or unreadable files.
3. If neither Claude file has content, read all readable nonempty `.cursorrules`
   and `.cursor/rules/*.mdc` files in the working directory only.

For example, an empty `AGENTS.override.md` does not suppress a nonempty `AGENTS.md`,
and an empty `AGENTS.md` does not suppress a nonempty `agents.md`. An all-empty
AGENTS chain must still fall back to Claude or Cursor content when available.
Existing Hermes-specific user instructions remain in place.
Reading those shared rules is a **bootstrap expectation**, not enforced loading.

Launch Hermes in the target project, not the Agent Profiles package directory.
In Desktop, select the target project/workspace and check the terminal working
directory. A Hermes runtime profile with an explicit `terminal.cwd` can override
the launch directory. The adapter does not change that setting for you.

## Identity and assigned roles

The managed block asks Hermes to run:

```sh
npx --no agent-profiles resolve --host hermes --identity-source host-stated --model "<exact model ID>"
```

Use only the exact ID stated by the current host for the current agent. Do not
substitute a UI label, a remembered model name, a default from another profile,
or the parent's ID for a differently configured child. If no exact identity is
stated, omit `--model` and `--identity-source`; the configured fallback applies.
The `host-stated` provenance is a relay claim, not an attestation.

Assign a role explicitly in the new session or delegated task, for example:

```text
Use Agent Profiles role reviewer. Before reviewing, run:
npx --no agent-profiles resolve --host hermes --role reviewer
If your host states your exact model ID, add --identity-source host-stated
and --model with that exact ID. Follow the result, then review the assigned scope.
```

A default role is used when none is assigned. An assignment does not grant new
permissions or authorize a ticket transition. Resolver errors must be reported;
`--no` prevents the bootstrap from downloading a package to work around a failure.

Use `proof --host hermes --model <exact-id> --role <role>` to inspect a route.
`resolve --json --contents` provides the resolved bodies for an integration;
it does not itself inject them into Hermes's system prompt.

## Skills and host boundaries

Required portable instruction skills enter the resolver output. Available skills
are listed with descriptions and paths; their bodies enter that output only when
requested. Existing local skills can be referenced without copying them:

```yaml
skills:
  task-checks:
    file: .agents/skills/task-checks/SKILL.md
```

Map that ID to a role's `required` or `available` list. The local Markdown skill
must have the metadata required by Agent Profiles.

This first Hermes adapter does **not** add `{host: hermes, ...}` native-skill
bindings, import skills into Hermes, or alter the host's skill catalog. Native
Hermes skills, discovery, project trust, security scanning, enable/disable rules,
and invocation remain Hermes-owned. Referencing a file as an instruction skill
is not evidence that Hermes registered or invoked it as a native skill.
Claude-native skills are incompatible with Hermes: available ones are omitted
from agent-facing output; required ones are reported as unsatisfied. Do not
silently substitute a same-named Hermes skill.

The adapter cannot hide previously loaded instructions or prevent an agent from
reading other files. It is not a context, skill-visibility, or permission sandbox.
Host-required instructions and restrictions continue to apply.

## Lifecycle and verification limits

Start fresh contexts for clean model/role changes. Re-running resolve states that
its result supersedes previous Agent Profiles instructions, but cannot remove
text already in the conversation. The bootstrap requests re-resolution after
compaction and model changes; no native lifecycle hook is installed.

Hermes subagents need the correct workspace context and an explicit role assignment.
Receiving the root bootstrap and obeying it are host/agent behavior, not guaranteed
by this adapter. A fresh subagent conversation is not a new Hermes runtime profile.

Automated checks cover resolver/CLI behavior, filename priority, shadow detection,
byte-preserving installation/removal, coexistence with Claude/Codex, and the packed
npm artifact. They do not prove live model obedience, exact identity exposure,
compaction/model-switch re-resolution, or native skill invocation. Doctor's
"ready" result concerns local installation/composition, not those live behaviors.
Native context construction/filtering would be a separate integration.

The adapter never writes `HERMES_HOME`, `SOUL.md`, Hermes configuration, memories,
credentials, or sessions, and never launches a model. Explicit `init --package`
or npm installation does modify the target project's package dependency files.

## Official host references

Instruction discovery was checked against the official Hermes documentation and
installed host source; re-check when the host changes:

- [Context files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files)
- [Hermes runtime profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)
- [Skills system](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- Host source: `agent/prompt_builder.py`, `agent/skill_utils.py`, and `tools/delegate_tool_progress.py`.

For core guarantees and the portable protocol, see [architecture](../architecture.md),
[bootstrap](../bootstrap.md), and [installer](../installer.md).
