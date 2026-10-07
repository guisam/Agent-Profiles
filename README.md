# Agent Profiles

Different models need different instructions. Different roles need different
skills. Agent Profiles resolves only the additional context each agent needs.

A shared `AGENTS.md` is useful for repository facts and conventions. But putting
every model accommodation, job description, and skill into it gives agents
instructions intended for other tasks. Agent Profiles separates those layers
in local, reviewable files, with a small CLI for setup and configuration.

## Quick start

Requires **Node.js 22 or newer**. Supports **Claude Code, OpenAI Codex, and Hermes Agent**
(Claude Code verified live; Codex and Hermes live bootstrap behavior not yet observed).

**v0.1.0 is being prepared; it has not been published to npm.** Try this checkout
now with `npm ci` and `npm pack`, then run these commands with the path to your
project. `--package` installs the packed tarball into the project so the bootstrap
command can run there:

```sh
node bin/agent-profiles.js init --root /path/to/project --package ./agent-profiles-0.1.0.tgz
node bin/agent-profiles.js configure --root /path/to/project
node bin/agent-profiles.js doctor --root /path/to/project
node bin/agent-profiles.js proof --root /path/to/project --role reviewer
node bin/agent-profiles.js visualize --root /path/to/project
```

After publication, from your Git repository, the same workflow will be:

```sh
npm install --save-dev agent-profiles
npx agent-profiles init
npx agent-profiles configure
npx agent-profiles doctor
npx agent-profiles proof --role reviewer
npx agent-profiles visualize
```

