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
```

After publication, from your Git repository, the same workflow will be:

```sh
npx agent-profiles init
npx agent-profiles configure
npx agent-profiles doctor
```

`init` asks which agents to enable and adds a small bootstrap block to their
instruction files. `configure` creates, edits, or deletes roles and lets you
select required and available local skills. `doctor` checks configuration and
integration status. Use `--help` for options; scripts can initialize with
`--agent claude --agent codex`. Use `--root` for a directory outside Git.

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

## Scope

Agent Profiles is a small convention and CLI for composing additional instruction
layers around repository instructions. It is not an agent framework, orchestrator,
model router, prompt marketplace, benchmark, collection of universally optimal
prompts, replacement for `AGENTS.md`, or skill registry. It does not choose or
launch models, score their capabilities, or run multi-agent workflows.

Presets, local environment profiles, context-weight estimates, and visualization
are future work, outside v0.1.0.

## Further reading

- [Role and skill configuration](docs/configure.md)
- [Architecture and schema](docs/architecture.md)
- [Bootstrap protocol and resolver examples](docs/bootstrap.md)
- [Contributing and development checks](CONTRIBUTING.md)
- [Release checklist and verification limits](docs/release.md)
- [Changelog](CHANGELOG.md)

Licensed under [Apache-2.0](LICENSE).
