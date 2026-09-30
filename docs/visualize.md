# Local context visualizer

From a checkout with dependencies installed:

```sh
node bin/agent-profiles.js visualize --root /path/to/project
node bin/agent-profiles.js visualize --model example-model --role reviewer --skill testing
```

The installed CLI exposes the same command as `agent-profiles visualize`.
Open the printed URL in a browser on the same machine. The server binds only to
`127.0.0.1` and chooses an available port. Use `--port 8080` for a specific port;
an occupied port produces an error. **Ctrl+C** stops the server. It does not
automatically open a browser, install software, or modify your configuration.
Root discovery matches the other CLI commands: nearest Git root, or `--root`.

## Explore a resolution

- **Model** lists configured exact model IDs. The unspecified choice exercises
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

The visualizer resolves without a host, so host-skill usability is shown as unknown
and no requirement is marked unsatisfied; use `proof --host <id>` for that view.

Selections and pins belong to the current page session; they are not saved to
disk or browser storage. Reloading the page returns to the launch selections.
**Refresh files** rereads the configuration and resets temporary requests. Every
resolution reads current instruction files. A pinned result remains a snapshot,
so refreshing after edits can compare an earlier result with current content.
This is not an atomic filesystem snapshot: avoid editing files mid-resolution.

Invalid configuration, missing references, and requests unavailable to a role
produce an error instead of fabricated counts. Fix the files and refresh, or
choose a valid selection. The server validates before starting as well.

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
The server serves only three bundled UI assets and two read-only JSON endpoints.
It uses a random session URL, rejects foreign Host/Origin and cross-site requests,
and sends no-store and restrictive content-security headers. Instruction text is
inserted as text, never executable HTML or rendered Markdown. Treat the session
URL as private while the process is running: local clients with that URL can
read the resolved instructions. This is not isolation from other local processes.

## API and reuse

```js
import { startVisualizer } from './src/visualize.js';

const { server, url } = await startVisualizer({
  root: '/path/to/project', model: 'example-model', role: 'reviewer',
});
console.log(url);
// When finished: server.close(); server.closeAllConnections();
```

Under the printed session URL:

| GET endpoint | Response |
| --- | --- |
| `api/config` | Validated `models`, `families`, `roles` arrays and initial selection |
| `api/resolve?model=example-model&role=reviewer&skill=testing` | Existing resolver result, including loaded contents and diagnostics |

`model`, `family`, and `role` are optional single values; repeat `skill` to request
multiple skills. Omission invokes the resolver's usual defaults. Invalid input
returns HTTP 400 with `{ "error": "..." }`. The endpoint does not accept filesystem
paths or another repository root. Non-GET methods are rejected. No CORS access is
granted. External applications can consume the core resolver directly without
starting a server or knowing the YAML format.

Configuration reading/validation uses `readConfiguration`; selection and accounting
use `resolveInstructions`. There is no second YAML parser, routing engine, or size
calculator in the browser. Imported preset roles work as ordinary roles. Inspecting
unimported presets, editing, hosted dashboards, execution, benchmarking, and token
estimation are outside this first visualizer.
