import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyPresetImport, planPresetImport } from "../src/presets.ts";
import { resolveInstructions } from "../src/resolve.ts";

test("Ponytail preset imports without private dependencies and confines skills to roles", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-ponytail-preset-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = fileURLToPath(
		new URL("../examples/presets/ponytail", import.meta.url),
	);
	const config = path.join(root, ".agent-profiles");
	fs.mkdirSync(path.join(config, "profiles"), { recursive: true });
	fs.writeFileSync(
		path.join(config, "profiles/base.md"),
		"Keep local project authority.\n",
	);
	fs.writeFileSync(
		path.join(config, "agents.yaml"),
		"version: 1\ndefault_profile: base\ndefault_role: local\nmodels: {}\nfamilies: {}\nroles:\n  local:\n    file: profiles/base.md\n    skills:\n      required: []\n      available: []\n",
	);
	const plan = planPresetImport({ root, source });
	assert.equal(plan.ready, true, JSON.stringify(plan.errors));
	applyPresetImport(plan, true);
	assert.equal(resolveInstructions({ root }).profile, "base");
	const expected = {
		"ponytail-implementer": "ponytail-implementation",
		"ponytail-reviewer": "ponytail-review",
		"ponytail-auditor": "ponytail-audit",
		"ponytail-maintainer": "ponytail-debt",
	};
	for (const host of ["claude", "codex"])
		for (const [role, skill] of Object.entries(expected)) {
			const resolved = resolveInstructions({
				root,
				host,
				role,
				model: "unmapped-model",
			});
			assert.deepEqual(
				resolved.required.map((entry) => entry.id),
				[skill],
			);
			assert.ok(
				resolved.loaded.some(
					(entry) =>
						entry.content.trim() ===
						fs
							.readFileSync(
								path.join(source, "skills", skill, "SKILL.md"),
								"utf8",
							)
							.trim(),
				),
			);
			assert.ok(resolved.required.every((entry) => !entry.package));
		}
	// The documented fresh-project configuration must work independently of import.
	fs.copyFileSync(
		path.join(source, "agents.yaml"),
		path.join(config, "agents.yaml"),
	);
	const standalone = resolveInstructions({ root });
	assert.equal(standalone.profile, "ponytail-base");
	assert.equal(standalone.role, "ponytail-implementer");
});
