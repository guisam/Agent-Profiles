"""Prepare/run one JobBench task through Harness2's Codex substrate on Windows.

This deployment uses the installed, recorded Codex and subscription auth, not the
stock Linux JobBench runner or its pinned Codex distribution. No search, grading,
promotion, credential copying, or approval bypass occurs here.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace


UPSTREAM = "1cfe254e8d25b15f37048c3730134686abe60335"
CODEX_VERSION = "codex-cli 0.163.0"
TASK = "technical_writers/task1"
OUTPUTS = (
    "MIGRATION_GUIDE_v2.0_to_v2.2.md", "API_REFERENCE.md",
    "TROUBLESHOOTING_GUIDE.md", "RELEASE_NOTES_v2.2.md",
)


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def save(file, value):
    Path(file).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def verify_digest(file, expected):
    file = Path(file)
    if (file.is_symlink() or file.is_junction() or not file.is_file()
            or file.stat().st_nlink != 1
            or hashlib.sha256(file.read_bytes()).hexdigest() != expected):
        raise ValueError(f"input changed or is not an ordinary file: {file}")


def inputs(root):
    dataset, reference = read_json(root / "dataset.json"), read_json(root / "reference.json")
    if dataset["task"] != TASK:
        raise ValueError("this pilot supports only technical_writers/task1")
    for asset in dataset["assets"]:
        name = asset["path"]
        if name == "RUBRICS.json":
            file = root / "grader" / name
        elif name.startswith("task_folder/") and Path(name).name == name.split("/")[1]:
            file = root / "source" / name
        else:
            raise ValueError(f"unsupported task input path: {name}")
        verify_digest(file, asset["sha256"])
    if reference["path"] != "references/swagger_markdown_api_docs_example.md":
        raise ValueError("unexpected external reference path")
    verify_digest(root / "source" / reference["path"], reference["sha256"])
    return dataset, reference


def matching_harnesses(prepared):
    for name in ("AGENTS.md", ".agents/skills/documentation-writer/SKILL.md"):
        contents = [Path(value["seed"]).joinpath(name).read_bytes() for value in prepared["models"].values()]
        if len(contents) != 2 or contents[0] != contents[1]:
            raise ValueError(f"managed baseline differs between the two models: {name}")


def provider_args(model):
    if model["provider"] == "subscription":
        return []
    if model["provider"] != "strata" or model["baseUrl"] != "http://127.0.0.1:8080/v1":
        raise ValueError("the local provider must use the approved Strata loopback endpoint")
    settings = {
        "model_provider": "strata",
        "model_providers.strata.name": "Strata",
        "model_providers.strata.base_url": model["baseUrl"],
        "model_providers.strata.wire_api": "responses",
        "model_providers.strata.requires_openai_auth": False,
        "model_providers.strata.supports_websockets": False,
        "model_providers.strata.request_max_retries": 0,
        "model_providers.strata.stream_max_retries": 0,
        "model_providers.strata.stream_idle_timeout_ms": 30000,
        "model_context_window": 131072,
    }
    return [argument for key, value in settings.items() for argument in ("-c", f"{key}={json.dumps(value)}")]


def windows_sandbox_args(config_file):
    config = tomllib.loads(config_file.read_text(encoding="utf-8-sig"))
    mode = config.get("windows", {}).get("sandbox")
    if mode not in ("elevated", "unelevated", "mxc"):
        raise ValueError("select a working Windows sandbox in your normal Codex configuration before running the pilot")
    return ["-c", f"windows.sandbox={json.dumps(mode)}"]


def launch_codex(settings, model, workspace, artifacts, prompt, timeout):
    artifacts.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.pop("OPENAI_API_KEY", None)
    if model["provider"] == "subscription":
        env.pop("OPENAI_BASE_URL", None)
        auth = subprocess.run([settings["node"], settings["codexScript"], "login", "status"],
                              capture_output=True, text=True, encoding="utf-8", env=env, timeout=30)
        if auth.returncode or "Logged in using ChatGPT" not in auth.stdout + auth.stderr:
            raise RuntimeError("Luna requires the existing ChatGPT login; API-key fallback is not authorized")
    argv = [settings["node"], settings["codexScript"], "exec", "--model", model["id"],
            "--cd", str(workspace), "--skip-git-repo-check", "--ignore-user-config",
            "--ephemeral", "--sandbox", "workspace-write", "--json",
            "--output-last-message", str(artifacts / "last-message.txt"),
            "-c", 'model_reasoning_effort="low"', "-c", 'web_search="disabled"',
            *settings["windowsSandboxArgs"], *provider_args(model), prompt]
    save(artifacts / "command.json", {"argv": argv, "timeoutSeconds": timeout})
    with (artifacts / "events.jsonl").open("w", encoding="utf-8") as out, (artifacts / "stderr.log").open("w", encoding="utf-8") as err:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=env,
                                   creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            code = process.wait(timeout=timeout)
        finally:
            if process.poll() is None:
                # Stop only this launcher's owned process tree, including the native CLI child.
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                process.wait(timeout=30)
    if code:
        raise RuntimeError(f"Codex exited {code}; inspect {artifacts / 'stderr.log'}")
    return [json.loads(line) for line in (artifacts / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def prepare(root, settings, profiles_type):
    dataset, reference = inputs(root)
    input_hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                    for name in ("dataset.json", "reference.json")}
    node_version = subprocess.check_output([settings["node"], "--version"], text=True).strip()
    codex_version = subprocess.check_output([settings["node"], settings["codexScript"], "--version"], text=True).strip()
    revision = subprocess.check_output(["git", "-C", settings["harness2"], "rev-parse", "HEAD"], text=True).strip()
    if not node_version.startswith("v24.") or codex_version != CODEX_VERSION or revision != UPSTREAM:
        raise ValueError("expected Node 24, Codex 0.163.0, and the pinned Harness2 checkout")
    models = settings["models"]
    if (len(models) != 2 or {model["label"] for model in models} != {"luna", "strata"}
            or len({model["id"] for model in models}) != 2):
        raise ValueError("expected the two distinct luna/strata model selections")
    for model in models:
        provider_args(model)
    stamp_file = root / "prepared.json"
    settings_sha = hashlib.sha256((root / "settings.json").read_bytes()).hexdigest()
    if stamp_file.exists():
        prepared = read_json(stamp_file)
        if prepared["settingsSha256"] != settings_sha:
            raise ValueError("settings changed after preparation; use a fresh pilot directory")
        if prepared.get("inputManifestSha256") != input_hashes:
            raise ValueError("input manifests changed after preparation; use a fresh pilot directory")
        for model in models:
            captured = prepared["models"][model["label"]]["capture"]
            if captured["selection"] != {"model": model["id"], "role": "technical-writer", "host": "codex"}:
                raise ValueError("prepared baseline selection differs from the requested model/role/host")
            profiles = profiles_type(root / "captures" / model["label"],
                cli=[settings["node"], str(Path(settings["repository"]) / "bin/agent-profiles.ts")],
                store=root / "store", model=model["id"], role="technical-writer", namespace="pilot")
            if not profiles.command("verify", captured["stampDigest"], project=Path(captured["project"]))["managedReproducible"]:
                raise ValueError("prepared baseline no longer verifies")
        matching_harnesses(prepared)
        return prepared
    primary = (
        "Role: technical writer. Follow task_folder/TASK_INSTRUCTIONS.txt and write the requested files under output/.\n"
        "Use .agents/skills/documentation-writer/SKILL.md for documentation work.\n"
        "The user has approved the requested deliverables and scope; complete the task directly.\n"
        "Use only task_folder/, references/, .agents/, AGENTS.md and output/ in this workspace.\n"
        "The external styling reference is pre-provisioned in references/. Do not access the network or other workspaces.\n"
    )
    skill = Path(settings["skill"]).read_bytes()
    prepared = {"task": TASK, "settingsSha256": settings_sha, "inputManifestSha256": input_hashes,
                "dataset": dataset, "reference": reference, "node": node_version,
                "codex": codex_version, "harness2": revision, "models": {}}
    for model in models:
        profiles = profiles_type(root / "captures" / model["label"],
            cli=[settings["node"], str(Path(settings["repository"]) / "bin/agent-profiles.ts")],
            store=root / "store", model=model["id"], role="technical-writer", namespace="pilot")
        captured = profiles.capture({"AGENTS.md": primary.encode(),
            ".agents/skills/documentation-writer/SKILL.md": skill}, surface="codex",
            run_id=f"prepare/{model['label']}", task_id=TASK, label="base")
        seed = profiles.seed(captured["stampDigest"], surface="codex", project=Path(captured["project"]))
        if not profiles.command("verify", captured["stampDigest"], project=Path(captured["project"]))["managedReproducible"]:
            raise ValueError("baseline stamp did not verify")
        prepared["models"][model["label"]] = {"capture": captured, "seed": str(seed)}
    matching_harnesses(prepared)
    save(stamp_file, prepared)
    return prepared


def self_check():
    with tempfile.TemporaryDirectory(prefix="ap-jobbench-check-") as directory:
        config = Path(directory) / "config.toml"
        for mode in ("elevated", "unelevated", "mxc"):
            config.write_text(f'[windows]\nsandbox = "{mode}"\n', encoding="utf-8")
            assert windows_sandbox_args(config) == ["-c", f'windows.sandbox="{mode}"']
        for content in ('', '[windows]\nsandbox = "disabled"\n'):
            config.write_text(content, encoding="utf-8")
            try:
                windows_sandbox_args(config)
            except ValueError:
                pass
            else:
                raise AssertionError("missing or unsupported sandbox selection was admitted")
        file = Path(directory) / "input.txt"
        file.write_bytes(b"original task")
        expected = hashlib.sha256(file.read_bytes()).hexdigest()
        verify_digest(file, expected)
        file.write_bytes(b"changed task")
        try:
            verify_digest(file, expected)
        except ValueError:
            pass
        else:
            raise AssertionError("changed task input was admitted")
    print("PASS: native sandbox selection is preserved; missing/invalid selection and task tampering refuse before launch.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="prepared pilot directory containing settings.json and source/")
    parser.add_argument("--run", action="store_true", help="run two file-access probes, then one task rollout per model")
    parser.add_argument("--self-check", action="store_true", help="test input integrity checks without models")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return 0
    if args.root is None:
        parser.error("--root is required")
    if os.name != "nt" or sys.version_info < (3, 12):
        raise RuntimeError("this deployment requires Windows and Python 3.12+")
    root = args.root.resolve()
    settings = read_json(root / "settings.json")
    sys.path[:0] = [settings["harness2"], str(Path(settings["repository"]) / "integrations/harness2")]
    from harness2.core import runmark
    from harness2.substrate.codex import CodexSubstrate
    from agent_profiles_harness2 import ProfilesBridge, seeded_adapter

    prepared = prepare(root, settings, ProfilesBridge)
    if not args.run:
        print(f"Prepared and verified both baseline stamps. No model calls.\nArtifacts: {root}")
        return 0
    # Ignore unrelated user settings, but retain the owner's configured native sandbox.
    config_root = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    settings["windowsSandboxArgs"] = windows_sandbox_args(config_root / "config.toml")
    run_root = root / "runs" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3))
    run_root.mkdir(parents=True)
    summary = {"status": "preflight", "task": TASK,
               "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "deployment": "Windows Codex custom launcher; not stock Linux JobBench",
               "windowsSandboxArgs": settings["windowsSandboxArgs"],
               "settings": prepared, "preflight": {}, "runs": {}, "grading": "not-run", "promotion": "not-authorized"}
    for model in settings["models"]:
        workspace = run_root / "preflight" / model["label"] / "workspace"
        workspace.mkdir(parents=True)
        (workspace / "readiness.txt").write_text("READY\n", encoding="utf-8")
        artifacts = workspace.parent
        try:
            events = launch_codex(settings, model, workspace, artifacts,
                "Read readiness.txt using the shell tool and reply only READY. Do not read other files or make changes.", 180)
            command_ok = any(event.get("type") == "item.completed" and event.get("item", {}).get("type") == "command_execution"
                             and event["item"].get("exit_code") == 0
                             and "readiness.txt" in event["item"].get("command", "")
                             and event["item"].get("aggregated_output", "").strip() == "READY" for event in events)
            if (artifacts / "last-message.txt").read_text(encoding="utf-8").strip() != "READY" or not command_ok:
                raise RuntimeError("no successful file-read evidence; do not bypass the executor's policy")
            summary["preflight"][model["label"]] = {"status": "passed"}
        except Exception as error:
            summary["preflight"][model["label"]] = {"status": "failed", "error": str(error)}
    if any(value["status"] != "passed" for value in summary["preflight"].values()):
        summary["status"] = "preflight-blocked"
        save(run_root / "summary.json", summary)
        print(f"File-access preflight blocked; no task rollouts started.\nInspect: {run_root / 'summary.json'}")
        return 2

    class PilotAdapter:
        def __init__(self, model, captures):
            self.model, self.captures = model, captures
            self.substrate = CodexSubstrate(self.launch)

        def launch(self, request, install):
            results = []
            for run_id in request.run_ids:
                run = run_root / self.model["label"] / run_id
                workspace = run / "workspace"
                workspace.mkdir(parents=True)
                shutil.copytree(install.staging_dir, workspace, dirs_exist_ok=True)
                shutil.copytree(root / "source/task_folder", workspace / "task_folder")
                shutil.copytree(root / "source/references", workspace / "references")
                output = workspace / "output"
                output.mkdir()
                prompt = (
                    "Read AGENTS.md, .agents/skills/documentation-writer/SKILL.md and task_folder/TASK_INSTRUCTIONS.txt. "
                    "The user approved the four requested deliverables and their outline; write them completely under output/. "
                    "All task data is in task_folder/ and the styling reference is in references/. "
                    "Work only in this workspace. Do not access the network or inspect other directories. "
                    "Do not stop at an outline or ask for clarification. State any actual source gaps in the deliverables."
                )
                launch_codex(settings, self.model, workspace, run, prompt, request.timeout)
                for name in ("AGENTS.md", ".agents/skills/documentation-writer/SKILL.md"):
                    verify_digest(workspace / name, hashlib.sha256((install.staging_dir / name).read_bytes()).hexdigest())
                for asset in prepared["dataset"]["assets"]:
                    if asset["path"] != "RUBRICS.json":
                        verify_digest(workspace / asset["path"], asset["sha256"])
                verify_digest(workspace / prepared["reference"]["path"], prepared["reference"]["sha256"])
                if output.is_symlink() or output.is_junction() or {file.name for file in output.iterdir()} != set(OUTPUTS):
                    raise RuntimeError("expected exactly the four requested Markdown deliverables")
                for name in OUTPUTS:
                    file = output / name
                    if file.is_symlink() or file.is_junction() or file.stat().st_nlink != 1 or len(file.read_text(encoding="utf-8-sig").strip()) < 80:
                        raise RuntimeError(f"missing, linked or empty deliverable: {name}")
                save(run / "outputs.json", {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in OUTPUTS})
                results.append(run)
            return results

        def execute(self, task_id, harness_dir, run_id, timeout=600):
            inputs(root)
            for name, expected in prepared["inputManifestSha256"].items():
                verify_digest(root / name, expected)
            install = self.substrate.materialise(harness_dir, SimpleNamespace(install_mode="codex_root"), {})
            try:
                run = self.substrate.execute(task_id, install, [run_id], timeout)[0]
                runmark.mark_complete(run, run_id=run_id, harness_dir=harness_dir)
                return run
            finally:
                shutil.rmtree(install.staging_dir)

    for model in settings["models"]:
        captures = prepared["models"][model["label"]]["capture"]
        profiles = ProfilesBridge(root / "captures" / model["label"],
            cli=[settings["node"], str(Path(settings["repository"]) / "bin/agent-profiles.ts")],
            store=root / "store", model=model["id"], role="technical-writer", namespace="pilot")
        adapter = seeded_adapter(PilotAdapter)(model, captures, profiles=profiles,
            seed_stamp=captures["stampDigest"], seed_project=Path(captures["project"]))
        try:
            run = adapter.execute(TASK, None, f"{run_root.name}/{model['label']}/task1/base1")
            summary["runs"][model["label"]] = {"status": "completed", "directory": str(run)}
        except Exception as error:
            summary["runs"][model["label"]] = {"status": "failed", "error": str(error)}
        save(run_root / "summary.json", summary)
    summary["status"] = "completed-ungraded" if all(value["status"] == "completed" for value in summary["runs"].values()) else "incomplete"
    save(run_root / "summary.json", summary)
    print(f"{summary['status']}\nSummary: {run_root / 'summary.json'}")
    return 0 if summary["status"] == "completed-ungraded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
