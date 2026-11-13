# Live visualizer

Version 0.24.1 (unreleased) opens a project with an external adapter directly:

```powershell
agent-profiles visualize --root C:\workspace\Agent-Profiles --host codex --model gpt-6.1-sol --role sp-implementer
```

Use a newly built checkout or locally packed artifact until this version is
published; see [Versioning and upgrades](Versioning-and-upgrades). The older
installed runtime in another workspace does not change when source files change.
Keep the same `AGENT_PROFILES_TRUST` value used by your CLI/MCP server.

The Host selector includes Codex, Claude and the other supported host IDs. Model
choices include exact adapter assignment IDs even if the project does not declare
them. Choosing one does not create a model declaration or change profile routing.
The package rows show identity, version, digest, revision when pinned, content and
UTF-8 byte counts from the resolver. No snapshot preparation or predicate removal
is needed.

Click **Refresh files** after editing files. It reads the real project and adapter
on demand, retaining valid host, model, family, role and optional skill selections.
Removed choices show a notice and use an unspecified selector or the current
default role; unavailable optional requests clear. The browser URL stays the same.
There is no background polling or file watching.

Project and adapter configuration, adapter references, instruction resources,
locks, trust policy and approvals are reread through the resolver. Malformed YAML,
missing adapters, stale locks and trust-withheld instructions hide old results and
show the reason. Repair files through the normal separate workflows, then click
**Refresh files** again. Startup validation errors must be fixed before launch.
If the connection fails, Refresh files retries when that
same session URL is still available. A newly launched process prints a new URL.

Without `--edit` the visualizer stays read-only: it never installs, signs,
regenerates locks or changes active selections. With `--edit` (from 0.29.0) you can
add and remove role skills and add models, families and roles from the page. Each
edit goes to the layer that owns it and refreshes locks; see the visualizer guide. Existing agents still need to resolve Agent Profiles
again. A pinned comparison is explicitly a browser-session snapshot.

## Visualizer app

From 0.31.0, `visualize` serves the separate
`@guisam/agent-profiles-visualizer` app when the project has it installed as a
development dependency, and prints its version at startup. Use `--ui builtin`
for the built-in page. The app uses the same API, session URL and `--edit`
rules. See [docs/visualize.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/visualize.md#use-the-visualizer-app)
for what is served and the content security policy.

## Skill library

From 0.27.0 (unreleased), select **Load skill library** to browse library skill
packages and project-local skills. Search and filter them, then compare any two
entries file by file. That includes two versions, differently named packages or
a local skill. Binary files are named, not shown. Missing versions, digests and
evidence appear as unknown or untested. **Preview** switches the resolution view
to a role that uses the skill, with the current configuration. It does not swap
versions or write files.

From 0.28.0, **Set as left** and **Set as right** on each row fill the comparison.
**View → Side by side, full files** shows every file of both skills, unchanged
lines and files included, aligned line by line like a two-pane diff tool.

From 0.30.0, with `--edit`, **Bind and add** binds a library version the project
does not bind yet and lists it in the selected role. Skills sharing a SKILL.md
`name` are variants: **Use for *role* instead of *skill*…** previews replacing a
package skill for the selected host × model × role, as `agent-profiles update`
does, and applies it after you confirm.

For the API, accounting boundaries and detailed instructions, see the
[visualizer guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/visualize.md).
