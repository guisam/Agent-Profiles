# Agent Profiles

Different models need different instructions. Different roles need different
skills. Agent Profiles resolves only the additional context each agent needs.

## Ask your coding agent

Copy this into your existing coding agent (including one used through a coding bench):

> Set up Agent Profiles for this repository using Node 24 or newer. Propose an
> exact published version of `@guisam/agent-profiles` (0.19.4 for this guide).
> Obtain approval for any registry download and execution, then run
> `npx --yes @guisam/agent-profiles@<approved-version> inspect --json` from this
> repository (or pass `--root <project>`). This prepares the tool in npm's cache
> if needed, without adding a project dependency. Inventory existing agent
> instructions, project/native skills, roles, models, workflow files and the
> environment. Ask for additional read permissions; use `--external` only for
> approved global sources.
>
> Identify the project's actual SDLC authority and recommend a small set of roles
> and model instruction profiles. For each role, explain required, available and
> unassigned skills. Preserve independent review and human approval gates; do not
> invent orchestration. Reuse native references without copying skill bodies.
> Keep unknown models on the configured fallback and machine-specific facts local.
> If I already maintain a shared Agent Profiles library, inspect its relevant
> packages and propose project-specific pins before creating duplicate skills.
>
> Show exact file changes, roles, model mappings, dependencies, and unverified host
> capabilities. Propose installing the same reviewed version with
> `npm install --save-dev --save-exact @guisam/agent-profiles@<approved-version>`.
> For Claude Code, recommend `init --agent claude --mcp` and show the separate
> project-scoped MCP registration. For other hosts, use their supported setup.
> In T3, confirm the selected provider and model; configure that provider's host.
> Keep the protocol-3 project bootstrap and a working local shell resolver even
> with MCP, because the server may still be connecting when work starts.
>
> Include a security plan: preserve host permissions and existing trust policy;
> explain the read-only MCP tools and the setup/library/pin commands reserved for
> the user. For shared packages, propose exact pins and ask whether signed approvals
> are required, which namespaces/effects are allowed, and who may approve them.
> Show any project-policy changes separately; keep signing keys and credentials
> outside the repository and chat. Report withheld packages without weakening policy.
> Package integrity and approval do not prove that instructions are safe or effective.
>
> Do not install into the project, execute skills or change files until I approve.
> Preserve existing instructions; only add or refresh the approved managed bootstrap
> block. Propose any restructuring or shortening of AGENTS.md separately.
>
> After approval, use the installer and role planner/applier or wizard. Respect
> existing permission rules: Claude Code's init adds deny rules for library/pin
> changes and setup commands, which may already apply. Prepare blocked commands
> for me to run; do not bypass them with another invocation. Register the approved
> MCP server separately: init prints setup instructions but does not register it.
> Have me approve/connect the server and start a fresh session as needed. Run
> doctor and representative host/model/role proofs, then verify an actual MCP
> resolve call for the intended project, host, exact model and role. Omit selector
> arguments already bound by the server; a conflicting value is an error.
> Check that every required skill body and the final `End of Agent Profiles context:`
> line arrived. Then use a neutral task in a fresh session and after clear/compaction
> to observe resolution before work; test the shell fallback separately if approved.
> Any resolver error, empty output or missing final line means report incomplete
> setup and stop role work until resolution succeeds. A successful doctor check,
> explain result or stamp alone does not establish delivery. Report measured
> managed context, live observations and anything unverified. Explain optional next
> steps: pinned library skills, update notices and trust policy. Offer preset export
> only with separate approval, excluding machine-local facts.

Use the [setup workflow](docs/setup.md) for a pinned npm inspection command,
inventory limits, MCP registration and verification. Trusted checkout and packed
artifact workflows remain available for offline or pre-release work. Tool
preparation/downloads need their own permissions. This prompt is a supported
workflow, not a guarantee of every host's tools or live behavior. MCP startup
instructions are a short retrieval reminder, not the skill bodies. The project
bootstrap requires fresh resolution after clear, compaction or a model change;
live compliance and subagent delivery must be verified for the selected host.

