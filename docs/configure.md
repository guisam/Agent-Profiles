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

The first list selects **required** skills, loaded whenever the role is active.
Keep this list small. The second selects **available** skills, whose metadata is
exposed until the task explicitly needs their instructions. Required skills are
excluded from the available list.

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

The directory sources inspect one level of skill directories. The existing
metadata reader extracts YAML `name` and `description` from each resource's
frontmatter. Full instruction bodies are not displayed or included in the
catalog. Invalid unconfigured candidates are skipped with an explanation;
invalid configured references fail normal validation. Missing source directories
are normal. A repository with no skills can still create roles with empty lists.

Duplicate IDs appear as separate entries with their source paths. The wizard
does not silently pick a source or overwrite a binding used by another role.
For example, if `testing` already refers to the conventional Agent Profiles
skill, selecting Claude's `testing` creates this explicit alias:

```yaml
skills:
  testing-2:
    file: .claude/skills/testing/SKILL.md

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

Additional layouts can be added through the small source adapter table in
[skills.js](../src/skills.js). This version does not scan home directories or
remote registries. To use a resource outside the automatic locations, add its
repository-local path to the existing `skills` map; it then appears in the wizard.

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
  available: [{ id: 'testing', path: '.claude/skills/testing/SKILL.md' }],
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
