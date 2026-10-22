import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { parse, stringify } from "yaml";
import { applyRoleChange, planRoleChange } from "../src/configure.ts";
import { formatProof, resolutionOutput } from "../src/diagnostics.ts";
import { inspectRepository } from "../src/inspect.ts";
import { doctor } from "../src/install.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import {
	applyPresetExport,
	applyPresetImport,
	planPresetExport,
	planPresetImport,
} from "../src/presets.ts";
import { parseYaml, resolveInstructions } from "../src/resolve.ts";
import { discoverSkills } from "../src/skills.ts";
import { startVisualizer } from "../src/visualize.ts";
import { configureRoles } from "../src/wizard.ts";

// P4 slice 2 (docs/development/issue-20-p4-handoff.md section 6, contract section 9): caller integration.
// Every test gets a fresh explicit store, a fake HOME, and AGENT_PROFILES_STORE naming an empty store (or a
// misleading one), so a dropped storeRoot is observable. fixtureCheck proves each fixture with the accepted
// resolver before any caller runs, so caller failures are attributable. storeRoot travels in caller options
// and, like sourceOptions, inside the plans that apply* functions receive.

const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), "p4-callers-")));
after(() => rmSync(WORK, { recursive: true, force: true }));

function put(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}
function fingerprint(dir) {
	if (!existsSync(dir)) return null;
	return readdirSync(dir, { recursive: true })
		.map((file) => String(file).split(path.sep).join("/"))
		.sort()
		.map((file) => {
			const full = path.join(dir, file);
			return statSync(full).isDirectory()
				? `${file}/`
				: `${file} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
		});
}
const json = (value) => JSON.parse(JSON.stringify(value));
const without = (list, ...files) =>
	list.filter((line) => !files.some((file) => line.startsWith(`${file} `)));
function ok(fn, label) {
	let value;
	assert.doesNotThrow(() => {
		value = fn();
	}, label);
	return value;
}
// A refusal must come from the guard under test, never from a dropped storeRoot.
function refuses(fn, ...patterns) {
	assert.throws(fn, (error) => {
		assert.doesNotMatch(
			error.message,
			/missing-package/,
			`refusal came from a dropped storeRoot: ${error.message}`,
		);
		for (const pattern of patterns) assert.match(error.message, pattern);
		return true;
	});
}

// ---- package fixtures, imported through the existing store API ----
const SR = "@example/security-review";
function fixture(name, version, type, entrypoint, files) {
	const manifest =
		`schema_version: 1\npackage:\n  name: "${name}"\n  version: "${version}"\n  type: ${type}\nentrypoint: ${entrypoint}\n` +
		"behavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n";
	return { "package.yaml": manifest, ...files };
}
const FIXTURES = {
	"security-review@1.0.0": fixture(SR, "1.0.0", "skill", "SKILL.md", {
		"SKILL.md":
			"---\ndescription: Security review one.\n---\nCheck inputs, revision one.\n",
	}),
	"security-review@2.0.0": fixture(SR, "2.0.0", "skill", "SKILL.md", {
		"SKILL.md":
			"---\ndescription: Security review two.\n---\nCheck inputs and outputs, revision two.\n",
	}),
	"auditor-role@1.0.0": fixture(
		"@example/auditor-role",
		"1.0.0",
		"instruction",
		"role.md",
		{ "role.md": "# Auditor 1.0.0\nAudit releases.\n" },
	),
	"autonomous-profile@1.0.0": fixture(
		"@example/autonomous-profile",
		"1.0.0",
		"instruction",
		"profile.md",
		{ "profile.md": "# Autonomous\nWork independently.\n" },
	),
};
const ALL = Object.keys(FIXTURES);
// Same identities, different bytes: a store that silently wins when storeRoot is dropped.
const MISLEADING = {
	"security-review@1.0.0": {
		...FIXTURES["security-review@1.0.0"],
		"SKILL.md":
			"---\ndescription: Ambient one.\n---\nAmbient store body one.\n",
	},
	"security-review@2.0.0": {
		...FIXTURES["security-review@2.0.0"],
		"SKILL.md":
			"---\ndescription: Ambient two.\n---\nAmbient store body two.\n",
	},
};

function buildStore(dir, name, keys = ALL, variants = {}) {
	const root = path.join(dir, name);
	const imports = {};
	for (const key of keys) {
		const source = path.join(dir, `${name}-sources`, key);
		for (const [file, text] of Object.entries(variants[key] ?? FIXTURES[key]))
			put(path.join(source, file), text);
		imports[key] = importPackage({ sourceDirectory: source, storeRoot: root });
	}
	return { root, imports };
}

// ---- repository fixtures ----
const LOCAL = {
	"profiles/constrained.md": "# Constrained\nTake small verified steps.\n",
	"profiles/scaffolded.md": "# Scaffolded\nFollow explicit checklists.\n",
	"roles/reviewer.md": "# Reviewer\nReview changes for defects.\n",
	"roles/writer.md": "# Writer\nWrite documentation.\n",
};
const routing = () => ({
	default_profile: "constrained",
	default_role: "reviewer",
	models: {
		"example-large": {
			profile: "autonomous",
			aliases: ["example-large-alias"],
		},
		"example-small": { profile: "scaffolded" },
	},
	families: {
		example: { profile: "scaffolded", match: { prefixes: ["example-"] } },
	},
});
const callerConfig = () => ({
	version: 2,
	...routing(),
	roles: {
		reviewer: {
			file: "roles/reviewer.md",
			description: "Review changes",
			skills: { required: ["security-review"], available: [] },
		},
		auditor: {
			package: "@example/auditor-role",
			version: "1.0.0",
			skills: { required: [], available: ["security-review"] },
		},
		writer: {
			file: "roles/writer.md",
			skills: { required: [], available: [] },
		},
	},
	skills: { "security-review": { package: SR, version: "1.0.0" } },
	profiles: {
		autonomous: { package: "@example/autonomous-profile", version: "1.0.0" },
	},
	assignments: {
		"large-review": {
			when: { model: "example-large", role: "reviewer" },
			versions: { "skills.security-review": "2.0.0" },
		},
	},
});
// The same local-only roles as version 1 (a local autonomous profile replaces the package profile).
const v1Config = () => ({
	version: 1,
	...routing(),
	roles: {
		reviewer: {
			file: "roles/reviewer.md",
			skills: { required: [], available: [] },
		},
		writer: {
			file: "roles/writer.md",
			skills: { required: [], available: [] },
		},
	},
});

function repository(dir, name, config, files = LOCAL) {
	const root = path.join(dir, name);
	for (const [file, text] of Object.entries(files))
		put(path.join(root, ".agent-profiles", file), text);
	put(path.join(root, ".agent-profiles/agents.yaml"), stringify(config));
	return root;
}

function setEnv(t, values) {
	const saved = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	Object.assign(process.env, values);
}

/** @param {{config?: object, files?: Record<string, string>, ambient?: 'empty' | 'misleading' | 'self'}} [options] */
function setup(
	t,
	{ config = callerConfig(), files = LOCAL, ambient = "empty" } = {},
) {
	const dir = mkdtempSync(path.join(WORK, "t-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { root: storeRoot, imports } = buildStore(dir, "store");
	const home = path.join(dir, "home");
	mkdirSync(home);
	let ambientStore = path.join(dir, "empty-store");
	if (ambient === "empty") mkdirSync(ambientStore);
	if (ambient === "misleading")
		ambientStore = buildStore(dir, "ambient-store", ALL, MISLEADING).root;
	if (ambient === "self") ambientStore = storeRoot;
	setEnv(t, {
		AGENT_PROFILES_STORE: ambientStore,
		HOME: home,
		USERPROFILE: home,
	});
	const root = repository(dir, "repo", config, files);
	const configFile = path.join(root, ".agent-profiles/agents.yaml");
	return {
		dir,
		root,
		storeRoot,
		imports,
		home,
		ambient,
		ambientStore,
		configFile,
		bytes: () => readFileSync(configFile),
		config: () => parse(readFileSync(configFile, "utf8")),
		digest: (key) => imports[key].sha256,
	};
}

// Fixture prerequisite, independent of every caller: the accepted resolver sees the explicit store.
// Real dependency install writes the current lock public required selection needs (after any per-test fixture file).
function fixtureCheck(f) {
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const large = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		model: "example-large",
		role: "reviewer",
	});
	assert.deepEqual(
		json(large.required.map((skill) => skill.package)),
		[
			{
				binding: "skills.security-review",
				name: SR,
				version: "2.0.0",
				sha256: f.digest("security-review@2.0.0"),
				selectedBy: "large-review",
				selectors: { model: "example-large", role: "reviewer" },
			},
		],
		"fixture: explicit store selects 2.0.0",
	);
	if (f.ambient === "empty")
		assert.throws(
			() => resolveInstructions({ root: f.root }),
			/missing-package/,
			"fixture: ambient store is empty",
		);
	return large;
}

const answers = (id) => {
	let rounds = 0;
	const asked = [];
	// Accept every default; save once; quit on the second action prompt.
	const ask = async (prompt) => {
		asked.push(prompt);
		if (prompt.startsWith("Roles:")) return rounds++ ? "q" : "e";
		if (prompt.startsWith("Role identifier")) return id;
		if (prompt.startsWith("Save role")) return "y";
		return "";
	};
	return { ask, asked };
};
const METADATA = {
	name: "local-preset",
	display_name: "Local",
	description: "Local roles",
	author: "Example",
	version: "1.0.0",
	license: "MIT",
};

test("P4-K00 fixture prerequisite: explicit store resolves every package binding; ambient store is empty", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const small = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		model: "example-small",
		role: "reviewer",
	});
	assert.equal(small.required[0].package.version, "1.0.0");
	assert.equal(small.required[0].package.selectedBy, "binding-default");
	const auditor = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		model: "example-large",
		role: "auditor",
	});
	assert.deepEqual(
		auditor.loaded.map((entry) => [
			entry.kind,
			entry.package?.binding,
			entry.package?.sha256,
		]),
		[
			["profile", "profiles.autonomous", f.digest("autonomous-profile@1.0.0")],
			["role", "roles.auditor", f.digest("auditor-role@1.0.0")],
		],
	);
	assert.equal(auditor.available[0].package.version, "1.0.0");
	assert.equal(os.homedir(), f.home);
});

// ---- configure.js (K01-K03) ----
test("P4-K01 planRoleChange/applyRoleChange description edit of local reviewer preserves package binding and assignments", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const before = fingerprint(f.root);
	const storeBefore = fingerprint(f.storeRoot);
	const plan = ok(
		() =>
			planRoleChange({
				root: f.root,
				action: "edit",
				id: "reviewer",
				description: "Review changes carefully",
				storeRoot: f.storeRoot,
			}),
		"planRoleChange with storeRoot",
	);
	ok(() => applyRoleChange(plan), "applyRoleChange of a storeRoot plan");
	const expected = callerConfig();
	expected.roles.reviewer.description = "Review changes carefully";
	assert.deepEqual(f.config(), expected);
	assert.deepEqual(
		without(fingerprint(f.root), ".agent-profiles/agents.yaml"),
		without(before, ".agent-profiles/agents.yaml"),
	);
	assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
	// The edit leaves the lock stale (public refusal is P5B-C03); validation checks the preserved binding's bytes.
	assert.equal(
		resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			model: "example-large",
			role: "reviewer",
			lockMode: "validation",
		}).required[0].package.sha256,
		f.digest("security-review@2.0.0"),
	);
});

test("P4-K01 negative: planRoleChange without storeRoot reports missing-package and writes nothing", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const before = fingerprint(f.root);
	// The resolver reports the first unavailable declared pin; any declared binding and its identity qualify.
	assert.throws(
		() =>
			planRoleChange({
				root: f.root,
				action: "edit",
				id: "reviewer",
				description: "Changed",
			}),
		/(profiles\.autonomous|roles\.auditor|skills\.security-review): .*missing-package @example\/[a-z-]+@1\.0\.0/,
	);
	assert.deepEqual(fingerprint(f.root), before);
});

for (const [label, extra] of [
	["without file", {}],
	["with file", { file: "roles/auditor.md" }],
]) {
	test(`P4-K02 planRoleChange edit of package role auditor ${label} is refused before writes`, (t) => {
		const f = setup(t);
		fixtureCheck(f);
		const before = fingerprint(f.root);
		refuses(
			() =>
				planRoleChange({
					root: f.root,
					action: "edit",
					id: "auditor",
					description: "Audit",
					storeRoot: f.storeRoot,
					...extra,
				}),
			/roles\.auditor|auditor/,
			/package/,
		);
		assert.deepEqual(fingerprint(f.root), before);
		assert.equal(
			existsSync(path.join(f.root, ".agent-profiles/roles/auditor.md")),
			false,
		);
	});
}

test("P4-K03 deleting an unreferenced local role succeeds and keeps package bindings", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const plan = ok(
		() =>
			planRoleChange({
				root: f.root,
				action: "delete",
				id: "writer",
				storeRoot: f.storeRoot,
			}),
		"planRoleChange delete with storeRoot",
	);
	ok(() => applyRoleChange(plan), "applyRoleChange delete");
	const expected = callerConfig();
	delete expected.roles.writer;
	assert.deepEqual(f.config(), expected);
	assert.equal(
		existsSync(path.join(f.root, ".agent-profiles/roles/writer.md")),
		true,
	);
});

test("P4-K03 negative: deleting reviewer while large-review selects it fails naming large-review; no write", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const before = fingerprint(f.root);
	refuses(
		() =>
			planRoleChange({
				root: f.root,
				action: "delete",
				id: "reviewer",
				defaultRole: "writer",
				storeRoot: f.storeRoot,
			}),
		/large-review/,
	);
	assert.deepEqual(fingerprint(f.root), before);
});

// ---- wizard.js (K04) ----
test("P4-K04 configureRoles edit of reviewer accepting defaults keeps the package skill", async (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const { ask } = answers("reviewer");
	const output = [];
	await assert.doesNotReject(
		configureRoles({
			root: f.root,
			storeRoot: f.storeRoot,
			ask,
			write: (text) => output.push(String(text)),
		}),
		"configureRoles with storeRoot",
	);
	assert.deepEqual(
		output.filter((line) => line.startsWith("Error:")),
		[],
	);
	assert.deepEqual(f.config(), callerConfig());
	assert.equal(
		resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			model: "example-large",
			role: "reviewer",
		}).required[0].package.version,
		"2.0.0",
	);
});

test("P4-K04 negative: configureRoles edit of package role auditor prints the refusal; no write", async (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const before = fingerprint(f.root);
	const { ask } = answers("auditor");
	const output = [];
	await assert.doesNotReject(
		configureRoles({
			root: f.root,
			storeRoot: f.storeRoot,
			ask,
			write: (text) => output.push(String(text)),
		}),
		"configureRoles with storeRoot",
	);
	const errors = output.filter((line) => line.startsWith("Error:"));
	assert.equal(
		errors.length,
		1,
		`expected one refusal, got ${JSON.stringify(output)}`,
	);
	assert.doesNotMatch(errors[0], /missing-package/);
	assert.match(errors[0], /auditor/);
	assert.match(errors[0], /package/);
	assert.deepEqual(fingerprint(f.root), before);
});

// ---- presets.js export (K05) ----
test("P4-K05 local-only role export from the v2 project is byte-equal to the v1 export", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const v1 = repository(f.dir, "repo-v1", v1Config(), {
		...LOCAL,
		"profiles/autonomous.md": "# Autonomous\nLocal.\n",
	});
	for (const out of ["out-v1", "out-v2"]) mkdirSync(path.join(f.dir, out));
	const control = planPresetExport({
		root: v1,
		destination: path.join(f.dir, "out-v1/preset"),
		metadata: METADATA,
		roles: ["writer"],
		profiles: [],
	});
	applyPresetExport(control, true);
	const plan = ok(
		() =>
			planPresetExport({
				root: f.root,
				destination: path.join(f.dir, "out-v2/preset"),
				metadata: METADATA,
				roles: ["writer"],
				profiles: [],
				storeRoot: f.storeRoot,
			}),
		"planPresetExport with storeRoot",
	);
	assert.deepEqual(
		plan.changes.map((change) => [
			change.file,
			change.after.toString("base64"),
		]),
		control.changes.map((change) => [
			change.file,
			change.after.toString("base64"),
		]),
	);
	ok(() => applyPresetExport(plan, true), "applyPresetExport");
	assert.deepEqual(
		fingerprint(path.join(f.dir, "out-v2/preset")),
		fingerprint(path.join(f.dir, "out-v1/preset")),
	);
});

for (const [id, options, binding] of [
	[
		"b reviewer requiring the package skill",
		{ roles: ["reviewer"], profiles: [] },
		/skills\.security-review/,
	],
	[
		"c reviewer including the package skill",
		{ roles: ["reviewer"], profiles: [], includeSkills: ["security-review"] },
		/skills\.security-review/,
	],
	// The guard may report either package binding the auditor role carries.
	[
		"d package role auditor",
		{ roles: ["auditor"], profiles: [] },
		/roles\.auditor|skills\.security-review/,
	],
	[
		"e package profile autonomous",
		{ roles: ["writer"], profiles: ["autonomous"] },
		/profiles\.autonomous/,
	],
]) {
	test(`P4-K05${id}: export throws preset-package-unsupported before the destination exists`, (t) => {
		const f = setup(t);
		fixtureCheck(f);
		const destination = path.join(f.dir, "out/preset");
		mkdirSync(path.dirname(destination));
		const before = fingerprint(f.root);
		refuses(
			() =>
				planPresetExport({
					root: f.root,
					destination,
					metadata: METADATA,
					storeRoot: f.storeRoot,
					...options,
				}),
			/preset-package-unsupported/,
			binding,
		);
		assert.equal(existsSync(destination), false);
		assert.deepEqual(fingerprint(f.root), before);
	});
}

// ---- presets.js import (K06) ----
function preset(dir, skills, files = {}) {
	const source = path.join(dir, "preset");
	put(
		path.join(source, "preset.yaml"),
		stringify({
			schema_version: 1,
			preset: {
				name: "tester-preset",
				display_name: "Tester",
				description: "Tester role",
				author: "Example",
				version: "1.0.0",
				license: "MIT",
			},
			roles: {
				tester: {
					file: "roles/tester.md",
					skills: { required: ["security-review"], available: [] },
				},
			},
			skills,
		}),
	);
	for (const [file, text] of Object.entries({
		"roles/tester.md": "# Tester\nTest changes.\n",
		...files,
	}))
		put(path.join(source, file), text);
	return source;
}

test("P4-K06 preset requiring security-review imports, reusing the package binding", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const source = preset(f.dir, { requires: ["security-review"], includes: {} });
	const plan = ok(
		() => planPresetImport({ root: f.root, source, storeRoot: f.storeRoot }),
		"planPresetImport with storeRoot",
	);
	assert.deepEqual(plan.conflicts, []);
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.ready, true);
	ok(() => applyPresetImport(plan, true), "applyPresetImport");
	const after = f.config();
	assert.deepEqual(after.skills, callerConfig().skills);
	assert.deepEqual(after.assignments, callerConfig().assignments);
	assert.deepEqual(after.roles.tester.skills.required, ["security-review"]);
	assert.equal(
		existsSync(
			path.join(f.root, ".agent-profiles/skills/security-review/SKILL.md"),
		),
		false,
	);
	// The import leaves the lock stale (public refusal is P5B-P01); validation checks the reused binding's bytes.
	const tester = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		model: "example-small",
		role: "tester",
		lockMode: "validation",
	});
	assert.deepEqual(
		[tester.required[0].package.binding, tester.required[0].package.sha256],
		["skills.security-review", f.digest("security-review@1.0.0")],
	);
});

test("P4-K06 negative: preset including Markdown security-review conflicts; replace is not ready, names large-review; no write", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const source = preset(
		f.dir,
		{
			requires: [],
			includes: {
				"security-review": { file: "skills/security-review/SKILL.md" },
			},
		},
		{
			"skills/security-review/SKILL.md":
				"---\nname: security-review\ndescription: Markdown review.\n---\nMarkdown body.\n",
		},
	);
	const before = fingerprint(f.root);
	const plan = ok(
		() => planPresetImport({ root: f.root, source, storeRoot: f.storeRoot }),
		"planPresetImport with storeRoot",
	);
	assert.ok(
		plan.conflicts.some(
			(conflict) => conflict.key === "skills.security-review",
		),
		JSON.stringify(plan.conflicts),
	);
	assert.equal(plan.ready, false);
	const replaced = ok(
		() =>
			planPresetImport({
				root: f.root,
				source,
				storeRoot: f.storeRoot,
				decisions: new Map([["skills.security-review", "replace"]]),
			}),
		"replace plan",
	);
	assert.equal(replaced.ready, false);
	assert.match(replaced.errors.join("\n"), /large-review/);
	assert.doesNotMatch(replaced.errors.join("\n"), /missing-package/);
	assert.throws(() => applyPresetImport(replaced, true));
	assert.deepEqual(fingerprint(f.root), before);
});

// ---- install.js doctor (K07) ----
test("P4-K07 doctor with explicit storeRoot reports no package error", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const result = doctor(f.root, { storeRoot: f.storeRoot });
	assert.deepEqual(
		result.errors.filter((error) => /missing-package|@example\//.test(error)),
		[],
	);
	assert.equal(result.role, "reviewer");
});

test("P4-K07 negative: doctor with a wrong store reports missing-package naming the binding and rule", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const partial = buildStore(
		f.dir,
		"partial-store",
		ALL.filter((key) => key !== "security-review@2.0.0"),
	).root;
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: partial }),
		/large-review.*missing-package.*security-review@2\.0\.0/s,
		"fixture: partial store lacks 2.0.0",
	);
	const errors = doctor(f.root, { storeRoot: partial }).errors.filter((error) =>
		/missing-package/.test(error),
	);
	assert.equal(errors.length, 1, JSON.stringify(errors));
	assert.match(errors[0], /assignments\.large-review/);
	assert.match(errors[0], /@example\/security-review@2\.0\.0/);
});

test("P4-K07 doctor legacy-file heuristic reports only local bindings, never package bindings", (t) => {
	const config = callerConfig();
	config.skills["legacy-check"] = {
		file: ".claude/skills/legacy-check/SKILL.md",
	};
	const f = setup(t, { config });
	put(
		path.join(f.root, ".claude/skills/legacy-check/SKILL.md"),
		"---\nname: legacy-check\ndescription: Legacy.\n---\nLegacy body.\n",
	);
	fixtureCheck(f);
	const { notes } = doctor(f.root, { storeRoot: f.storeRoot });
	assert.ok(
		notes.some((note) =>
			note.startsWith(
				"Skill legacy-check maps .claude/skills/legacy-check/SKILL.md",
			),
		),
		JSON.stringify(notes),
	);
	assert.deepEqual(
		notes.filter((note) => /security-review|undefined/.test(note)),
		[],
	);
});

// ---- visualize.js (K08) ----
async function serve(t, options) {
	const app = await startVisualizer(options);
	t.after(
		() =>
			new Promise((resolve) => {
				app.server.close(resolve);
				app.server.closeAllConnections();
			}),
	);
	return app;
}
async function get(url, query) {
	const response = await fetch(`${url}api/resolve?${query}`);
	return { status: response.status, body: await response.json() };
}
const oracle = (f, model, role) =>
	json(
		resolutionOutput(
			resolveInstructions({
				root: f.root,
				storeRoot: f.storeRoot,
				model,
				role,
			}),
			true,
		),
	);

test("P4-K08 visualizer api/resolve uses explicit storeRoot over a misleading AGENT_PROFILES_STORE", async (t) => {
	const f = setup(t, { ambient: "misleading" });
	fixtureCheck(f);
	const { url } = await serve(t, {
		root: f.root,
		storeRoot: f.storeRoot,
		model: "example-large",
		role: "reviewer",
	});
	const { status, body } = await get(url, "model=example-large&role=reviewer");
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(
		body.required[0].package.sha256,
		f.digest("security-review@2.0.0"),
		"api/resolve digest comes from the explicit store",
	);
	assert.deepEqual(body, oracle(f, "example-large", "reviewer"));
});

test("P4-K08 visualizer initial resolve uses explicit storeRoot when the ambient store is empty", async (t) => {
	const f = setup(t);
	fixtureCheck(f);
	let app;
	await assert.doesNotReject(async () => {
		app = await serve(t, {
			root: f.root,
			storeRoot: f.storeRoot,
			model: "example-large",
			role: "reviewer",
		});
	}, "startVisualizer with storeRoot");
	const { status, body } = await get(
		app.url,
		"model=example-large&role=reviewer",
	);
	assert.equal(status, 200, JSON.stringify(body));
	assert.deepEqual(body, oracle(f, "example-large", "reviewer"));
});

test("P4-K08 negative (inherited): ?store= is rejected as an unknown parameter", async (t) => {
	const f = setup(t, { ambient: "self" });
	fixtureCheck(f);
	const { url } = await serve(t, { root: f.root, storeRoot: f.storeRoot });
	assert.deepEqual(await get(url, "model=example-large&role=reviewer"), {
		status: 200,
		body: oracle(f, "example-large", "reviewer"),
	});
	assert.deepEqual(
		await get(
			url,
			`store=${encodeURIComponent(f.storeRoot)}&model=example-large`,
		),
		{ status: 400, body: { error: "Unknown parameter: store" } },
	);
});

// ---- inspect.js (K09), skills.js (K10) ----
test("P4-K09 inspectRepository lists package role and profile as declared metadata, store-free, never a fake path", (t) => {
	const f = setup(t);
	fixtureCheck(f);
	const before = [
		fingerprint(f.root),
		fingerprint(f.storeRoot),
		fingerprint(f.ambientStore),
		fingerprint(f.home),
	];
	const { configuration } = inspectRepository({ root: f.root }).repository;
	const auditor = configuration.roles.find((role) => role.id === "auditor");
	assert.ok(
		auditor,
		`auditor listed (status ${configuration.status}: ${configuration.problem ?? ""})`,
	);
	assert.notEqual(auditor.path, ".agent-profiles/undefined");
	assert.notEqual(auditor.availability, "missing");
	assert.ok(
		JSON.stringify(auditor).includes('"@example/auditor-role"') &&
			JSON.stringify(auditor).includes('"1.0.0"'),
		JSON.stringify(auditor),
	);
	const autonomous = configuration.profiles.find(
		(profile) => profile.id === "autonomous",
	);
	assert.ok(autonomous, "autonomous listed");
	assert.notEqual(autonomous.availability, "missing");
	assert.ok(
		JSON.stringify(autonomous).includes('"@example/autonomous-profile"'),
		JSON.stringify(autonomous),
	);
	// Bounded inspection cannot verify a package, so it must not claim verification.
	for (const entry of [auditor, autonomous])
		assert.ok(
			!String(entry.verification ?? "").startsWith("verified"),
			JSON.stringify(entry),
		);
	const reviewer = configuration.roles.find((role) => role.id === "reviewer");
	assert.deepEqual(
		[reviewer.path, reviewer.availability],
		[".agent-profiles/roles/reviewer.md", "available"],
	);
	assert.deepEqual(
		[
			fingerprint(f.root),
			fingerprint(f.storeRoot),
			fingerprint(f.ambientStore),
			fingerprint(f.home),
		],
		before,
	);
});

for (const metadataOnly of [false, true]) {
	test(`P4-K10 discoverSkills (metadataOnly ${metadataOnly}) emits no warning or fake path for package bindings`, (t) => {
		const config = callerConfig();
		config.skills["local-check"] = {
			file: ".agent-profiles/extra/local-check.md",
		};
		const f = setup(t, {
			config,
			files: {
				...LOCAL,
				"extra/local-check.md":
					"---\nname: local-check\ndescription: Local check.\n---\nLocal check body.\n",
			},
		});
		fixtureCheck(f);
		const found = discoverSkills(
			f.root,
			parseYaml(readFileSync(f.configFile, "utf8")),
			{ metadataOnly },
		);
		assert.ok(
			found.skills.some(
				(skill) =>
					skill.id === "local-check" &&
					skill.path === ".agent-profiles/extra/local-check.md",
			),
			"local configured skill discovered",
		);
		assert.deepEqual(
			found.warnings.filter((warning) =>
				/security-review|undefined/.test(warning),
			),
			[],
		);
		assert.deepEqual(
			found.skills.filter(
				(skill) =>
					skill.id === "security-review" && typeof skill.path === "string",
			),
			[],
		);
	});
}

// ---- diagnostics.js formatProof (K11) ----
test("P4-K11 formatProof shows package identities and digests", (t) => {
	const f = setup(t);
	const proof = formatProof(fixtureCheck(f));
	assert.ok(proof.includes(`${SR}@2.0.0`), proof);
	assert.ok(
		proof.includes(f.digest("security-review@2.0.0")),
		"security-review digest",
	);
	assert.ok(
		proof.includes("@example/autonomous-profile@1.0.0"),
		"profile identity",
	);
	assert.ok(
		proof.includes(f.digest("autonomous-profile@1.0.0")),
		"profile digest",
	);
});

test("P4-K11 negative: formatProof never prints null as a path or the store root", (t) => {
	const f = setup(t);
	const proof = formatProof(fixtureCheck(f));
	assert.match(
		proof,
		/^ {2}\.agent-profiles\/roles\/reviewer\.md {2}/m,
		"local role keeps its repository path",
	);
	assert.deepEqual(
		proof.split("\n").filter((line) => /\bnull\b/.test(line)),
		[],
	);
	assert.equal(proof.includes(f.storeRoot), false);
	assert.equal(proof.includes("objects/sha256"), false);
});
