import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { publishPackage } from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import {
	compareSkills,
	parseSkillSelector,
	skillCatalog,
} from "../src/skill-catalog.ts";
import { startVisualizer } from "../src/visualize.ts";

const REVIEW = "@example/security-review";
const ALT = "@example/careful-review";

function put(file, bytes) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}

function source(dir, name, version, extra = {}) {
	const directory = path.join(
		dir,
		"sources",
		name.replace(/[@/]/g, "_"),
		version,
	);
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name, version, type: "skill", description: `${name} skill` },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "SKILL.md"),
		`---\ndescription: "${name} skill"\n---\nReview ${version}\n`,
	);
	put(path.join(directory, "support/note.txt"), `note ${version}\n`);
	for (const [file, bytes] of Object.entries(extra))
		put(path.join(directory, file), bytes);
	return directory;
}

function digestTree(directory) {
	const out = {};
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const file = path.join(current, name);
			if (fs.statSync(file).isDirectory()) walk(file);
			else
				out[path.relative(directory, file)] = createHash("sha256")
					.update(fs.readFileSync(file))
					.digest("hex");
		}
	};
	walk(directory);
	return out;
}

function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-skill-catalog-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = path.join(dir, "store");
	for (const directory of [
		source(dir, REVIEW, "1.0.0"),
		source(dir, REVIEW, "2.0.0", {
			"support/icon.bin": Buffer.from([0, 1, 2, 255]),
		}),
		source(dir, ALT, "1.0.0"),
	])
		publishPackage({ storeRoot: store, sourceDirectory: directory });
	const root = path.join(dir, "project");
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	put(
		path.join(root, ".agent-profiles/skills/testing/SKILL.md"),
		"---\ndescription: Test carefully\n---\nReview 1.0.0\n",
	);
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { "fictional-large": { profile: "base" } },
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: ["security-review"], available: ["testing"] },
				},
			},
			skills: { "security-review": { package: REVIEW, version: "1.0.0" } },
		}),
	);
	installDependencies({ root, storeRoot: store });
	return { dir, store, root };
}

const LOCAL = "local:.agent-profiles/skills/testing/SKILL.md";
const pick = (value) => parseSkillSelector(value);

test("catalog lists package versions and local skills with their role usage", (t) => {
	const f = fixture(t);
	const before = digestTree(f.dir);
	const catalog = skillCatalog({ root: f.root, storeRoot: f.store });
	assert.deepEqual(catalog.problems, []);
	assert.equal("store" in catalog, false, "no local store path in the API");
	const review = catalog.packages.find((item) => item.name === REVIEW);
	assert.deepEqual(
		review.versions.map((version) => [
			version.version,
			version.usage.bindings,
			version.usage.roles,
			version.evidence,
		]),
		[
			["2.0.0", [], [], 0],
			[
				"1.0.0",
				["skills.security-review"],
				[{ skill: "security-review", role: "reviewer", list: "required" }],
				0,
			],
		],
	);
	assert.match(review.versions[0].sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(
		catalog.local.map((skill) => [skill.id, skill.version, skill.usage.roles]),
		[["testing", null, [{ role: "reviewer", list: "available" }]]],
	);
	// Browsing never writes the store, configuration, lock, or skills.
	assert.deepEqual(digestTree(f.dir), before);
});

test("comparing two versions shows supporting and binary file changes", (t) => {
	const f = fixture(t);
	const result = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${REVIEW}@2.0.0`),
	});
	assert.equal(result.identical, false);
	assert.deepEqual(
		result.files.map((file) => [file.path, file.status, file.diff === null]),
		[
			["SKILL.md", "changed", false],
			["package.yaml", "changed", false],
			["support/icon.bin", "added", true],
			["support/note.txt", "changed", false],
		],
	);
	assert.match(
		result.files[0].diff,
		new RegExp(`--- ${REVIEW}@1\\.0\\.0/SKILL\\.md`),
	);
	assert.deepEqual(
		result.right.files.find((file) => file.path === "support/icon.bin"),
		{
			path: "support/icon.bin",
			bytes: 4,
			sha256: createHash("sha256")
				.update(Buffer.from([0, 1, 2, 255]))
				.digest("hex"),
			binary: true,
		},
	);
	assert.notEqual(result.left.sha256, result.right.sha256);
	for (const side of [result.left, result.right])
		assert.deepEqual(side.evidence, { status: "untested", rows: [] });
	assert.deepEqual(result.left.usage.roles, [
		{ skill: "security-review", role: "reviewer", list: "required" },
	]);
	assert.deepEqual(result.right.usage.bindings, []);
});

test("differently named packages and local skills compare with explicit unknowns", (t) => {
	const f = fixture(t);
	const named = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${ALT}@1.0.0`),
	});
	assert.equal(named.left.name, REVIEW);
	assert.equal(named.right.name, ALT);
	assert.deepEqual(
		named.files.map((file) => file.path),
		["SKILL.md", "package.yaml"],
	);

	const local = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(LOCAL),
		right: pick(`package:${REVIEW}@1.0.0`),
	});
	assert.deepEqual(
		[local.left.kind, local.left.name, local.left.version, local.left.sha256],
		["local", "testing", null, null],
	);
	assert.deepEqual(local.left.usage.roles, [
		{ role: "reviewer", list: "available" },
	]);
	assert.deepEqual(local.left.evidence, { status: "untested", rows: [] });
	assert.deepEqual(
		local.files.map((file) => [file.path, file.status]),
		[
			["SKILL.md", "changed"],
			["package.yaml", "added"],
			["support/note.txt", "added"],
		],
	);

	const same = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(LOCAL),
		right: pick(LOCAL),
	});
	assert.equal(same.identical, true);
});

