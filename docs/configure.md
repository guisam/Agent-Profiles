# Role and skill wizard

From an installed package, run `agent-profiles configure`. From this checkout:

```sh
node bin/agent-profiles.js configure --root /path/to/repository
```

Use `init` first if the repository has no configuration. The wizard uses the
same Git-root detection and `--root` option as the installer, and requires an
interactive terminal. Existing configuration must pass resolver validation;
run `doctor` and repair invalid references before opening the wizard.

## Create, edit, or delete

Choose `c`, `e`, `d`, or `q` from the Roles menu. Creation asks for a stable role
ID, an optional description, and an instruction file relative to
`.agent-profiles/`. IDs contain lowercase letters, digits, and hyphens.

The default file is `roles/<id>.md`. A missing file is created only after
confirmation, with a heading and the supplied description or a short placeholder.
An existing file is never rewritten. Refine its instructions directly in your
editor; the wizard is not a prompt authoring tool. The optional configuration
description is a human-readable summary, not an additional instruction layer.

Editing preselects the current required and available skills. Enter keeps the
current description and file path; `-` clears the description. The role ID is
stable: renaming is not part of this command.

Deletion previews removal from `agents.yaml` and preserves the role Markdown
and all skills. Deleting the default role requires another existing role as
its replacement. The only/default role cannot be deleted until another exists.

## Selecting skills

The first list selects **required** skills, which apply to all work in the role:
instruction skills are injected and supported host-native skills invoked. Keep this list
small. The second selects **available** skills, listed for the role and used only
when a task falls within the skill's description. Required skills are excluded from
the available list. Selecting a skill routes it; it does not hide other host skills,
which Claude Code lists to every role.

Each entry shows its identifier, name, short description, and source path.
The list is paginated rather than assuming all skills fit on one screen:

| Input | Action |
| --- | --- |
| `1,3` or `1 3` | Toggle the numbered entries on the current page |
| `n` / `p` | Next / previous page |
| `/security` | Filter IDs, names, descriptions, sources, and paths |
| `/` | Clear the filter |
| `clear` | Deselect everything in the current category |
| Enter or `done` | Accept the selection |
| `q` | Cancel this role operation without saving |

Filtering and paging preserve selections. Choosing a different source for the
same ID replaces its previous selection. The final preview shows the actual IDs
and paths that will be saved. Enter `y` to save; any other answer cancels.

## Local sources and duplicates

Discovery inspects only these known resources:

- `.agent-profiles/skills/<id>/SKILL.md`;
- `.claude/skills/<id>/SKILL.md`;
- explicit paths in the top-level `skills` map.

The directory sources inspect one level of skill directories. Skills under
`.claude/skills/` are **host-native**: selecting one saves a reference such as
`release-notes: {host: claude, scope: project}`, and agents invoke it through Claude Code instead of
receiving its text. The metadata reader extracts YAML `name` and `description` from
each resource's frontmatter; when `name` is absent, the directory name is used, as in
Claude Code. Host skills may omit `description`. Full instruction bodies are not displayed or included in the
catalog. Invalid unconfigured candidates are skipped with an explanation;
invalid configured references fail normal validation. Missing source directories
are normal. A repository with no skills can still create roles with empty lists.

Duplicate IDs appear as separate entries with their source paths. The wizard
does not silently pick a source or overwrite a binding used by another role.
A Claude skill keeps its host identity. If `testing` already names the conventional
Agent Profiles skill, selecting Claude's `testing` fails and asks you to rename one
of them; it is never renamed to a second ID.

A mapped repository file (not a host skill) can instead receive an explicit alias.
If `testing` is already bound, selecting `team-skills/testing/SKILL.md` creates:

```yaml
skills:
  testing-2:
    file: team-skills/testing/SKILL.md

roles:
  qa:
    file: roles/qa.md
    skills:
      required: [testing-2]
      available: []
```

The preview shows this alias before saving. Existing mappings to the selected
resource are reused; occupied IDs are skipped when choosing a numbered alias.
Other roles can continue to reference the original `testing`. Skill files are
never copied, rewritten, or deleted. Unused source mappings are retained.

