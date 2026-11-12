import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { applyChanges } from "../src/files.ts";
import { statusSkillChanges } from "../src/status-skill.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-status-")),
	);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

test("bundled status skill installs for selected hosts, is discoverable and idempotent", (t) => {
	const root = fixture(t);
	applyChanges(
		root,
		statusSkillChanges(root, packageRoot, ["codex", "claude"]),
	);
	for (const host of [".agents", ".claude"]) {
		const file = `${host}/skills/ap-status/SKILL.md`;
		const text = fs
			.readFileSync(path.join(root, file), "utf8")
			.replace(/^\uFEFF/, "");
		const metadata = parse(text.split("---")[1]);
		assert.equal(metadata.name, "ap-status");
		assert.ok(metadata.description.includes("on the bench"));
		const ui = parse(
			fs.readFileSync(
				path.join(root, host, "skills/ap-status/agents/openai.yaml"),
				"utf8",
			),
		);
		assert.ok(ui.interface.default_prompt.includes("$ap-status"));
	}
	assert.deepEqual(
		statusSkillChanges(root, packageRoot, ["codex", "claude"]),
		[],
	);
	assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
	applyChanges(root, statusSkillChanges(root, packageRoot, null));
	assert.equal(
		fs.existsSync(path.join(root, ".agents/skills/ap-status/SKILL.md")),
		false,
	);
	assert.equal(
		fs.existsSync(path.join(root, ".agent-profiles/status-skill.json")),
		false,
	);
});

test("init collisions fail before writes; uninstall preserves user edits and unrelated files", (t) => {
	const root = fixture(t);
	applyChanges(root, statusSkillChanges(root, packageRoot, ["codex"]));
	const file = path.join(root, ".agents/skills/ap-status/SKILL.md");
	fs.appendFileSync(file, "\nUser notes\n");
	const edited = fs.readFileSync(file);
	const extra = path.join(root, ".agents/skills/ap-status/notes.md");
	fs.writeFileSync(extra, "keep");
	assert.throws(
		() => statusSkillChanges(root, packageRoot, ["claude", "codex"]),
		/was edited/,
	);
	assert.equal(fs.existsSync(path.join(root, ".claude")), false);
	applyChanges(root, statusSkillChanges(root, packageRoot, null));
	assert.deepEqual(fs.readFileSync(file), edited);
	assert.equal(fs.readFileSync(extra, "utf8"), "keep");
	assert.throws(
		() => statusSkillChanges(root, packageRoot, ["codex"]),
		/already exists/,
	);
});

test("owned unchanged files upgrade, while unowned identical files are not adopted", (t) => {
	const root = fixture(t);
	const bundle = fixture(t);
	fs.cpSync(path.join(packageRoot, "skills"), path.join(bundle, "skills"), {
		recursive: true,
	});
	applyChanges(root, statusSkillChanges(root, bundle, ["codex"]));
	fs.appendFileSync(
		path.join(bundle, "skills/ap-status/SKILL.md"),
		"\nNew release\n",
	);
	applyChanges(root, statusSkillChanges(root, bundle, ["codex"]));
	assert.match(
		fs.readFileSync(
			path.join(root, ".agents/skills/ap-status/SKILL.md"),
			"utf8",
		),
		/New release/,
	);
	fs.unlinkSync(path.join(root, ".agent-profiles/status-skill.json"));
	assert.throws(
		() => statusSkillChanges(root, bundle, ["codex"]),
		/already exists/,
	);
});

test("ownership cannot target arbitrary files and linked target directories are rejected", (t) => {
	const root = fixture(t);
	fs.mkdirSync(path.join(root, ".agent-profiles"));
	const ownership = path.join(root, ".agent-profiles/status-skill.json");
	fs.writeFileSync(ownership, JSON.stringify({ "README.md": "0".repeat(64) }));
	assert.throws(
		() => statusSkillChanges(root, packageRoot, null),
		/invalid managed skill entry/,
	);
	fs.unlinkSync(ownership);
	const outside = fixture(t);
	fs.symlinkSync(
		outside,
		path.join(root, ".agents"),
		process.platform === "win32" ? "junction" : "dir",
	);
	assert.throws(
		() => statusSkillChanges(root, packageRoot, ["codex"]),
		/linked/,
	);
	assert.deepEqual(fs.readdirSync(outside), []);
});
