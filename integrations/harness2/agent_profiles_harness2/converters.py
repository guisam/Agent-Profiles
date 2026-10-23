"""Explicit artifact conversion. Judgments and runner metadata remain external claims."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import tempfile

from .bridge import encoded, read_file, safe

UPSTREAM = "1cfe254e8d25b15f37048c3730134686abe60335"


def text(value):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("expected nonempty text without NUL")
    return value


def captured_host(record):
    host = record["selection"]["host"]
    if host not in ("codex", "opencode") or record["surface"] != host:
        raise ValueError("migration conversion requires a matching native host and surface; recapture legacy null-host inputs")
    return host


def start_migration(profiles, captured, *, binding):
    """Select a captured skill in a new evaluation project, then start a fork."""
    host = captured_host(captured)
    if not isinstance(binding, str) or not binding.startswith("skills."):
        raise ValueError("expected a skills binding")
    config = json.loads(read_file(safe(Path(captured["project"]), ".agent-profiles/agents.yaml")))
    skill = binding.removeprefix("skills.")
    if skill not in config["skills"]:
        raise ValueError("skill binding is absent from captured configuration")
    role = config["roles"][captured["selection"]["role"]]["skills"]
    role["required"] = sorted(set(role["required"]) | {skill})
    role["available"] = [name for name in role["available"] if name != skill]
    parent = safe(profiles.root, "migration-projects")
    parent.mkdir(exist_ok=True)
    project = Path(tempfile.mkdtemp(prefix="fork-", dir=parent))
    (project / ".agent-profiles").mkdir()
    (project / ".agent-profiles/agents.yaml").write_bytes(encoded(config))
    profiles.command("install", "--offline", project=project)
    selectors = ["--role", captured["selection"]["role"], "--model", captured["selection"]["model"], "--host", host]
    stamp = profiles.command("stamp", *selectors, project=project)
    base = deepcopy(captured)
    base.update(project=str(project), stampDigest=stamp["digest"])
    migration = profiles.command("migrate", "start", *selectors, "--sharing", "fork", project=project)
    return {"base": base, "migration": migration}


def proposal_batch(base, after: dict[str, bytes], migration, *, run_id, excerpt, draft_case=None, before_tree=None):
    """Convert changed captured entrypoints against an untouched fork workspace.

    Return proposals and every unsupported change; never accept or publish candidates.
    """
    captured_host(base)
    text(run_id)
    text(excerpt)
    if (migration["state"] != "open" or migration["sharing"] != "fork"
            or len(migration["bases"]) != 1
            or migration["bases"][0]["stamp"] != base["stampDigest"]
            or migration["bases"][0]["assignment"] != base["selection"]):
        raise ValueError("expected an open fork migration matching the captured base and assignment")
    if draft_case is not None:
        if set(draft_case) != {"input", "expected"}:
            raise ValueError("draft case needs input and expected")
        for value in draft_case.values():
            text(value)
    workspace = safe(Path(base["project"]), migration["workspace"])
    tracked = {item["path"]: item["sha256"] for item in migration["files"]}
    entrypoints = {}
    for component, pin in base["packages"].items():
        if component.startswith("skill-"):
            entrypoints[(pin["sha256"], "SKILL.md")] = "package"
        elif component in ("profile", "role"):
            entrypoints[(pin["sha256"], "PROMPT.md" if component == "profile" else "ROLE.md")] = "model-specific" if component == "profile" else "role"
        elif component.startswith("instruction-"):
            entrypoints[(pin["sha256"], "CONTENT.md")] = "model-specific"
    proposals, unsupported = [], []
    baseline = base["components"] if before_tree is None else before_tree
    for name in sorted(set(baseline) | set(after)):
        safe(workspace, name)
        source = base["components"].get(name)
        content = after.get(name)
        if content is not None and not isinstance(content, bytes):
            raise ValueError("after-tree values must be bytes")
        original_sha = (base["components"][name]["sha256"] if before_tree is None else hashlib.sha256(before_tree[name]).hexdigest()) if name in baseline else None
        if content is not None and hashlib.sha256(content).hexdigest() == original_sha:
            continue
        reason = None
        if name not in baseline or content is None:
            reason = "added or deleted component"
        elif source is None or original_sha != source["sha256"]:
            reason = "generated or composed text has no single captured entrypoint mapping"
        elif (source["packageDigest"], source["packagePath"]) not in entrypoints:
            reason = "scripts, subagents, plugins and companion files are unsupported"
        else:
            target = f'packages/{source["packageDigest"]}/{source["packagePath"]}'
            before = read_file(safe(workspace, target))
            if (hashlib.sha256(before).hexdigest() != source["sha256"]
                    or tracked.get(target) != source["sha256"]):
                raise ValueError("stale workspace or mismatched captured component")
            try:
                before_text, after_text = before.decode("utf-8"), content.decode("utf-8")
                if "\0" in before_text + after_text:
                    raise ValueError("NUL")
            except (UnicodeError, ValueError):
                reason = "non-UTF-8 or NUL text"
            if reason is None:
                classification = entrypoints[(source["packageDigest"], source["packagePath"])]
                proposal = {
                    "proposalVersion": 1, "classification": classification,
                    "target": {"path": target},
                    "change": {"before": before_text, "after": after_text},
                    "evidence": [{"sessionId": run_id, "excerpt": excerpt, "baseStamp": base["stampDigest"]}],
                }
                if draft_case is not None:
                    proposal["draftCase"] = deepcopy(draft_case)
                proposals.append(proposal)
        if reason:
            unsupported.append({"path": name, "reason": reason})
    return {"proposals": proposals, "unsupported": unsupported, "evidenceStatus": "external-claim"}


def evaluation_plan(*, id, candidate, base_stamp, assignment, binding, member,
                    workflow_peers, tasks, k, mode, seed, judge, rubric):
    """Build a strict migrate-plan artifact; retain it with `migrate plan` before running."""
    host = assignment.get("host")
    if host not in ("codex", "opencode"):
        raise ValueError("paired conversion requires a supported native host")
    if type(k) is not int or not 0 < k <= 9007199254740991 or mode not in ("agg", "seq"):
        raise ValueError("expected positive k and agg or seq mode")
    if seed is not None and (type(seed) is not int or not 0 <= seed <= 9007199254740991):
        raise ValueError("seed must be a nonnegative safe integer or null")
    if not re.fullmatch(r"skills\.[a-z0-9][a-z0-9-]*", binding):
        raise ValueError("paired evaluation requires a skill binding")
    cases, subset = [], []
    for task in tasks:
        if not {"id", "taskId", "kind", "input", "expected"} <= set(task) or set(task) - {"id", "taskId", "kind", "input", "expected", "target"}:
            raise ValueError("tasks need id, taskId, kind, input and expected")
        for key in ("id", "taskId", "input", "expected"):
            text(task[key])
        cases.append({key: task[key] for key in ("id", "kind", "input", "expected")})
        cases[-1]["target"] = deepcopy(task.get("target", {"assignment": assignment, "binding": binding, "member": member, "protocol": None}))
        subset.append({"caseId": task["id"], "taskId": task["taskId"]})
    if (len({item["caseId"] for item in subset}) != len(subset)
            or len({item["taskId"] for item in subset}) != len(subset)
            or not {"motivating", "regression"} <= {case["kind"] for case in cases}
            or any(case["kind"] not in ("motivating", "regression", "workflow", "collateral") for case in cases)):
        raise ValueError("need unique tasks and motivating plus regression cases")
    for condition in (judge, rubric):
        if set(condition) != {"id", "version", "settings"} or not isinstance(condition["settings"], dict):
            raise ValueError("judge and rubric need id, version and settings")
        text(condition["id"])
        text(condition["version"])
    return deepcopy({
        "planVersion": 1, "id": id, "candidateId": candidate["id"],
        "candidateRevisionDigest": candidate["revisionDigest"],
        "baseStamp": base_stamp, "candidateStamp": candidate["stampDigest"],
        "context": {"assignment": assignment, "requestedSkills": [], "workflowPeers": workflow_peers},
        "cases": cases, "trials": k,
        "conditions": {"harness": {"id": "harness2", "version": UPSTREAM,
            "settings": {"substrate": host, "k": k, "mode": mode, "seed": seed, "subset": subset}},
            "judge": judge, "rubric": rubric},
    })


def evaluation_results(*, id, plan, plan_digest, base, candidate):
    """Convert two fixed-arm base_judged lists with pre-execution rollout sidecars.

    Each arm supplies runsRoot, stampDigest, conditions, judged and rollouts.
    Optional costs are actual per-rollout ledger entries keyed by runId; summary
    totals and selection scores are deliberately not supported.
    """
    roots = [Path(arm["runsRoot"]).resolve() for arm in (base, candidate)]
    if roots[0] == roots[1] or roots[0] in roots[1].parents or roots[1] in roots[0].parents:
        raise ValueError("fixed arms require separate, nonoverlapping HARNESS2_RUNS_DIR roots")
    settings = plan["conditions"]["harness"]
    host = plan["context"]["assignment"].get("host")
    if (settings["id"] != "harness2" or settings["version"] != UPSTREAM
            or host not in ("codex", "opencode") or settings["settings"]["substrate"] != host
            or settings["settings"]["k"] != plan["trials"]):
        raise ValueError("not a pinned Harness2 plan matching the native assignment host")
    task_cases = {item["taskId"]: item["caseId"] for item in settings["settings"]["subset"]}
    if len(task_cases) != len(plan["cases"]) or set(task_cases.values()) != {case["id"] for case in plan["cases"]}:
        raise ValueError("task subset does not match plan cases")
    outcomes, all_runs = [], set()
    for side, arm in (("base", base), ("candidate", candidate)):
        stamp = plan[side + "Stamp"]
        if arm["stampDigest"] != stamp or arm["conditions"] != plan["conditions"]:
            raise ValueError("arm stamp or conditions differ from retained plan")
        records = {record["runId"]: record for record in arm["rollouts"]}
        costs = {record["runId"]: record for record in arm.get("costs", [])}
        if len(records) != len(arm["rollouts"]) or len(costs) != len(arm.get("costs", [])):
            raise ValueError("duplicate rollout or cost evidence")
        if len(arm["judged"]) != len(task_cases) * plan["trials"]:
            raise ValueError("missing or foreign fixed-arm coverage")
        seen, used_runs = set(), set()
        for row in arm["judged"]:
            if not isinstance(row, dict) or set(row) != {"task", "label", "run_id", "score"}:
                raise ValueError("expected base_judged rows, not selected-harness scores")
            label = row["label"]
            if row["task"] not in task_cases or not isinstance(label, str) or not re.fullmatch(r"base[1-9][0-9]*", label):
                raise ValueError("foreign task or non-base label")
            trial = int(label[4:])
            key = (row["task"], trial)
            if trial > plan["trials"] or key in seen:
                raise ValueError("duplicate or foreign trial")
            seen.add(key)
            run_id = text(row["run_id"])
            if run_id in all_runs:
                raise ValueError("reused run ID across trials or arms")
            all_runs.add(run_id)
            used_runs.add(run_id)
            record = records.get(run_id, {})
            if (record.get("stampDigest") != stamp or record.get("taskId") != row["task"]
                    or record.get("inputObservation") != "before-execution"
                    or not re.fullmatch(r"[0-9a-f]{16}", record.get("fingerprint", ""))
                    or not re.fullmatch(r"[0-9a-f]{64}", record.get("treeDigest", ""))):
                raise ValueError("missing or mismatched pre-execution rollout identity")
            score = row["score"]
            if not isinstance(score, dict) or type(score.get("all_pass")) is not bool:
                raise ValueError("ungraded row or missing boolean all_pass")
            if "n_passed" in score or "n_criteria" in score:
                passed, count = score.get("n_passed"), score.get("n_criteria")
                if (type(passed) not in (int, float) or type(count) not in (int, float)
                        or not 0 <= passed <= count <= 9007199254740991 or count == 0
                        or score["all_pass"] != (passed == count)):
                    raise ValueError("inconsistent grade counts")
            cost = costs.get(run_id)
            usd = None
            if cost is not None:
                if (set(cost) != {"runId", "taskId", "kind", "label", "usd"}
                        or cost["taskId"] != row["task"] or cost["kind"] != "rollout" or cost["label"] != label):
                    raise ValueError("cost must be an individual matching rollout ledger entry")
                usd = cost["usd"]
                if (type(usd) not in (int, float) or not 0 <= usd <= 9007199254740991
                        or math.copysign(1, usd) < 0):
                    raise ValueError("invalid recorded cost")
            outcomes.append({"caseId": task_cases[row["task"]], "trial": trial, "side": side,
                "stampDigest": stamp, "assignment": deepcopy(plan["context"]["assignment"]),
                "correct": score["all_pass"], "metrics": {"costUsd": usd, "tokens": None,
                    "turns": None, "toolCalls": None, "latencyMs": None}, "evidenceRef": run_id})
        expected = {(task, trial) for task in task_cases for trial in range(1, plan["trials"] + 1)}
        if seen != expected or set(records) != used_runs or not set(costs) <= used_runs:
            raise ValueError("missing or foreign fixed-arm coverage")
        if len({(record["treeDigest"], record["fingerprint"]) for record in records.values()}) != 1:
            raise ValueError("fixed-arm harness bytes changed during evaluation")
    return {"resultVersion": 1, "id": id, "planDigest": plan_digest,
        "candidateRevisionDigest": plan["candidateRevisionDigest"],
        "conditions": {"base": deepcopy(plan["conditions"]), "candidate": deepcopy(plan["conditions"])},
        "outcomes": outcomes}
