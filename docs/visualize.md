# Local context visualizer

From a checkout with dependencies installed:

```sh
node bin/agent-profiles.ts visualize --root /path/to/project
node bin/agent-profiles.ts visualize --host codex --model example-model --role reviewer --skill testing
```

The installed CLI exposes the same command as `agent-profiles visualize`.
Open the printed URL in a browser on the same machine. The server binds only to
`127.0.0.1` and chooses an available port. Use `--port 8080` for a specific port;
an occupied port produces an error. **Ctrl+C** stops the server. It does not
automatically open a browser or install software. It changes your configuration
only when started with `--edit` (see [Edit the configuration](#edit-the-configuration)).
Root discovery matches the other CLI commands: nearest Git root, or `--root`.

## Explore a resolution

- **Host** lists the resolver's supported host IDs, including `codex` and `claude`.
  It starts unspecified unless `--host` is supplied. Changing only the host
  re-resolves host-qualified assignments without changing the model or role.
- **Model** lists configured model IDs and aliases, plus exact IDs named by adapter
  assignments. These extra choices do not declare models or change profile-routing
  provenance. The unspecified choice exercises
  fallback routing. An explicit CLI `--model` is also selectable, even if it is
  not configured.
- **Family fallback** is supplied independently. Routing follows the resolver:
  exact model, alias, supplied family, the longest configured family prefix, then
  the default profile. The routing line names the rule used, and the canonical
  model for an alias.
- **Role** lists configured roles and starts with the default or CLI `--role`.
  Changing a role clears temporary skill requests. Changing model or family
  retains requests for the same role.
- **Required skills** are injected for all work in the role. Checkboxes request
  available instruction skills temporarily. Host-native skills appear with their
  host skill ID and verification state, marked as invoked through the host, with
  no checkbox and no byte count. Each change calls the existing resolver, which classifies
  requested entries and produces the new totals.
- Expand an entry to inspect its repository-relative path, bytes, Unicode code
  points, and why it is included. Loaded entries also expose their instruction
  text as plain text. Unrequested skill bodies are not sent to the browser.
- **Pin for comparison** keeps one resolution in memory and compares its category
  byte totals with the current selection. Pin again to replace it, or clear it.

An unspecified host leaves host-skill usability unknown. Selecting a host previews
that host's resolution; it does not attest to instructions delivered to an agent.

Selections and pins belong to the current page session; they are not saved to
disk or browser storage. Reloading the page returns to the launch selections.
Click **Refresh files** after editing configuration or instructions. It rereads
project and adapter configuration, the adapter reference, instruction resources,
locks, trust policy and approvals through the existing resolver. It retains valid
host, model, family, role and optional skill selections at the same URL.
There is no background polling or file watching. Changing a selector also resolves
its current selection on demand.

Removed choices produce a notice: host/model/family fall back to unspecified,
role falls back to the current default, and unavailable optional requests are
removed. A pinned result remains explicitly a snapshot for comparison.
Individual filesystem reads are not an atomic snapshot across files.

Invalid configuration, missing adapters, stale or invalid locks, and trust or
approval failures hide the previous result and show an error. This includes the
resolver's `withheld` skills: the browser does not present partial instructions as
a successful current result. After repair, click **Refresh files** again to recover at the same URL.
The server also validates before starting; a startup error must be fixed before
launch. In the default read-only mode it never installs packages, signs approvals
or regenerates locks.

## Browse and compare skills

The **Skill library** panel loads only after you select **Load skill library**.
It lists every library skill package version and every discovered project-local
skill. Each entry shows its version (or "unknown version (local, unversioned)"),
source, abbreviated SHA-256 (marked with `…`), the roles that list it, and its
evidence status. No evidence is shown as `untested`, not as a recommendation.

- **Search** matches the name and description. **Show** filters to library
  packages, project-local skills or skills used by a role.
- **Set as left** and **Set as right** on a row fill the comparison sides, so
  you can pick from the filtered table instead of the selection lists.
- **Compare skills** takes any two entries. These can be two versions of one
  package, differently named packages, or a local skill. Each side shows its
  identity, full digest, source, usage, evidence and files.
- **View** chooses how files are shown. **Unified changes** lists changed files
  only, as unified diffs with three lines of context. **Side by side, full files**
  lists every file, unchanged ones included, with every line of both sides
  aligned and numbered. Changed, removed and added lines are highlighted, and
  unchanged files start collapsed. Binary files are named without their contents.
- **Preview** on a role's usage switches the resolution view to that role and
  requests the skill when the role offers it as available. The preview uses the
  current configuration, so it shows the pinned version for that role. It does
  not swap in a different version, and it writes nothing.

## Edit the configuration

Start the visualizer with `--edit` to change the configuration from the page:

```sh
node bin/agent-profiles.ts visualize --root /path/to/project --edit
```

The header then shows **LOCAL · EDITS ON**. Without `--edit` the page and the
server stay read-only.

- **Add to role** buttons in the skill library add a skill to the role selected at
  the top, as required (always loaded) or available (on demand). Adding a skill
  that the role already lists in the other list moves it. A library package can be
  added once the project binds it; binding a new package version comes next.
- **Move to on demand** on a required skill card, and **Move to required** on an
  on-demand card, move the skill between the role's two lists.
- **Remove** on a skill card removes that skill from the role. A confirmation
  dialog names the skill and role first; cancelling changes nothing.
- **Add to configuration** adds a model (with its profile), a family (with its
  profile and optional prefixes) or a role (with a starter instruction file under
  `.agent-profiles/roles/`). Hosts are built into Agent Profiles and cannot be added.

Each edit is written to the layer that owns it. Without an adapter, that is the
project's `agents.yaml`. With an adapter:

- Models, families and new roles go to the project's `agents.yaml`, because an
  adapter may not declare them.
- A skill change on an adapter role goes to the adapter's `agents.yaml`.
- An adapter skill added to a project role is appended by the adapter, because the
  project must still work without the adapter.
- A skill listed through one layer must be removed there before it can move to the
  other list through the other layer.

Every edit is checked before anything is written. The project must validate alone
and composed with its adapter. Comments and unrelated YAML are kept. The edit is
written atomically and rolled back if the follow-up lock refresh fails. Lock
refresh covers the project lock and, with an adapter, the adapter lock. It reads
packages from the local store only. It never signs approvals or downloads
anything. If the files changed since the page loaded, the edit is refused with a
request to use **Refresh files**.

## Open a project with an external adapter

Since 0.24.0, point `--root` at the real project containing
`.agent-profiles/agents.local.yaml`. The visualizer uses the supported composed
configuration and resolver, including adapter-owned role files and locks. No
snapshot helper, copied configuration or stripped host predicates are needed.

On Windows, to test a source checkout instead of an older workbench installation:

```powershell
npm run build
node C:\workspace\Agent-Profiles\dist\bin\agent-profiles.js visualize --root C:\workspace\Agent-Profiles --host codex --model gpt-6.1-sol --role sp-implementer
```

Run with the same `AGENT_PROFILES_TRUST` value as the CLI/MCP process you are
comparing. Preserve that policy and signing settings. Building this checkout
does not upgrade a package installed in another workspace. Stop the old snapshot
server and launch the new runtime once; subsequent edits need only **Refresh files**.
Version 0.24.1 requires no YAML, lock-format or bootstrap migration. Until a package
is published, use the built checkout or a locally packed artifact.

This updates only the visualizer. Already-running agents must resolve Agent
Profiles again to receive changed instructions.

## Package-aware selections

Pass `--store <directory>` at launch, or `storeRoot` to `startVisualizer`. The server
keeps this operational context through initial validation and later resolutions;
HTTP queries cannot override it. Package-backed profile/role/skill rows show typed
identity/version/digest/revision/provenance instead of a fictitious repository file path.
A package's verified bytes do not establish native invocation. Required public
resolution still refuses missing/stale/invalid package locks or backing; fix them
through separately approved dependency operations, not this read-only view.

The [package guide](versioned-packages.md) explains snapshots and export separately
from this live view. Listener/interception and stubbed UI test evidence is not a
claim that every actual browser or live host has been qualified; those release
gates remain separate.

## Accounting and privacy

The view uses the [context proof contract](proof.md). Managed totals contain only
resolved profile, role, required-skill, and requested-skill instruction bodies.
Available-but-unloaded context is separate; it is not a savings claim without
a baseline. Byte counts use UTF-8 and characters are Unicode code points.
Tokens are explicitly not calculated. Bootstrap instructions, host-native skills,
inventory rendering, and output formatting are outside the totals.

Project instructions such as `AGENTS.md` remain host-supplied and unmeasured.
System instructions, built-in tools/skills, and other host context remain
unobserved. Unknown is never displayed as zero or added to managed totals.

There are no accounts, remote assets, telemetry, uploads, or external services.
The server serves only three bundled UI assets and read-only JSON endpoints. With
`--edit` it also accepts `POST api/edit`, which requires the session URL, a
same-origin `Origin` header, a JSON body, an `X-Agent-Profiles-Edit: 1` header and
the configuration revision from `api/config`.
It uses a random session URL, rejects foreign Host/Origin and cross-site requests,
and sends no-store and restrictive content-security headers. Instruction text is
inserted as text, never executable HTML or rendered Markdown. Treat the session
URL as private while the process is running: local clients with that URL can
read the resolved instructions. This is not isolation from other local processes.

## API and reuse

The family selector holds only an explicitly supplied family override. A family
inferred from a model prefix is shown in the resolution, not promoted into selector
state; changing the model recalculates prefix routing.

```js
import { startVisualizer } from './src/visualize.ts';

const { server, url } = await startVisualizer({
  root: '/path/to/project', model: 'example-model', role: 'reviewer',
});
console.log(url);
// When finished: server.close(); server.closeAllConnections();
```

Under the printed session URL:

| GET endpoint | Response |
| --- | --- |
| `api/config` | Composed `hosts`, `models`, `families`, `roles`, per-role `optionalSkills`, `defaultRole` and initial selection; required lock preflight |
| `api/resolve?host=codex&model=example-model&role=reviewer&skill=testing` | Existing resolver result, including loaded contents and diagnostics |
| `api/skills` | Skill catalog: library skill packages per version (source, SHA-256, revision digest, description, project pin bindings, roles listing the bound skill as required or available, evidence row count) and discovered project-local skills (`version: null`) with role usage |
| `api/compare?left=package:@example/review@1.0.0&right=local:.agent-profiles/skills/testing/SKILL.md` | Side-by-side comparison of two skills: identity, digest, metadata, usage, evidence (`untested` when no rows exist), each file's size, SHA-256 and binary flag, a unified diff per changed text file (`diff: null` for binary files), and `aligned`: every file of both sides with its status (`same`, `changed`, `added`, `removed`) and side-by-side `rows` of `{kind, left: [line, text] | null, right: [line, text] | null}` (`rows: null` for binary files) |

Selectors are `package:<name>@<version>` for a verified library version and
`local:<repository path>` for a discovered project-local skill. A local selector
must name a skill that discovery found; it cannot read other repository files.
Local skills compare their `SKILL.md` and declared resources, with paths relative
to the skill directory. Comparison does not change configuration, pins, locks or
skill contents. External user or plugin skill roots are not included in this
catalog yet.

`host`, `model`, `family`, and `role` are optional single values; repeat `skill` to request
multiple skills. Omission invokes the resolver's usual defaults. Invalid input
returns HTTP 400 with `{ "error": "..." }`. The endpoint does not accept filesystem
paths or another repository root. Non-GET methods are rejected. No CORS access is
granted. External applications can consume the core resolver directly without
starting a server or knowing the YAML format.

Configuration enumeration uses `validateConfiguration` from disk; preflight,
selection and accounting use `resolveInstructions` from disk, preserving composition.
There is no second YAML parser, routing engine, or size
calculator in the browser. Imported preset roles work as ordinary roles. Inspecting
unimported presets, editing, hosted dashboards, execution, benchmarking, and token
estimation are outside this first visualizer.
