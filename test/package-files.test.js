// #85: local dogfood data next to the shipped templates must never enter the npm artifact.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const npm =
	process.env.npm_execpath ??
	path.resolve(
		path.dirname(process.execPath),
		process.platform === "win32"
			? "node_modules/npm/bin/npm-cli.js"
			: "../lib/node_modules/npm/bin/npm-cli.js",
	);
const manifest = JSON.parse(
	fs.readFileSync(path.join(project, "package.json"), "utf8"),
);
const templates = manifest.files.filter((file) =>
	file.startsWith(".agent-profiles/"),
);
const sentinel = "AP-85-PRIVATE-SENTINEL";

test("package files list each shipped template explicitly", () => {
	assert.ok(templates.length > 0);
	for (const file of templates) {
		assert.ok(!/[*/]$|\*/.test(file), `${file} must name one file`);
		assert.ok(fs.statSync(path.join(project, file)).isFile(), file);
	}
	// init copies every packaged template into consumers; keep the list complete.
	assert.ok(templates.includes(".agent-profiles/agents.yaml"));
	assert.ok(templates.includes(".agent-profiles/BOOTSTRAP.md"));
});

test("npm pack excludes local data placed beside the templates", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-pack-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const put = (file, content) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	};
	put("package.json", JSON.stringify({ ...manifest, scripts: {} }));
	for (const file of templates)
		put(file, fs.readFileSync(path.join(project, file)));
	const local = [
		".agent-profiles/agents.local.yaml",
		".agent-profiles/agent-profiles.lock",
		".agent-profiles/approvals/@local/ponytail/1.0.0.sig",
		".agent-profiles/permissions.json",
		".agent-profiles/trust.yaml",
		".agent-profiles/roles/maintainer.md",
		".agent-profiles/skills/private/SKILL.md",
		".agent-profiles/store/objects/sentinel",
		"docs/../.mcp.json",
		".codex/config.toml",
	];
	for (const file of local) put(file, `${sentinel} C:/Users/private/store\n`);
	const result = spawnSync(
		process.execPath,
		[npm, "pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
		{ cwd: root, encoding: "utf8", timeout: 120000 },
	);
	assert.equal(result.status, 0, result.stderr);
	const packed = JSON.parse(result.stdout)[0].files.map((file) => file.path);
	const shipped = packed.filter((file) => file.startsWith(".agent-profiles/"));
	assert.deepEqual(shipped.sort(), [...templates].sort());
	for (const file of local)
		assert.ok(!packed.includes(path.posix.normalize(file)), file);
	for (const file of packed)
		assert.ok(
			!fs.readFileSync(path.join(root, file), "utf8").includes(sentinel),
			`${file} carries local data`,
		);
});
