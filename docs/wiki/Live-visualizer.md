# Live visualizer

Version 0.24.0 (unreleased) opens a project with an external adapter directly:

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

The page polls its existing read-only endpoints after each one-second pause.
Two matching changed samples debounce saves; valid host, model, family, role and
optional skill selections survive. Removed choices show a notice and use an
unspecified selector or the current default role; removed optional requests clear.
Refresh files rereads immediately. The browser URL stays the same.

Project and adapter configuration, adapter references, instruction resources,
locks, trust policy and approvals are reread through the resolver. Malformed YAML,
missing adapters, stale locks and trust-withheld instructions hide old results and
show the reason. Repair files through the normal separate workflows; the page
recovers automatically. Startup validation errors must be fixed before launch.
If the server stops, polling stops; Refresh files reconnects after restart if that
same session URL is still available. A newly launched process prints a new URL.

The visualizer stays read-only: it never installs, signs, regenerates locks or
changes active selections. Existing agents still need to resolve Agent Profiles
again. A pinned comparison is explicitly a browser-session snapshot.

For the API, accounting boundaries and detailed instructions, see the
[visualizer guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/visualize.md).