Additional repository layouts can be added through the source adapter table in
[skills.js](../src/skills.js) or explicit repository-local file mappings.
External discovery is opt-in as described below; no remote registry is queried.
Manual user/plugin native references remain supported and installation-unverified.
Editing a role retains these references even when their metadata is unavailable.

## External native skills (opt-in)

```sh
agent-profiles skills --external --json
agent-profiles configure --external
agent-profiles doctor --external
# An explicit machine-local preferences file implies --external:
agent-profiles configure --sources /path/to/skill-sources.json
```

Personal Claude and Codex skills are inventoried without copying their bodies.
Explicit Claude plugin roots require the native plugin namespace. See
[external skill sources](hosts/external-skill-sources.md) for current defaults,
host-home overrides, the local JSON schema, symlink containment, and supported layouts.
Preferences and inventory paths stay outside shareable repository configuration.

The picker displays host, scope, native identifier, origin path, and availability.
Search also matches host/scope/native identity/status. External aliases such as
`codex-user-audit` save `{host: codex, scope: user, id: audit}`; they do not rename
the native command. Existing configured aliases are reused. Fully qualified
Claude plugin IDs stay qualified, for example `toolkit:lint`. Ambiguous external
origins are disabled, not silently chosen. Claude personal skills shadow matching
project names; Codex project/user duplicates cannot select an exact origin through
this portable reference and are rejected. Only the selected repository root is
checked for project conflicts; enterprise, additional directories and unobserved
host catalogs may have other conflicts.

`metadata-found` means frontmatter was found, not that the host enables or can
invoke the skill. `not-found` means no matching user skill was found in the
inventoried roots. An opaque plugin reference remains `host-provided-unverified`.
Missing references remain editable and travel as references in presets. Native
implementations are never bundled, injected, or included in managed-context bytes.

New disk selections are validated again before preview and save. Missing, changed
metadata, repointed links, and known origin conflicts abort before writes. This is
not a filesystem sandbox or an atomic snapshot of host enablement. `resolve` stays
repository-scoped and does not scan user roots; normal `doctor` reports compatibility,
while `doctor --external` additionally prints inventory availability and warnings.
Codex native bindings currently support user scope only; project directories are
inspected solely for user-name conflict detection. Admin, bundled/system, Codex
plugins, and Claude downloaded/enterprise catalogs are not automatically inventoried.

## Safe configuration changes

The wizard previews and validates the proposed role using the same resolver as
`doctor`, including a prospective new role file held in memory. No repository
files are created during planning. It checks again before writing and validates
the saved configuration afterward.

YAML is edited through the existing parser's document nodes. Model and family
mappings, defaults, unrelated roles, comments, and newline style are preserved;
serialization may normalize whitespace when a real edit is made. A no-op edit
keeps the file byte-for-byte unchanged. Descriptions and explicit source aliases
use the existing human-editable YAML configuration, not a separate database.

An aliased role is detached when edited so its source remains unchanged. Roles
that define YAML anchors require manual editing to avoid changing other aliases.
Changed configuration snapshots abort saving rather than overwriting concurrent
edits. The shared installer write path supplies temporary-file writes and rollback
on detected failure. Linked mutation paths are refused. Existing role Markdown
and shared skill contents are never modified by a role edit.

## Configuration API

The prompt-free API is shared with the wizard:

```js
import { planRoleChange, applyRoleChange } from './src/configure.js';

const plan = planRoleChange({
  root: '/path/to/repository',
  action: 'create',
  id: 'qa',
  description: 'Verify release readiness.',
  required: ['code-review'],
  available: [{ id: 'release-notes', host: 'claude', hostId: 'release-notes', path: '.claude/skills/release-notes/SKILL.md' }],
});
// Show plan.changes, plan.aliases, and plan.resolution, then obtain confirmation.
const result = applyRoleChange(plan);
```

`edit` accepts the same fields; omitted skill lists keep existing assignments.
`delete` needs an ID and, when deleting the default, `defaultRole`. Passing
`expectedConfiguration` from `readConfiguration(root).before` also protects a
form that has been open while another editor changes the YAML. Discovery uses
`discoverSkills(root, configuration)` and returns `skills`, `duplicates`, and
`warnings` without changing configuration or loading the catalog into an agent.

Model configuration, integration selection, context-weight estimates, and a
visualizer are outside this wizard's scope.
