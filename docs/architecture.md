# Architecture (configuration version 1)

Agent Profiles is a repository-local instruction and configuration layer.
It describes which instructions an existing agent tool should receive. This
architecture defines the contract. The [bootstrap protocol](bootstrap.md) and
resolver implement it. The [installer](installer.md) adds the bootstrap to
host instruction files through small agent-specific adapters.

## Guarantee levels

Every behavioral statement in this documentation has one of these levels:

| Level | Meaning | Enforced by |
| --- | --- | --- |
| **Core** | Deterministic behavior of the resolver, validation, installer, and diagnostics | Agent Profiles code and tests |
| **Native** | What a host that calls the resolver while building context can ensure | That host integration (none ships yet) |
| **Bootstrap expectation** | What the managed block and `resolve` output ask the agent to do | The agent; verified only by live-host tests |
| **Host-dependent** | Behavior Agent Profiles neither controls nor observes | The host |

| Statement | Core | Native | Bootstrap mode |
| --- | --- | --- | --- |
| A given identity and role resolve to one profile, role, and skill set | Yes | Yes | Yes, when the agent runs `resolve` |
| Broken configuration fails instead of falling back | Yes | Yes | The command fails; the agent is asked to report it |
| The agent receives only the resolved profile, role, and required skills | — | Yes | Expectation. The agent may read other files, and the host may re-attach earlier ones |
| An available skill stays uninjected until the task needs it | — | Yes | Expectation. Claude Code re-attaches files read earlier after compaction |
| A reviewer does not receive implementer instructions | — | Yes, if the host builds each role's context separately | Only in a new session or custom agent. A rerun with `--role` supersedes earlier text but cannot remove it |
| A role sees only its assigned skills | — | Only if the host can hide skills | No. Agent Profiles routes the role's skills; Claude Code still lists every host skill |
| Resolution runs again after compaction or a model change | — | Yes, where the host reports the event | Expectation. Observed after compaction; skipped after a model change on an unrelated task |
| The agent uses its host-stated model ID, not a guess | — | The host supplies it | Expectation. Observed reliably on Claude Code |
| A host-native skill behaves as the host defines it | — | Host-dependent | Host-dependent: Agent Profiles asks the agent to invoke it and never injects its file |
| The installed bootstrap command can run in this repository | Yes, for what is on disk: doctor checks the local package, its version, and the Claude Code allow rules; init exits nonzero until they hold | — (no bootstrap) | Host-dependent: Claude Code ignores project allow rules until the workspace is trusted. When denied, Haiku was observed routing by hand |
| Every installed bootstrap surface carries the current protocol | Yes: doctor reports unversioned, older, or modified blocks and a changed BOOTSTRAP.md; init refreshes all installed surfaces | — | The agent reads whatever the surface says |
| A host skill is offered only to the host that can invoke it | Yes, when the host is supplied | Yes: the host passes itself | Yes: each managed block passes its own `--host` |
| A role whose required host skill the running host cannot invoke is reported, not silently degraded | Yes: `unsatisfied` in the resolution and a doctor capability error per installed host | Yes | The `resolve` output tells the agent to inform the user |

Observed host behavior, with versions, is recorded in [host-observations.md](host-observations.md).
Integration capabilities are also printed by `agent-profiles doctor`.

## Host in the resolution contract

Every resolution may name the host that consumes it (`host`: an integration ID such
as `claude` or `codex`). Host-native skills carry `usable`: `true` or `false` for the
given host, `null` when no host is given. For a known host:

- another host's available skills are not exposed to the agent;
- another host's required skills are listed in `unsatisfied` with a reason, and the
  `resolve` output tells the agent to inform the user instead of substituting;
- `doctor` reports each unsatisfied role and installed host as a capability error,
  separate from configuration errors. It does not block installing the integration.

Without `host`, usability is unknown and nothing is marked unsatisfied; callers that
consume host skills should always pass it.

## Terms

- **Resolve**: choose the profile, role, and skills from configuration and the
  supplied identity. Only the resolver resolves.
- **Inject**: add Agent Profiles instruction text to the agent's context.
- **Expose**: list a skill's ID and description without injecting or invoking it.
- **Invoke**: use the host's own mechanism for a host-native skill.

## Implementation flow

