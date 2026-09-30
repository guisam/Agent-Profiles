# Shareable presets

A preset is an inspectable set of opinions about roles, profiles, and skills.
Authors choose the instructions; Agent Profiles supplies the composition format.
Imported definitions become ordinary editable configuration, with no runtime
dependency on the preset and no automatic synchronization.

## Try the example

From this checkout, after `npm ci`, against an initialized project:

```sh
node bin/agent-profiles.js preset inspect examples/presets/release-review --root /path/to/project
node bin/agent-profiles.js preset inspect examples/presets/release-review --root /path/to/project --contents
node bin/agent-profiles.js preset import examples/presets/release-review --root /path/to/project
node bin/agent-profiles.js doctor --root /path/to/project
```

The [example manifest](../examples/presets/release-review/preset.yaml) supplies a
release reviewer, a small profile, and a release-checklist skill. It expects
`testing` locally (present in the initial scaffold). The fictional family mapping
is illustrative, not a capability rating. The example files use this repository's
Apache-2.0 license.

With the CLI installed, use:

```sh
agent-profiles preset inspect /path/to/preset --contents
agent-profiles preset import /path/to/preset --role reviewer
agent-profiles preset export /path/to/new-preset-directory
```

Sources are **local directories**, including directories checked into Git. No
archive, URL, registry, authentication, or remote download support is included.
Relative paths are relative to the invoking shell's working directory; `--root`
selects the target repository. Inspection works outside Git. Within a repository
it checks local conflicts and dependencies; without an initialized target it
summarizes the source and explicitly reports that those checks were not performed.

## Inspect and import

Inspection lists author/version/license, roles and skill assignments, included
profiles and skills, required local skills, model/family mappings, and defaults.
With a target, it also lists proposed file changes, conflicts, and unresolved
references. `--contents` shows every referenced Markdown file, with terminal
control characters removed. Inspection never modifies the source or target.

Import selects all roles by default; the paginated selector lets you choose a
subset. `--role <id>` may be repeated to select roles explicitly. All included
profiles and model/family recommendations participate in the import; only skills
used by selected, imported roles are copied or required locally. Keeping a local
role skips its preset skill dependencies. Optional defaults require a separate
opt-in prompt, and the final preview requires confirmation before any write.

Conflicts never imply approval to overwrite:

- **keep** retains the existing local definition and file. A loose role file
  without a configured role cannot be kept as a definition; use rename or replace.
- **replace** explicitly replaces the definition and canonical destination file.
  References from other local roles/models to that ID will see the replacement.
- **rename:new-id** imports a role, profile, or included skill under a fresh ID,
  updating references within incoming definitions. Local references are unchanged.
- **cancel** leaves the repository untouched.

Model/family mapping conflicts support keep, replace, or cancel. IDs and files
that exist only on disk also count as conflicts. Changed role definitions use
`roles/<id>.md`; included skills use `.agent-profiles/skills/<id>/SKILL.md`. Older
custom-path files are retained when their mappings are replaced. Missing skills,
invalid references, and occupied rename destinations block application.

Local skill requirements use an exact existing top-level `skills` mapping, a
host-native reference, or the conventional `.agent-profiles/skills/<id>/SKILL.md`.
The importer does not guess from similarly named Claude skills or search other
directories. Use the existing wizard to bind such a resource explicitly first. Both
required and available role skills must resolve; missing dependencies are never dropped.

A preset may also declare host-native skills under `skills.host`
(`release-notes: {host: claude}`). Import adds the same reference to `agents.yaml`;
it never converts a host skill into injected Markdown or drops it. If the target
repository lacks that host's integration, the preview shows a note and the reference
is kept. If the ID already names a different local skill, import stops until one is
renamed. Export writes the host skills of selected roles to `skills.host`; they
cannot be included as files.

After a successful import, an optional prompt opens the existing role/skill
wizard. These are subsequent edits with their own previews and confirmations;
cancelling customization does not undo the already confirmed import.

## Export

Export uses the existing selection UI to choose roles, profiles, and skills to
bundle. Unbundled skills referenced by selected roles become explicit local
requirements. The CLI asks for preset metadata and shows a preview before saving.
The destination must be a **new directory with an existing parent**. Existing
directories and files are never overwritten by export.

Export includes only model/family mappings targeting selected profiles, and only
defaults whose role/profile was selected. A roles-only preset can rely on the
destination's existing model profiles and default routing.

