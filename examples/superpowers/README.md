# Help test Superpowers through Agent Profiles

Experimental, repository-local role example. Volunteers are welcome: one small
reproducible observation is useful; you do not need to run the whole experiment.
Existing subscriptions are sufficient. No API account or paid purchase is required.

## Why try this?

Select Superpowers instructions explicitly per project and role, preserve a
reviewed upstream revision, and inspect what each agent receives. AP can also
select versioned library packages by exact model, role and host; this local-file
example does not yet demonstrate those pins or model-specific optimization.

| Role | Required: full body on resolve | Available: load when needed |
| --- | --- | --- |
| sp-coordinator | Subagent-driven development | Worktrees, requesting review, branch completion, parallel agents |
| sp-implementer | Implementation contract, TDD, verification | Debugging, receiving review |
| sp-reviewer | Task-review contract | Linked re-review or whole-branch contract selected by scope |

See [agents.yaml](agents.yaml) and [the adapter](profiles/base.md). The example
covers execution of an approved plan. Brainstorming and planning remain earlier
stages. AP does not dispatch agents, select the host's actual model, enforce
permissions or turn an agent-generated plan into user approval.

Required skill bodies reload on resolve after clear/compaction; supporting files
remain on disk. The coordinator must separately recover progress from its ledger.
Every child must resolve its own explicitly assigned role; inheritance is not assumed.

## Prepare a disposable consumer

Use Node 24, Git, and Git Bash for upstream shell helpers on Windows. Clone this
repository and [Superpowers](https://github.com/obra/superpowers) separately.
Review the pinned source before running its helpers. The commands below use
PowerShell and a **new destination**, outside other projects' instruction trees.

```powershell
$ap = (Resolve-Path ./Agent-Profiles).Path
$sp = (Resolve-Path ./superpowers).Path
# Use a dedicated upstream checkout; this changes its checked-out revision.
git -C $sp checkout 22f0b463e7a5e579904dd6211a520321035526f7
if ($LASTEXITCODE -ne 0) { throw 'Upstream checkout failed' }
if (git -C $sp status --porcelain -- skills LICENSE) { throw 'Upstream resources are modified' }
$project = Join-Path (Get-Location) 'superpowers-ap-trial'
if (Test-Path $project) { throw 'Choose a new destination' }
New-Item -ItemType Directory -Path "$project/.agent-profiles" -Force | Out-Null
$example = Join-Path $ap 'examples/superpowers'
Copy-Item "$sp/skills" "$project/.agent-profiles/skills" -Recurse
Copy-Item "$example/contracts/*" "$project/.agent-profiles/skills/" -Recurse
Copy-Item "$example/profiles","$example/roles" "$project/.agent-profiles/" -Recurse
Copy-Item "$example/agents.yaml" "$project/.agent-profiles/agents.yaml"
Copy-Item "$example/LICENSE" "$project/.agent-profiles/SUPERPOWERS-LICENSE"
Set-Location $project
npm init -y
npm install --save-dev --save-exact @guisam/agent-profiles@0.19.4
npx --no agent-profiles init --agent claude --agent codex --mcp
npx --no agent-profiles doctor
```

The runtime pin is the version used in the initial trial, not a claim that it is
the latest release. Example documentation requires this repository checkout;
it is not a Markdown preset or a published library package. Copy complete skill
directories: scripts, templates and relative links are necessary, not optional
decorations. Upstream binaries/scripts are not executed merely by resolving AP.

Follow the printed host setup and [MCP registration guide](../../docs/mcp.md).
Register the consumer root, with no bound role if several roles use the server.
Disable native Superpowers/Ponytail activation in this disposable consumer using
your host's supported controls; plugin identifiers vary. Inspect inherited
parent/global instructions and verify no competing hooks or skills were injected.
Do not assume AP disables an existing plugin. Leave other projects unchanged.

Before implementation, create a small source fixture and an explicit plan with
acceptance tests, an experiment branch, approval gates and retained ledger. Give
the agent its role and require successful resolution before role work. Stop on
missing resources, resolver failure or a missing completion marker. Host permissions
remain authoritative. No installation command above authorizes model delegation,
merge, push, publication or extra usage purchases.

## Pick one volunteer test

1. **Setup:** resolve sp-coordinator and report required/available skills and the
   final completion line. Report competing native injection; do not infer absence
   merely from a configuration setting.
2. **Child delivery:** assign sp-implementer or sp-reviewer in a separate agent.
   Confirm it resolves its own role before work and can read needed support files.
3. **Recovery:** after clear/compaction, give a neutral resume request. Check that
   it resolves again and reads persisted task state without repeating completed work.
4. **Isolation:** run a neutral task in an unrelated project. Check instruction
   discovery, injected bodies and actual invocation separately. Compare native
   default and scoped configurations fairly; a native pass is a valid result.
5. **Scripts/platforms:** verify workspace, brief and review-package helpers on
   your OS. Record interpreter and failures; do not silently replace helpers.

Start with setup only. Approve any child model runs separately. Codex, Windows,
macOS and Linux observations are particularly useful. Use [the report template](TEST-REPORT.md)
to [open an issue](https://github.com/guisam/Agent-Profiles/issues/new).
Do not include credentials, private transcripts, personal paths or signing keys.

## What we know

See [initial findings](FINDINGS.md). One Claude trial demonstrated feasibility,
including independent child resolution and coordinator recovery. We have not
established equal accuracy, lower cost, universal isolation or live Sol 6.1 support.
Failures are welcome; report observable calls and artifacts, not private reasoning.

## Provenance

Source: obra/superpowers 7.0.2, commit
`22f0b463e7a5e579904dd6211a520321035526f7`, MIT, Copyright 2025 Jesse Vincent.
The two files under contracts/ extract the `prompt: |` bodies from upstream
subagent-driven-development/implementer-prompt.md and task-reviewer-prompt.md,
with indentation removed and skill frontmatter added. Keep [LICENSE](LICENSE)
with these adaptations. The adapter and role mapping are this experiment's work;
this is not an upstream endorsement or a replacement for its full workflow.
