"""Archive adopted bytes through the Node CLI; never execute package components."""

from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

from harness2.core import runmark, tree as ht
from harness2.substrate.codex import CODEX_SURFACE
from harness2.substrate.opencode import OPENCODE_SURFACE


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def digest(files: dict[str, bytes]) -> str:
    value = hashlib.sha256(b"agent-profiles/harness2-tree/v1\0")
    for name, content in sorted(files.items()):
        for part in (name.encode(), content):
            value.update(len(part).to_bytes(8, "big"))
            value.update(part)
    return value.hexdigest()


def linked(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def safe(root: Path, relative: str) -> Path:
    parts = relative.split("/")
    if (
        not relative or relative.startswith("/")
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", relative)
        or any(
            part in ("", ".", "..") or part.lower() == ".git"
            or part.endswith(".") or len(part) > 255
            or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.I)
            for part in parts
        )
    ):
        raise ValueError(f"unsafe relative path: {relative!r}")
    target = root
    for part in parts:
        target = target / part
        if linked(target):
            raise ValueError(f"links are forbidden: {target}")
    return target


def read_file(path: Path) -> bytes:
    if linked(path) or not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError(f"expected an ordinary unlinked file: {path}")
    return path.read_bytes()


def surface_for(name: str):
    if name not in ("codex", "opencode"):
        raise ValueError("surface must be codex or opencode")
    return CODEX_SURFACE if name == "codex" else OPENCODE_SURFACE


def read_tree(directory: Path, surface) -> dict[str, bytes]:
    directory = Path(directory)
    if any(linked(parent) for parent in (directory, *directory.parents)) or not directory.is_dir():
        raise ValueError("expected an ordinary harness directory")
    stubs = {name for name, _ in surface.stubs}
    files = {}
    for file in sorted(directory.rglob("*")):
        if linked(file):
            raise ValueError(f"links are forbidden: {file}")
        if file.is_dir():
            continue
        relative = file.relative_to(directory).as_posix()
        if relative in stubs or "__pycache__" in file.relative_to(directory).parts:
            continue
        files[relative] = read_file(file)
    return files