The initial format copies **Markdown instruction files only**, preserving their
bytes. It does not copy supporting scripts, images, linked documents, or folders
mentioned inside instructions, and does not rewrite links inside Markdown. Review
those references for portability, or leave a skill as a local requirement when
it depends on resources outside its instruction file. Review redistribution
rights before bundling someone else's skill.

## Authoring a manifest

```yaml
schema_version: 1
preset:
  name: review-team
  display_name: Review Team
  description: A small review configuration.
  author: Example team
  version: 1.0.0
  license: Apache-2.0
roles:
  reviewer:
    file: roles/reviewer.md
    description: Review changes for correctness.
    skills:
      required: [review-checklist]
      available: [testing]
profiles:
  review-scaffolded:
    file: profiles/review-scaffolded.md
families:
  example-family:
    profile: review-scaffolded
skills:
  requires: [testing]
  includes:
    review-checklist:
      file: skills/review-checklist/SKILL.md
  host: {}             # optional: skill ID -> {host: claude, id?: host skill ID}
defaults:
  role: reviewer
```

Place the referenced Markdown files beside `preset.yaml` at those relative
paths. Included skills use the same `name`/`description` YAML frontmatter as
local skills. See the checked-in example for complete file contents.

`schema_version`, `preset`, and a nonempty `roles` map are required. All six
metadata fields in the example are required nonempty strings; `preset.homepage`
and `preset.repository` are optional descriptive strings, never fetch targets.
`schema_version` identifies this format; `preset.version` identifies the author's
release and is stored as text, not interpreted as a dependency constraint.

`profiles`, `models`, `families`, `skills`, and `defaults` are optional. When
`skills` is present it must contain both `requires` and `includes` (which may be
empty). Every role skill must appear in exactly one of those declarations.
Role definitions use the ordinary file/description/required/available schema.
Profiles and included skills map IDs to `{file: <relative-markdown-path>}`.
Model/family maps use `{profile: <id>}` and may reference existing local profiles.
Defaults support `profile` and `role`; a default role must be declared in the
preset and selected for import when applying defaults. Unknown fields and
unsupported schema versions are rejected.

For different scaffolding needs, define ordinary roles such as `implementer`
and `implementer-scaffolded` with explicit skill lists and explain the intended
profile in their descriptions. Conditional role-by-profile routing is deliberately
not part of this format; model and role selection remain independent.

## Provenance, safety, and trust

`.agent-profiles/preset-origins.yaml` records the preset name, version, author,
source, and original ID under keys such as `roles.reviewer` or `profiles.review`.
The source is `preset.repository` when provided, otherwise the absolute local
source directory; inspect this metadata before sharing a repository. This is
origin information, not a synchronization lock or a claim that later edits still
match the preset. Ordinary wizard edits do not remove it; it may outlive a deleted
role. Export creates a new preset with the metadata you supply.

Review third-party instructions as you would source code. Only declared local
Markdown files are read/copied. Path traversal, escaping or linked mutation paths,
unknown manifest fields, and lifecycle hooks are rejected. No preset scripts are
executed, even if extra script files exist beside the manifest. Agent Profiles
does not certify instruction safety or prevent a host agent from following a
malicious instruction later; review the text before import and use host permissions.

The planner uses the existing resolver with an in-memory view of proposed files
to validate before writing. Application rechecks source/target snapshots, uses
the shared guarded writer and rollback, then validates the resulting configuration.
This protects against detected stale edits and write errors, not process crashes
or arbitrary simultaneous filesystem mutation. No global settings or host
integration files are changed by preset import/export.

## API

`readPreset(source)` validates the manifest and referenced files.
`planPresetImport({root, source, roles, decisions, useDefaults})` returns actions,
conflicts, errors, proposed changes, and `ready`. `decisions` is a Map keyed by
`roles.<id>`, `profiles.<id>`, `skills.<id>`, `models.<identity>`, or
`families.<identity>`, with the choices described above. Plans are read-only.
`applyPresetImport(plan, true)` applies a reviewed, ready plan; callers must
obtain explicit approval before supplying `true`.

`planPresetExport({root, destination, metadata, roles, profiles, includeSkills})`
creates an export plan; `applyPresetExport(plan, true)` saves it after approval.
Omitted role/profile lists select all; omitted `includeSkills` bundles none.
The CLI prompts for these choices. Remote sources and preset diff/update commands
are future work; there is no automatic policy enforcement or synchronization.
