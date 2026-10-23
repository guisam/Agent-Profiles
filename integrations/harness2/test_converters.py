from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from agent_profiles_harness2 import ProfilesBridge, evaluation_plan, evaluation_results, proposal_batch, start_migration
from agent_profiles_harness2.bridge import encoded
from test_bridge import CLI, REPO, SKILL, harness
from test_native_adapters import workbuddy_runner


class ConverterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="ap-harness2-convert-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.profiles = ProfilesBridge(cls.root / "capture", cli=CLI, store=cls.root / "store", model="fixture-model", role="worker")
        cls.captured = cls.profiles.capture(harness(), surface="codex", run_id="seed", task_id="fix", label="agg1")
        prepared = start_migration(cls.profiles, cls.captured, binding="skills.review")
        cls.base, cls.migration = prepared["base"], prepared["migration"]
        cls.project = Path(cls.base["project"])
        cls.after = harness()
        cls.after[".agents/skills/review/SKILL.md"] = SKILL + b"Reject stale evidence.\n"
        cls.batch = proposal_batch(cls.base, cls.after, cls.migration, run_id="improve-1", excerpt="Check stale evidence", draft_case={"input": "stale", "expected": "reject"})
        proposal_file = cls.root / "proposal.json"
        proposal_file.write_bytes(encoded(cls.batch["proposals"][0]))
        cls.proposal = cls.profiles.command("migrate", "propose", cls.migration["id"], str(proposal_file), project=cls.project)
        cls.profiles.command("migrate", "accept", cls.migration["id"], cls.proposal["id"], project=cls.project)
        skill = cls.base["packages"]["skill-review"]
        tree = cls.project / cls.migration["workspace"] / "packages" / skill["sha256"]
        script = f'import {{readPackage}} from {json.dumps((REPO / "src/packages.ts").as_uri())}; console.log(readPackage({{root:process.argv[1]}}).sha256)'
        tree_sha = subprocess.run([CLI[0], "--input-type=module", "-e", script, str(tree)], capture_output=True, text=True, check=True).stdout.strip()
        config_sha = json.loads((cls.project / ".agent-profiles/agent-profiles.lock").read_bytes())["configSha256"]
        candidate_file = cls.root / "candidate.json"
        candidate_file.write_bytes(encoded({
            "candidateVersion": 1, "id": "harness2-candidate", "binding": "skills.review",
            "release": {"name": skill["name"], "version": "1.0.0"},
            "migrationBase": cls.base["stampDigest"], "evaluationBase": cls.base["stampDigest"],
            "configSha256": config_sha, "expectedTreeSha256": tree_sha, "proposalIds": [cls.proposal["id"]],
            "workflowChange": {"kind": "task-only", "reason": "Keep workflow unchanged"},
        }))
        cls.candidate = cls.profiles.command("migrate", "candidate", cls.migration["id"], str(candidate_file), project=cls.project)
        snapshots = {}
        for side, stamp in (("base", cls.base["stampDigest"]), ("candidate", cls.candidate["stampDigest"])):
            snapshots[side] = json.loads((cls.profiles.store / "stamps/sha256" / stamp / "snapshot.json").read_bytes())
        cls.plan = evaluation_plan(id="harness2-plan", candidate=cls.candidate, base_stamp=cls.base["stampDigest"],
            assignment=cls.base["selection"], binding="skills.review", member=skill["name"],
            workflow_peers={side: snapshot["workflowPeers"] for side, snapshot in snapshots.items()},
            tasks=[{"id": "fix", "taskId": "demo/fix", "kind": "motivating", "input": "stale", "expected": "reject"},
                {"id": "retain", "taskId": "demo/retain", "kind": "regression", "input": "fresh", "expected": "keep"}],
            k=2, mode="agg", seed=7, judge={"id": "fixture", "version": "1", "settings": {}},
            rubric={"id": "all-pass", "version": "1", "settings": {}})
        plan_file = cls.root / "plan.json"
        plan_file.write_bytes(encoded(cls.plan))
        cls.retained = cls.profiles.command("migrate", "plan", cls.candidate["id"], str(plan_file), project=cls.project)

    def arms(self):
        arms = []
        for side in ("base", "candidate"):
            arm = {"runsRoot": str(self.root / side), "stampDigest": self.plan[side + "Stamp"],
                "conditions": deepcopy(self.plan["conditions"]), "judged": [], "rollouts": [], "costs": []}
            for task in ("demo/fix", "demo/retain"):
                for trial in (1, 2):
                    run = f"{side}/{task}/base{trial}"
                    arm["judged"].append({"task": task, "label": f"base{trial}", "run_id": run,
                        "score": {"all_pass": side == "candidate", "n_passed": int(side == "candidate"), "n_criteria": 1}})
                    arm["rollouts"].append({"runId": run, "taskId": task, "stampDigest": arm["stampDigest"],
                        "inputObservation": "before-execution", "fingerprint": "b" * 16 if side == "base" else "c" * 16, "treeDigest": hashlib.sha256(side.encode()).hexdigest()})
                    arm["costs"].append({"runId": run, "taskId": task, "kind": "rollout", "label": f"base{trial}", "usd": 0.01})
            arms.append(arm)
        return arms

    def convert(self, arms=None):
        base, candidate = arms or self.arms()
        return evaluation_results(id="harness2-results", plan=self.plan, plan_digest=self.retained["planDigest"], base=base, candidate=candidate)

    def test_generated_artifacts_pass_real_cli_without_edits(self):
        self.assertEqual(self.batch["unsupported"], [])
        self.assertEqual(self.batch["proposals"][0]["classification"], "package")
        result = self.convert()
        self.assertEqual(len(result["outcomes"]), 8)
        result_file = self.root / "results.json"
        result_file.write_bytes(encoded(result))
        imported = self.profiles.command("migrate", "results", self.plan["id"], str(result_file), project=self.project)
        self.assertEqual(imported["status"], "published")
        report = self.profiles.command("migrate", "report", result["id"], project=self.project)
        self.assertEqual(report["resultDigest"], imported["resultDigest"])
        self.assertEqual(report["evidence"]["correctness"], "external-claim")
        self.assertEqual(report["evidence"]["promotion"], "not-authorized")
        self.assertEqual(report["eligibility"]["status"], "eligible")
        self.assertIsNone(result["outcomes"][0]["metrics"]["tokens"])
        self.assertEqual(result["outcomes"][0]["metrics"]["costUsd"], 0.01)

    def test_native_fixed_arms_consume_distinct_seeds_and_pass_cli_results(self):
        tasks = [{**{key: case[key] for key in ("id", "kind", "input", "expected")}, "taskId": case["id"]} for case in self.plan["cases"]]
        plan = self.make_plan(id="native-plan", tasks=tasks)
        source = self.root / "native-plan.json"
        source.write_bytes(encoded(plan))
        retained = self.profiles.command("migrate", "plan", self.candidate["id"], str(source), project=self.project)
        arms, prompts = [], []
        for side in ("base", "candidate"):
            stamp = plan[side + "Stamp"]
            seed = self.profiles.seed(stamp, surface="codex", project=self.project)
            arm = {"runsRoot": str(self.root / side), "stampDigest": stamp, "conditions": plan["conditions"], "judged": []}
            with workbuddy_runner(self.root / side, self.profiles, stamp, seed) as (adapter, observed):
                for task in tasks:
                    ids = [f"{adapter.spec.name}-cx-{side}/{task['taskId']}/base{i}" for i in (1, 2)]
                    self.assertEqual(len(adapter.execute_many(task["taskId"], None, ids)), 2)
                    for i, run_id in enumerate(ids, 1):
                        arm["judged"].append({"task": task["taskId"], "label": f"base{i}", "run_id": run_id, "score": {"all_pass": True}})
                prompts.append(observed)
            ids = {row["run_id"] for row in arm["judged"]}
            records = [json.loads(file.read_bytes()) for file in (self.profiles.root / "rollouts").glob("*.json")]
            arm["rollouts"] = [record for record in records if record["runId"] in ids]
            arms.append(arm)
        self.assertTrue(all("Reject stale evidence." not in prompt for prompt in prompts[0]))
        self.assertTrue(all("Reject stale evidence." in prompt for prompt in prompts[1]))
        result = evaluation_results(id="native-results", plan=plan, plan_digest=retained["planDigest"], base=arms[0], candidate=arms[1])
        source = self.root / "native-results.json"
        source.write_bytes(encoded(result))
        imported = self.profiles.command("migrate", "results", plan["id"], str(source), project=self.project)
        report = self.profiles.command("migrate", "report", result["id"], project=self.project)
        self.assertEqual(report["resultDigest"], imported["resultDigest"])
        self.assertEqual(report["evidence"]["correctness"], "external-claim")

    def fresh_workspace(self):
        # An isolated copy of the original migration bytes avoids accepting test proposals.
        project = self.root / self.id().split(".")[-1]
        migration = deepcopy(self.migration)
        base = deepcopy(self.base)
        base["project"] = str(project)
        for name, source in base["components"].items():
            target = project / migration["workspace"] / "packages" / source["packageDigest"] / source["packagePath"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(harness()[name])
        return base, migration

    def test_profile_text_and_every_unsupported_edit_are_reported(self):
        base, migration = self.fresh_workspace()
        after = harness()
        after["AGENTS.md"] += b"Check sources.\n"
        after["scripts/summarize.py"] += b"# changed\n"
        after["new.md"] = b"new"
        del after["sub_agents/checker/AGENT.md"]
        after[".agents/skills/review/SKILL.md"] = b"\xff"
        batch = proposal_batch(base, after, migration, run_id="run", excerpt="decision")
        self.assertEqual(batch["proposals"][0]["classification"], "model-specific")
        self.assertTrue(batch["proposals"][0]["target"]["path"].endswith("/PROMPT.md"))
        self.assertEqual(len(batch["unsupported"]), 4)

    def test_stale_workspace_wrong_base_and_opencode_refused(self):
        base, migration = self.fresh_workspace()
        target = self.batch["proposals"][0]["target"]["path"]
        (Path(base["project"]) / migration["workspace"] / target).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "stale"):
            proposal_batch(base, self.after, migration, run_id="run", excerpt="decision")
        for change in ("stamp", "surface"):
            bad = deepcopy(base)
            if change == "stamp":
                bad["stampDigest"] = "0" * 64
            else:
                bad["surface"] = "opencode"
            with self.assertRaises(ValueError):
                proposal_batch(bad, self.after, migration, run_id="run", excerpt="decision")

    def test_materialized_composition_is_not_mistaken_for_a_profile_edit(self):
        base, migration = self.fresh_workspace()
        before = harness()
        before["AGENTS.md"] += b"\nGenerated triggers and composed required skill.\n"
        after = deepcopy(before)
        after[".agents/skills/review/SKILL.md"] += b"Check stale evidence.\n"
        batch = proposal_batch(base, after, migration, before_tree=before, run_id="run", excerpt="decision")
        self.assertEqual(len(batch["proposals"]), 1)
        self.assertEqual(batch["unsupported"], [])
        after["AGENTS.md"] += b"Ambiguous edit.\n"
        batch = proposal_batch(base, after, migration, before_tree=before, run_id="run", excerpt="decision")
        self.assertEqual(batch["unsupported"][0]["path"], "AGENTS.md")

    def test_preparation_keeps_captured_configuration_immutable(self):
        original = json.loads((Path(self.captured["project"]) / ".agent-profiles/agents.yaml").read_bytes())
        prepared = json.loads((self.project / ".agent-profiles/agents.yaml").read_bytes())
        self.assertEqual(original["roles"]["worker"]["skills"]["required"], [])
        self.assertEqual(prepared["roles"]["worker"]["skills"]["required"], ["review"])
        self.assertNotEqual(self.captured["stampDigest"], self.base["stampDigest"])

    def test_result_rejections(self):
        mutations = {
            "missing": lambda a: a[0]["judged"].pop(),
            "duplicate": lambda a: a[0]["judged"].append(a[0]["judged"][0]),
            "ungraded": lambda a: a[0]["judged"][0].update(score=None),
            "selected": lambda a: a[0]["judged"][0].update(label="agg1"),
            "foreign": lambda a: a[0]["judged"][0].update(task="foreign"),
            "conditions": lambda a: a[1]["conditions"]["harness"]["settings"].update(seed=8),
            "stamp": lambda a: a[1].update(stampDigest="0" * 64),
            "sidecar": lambda a: a[1]["rollouts"][0].update(stampDigest=None),
            "default-base-identity": lambda a: a[1]["rollouts"][0].update(fingerprint="base"),
            "mutable": lambda a: a[1]["rollouts"][0].update(treeDigest="0" * 64),
            "same-root": lambda a: a[1].update(runsRoot=a[0]["runsRoot"]),
            "overlap-root": lambda a: a[1].update(runsRoot=str(Path(a[0]["runsRoot"]) / "nested")),
            "reused-run": lambda a: a[1]["judged"][0].update(run_id=a[0]["judged"][0]["run_id"]),
            "cost": lambda a: a[1]["costs"][0].update(usd=float("nan")),
            "summary-cost": lambda a: a[1]["costs"][0].update(kind="summary"),
            "negative-zero": lambda a: a[1]["costs"][0].update(usd=-0.0),
            "huge-cost": lambda a: a[1]["costs"][0].update(usd=10 ** 400),
            "nonboolean-grade": lambda a: a[1]["judged"][0]["score"].update(all_pass=1),
            "inconsistent": lambda a: a[1]["judged"][0]["score"].update(n_passed=0),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                arms = self.arms()
                mutate(arms)
                with self.assertRaises(ValueError):
                    self.convert(arms)

    def test_unrecorded_cost_stays_null(self):
        arms = self.arms()
        for arm in arms:
            del arm["costs"]
        self.assertTrue(all(outcome["metrics"]["costUsd"] is None for outcome in self.convert(arms)["outcomes"]))

    def make_plan(self, **changes):
        parameters = dict(id="another-plan", candidate=self.candidate, base_stamp=self.base["stampDigest"],
            assignment=self.base["selection"], binding="skills.review", member=self.base["packages"]["skill-review"]["name"],
            workflow_peers=self.plan["context"]["workflowPeers"],
            tasks=[{**{key: case[key] for key in ("id", "kind", "input", "expected")}, "taskId": "demo/" + case["id"]} for case in self.plan["cases"]],
            k=2, mode="agg", seed=7, judge=self.plan["conditions"]["judge"], rubric=self.plan["conditions"]["rubric"])
        parameters.update(changes)
        return evaluation_plan(**parameters)

    def test_plan_rejects_invalid_selection_trials_and_subset(self):
        for change in ({"assignment": {**self.base["selection"], "host": "opencode"}}, {"k": True},
                {"k": 0}, {"mode": "other"}, {"seed": -1}, {"tasks": []}, {"binding": "profiles.harness"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.make_plan(**change)
        self.assertEqual(self.make_plan()["conditions"], self.plan["conditions"])

    def test_explicit_workflow_target_is_preserved_for_native_validation(self):
        tasks = [{**{key: case[key] for key in ("id", "kind", "input", "expected")}, "taskId": "demo/" + case["id"]} for case in self.plan["cases"]]
        target = {**self.plan["cases"][0]["target"], "protocol": {"protocol": "review-checkin", "major": 1}}
        tasks.append({"id": "handoff", "taskId": "demo/handoff", "kind": "workflow", "input": "handoff", "expected": "check in", "target": target})
        plan = self.make_plan(tasks=tasks)
        self.assertEqual(plan["cases"][-1]["target"], target)
        source = self.root / "undeclared-workflow.json"
        source.write_bytes(encoded(plan))
        with self.assertRaises(RuntimeError):
            self.profiles.command("migrate", "plan", self.candidate["id"], str(source), project=self.project)


if __name__ == "__main__":
    unittest.main()
