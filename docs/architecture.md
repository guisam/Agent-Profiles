# Architecture (configuration version 1)

Agent Profiles is a repository-local instruction and configuration layer.
It describes which instructions an existing agent tool should load. This
architecture defines the contract. The [bootstrap protocol](bootstrap.md) and
resolver implement validation and loading of additional instruction layers.
The [installer](installer.md) adds portable instructions through small
agent-specific adapters.

## Implementation flow

`bin/agent-profiles.js` parses commands and owns terminal input. It passes an
explicit repository root to the synchronous installer and configuration APIs.

- `resolve.js` parses YAML using `yaml`, rejects duplicate keys and invalid
  schema, validates local references, then resolves the model profile, role,
  and skill lists. Only selected instruction bodies enter its result.
- `integrations.js` describes host instruction targets and precedence. The
  [adapter contract](installer.md#integration-contract) keeps host differences
  out of routing.
- `install.js` discovers integrations, validates configuration, plans scaffold
  and bootstrap changes, then checks the resulting installation with doctor.
  Uninstall removes managed spans even if routing configuration is broken.
- `files.js` checks mutation paths and snapshots, writes temporary sibling files,
  and rolls completed writes back after reported failures. Existing user files
  are preserved; configuration deletion requires separate explicit confirmation.
- `wizard.js` gathers a proposed role edit using local discovery from `skills.js`.
  `configure.js` builds an in-memory YAML edit, validates through the same resolver,
  previews the outcome, and applies it only after confirmation and stale-edit checks.
- `presets.js` validates a separate versioned preset manifest, then composes import
  plans into the ordinary configuration. A resolver preview map supplies proposed
  Markdown bytes without writing them. Apply rechecks snapshots and uses the shared
  writer. `preset-wizard.js` reuses selection and configuration prompts. Export
  copies selected instruction files into a new local preset directory.

There is no build step, network resolution, or agent runtime. The only runtime
dependency is `yaml`; Node supplies file, path, argument, and terminal APIs.

## Context accounting

A context proof measures the marginal instruction context managed by Agent
Profiles. It is not necessarily a measurement of the agent's complete context
window. `diagnostics.js` counts UTF-8 bytes and Unicode code points from the exact
resolved instruction text, classifies loaded entries, and summarizes profile,
role, required-skill, and requested-skill totals. Available skill bodies are scanned
in bounded chunks to measure potential context without exposing that text in the
result. Routing and ID deduplication semantics remain unchanged.

The resolver returns these diagnostics for CLI, preset, and external consumers.
`proof` formats that result; it does not route independently. The data model marks
repository instructions as host-supplied and host internals as unobserved, and
excludes them from managed totals. Bootstrap instructions, inventory rendering,
and output wrappers are also explicitly excluded. Tokens are not calculated.
See [proof.md](proof.md) for the output contract and encoding details.

## Instruction layers

| Layer | Responsibility | Loaded when |
| --- | --- | --- |
| Repository (`AGENTS.md`) | Shared project knowledge and invariant rules | Always |
| Model profile | Accommodations for the configured model | One profile per agent |
| Role | The job the agent is performing | One role per agent |
| Required skills | Specialized instructions needed for that role | Whenever the role is active |
| Available skills | Specialized instructions relevant to some tasks | Only when relevant to the current task |

Keep each instruction in its owning layer. Profiles should not repeat project
rules or define jobs; roles should not encode model capability. Roles reference
skills through configuration rather than copying their text. These additions
do not override repository invariants or the host tool's instruction hierarchy.
If instructions conflict, surface the conflict rather than silently treating
the last loaded file as authoritative.

The sample instructions are deliberately small demonstrations, not recommended
prompts or capability rankings. A constrained profile is guidance, not a
security sandbox or a replacement for host permission controls.

## Files and schema

The working example is [agents.yaml](../.agent-profiles/agents.yaml). All paths
below are relative to `.agent-profiles/`:

```text
agents.yaml
BOOTSTRAP.md
profiles/<profile-id>.md
roles/<role-id>.md
skills/<skill-id>/SKILL.md
```

Version 1 uses plain YAML mappings and lists. The following table is the initial
schema contract, enforced by [the resolver](../src/resolve.js).

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | Integer | Required; exactly `1` |
| `default_profile` | Profile ID | Required fallback for unmatched models |
| `default_role` | Role ID | Required; must be declared in `roles` |
| `models` | Mapping | Required, may be `{}`; exact model identity to `{profile: <profile-id>}` |
| `families` | Mapping | Required, may be `{}`; exact family identity to `{profile: <profile-id>}` |
| `roles` | Mapping | Required; role ID to role definition |
| `roles.<id>.file` | String | Required path to that role's Markdown instructions |
| `roles.<id>.description` | String | Optional human-readable summary for role selection; role instructions remain in the Markdown file |
| `roles.<id>.skills.required` | List of skill IDs | Required; use `[]` for none |
| `roles.<id>.skills.available` | List of skill IDs | Required; use `[]` for none |
| `skills` | Mapping | Optional; skill ID to `{file: <repository-relative Markdown path>}` for existing local resources |

Profile, role, and skill IDs use lowercase ASCII letters, digits, and hyphens,
starting with a letter or digit. A profile ID resolves to
`profiles/<id>.md`; a skill ID normally resolves to `skills/<id>/SKILL.md`.
The optional top-level `skills` map references resources elsewhere in the
repository without copying or moving them. See [Local skills](#local-skills).
Model and family keys are nonempty, case-sensitive identity strings, not paths,
patterns, or capability labels. Quote YAML keys when needed to keep them strings.

Role file paths must be relative, use `/` separators, end in `.md`, and remain
inside `.agent-profiles/`, including after resolving symlinks. Absolute paths,
URLs, and `..` path segments are invalid. All referenced files must exist;
available skill bodies remain unloaded while their metadata is checked.
Skill lists contain no duplicates and must not overlap within a role.

The resolver rejects duplicate mapping keys, unknown fields, unsupported
versions, incorrect types, and invalid references with a clear error. A broken
configuration is not an unknown model: do not silently substitute another
profile or skip a missing required skill.

## Model resolution

The host integration supplies a model identity and, when known, one family
identity. Identity discovery may report the model's name, but may not infer its
capability or select its own profile. Family membership comes from explicit
host metadata or a user-supplied identity, never a guessed prefix or substring.

**Models may identify themselves. Models do not grade themselves.**

Resolve the profile in this order:

1. If the model identity exactly matches a key in `models`, use its profile.
2. Otherwise, if the supplied family identity exactly matches a key in
   `families`, use its profile.
3. Otherwise, use `default_profile`, including when identity is unavailable.

Exact model matches win even when a family mapping also exists. Repository
owners choose the mappings and a safe default; the example uses `constrained`.
Profile names are opaque IDs to the resolver, with no built-in ranking.

## Role selection and skill composition

The user or calling tool explicitly selects a role. If no role is supplied,
use `default_role`. An explicitly requested but undeclared role is an error,
not a request to fall back. Role selection never changes model routing, and
model routing never selects a role.

The [configuration wizard](configure.md) edits this same role schema. It can
create a minimal instruction file, but does not rewrite an existing file when
its description or skill assignments change.

After resolution, compose context in this order:

1. Repository instructions, following the host's existing `AGENTS.md` handling.
2. The resolved profile's contents.
3. The selected role's contents.
4. That role's required skills, in declaration order.
5. An inventory of that role's available skill IDs, names, descriptions, and
   local paths. Load their contents only when explicitly requested for the task,
   once per skill in the returned context.

Do not eagerly load other profiles, other roles, or available skill contents.
If the role changes, recompute the role and skill context rather than carrying
the previous role's instructions forward. How a host refreshes that context is
an integration detail.

With the checked-in example, these cases can be followed by hand:

| Model | Supplied family | Requested role | Profile | Role | Required skill contents | Available inventory only |
| --- | --- | --- | --- | --- | --- | --- |
| `example-model` | `example-family` | `reviewer` | `autonomous` | `reviewer` | `code-review` | `testing` |
| `unlisted-model` | `example-family` | `reviewer` | `scaffolded` | `reviewer` | `code-review` | `testing` |
| `unlisted-model` | Unknown | Omitted | `constrained` | `implementer` | None | `testing` |
| Unavailable | Unavailable | `researcher` | `constrained` | `researcher` | None | None |
| `example-model` | Unavailable | `implementer` | `autonomous` | `implementer` | None | `testing` |

For the first row, load `AGENTS.md`, `profiles/autonomous.md`,
`roles/reviewer.md`, and `skills/code-review/SKILL.md`. Advertise
`skills/testing/SKILL.md` without loading its contents until testing is relevant.
For any row, a role such as `undeclared-role` must produce an error.

## Local skills

The default source is `.agent-profiles/skills/<id>/SKILL.md`. To reference an
existing Markdown skill elsewhere, add an optional top-level mapping:

```yaml
skills:
  security-review:
    file: team-skills/security/SKILL.md
```

This file path is relative to the **repository root**, unlike role file paths.
It must remain inside the repository after resolving symlinks. Absolute paths,
URLs, backslashes, and `..` segments are rejected. No folders are scanned, no
files are downloaded, and a mapping alone does not expose a skill to any role.
Add its ID to a role's `required` or `available` list to expose it there.

There must be one authoritative resource for each skill ID. If both a mapped
file and the conventional file exist and resolve to different files, validation
reports an ambiguous skill instead of choosing a winner. A mapping to the same
canonical file is allowed. Duplicate YAML IDs are rejected. Multiple roles can
reference the same ID; metadata is read once per resolution, and instructions
remain in their original file.

The initial local reader supports Markdown with YAML frontmatter:

```markdown
---
name: Security Review
description: Review changes for common application security risks.
---

Skill instructions go here.
```

`name` and `description` must be nonempty strings. The stable ID comes from the
configuration or conventional directory, not the display name. Other frontmatter
fields are retained in the source and ignored by this reader; Agent Profiles
does not maintain a second copy of metadata. Keep descriptions short enough to
help decide relevance. Metadata must be within the first 64 KiB and use `---`
delimiter lines. Existing skills without metadata need this small header added
to their authoritative source. Other local formats can have readers added later.

Wizard discovery is separate from runtime exposure: it scans the supported
Agent Profiles and Claude-local directories for a human to select from, while
bootstrap still exposes only the selected role's lists. If two sources have the
same ID, selecting an alternative creates or reuses an explicit source alias,
such as `testing-2`, in the existing top-level `skills` map. No existing binding
is overwritten, and no other role's meaning changes. The resolver continues to
reject ambiguous IDs without explicit aliases.

Metadata validation reads headers incrementally, stopping after the closing delimiter
(a read chunk may include a prefix of the body). Unselected bodies never enter
the returned instruction context. Required skills and explicitly requested
available skills load their complete source text, including frontmatter.

The resolution output includes `required` and `available` metadata lists, each
containing `id`, `name`, `description`, and repository-relative `path`. The
`loaded` list contains only selected instructions. Request an available skill
through `skills: ['security-review']` in the API or `--skill security-review` in
the debug command. Requests outside the selected role's lists fail even if a
file exists. Required skills load first; requested skills follow in request
order, with repeated IDs loaded once. The available index remains unchanged.
See [bootstrap.md](bootstrap.md) for runnable examples.

Roles, skill exposure, and on-demand requests do not change model routing.
This is instruction routing, not permission enforcement or a tool execution
sandbox. The host remains responsible for its own permissions and context.

## Integration boundary and scope

The installer adapters select host instruction files and insert a managed block
pointing to `.agent-profiles/BOOTSTRAP.md`. The host agent follows that protocol
using its runtime identity and assigned role. The resolver API remains available
for integrations that supply instruction text programmatically. Existing
repository instructions are preserved and should be read only once. Agent-specific
filenames belong in the adapter, not in the core profile format.

The core does not choose a model, spawn agents, orchestrate tasks, execute skill
files, benchmark capability, or distribute optimal prompts. Local skill files
are sufficient; this schema does not define a universal skill ecosystem.
Remote registries, downloads, machine-local environments, hosted services, and synchronization are
outside the initial architecture, routing, and installer work. A local debugging
command is available as `npm run resolve`; the installer exposes `init`, `doctor`,
and `uninstall`; `configure` provides the role/skill wizard. The [preset format](presets.md)
adds local inspect/import/export without adding a runtime concept of preset roles.

The [local visualizer](visualize.md) exposes validated selection lists through
`readConfiguration` and delegates every projection to `resolveInstructions`.
Its browser UI renders those results without parsing YAML, routing models, or
recalculating context sizes. A Node HTTP server binds to loopback with a random
session URL, fixed assets, same-origin restrictions, and read-only endpoints.
Model/role choices, skill requests, and comparison snapshots remain in page memory;
they never write configuration. Imported presets need no separate visualizer logic.
