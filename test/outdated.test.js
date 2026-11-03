import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { publishPackage } from "../src/library.ts";
import * as migrations from "../src/migrations.ts";
import {
	applyUpdate,
	formatOutdated,
	formatUpdate,
	outdatedPins,
	previewUpdate,
} from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { resolveInstructions } from "../src/resolve.ts";
import {
	decision,
	fixture as promotionFixture,
	put,
	release,
	scope,
	versions as v3Versions,
	writeDecision,
} from "./helpers/promotion-fixture.js";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const NAME = "@example/security-review";
const BINDING = "skills.security-review";
const SMALL = { role: "reviewer", model: "fictional-small", host: "codex" };
const LARGE = { role: "reviewer", model: "fictional-large", host: "codex" };

function source(dir, version) {
	const directory = path.join(dir, "sources", version);
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: {
				name: NAME,
				version,
				type: "skill",
				description: "Review fictional changes for security defects.",
			},
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "SKILL.md"),
		`---\ndescription: Review security.\n---\nReview ${version}.\n`,
	);
	return directory;
}

// A v2 project: a shared default (1.0.0) and a rule for the large model (2.0.0);
// the library also holds 3.0.0.
function v2(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-outdated-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	const store = path.join(dir, "store");
	for (const version of ["1.0.0", "2.0.0", "3.0.0"])
		publishPackage({ storeRoot: store, sourceDirectory: source(dir, version) });
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		`# Kept across updates.\n${stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: {
				"fictional-small": { profile: "base" },
				"fictional-large": { profile: "base" },
			},
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: ["security-review"], available: [] },
				},
			},
			skills: { "security-review": { package: NAME, version: "1.0.0" } },
			assignments: {
				"large-review": {
					when: { model: "fictional-large", role: "reviewer" },
					versions: { [BINDING]: "2.0.0" },
				},
			},
		})}`,
	);
	installDependencies({ root, storeRoot: store });
	return { dir, root, store };
}

function tree(directory) {
	const out = {};
	if (!fs.existsSync(directory)) return out;
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const file = path.join(current, name);
			if (fs.lstatSync(file).isDirectory()) walk(file);
			else
				out[path.relative(directory, file)] = createHash("sha256")
					.update(fs.readFileSync(file))
					.digest("hex");
		}
	};
	walk(directory);
	return out;
}

const selectedVersion = (f, tuple) =>
	resolveInstructions({
		root: f.root,
		storeRoot: f.store ?? f.storeRoot,
		...tuple,
	}).required.find((skill) => skill.package)?.package.version;

test("outdated lists each pin, the tuples it serves, newer versions and evidence", (t) => {
	const f = v2(t);
	const result = outdatedPins({ root: f.root, storeRoot: f.store });
	assert.equal(result.lockState, "valid");
	assert.equal(result.configurationVersion, 2);
	const byRule = Object.fromEntries(
		result.pins.map((pin) => [pin.rule ?? "default", pin]),
	);
	assert.deepEqual(Object.keys(byRule).sort(), ["default", "large-review"]);
	assert.deepEqual(byRule.default.serves, [
		{ role: "reviewer", model: "fictional-small", host: null },
	]);
	assert.deepEqual(byRule["large-review"].serves, [
		{ role: "reviewer", model: "fictional-large", host: null },
	]);
	assert.deepEqual(
		byRule.default.newer.map((n) => [n.version, n.major, n.pinnable]),
		[
			["3.0.0", true, true],
			["2.0.0", true, true],
		],
	);
	assert.deepEqual(
		byRule["large-review"].newer.map((n) => [n.version, n.major]),
		[["3.0.0", true]],
	);
	assert.deepEqual(byRule.default.newer[0].evidence[0].rows, []);
	assert.equal(result.outdated, 2);
	const text = formatOutdated(result);
	assert.match(
		text,
		/skills\.security-review at the default: @example\/security-review@1\.0\.0/,
	);
	assert.match(
		text,
		/Newer: 3\.0\.0 \(major\)\n {4}reviewer × fictional-small: untested/,
	);

	const filtered = outdatedPins({
		root: f.root,
		storeRoot: f.store,
		filter: { model: "fictional-large" },
	});
	assert.deepEqual(
		filtered.pins.map((pin) => pin.rule),
		["large-review"],
	);
});

