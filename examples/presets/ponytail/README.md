# Ponytail by role

Use Ponytail's instructions through Agent Profiles without installing its plugin.
This self-contained preset includes four adapted skills, their MIT license and
per-skill source provenance. It needs no private library, signatures, machine
paths or model subscription to inspect and resolve.

## Why split it?

Keep reusable instructions separate from project authority. Load implementation
policy for implementation, review policy for review, and keep each project's own
rules and approval gates. A reviewer verdict never grants merge authority.

`preset.yaml` is the import manifest. `agents.yaml` is the equivalent standalone
configuration for a fresh `.agent-profiles` directory. Import the preset into an
existing project rather than replacing its `agents.yaml`.

## Configuration breakdown

| Role | Required skill | Available on request |
| --- | --- | --- |
| `ponytail-implementer` | `ponytail-implementation` | `ponytail-debt` |
| `ponytail-reviewer` | `ponytail-review` | `ponytail-debt` |
| `ponytail-auditor` | `ponytail-audit` | `ponytail-debt` |
| `ponytail-maintainer` | `ponytail-debt` | none |

The single model profile, `ponytail-base`, preserves project authority and
evidence limits. Roles define the job; skills supply its detailed instructions.
The model and family maps are deliberately empty: every model uses the same
baseline until evaluations justify a different selection. The optional import
defaults select this profile and implementer role; accepting them is a separate
choice. Role IDs are prefixed to avoid replacing existing project roles.

## Try it

With Node 24 and Agent Profiles installed in an initialized target project:

```powershell
npx --no agent-profiles preset inspect /path/to/ponytail --contents
npx --no agent-profiles preset import /path/to/ponytail
npx --no agent-profiles doctor
npx --no agent-profiles resolve --host claude --role ponytail-reviewer
```

Replace `/path/to/ponytail` with this directory. Import is interactive: inspect
the proposed changes, choose conflict handling, and confirm before writing.
To inspect from this source checkout, use `node bin/agent-profiles.ts` instead of
`npx --no agent-profiles` and add `--root /path/to/target`.

Configure the host with `init --agent claude --mcp` or
`init --agent codex --mcp`, then register the MCP server using the instructions
printed by init. Keep the project bootstrap for shell fallback. Start a fresh
session and explicitly assign `ponytail-reviewer` for a review. Disable native
Ponytail in that test project to avoid loading both instruction sources.

Preset import copies Markdown; it does not install plugin hooks or synchronize
future source updates. Preserve the included MIT notices when redistributing
the skills. The source licenses and provenance remain in this preset; the preset
importer copies instruction Markdown, not the adjacent provenance/license files.

## Model-specific versions and a shared library

For coordinated updates across projects, publish reviewed instruction packages
to your AP library and replace local skill bindings with package bindings using
configuration version 2. See [versioned packages](../../../docs/versioned-packages.md)
and [trust policy](../../../docs/trust.md). Sign the packages if your policy
requires it; this example supplies no approvals for your machine.

The following is an illustrative fragment for that **later package-backed
configuration**, not an addition to this schema-1 preset:

```yaml
version: 2
skills:
  ponytail-review:
    package: "@your-team/ponytail-review"
    version: 1.0.0
assignments:
  evaluated-review-variant:
    when:
      role: ponytail-reviewer
      model: exact-model-id-from-your-host
      host: claude
    versions:
      skills.ponytail-review: 1.1.0
```

Both versions must actually exist in your library, satisfy trust policy and have
a valid dependency lock. Use AP's update preview/apply workflow to adopt pins.
Haiku, Sonnet and Opus can each select different versions by exact model ID;
so can generations within one model line, such as Opus 5 versus Opus 5.5.
Use the actual IDs supplied by the host rather than display names. A maintainer
of any skill library can publish such variants; AP selects them without requiring
a plugin release or a global update to every consuming project.
This preset does not assert that any variant performs better. Evaluate candidates
on representative tasks, then pin the best-performing version per assignment.

## What the experiment established

Two disposable projects consumed the same library while retaining their own
role text. A adopted a reviewer update while B stayed pinned; B later adopted
the identical version and digest. A separate shared-language skill participated
in that experiment but is not redistributed here: this preset contains only the
four MIT-licensed Ponytail adaptations.

Live Claude testing exposed startup truncation, leading to [#80](https://github.com/guisam/Agent-Profiles/issues/80).
The bootstrap now directs the agent to resolve after new/cleared or compacted
contexts, using MCP or shell fallback, and check the final
`End of Agent Profiles context:` line. The text is retrieved again rather than
trusted to survive in a summary. Observed recovery is not a universal guarantee;
see [#82](https://github.com/guisam/Agent-Profiles/issues/82) for subagents and
[#83](https://github.com/guisam/Agent-Profiles/issues/83) for remaining failure tests.
Successful delivery does not prove instruction adherence or model quality.

## Source and boundaries

Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail),
5.3.3, commit `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`.
Each skill's `PROVENANCE.json` records source hashes and adaptations. Implementation
uses the full policy within its assigned role; plugin mode persistence, lifecycle
hooks, help and benchmark commands are not included. Future upstream changes
require review; this is not an automatically maintained mirror.
