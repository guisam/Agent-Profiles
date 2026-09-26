# Agent Profiles

Agent Profiles is a small configuration layer for giving different AI coding agents different instructions, roles, and skills without putting everything into `AGENTS.md`.

> **TL;DR:** Keep your common project instructions in `AGENTS.md`. Agent Profiles adds model-specific instructions, role-specific instructions, and role-specific skills on top of them. Agents only load the layers that apply to them.

## Why?

`AGENTS.md` gives coding agents a common place to find project instructions.

The problem is that different models do not always benefit from the same instructions.

A smaller or local model may need explicit steps and verification instructions. A stronger model may perform better with less scaffolding. Instructions written around the behavior of an older model may be unnecessary or counterproductive for a newer one.

There is a second problem: not every agent working on a project has the same job.

An implementation agent, code reviewer, researcher, and security reviewer may need different instructions and different skills.

Putting all of this into one file eventually means every agent receives instructions that were written for other models and other jobs.

Agent Profiles separates those concerns.

## How it works

Agent Profiles builds the agent's additional context from a few layers:

```text
AGENTS.md
    +
model profile
    +
role
    +
required skills
    +
available skills when needed
```

`AGENTS.md` remains the place for instructions that apply to everyone working in the repository.

A **model profile** contains instructions that are useful for a particular model or class of models.

A **role** describes the job the agent is performing.

A **skill** contains specialized instructions that a role may need.

For example:

```text
Claude + reviewer
  profile: autonomous
  role: reviewer
  required: code-review
  available: security, testing

Qwen + implementer
  profile: constrained
  role: implementer
  required: coding-standards
  available: typescript, testing
```

Model and role are separate. The same model can perform several roles, and several models can perform the same role.

## Project structure

A project using Agent Profiles will look roughly like this:

```text
AGENTS.md

.agent-profiles/
├── agents.yaml
├── profiles/
│   ├── autonomous.md
│   ├── scaffolded.md
│   └── constrained.md
├── roles/
│   ├── implementer.md
│   ├── reviewer.md
│   └── researcher.md
└── skills/
```

`agents.yaml` maps models to profiles and defines the roles and skills available in the project.

See the complete [example configuration](.agent-profiles/agents.yaml) and the
[version 1 architecture and schema](docs/architecture.md). The example includes
three model profiles, three independent roles, and two local skills. Unknown
models without a matching family receive its `constrained` default profile.

To explore the scaffold, start with `agents.yaml`, then follow the architecture
document's resolution examples to the referenced Markdown files. The
[bootstrap protocol](docs/bootstrap.md) documents the runnable resolver and a
reusable instruction block. The schema may evolve during initial development.

With Node.js 22 or newer, inspect the selected instruction layers locally:

```sh
npm ci
npm test
npm run resolve -- --model example-model --role reviewer
```

Add `--contents` to include loaded instruction text. Available skills are listed
with names, descriptions, and paths; their bodies stay unloaded until requested
with `--skill <id>`. This command validates configuration and resolves
instructions; agent-specific integrations will supply them to an agent session.

## Model routing

Models do not choose their own capability level.

Agent Profiles resolves profiles in this order:

```text
exact model
    ↓
model family
    ↓
default profile
```

The agent can identify which model it is running as. The project configuration determines which profile that model receives.

Unknown models use the configured default.

## Roles and skills

Roles define what an agent is doing.

A project might have:

```text
implementer
reviewer
researcher
architect
security-reviewer
```

There is no required set of roles. Projects define the roles they need.

Skills assigned to a role are divided into two groups.

**Required skills** are loaded whenever the role is active.

**Available skills** can be loaded when the task requires them.

For example:

```yaml
reviewer:
  skills:
    required:
      - code-review

    available:
      - testing
      - security-review
      - typescript
```

A reviewer always gets the `code-review` instructions.

It knows that `testing`, `security-review`, and `typescript` are available, but those instructions are not loaded unless they are relevant to the task.