A shared `AGENTS.md` is useful for repository facts and conventions. But putting
every model accommodation, job description, and skill into it gives agents
instructions intended for other tasks. Agent Profiles separates those layers
in local, reviewable files, with a small CLI for setup and configuration.

## Quick start

Requires **Node.js 24 or newer**. Supports **Claude Code, OpenAI Codex, OpenCode, and Hermes Agent**
(Claude Code and OpenCode verified live; Codex and Hermes live bootstrap behavior not yet observed).
For OpenCode v2.1.3, see the [setup guide and assistant prompt](docs/hosts/opencode.md).

For Claude Code, run these from your Git repository after reviewing the setup
changes (for a non-Git project, pass `--root /path/to/project` to AP commands):

```sh
npm install --save-dev --save-exact @guisam/agent-profiles@0.19.4
npx --no agent-profiles init --agent claude --mcp
claude mcp add --scope project agent-profiles -- npx --no agent-profiles mcp --host claude
npx --no agent-profiles configure
npx --no agent-profiles doctor
npx --no agent-profiles proof --role reviewer
```

`init --mcp` writes the project bootstrap and prints registration instructions;
the separate `claude mcp add` command registers the server. Preserve or update an
existing entry instead of adding a duplicate. Approve the project server in Claude
and start a fresh session. Verify that `resolve` runs before work and returns the
required instructions plus its final context line. If MCP is not ready, the
bootstrap uses the installed shell resolver; retain both paths.