`bin/agent-profiles.js` parses commands and owns terminal input. It passes an
explicit repository root to the synchronous installer and configuration APIs.

- `resolve.js` parses YAML using `yaml`, rejects duplicate keys and invalid
  schema, validates local references, aliases, and family prefixes, then resolves
  the profile, role, and skill lists. Only selected instruction bodies enter its result.
- `integrations.js` describes host instruction targets, host skill locations, the
  managed block, and each adapter's observed capabilities. The
  [adapter contract](installer.md#integration-contract) keeps host differences
  out of routing.
- `install.js` discovers integrations, validates configuration, plans scaffold
  and bootstrap changes (replacing outdated managed blocks), then checks the
  result with doctor. Uninstall removes managed spans even if routing
  configuration is broken.
- `files.js` checks mutation paths and snapshots, writes temporary sibling files,
  and rolls completed writes back after reported failures. Existing user files
  are preserved; configuration deletion requires separate explicit confirmation.
- `wizard.js` gathers a proposed role edit using local discovery from `skills.js`.
  `configure.js` builds an in-memory YAML edit, validates it through the same
  resolver, previews the outcome, and applies it only after confirmation and
  stale-edit checks.
- `presets.js` validates a separate versioned preset manifest, then composes import
  plans into the ordinary configuration. A resolver preview map supplies proposed
  Markdown bytes without writing them. Apply rechecks snapshots and uses the shared
  writer. `preset-wizard.js` reuses selection and configuration prompts. Export
  copies selected instruction files into a new local preset directory.
- `diagnostics.js` measures and formats resolutions: `resolve` output for agents
  and `proof` output for people.

There is no build step, network resolution, or agent runtime. The only runtime
dependency is `yaml`; Node supplies file, path, argument, and terminal APIs.

## Context accounting

A context proof measures the marginal instruction context managed by Agent
Profiles, not the agent's complete context window. `diagnostics.js` counts UTF-8
bytes and Unicode code points from the exact resolved instruction text, classifies
injected entries, and summarizes profile, role, required-skill, and requested-skill
totals. Available instruction skill bodies are scanned in bounded chunks to
measure potential context without exposing their text.

Host-native skills are listed separately and never counted, because the host
delivers them. The bootstrap block is measured on its own line: it is added to
each host instruction surface in bootstrap mode, and a native integration needs
none. Repository instructions are host-supplied, host internals are unobserved,
and tokens are not calculated. See [proof.md](proof.md).

## Instruction layers

| Layer | Responsibility | Delivered |
| --- | --- | --- |
| Repository (`AGENTS.md`) | Shared project knowledge and invariant rules | By the host (Claude Code needs the `resolve` reminder to read it) |
| Model profile | Accommodations for the configured model | Injected, one per resolution |
| Role | The job the agent is performing | Injected, one per resolution |
| Required skills | Specialized instructions for all work in the role | Instruction skills injected; host skills invoked |
| Available skills | Specialized instructions for some tasks | Exposed; used only when the current task falls within the skill's description |

This is the single definition of *required* and *available* used across the
bootstrap, `resolve` output, wizard, presets, and visualizer.

Keep each instruction in its owning layer. Profiles should not repeat project
rules or define jobs; roles should not encode model capability. Roles reference
skills through configuration rather than copying their text. These additions do
not override repository invariants or host permissions. If instructions
conflict, surface the conflict rather than treating the last loaded file as
authoritative.

The sample instructions are deliberately small demonstrations, not recommended
prompts or capability rankings. A constrained profile is guidance, not a
security sandbox or a replacement for host permission controls.

## Files and schema

The working example is [agents.yaml](../.agent-profiles/agents.yaml). Paths
below are relative to `.agent-profiles/`:

```text
agents.yaml
BOOTSTRAP.md
profiles/<profile-id>.md
roles/<role-id>.md
skills/<skill-id>/SKILL.md
```

Version 1 uses plain YAML mappings and lists, enforced by [the resolver](../src/resolve.js).

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | Integer | Required; exactly `1` |
| `default_profile` | Profile ID | Required fallback for unmatched models |
| `default_role` | Role ID | Required; must be declared in `roles` |
| `models` | Mapping | Required, may be `{}`; canonical model ID to a model entry |
| `models.<id>.profile` | Profile ID | Required |
| `models.<id>.aliases` | List of strings | Optional; other exact identities of the same model |
| `families` | Mapping | Required, may be `{}`; family name to a family entry |
| `families.<id>.profile` | Profile ID | Required |
| `families.<id>.match.prefixes` | List of strings | Optional; identity prefixes that select this family |
| `roles` | Mapping | Required; role ID to role definition |
| `roles.<id>.file` | String | Required path to that role's Markdown instructions |
| `roles.<id>.description` | String | Optional human-readable summary |
| `roles.<id>.skills.required` | List of skill IDs | Required; use `[]` for none |
| `roles.<id>.skills.available` | List of skill IDs | Required; use `[]` for none |
| `skills` | Mapping | Optional; skill ID to `{file: <repository path>}` or `{host: <host>, scope: project | user | plugin, id?: <host skill ID>}` |

**Compatibility decision.** The new optional fields (`aliases`, `match`, and host
skill entries) stay in version 1. No release of Agent Profiles has been
published, so no existing CLI can reject them. Configurations without these fields
are unchanged, and the example configuration still validates.

Profile, role, and skill IDs use lowercase ASCII letters, digits, and hyphens,
starting with a letter or digit. Model and family keys, aliases, and prefixes are
nonempty, case-sensitive strings. Quote any value containing YAML syntax, such as
`"claude-opus-5-5[1m]"`; inside a flow list an unquoted `[` is a YAML error.

Role file paths must be relative, use `/` separators, end in `.md`, and remain
inside `.agent-profiles/`, including after resolving symlinks. Absolute paths,
URLs, and `..` segments are invalid. All referenced local files must exist.
Skill lists contain no duplicates and must not overlap within a role.

The resolver rejects duplicate mapping keys, unknown fields, unsupported versions,
incorrect types, and invalid references with an error naming the entry and a
repository-relative path. A broken configuration is not an unknown model: nothing
is silently substituted.

## Model resolution

Identity comes from the host: the exact model ID the host states, supplied by the
agent in bootstrap mode or by the host in native mode. Models may copy their
identity; models do not grade themselves, and they never supply an identity from
recollection. Resolution is core behavior:

1. An identity that exactly equals a `models` key uses that model.
2. Otherwise, an identity listed in a model's `aliases` uses that model.
3. Otherwise, a supplied family that exactly equals a `families` key uses it.
4. Otherwise, the family with the longest `match.prefixes` entry that the
   identity starts with is used.
5. Otherwise, `default_profile` applies, including when identity is absent.

Validation makes each step unambiguous:

- An alias may not equal another model's key or appear under two models.
- An alias equal to its own model key is redundant but allowed.
- The same prefix may not appear in two families. Distinct prefixes that both
  match an identity always differ in length, so the longest one wins without a tie.

Aliases and prefixes are chosen by the repository owner; the resolver never
derives them.

```yaml
models:
  claude-opus-5-5:
    profile: autonomous
    aliases: ["claude-opus-5-5[1m]"]
families:
  claude-haiku:
    profile: scaffolded
    match:
      prefixes: [claude-haiku-]
```

Provider IDs vary. For example, Amazon Bedrock cross-region inference profiles
put a region before the model (`us.`, `eu.`, `apac.`, `global.`). A prefix such as
`claude-haiku-` does not match them, so list each form you use as an alias or
prefix. Only the direct Claude Code identities in
[host-observations.md](host-observations.md) have been verified live; Bedrock and
Vertex forms are unverified.

The output records provenance: `identity.raw`, `identity.canonical`,
`identity.source` (`host` when a native host supplied it, `host-stated` when the
agent relayed the host's statement in bootstrap mode, `user`, or `null`), `matchedBy`, `family`, and
`familySource` (`supplied` or `configured-prefix`).

## Role selection and skill composition

The user or calling tool selects a role; otherwise `default_role` applies. An
explicitly requested but undeclared role is an error. Role selection never changes
model routing, and model routing never selects a role.

The [configuration wizard](configure.md) edits this same role schema. It can
create a minimal instruction file, but does not rewrite an existing file.

A resolution composes, in order:

1. Repository instructions, supplied by the host.
2. The resolved profile, injected.
3. The selected role, injected.
4. Required instruction skills in declaration order, injected; required host
   skills, named for invocation.
5. The role's available skills, exposed by ID, description, and either a path to
   read or the host skill to invoke.

The following cases can be checked with the example configuration (core behavior):

| Model | Supplied family | Requested role | Profile | Role | Injected skills | Exposed only |
| --- | --- | --- | --- | --- | --- | --- |
| `example-model` | `example-family` | `reviewer` | `autonomous` | `reviewer` | `code-review` | `testing` |
| `unlisted-model` | `example-family` | `reviewer` | `scaffolded` | `reviewer` | `code-review` | `testing` |
| `unlisted-model` | Unknown | Omitted | `constrained` | `implementer` | None | `testing` |
| Unavailable | Unavailable | `researcher` | `constrained` | `researcher` | None | None |
| `example-model` | Unavailable | `implementer` | `autonomous` | `implementer` | None | `testing` |

Any undeclared role, such as `undeclared-role`, produces an error.

## Local and host-native skills

An **instruction skill** is Markdown that Agent Profiles injects. Its default
source is `.agent-profiles/skills/<id>/SKILL.md`; the top-level `skills` map can
point an ID at another repository file:

```yaml
skills:
  security-review:
    file: team-skills/security/SKILL.md
```

This path is relative to the **repository root** and must stay inside the
repository after resolving symlinks. No folders are scanned and nothing is
downloaded.

A **host-native skill** belongs to the host and is invoked, never injected:

```yaml
skills:
  release-notes:
    host: claude            # Claude Code
    scope: project          # .claude/skills/release-notes/SKILL.md
  personal-style:
    host: claude
    scope: user             # ~/.claude/skills; outside the repository
  lint:
    host: claude
    scope: plugin
    id: toolkit:lint        # defaults to the key
```

`scope` is required, and it decides what validation can enforce:

| Scope | Identifier | Validation (core) | Verification |
| --- | --- | --- | --- |
| `project` | `name` | `.claude/skills/<id>/SKILL.md` must exist; a misspelled ID fails like any missing file | `verified-local`; metadata is read |
| `user` | `name` | Identifier only; the file is outside the repository | `host-provided` |
| `plugin` | `plugin:name` | Identifier only | `host-provided` |

Identifiers follow the host's rules, not the Agent Profiles ID grammar used for keys.
A `host-provided` skill is neither verified nor reported missing. That is a stated
limit of what can be checked, not a fallback, because the scope was declared
explicitly. Codex host skills are not supported yet.

There is one authoritative resource per ID. If a mapped file or host reference
coexists with a different conventional `.agent-profiles/skills/<id>/SKILL.md`,
validation reports the ambiguity. Host skills are never renamed to resolve a
conflict. The wizard asks you to rename one instead, while other mapped files may
receive an explicit alias such as `testing-2`.

Metadata comes from YAML frontmatter delimited by `---` within the first 64 KiB.
The same rules apply to discovery, validation, and resolution:

- When `name` is absent, the skill's directory name is used, as Claude Code does.
- `description` is required for instruction skills and optional for host skills.
- A host skill whose metadata cannot be read stays `verified-local` with a
  `metadataError`; doctor reports it, and other roles keep resolving.
- Other fields are ignored by this reader.

The resolution lists `required` and `available` metadata with `id`, `type`
(`instruction` or `host`), `delivery` (`inject` or `invoke`), `name`,
`nameSource`, `description`, and `path` (`null` for host-provided skills). Request
an available instruction skill with `skills: ['id']` in the API or `--skill id` on
the CLI. Requests outside the selected role's lists fail. This is instruction
routing, not permission enforcement.

## Integration boundary and scope

Installer adapters choose host instruction files and insert the managed block;
the agent then runs `resolve`. The resolver API is the native-mode entry point for
hosts that build context themselves. Agent-specific filenames, skill locations,
and capabilities belong in the adapter, not in the profile format.

The core does not choose or launch models, orchestrate tasks, execute skill files,
benchmark capability, or distribute prompts. Remote registries, downloads,
machine-local environments, hosted services, and synchronization are out of scope.
The [preset format](presets.md) adds local inspect, import, and export. The
[visualizer](visualize.md) renders resolver output without routing on its own.