test("selectors reject malformed values and files that are not discovered skills", (t) => {
	const f = fixture(t);
	for (const value of ["", "package:", `package:${REVIEW}`, "local:", "x:y"])
		assert.throws(() => pick(value), /expected package:<name>@<version>/);
	assert.deepEqual(pick(`package:${REVIEW}@1.0.0`), {
		kind: "package",
		name: REVIEW,
		version: "1.0.0",
	});
	const compare = (left, right = LOCAL) =>
		compareSkills({
			root: f.root,
			storeRoot: f.store,
			left: pick(left),
			right: pick(right),
		});
	assert.throws(
		() => compare("local:.agent-profiles/agents.yaml"),
		/not a discovered project-local skill/,
	);
	assert.throws(
		() => compare("local:../outside/SKILL.md"),
		/not a discovered project-local skill/,
	);
	assert.throws(() => compare(`package:${REVIEW}@9.9.9`), /not in the library/);
});

function get(url) {
	return new Promise((resolve, reject) => {
		request(url, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () =>
				resolve({ status: response.statusCode, body: JSON.parse(body) }),
			);
		})
			.on("error", reject)
			.end();
	});
}

test("the visualizer serves the catalog and comparisons read-only", async (t) => {
	const f = fixture(t);
	const app = await startVisualizer({ root: f.root, storeRoot: f.store });
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const catalog = await get(`${app.url}api/skills`);
	assert.equal(catalog.status, 200);
	assert.deepEqual(
		catalog.body.packages.map((item) => item.name),
		[ALT, REVIEW],
	);
	const query = new URLSearchParams({
		left: `package:${REVIEW}@1.0.0`,
		right: LOCAL,
	});
	const compared = await get(`${app.url}api/compare?${query}`);
	assert.equal(compared.status, 200);
	assert.equal(compared.body.right.kind, "local");
	for (const [suffix, message] of [
		["api/skills?x=1", /takes no parameters/],
		[`api/compare?left=${encodeURIComponent(LOCAL)}`, /exactly one right/],
		[`api/compare?${query}&store=elsewhere`, /Unknown parameter: store/],
	]) {
		const response = await get(`${app.url}${suffix}`);
		assert.equal(response.status, 400);
		assert.match(response.body.error, message);
	}
});
