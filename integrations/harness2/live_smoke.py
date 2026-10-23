"""Opt-in live paired validation with a tiny exact-answer policy task.

Uses the public Harness2 substrate/launcher contract, real OpenCode, real stamps,
and native migration commands. This is not a WorkBuddy/LAB/JobBench deployment.
Run with PYTHONPATH pointing at the pinned Harness2 checkout. Artifacts are kept.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import secrets
import shutil
import subprocess

import harness2
from harness2.core import judge, runmark
from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec
from harness2.substrate.opencode import OpencodeSubstrate

from agent_profiles_harness2 import ProfilesBridge, evaluation_plan, evaluation_results, proposal_batch, seeded_adapter, start_migration
from agent_profiles_harness2.bridge import encoded
from agent_profiles_harness2.converters import UPSTREAM


REPO = Path(__file__).resolve().parents[2]
TASKS = ("alpha", "beta")


class LiveAdapter:
    def __init__(self, root, model, executable):
        self.root, self.model, self.executable = root, model, executable
        channel = ChannelSpec("opencode", model)
        self.spec = BenchSpec(name="ap-live", runs_root=root, install_mode="workspace_agents_md",
            prompts=BenchPrompts(work="classify states using the current routing policy"), channels={"proposer": channel, "selector": channel})
        self.substrate = OpencodeSubstrate(self.launch)
        self.launch_count = 0

    def launch(self, request, install):
        outputs = []
        for run_id in request.run_ids:
            run = self.root / run_id
            workspace = run / "workspace"
            workspace.mkdir(parents=True)
            prompt = "\n\n".join((install.staging_dir / name).read_text(encoding="utf-8")
                for name in self.substrate.surface().always_on if (install.staging_dir / name).is_file())
            (workspace / "AGENTS.md").write_text(prompt, encoding="utf-8")
            shutil.copytree(install.staging_dir / "skills", workspace / ".opencode/skills")
            message = f"Load the native routing skill and classify state {request.task_ref}. Return only the policy's routing token for that state. Use only the skill tool; do not read files or run commands."
            argv = [self.executable, "run", "--standalone", "--model", self.model, "--format", "json", message]
            self.launch_count += 1
            completed = subprocess.run(argv, cwd=workspace, capture_output=True, text=True, encoding="utf-8", timeout=request.timeout)
            (run / "events.jsonl").write_text(completed.stdout, encoding="utf-8")
            (run / "stderr.log").write_text(completed.stderr, encoding="utf-8")
            if completed.returncode:
                raise RuntimeError(f"native OpenCode failed; inspect {run / 'stderr.log'}")
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            assert not any(event.get("type") == "error" for event in events), "native error event"
            assert any(event.get("type") == "tool_use" and event.get("part", {}).get("tool") == "skill"
                and event["part"]["state"]["input"].get("id") == "routing" for event in events), "routing skill was not invoked"
            texts = [event["part"]["text"] for event in events if event.get("type") == "text"]
            assert texts, "native model returned no text"
            (run / "answer.txt").write_text(texts[-1].strip(), encoding="utf-8")
            session = next(event["sessionID"] for event in events if event.get("sessionID"))
            context = subprocess.run([self.executable, "api", "GET", f"/api/session/{session}/context"],
                capture_output=True, text=True, encoding="utf-8", check=True, timeout=30)
            assistants = [item for item in json.loads(context.stdout)["data"] if item.get("type") == "assistant"]
            assert assistants and all(f'{item["model"]["providerID"]}/{item["model"]["id"]}' == self.model for item in assistants), "native model differs from retained assignment"
            (run / "identity.json").write_bytes(encoded({"sessionID": session, "model": self.model, "agents": sorted({item["agent"] for item in assistants})}))
            outputs.append(run)
        return outputs

    def execute(self, task_id, harness_dir, run_id, *, timeout=180):
        run = self.root / run_id
        if runmark.is_complete(run, harness_dir=harness_dir):
            return run
        install = self.substrate.materialise(harness_dir, self.spec, {})
        try:
            result = self.substrate.execute(task_id, install, [run_id], timeout)[0]
            runmark.mark_complete(result, run_id=run_id, harness_dir=harness_dir)
            return result
        finally:
            shutil.rmtree(install.staging_dir)

    def score(self, run_dir, task_id):
        correct = (run_dir / "answer.txt").read_text(encoding="utf-8").strip() == self.expected[task_id]
        return {"all_pass": correct, "n_passed": int(correct), "n_criteria": 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--opencode", default="opencode")
    parser.add_argument("--prepare-only", action="store_true", help="retain exact synthetic payloads and plan without model requests")
    args = parser.parse_args()
    assert "/" in args.model, "use an explicit provider/model"
    assert subprocess.check_output([args.opencode, "--version"], text=True).strip() == "opencode v2.1.3"
    upstream = Path(harness2.__file__).resolve().parents[1]
    assert subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip() == UPSTREAM
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    cli = [shutil.which("node"), str(REPO / "bin/agent-profiles.ts")]
    profiles = ProfilesBridge(root / "capture", cli=cli, store=root / "store", model=args.model, role="worker", namespace="live")
    old, new, keep = (secrets.token_hex(12) for _ in range(3))
    def policy(alpha):
        return f"---\nname: routing\ndescription: Classify alpha and beta states using the current routing policy.\n---\nFor state alpha return {alpha}.\nFor state beta return {keep}.\nReturn the token only.\n".encode()
    files = {"systemprompt.md": b"Load the native routing skill to classify states. Follow its policy exactly.\n",
        "skills/routing/SKILL.md": policy(old)}
    captured = profiles.capture(files, surface="opencode", run_id="adopt/base", task_id="alpha", label="agg1")
    prepared = start_migration(profiles, captured, binding="skills.routing")
    base, migration = prepared["base"], prepared["migration"]
    project = Path(base["project"])
    changed = {**files, "skills/routing/SKILL.md": policy(new)}
    batch = proposal_batch(base, changed, migration, run_id="edit/policy", excerpt="Route alpha to the new token; preserve beta.")
    assert len(batch["proposals"]) == 1 and not batch["unsupported"]
    def save(name, value):
        file = root / name
        file.write_bytes(encoded(value))
        return str(file)
    proposal = profiles.command("migrate", "propose", migration["id"], save("proposal.json", batch["proposals"][0]), project=project)
    profiles.command("migrate", "accept", migration["id"], proposal["id"], project=project)
    skill = base["packages"]["skill-routing"]
    tree = project / migration["workspace"] / "packages" / skill["sha256"]
    script = f'import {{readPackage}} from {json.dumps((REPO / "src/packages.ts").as_uri())}; console.log(readPackage({{root:process.argv[1]}}).sha256)'
    tree_sha = subprocess.check_output([cli[0], "--input-type=module", "-e", script, str(tree)], text=True).strip()
    candidate = profiles.command("migrate", "candidate", migration["id"], save("candidate.json", {
        "candidateVersion": 1, "id": "live-candidate", "binding": "skills.routing",
        "release": {"name": skill["name"], "version": "1.0.0"},
        "migrationBase": base["stampDigest"], "evaluationBase": base["stampDigest"],
        "configSha256": json.loads((project / ".agent-profiles/agent-profiles.lock").read_bytes())["configSha256"],
        "expectedTreeSha256": tree_sha, "proposalIds": [proposal["id"]],
        "workflowChange": {"kind": "task-only", "reason": "Only the alpha routing token changes"}}), project=project)
    snapshots = {side: json.loads((profiles.store / "stamps/sha256" / stamp / "snapshot.json").read_bytes())
        for side, stamp in (("base", base["stampDigest"]), ("candidate", candidate["stampDigest"]))}
    plan = evaluation_plan(id="live-plan", candidate=candidate, base_stamp=base["stampDigest"], assignment=base["selection"],
        binding="skills.routing", member=skill["name"], workflow_peers={side: snapshot["workflowPeers"] for side, snapshot in snapshots.items()},
        tasks=[{"id": task, "taskId": task, "kind": "motivating" if task == "alpha" else "regression", "input": f"Classify state {task}", "expected": token}
            for task, token in (("alpha", new), ("beta", keep))],
        k=1, mode="agg", seed=0, judge={"id": "exact-native-answer", "version": "1", "settings": {}},
        rubric={"id": "routing-token-equality", "version": "1", "settings": {}})
    retained = profiles.command("migrate", "plan", candidate["id"], save("plan.json", plan), project=project)
    payloads = []
    for side in ("base", "candidate"):
        seed = profiles.seed(plan[side + "Stamp"], surface="opencode", project=project)
        native = {file.relative_to(seed).as_posix(): file.read_text(encoding="utf-8") for file in seed.rglob("*") if file.is_file()}
        assert set(native) == {"systemprompt.md", "skills/routing/SKILL.md"}, "unexpected model-visible input"
        payloads.append({"side": side, "model": args.model, "files": native,
            "tasks": [f"Load the native routing skill and classify state {task}. Return only the policy's routing token for that state. Use only the skill tool; do not read files or run commands." for task in TASKS]})
    save("payload-preview.json", payloads)
    if args.prepare_only:
        print(json.dumps({"status": "prepared-without-model-requests", "output": str(root), "payloads": payloads}, indent=2), flush=True)
        return
    arms, launches = [], 0
    for side in ("base", "candidate"):
        stamp = plan[side + "Stamp"]
        adapter = seeded_adapter(LiveAdapter)(root / side, args.model, args.opencode,
            profiles=profiles, seed_stamp=stamp, seed_project=project)
        adapter.expected = {"alpha": new, "beta": keep}
        arm = {"runsRoot": str(root / side), "stampDigest": stamp, "conditions": deepcopy(plan["conditions"]), "judged": [], "rollouts": []}
        for task in TASKS:
            run_id = f"{side}/{task}/base1"
            run = adapter.execute(task, None, run_id)
            scored = judge.judge_one(adapter, task, "agg", 1, "base1", run_id, run)
            assert scored.graded, scored.error
            arm["judged"].append({"task": task, "label": "base1", "run_id": run_id, "score": scored.raw})
            name, _ = profiles._rollout_record(run_id, task, adapter._profiles_identity(None))
            arm["rollouts"].append(json.loads((profiles.root / "rollouts" / name).read_bytes()))
            assert adapter.execute(task, None, run_id) == run
            print(f"{side}/{task}: answer {'PASS' if scored.all_pass else 'FAIL'}; native cache replay reused", flush=True)
        assert adapter.launch_count == len(TASKS), "cache replay launched another model"
        conflict = root / f"{side}-different-input"
        shutil.copytree(adapter.base_harness(), conflict)
        with (conflict / "systemprompt.md").open("a", encoding="utf-8") as stream:
            stream.write("\nChanged input must refuse before launch.\n")
        try:
            adapter.execute("alpha", conflict, f"{side}/alpha/base1")
        except ValueError:
            pass
        else:
            raise AssertionError("changed-input run ID was accepted")
        assert adapter.launch_count == len(TASKS)
        launches += adapter.launch_count
        arms.append(arm)
    assert [row["score"]["all_pass"] for row in arms[0]["judged"]] == [False, True]
    assert all(row["score"]["all_pass"] for row in arms[1]["judged"])
    result = evaluation_results(id="live-results", plan=plan, plan_digest=retained["planDigest"], base=arms[0], candidate=arms[1])
    imported = profiles.command("migrate", "results", plan["id"], save("results.json", result), project=project)
    report = profiles.command("migrate", "report", result["id"], project=project)
    assert report["eligibility"]["status"] == "eligible"
    decision = {"decisionVersion": 1, "id": "live-promote", "resultId": result["id"], "candidateId": candidate["id"],
        "candidateRevisionDigest": candidate["revisionDigest"], "planDigest": retained["planDigest"], "resultDigest": imported["resultDigest"],
        "assignment": base["selection"], "release": candidate["release"], "regressions": report["eligibility"]["regressions"], "correctnessOverride": None}
    decision_file = save("decision.json", decision)
    before = (project / ".agent-profiles/agents.yaml").read_bytes()
    preview = profiles.command("migrate", "preview", decision_file, project=project)
    assert preview["status"] == "preview" and (project / ".agent-profiles/agents.yaml").read_bytes() == before
    promoted = profiles.command("migrate", "promote", decision_file, project=project)
    assert promoted["status"] == "promoted"
    final = json.loads((profiles.store / "stamps/sha256" / promoted["stampDigest"] / "snapshot.json").read_bytes())
    assert final["selection"]["host"] == "opencode"
    assert profiles.command("verify", promoted["stampDigest"], project=project)["managedReproducible"]
    summary = {"status": "passed", "opencode": "2.1.3", "model": args.model, "harness2": UPSTREAM,
        "assignment": base["selection"], "launches": launches, "baseCorrect": 1, "candidateCorrect": 2, "cases": 2,
        "planDigest": retained["planDigest"], "resultDigest": imported["resultDigest"], "promotedStamp": promoted["stampDigest"],
        "cacheReplay": "passed", "changedInputRefusal": "passed", "preview": "read-only", "promotion": "passed"}
    save("summary.json", summary)
    print(json.dumps(summary, indent=2), flush=True)
    print(f"Evidence retained at {root}", flush=True)


if __name__ == "__main__":
    main()
