# Case study: different skill versions for the same reviewer role

On November 10, 2026, a disposable Agent Profiles experiment delivered different
pinned versions of one skill to Sonnet and Opus reviewers delegated through T3
Code. Each child resolved its own model and assigned role before review work.

This matters when a team wants to evaluate or maintain different instructions
for the same job across models. A reviewer can keep the same role while its
exact model selects a different package version. These fixture variants were
identification probes, not optimized instructions: the experiment establishes
selection and delivery, not better reviews or lower token costs.

## Setup and evidence

The fixture used source 0.23.1 at `5d83a2a` and the
[#82 preparation and tracing protocol](../../test/fixtures/issue-82/README.md).
It used configuration v2, an isolated package store, and a host-only Claude MCP
server binding. The parent resolved explicitly as `coordinator`; child briefs
assigned `reviewer`. T3's `role` metadata was not used as an AP assignment.

One binding, `skills.reviewer-variant`, selected versions of
`@fixture105/reviewer-variant`:

- Baseline: 1.0.0 for no exact model assignment.
- `claude-sonnet-5-5` and `reviewer`: 2.0.0 through `sonnet-reviewer`.
- `claude-opus-5-5` and `reviewer`: 3.0.0 through `opus-reviewer`.

Each version had a distinct final marker. Deterministic CLI checks also covered
unknown and omitted model IDs, which selected the baseline. They did not stand
in for the live child runs.

The same brief was passed to both children:

> Your assigned Agent Profiles role is reviewer. Review removing the `0` initial
> value from `items.reduce((sum, item) => sum + item.price, 0)`.

The coordinator retained private host transcripts and published a
[sanitized trial report](https://github.com/guisam/Agent-Profiles/issues/105#issuecomment-6781389034).
The observations below are drawn from that trace report. Raw transcripts,
personal configuration and machine-specific paths are not published here.

## T3 result: one attempt per child

| Child's executed model | Effort | AP role | Selected version | Digest prefix | Delivery |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5-5` | high | reviewer | 2.0.0 | `c0d86adf` | MCP resolve before work; own variant only |
| `claude-opus-5-5` | medium | reviewer | 3.0.0 | `3a1f9050` | MCP resolve before work; own variant only |

The table uses abbreviated digests for identification, not integrity checking.
Both rows ran through T3 `delegate_task`, sequentially, in the shared disposable
fixture. There were no retries. Each started with `ToolSearch`, then `resolve`
with its own host-stated model and assigned `reviewer` role. Each result contained
all three skill-final markers and the five-section completion line. Neither AP
result delivered the coordinator role. Both children checked the snippet with
Node and recommended keeping the initial value.

An [earlier native CLI trial](https://github.com/guisam/Agent-Profiles/issues/105#issuecomment-6781000647)
also delivered the respective variants, but its parent had resolved as the
default reviewer rather than coordinator. It is separate evidence, not a T3
run or a strong parent-role-separation test. An earlier cross-project T3 launch
was rejected before any child ran; starting the parent in the fixture project
removed that launch blocker.

## Isolation and bootstrap limits

The fixture's MCP configuration explicitly set its store, trust and session
paths. T3 shell tools did not inherit those variables. The stock shell fallback
therefore read personal configuration and failed to find the fixture package.

For this fixture only, a PowerShell wrapper set those paths and ran `resolve`
through `npx.cmd`; the fixture's `CLAUDE.md` fallback pointed to it. Fresh-shell
checks selected both intended versions. The bare stock command remained a
negative control that failed. This is a fixture-specific adaptation, not stock
bootstrap behavior. `doctor` correctly reported the managed block as modified.
Neither live child used the wrapper: both used MCP.

The coordinator reported that the first wrapper draft, using `npx` and `@args`,
lost model selectors and selected the baseline while still returning a complete
end marker. Changing to `npx.cmd` resolved the observed problem. A later [PowerShell investigation](../powershell-selector-forwarding.md)
reproduced argument loss before npm JavaScript and AP on the installed shim.
It records the environment and tested forwarding alternatives (#106). A completion marker checks output completeness. Verify the
model, role, selection rule, version and digest separately.

## What this does not establish

- **Clean context isolation:** after resolving, Sonnet searched Graft session
  caches and received cached coordinator prompt text. AP did not select the
  coordinator role, but a separate plugin exposed that text. Opus had no observed
  cache hit. Neither role separation nor package routing prevents filesystem
  searches from exposing other session artifacts.
- **Universal store isolation:** the personal store was unchanged across the two
  children, but a stock session-start notice hook wrote a personal notice file
  before they ran. The experiment is not evidence that all host hooks were isolated.
- **Quality or efficiency:** one attempt per row, different effort settings, and
  no scored comparison cannot establish skill adherence, quality gains or token
  savings. Both reviews reaching the expected conclusion is not a benchmark.
- **Other delivery paths:** child shell fallback, default-role children,
  other models/providers and repeated trials remain outside this T3 result.
  The built-in Explore bootstrap limitation from #82 remains unchanged.

## Applying the finding

Keep the shared MCP server free of model and role bindings when children need
independent selections. Assign each child's AP role explicitly and use its actual
host-stated model ID. Verify selection identity as well as complete delivery.
Keep session caches out of searchable project content when testing isolation.
Evaluate a candidate's behavior before treating its model-specific pin as an
optimal skill version.

See [versioned packages](../versioned-packages.md),
[model-and-role tuning](../model-role-skill-tuning.md) and
[#105](https://github.com/guisam/Agent-Profiles/issues/105) for remaining coverage.
