# Initial feasibility findings

Reported 2026-11-07. Superpowers 7.0.2 at revision named in README, AP 0.19.4,
Windows, T3 and Claude. This is a case study, not a comparative benchmark.

Structural checks passed for three roles across Claude/Codex host selectors:
complete required bodies, no other required bodies, final completion marker.
These SDK calls alone do not establish live Codex compatibility. Git Bash
workspace, task-brief and review-package helpers also passed.

The live exercise fixed empty-array reduction with a zero seed. Sonnet 5.5
implemented and performed task review in separate sessions; Opus 5.5 performed
whole-branch review. Each child's saved report recorded independent MCP resolution,
its assigned role and complete required instructions. The final reviewer loaded
the linked whole-branch contract separately. Reported tests progressed from the
expected empty-input failure to 4/4 passing. Only two source/test files changed.

No competing native Superpowers injection was observed in the coordinator setup.
After compaction it resolved again and avoided redispatch, but used reattached
ledger content and unnecessarily repeated tests. A fresh-session test read the
persisted ledger, resolved its role and made no edits, tests or dispatches.

## Limits and lessons

- Child delivery evidence is saved agent reports; complete provider traces were
  not archived. One old child could no longer be reopened. Preserve transcripts
  and experiment/task/thread/run/provider-session mappings in future tests.
- Signed-zero normalization was accepted by reviewers; strict preservation of
  every nonempty numeric result was not achieved. It is observable with Object.is
  and division. Successful delivery is not proof of perfect instruction adherence.
- Reviewer cosmetic findings need independent quality scoring. No fix loop ran.
- Stale plan status confused recovery. Keep approval, completed state and historical
  setup snapshots distinct. A generated plan is not evidence of user authorization.
- No upstream configured does not prove no push. Matching timestamps do not
  establish which tool authored a file. Keep observations separate from inference.

Still untested: repeated trials, child recovery, live Sol 6.1, cost/accuracy
comparison, unrelated-project isolation and published-library resource execution.
The next pilot will use identical tasks/models per comparison arm, independent
acceptance tests and dated API-equivalent cost estimates where token metadata
exists. Subscription charges and estimated API costs are different quantities.