For other hosts, use their [setup instructions](docs/mcp.md#host-setup).
For existing installations, update the dependency and re-run
`npx --no agent-profiles init --agent claude --mcp` to refresh the bootstrap;
prepare host-denied commands for the user to run. Version 0.19.4 keeps protocol 3
and needs no YAML, lock or store migration. Review [security choices](docs/setup.md#security-choices-before-adopting-shared-skills)
before adopting shared packages.

From a trusted source checkout, run `npm ci` and `npm pack`, then
`node bin/agent-profiles.ts init --root /path/to/project --agent claude --mcp --package ./guisam-agent-profiles-0.19.4.tgz`.
Use the separate registration and verification steps above from the target project.

The npm package is `@guisam/agent-profiles`; the command remains `agent-profiles`.
If you previously installed an unscoped source tarball, remove that dependency
with `npm uninstall --save-dev agent-profiles`, then install the scoped package.
Keep your `.agent-profiles/` configuration and package pins; no YAML migration is
needed for this package-name change.

`init` asks which agents to enable and adds a small bootstrap block to their
instruction files. The block asks the agent to run `npx --no agent-profiles resolve`
with the exact model ID its host states. Code does all routing, and the agent
follows the printed result. For Claude Code, `init` also allows exactly that command
in `.claude/settings.json`, and adds a startup-only hook that shows you a short
[update notice](docs/versioned-packages.md#update-notice) when the library has newer
versions for your pins. It also denies agents the commands that change the
library or your pins (`library publish`, `update`, `install` and others), so you run
those yourself; see [bootstrap setup](docs/bootstrap.md#host-setup) for the limits.
A [trust policy](docs/trust.md) can limit which packages reach a project and, as it
is built out, require SSH-signed approvals.
It exits nonzero until the local bootstrap executable
and matching version are verified (see
[bootstrap setup](docs/bootstrap.md#host-setup)). `configure` creates, edits, or deletes
roles and lets you select required and available local skills. `doctor` answers three
separate questions: is the configuration valid, can the bootstrap run here, and can
each role's required host skills belong to every installed host. Actual native
invocation remains host-controlled. Use `--help` for options and `--version` for the installed version; scripts can initialize with
`--agent claude --agent codex`. Use `--root` for a directory outside Git.

| Command | Purpose |
| --- | --- |
| `inspect` | Read-only repository/machine inventory before or after init; `--json`, opt-in `--external` |
| `init` | Select agents, preserve their existing instructions, and install the local scaffold |
| `configure` | Create/edit/delete roles; `--external` adds native user/plugin metadata |
| `skills` | Inspect metadata/source availability; `--external --json` includes external inventory |
| `doctor` | Validate configuration, local references, host skills, and integration capabilities |
| `resolve` | Print the resolved instructions an agent follows; `--json` for integrations |
| `proof` | Measure selected instruction bytes/characters and available context not injected |
| `visualize` | Explore model/role composition, project skill requests, and compare context locally |
| `preset inspect/import/export` | Review and share local configurations with explicit conflict handling |
| `add` | Import one exact local package revision into an explicit store |
| `install` | Lock/import all declared v2 package pins; frozen/offline reproduction |
| `stamp` | Capture immutable selected managed bytes and provenance |
| `verify` | Verify a full stamp digest and all backing, without repair |
| `diff` | Verify and structurally compare two stamps |
| `materialize` | Export a verified stamp into a new absent filesystem destination |
| `migrate start/status/abandon` | Edit an isolated workspace with retained base stamps |
| `migrate candidate <id> <candidate-file>` | Retain one advisory task-only package candidate without activation |
| `migrate plan <candidate-id> <plan-file>` | Retain exact paired context, cases, trials and conditions |
| `migrate results <plan-id> <result-file>` | Import complete caller-supplied paired outcomes |
| `migrate report <result-id>` | Read historical correctness/metric claims without a project |
| `migrate propose/proposals/accept/reject` | Retain evidence-linked advisory changes and explicitly accept or reject one workspace instruction |
| `migrate preview <decision-file>` | Check a promotion decision read-only before applying it |
| `migrate promote <decision-file>` | Promote one exact evaluated role/model/host tuple and repin only its binding |
| `revision record <manifest-file>` | Adopt immutable metadata for an existing legacy release |
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
node bin/agent-profiles.ts uninstall --root /path/to/project
```

See the [installer guide](docs/installer.md) for packed-package installation,
target-file selection, and explicitly confirmed configuration deletion.

## Versioned instruction dependencies

The [complete local package walkthrough](docs/versioned-packages.md) imports two
revisions, selects exact pins by model/role, locks every declared override, captures
raw managed bytes and exports separate ordinary filesystem trees. Configuration
v2 is implemented in this checkout and included since version 0.4.1. Existing
v1 source validation remains, while dependency `install` requires v2. Use the
[scalar-only migration guide](docs/migrations/config-v1-to-v2.md) and its
[approval-first AI prompt](docs/migrations/prompts/config-v1-to-v2.md) before
separately choosing package adoption. This is local acquisition, without downloads,
model execution or native host enablement. Dependency `install` does not install
the Agent Profiles executable; `init --package` retains that separate meaning.

Packages are identified by SHA-256 digests covering their complete file trees.
The `stamp` command captures selected managed instruction content and records
SHA-256 hashes of captured local files, together with package identities and
composition metadata. Retained content can then be verified, compared, and
reconstructed without relying on the original source files. This verifies
captured managed content—not every file an agent reads or the host's complete
runtime context. See the [capture, verify and compare walkthrough](docs/versioned-packages.md#capture-verify-and-compare).

The store doubles as a local skill library: `library publish <directory>` adds a
version, and `library list`, `search` and `info` browse what you have, with
verified digests and, with `--root`, which versions a project pins.
`library evidence @ns/name --model <id> --role <id>` shows which versions have
retained evaluations for that exact model and role, whether they were promoted,
and whether that evidence came from this project or another. `outdated` lists
pins with newer versions, and the evidence for the tuples each one serves;
`update` previews, then with `--apply` writes, a move of one exact role × model ×
host pin. See
[Library](docs/versioned-packages.md#library-browse-search-inspect-and-publish).

## Skill migration workspaces

The first migration slice provides `migrate start`, `migrate status` and
`migrate abandon`: capture a base stamp for an explicit role/model/host, record
shared-versus-fork intent, and edit isolated copies without changing active
assignments or their lockfile. See [skill migration workspaces](docs/skill-migrations.md).
An additional slice provides `migrate propose/proposals/accept/reject`: import
strict JSON v1 with caller-claimed evidence tied to a retained base, inspect it
without applying, then explicitly accept one existing instruction or retain a
rejection reason. Acceptance checks exact before bytes and changes only the
workspace. Repo recommendations never apply. This is not completion of issue #21:
actual forks/lineage, broader candidate targets, provider execution, promotion
beyond one evaluated tuple, verified host attribution and `explain` remain pending.
An additional slice publishes one immutable task-only skill-package candidate from
a fork-intent workspace started directly on a current config3 project and lock2.
Its authoring base and its separately recorded evaluation base are both active stamp2
captures, the same digest when active inputs are unchanged. Accepted history must explain exact task bytes; companions,
dependencies and other files stay unchanged. Typed metadata-v2 separates the planned
label from the unchanged embedded manifest identity. Candidate stamp2/readback retains
exact managed backing without changing active config/lock or selecting the reserved
planned release. See the [candidate workflow and limits](docs/skill-migrations.md#publish-one-advisory-task-only-candidate).
The [offline paired evidence slice](docs/skill-migrations.md#retain-paired-external-evaluation-claims)
retains immutable exact plans/results and reports per-case correctness and comparable
metrics, including explicit unavailable values. Any per-case correctness drop blocks
default eligibility; aggregate/efficiency gains do not cancel it. Imported outcomes
are external claims, runtime is unverified and promotion is not authorized. Historical
rootless report revalidates retained candidate/base/peer backing after mutable deletion.
No provider runs, active assignment changes or promotion/override writes are added by
that evidence slice.
[Single-tuple promotion](docs/skill-migrations.md#promote-the-exact-evaluated-tuple)
adds `migrate preview` (read-only) and `migrate promote` for one strict decision. It
binds the exact candidate, plan/results and only the evaluated primary role/model/host.
Any per-case correctness drop refuses unless an explicit recorded correctness-only
override names exactly those cases; integrity, freshness and workflow failures are
never overridable. Promotion publishes an immutable decision, then a typed release
wrapper over the identical evaluated bytes, then a write-once decision index and
external label. It then repins only that tuple's binding, refreshes lock2 and
captures a fresh stamp. Other tuples, defaults and old versions keep their exact
pins. Failures after the decision commit are reported as partial, and replaying the
same decision completes them. This checkout remains under coordinator/independent
qualification; npm publication does not establish completion of step4 or
issue #21.

## MCP service

`agent-profiles mcp` serves read-only tools to any MCP host over stdio, alongside
the CLI: `resolve`, `explain`, `verify`, `diff` and `report`, plus the library
(`library_list`, `library_search`, `library_info`, `library_evidence`, `outdated`,
`update_preview`). Package files are available as resources. A tool call needs
no shell permission rule, and a server started with `--model` or `--role` carries
the resolved profile in its MCP instructions. It is optional and never writes
files. `init --mcp` makes the managed block hand off to the server's `resolve`
tool, with the shell command as the fallback, and prints the host setup to add.
The server also picks the project from the host's workspace roots and puts the
session's stamp digest in its instructions. With `--record-sessions`, it keeps
machine-local [session records](docs/sessions.md) of what each session resolved.
Available from source (0.5.0–0.7.0; not yet published to npm). See
[MCP service](docs/mcp.md) for host setup and verified behavior.

## Use with Harness²

To decide whether an agent meets a role's quality, turnaround and cost targets,
start with [Qualify an agent](docs/agent-qualification.md). One pasteable prompt
guides requirements, evaluation evidence and a retained qualification report,
including optional basic/premium service labels and an explicit adoption choice.

Start with the [Harness² setup guide](docs/harness2.md) for a complete Windows
example that needs no API keys. It captures, verifies and exports a starter harness.
You can also [copy a setup prompt for your coding assistant](docs/harness2.md#ask-your-coding-assistant).

To evaluate and improve a role's skill, use the
[guided workflow and copyable assistant prompt](docs/guided-evaluation.md).
It covers compatibility, separate tuning/evaluation tasks, baseline/candidate
comparisons, explicit adoption, restoration, and repeating for another model.

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
node bin/agent-profiles.ts proof --model example-model --role reviewer
node bin/agent-profiles.ts proof --model example-model --role reviewer --skill testing
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
node bin/agent-profiles.ts visualize --model example-model --role reviewer
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
node bin/agent-profiles.ts preset inspect /path/to/preset --contents
node bin/agent-profiles.ts preset import /path/to/preset --root /path/to/project
node bin/agent-profiles.ts preset export /path/to/new-preset --root /path/to/project
```

Imports preview changes, require explicit conflict choices and confirmation,
and leave ordinary editable configuration. See [presets](docs/presets.md) for
the local format, dependency handling, provenance, and the small example.

Try the included [release-review preset](examples/presets/release-review/preset.yaml)
with `preset inspect examples/presets/release-review --contents`. Presets may
include Markdown skills or declare exact local dependencies; imports never
download missing skills. Roles remain editable through the same wizard after
import, and their origins are recorded separately.

The [Ponytail preset](examples/presets/ponytail/README.md) demonstrates four
role-specific skills, a self-contained `agents.yaml`, and the path from local
instructions to evaluated model-specific package pins.

## Scope and status

An additional issue #21 slice supports `revision record <manifest-file> --store
<directory> [--json]` to adopt immutable metadata for an existing legacy release.
It verifies the unchanged full tree and exact dependency pins, retains explicit
workflow declarations, and refuses label repointing. Published versions coexist
with independent exact selections; adoption causes no global upgrade. Package
release major does not determine workflow protocol major. See
[release metadata adoption](docs/revisions.md) for the strict JSON format.
Config3 now opts into exact revision references, explicit workflow peer links,
dependency/companion composition and lock2. Fully specified resolution checks named
protocol majors against actual loaded peers; declarations remain runtime-unverified.
Use the [v2 → v3 guide and approval-first prompt](docs/migrations/config-v2-to-v3.md)
for base conversion before separate optional workflow adoption. Legacy v1/v2 behavior
remains supported. Config3 opts into stamp2 capture/reconstruction and filesystem
materialization with retained metadata, exact closure and peer evidence; this does
not complete issue #21 or establish host/model compliance.

The local workflow now includes deterministic routing, Claude Code/Codex/OpenCode/Hermes setup,
role and skill configuration, shareable presets, context diagnostics, and a local
visualizer. The npm package also includes the dependencies for the read-only MCP
service. See the [release checklist](docs/release.md)
for platform and live-host verification before publication.

Agent Profiles is a small convention and CLI for composing additional instruction
layers around repository instructions. It is not an agent framework, orchestrator,
model router, prompt marketplace, benchmark, collection of universally optimal
prompts, replacement for `AGENTS.md`, or skill registry. It does not choose or
launch models, score their capabilities, or run multi-agent workflows.

Read-only environment inventory is available; persistent local environment profiles
and token accounting remain future work.

## Further reading

- [Agent-assisted setup and inventory](docs/setup.md)
- [Using Agent Profiles with Harness²](docs/harness2.md)
- [Qualify an agent for a role or service tier](docs/agent-qualification.md)
- [Guided skill evaluation and improvement](docs/guided-evaluation.md)
- [Role and skill configuration](docs/configure.md)
- [Shareable presets](docs/presets.md)
- [Context proof and accounting boundaries](docs/proof.md)
- [Local context visualizer](docs/visualize.md)
- [Architecture and schema](docs/architecture.md)
- [Bootstrap protocol, host setup, and resolver API](docs/bootstrap.md)
- [Mixed-model reviewer case study](docs/case-studies/mixed-model-reviewers.md)
- [Live-host observations](docs/host-observations.md)
- [Contributing and development checks](CONTRIBUTING.md)
- [Release checklist and verification limits](docs/release.md)
- [Changelog](CHANGELOG.md)

Licensed under [Apache-2.0](LICENSE).

## Volunteer testing: Superpowers roles

Try the experimental [Superpowers role example](examples/superpowers/README.md),
read the initial findings, and contribute one reproducible setup, recovery or
isolation observation. No cost or accuracy advantage is claimed yet.
