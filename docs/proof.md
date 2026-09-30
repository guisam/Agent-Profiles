# Context proof

A context proof measures the marginal instruction context managed by Agent
Profiles. It is not necessarily a measurement of the agent's complete context
window. This implementation measures the **resolved instruction bodies** supplied
in the resolver's `loaded` list.

## Commands

From a checkout, after `npm ci`:

```sh
node bin/agent-profiles.js proof --model example-model --role reviewer
node bin/agent-profiles.js proof --model example-model --role reviewer --skill testing
node bin/agent-profiles.js proof --model example-model --role reviewer --json
node bin/agent-profiles.js proof --model example-model --role reviewer --json --contents
```

With the executable installed, use `agent-profiles proof` with the same flags.
`--root <directory>` targets another initialized repository; otherwise the CLI
uses the nearest Git root. `--host <id>` names the consuming integration, which
enables host-skill usability, unsatisfied requirements, and bootstrap block size.
`--family <id>` supplies an explicit family identity.
Omitted model/family identities use normal fallback rules; omitted role uses
`default_role`. One role may be selected per invocation. Repeat `--skill` to
request available skills. Unknown roles or skills are errors, not substitutions.

The human report shows the host (from `--host`), the selected model, its canonical ID and identity source,
the family and how it was found, the match rule, profile and role, injected paths
grouped by kind, byte/character totals, available context not injected, host-native
skills, and the bootstrap block size.
`--json` produces only JSON on stdout. `--contents` requires `--json` and adds
selected instruction text; it never adds unrequested skill bodies. JSON errors
go to stderr with exit code 1 and no partial JSON on stdout.

Run the command for two roles to compare their results. There is no separate
comparison command, preset benchmark, or visualizer. Imported preset roles use
the same resolver and diagnostics as any other local role.

## Measurements

| Field | Meaning |
| --- | --- |
| `loaded[].kind` | `profile`, `role`, `required-skill`, or `requested-skill` |
| `loaded[].id` | Profile, role, or skill ID |
| `loaded[].bytes` | UTF-8 byte length of that entry's resolved text |
| `loaded[].characters` | Unicode code points in that text |
| `required[]`, `available[]` | Existing skill metadata plus byte/character counts |
| `diagnostics.managed` | `profile`, `role`, `requiredSkills`, `requestedSkills`, and combined `total` |
| `diagnostics.availableNotLoaded` | Selected-role available instruction skills not injected (key name kept for compatibility) |
| `diagnostics.tokens` | `{value: null, kind: "not-calculated", method: null}` |

Each category and total contains `files`, `bytes`, and `characters`. Empty
categories have zero counts because their contents are known to be empty.
`files` counts instruction entries, not unique filesystem objects. Routing and
deduplication semantics are unchanged: repeated requests for the same skill ID
load it once; distinct aliases pointing to the same file still represent distinct
entries and are counted as often as they occur in `loaded`. A required skill
requested explicitly remains classified as required.

`available` remains the role's complete available catalog even when some entries
are requested. Subtract IDs present in loaded skill entries, or use
`diagnostics.availableNotLoaded`, to find the remaining potential context. A
requested available skill moves its full size into `managed.requestedSkills`
and out of `availableNotLoaded`. Required skills are already in managed totals.

Counts use the actual selected text, including in-memory wizard/preset previews.
No sizes are manually maintained. Frontmatter, whitespace, BOMs, and line endings
count as supplied. CRLF contributes two code points; an emoji normally contributes
one, and a combining mark contributes its own code point. Characters here are not
grapheme clusters or JavaScript UTF-16 code units.

Files are decoded as UTF-8 using Node's replacement behavior for malformed byte
sequences. Byte counts describe that resolved text re-encoded as UTF-8, so they
may differ from raw disk size for invalid UTF-8. No newline normalization occurs;
counts may differ between checkouts with different line endings.

To count selected-role available skills exactly, the resolver scans their text
in bounded chunks without retaining unrequested bodies in its output. Other
roles' skills still receive metadata validation only. This adds file I/O to
resolution, not those bodies to agent context. Measurement failures identify
the path instead of inventing zero counts. Counts are a view of files read by
that call, not a filesystem-wide atomic snapshot.

## Accounting boundary

The data model makes the boundary explicit:

```json
{
  "scope": "resolved-instruction-bodies",
  "encoding": "utf8",
  "characterUnit": "unicode-code-points",
  "excluded": [
    "host-context", "repository-instructions", "bootstrap-instructions",
    "host-native-skills", "inventory-rendering", "output-formatting"
  ]
}
```

`diagnostics.repository` identifies `AGENTS.md` as host-supplied, with
host-controlled injection and null byte/character measurements. Other repository
instructions are unobserved. The existing top-level `repository` descriptor is
unchanged. The resolver does not reread repository instructions to compute these
totals, infer whether a host injected them, or claim which other files it used.

`diagnostics.host` marks system instructions, tools, built-in skills, and other
runtime context as `unobserved`, without invented sizes or host-specific
assumptions. Tokens are `not-calculated`; there is no tokenizer dependency or
approximate byte-to-token conversion presented as a measurement.

`diagnostics.hostSkills` lists each required or available host-native skill with its
host, host skill ID, and verification state (`verified-local` or `host-provided`).
Their bytes are `null`: the host delivers them, Agent Profiles never injects them,
and they are excluded from `availableNotLoaded`. `proof`, the JSON output, and the
visualizer apply the same rule.

`diagnostics.bootstrap` measures the managed block for the host given with `--host`. When that
host's block is installed, it measures the bytes on disk (`scope: installed-managed-block`,
with its `file`), so a CRLF instruction file reports its CRLF block. Otherwise it measures
the block `init` would write with LF (`expected-managed-block`). Without a host it is not
measured. It is never added to managed totals, and a native integration needs no block.
The `resolve` output wrapper and tool-call overhead are not measured.

Managed totals exclude bootstrap/protocol text, host rendering of skill metadata,
CLI/JSON formatting, separators, and other wrappers. Those bytes are not in
`loaded[].content`. This measures the instruction payload, not complete Agent
Profiles-related overhead or total context-window usage.

Use **available context not injected**, not **savings**, unless comparing with an
explicit baseline that would have loaded those instructions. The proof shows
what was selected and what could additionally be loaded without assuming what
another setup would do.

## Programmatic access

```js
import { resolveInstructions } from './src/resolve.js';

const result = resolveInstructions({ root: '/path/to/project', role: 'reviewer' });
console.log(result.diagnostics.managed.total);
console.log(result.diagnostics.availableNotLoaded);
```

All accounting is computed in the normal resolution path. `proof` only formats
that result. `agent-profiles resolve --json --role reviewer` exposes the same
diagnostic fields, with or without `--contents`.
Consumers can resolve several model/role combinations independently for future
comparisons or preset analysis without parsing terminal text.