`init` asks which agents to enable and adds a small bootstrap block to their
instruction files. The block asks the agent to run `npx --no agent-profiles resolve`
with the exact model ID its host states. Code does all routing, and the agent
follows the printed result. For Claude Code, `init` also allows exactly that command
in `.claude/settings.json`. It exits nonzero until the local bootstrap executable
and matching version are verified (see
[bootstrap setup](docs/bootstrap.md#host-setup)). `configure` creates, edits, or deletes
roles and lets you select required and available local skills. `doctor` answers three
separate questions: is the configuration valid, can the bootstrap run here, and can
each role's required host skills belong to every installed host. Actual native
invocation remains host-controlled. Use `--help` for options; scripts can initialize with
`--agent claude --agent codex`. Use `--root` for a directory outside Git.

| Command | Purpose |
| --- | --- |
| `init` | Select agents, preserve their existing instructions, and install the local scaffold |
| `configure` | Create/edit/delete roles and select required or available skills |
| `doctor` | Validate configuration, local references, host skills, and integration capabilities |
| `resolve` | Print the resolved instructions an agent follows; `--json` for integrations |
| `proof` | Measure selected instruction bytes/characters and available context not injected |
| `visualize` | Explore model/role composition, project skill requests, and compare context locally |
| `preset inspect/import/export` | Review and share local configurations with explicit conflict handling |
| `uninstall` | Remove managed bootstrap blocks while retaining user configuration |

```text
your-project/
  AGENTS.md                   # repository rules + Codex bootstrap
  CLAUDE.md                   # Claude bootstrap
  .hermes.md                  # Hermes bootstrap, when selected (existing HERMES.md respected)
  .agent-profiles/
    agents.yaml               # model mappings, roles, skill references
    BOOTSTRAP.md              # protocol reference (agents do not need to read it)
    profiles/                 # autonomous, scaffolded, constrained
    roles/                    # implementer, reviewer, researcher
    skills/                   # code-review and testing examples
```

Only selected agents receive integrations; existing supported alternate files
are respected. Initialization preserves existing instructions and user-edited
configuration. Review the generated files before committing, then restart your
agent session. Assign a role explicitly, or use the configured default. For a
clean per-role session in Claude Code, use a [custom agent](docs/bootstrap.md#roles).

To remove integration blocks while keeping your configuration:

```sh
node bin/agent-profiles.js uninstall --root /path/to/project
```

See the [installer guide](docs/installer.md) for packed-package installation,
target-file selection, and explicitly confirmed configuration deletion.

## The layers

| Layer | Purpose | Delivered |
| --- | --- | --- |
| Repository instructions | Facts, conventions, and invariants in `AGENTS.md` | By the host |
| Model profile | Scaffolding or accommodations configured for a model | One selected profile, injected |
| Role | Instructions for the job being performed | One assigned or default role, injected |
| Required skills | Specialized instructions for all work in the role | Injected, or invoked for host skills |
| Available skills | Other skills the role may use | Listed; used only when the task falls within the skill's description |

Profile resolution is deterministic: **exact model → configured alias → supplied
family → longest configured family prefix → default**. Role selection is
independent. Models copy the identity their host states; they do not grade
themselves or guess. Unknown identities receive the fallback profile.

The complete [example configuration](.agent-profiles/agents.yaml) routes
`example-model` to `autonomous`, `example-family` to `scaffolded`, and unmatched
identities to `constrained`. A `reviewer` receives `code-review` and sees `testing`
listed until a task needs it. The model names, three short profiles, and
three roles demonstrate the mechanism; they are not capability rankings or
universally optimal prompts. Adapt them to your workflow.

Skills live in `.agent-profiles/skills/<id>/SKILL.md` or another explicitly mapped
repository path. Claude Code skills in `.claude/skills/` can be assigned as
host-native skills: Agent Profiles asks the agent to invoke them through Claude Code
and never injects their files. The [wizard](docs/configure.md) discovers both kinds.
Skill frontmatter supplies descriptions and optional names (the directory name is
the fallback). No remote instruction
source is fetched or silently installed, and Agent Profiles never executes skill
instructions. Treat local configuration as code-like repository content.

Agent Profiles guarantees the resolution: the same identity, role, and
configuration always produce the same instructions. In bootstrap mode, running
the command and following its output is up to the agent. Text already in context
cannot be removed, and Claude Code lists every host skill to every role. The
[guarantee levels](docs/architecture.md#guarantee-levels) mark what each
integration mode can ensure. [host-observations.md](docs/host-observations.md)
records what was verified live with Claude Haiku, Sonnet, and Opus; see the
[Claude Code compatibility record](docs/hosts/claude-code.md) and the
[known limitations](docs/architecture.md#known-limitations). Agent Profiles
is not a context or permission sandbox.

## Hermes: model instructions, not runtime profiles

`init --agent hermes` installs a repository-local bootstrap in `.hermes.md` or
an existing `HERMES.md`. A **model instruction profile** in `.agent-profiles/`
is not a **Hermes runtime profile**: it adds model accommodations to a repository
task, while Hermes owns personality, configuration, memory, credentials, sessions,
tools, and its native skill catalog. This adapter never creates or selects a
Hermes runtime profile and never edits `SOUL.md` or `HERMES_HOME`.

Required and available portable skills use the existing resolver. The adapter
does not restrict Hermes's skill visibility or add native Hermes skill bindings.
Use fresh contexts for role/model changes; lifecycle compliance remains a bootstrap
expectation. See the [Hermes adapter and sharing guide](docs/hosts/hermes.md) for
installation, working-directory requirements, instruction precedence, and limits.

## Measure the selected context

```sh
node bin/agent-profiles.js proof --model example-model --role reviewer
node bin/agent-profiles.js proof --model example-model --role reviewer --skill testing
```

`proof` shows each profile, role, required skill, and requested skill with exact
UTF-8 byte and Unicode character counts. Requesting `testing` moves its size from
**available, not injected** into the managed total. Add `--json` for machine-readable
output; the same diagnostics are available through the resolver API.

These totals cover resolved instruction bodies, not the complete agent context.
Repository instructions remain host-supplied; hidden system prompts, built-in
skills, and other host context remain unobserved. Host-native skills are listed
but never counted. The bootstrap block is reported on its own line, outside the
managed total. Tokens are explicitly **not calculated**,
and unloaded context is not labeled as savings without a comparison baseline.
See [context proof](docs/proof.md) for the accounting contract.

## Explore context visually

```sh
node bin/agent-profiles.js visualize --model example-model --role reviewer
```

Open the printed local URL. Select a model, family fallback, and role to see
their instruction layers. Check an available skill to preview its contribution;
expand an entry to inspect its path, measurements, and loaded source text.
Pin a resolution to compare it with another selection. The numbers come directly
from the same resolver used by `proof`.

The visualizer is read-only, stays on your machine, and makes no configuration
changes. Stop the server with **Ctrl+C**. See the [visualizer guide](docs/visualize.md)
for refresh behavior, accounting boundaries, and the local JSON endpoints.

## Share a configuration

Local presets can share roles, profiles, and skill assignments across projects:

```sh
node bin/agent-profiles.js preset inspect /path/to/preset --contents
node bin/agent-profiles.js preset import /path/to/preset --root /path/to/project
node bin/agent-profiles.js preset export /path/to/new-preset --root /path/to/project
```

Imports preview changes, require explicit conflict choices and confirmation,
and leave ordinary editable configuration. See [presets](docs/presets.md) for
the local format, dependency handling, provenance, and the small example.

Try the included [release-review preset](examples/presets/release-review/preset.yaml)
with `preset inspect examples/presets/release-review --contents`. Presets may
include Markdown skills or declare exact local dependencies; imports never
download missing skills. Roles remain editable through the same wizard after
import, and their origins are recorded separately.

## Scope and status

The local workflow now includes deterministic routing, Claude Code/Codex/Hermes setup,
role and skill configuration, shareable presets, context diagnostics, and a local
visualizer. No runtime dependencies were added for these features; YAML handling remains
the CLI's single runtime dependency. See the [release checklist](docs/release.md)
for platform and live-host verification before publication.

Agent Profiles is a small convention and CLI for composing additional instruction
layers around repository instructions. It is not an agent framework, orchestrator,
model router, prompt marketplace, benchmark, collection of universally optimal
prompts, replacement for `AGENTS.md`, or skill registry. It does not choose or
launch models, score their capabilities, or run multi-agent workflows.

Local environment profiles and token accounting remain future work.

## Further reading

- [Role and skill configuration](docs/configure.md)
- [Shareable presets](docs/presets.md)
- [Context proof and accounting boundaries](docs/proof.md)
- [Local context visualizer](docs/visualize.md)
- [Architecture and schema](docs/architecture.md)
- [Bootstrap protocol, host setup, and resolver API](docs/bootstrap.md)
- [Live-host observations](docs/host-observations.md)
- [Contributing and development checks](CONTRIBUTING.md)
- [Release checklist and verification limits](docs/release.md)
- [Changelog](CHANGELOG.md)

Licensed under [Apache-2.0](LICENSE).
