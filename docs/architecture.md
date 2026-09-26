# Initial architecture (version 1)

Agent Profiles is a repository-local instruction and configuration layer.
It describes which instructions an existing agent tool should load. This
architecture defines the contract. The [bootstrap protocol](bootstrap.md) and
resolver implement validation and loading of additional instruction layers;
agent-specific injection and installation remain separate work.

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

Validation reads headers incrementally, stopping after the closing delimiter
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

A future agent-specific adapter connects the host instruction mechanism to
this contract. It supplies identity and role inputs, reads and validates the
local configuration, resolves the profile independently from the role, and
loads the applicable files using the host's context mechanisms. Preserve
existing repository instructions and avoid loading them twice if the host
already supplies them. Agent-specific filenames and APIs belong in that adapter,
not in the core profile format.

The core does not choose a model, spawn agents, orchestrate tasks, execute skill
files, benchmark capability, or distribute optimal prompts. Local skill files
are sufficient; this schema does not define a universal skill ecosystem.
Installers, configuration wizards, remote registries, downloads, shareable
presets, machine-local environments, hosted services, and synchronization are
outside the initial architecture and bootstrap work. A local debugging command
is available as `npm run resolve`; the installer and other planned CLI commands
remain unimplemented.