test("update previews without writing and changes exactly the target tuple", (t) => {
	const f = v2(t);
	const before = [f.root, f.store].map(tree);
	const preview = previewUpdate({
		root: f.root,
		storeRoot: f.store,
		binding: BINDING,
		version: "3.0.0",
		assignment: SMALL,
	});
	assert.equal(preview.status, "preview");
	assert.equal(preview.rule.action, "add");
	assert.deepEqual(preview.rule.when, SMALL);
	assert.match(preview.rule.id, /^update-[0-9a-f]{16}$/);
	assert.deepEqual(preview.changed, [
		{
			tuple: SMALL,
			binding: BINDING,
			from: `${NAME}@1.0.0`,
			to: `${NAME}@3.0.0`,
		},
	]);
	assert.deepEqual(preview.evidence, []);
	assert.match(preview.previewDigest, /^[0-9a-f]{64}$/);
	assert.match(
		formatUpdate(preview),
		/Preview \(nothing written\)[\s\S]*--apply --expect [0-9a-f]{64}/,
	);
	assert.deepEqual([f.root, f.store].map(tree), before);
});

test("update --apply edits one rule, keeps comments, refreshes the lock and stamps", (t) => {
	const f = v2(t);
	const input = {
		root: f.root,
		storeRoot: f.store,
		binding: BINDING,
		version: "3.0.0",
		assignment: SMALL,
	};
	const { previewDigest } = previewUpdate(input);
	const applied = applyUpdate({ ...input, expect: previewDigest });
	assert.equal(applied.status, "updated");
	assert.match(applied.stampDigest, /^[0-9a-f]{64}$/);
	const text = fs.readFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
		"utf8",
	);
	assert.ok(text.startsWith("# Kept across updates.\n"), text);
	const config = parse(text);
	assert.deepEqual(config.assignments[applied.rule.id], {
		when: SMALL,
		versions: { [BINDING]: "3.0.0" },
	});
	assert.equal(config.skills["security-review"].version, "1.0.0");
	assert.equal(selectedVersion(f, SMALL), "3.0.0");
	assert.equal(
		selectedVersion(f, { role: "reviewer", model: "fictional-small" }),
		"1.0.0",
	);
	assert.equal(selectedVersion(f, LARGE), "2.0.0");
	assert.equal(
		outdatedPins({ root: f.root, storeRoot: f.store }).lockState,
		"valid",
	);

	// The added rule now pins the exact tuple, so the next update replaces it in place.
	const again = applyUpdate({ ...input, version: "2.0.0" });
	assert.equal(again.rule.action, "replace");
	assert.equal(again.rule.id, applied.rule.id);
	assert.equal(selectedVersion(f, SMALL), "2.0.0");
});

test("already pinned is reported without writing", (t) => {
	const f = v2(t);
	const before = [f.root, f.store].map(tree);
	const result = applyUpdate({
		root: f.root,
		storeRoot: f.store,
		binding: BINDING,
		version: "2.0.0",
		assignment: LARGE,
	});
	assert.equal(result.status, "already-pinned");
	assert.match(
		formatUpdate(result),
		/already selects @example\/security-review@2\.0\.0; nothing to do/,
	);
	assert.deepEqual([f.root, f.store].map(tree), before);
});

test("update refusals leave the project and store unchanged", (t) => {
	const f = v2(t);
	const input = {
		root: f.root,
		storeRoot: f.store,
		binding: BINDING,
		version: "3.0.0",
		assignment: SMALL,
	};
	const { previewDigest } = previewUpdate(input);
	const before = [f.root, f.store].map(tree);
	for (const [change, message] of [
		[{ version: "9.9.9" }, /9\.9\.9: not in the library/],
		[{ assignment: { ...SMALL, host: "" } }, /--host is required/],
		[{ binding: "skills.absent" }, /skills\.absent is not selected/],
		[
			{ requireEvidence: true },
			/--require-evidence: .* has no promoted evidence/,
		],
		[{ expect: "0".repeat(64) }, /changed since the preview/],
	])
		assert.throws(() => applyUpdate({ ...input, ...change }), message);
	assert.deepEqual([f.root, f.store].map(tree), before);

	// A configuration edit between preview and apply is refused by the preview digest.
	const config = path.join(f.root, ".agent-profiles/agents.yaml");
	fs.appendFileSync(config, "# edited after the preview\n");
	assert.throws(
		() => applyUpdate({ ...input, expect: previewDigest }),
		/changed since the preview/,
	);
});