class ProfilesBridge:
    def __init__(
        self, root: Path, *, cli: list[str], store: Path,
        model: str, role: str, namespace: str = "harness2",
    ):
        if not isinstance(cli, list) or not cli or any(not isinstance(arg, str) or not arg for arg in cli):
            raise ValueError("cli must be a nonempty argument list")
        if not isinstance(model, str) or not model.strip() or not isinstance(role, str) or not isinstance(namespace, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", role) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", namespace):
            raise ValueError("model, role and namespace must be explicit valid identifiers")
        root = Path(root).absolute()
        if any(linked(parent) for parent in (root, *root.parents)):
            raise ValueError("capture root must not contain links")
        root.mkdir(parents=True, exist_ok=True)
        self.root = root.resolve()
        self.cli, self.store = list(cli), Path(store).resolve()
        self.model, self.role, self.namespace = model, role, namespace
        self._mutex = threading.Lock()

    def command(self, *args: str, project: Path) -> dict:
        result = subprocess.run([*self.cli, *args, "--root", str(project), "--store", str(self.store), "--json"], capture_output=True, text=True, encoding="utf-8", check=False)
        if result.returncode:
            raise RuntimeError(f"Agent Profiles {args[0]} failed: {result.stderr.strip()}")
        return json.loads(result.stdout)

    @contextmanager
    def writer(self):
        with self._mutex:
            lock = safe(self.root, ".capture-lock")
            try:
                lock.mkdir()
            except FileExistsError as error:
                raise RuntimeError("capture busy; confirm no writer before removing .capture-lock") from error
            try:
                yield
            finally:
                lock.rmdir()

    def immutable(self, relative: str, content: bytes) -> Path:
        target = safe(self.root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if read_file(target) != content:
                raise ValueError(f"immutable capture conflict: {relative}")
        else:
            with target.open("xb") as output:
                output.write(content)
        return target

    def _index(self):
        rows = []
        directory = safe(self.root, "adoptions")
        if directory.exists():
            for file in sorted(directory.glob("*.json")):
                row = json.loads(read_file(file))
                rows.append({key: row[key] for key in ("eventId", "runId", "taskId", "label", "fingerprint", "treeDigest", "stampDigest", "surface", "selection", "project", "packages")})
        target = safe(self.root, "index.json")
        with tempfile.NamedTemporaryFile(dir=self.root, suffix=".index", delete=False) as output:
            temporary = Path(output.name)
            output.write(encoded({"indexVersion": 1, "evidenceStatus": "external-claim", "adoptions": sorted(rows, key=encoded)}))
        try:
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def capture(
        self, harness, *, surface: str, run_id: str, task_id: str,
        label: str, evidence: dict[str, bytes] | None = None,
    ) -> dict:
        spec = surface_for(surface)
        if any(not isinstance(value, str) or not value for value in (run_id, task_id, label)):
            raise ValueError("run_id, task_id and label are required")
        raw = read_tree(harness, spec) if isinstance(harness, (str, Path)) else harness
        source_fingerprint = runmark.fingerprint(Path(harness)) if isinstance(harness, (str, Path)) else None
        if not isinstance(raw, dict):
            raise ValueError("harness must be a directory or a path-to-bytes mapping")
        files = {}
        spellings = {}
        for name, content in raw.items():
            name = name.replace("\\", "/")
            safe(self.root, name)
            if name in files or not ht.is_allowed(spec, name):
                raise ValueError(f"duplicate or off-surface file: {name}")
            parts = name.split("/")
            for i in range(1, len(parts) + 1):
                prefix = "/".join(parts[:i])
                if spellings.get(prefix.lower(), prefix) != prefix:
                    raise ValueError(f"case collision: {name}")
                spellings[prefix.lower()] = prefix
            files[name] = content.encode("utf-8") if isinstance(content, str) else content
            if not isinstance(files[name], bytes):
                raise ValueError(f"expected text or bytes: {name}")
        if not any(name in files for name in spec.always_on):
            raise ValueError("harness lacks always-on instructions")
        ht.validate(spec, {name: content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") for name, content in files.items()})
        skill_prefix = spec.skill_dir + "/"
        for name in files:
            if name.startswith(skill_prefix) and f"{skill_prefix}{name[len(skill_prefix):].split('/')[0]}/SKILL.md" not in files:
                raise ValueError(f"orphan skill companion: {name}")
        claims = {name: {"encoding": "base64", "data": base64.b64encode(content).decode("ascii")} for name, content in (evidence or {}).items()}
        tree_digest = digest(files)
        selection = {"model": self.model, "role": self.role, "host": surface}
        with self.writer(), tempfile.TemporaryDirectory(prefix="capture-", dir=self.root) as temporary:
            work = Path(temporary)
            project = work / "project"
            project.mkdir()
            tree_dir = work / "tree"
            tree_dir.mkdir()
            for name, content in files.items():
                file = safe(tree_dir, name)
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(content)
            fingerprint = source_fingerprint if source_fingerprint is not None else runmark.fingerprint(tree_dir)
            packages = {}
            source_map = {}

            def package(component: str, members: dict[str, bytes], entrypoint: str, kind: str = "instruction", dependencies=()):
                raw_digest = digest({**members, "capture-dependencies.json": encoded(list(dependencies))})
                # shortcut: 156-bit hash versions can collide; store rejects conflicts, use an allocator if one occurs.
                version = ".".join(str(int(raw_digest[i:i + 13], 16)) for i in (0, 13, 26))
                name = f"@{self.namespace}/{surface}-{component}"
                directory = work / "packages" / component
                directory.mkdir(parents=True)
                for relative, content in members.items():
                    file = safe(directory, relative)
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes(content)
                effects = []
                if any("scripts/" in path for path in members):
                    effects.append("commands")
                if any(path.startswith(("sub_agents/", "plugin/", ".codex/")) for path in members):
                    effects.append("host-configuration")
                (directory / "package.yaml").write_bytes(encoded({
                    "schema_version": 1,
                    "package": {"name": name, "version": version, "type": kind},
                    "entrypoint": entrypoint,
                    "behavior": {"delivery": "instruction", "hosts": [], "effects": effects},
                }))
                imported = self.command("add", f"{name}@{version}", "--source", str(directory), project=project)
                revision_file = work / f"{component}-revision.json"
                identity = {"name": name, "version": version}
                revision_file.write_bytes(encoded({
                    "revisionVersion": 1,
                    "identity": identity,
                    "kind": "release",
                    "content": {"identity": identity, "sha256": imported["sha256"]},
                    "parent": None,
                    "candidate": None,
                    "dependencies": list(dependencies),
                    "workflow": {"file": None, "provides": [], "requires": []},
                    "provenance": {
                        "kind": "legacy-adoption",
                        "workflowChange": {
                            "kind": "initial",
                            "reason": "Captured Harness2 component; caller-supplied evidence only",
                        },
                    },
                }))
                revision = self.command("revision", "record", str(revision_file), project=project)
                pin = {"name": name, "version": version, "sha256": imported["sha256"], "revisionDigest": revision["recordDigest"]}
                packages[component] = pin
                return pin

            skill_prefix = spec.skill_dir + "/"
            skill_names = ht.skill_names(spec, {name: "" for name in files})
            bindings = {}
            for name in skill_names:
                binding = name if re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) else "skill-" + hashlib.sha256(name.encode()).hexdigest()[:16]
                if binding in bindings:
                    raise ValueError("skill binding collision")
                prefix = f"{skill_prefix}{name}/"
                members = {file[len(prefix):]: content for file, content in files.items() if file.startswith(prefix)}
                bindings[binding] = package("skill-" + binding, members, "SKILL.md", "skill")
                source_map.update({prefix + name: ("skill-" + binding, name) for name in members})
            primary = next(name for name in spec.always_on if name in files)
            dependencies = []
            for name in spec.always_on:
                if name in files and name != primary:
                    component = "instruction-" + hashlib.sha256(name.encode()).hexdigest()[:16]
                    dependencies.append(package(component, {"CONTENT.md": files[name]}, "CONTENT.md"))
                    source_map[name] = (component, "CONTENT.md")
            members = {"PROMPT.md": files[primary]}
            members.update({name: content for name, content in files.items() if name not in spec.always_on and not name.startswith(skill_prefix)})
            source_map[primary] = ("profile", "PROMPT.md")
            source_map.update({name: ("profile", name) for name in members if name != "PROMPT.md"})
            profile = package("profile", members, "PROMPT.md", dependencies=sorted(dependencies, key=encoded))
            role = package("role", {"ROLE.md": b""}, "ROLE.md")
            binding = lambda pin: {"package": pin["name"], "version": pin["version"], "revision": pin["revisionDigest"]}
            config = {
                "version": 3,
                "default_profile": "harness",
                "default_role": self.role,
                "models": {self.model: {"profile": "harness"}},
                "families": {},
                "profiles": {"harness": binding(profile)},
                "roles": {
                    self.role: {
                        **binding(role),
                        "skills": {"required": [], "available": sorted(bindings)},
                    },
                },
                "skills": {name: binding(pin) for name, pin in bindings.items()},
            }
            (project / ".agent-profiles").mkdir()
            (project / ".agent-profiles/agents.yaml").write_bytes(encoded(config))
            self.command("install", "--offline", project=project)
            selectors = ["--role", self.role, "--model", self.model]
            selectors += ["--host", surface]
            stamp = self.command("stamp", *selectors, project=project)
            project_key = tree_digest + "-" + hashlib.sha256(encoded({**selection, "namespace": self.namespace})).hexdigest()[:16]
            relative_project = f"projects/{project_key}"
            final_project = safe(self.root, relative_project)
            final_project.mkdir(parents=True, exist_ok=True)
            for file in project.rglob("*"):
                if file.is_file():
                    self.immutable(f"{relative_project}/{file.relative_to(project).as_posix()}", read_file(file))
            record = {
                "captureVersion": 1,
                "evidenceStatus": "external-claim",
                "surface": surface,
                "selection": selection,
                "runId": run_id,
                "taskId": task_id,
                "label": label,
                "fingerprint": fingerprint,
                "treeDigest": tree_digest,
                "stampDigest": stamp["digest"],
                "project": str(final_project),
                "packages": packages,
                "structureOnlyRole": True,
                "components": {
                    name: {
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "bytes": len(content),
                        "packageDigest": packages[source_map[name][0]]["sha256"],
                        "packagePath": source_map[name][1],
                    }
                    for name, content in files.items()
                },
                "evidence": claims,
            }
            event_id = hashlib.sha256(encoded(record)).hexdigest()
            record["eventId"] = event_id
            self.immutable(f"adoptions/{event_id}.json", encoded(record))
            self._index()
            return record

    def seed(self, stamp: str, *, surface: str, project: Path) -> Path:
        surface_for(surface)
        if not re.fullmatch(r"[0-9a-f]{64}", stamp):
            raise ValueError("expected a full stamp digest")
        output = safe(self.root, "seeds")
        output.mkdir(exist_ok=True)
        parent = Path(tempfile.mkdtemp(prefix=f"{surface}-", dir=output))
        destination = parent / "export"
        self.command("materialize", stamp, "--adapter", "harness2-tree", "--surface", surface, "--output-root", str(parent), "--destination", str(destination), project=project)
        return destination / "content"

    def diff(self, before: dict, after: dict) -> dict:
        report = self.command("diff", before["stampDigest"], after["stampDigest"], project=self.root)
        names = sorted(set(before["components"]) | set(after["components"]))
        report["capturedComponentChanges"] = [name for name in names if before["components"].get(name, {}).get("sha256") != after["components"].get(name, {}).get("sha256")]
        report["componentMappingEvidence"] = "external-claim"
        return report

    def _rollout_record(self, run_id: str, task_id: str, identity: dict):
        record = {"evidenceStatus": "external-claim", "inputObservation": "before-execution", "runId": run_id, "taskId": task_id, **identity}
        return hashlib.sha256(run_id.encode()).hexdigest() + ".json", encoded(record)

    def reserve_rollout(self, *, run_id: str, task_id: str, identity: dict):
        name, content = self._rollout_record(run_id, task_id, identity)
        with self.writer():
            completed = safe(self.root, f"rollouts/{name}")
            if completed.exists() and read_file(completed) != content:
                raise ValueError(f"immutable capture conflict: rollouts/{name}")
            self.immutable(f"rollout-inputs/{name}", content)

    def record_rollout(self, *, run_id: str, task_id: str, identity: dict):
        name, content = self._rollout_record(run_id, task_id, identity)
        with self.writer():
            self.immutable(f"rollouts/{name}", content)
