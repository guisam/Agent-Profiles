# Project adapter: a local layer over committed configuration

Issue: [#85](https://github.com/guisam/Agent-Profiles/issues/85). Since 0.20.0 (first slice).
Guarded updates: [#97](https://github.com/guisam/Agent-Profiles/issues/97), since 0.21.0.
Stamps, verify/diff, evidence and inspect: [#98](https://github.com/guisam/Agent-Profiles/issues/98), since 0.22.0.

A contributor can use private, pinned skills in a project without changing the
project's committed configuration, lock or npm package. One ignored file names one
external **adapter** directory. Agent Profiles composes the adapter over the
committed configuration.

```text
project/.agent-profiles/agents.yaml          committed, portable defaults
project/.agent-profiles/agents.local.yaml    ignored: adapter: ../project-config
project-config/.agent-profiles/agents.yaml   the adapter's additions
project-config/.agent-profiles/roles/*.md    files for roles the adapter adds
project-config/.agent-profiles/agent-profiles.lock
project-config/.agent-profiles/approvals/    approvals recorded in adapter mode
```

Keep the adapter in its own repository, one adapter per project. Packages come
from the local library by `name@version`. The adapter does not reference the
repository the packages were built in.

## Connection

`.agent-profiles/agents.local.yaml` contains one required key and one optional key:

```yaml
adapter: ../project-config   # relative to the project root, or absolute
label: team-workshop         # optional (0.22.0): names the adapter in stamps and evidence
```

A `label` is 1–64 letters, digits, spaces, dots, hyphens or underscores. It
cannot contain a slash, backslash or colon, so it cannot carry a path.

- No local file: the committed configuration alone applies.
- The reference must resolve to an existing directory outside the project that
  does not contain the project, with `.agent-profiles/agents.yaml`. Otherwise
  every command that reads configuration fails and names the remedy. There is no
  silent fallback.
- An adapter cannot contain `agents.local.yaml` (no chains) or `trust.yaml`.
- Add `.agent-profiles/agents.local.yaml` to the project's `.gitignore`. The npm
  package never includes it (`test/package-files.test.js`).

## Precedence

Every binding and every assignment belongs to exactly one layer. The adapter
adds; it never overrides.

| The adapter may | The adapter may not |
| --- | --- |
| Add skills under new IDs, bound to packages | Redeclare a project skill, role, profile or assignment |
| Append skills to a project role's `required`/`available` lists | Change a project role's file, package or description |
| Add roles, with a file in the adapter or a package | Shadow a project file with an adapter file |
| Add assignments that select only adapter-declared bindings | Assign versions to a project binding |
| | Set `default_profile`, `default_role`, `models`, `families`, `profiles` or `workflow_links` |

### Exact-model selection

An adapter assignment may name, in `when.model`, an exact model ID that the
project does not declare. This applies only to the adapter's own bindings. The
project's `models` routing is not changed: the profile still comes from the
project's model, family or default route.

```yaml
skills:
  review: {package: "@local/review", version: 1.0.0}      # baseline
assignments:
  opus-review:
    when: {model: claude-opus-5-5}
    versions: {skills.review: 1.1.0}                       # exact model only
```

Only a host-stated model equal to that ID selects the rule. No model, another model,
a near match such as `claude-opus-5-5-20261101`, a prefix, or a different case keeps
the baseline. An ID that is a project alias is refused; name the canonical model.
Validation checks every adapter-named model under the default and each family
profile, so an ambiguous combination is refused before any session.

Within one layer the existing rule applies: per binding, a matching rule with a
strict superset selector wins, and incomparable or duplicate rules are refused.
Because ownership is exclusive, no rule compares across layers.

Versions: the adapter declares `version: 2` or `3`. It composes with a project of
the same version. It also composes with a version 1 project if the adapter is
version 2, because v1 to v2 changes only the scalar.

Trust is unchanged: the machine policy narrowed by the project's `trust.yaml`.

## Locks, approvals and signing

- With an adapter, the lock lives in the adapter and covers the whole composed
  configuration. `install` writes only that lock. The project's lock is not read
  in adapter mode, and `install` does not write it. Any change to the project
  configuration, the reference or the adapter configuration makes the adapter's
  lock stale. A project-owned `update` (below) refreshes the project's lock and
  leaves the adapter's stale.
- Approval checks read the project's `approvals/` and the adapter's.
  Approval files name the package, version and digest, not a path, so moving them
  between the two does not invalidate a signature.
- Signing is separate. `install` and `update` never sign or write approvals.
  `library approve` is the only command that signs; in adapter mode it records the
  approval in the adapter.

## Commands

Commands that compose the adapter: `resolve`, `install`, `doctor`, `notice`,
`library`, `outdated` (read-only), `update` (see [Updates](#updates)), `mcp`
(including `update_preview`), and, since 0.22.0, `stamp`, `verify`, `diff`,
`inspect` and `sessions` (see
[Stamps, verify, diff and evidence](#stamps-verify-diff-and-evidence)).

Every other command refuses while an adapter is configured. This includes
`configure`, `init`, `uninstall`, `preset`, `migrate`, `materialize` and
`revision`. Each names the local file to move aside to run on the committed
configuration. They do not act on one layer silently.

Provenance: `resolve --json` and MCP `explain` include an `adapter` field (its
reference, root and the entries it added) only when an adapter composes. `doctor`
reports the same. Committed-only output is unchanged.

## Updates

Since 0.21.0 (#97), `update` and MCP `update_preview` work with an adapter. The
layer that declares a binding owns its updates:

| Binding declared by | Apply writes | Apply does not write |
| --- | --- | --- |
| the adapter (`skills.<id>` or `roles.<id>` in the adapter) | the adapter's `agents.yaml`, then the adapter's lock | any project file |
| the project | the project's `agents.yaml`, then the project's lock | any adapter file |

- **Preview** lists each edit with its `layer` and `file` (relative to the project
  root), and a `locks` list with the action for each lock. JSON output also
  carries `layer` and `adapter` (reference and root).
- **Adapter-owned updates.** The rule is added to the adapter, or the adapter's
  rule for the exact tuple is replaced. For a model that the project does not
  declare, the rule names the exact model ID. No `models` entry is added, because
  models are project policy. Routing, profiles and the baseline pin for every
  other model stay unchanged.
- **Project-owned updates.** The edited project configuration must be valid on its
  own and composed with the adapter. Apply refreshes the project's lock for the
  committed configuration alone. The adapter's lock covers the composed
  configuration, so it becomes stale. `update` does not write it. Run
  `agent-profiles install` as a separate step; it writes only the adapter's lock.
  Until then, resolution in adapter mode reports `stale-lock`.
- **Cross-layer edits are refused.** An example is a project assignment that
  selects an adapter binding for the exact tuple. Nothing is written.
- **Stale previews.** `previewDigest` covers the project's `agents.yaml` and lock,
  `agents.local.yaml`, the adapter's `agents.yaml` and lock, the adapter root, the
  store, and the current and target package identities. With `--expect`, apply
  refuses a change to any of them, and nothing is written.
- **Trust.** Apply never signs or writes approvals. Under `require_approval`, apply
  refuses an unapproved target. Approve it with `agent-profiles library approve` as a
  separate step. Approvals from the project and the adapter both count.
- **Stamps.** After an adapter-owned update, apply records a composed stamp
  (0.22.0). After a project-owned update the adapter lock is stale, so apply
  records none (`stampDigest: null`) and says so. Run `agent-profiles install`,
  then `agent-profiles stamp`.
- `outdated` lists each pin's `layer`. Its tuples include the exact model IDs that
  adapter rules name.

## Stamps, verify, diff and evidence

Since 0.22.0 (#98), `stamp` works with an adapter. A composed stamp has an extra
`configurationSources` field. A committed-only stamp never has it, so its bytes
and digest are the same as in 0.20.0.

`configurationSources` holds:

| Field | Content |
| --- | --- |
| `mode` | `composed` |
| `adapter` | `label` (from the local file, or `null`) and `referenceDigest` |
| `configuration` | the composed configuration: its `digest` (the `configSha256` the adapter lock covers) and a blob of its canonical record |
| `inputs` | each contributing file by `layer` and `kind`: the project's `agents.yaml`; the local reference (digest only); the adapter's `agents.yaml`, role files and lock |
| `approvals` | adapter approvals for the captured package versions, by package, version and principal, with the payload and signature bytes |
| `adapterEntries` | the declarations the adapter added, as in `resolve --json` |

- **No machine paths.** Every file path is relative to its layer's root. The
  local reference is recorded only as `referenceDigest`: a SHA-256 of the
  reference text as written. Approval rows carry no path. Set `label` to choose
  the name shown in stamps, session records and the MCP stamp line. A short
  reference has few possible values, so its digest identifies it but does not
  hide it; a label shows a chosen name instead.
- **Capture.** The stamp resolves exactly the captured layer bytes. It refuses
  with `stale-lock` when the adapter lock does not cover the composed
  configuration. Role files the adapter adds are captured from the adapter, at
  their project path.
- **Approvals and trust.** The stamp keeps approval bytes, not verdicts. Trust
  policy is machine-local and still checked live when resolving.
- **`verify`** adds a `configuration` report: the status of each input
  (`reproducible`, `missing`, `mismatched`, or `digest-only` for the local
  reference), each approval's status, whether the composed record matches its
  digest, and whether the captured adapter lock covers it
  (`lockCoversConfiguration`). `configurationReproducible` is true when all of
  these hold. Otherwise a finding names what failed and `verify` exits 1.
- **`diff`** gives each change a `layer`: `project`, `adapter`, `local` (the
  label or reference), `composed` (the composed record), or `derived` (selection
  and package results). Profiles, shared files and project roles and skills are
  `project`; roles and skills the adapter added, and its inputs and approvals, are
  `adapter`. `layers` counts the changes per layer. `configuration` gives each
  side's `mode`, `configurationDigest` and `adapter`. `sameMode` is false when one
  stamp is committed-only and the other composed. Two committed-only stamps diff
  exactly as before.
- **Evidence.** Session records (`resolve --record-session`, `mcp
  --record-sessions`) state the `configuration` mode, and for a composed run its
  digest and adapter (see [session records](sessions.md)). The MCP stamp line names
  the adapter and configuration digest. A composed stamp and a committed-only one
  always have different digests. Do not pool results from the two modes, or
  from different configuration digests, as one configuration.
- **`inspect`** lists the adapter under `repository.adapter`: its reference, label,
  reference digest, status, the entries it declares, and its files (the local
  reference, `agents.yaml`, lock and role files) with size and availability. Every
  read is bounded and stays inside the adapter root. A role file whose path
  leaves the root, or a link, is reported `unavailable` and is not read. Local
  inventory output still shows the local paths, as it does for the project.

## Migration and rollback

The workshop repository provides a snapshot-backed tool:
`workflow-skills/scripts/adapter-migration.mjs`.

1. `snapshot` copies `.agent-profiles/**` and host files and hashes them. It also
   records the resolution of every role × model × host, plus approval status for
   each pinned package.
2. `migrate` refuses if anything changed since the snapshot. It writes the overlay
   (adapter additions only), the added role files and the approval bytes to the
   adapter. It then restores the committed `agents.yaml`, adds the reference and
   runs `install`. It compares every resolution with the snapshot, and rolls back
   on any difference.
3. `rollback` restores the snapshot bytes, removes the reference and verifies
   resolutions. It does not change the adapter directory.

## Not in this slice

The configure, preset and migration writers do not target an adapter yet.
`materialize`, `revision` and the `migrate` evaluation workflow still refuse in
adapter mode. Adapters cannot declare or route models;
exact-model selection above does not change routing. Adapter roles cannot declare
`resources`.
