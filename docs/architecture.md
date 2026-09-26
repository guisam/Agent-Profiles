# Initial architecture (version 1)

Agent Profiles is a repository-local instruction and configuration layer.
It describes which instructions an existing agent tool should load. This
scaffold defines the contract; it does not implement a loader or installer.

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
schema contract; no runtime validator is supplied yet.

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

Profile, role, and skill IDs use lowercase ASCII letters, digits, and hyphens,
starting with a letter or digit. A profile ID resolves to
`profiles/<id>.md`; a skill ID resolves to `skills/<id>/SKILL.md`.
Model and family keys are nonempty, case-sensitive identity strings, not paths,
patterns, or capability labels. Quote YAML keys when needed to keep them strings.

Role file paths must be relative, use `/` separators, end in `.md`, and remain
inside `.agent-profiles/`, including after resolving symlinks. Absolute paths,
URLs, and `..` path segments are invalid. All referenced files must exist;
available skill contents can remain unloaded while their existence is checked.
Skill lists contain no duplicates and must not overlap within a role.

A future loader must reject duplicate mapping keys, unknown fields, unsupported
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
5. An inventory of that role's available skill IDs and local paths. Load their
   contents only when the task needs them, once per skill in the active context.

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

## Integration boundary and scope

A future agent-specific bootstrap connects the host instruction mechanism to
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
outside issue #1. No CLI commands described in the README are implemented by
this scaffold.
