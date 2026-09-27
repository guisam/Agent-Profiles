# Installer CLI

Agent Profiles requires Node.js 22 or newer. The CLI exposes `init`, `configure`,
`doctor`, and `uninstall`, plus [presets](presets.md) and [context proof](proof.md).
The [configure guide](configure.md) covers the role/skill
wizard; this guide covers installation and removal.

## Run from a checkout or local package

```sh
npm ci
node bin/agent-profiles.js init --root /path/to/repository
node bin/agent-profiles.js doctor --root /path/to/repository
node bin/agent-profiles.js uninstall --root /path/to/repository
```

Without `--root`, commands walk upward from the working directory to the nearest
`.git` directory or worktree `.git` file. If no Git root is found, supply an
explicit directory. The resolved target is printed before making changes.

The npm package contains the executable, resolver, and scaffold. It does not
need a build step. To test the package before publishing:

```sh
npm pack
npx --yes --package /absolute/path/agent-profiles-0.1.0.tgz agent-profiles init --root /path/to/repository
```

After a separate publication step, the entry point will be
`npx agent-profiles init`. This implementation does not publish anything or
install a dependency into the target repository's `package.json`.

## Init

Interactive `init` offers `claude` and `codex` as comma-separated choices. Known
instruction files and `.claude`/`.codex` directories suggest defaults; detection
does not prove an agent is in use. Enter a different list to change the selection.
Choose at least one agent. In scripts or CI, specify choices explicitly:

```sh
agent-profiles init --agent claude --agent codex
```

A fresh install copies the small checked-in `.agent-profiles/` scaffold,
including its portable `BOOTSTRAP.md`, three profiles, three roles, and two
illustrative skills. The default is `constrained` plus `implementer`. It then
inserts a marked bootstrap block into the selected host instruction files and
validates the installation using the existing resolver.

Re-running init keeps existing configuration, profiles, roles, skills, and managed
blocks unchanged. Additional agents can be selected later. A valid older
configuration can receive a missing `BOOTSTRAP.md` without replacing other files.
A nonempty `.agent-profiles/` without `agents.yaml`, or invalid existing
configuration, is reported for manual repair rather than overwritten.

## Adapters

The small adapter table lives in [integrations.js](../src/integrations.js).
Shared editing and validation stay in [install.js](../src/install.js).

| Agent ID | Instruction target |
| --- | --- |
| `claude` | Existing managed location, otherwise existing `CLAUDE.md`, then `.claude/CLAUDE.md`; creates root `CLAUDE.md` when neither exists |
| `codex` | Nonempty root `AGENTS.override.md`, otherwise root `AGENTS.md` |

These paths follow the official [Claude Code memory documentation](https://code.claude.com/docs/en/memory)
and [OpenAI instruction-file documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
Global settings, custom instruction filenames, per-directory installations, and
additional agent products are outside this first adapter set. Host exclusions
and instruction size limits still apply. Restart the host session after install.

The portable bootstrap preserves repository rules and directs agents to read
root `AGENTS.md` once if it was not supplied by the host. It then follows the
configuration routing protocol; it does not run an agent or execute skill tools.

## Integration contract

An adapter is one record in `integrations` with a unique `id`, display `name`,
repository-relative detection `hint`, ordered instruction `files`, and a pure
`select(records)` function returning one of those paths. Each record supplied
to `select` contains `file`, `before` (a Buffer or null), and `span` (the managed
block range or null). Missing targets must have a deterministic default. Path
precedence belongs here, not in the resolver or shared bootstrap.

| Conceptual operation | Implementation |
| --- | --- |
| `detect()` | `integrationState` checks known files and the adapter's hint |
| `instructionTarget()` | Adapter `select(records)` chooses the host-readable path |
| `isInstalled()` | `managedSpan` plus duplicate/shadow checks in `integrationState` |
| `installBootstrap()` | Shared `install` validates, plans, writes, then runs doctor |
| `removeBootstrap()` | Shared `uninstall` visits every adapter path and removes only managed spans |

To add a host, verify its official instruction-loading rules, add the record,
document its precedence, and test fresh files, existing files, reruns, overrides,
and uninstall. Agent choices and detection derive from this table. The current
contract assumes local Markdown instruction files; a host requiring a different
mechanism needs a separately designed adapter extension, not shared-bootstrap
workarounds. No routing changes should be necessary.

The shared bootstrap deliberately contains no host commands or assumed model
identity. The installed protocol can be followed by reading local files without
a global CLI. It preserves host instruction precedence, separates model identity
from role assignment, and keeps available skill bodies out of initial context.
See the [release checklist](release.md) for live-session verification: automated
tests prove file and resolver behavior, not host compliance with instructions.

## Managed blocks and failure safety

Blocks use exactly `<!-- agent-profiles:start -->` and
`<!-- agent-profiles:end -->`. Existing file bytes, including BOMs and line
endings, are retained. All newly added whitespace is inside the markers; if an
existing file has no final newline, the opening HTML comment follows its last
character. Removing the block restores all surrounding bytes exactly. Empty
instruction files left by uninstall are retained because they may be user-owned.

Malformed or repeated marker pairs require manual repair. A Codex block shadowed
by a newly added override is reported; uninstall followed by init relocates it
without editing unrelated rules. Existing blocks are not automatically upgraded.

The installer validates source configuration and checks targets before writing.
Writes use temporary sibling files and rename; detected failures roll completed
writes back. If rollback cannot finish, the error identifies affected files and
directs the user to doctor. Concurrent changes detected between planning and
writing abort the operation. This is not a filesystem transaction or a guarantee
against concurrent editors or process termination; review reported failures.
Linked mutation targets are rejected rather than writing through them.

## Doctor

`agent-profiles doctor` reuses `resolveInstructions` to validate every declared
profile, role, skill source, and metadata reference. It reports defaults and each
supported integration's location/status. Missing protocol files, malformed blocks,
shadowed integrations, and a configuration with no active integration produce
actionable errors and exit status 1. Unselected agents are simply reported as
not installed. Doctor never modifies files.

## Uninstall

`agent-profiles uninstall` removes managed blocks from all known adapter paths,
including shadowed locations, and preserves `.agent-profiles/`. It also works
when the routing configuration is broken. Unrelated instructions are untouched.

For complete removal, explicitly request:

```sh
agent-profiles uninstall --delete-config
```

The CLI asks you to type `delete .agent-profiles` before changing anything.
Declining, closing the prompt, or running without an interactive terminal makes
no changes. Configuration deletion is recursive and irreversible; external skill
resources referenced elsewhere in the repository are retained. Linked descendants
are rejected before removal. If deletion itself fails, the CLI reports that
integrations were removed and identifies the remaining deletion error.

The prompt-free APIs are `install({root, agents})`, `doctor(root)`, and
`uninstall({root, deleteConfig, confirmed})`. Programmatic deletion requires both
boolean flags to be true; callers must obtain explicit confirmation first.
