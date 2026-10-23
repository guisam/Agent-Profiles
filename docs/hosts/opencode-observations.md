# OpenCode native loading observations

Observed on Windows with Node `v24.20.0` and installed OpenCode `v2.1.3`
(`C:\Users\gfw\.bun\bin\opencode.exe`). Official release source:
[`bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1`](https://github.com/anomalyco/opencode/releases/tag/v2.1.3).
This supersedes the earlier observation that no executable was on PATH; the
[v1.19.4 source investigation](../development/issue-30-opencode-contract.md)
describes a different version and must not be treated as the installed contract.

## Reproduce

```powershell
# Native skill inventory only; no model request.
node scripts/opencode-smoke.ts

# Explicit live request using the current OpenCode default model and agent.
node scripts/opencode-smoke.ts --live
```

The script requires exactly v2.1.3, creates and removes a temporary project, and
leaves global/repository configuration unchanged. It uses the normal diagnostic
connection for inventory and `opencode run --standalone --format json` for a
fresh live session without resume/continue/fork flags. Normal OpenCode logs,
service state and test sessions remain in OpenCode's own storage. A live run can
incur the default provider's ordinary usage charges. Default CI does not run it.

## Observed results

- Native inventory discovered `.opencode/skills/issue30-smoke/SKILL.md`.
- The live default model returned random verification codes from project
  `AGENTS.md` and an additional local file selected through `opencode.json`'s
  `instructions` list. The prompt did not contain those codes.
- A native `skill` tool event was observed and the model returned the separate
  random code from the skill body.
- The extended check installed the actual OpenCode bootstrap and a local shim
  to the real Agent Profiles CLI. In fresh session
  `ses_e970721ddffeA5GPZs42u1hC9x`, the model executed the bootstrap resolver with
  `--host opencode --identity-source host-stated --model "opencode/big-pickle"
  --role reviewer` and returned the additional selected profile and assigned-role
  codes. The script accepts native shell tools and codemode execution wrappers
  only when their inputs name that resolver/host/role, and requires a real shell
  invocation plus all five codes. Direct file tools are rejected.
- A later run, `ses_e96ff7298ffevLCujhS8W6COpW`, passed with a deliberately
  different default role and an assertion matching resolver identity to the
  retained native request's provider/model. An earlier run omitted the explicit
  role flag and was correctly rejected; the bootstrap now explicitly requires
  assigned roles on every invocation.
- Retained assistant messages identified provider/model **`opencode/big-pickle`**
  and agent **`build`**. Session metadata alone did not expose model/agent fields;
  `/api/session/{sessionID}/context` did. This is host-retained attribution,
  rather than proof of an underlying provider's model weights/version.
- An immediately queried `/api/skill` on a new private server returned an empty
  list before location plugins had activated. The reproducible check polls the
  normal persistent diagnostic connection for the fixture skill. Upstream
  [skill handler](https://github.com/anomalyco/opencode/blob/bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1/packages/server/src/handlers/skill.ts)
  lists registered skills without awaiting plugin activation.

The v2 source uses different loading code from the v1 investigation:
[instruction loading](https://github.com/anomalyco/opencode/blob/bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1/packages/core/src/config/plugin/instruction.ts),
[skill sources](https://github.com/anomalyco/opencode/blob/bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1/packages/core/src/config/plugin/skill.ts),
[skill identity parsing](https://github.com/anomalyco/opencode/blob/bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1/packages/core/src/config/plugin/skill-file.ts).
In particular, v2 keys native skills by directory-derived ID, keeps the display
name separately, and loads sources sequentially; do not carry over v1's
frontmatter-name/concurrent-duplicate conclusions without new qualification.

## Live paired workflow

The remaining live workflow check passed on 2026-10-23. It used the same
`opencode/big-pickle` model and the public pinned Harness² substrate/launcher
contract with a tiny synthetic routing task. The model saw generated policies and
random tokens only. No repository code, instructions, private task data or grader
answers were supplied. This is a live integration check, not a deployment of the
WorkBuddy/LAB/JobBench datasets or their separately pinned executors.

```powershell
$env:PYTHONPATH = 'C:\workspace\harness2'
python integrations/harness2/live_smoke.py --live --model opencode/big-pickle --output "$env:TEMP\ap-live-new-run"
```

Choose a new, absent output directory. Add `--prepare-only` to inspect exact
synthetic payloads and the retained plan without making model requests. Live mode
requests four actual rollouts and retains raw events, native session identities,
answers, exact-answer judgments, stamps, plans/results and promotion records.
The script's tiny adapter supplies the launcher through Harness²'s public API;
it does not patch upstream or replace existing benchmark launchers.

- Two cases, one trial per arm: base **1/2**, candidate **2/2**. The candidate fixed
  the intentionally obsolete alpha route and preserved the beta regression case.
- Every rollout invoked the native routing skill. Retained native assistant
  metadata matched `opencode/big-pickle`; the real assignment remained host
  `opencode`, role `worker`.
- Replaying the four run IDs reused native cache artifacts with **zero additional
  model launches**. Reusing either arm's run ID with changed harness bytes refused
  before launching or overwriting evidence.
- `evaluation_results` accepted exact paired coverage. The real migration CLI
  retained results, reported eligibility, performed a read-only preview, then
  explicitly promoted the evaluated candidate. The resulting OpenCode stamp
  verified as managed-reproducible.

The [measured summary and native session references](opencode-live-result.json)
record the immutable plan/result/promoted-stamp digests. Raw evidence is retained
locally at `C:\Users\gfw\AppData\Local\Temp\agent-profiles-live-paired-a88c40ce729d4dc2992bab5c6c54550b`.
Exact answers were graded by executable equality checks through Harness²'s judge
API; they are not fabricated fixture judgments. Imported measurements retain the
existing `external-claim` trust label because the evaluator runs outside Agent
Profiles. The four-call check establishes integration behavior, not statistical
model quality.

## Verification boundaries

The extended check verifies actual bootstrap execution and selected profile/role
consumption with isolated synthetic content. Credential-free host tests cover
installation, Codex coexistence, identity, fallback, native metadata and stamps.
Python converter tests cover both hosts' fork/proposal/candidate/paired-evaluation
and explicit preview/promotion paths; native launcher fixtures cover fixed-arm
batch consumption and immutable input identities. The separate live paired check
above exercises measured native answers through real results and promotion.

Clean sessions are requested without resume/continue/fork flags. Switching an
existing session is not certified as clean; the bootstrap and resolver require
new-session semantics explicitly. Arbitrary subagent behavior, global/ancestor
precedence, all compatibility layouts and provider implementation identity are
outside the bounded qualification. Do not relabel old null-host
captures or claim role-based native skill/permission isolation.

## Repository checks

Typechecking, lint, the full Node suite (2,080 passed, one skipped), the final
focused OpenCode/external metadata checks (19 passed), and the Python integration
matrix (40 passed, one skipped) passed. The packed artifact passed all setup and
migration/promotion smoke scenarios, including OpenCode in all-host installation.

Trail may report lexical conflicts with historical learnings: the v1 source
investigation is explicitly historical; this change does not replace native
Harness² batching or relax pre-launch reservations or exact paired coverage.
The ownership and evidence learning records this rationale for review. Treat a
nonzero Trail check as a reported wording conflict, not a clean automated result.