This is intended to keep agent context smaller.

Skills can live in `.agent-profiles/skills/<id>/SKILL.md` or be referenced from
elsewhere in the repository. Their own YAML frontmatter supplies `name` and
`description`; no metadata copy is needed in the configuration. See the
[local skill schema](docs/architecture.md#local-skills) for path mappings and
validation rules.

To load a skill explicitly for the current task:

```sh
npm run resolve -- --role reviewer --skill testing --contents
```

Only skills declared by the selected role can be requested. Repeating a skill
request does not duplicate its instructions.

## CLI

The planned basic workflow is:

```text
npx agent-profiles init
```

The installer creates the Agent Profiles scaffold and asks which coding agents you use.

For example:

```text
Which coding agents do you use?

[x] Claude Code
[x] OpenAI Codex
[ ] Gemini CLI
[ ] OpenCode
```

Agent Profiles then adds a small bootstrap instruction to the appropriate agent instruction files.

Existing instructions are preserved.

Roles and skills can be configured with:

```text
agent-profiles configure
```

Configuration can be checked with:

```text
agent-profiles doctor
```

And Agent Profiles integration can be removed with:

```text
agent-profiles uninstall
```

These interfaces are planned and may change during initial development.

## Presets

Agent Profiles will also support shareable presets.

A preset is a reusable Agent Profiles configuration created by an individual or team.

For example, a TypeScript preset might define:

```text
implementer
  required: typescript
  available: testing, react

reviewer
  required: typescript-review
  available: testing, performance

architect
  available: api-design
```

This lets people who know a particular language, framework, or workflow publish their preferred agent setup without making those choices part of Agent Profiles itself.

Teams can also maintain private presets for their own projects.

Planned commands include:

```text
agent-profiles preset inspect
agent-profiles preset import
agent-profiles preset export
```

Presets will be inspectable before installation and will not contain executable install hooks.

## Local environments

Some agent instructions depend on the developer's machine rather than the project.

For example, one developer may use:

```text
Windows
PowerShell
pnpm
rg
```

while another uses:

```text
macOS
zsh
pnpm
rg
```

Agent Profiles plans to support a local, gitignored environment configuration for this information.

This keeps machine-specific instructions out of the shared project configuration.

The host environment will also be kept separate from deployment targets. A project that deploys to Linux does not necessarily run its coding agents on Linux.

## Presets and contributions

There are several ways to extend Agent Profiles.

**Agent integrations** teach the installer how to add the Agent Profiles bootstrap to another coding agent.

**Skill source adapters** teach Agent Profiles how to discover skills stored by another agent or tool.

**Presets** package a useful combination of profiles, roles, and skills for a particular workflow.

For example, people or teams could maintain presets for:

```text
TypeScript development
Rust development
Shopify development
security review
frontend development
DevOps
documentation
```

Agent Profiles does not need to decide which of these configurations is best. It provides a common format for defining and sharing them.

## What Agent Profiles does not do

Agent Profiles is not an agent runtime or orchestrator.

It does not:

- spawn agents
- choose which model should perform a task
- benchmark or rank models
- execute multi-agent workflows
- provide a hosted service
- replace `AGENTS.md`
- automatically download arbitrary skills or prompts

It configures the instruction layers used by the agent tools you already run.

## Roadmap

The initial work is split into a small set of issues:

```text
#1  Basic architecture
#2  Bootstrap and routing
#3  Role and skill model
#4  Installer CLI
#5  Role and skill configuration wizard
#6  v0.1.0 hardening
#7  Shareable presets
#8  Local environment profiles
```

## Status

Early development. The architecture, local examples, bootstrap protocol, and
tested resolver are available. See [docs/architecture.md](docs/architecture.md),
[docs/bootstrap.md](docs/bootstrap.md), and [.agent-profiles/](.agent-profiles/).

The installer CLI and agent-specific integrations are planned. Commands,
configuration, and file formats may change before the first release.

## License

Apache-2.0