test("v3: newer versions need a release label; update pins the revision", (t) => {
	const f = promotionFixture(t);
	// An imported-only version cannot be pinned in v3.
	const unlabeled = path.join(f.dir, "unlabeled");
	put(
		path.join(unlabeled, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: release.name, version: "9.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(path.join(unlabeled, "SKILL.md"), "---\ndescription: x\n---\nx\n");
	importPackage({ sourceDirectory: unlabeled, storeRoot: f.storeRoot });

	const result = outdatedPins({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(result.configurationVersion, 3);
	const pin = result.pins.find((p) => p.rule === "worker-0");
	assert.equal(pin.version, v3Versions[0]);
	const nine = pin.newer.find((n) => n.version === "9.0.0");
	assert.equal(nine.pinnable, false);
	assert.equal(nine.reason, "needs revision record");
	const adopted = pin.newer.find((n) => n.version === v3Versions[2]);
	assert.equal(adopted.source, "adopted");
	assert.equal(adopted.pinnable, true);
	assert.match(
		formatOutdated(result),
		/Newer: 9\.0\.0 \(major\); needs revision record/,
	);

	const opus = { role: "worker", model: "opus", host: "claude" };
	assert.throws(
		() =>
			previewUpdate({
				root: f.root,
				storeRoot: f.storeRoot,
				binding: "skills.reviewer",
				version: "9.0.0",
				assignment: opus,
			}),
		/has no release label; configuration v3 pins a revision/,
	);
	const applied = applyUpdate({
		root: f.root,
		storeRoot: f.storeRoot,
		binding: "skills.reviewer",
		version: v3Versions[2],
		assignment: opus,
	});
	assert.equal(applied.status, "updated");
	// worker-1 already pins exactly opus × worker × claude, so it is replaced in place.
	assert.deepEqual(applied.rule, {
		id: "worker-1",
		when: opus,
		action: "replace",
	});
	const config = parse(fs.readFileSync(f.configFile, "utf8"));
	assert.deepEqual(config.assignments["worker-1"].bindings["skills.reviewer"], {
		package: release.name,
		version: v3Versions[2],
		revision: f.records.get(v3Versions[2]).recordDigest,
	});
	assert.equal(
		config.assignments["worker-0"].bindings["skills.reviewer"].version,
		v3Versions[0],
	);
});

test("v3: after promotion, update reports the promoted tuple as already pinned and shows its evidence", (t) => {
	const f = promotionFixture(t);
	writeDecision(f, decision(f));
	migrations.applyMigrationPromotion({
		root: f.root,
		storeRoot: f.storeRoot,
		decisionFile: f.decisionFile,
	});
	const result = previewUpdate({
		root: f.root,
		storeRoot: f.storeRoot,
		binding: "skills.reviewer",
		version: release.version,
		assignment: scope,
	});
	assert.equal(result.status, "already-pinned");
	assert.deepEqual(
		result.evidence.map((row) => [row.outcome, row.origin]),
		[["promoted", "evaluated here"]],
	);
	// For another model, the promoted version is newer, with evidence for local-llm only.
	const outdated = outdatedPins({
		root: f.root,
		storeRoot: f.storeRoot,
		filter: { model: "opus" },
	});
	const promoted = outdated.pins[0].newer.find(
		(n) => n.version === release.version,
	);
	assert.equal(promoted.source, "promoted");
	assert.deepEqual(promoted.evidence[0].rows, []);
});

test("CLI: outdated and update print text and JSON and validate options", (t) => {
	const f = v2(t);
	const run = (...args) =>
		spawnSync(
			process.execPath,
			[cli, ...args, "--root", f.root, "--store", f.store],
			{
				encoding: "utf8",
			},
		);
	const outdated = run("outdated");
	assert.equal(outdated.status, 0, outdated.stderr);
	assert.match(outdated.stdout, /2 pins with newer versions/);
	const target = [
		"--model",
		SMALL.model,
		"--role",
		SMALL.role,
		"--host",
		SMALL.host,
	];
	const preview = run("update", BINDING, "3.0.0", ...target, "--json");
	assert.equal(preview.status, 0, preview.stderr);
	const { previewDigest, status } = JSON.parse(preview.stdout);
	assert.equal(status, "preview");
	const applied = run(
		"update",
		BINDING,
		"3.0.0",
		...target,
		"--apply",
		"--expect",
		previewDigest,
	);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(
		applied.stdout,
		/^Updated: skills\.security-review for reviewer × fictional-small × codex/,
	);
	for (const [args, message] of [
		[["outdated", "extra"], /Usage: agent-profiles outdated/],
		[["update", BINDING], /Usage: agent-profiles update/],
		[["outdated", "--apply"], /--apply is not supported by outdated/],
		[
			["update", BINDING, "3.0.0", ...target, "--expect", "x"],
			/--expect is only supported with --apply/,
		],
		[
			[
				"update",
				BINDING,
				"3.0.0",
				"--model",
				"m",
				"--role",
				"a",
				"--role",
				"b",
				"--host",
				"h",
			],
			/accepts one --role/,
		],
	]) {
		const result = run(...args);
		assert.equal(result.status, 1, args.join(" "));
		assert.match(result.stderr, message, args.join(" "));
	}
});
