# Agent Profiles

Different models need different instructions. Different roles need different
skills. Agent Profiles gives each agent only the additional context it needs.

A shared `AGENTS.md` is useful for repository facts and conventions. But putting
every model accommodation, job description, and skill into it gives agents
instructions intended for other tasks. Agent Profiles separates those layers
in local, reviewable files, with a small CLI for setup and configuration.

## Quick start

Requires **Node.js 22 or newer**. Supports **Claude Code and OpenAI Codex**.

**v0.1.0 is being prepared; it has not been published to npm.** Try this checkout
now with `npm ci`, then run these commands with the path to your project:

```sh
node bin/agent-profiles.js init --root /path/to/project
node bin/agent-profiles.js configure --root /path/to/project
node bin/agent-profiles.js doctor --root /path/to/project
node bin/agent-profiles.js proof --root /path/to/project --role reviewer
```

After publication, from your Git repository, the same workflow will be:

```sh
npx agent-profiles init
npx agent-profiles configure
npx agent-profiles doctor
npx agent-profiles proof --role reviewer
```

`init` asks which agents to enable and adds a small bootstrap block to their
instruction files. `configure` creates, edits, or deletes roles and lets you
select required and available local skills. `doctor` checks configuration and
integration status. Use `--help` for options; scripts can initialize with
`--agent claude --agent codex`. Use `--root` for a directory outside Git.

| Command | Purpose |
| --- | --- |
| `init` | Select agents, preserve their existing instructions, and install the local scaffold |
| `configure` | Create/edit/delete roles and select required or available skills |
| `doctor` | Validate configuration, local references, and integration status |
| `proof` | Measure selected instruction bytes/characters and available context not loaded |
| `preset inspect/import/export` | Review and share local configurations with explicit conflict handling |
| `uninstall` | Remove managed bootstrap blocks while retaining user configuration |

```text
your-project/
  AGENTS.md                   # repository rules + Codex bootstrap
  CLAUDE.md                   # Claude bootstrap
  .agent-profiles/
    agents.yaml               # model mappings, roles, skill references
    BOOTSTRAP.md               # portable routing protocol
    profiles/                 # autonomous, scaffolded, constrained
    roles/                    # implementer, reviewer, researcher
    skills/                   # code-review and testing examples
```

Only selected agents receive integrations; existing supported alternate files
are respected. Initialization preserves existing instructions and user-edited
configuration. Review the generated files before committing, then restart your
agent session. Assign a role explicitly, or use the configured default.

To remove integration blocks while keeping your configuration:

```sh
node bin/agent-profiles.js uninstall --root /path/to/project
```

See the [installer guide](docs/installer.md) for packed-package installation,
target-file selection, and explicitly confirmed configuration deletion.

## The layers

| Layer | Purpose | When loaded |
| --- | --- | --- |
| Repository instructions | Facts, conventions, and invariants in `AGENTS.md` | Always, through the host |
| Model profile | Scaffolding or accommodations configured for a model | One selected profile |
| Role | Instructions for the job being performed | One assigned or default role |
| Required skills | Specialized instructions always needed for that role | With the role |
| Available skills | Other relevant skills the role may use | Metadata first; instructions on demand |

Profile resolution is deterministic: **exact model → supplied family → configured
default**. Role selection is independent. Models may identify themselves; models
do not grade themselves. Unknown identities receive the fallback profile.

The complete [example configuration](.agent-profiles/agents.yaml) routes
`example-model` to `autonomous`, `example-family` to `scaffolded`, and unmatched
identities to `constrained`. A `reviewer` loads `code-review` and sees `testing`
metadata until that skill is needed. The model names, three short profiles, and
three roles demonstrate the mechanism; they are not capability rankings or
universally optimal prompts. Adapt them to your workflow.

Skills live in `.agent-profiles/skills/<id>/SKILL.md` or another explicitly mapped
repository path. The [wizard](docs/configure.md) also discovers Claude-local
skills. Skill frontmatter supplies names and descriptions. No remote instruction
source is fetched or silently installed, and Agent Profiles never executes skill
instructions. Treat local configuration as code-like repository content.

These are instructions for the host to follow, not a context or permission
sandbox. Built-in host skills, global instructions, and host-managed context
remain outside Agent Profiles' control.

## Measure the selected context

```sh
node bin/agent-profiles.js proof --model example-model --role reviewer
node bin/agent-profiles.js proof --model example-model --role reviewer --skill testing
```

`proof` shows each profile, role, required skill, and requested skill with exact
UTF-8 byte and Unicode character counts. Requesting `testing` moves its size from
**available, not loaded** into the managed total. Add `--json` for machine-readable
output; the same diagnostics are available through the resolver API.

These totals cover resolved instruction bodies, not the complete agent context.
Repository instructions remain host-supplied; hidden system prompts, built-in
skills, and other host context remain unobserved. Bootstrap text and metadata
rendering are outside the measured total. Tokens are explicitly **not calculated**,
and unloaded context is not labeled as savings without a comparison baseline.
See [context proof](docs/proof.md) for the accounting contract.

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

The local workflow now includes deterministic routing, Claude Code/Codex setup,
role and skill configuration, shareable presets, and context diagnostics. No
runtime dependencies were added for presets or accounting; YAML handling remains
the CLI's single runtime dependency. See the [release checklist](docs/release.md)
for platform and live-host verification before publication.

Agent Profiles is a small convention and CLI for composing additional instruction
layers around repository instructions. It is not an agent framework, orchestrator,
model router, prompt marketplace, benchmark, collection of universally optimal
prompts, replacement for `AGENTS.md`, or skill registry. It does not choose or
launch models, score their capabilities, or run multi-agent workflows.

Local environment profiles, token accounting, and visualization remain future work.

## Further reading

- [Role and skill configuration](docs/configure.md)
- [Shareable presets](docs/presets.md)
- [Context proof and accounting boundaries](docs/proof.md)
- [Architecture and schema](docs/architecture.md)
- [Bootstrap protocol and resolver examples](docs/bootstrap.md)
- [Contributing and development checks](CONTRIBUTING.md)
- [Release checklist and verification limits](docs/release.md)
- [Changelog](CHANGELOG.md)

Licensed under [Apache-2.0](LICENSE).
