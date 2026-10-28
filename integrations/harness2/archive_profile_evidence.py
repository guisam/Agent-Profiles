"""Archive a portable, selected profile configuration beside an existing rollout.

This performs offline file/store checks only; it never invokes a model or restores
over an active project. The native stamp remains the authoritative provenance.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identifier(value):
    if (not isinstance(value, str) or value in (".", "..")
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", value)):
        raise ValueError("unsafe instruction identifier")
    return value


def backing_bytes(store, entry):
    backing = entry["backing"]
    checksum = backing["sha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("invalid backing digest")
    if backing["type"] == "blob":
        base = store / "blobs/sha256"
        target = base / checksum
    elif backing["type"] == "package":
        base = store / "objects/sha256" / checksum / "tree"
        target = base / backing["path"]
    else:
        raise ValueError("unsupported backing type")
    if (not target.resolve().is_relative_to(base.resolve())
            or target.is_symlink() or target.is_junction()
            or not target.is_file()):
        raise ValueError("unsafe or missing backing file")
    data = target.read_bytes()
    if backing["type"] == "blob" and digest(data) != checksum:
        raise ValueError("changed blob")
    if entry.get("resources"):
        raise ValueError("resource trees require the native materializer; refusing a partial archive")
    return data


def portable(snapshot, store):
    selection = snapshot["selection"]
    model = selection["identity"]["canonical"]
    profile, role = identifier(selection["profile"]), identifier(selection["role"])
    parts = {entry["kind"]: entry for entry in snapshot["composition"]
             if entry["kind"] in ("profile", "role")}
    required, available = snapshot["required"], snapshot["available"]
    data = {}
    for kind, name in [("profile", profile), ("role", role)]:
        if kind not in parts:
            raise ValueError("missing instruction component")
        data[f"{kind}s/{name}.md"] = backing_bytes(store, parts[kind])
    skills = []
    for mode, entries in [("required", required), ("available", available)]:
        for entry in entries:
            if entry.get("type") != "instruction" or entry.get("hostReference"):
                raise ValueError("host-native skills cannot be reconstructed as local instructions")
            name = identifier(entry["id"])
            relative = f"skills/{name}/SKILL.md"
            data[relative] = backing_bytes(store, entry)
            skills.append({"id": name, "association": mode,
                           "contentSha256": digest(data[relative]),
                           "package": entry.get("package"), "file": relative})
    q = json.dumps
    lines = ["# Portable reconstruction from the retained native stamp.",
             "# Exact retained project YAML is archived separately when available.",
             "version: 1", f"default_profile: {q(profile)}", f"default_role: {q(role)}",
             "models:", f"  {q(model)}:", f"    profile: {q(profile)}",
             "families: {}",
             "roles:", f"  {q(role)}:", f"    file: {q('roles/' + role + '.md')}",
             "    skills:", "      required: " + q([e["id"] for e in required]),
             "      available: " + q([e["id"] for e in available])]
    if skills:
        lines.append("skills:")
        for skill in skills:
            lines.extend([f"  {q(skill['id'])}:", f"    file: {q('.agent-profiles/' + skill['file'])}"])
    return ("\n".join(lines) + "\n").encode(), data, skills


def archive(run, store, stamp, source_config=None, node="node"):
    run, store = Path(run).resolve(), Path(store).resolve()
    if not re.fullmatch(r"[0-9a-f]{64}", stamp):
        raise ValueError("invalid stamp")
    target = run / "profile-evidence"
    if target.exists() or (run / "agent-profile.yaml").exists():
        raise ValueError("evidence already exists; refusing to overwrite history")
    command = json.loads((run / "command.json").read_text(encoding="utf-8-sig"))
    verification = json.loads(subprocess.check_output([
        node, str(REPO / "bin/agent-profiles.ts"), "verify", stamp,
        "--store", str(store), "--json"], text=True, encoding="utf-8"))
    if verification.get("managedReproducible") is not True:
        raise ValueError("native stamp is not managed-reproducible")
    raw = (store / "stamps/sha256" / stamp / "snapshot.json").read_bytes()
    snapshot = json.loads(raw)
    yaml, bodies, skills = portable(snapshot, store)
    # Validate the referenced instruction bytes before creating the archive.
    source = Path(source_config).read_bytes() if source_config else None
    config = target / "project/.agent-profiles/agents.yaml"
    config.parent.mkdir(parents=True)
    config.write_bytes(yaml)
    for relative, content in bodies.items():
        path = config.parent / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (target / "native-stamp.json").write_bytes(raw)
    (target / "native-verification.json").write_text(
        json.dumps(verification, indent=2) + "\n", encoding="utf-8")
    (run / "agent-profile.yaml").write_bytes(yaml)
    if source is not None:
        (target / "retained-source-agents.yaml").write_bytes(source)
    runtime = []
    for name in ["AGENTS.md", *[".agents/" + skill["file"] for skill in skills]]:
        path = run / "workspace" / name
        if path.is_file() and not path.is_symlink() and not path.is_junction():
            dest = target / "retained-native" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
            runtime.append({"path": name, "sha256": digest(dest.read_bytes())})
    args = command["argv"]
    effort = next((arg for arg in args if arg.startswith("model_reasoning_effort=")), None)
    manifest = {"stampDigest": stamp, "selection": snapshot["selection"],
                "configurationStatus": "portable-reconstruction-from-verified-stamp",
                "retainedSourceStatus": "post-run-retained-project-copy" if source else "unavailable",
                "configurationSha256": digest(yaml), "skills": skills,
                "runtimeSettings": {"reasoningEffortArgument": effort,
                                    "timeoutSeconds": command["timeoutSeconds"]},
                "retainedNative": runtime,
                "files": {p.relative_to(target).as_posix(): digest(p.read_bytes())
                          for p in target.rglob("*") if p.is_file()}}
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    rows = [f"| {s['id']} | {s['association']} | {(s['package'] or {}).get('version', 'local file')} | `{s['contentSha256']}` |"
            for s in skills]
    (target / "README.md").write_text(
        "# Run profile evidence\n\n"
        f"Model: `{snapshot['selection']['identity']['canonical']}`; role: `{snapshot['selection']['role']}`.\n\n"
        f"Native stamp: `{stamp}`.\n\n"
        "[Profile YAML](../agent-profile.yaml) · [Manifest](manifest.json) · [Native stamp](native-stamp.json)\n\n"
        "| Skill | Association | Version | Content SHA-256 |\n| --- | --- | --- | --- |\n" + "\n".join(rows) +
        "\n\nThe YAML is reconstructed from immutable selected instruction bytes, not guessed from prompts. "
        "The retained source YAML is a separate post-run project copy; candidate previews may have overlaid its bindings. "
        "Required/available associations and original package identities are preserved in the manifest.\n\n"
        "## Restore safely\n\nCopy `project/.agent-profiles` into a NEW empty project, then resolve the recorded model and role. "
        "Compare its selected content hashes with the manifest before use. Review a merge into an existing project; "
        "do not overwrite live configuration blindly. This portable v1 configuration restores selected instruction bodies, "
        "not original package locks, migration history, host permissions or runtime model state. "
        "Keep the original store/stamp and retained native files for exact provenance. No restore was applied to a live project.\n",
        encoding="utf-8")
    return manifest


def self_check():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        data = b"instruction\n"
        checksum = digest(data)
        path = root / "blobs/sha256" / checksum
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
        entry = {"backing": {"type": "blob", "sha256": checksum}}
        assert backing_bytes(root, entry) == data
        path.write_bytes(b"changed")
        try:
            backing_bytes(root, entry)
        except ValueError:
            pass
        else:
            raise AssertionError("changed blob admitted")
        for value in ("../escape", ".."):
            try:
                identifier(value)
            except ValueError:
                pass
            else:
                raise AssertionError("unsafe path admitted")
        def entry(content, kind, name):
            checksum = digest(content)
            (root / "blobs/sha256" / checksum).write_bytes(content)
            return {"kind": kind, "id": name, "resources": [],
                    "backing": {"type": "blob", "sha256": checksum}}
        skill = entry(b"---\nname: archive-check\ndescription: Check archival round trips.\n---\nVerify the supplied evidence.\n", "required-skill", "archive-check")
        skill["type"] = "instruction"
        snapshot = {"selection": {"identity": {"canonical": "archive-check-model"},
                                  "profile": "archived", "role": "reviewer"},
                    "composition": [entry(b"Check evidence.\n", "profile", "archived"),
                                    entry(b"Review the requested task.\n", "role", "reviewer")],
                    "required": [skill], "available": []}
        yaml, bodies, _ = portable(snapshot, root)
        project = root / "restored"
        folder = project / ".agent-profiles"
        folder.mkdir(parents=True)
        (folder / "agents.yaml").write_bytes(yaml)
        for relative, data in bodies.items():
            path = folder / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        result = json.loads(subprocess.check_output([
            "node", str(REPO / "bin/agent-profiles.ts"), "resolve", "--root", str(project),
            "--model", "archive-check-model", "--role", "reviewer", "--json"],
            text=True, encoding="utf-8"))
        assert result["profile"] == "archived"
        assert [s["id"] for s in result["required"]] == ["archive-check"]
    print("PASS: backing integrity, identifier boundaries and real resolver round trip")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--store", type=Path)
    parser.add_argument("--stamp")
    parser.add_argument("--source-config", type=Path)
    parser.add_argument("--self-check", action="store_true")
    options = parser.parse_args()
    if options.self_check:
        self_check()
    else:
        if not all([options.run, options.store, options.stamp]):
            parser.error("--run, --store and --stamp are required")
        archive(options.run, options.store, options.stamp, options.source_config)
