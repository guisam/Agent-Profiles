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
import { stringify } from "yaml";
import { integrations } from "../src/integrations.ts";
import { importPackage, lookupPackage } from "../src/package-store.ts";
import { readPackage } from "../src/packages.ts";
import { resolveInstructions } from "../src/resolve.ts";

// P4 slice 1 (docs/development/issue-20-p4-handoff.md sections 4, 5, 8): resolver only.
// Seam B1 (parent-accepted): resolveInstructions({..., storeRoot, lockMode: 'validation'}) verifies EVERY
// declared package pin (base and overrides) through the existing lookupPackage; no lock is written.
// P5b: results carry the operational lockMode/lockState/installRequired fields; only exact-output oracles assert them.
// Missing-seam protocol: P4-SEAM probes one minimal-valid version 2 configuration. Only its exact current
// rejection skips the version 2 cases, each listing its unexecuted assertions; any other outcome runs them.
// Each version 2 case must execute its whole ledger once unblocked. P4-F* and P4-R01 run independently.

const WORK = realpathSync(
	mkdtempSync(path.join(os.tmpdir(), "p4-resolution-")),
);
after(() => rmSync(WORK, { recursive: true, force: true }));

function put(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}
function scratch(t) {
	const dir = mkdtempSync(path.join(WORK, "t-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function fingerprint(dir) {
	return readdirSync(dir, { recursive: true })
		.map(String)
		.sort()
		.map((file) => {
			const full = path.join(dir, file);
			return statSync(full).isDirectory()
				? `${file}/`
				: `${file} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
		});
}
const json = (value) => JSON.parse(JSON.stringify(value));
const measure = (text) => ({
	bytes: Buffer.byteLength(text),
	characters: [...text].length,
});

// ---- package fixtures, imported through the existing store API ----
const SR = "@example/security-review";
function fixture(
	name,
	version,
	type,
	entrypoint,
	files,
	delivery = "instruction",
	hosts = [],
) {
	const manifest =
		`schema_version: 1\npackage:\n  name: "${name}"\n  version: "${version}"\n  type: ${type}\nentrypoint: ${entrypoint}\n` +
		`behavior:\n  delivery: ${delivery}\n  hosts: [${hosts.join(", ")}]\n  effects: []\n`;
	return {
		name,
		version,
		type,
		entrypoint,
		delivery,
		hosts,
		files: Object.fromEntries(
			Object.entries({ "package.yaml": manifest, ...files }).map(
				([file, text]) => [file, Buffer.from(text)],
			),
		),
	};
}
// Skill entrypoints sit at the package root without frontmatter `name` (R12).
const FIXTURES = {
	"security-review@1.0.0": fixture(SR, "1.0.0", "skill", "SKILL.md", {
		"SKILL.md":
			"---\ndescription: Security review one.\n---\r\nCheck inputs — revision one ✓\r\n",
		"resources/checklist.txt": "inputs\r\n",
	}),
	"security-review@2.0.0": fixture(SR, "2.0.0", "skill", "SKILL.md", {
		"SKILL.md":
			"---\ndescription: Security review two.\n---\nCheck inputs and outputs — revision two ✓✓\n",
		"resources/checklist.txt": "inputs\noutputs\n",
	}),
	"auditor-role@1.0.0": fixture(
		"@example/auditor-role",
		"1.0.0",
		"instruction",
		"role.md",
		{ "role.md": "# Auditor 1.0.0\nAudit releases.\n" },
	),
	"auditor-role@1.1.0": fixture(
		"@example/auditor-role",
		"1.1.0",
		"instruction",
		"role.md",
		{ "role.md": "# Auditor 1.1.0\r\nAudit releases and dependencies ✓\r\n" },
	),
	"autonomous-profile@1.0.0": fixture(
		"@example/autonomous-profile",
		"1.0.0",
		"instruction",
		"profile.md",
		{ "profile.md": "# Autonomous ✓\nWork independently.\n" },
	),
	"native-check@1.0.0": fixture(
		"@example/native-check",
		"1.0.0",
		"skill",
		"SKILL.md",
		{
			"SKILL.md":
				"---\nname: native-check\ndescription: Native check.\n---\nRun the native check.\n",
		},
		"native",
		["claude"],
	),
};
const STORE_B_FILES = {
	...FIXTURES["security-review@1.0.0"].files,
	"SKILL.md": Buffer.from(
		"---\ndescription: Store B review.\n---\nStore B body.\n",
	),
};
const treeOf = (files) =>
	Object.entries(files)
		.map(([file, bytes]) => ({ path: file, bytes }))
		.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

function buildStore(dir, keys, variants = {}) {
	const root = path.join(dir, "store");
	const imports = {};
	for (const key of keys) {
		const source = path.join(dir, "sources", key);
		for (const [file, bytes] of Object.entries(
			variants[key] ?? FIXTURES[key].files,
		))
			put(path.join(source, file), bytes);
		imports[key] = importPackage({ sourceDirectory: source, storeRoot: root });
	}
	return { root, imports };
}
let shared;
const sharedStore = () =>
	(shared ??= buildStore(
		mkdtempSync(path.join(WORK, "shared-")),
		Object.keys(FIXTURES),
	));
const digest = (key) => sharedStore().imports[key].sha256;
const ALL = Object.keys(FIXTURES);
const except = (key) => ALL.filter((item) => item !== key);
function corrupt(storeRoot, key, file) {
	const target = path.join(
		storeRoot,
		"objects/sha256",
		digest(key),
		"tree",
		file,
	);
	const bytes = readFileSync(target);
	bytes[0] ^= 1;
	writeFileSync(target, bytes);
}

// ---- repository fixtures ----
const LOCAL = {
	"profiles/constrained.md": "# Constrained\r\nTake small verified steps.\r\n",
	"profiles/scaffolded.md": "# Scaffolded ✓\nFollow explicit checklists.\n",
	"profiles/autonomous.md": "# Autonomous\nPlan and act independently.\n",
	"roles/reviewer.md": "# Reviewer\nReview changes for defects.\n",
	"roles/auditor.md": "# Auditor\nAudit releases.\n",
	"skills/security-review/SKILL.md":
		"---\nname: security-review\ndescription: Local security review.\n---\nLocal review body ✓\n",
};
const pickFiles = (...files) =>
	Object.fromEntries(files.map((file) => [file, LOCAL[file]]));
const PACKAGE_FILES = pickFiles(
	"profiles/constrained.md",
	"profiles/scaffolded.md",
	"roles/reviewer.md",
);
const SINGLE_PIN_FILES = pickFiles(
	"profiles/constrained.md",
	"profiles/scaffolded.md",
	"profiles/autonomous.md",
	"roles/reviewer.md",
	"roles/auditor.md",
);
const EXTRA_LOCAL_SKILL = {
	"extra/local-check.md":
		"---\nname: local-check\ndescription: Local check.\n---\nLocal check body.\n",
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
const localConfig = (version) => ({
	version,
	...routing(),
	roles: {
		reviewer: {
			file: "roles/reviewer.md",
			skills: { required: ["security-review"], available: [] },
		},
		auditor: {
			file: "roles/auditor.md",
			skills: { required: [], available: ["security-review"] },
		},
	},
});
const base = () => ({
	version: 2,
	...routing(),
	roles: {
		reviewer: {
			file: "roles/reviewer.md",
			skills: { required: ["security-review"], available: [] },
		},
		auditor: {
			package: "@example/auditor-role",
			version: "1.0.0",
			skills: { required: [], available: ["security-review"] },
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
const rule = (when, version = "2.0.0", binding = "skills.security-review") => ({
	when,
	versions: { [binding]: version },
});
const withRules = (rules) => ({ ...base(), assignments: rules });
const withoutAssignments = () => {
	const config = base();
	delete config.assignments;
	return config;
};
const withExtraSkills = () => {
	const config = base();
	config.skills["local-check"] = {
		file: ".agent-profiles/extra/local-check.md",
	};
	config.skills["host-check"] = { host: "claude", scope: "user" };
	return config;
};
const singlePin = () => ({
	...localConfig(2),
	skills: { "security-review": { package: SR, version: "1.0.0" } },
});

function project(t, config, files = PACKAGE_FILES) {
	const dir = scratch(t);
	const root = path.join(dir, "repo");
	for (const [file, text] of Object.entries(files))
		put(path.join(root, ".agent-profiles", file), text);
	const write = (next) =>
		writeFileSync(
			path.join(root, ".agent-profiles/agents.yaml"),
			stringify(next),
		);
	write(config);
	return { dir, root, write };
}

// ---- routing oracle (today's routing, written out independently) ----
const ROUTES = [
	[
		"exact-model",
		{ model: "example-large" },
		{
			matchedBy: "model",
			canonical: "example-large",
			profile: "autonomous",
			family: null,
			familySource: null,
		},
	],
	[
		"alias",
		{ model: "example-large-alias" },
		{
			matchedBy: "alias",
			canonical: "example-large",
			profile: "autonomous",
			family: null,
			familySource: null,
		},
	],
	[
		"second-model",
		{ model: "example-small" },
		{
			matchedBy: "model",
			canonical: "example-small",
			profile: "scaffolded",
			family: null,
			familySource: null,
		},
	],
	[
		"supplied-family",
		{ model: "unlisted", family: "example" },
		{
			matchedBy: "family",
			canonical: null,
			profile: "scaffolded",
			family: "example",
			familySource: "supplied",
		},
	],
	[
		"family-prefix",
		{ model: "example-v9" },
		{
			matchedBy: "family-prefix",
			canonical: null,
			profile: "scaffolded",
			family: "example",
			familySource: "configured-prefix",
		},
	],
	[
		"default",
		{},
		{
			matchedBy: "default",
			canonical: null,
			profile: "constrained",
			family: null,
			familySource: null,
		},
	],
];
const DEFAULT_ROUTE = ROUTES[5][2];
const ROLES = ["reviewer", "auditor", undefined];
const ROUTING_FIELDS = [
	"host",
	"model",
	"family",
	"familySource",
	"matchedBy",
	"identity",
	"profile",
	"role",
	"roleSource",
];
const routingFields = (result) =>
	Object.fromEntries(ROUTING_FIELDS.map((key) => [key, result[key]]));
const routingOf = (options, route, role, host) => ({
	host: host ?? null,
	model: options.model ?? null,
	family: route.family,
	familySource: route.familySource,
	matchedBy: route.matchedBy,
	identity: {
		raw: options.model ?? null,
		canonical: route.canonical,
		source: null,
		matchedBy: route.matchedBy,
	},
	profile: route.profile,
	role: role ?? "reviewer",
	roleSource: role === undefined ? "default" : "assigned",
});
const total = (entries) => ({
	files: entries.length,
	bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
	characters: entries.reduce((sum, entry) => sum + entry.characters, 0),
});
// Today's complete hostless version 1 JSON for the local twin project.
function expectedV1(options, route, role) {
	const selected = role ?? "reviewer";
	const entry = (file, kind, id) => ({
		path: `.agent-profiles/${file}`,
		kind,
		id,
		content: LOCAL[file],
		...measure(LOCAL[file]),
	});
	const skill = {
		id: "security-review",
		type: "instruction",
		delivery: "inject",
		name: "security-review",
		nameSource: "frontmatter",
		description: "Local security review.",
		path: ".agent-profiles/skills/security-review/SKILL.md",
		...measure(LOCAL["skills/security-review/SKILL.md"]),
	};
	const loaded = [
		entry(`profiles/${route.profile}.md`, "profile", route.profile),
		entry(`roles/${selected}.md`, "role", selected),
		...(selected === "reviewer"
			? [
					entry(
						"skills/security-review/SKILL.md",
						"required-skill",
						"security-review",
					),
				]
			: []),
	];
	const available = selected === "auditor" ? [skill] : [];
	return {
		...routingOf(options, route, role),
		repository: { path: "AGENTS.md", suppliedBy: "host", exists: false },
		loaded,
		required: selected === "reviewer" ? [skill] : [],
		available,
		unsatisfied: [],
		// Public required mode: these projects declare zero package pins, so no lock is required.
		lockMode: "required",
		lockState: "not-required",
		installRequired: false,
		diagnostics: {
			scope: "resolved-instruction-bodies",
			encoding: "utf8",
			characterUnit: "unicode-code-points",
			excluded: [
				"host-context",
				"repository-instructions",
				"bootstrap-instructions",
				"host-native-skills",
				"inventory-rendering",
				"output-formatting",
			],
			managed: {
				profile: total(loaded.filter((item) => item.kind === "profile")),
				role: total(loaded.filter((item) => item.kind === "role")),
				requiredSkills: total(
					loaded.filter((item) => item.kind === "required-skill"),
				),
				requestedSkills: total([]),
				total: total(loaded),
			},
			availableNotLoaded: total(available),
			hostSkills: [],
			bootstrap: {
				scope: "not-measured",
				host: null,
				file: null,
				installed: false,
				bytes: null,
				characters: null,
			},
			repository: {
				path: "AGENTS.md",
				suppliedBy: "host",
				status: "host-supplied",
				injection: "host-controlled",
				bytes: null,
				characters: null,
				otherInstructions: { status: "unobserved", suppliedBy: "host" },
			},
			host: {
				systemInstructions: { status: "unobserved" },
				tools: { status: "unobserved" },
				builtInSkills: { status: "unobserved" },
				otherContext: { status: "unobserved" },
			},
			tokens: { value: null, kind: "not-calculated", method: null },
		},
	};
}

// ---- package selection oracle ----
const record = (
	key,
	binding,
	selectedBy = "binding-default",
	selectors = {},
) => ({
	binding,
	name: FIXTURES[key].name,
	version: FIXTURES[key].version,
	sha256: digest(key),
	selectedBy,
	selectors,
});
const LARGE_REVIEW = { model: "example-large", role: "reviewer" };
const baseSelection = (route, role) =>
	(role ?? "reviewer") === "reviewer" && route.canonical === "example-large"
		? record(
				"security-review@2.0.0",
				"skills.security-review",
				"large-review",
				LARGE_REVIEW,
			)
		: record("security-review@1.0.0", "skills.security-review");
const skillEntry = (result, id) =>
	[...result.required, ...result.available].find((skill) => skill.id === id);
function assertPackage(entry, key, expected) {
	assert.equal(entry.path, null);
	assert.deepEqual(entry.backing, {
		type: "package",
		sha256: digest(key),
		path: FIXTURES[key].entrypoint,
	});
	assert.deepEqual(entry.package, expected);
}
function assertBytes(entry, key) {
	const raw = FIXTURES[key].files[FIXTURES[key].entrypoint];
	assert.deepEqual(Buffer.from(entry.content, "utf8"), raw);
	assert.deepEqual(
		[entry.bytes, entry.characters],
		[raw.length, [...raw.toString("utf8")].length],
	);
}
const kinds = (result) => result.loaded.map((entry) => [entry.kind, entry.id]);
const resolve = (root, options = {}, storeRoot = sharedStore().root) =>
	resolveInstructions({ root, storeRoot, lockMode: "validation", ...options });

const SEAM = "version: only version 1 is supported";
function rejects(fn, needles) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof Error, "expected an Error");
		assert.notEqual(
			error.message,
			SEAM,
			"the version seam is not behavioral evidence",
		);
		for (const needle of needles) {
			assert.ok(
				typeof needle === "string"
					? error.message.includes(needle)
					: needle.test(error.message),
				`${JSON.stringify(error.message)} lacks ${needle}`,
			);
		}
		return true;
	});
}
function storeEnv(t, value) {
	const previous = process.env.AGENT_PROFILES_STORE;
	process.env.AGENT_PROFILES_STORE = value;
	t.after(() => {
		if (previous === undefined) delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = previous;
	});
}

// ---- missing version 2 seam probe ----
const probeRoot = path.join(WORK, "probe");
put(
	path.join(probeRoot, ".agent-profiles/agents.yaml"),
	stringify({
		version: 2,
		default_profile: "constrained",
		default_role: "reviewer",
		models: {},
		families: {},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: [], available: [] },
			},
		},
	}),
);
put(
	path.join(probeRoot, ".agent-profiles/profiles/constrained.md"),
	LOCAL["profiles/constrained.md"],
);
put(
	path.join(probeRoot, ".agent-profiles/roles/reviewer.md"),
	LOCAL["roles/reviewer.md"],
);
let probe, probeError;
try {
	probe = resolveInstructions({ root: probeRoot });
} catch (error) {
	probeError = error;
}
rmSync(probeRoot, { recursive: true, force: true });
const blocked =
	probeError?.message === SEAM &&
	`BLOCKED by missing version 2 seam: minimal-valid version 2 rejected with exactly "${SEAM}"`;

function v2(name, ledger, fn) {
	test(name, {
		skip: blocked && `${blocked}; unexecuted: ${ledger.join(" | ")}`,
	}, async (t) => {
		const reached = new Set();
		await fn(t, (label) => {
			assert.ok(ledger.includes(label), `ledger lacks ${label}`);
			reached.add(label);
		});
		assert.deepEqual(
			ledger.filter((label) => !reached.has(label)),
			[],
			"every ledger assertion executed",
		);
	});
}
const SMALL = { model: "example-small", role: "reviewer" };
function assertSmall(result) {
	assert.equal(result.profile, "scaffolded");
	assert.deepEqual(
		skillEntry(result, "security-review").package,
		record("security-review@1.0.0", "skills.security-review"),
	);
}
// One valid sibling, then exactly one change that must reject.
function negative(name, { config = base, files = {}, change, needles }) {
	const ok =
		"positive sibling selects @example/security-review@1.0.0 by binding-default";
	const no = `single change rejects naming ${needles.join(", ")}`;
	v2(name, [ok, no], (t, reach) => {
		const repo = project(t, config(), { ...PACKAGE_FILES, ...files });
		assertSmall(resolve(repo.root, SMALL));
		reach(ok);
		const next = config();
		change(next, repo.root);
		repo.write(next);
		rejects(() => resolve(repo.root, SMALL), needles);
		reach(no);
	});
}

test("P4-SEAM minimal-valid version 2 configuration resolves", () => {
	assert.equal(
		probeError,
		undefined,
		`version 2 support missing: ${probeError?.message}`,
	);
	assert.deepEqual(
		routingFields(probe),
		routingOf({}, DEFAULT_ROUTE, undefined),
	);
	assert.deepEqual(
		probe.loaded.map((entry) => [entry.kind, entry.path]),
		[
			["profile", ".agent-profiles/profiles/constrained.md"],
			["role", ".agent-profiles/roles/reviewer.md"],
		],
	);
});

// ---- independent fixture oracles (existing manifest/import/lookup APIs; no version 2 needed) ----
for (const [key, fixture] of Object.entries(FIXTURES)) {
	test(`P4-F01 fixture ${key} passes manifest validation, imports and verifies byte-exact`, (t) => {
		const source = path.join(scratch(t), "source");
		for (const [file, bytes] of Object.entries(fixture.files))
			put(path.join(source, file), bytes);
		const read = readPackage({ root: source });
		assert.deepEqual(read.manifest, {
			schema_version: 1,
			package: {
				name: fixture.name,
				version: fixture.version,
				type: fixture.type,
			},
			entrypoint: fixture.entrypoint,
			behavior: {
				delivery: fixture.delivery,
				hosts: fixture.hosts,
				effects: [],
			},
		});
		assert.deepEqual(sharedStore().imports[key], {
			identity: { name: fixture.name, version: fixture.version },
			sha256: read.sha256,
			status: "published",
		});
		assert.deepEqual(
			lookupPackage({
				storeRoot: sharedStore().root,
				name: fixture.name,
				version: fixture.version,
			}),
			{
				identity: { name: fixture.name, version: fixture.version },
				sha256: read.sha256,
				files: treeOf(fixture.files),
			},
		);
	});
}

test("P4-F02 fixture revisions differ in digest, entrypoint and resource bytes", () => {
	assert.equal(new Set(ALL.map(digest)).size, ALL.length);
	const one = FIXTURES["security-review@1.0.0"].files,
		two = FIXTURES["security-review@2.0.0"].files;
	assert.notDeepEqual(one["SKILL.md"], two["SKILL.md"]);
	assert.notDeepEqual(
		one["resources/checklist.txt"],
		two["resources/checklist.txt"],
	);
	assert.notDeepEqual(
		FIXTURES["auditor-role@1.0.0"].files["role.md"],
		FIXTURES["auditor-role@1.1.0"].files["role.md"],
	);
});

test("P4-F03 oracle: lookupPackage returns null for an absent pin and rejects one changed stored byte without repair", (t) => {
	const store = buildStore(scratch(t), ["security-review@2.0.0"]);
	assert.equal(
		lookupPackage({ storeRoot: store.root, name: SR, version: "1.0.0" }),
		null,
	);
	corrupt(store.root, "security-review@2.0.0", "resources/checklist.txt");
	const before = fingerprint(store.root);
	assert.throws(
		() => lookupPackage({ storeRoot: store.root, name: SR, version: "2.0.0" }),
		new RegExp(`digest mismatch ${digest("security-review@2.0.0")}`),
	);
	assert.deepEqual(fingerprint(store.root), before);
});

test("P4-F04 oracle: lookupPackage prefers explicit storeRoot over AGENT_PROFILES_STORE", (t) => {
	const storeB = buildStore(scratch(t), ["security-review@1.0.0"], {
		"security-review@1.0.0": STORE_B_FILES,
	});
	assert.notEqual(
		storeB.imports["security-review@1.0.0"].sha256,
		digest("security-review@1.0.0"),
	);
	storeEnv(t, storeB.root);
	assert.equal(
		lookupPackage({ storeRoot: sharedStore().root, name: SR, version: "1.0.0" })
			.sha256,
		digest("security-review@1.0.0"),
	);
	assert.equal(
		lookupPackage({ name: SR, version: "1.0.0" }).sha256,
		storeB.imports["security-review@1.0.0"].sha256,
	);
});

test("P4-F05 oracle: lookupPackage of every fixture leaves store bytes unchanged and takes no writer lock", () => {
	const { root } = sharedStore();
	const before = fingerprint(root);
	for (const fixture of Object.values(FIXTURES))
		assert.ok(
			lookupPackage({
				storeRoot: root,
				name: fixture.name,
				version: fixture.version,
			}),
		);
	assert.deepEqual(fingerprint(root), before);
	assert.equal(existsSync(path.join(root, ".writer-lock")), false);
});

// ---- P4-R01: inherited version 1 behavior (expected to pass now) ----
for (const [name, options, route] of ROUTES) {
	test(`P4-R01 version 1 ${name} route: exact current JSON for every role; storeRoot naming a regular file ignored`, (t) => {
		const repo = project(t, localConfig(1), LOCAL);
		const blocker = path.join(repo.dir, "blocker");
		writeFileSync(blocker, "regular file, not a store\n");
		const before = fingerprint(repo.dir);
		for (const role of ROLES) {
			const expected = expectedV1(options, route, role);
			assert.deepEqual(
				json(resolveInstructions({ root: repo.root, ...options, role })),
				expected,
			);
			assert.deepEqual(
				json(
					resolveInstructions({
						root: repo.root,
						...options,
						role,
						storeRoot: blocker,
					}),
				),
				expected,
			);
		}
		assert.deepEqual(fingerprint(repo.dir), before);
	});
}

// ---- P4-R02: version 2 without package bindings ----
for (const [name, options, route] of ROUTES) {
	const equal = "version 2 result equals the version 1 oracle for every role";
	const ignored =
		"storeRoot naming a regular file is ignored; repository and file bytes unchanged";
	v2(
		`P4-R02 version 2 local-only ${name} route equals version 1; unusable storeRoot untouched`,
		[equal, ignored],
		(t, reach) => {
			const repo = project(t, localConfig(2), LOCAL);
			const blocker = path.join(repo.dir, "blocker");
			writeFileSync(blocker, "regular file, not a store\n");
			const before = fingerprint(repo.dir);
			for (const role of ROLES)
				assert.deepEqual(
					json(resolveInstructions({ root: repo.root, ...options, role })),
					expectedV1(options, route, role),
				);
			reach(equal);
			for (const role of ROLES)
				assert.deepEqual(
					json(
						resolveInstructions({
							root: repo.root,
							...options,
							role,
							storeRoot: blocker,
						}),
					),
					expectedV1(options, route, role),
				);
			assert.deepEqual(fingerprint(repo.dir), before);
			reach(ignored);
		},
	);
}
{
	const ok =
		"positive sibling: version 2 local-only default route equals the version 1 oracle";
	const no = "version 4 rejects at version";
	v2("P4-R02 version 4 rejects at version", [ok, no], (t, reach) => {
		const repo = project(t, localConfig(2), LOCAL);
		assert.deepEqual(
			json(resolveInstructions({ root: repo.root })),
			expectedV1({}, DEFAULT_ROUTE, undefined),
		);
		reach(ok);
		repo.write(localConfig(4));
		rejects(() => resolveInstructions({ root: repo.root }), [/^version: /]);
		reach(no);
	});
}

// ---- P4-R03: binding default from the verified store ----
{
	const a =
		"required entry: instruction/inject with package record, backing and path null";
	const b = "loaded skill content equals raw 1.0.0 SKILL.md bytes";
	const c =
		"local profile and role entries keep their paths and gain no package keys";
	v2(
		"P4-R03 example-small reviewer loads @example/security-review@1.0.0 by binding-default",
		[a, b, c],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, SMALL);
			const required = skillEntry(result, "security-review");
			assert.deepEqual(
				[required.type, required.delivery],
				["instruction", "inject"],
			);
			assertPackage(
				required,
				"security-review@1.0.0",
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(a);
			assert.deepEqual(kinds(result), [
				["profile", "scaffolded"],
				["role", "reviewer"],
				["required-skill", "security-review"],
			]);
			assertPackage(
				result.loaded[2],
				"security-review@1.0.0",
				record("security-review@1.0.0", "skills.security-review"),
			);
			assertBytes(result.loaded[2], "security-review@1.0.0");
			reach(b);
			assert.deepEqual(
				result.loaded
					.slice(0, 2)
					.map((entry) => [
						entry.path,
						entry.content,
						"package" in entry,
						"backing" in entry,
					]),
				[
					[
						".agent-profiles/profiles/scaffolded.md",
						LOCAL["profiles/scaffolded.md"],
						false,
						false,
					],
					[
						".agent-profiles/roles/reviewer.md",
						LOCAL["roles/reviewer.md"],
						false,
						false,
					],
				],
			);
			reach(c);
		},
	);
}
{
	const ok = "positive sibling with the complete store selects 1.0.0";
	const no =
		"store lacking 1.0.0 rejects missing-package naming skills.security-review and @example/security-review@1.0.0";
	v2(
		"P4-R03 store lacking @example/security-review@1.0.0 fails missing-package",
		[ok, no],
		(t, reach) => {
			const repo = project(t, base());
			assertSmall(resolve(repo.root, SMALL));
			reach(ok);
			const store = buildStore(scratch(t), except("security-review@1.0.0"));
			rejects(
				() => resolve(repo.root, SMALL, store.root),
				[
					"missing-package",
					"skills.security-review",
					"@example/security-review@1.0.0",
				],
			);
			reach(no);
		},
	);
}

// ---- P4-R04: two models and an alias select different exact revisions ----
{
	const a =
		"example-large reviewer selects 2.0.0 by large-review with its selectors";
	const b =
		"loaded content equals raw 2.0.0 bytes and differs from 1.0.0 provenance";
	v2(
		"P4-R04 example-large reviewer selects @example/security-review@2.0.0 by large-review",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, LARGE_REVIEW);
			assertPackage(
				skillEntry(result, "security-review"),
				"security-review@2.0.0",
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"large-review",
					LARGE_REVIEW,
				),
			);
			reach(a);
			const loaded = result.loaded.find(
				(entry) => entry.id === "security-review",
			);
			assertBytes(loaded, "security-review@2.0.0");
			assert.notEqual(loaded.package.sha256, digest("security-review@1.0.0"));
			reach(b);
		},
	);
}
{
	const a = "alias routes as alias to canonical example-large";
	const b = "alias selects the same 2.0.0 record as the canonical model";
	v2(
		"P4-R04 example-large-alias reviewer selects the same 2.0.0 revision",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, {
				model: "example-large-alias",
				role: "reviewer",
			});
			assert.deepEqual(
				[result.matchedBy, result.identity.canonical],
				["alias", "example-large"],
			);
			reach(a);
			assert.deepEqual(
				skillEntry(result, "security-review").package,
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"large-review",
					LARGE_REVIEW,
				),
			);
			assertBytes(
				result.loaded.find((entry) => entry.id === "security-review"),
				"security-review@2.0.0",
			);
			reach(b);
		},
	);
}
{
	const a = "auditor on example-large keeps available 1.0.0 by binding-default";
	v2(
		"P4-R04 auditor on example-large gets 1.0.0 (role selector does not match)",
		[a],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, {
				model: "example-large",
				role: "auditor",
			});
			assertPackage(
				result.available[0],
				"security-review@1.0.0",
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(a);
		},
	);
}
{
	const a = "example-v9 routes by family-prefix with canonical null";
	const b = "example-v9 reviewer gets 1.0.0 by binding-default, not 2.0.0";
	v2(
		"P4-R04 example-v9 prefix route gets 1.0.0, not 2.0.0",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, {
				model: "example-v9",
				role: "reviewer",
			});
			assert.deepEqual(
				[result.matchedBy, result.identity.canonical, result.profile],
				["family-prefix", null, "scaffolded"],
			);
			reach(a);
			assert.deepEqual(
				skillEntry(result, "security-review").package,
				record("security-review@1.0.0", "skills.security-review"),
			);
			assertBytes(
				result.loaded.find((entry) => entry.id === "security-review"),
				"security-review@1.0.0",
			);
			reach(b);
		},
	);
}
negative(
	"P4-R04 selector model naming the alias example-large-alias rejects at large-review",
	{
		change: (config) => {
			config.assignments["large-review"].when.model = "example-large-alias";
		},
		needles: [/^assignments\.large-review\.when\.model: /],
	},
);

// ---- P4-R05: strict selector dominance, order independence ----
const DOMINANCE = [
	[
		"model+role over model",
		LARGE_REVIEW,
		{ model: "example-large", role: "reviewer" },
		{ model: "example-large" },
	],
	[
		"role+profile over role",
		LARGE_REVIEW,
		{ role: "reviewer", profile: "autonomous" },
		{ role: "reviewer" },
	],
	[
		"host+model over host",
		{ ...LARGE_REVIEW, host: "claude" },
		{ host: "claude", model: "example-large" },
		{ host: "claude" },
	],
	["any selector over empty when", SMALL, { role: "reviewer" }, {}],
];
for (const [title, request, top, lower] of DOMINANCE) {
	const a = "dominant top-rule selects 2.0.0 with its selectors";
	const b = "reversed assignment map order selects the identical record";
	v2(
		`P4-R05 ${title}: dominant rule wins in either declaration order`,
		[a, b],
		(t, reach) => {
			const repo = project(
				t,
				withRules({
					"top-rule": rule(top),
					"lower-rule": rule(lower, "1.0.0"),
				}),
			);
			const selected = skillEntry(
				resolve(repo.root, request),
				"security-review",
			).package;
			assert.deepEqual(
				selected,
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"top-rule",
					top,
				),
			);
			reach(a);
			repo.write(
				withRules({
					"lower-rule": rule(lower, "1.0.0"),
					"top-rule": rule(top),
				}),
			);
			assert.deepEqual(
				skillEntry(resolve(repo.root, request), "security-review").package,
				selected,
			);
			reach(b);
		},
	);
	const ok = "positive sibling selects top-rule";
	const lowered =
		"without top-rule the lower rule selects 1.0.0 with its selectors";
	v2(
		`P4-R05 ${title}: removing the dominant rule leaves the lower rule selected`,
		[ok, lowered],
		(t, reach) => {
			const repo = project(
				t,
				withRules({
					"top-rule": rule(top),
					"lower-rule": rule(lower, "1.0.0"),
				}),
			);
			assert.equal(
				skillEntry(resolve(repo.root, request), "security-review").package
					.selectedBy,
				"top-rule",
			);
			reach(ok);
			repo.write(withRules({ "lower-rule": rule(lower, "1.0.0") }));
			assert.deepEqual(
				skillEntry(resolve(repo.root, request), "security-review").package,
				record(
					"security-review@1.0.0",
					"skills.security-review",
					"lower-rule",
					lower,
				),
			);
			reach(lowered);
		},
	);
}
{
	const ok = "host claude request selects host-rule 2.0.0";
	const no =
		"hostless request ignores host-rule and selects 1.0.0 by binding-default";
	v2(
		"P4-R05 hostless request ignores host-specific rules",
		[ok, no],
		(t, reach) => {
			const repo = project(
				t,
				withRules({ "host-rule": rule({ host: "claude" }) }),
			);
			assert.deepEqual(
				skillEntry(
					resolve(repo.root, { ...SMALL, host: "claude" }),
					"security-review",
				).package,
				record("security-review@2.0.0", "skills.security-review", "host-rule", {
					host: "claude",
				}),
			);
			reach(ok);
			assert.deepEqual(
				skillEntry(resolve(repo.root, SMALL), "security-review").package,
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(no);
		},
	);
}

// ---- P4-R06: conflicts over routing-reachable contexts ----
const DISJOINT = (profile = "scaffolded", version = "1.0.0") => ({
	"model-rule": rule({ model: "example-large" }),
	"profile-rule": rule({ profile }, version),
});
{
	const a = "example-large reviewer selects model-rule 2.0.0";
	const b = "example-small and example-v9 reviewers select profile-rule 1.0.0";
	const c = "default route reviewer selects binding-default";
	v2(
		"P4-R06 model and scaffolded-profile rules on one binding coexist (disjoint reachable contexts)",
		[a, b, c],
		(t, reach) => {
			const repo = project(t, withRules(DISJOINT()));
			assert.deepEqual(
				skillEntry(resolve(repo.root, LARGE_REVIEW), "security-review").package,
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"model-rule",
					{ model: "example-large" },
				),
			);
			reach(a);
			for (const model of ["example-small", "example-v9"]) {
				assert.deepEqual(
					skillEntry(
						resolve(repo.root, { model, role: "reviewer" }),
						"security-review",
					).package,
					record(
						"security-review@1.0.0",
						"skills.security-review",
						"profile-rule",
						{ profile: "scaffolded" },
					),
				);
			}
			reach(b);
			assert.deepEqual(
				skillEntry(resolve(repo.root, { role: "reviewer" }), "security-review")
					.package,
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(c);
		},
	);
}
{
	const a = "roles.auditor selects 1.1.0 by role-large";
	const b =
		"skills.security-review selects 2.0.0 by skill-large with the equal selector";
	v2(
		"P4-R06 equal selectors on two different bindings coexist",
		[a, b],
		(t, reach) => {
			const repo = project(
				t,
				withRules({
					"skill-large": rule({ model: "example-large" }),
					"role-large": rule(
						{ model: "example-large" },
						"1.1.0",
						"roles.auditor",
					),
				}),
			);
			const result = resolve(repo.root, {
				model: "example-large",
				role: "auditor",
			});
			assertPackage(
				result.loaded[1],
				"auditor-role@1.1.0",
				record("auditor-role@1.1.0", "roles.auditor", "role-large", {
					model: "example-large",
				}),
			);
			reach(a);
			assert.deepEqual(
				result.available[0].package,
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"skill-large",
					{ model: "example-large" },
				),
			);
			reach(b);
		},
	);
}
for (const version of ["1.0.0", "2.0.0"]) {
	const ok = `positive sibling: disjoint rules (profile-rule ${version}) resolve`;
	const no =
		"profile-rule on autonomous rejects as ambiguous naming both rules and the binding, even for example-small";
	v2(
		`P4-R06 overlapping model-rule and autonomous profile-rule reject (profile-rule version ${version})`,
		[ok, no],
		(t, reach) => {
			const repo = project(t, withRules(DISJOINT("scaffolded", version)));
			assert.equal(
				skillEntry(resolve(repo.root, SMALL), "security-review").package
					.selectedBy,
				"profile-rule",
			);
			reach(ok);
			repo.write(withRules(DISJOINT("autonomous", version)));
			rejects(
				() => resolve(repo.root, SMALL),
				["skills.security-review", "model-rule", "profile-rule", /ambiguous/],
			);
			reach(no);
		},
	);
}
{
	const ok =
		"positive sibling: one unreachable model+profile rule resolves to binding-default";
	const no =
		"an identical duplicate selector rejects naming both rules and the binding";
	v2(
		"P4-R06 duplicate identical selectors on one binding reject even if unreachable",
		[ok, no],
		(t, reach) => {
			const when = { model: "example-large", profile: "scaffolded" };
			const repo = project(t, withRules({ "dup-one": rule(when) }));
			assert.deepEqual(
				skillEntry(resolve(repo.root, LARGE_REVIEW), "security-review").package,
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(ok);
			repo.write(withRules({ "dup-one": rule(when), "dup-two": rule(when) }));
			rejects(
				() => resolve(repo.root, SMALL),
				["skills.security-review", "dup-one", "dup-two"],
			);
			reach(no);
		},
	);
}
{
	const ok = "model+profile repair-rule dominates both and selects 2.0.0";
	const no =
		"removing repair-rule rejects as ambiguous naming model-rule and profile-rule";
	v2(
		"P4-R06 adding a model+profile rule repairs the overlap",
		[ok, no],
		(t, reach) => {
			const repair = { model: "example-large", profile: "autonomous" };
			const repo = project(
				t,
				withRules({ ...DISJOINT("autonomous"), "repair-rule": rule(repair) }),
			);
			assert.deepEqual(
				skillEntry(resolve(repo.root, LARGE_REVIEW), "security-review").package,
				record(
					"security-review@2.0.0",
					"skills.security-review",
					"repair-rule",
					repair,
				),
			);
			reach(ok);
			repo.write(withRules(DISJOINT("autonomous")));
			rejects(
				() => resolve(repo.root, LARGE_REVIEW),
				["skills.security-review", "model-rule", "profile-rule", /ambiguous/],
			);
			reach(no);
		},
	);
}

// ---- P4-R07: assignment schema rejects at its field path ----
const largeReview = (config) => config.assignments["large-review"];
for (const [title, change, needles, config, files] of [
	[
		"unknown assignment field",
		(c) => {
			largeReview(c).note = "x";
		},
		[/^assignments\.large-review\.note: /],
	],
	[
		"unknown when key",
		(c) => {
			largeReview(c).when.team = "blue";
		},
		[/^assignments\.large-review\.when\.team: /],
	],
	[
		"empty versions",
		(c) => {
			largeReview(c).versions = {};
		},
		[/^assignments\.large-review\.versions: /],
	],
	[
		"unqualified binding key",
		(c) => {
			largeReview(c).versions = { "security-review": "2.0.0" };
		},
		[/^assignments\.large-review\.versions/, "security-review"],
	],
	[
		"override of a local-file skill",
		(c) => {
			largeReview(c).versions["skills.local-check"] = "1.0.0";
		},
		[/^assignments\.large-review\.versions/, "skills.local-check"],
		withExtraSkills,
		EXTRA_LOCAL_SKILL,
	],
	[
		"override of a native-host skill",
		(c) => {
			largeReview(c).versions["skills.host-check"] = "1.0.0";
		},
		[/^assignments\.large-review\.versions/, "skills.host-check"],
		withExtraSkills,
		EXTRA_LOCAL_SKILL,
	],
	[
		"undeclared role selector",
		(c) => {
			largeReview(c).when.role = "ghost";
		},
		[/^assignments\.large-review\.when\.role: /],
	],
	[
		"unreferenced profile selector",
		(c) => {
			largeReview(c).when.profile = "unused";
		},
		[/^assignments\.large-review\.when\.profile: /],
		base,
		{ "profiles/unused.md": "# Unused\n" },
	],
	[
		"unknown host selector",
		(c) => {
			largeReview(c).when.host = "nohost";
		},
		[/^assignments\.large-review\.when\.host: /],
	],
	[
		"version range ^2.0.0",
		(c) => {
			largeReview(c).versions["skills.security-review"] = "^2.0.0";
		},
		[/^assignments\.large-review\.versions\.skills\.security-review: /],
	],
])
	negative(`P4-R07 ${title} rejects at its field path`, {
		change,
		needles,
		config,
		files,
	});

// ---- P4-R08: binding shapes and local ambiguity ----
for (const [title, change, needles, config, files] of [
	[
		"skill {file, package, version}",
		(c) => {
			c.skills["security-review"].file = ".agent-profiles/extra/local-check.md";
		},
		[/^skills\.security-review/],
		base,
		EXTRA_LOCAL_SKILL,
	],
	[
		"skill {host, scope, package}",
		(c) => {
			c.skills["host-check"].package = SR;
		},
		[/^skills\.host-check/],
		withExtraSkills,
		EXTRA_LOCAL_SKILL,
	],
	[
		"skill {package} without version",
		(c) => {
			delete c.skills["security-review"].version;
		},
		[/^skills\.security-review/],
	],
	[
		"role with both file and package",
		(c, root) => {
			put(
				path.join(root, ".agent-profiles/roles/auditor.md"),
				LOCAL["roles/auditor.md"],
			);
			c.roles.auditor.file = "roles/auditor.md";
		},
		[/^roles\.auditor/],
	],
	[
		"role with neither file nor package",
		(c) => {
			delete c.roles.reviewer.file;
		},
		[/^roles\.reviewer/],
	],
	[
		"package skill plus existing .agent-profiles/skills/security-review/SKILL.md",
		(_c, root) => {
			put(
				path.join(root, ".agent-profiles/skills/security-review/SKILL.md"),
				LOCAL["skills/security-review/SKILL.md"],
			);
		},
		[/ambiguous/, "security-review"],
	],
	[
		"package profile plus existing profiles/autonomous.md",
		(_c, root) => {
			put(
				path.join(root, ".agent-profiles/profiles/autonomous.md"),
				LOCAL["profiles/autonomous.md"],
			);
		},
		[/ambiguous/, "autonomous"],
	],
])
	negative(`P4-R08 ${title} rejects`, { change, needles, config, files });

// ---- P4-R09: package type must match the binding ----
for (const [title, change, needles, config] of [
	[
		"skill binding to instruction package @example/auditor-role",
		(c) => {
			c.skills["security-review"].package = "@example/auditor-role";
		},
		["skills.security-review", "@example/auditor-role@1.0.0", /\bskill\b/],
		withoutAssignments,
	],
	[
		"role binding to skill package @example/security-review",
		(c) => {
			c.roles.auditor.package = SR;
		},
		["roles.auditor", "@example/security-review@1.0.0", /\binstruction\b/],
	],
	[
		"profile binding to skill package @example/security-review",
		(c) => {
			c.profiles.autonomous.package = SR;
		},
		[
			"profiles.autonomous",
			"@example/security-review@1.0.0",
			/\binstruction\b/,
		],
	],
])
	negative(
		`P4-R09 ${title} rejects naming binding, identity and expected type`,
		{ change, needles, config },
	);

// ---- P4-R10: package roles and profiles ----
{
	const a =
		"auditor role entry loads @example/auditor-role@1.0.0 with binding roles.auditor";
	const b = "role content equals raw 1.0.0 role.md bytes";
	v2(
		"P4-R10 package role auditor loads its verified entrypoint",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, {
				model: "example-small",
				role: "auditor",
			});
			assert.deepEqual(kinds(result), [
				["profile", "scaffolded"],
				["role", "auditor"],
			]);
			assertPackage(
				result.loaded[1],
				"auditor-role@1.0.0",
				record("auditor-role@1.0.0", "roles.auditor"),
			);
			reach(a);
			assertBytes(result.loaded[1], "auditor-role@1.0.0");
			reach(b);
		},
	);
}
{
	const a =
		"example-large profile entry loads @example/autonomous-profile@1.0.0 with binding profiles.autonomous";
	const b = "profile content equals raw profile.md bytes";
	v2(
		"P4-R10 package profile autonomous loads its verified entrypoint",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const result = resolve(repo.root, LARGE_REVIEW);
			assert.deepEqual(
				[result.profile, ...kinds(result)[0]],
				["autonomous", "profile", "autonomous"],
			);
			assertPackage(
				result.loaded[0],
				"autonomous-profile@1.0.0",
				record("autonomous-profile@1.0.0", "profiles.autonomous"),
			);
			reach(a);
			assertBytes(result.loaded[0], "autonomous-profile@1.0.0");
			reach(b);
		},
	);
}
const AUDITOR_LARGE = () => ({
	...base(),
	assignments: {
		...base().assignments,
		"auditor-large": rule({ model: "example-large" }, "1.1.0", "roles.auditor"),
	},
});
{
	const a = "example-large auditor loads 1.1.0 by auditor-large";
	const b = "example-small auditor keeps 1.0.0 by binding-default";
	v2(
		"P4-R10 rule on roles.auditor selects 1.1.0 only on example-large",
		[a, b],
		(t, reach) => {
			const repo = project(t, AUDITOR_LARGE());
			const large = resolve(repo.root, {
				model: "example-large",
				role: "auditor",
			});
			assertPackage(
				large.loaded[1],
				"auditor-role@1.1.0",
				record("auditor-role@1.1.0", "roles.auditor", "auditor-large", {
					model: "example-large",
				}),
			);
			assertBytes(large.loaded[1], "auditor-role@1.1.0");
			reach(a);
			assert.deepEqual(
				resolve(repo.root, { model: "example-small", role: "auditor" })
					.loaded[1].package,
				record("auditor-role@1.0.0", "roles.auditor"),
			);
			reach(b);
		},
	);
}
{
	const ok =
		"positive sibling: example-large auditor selects 1.1.0 by auditor-large";
	const no =
		"without the rule example-large auditor returns 1.0.0 by binding-default";
	v2(
		"P4-R10 removing the roles.auditor rule returns 1.0.0",
		[ok, no],
		(t, reach) => {
			const repo = project(t, AUDITOR_LARGE());
			assert.equal(
				resolve(repo.root, { model: "example-large", role: "auditor" })
					.loaded[1].package.version,
				"1.1.0",
			);
			reach(ok);
			repo.write(base());
			const result = resolve(repo.root, {
				model: "example-large",
				role: "auditor",
			});
			assert.deepEqual(
				result.loaded[1].package,
				record("auditor-role@1.0.0", "roles.auditor"),
			);
			assertBytes(result.loaded[1], "auditor-role@1.0.0");
			reach(no);
		},
	);
}

// ---- P4-R11: every declared pin is verified, selected or not ----
{
	const a = "every route x role x host context resolves";
	const b = "each context selects the oracle security-review record";
	v2(
		"P4-R11 all declared pins present: every context resolves",
		[a, b],
		(t, reach) => {
			const repo = project(t, base());
			const results = [];
			for (const [, options, route] of ROUTES) {
				for (const role of ROLES) {
					for (const host of [
						undefined,
						...integrations.map((adapter) => adapter.id),
					])
						results.push([
							route,
							role,
							resolve(repo.root, { ...options, role, host }),
						]);
				}
			}
			reach(a);
			for (const [route, role, result] of results)
				assert.deepEqual(
					skillEntry(result, "security-review").package,
					baseSelection(route, role),
				);
			reach(b);
		},
	);
}
// [title, pin, changed stored file (null: pin absent from the store), declaring binding or rule]
for (const [title, key, file, owner] of [
	[
		"absent unselected override @example/security-review@2.0.0",
		"security-review@2.0.0",
		null,
		"large-review",
	],
	[
		"one changed byte in the unselected 2.0.0 stored tree",
		"security-review@2.0.0",
		"resources/checklist.txt",
	],
	[
		"absent unselected base pin @example/auditor-role@1.0.0",
		"auditor-role@1.0.0",
		null,
		"roles.auditor",
	],
	[
		"one changed byte in the unselected autonomous profile entrypoint",
		"autonomous-profile@1.0.0",
		"profile.md",
	],
]) {
	const ok =
		"positive sibling: example-small reviewer resolves against the complete store";
	const no = file
		? "example-small reviewer fails with a digest finding naming the stored digest; store bytes unchanged"
		: `example-small reviewer fails missing-package naming ${owner} and the identity; store bytes unchanged`;
	v2(`P4-R11 ${title} fails even for example-small`, [ok, no], (t, reach) => {
		const repo = project(t, base());
		const store = buildStore(scratch(t), file ? ALL : except(key));
		assertSmall(
			resolve(repo.root, SMALL, file ? store.root : sharedStore().root),
		);
		reach(ok);
		if (file) corrupt(store.root, key, file);
		const before = fingerprint(store.root);
		rejects(
			() => resolve(repo.root, SMALL, store.root),
			file
				? [/digest/, digest(key)]
				: [
						"missing-package",
						owner,
						`${FIXTURES[key].name}@${FIXTURES[key].version}`,
					],
		);
		assert.deepEqual(fingerprint(store.root), before);
		reach(no);
	});
}

// ---- P4-R12: available and requested package skills ----
const AVAILABLE = () => {
	const config = base();
	config.roles.auditor.skills.required = ["checklist"];
	return config;
};
const AVAILABLE_FILES = {
	"skills/checklist/SKILL.md":
		"---\nname: checklist\ndescription: Local checklist.\n---\nChecklist body.\n",
};
const AUDITOR_SMALL = { model: "example-small", role: "auditor" };
{
	const a =
		'available entry: name security-review (never "."), description, package record, backing, path null';
	const b = "available bytes and characters measure the raw 1.0.0 entrypoint";
	const c =
		"unrequested package skill is not loaded and its body is absent from the result";
	v2(
		"P4-R12 unrequested available package skill is indexed, measured and not loaded",
		[a, b, c],
		(t, reach) => {
			const repo = project(t, AVAILABLE(), {
				...PACKAGE_FILES,
				...AVAILABLE_FILES,
			});
			const result = resolve(repo.root, AUDITOR_SMALL);
			const available = result.available[0];
			assert.deepEqual(
				[
					result.available.length,
					available.id,
					available.type,
					available.delivery,
					available.name,
					available.description,
				],
				[
					1,
					"security-review",
					"instruction",
					"inject",
					"security-review",
					"Security review one.",
				],
			);
			assertPackage(
				available,
				"security-review@1.0.0",
				record("security-review@1.0.0", "skills.security-review"),
			);
			reach(a);
			const raw = FIXTURES["security-review@1.0.0"].files["SKILL.md"];
			assert.deepEqual(
				[available.bytes, available.characters],
				[raw.length, [...raw.toString("utf8")].length],
			);
			reach(b);
			assert.deepEqual(kinds(result), [
				["profile", "scaffolded"],
				["role", "auditor"],
				["required-skill", "checklist"],
			]);
			assert.ok(!JSON.stringify(result).includes("revision one"));
			reach(c);
		},
	);
}
{
	const a = "requested package skill loads after required skills";
	const b =
		"requested entry carries the 1.0.0 package record, name security-review and raw bytes";
	v2(
		"P4-R12 requesting the available package skill loads it after required skills",
		[a, b],
		(t, reach) => {
			const repo = project(t, AVAILABLE(), {
				...PACKAGE_FILES,
				...AVAILABLE_FILES,
			});
			const result = resolve(repo.root, {
				...AUDITOR_SMALL,
				skills: ["security-review"],
			});
			assert.deepEqual(kinds(result), [
				["profile", "scaffolded"],
				["role", "auditor"],
				["required-skill", "checklist"],
				["requested-skill", "security-review"],
			]);
			reach(a);
			assertPackage(
				result.loaded[3],
				"security-review@1.0.0",
				record("security-review@1.0.0", "skills.security-review"),
			);
			assertBytes(result.loaded[3], "security-review@1.0.0");
			assert.equal(result.available[0].name, "security-review");
			reach(b);
		},
	);
}
{
	const ok = "positive sibling: auditor request for security-review loads it";
	const no = "without security-review in auditor available the request rejects";
	v2(
		"P4-R12 unpermitted package skill request still rejects",
		[ok, no],
		(t, reach) => {
			const repo = project(t, AVAILABLE(), {
				...PACKAGE_FILES,
				...AVAILABLE_FILES,
			});
			assert.deepEqual(
				kinds(
					resolve(repo.root, { ...AUDITOR_SMALL, skills: ["security-review"] }),
				).at(-1),
				["requested-skill", "security-review"],
			);
			reach(ok);
			const config = AVAILABLE();
			config.roles.auditor.skills.available = [];
			repo.write(config);
			rejects(
				() =>
					resolve(repo.root, { ...AUDITOR_SMALL, skills: ["security-review"] }),
				["role auditor", "security-review"],
			);
			reach(no);
		},
	);
}

// ---- P4-R13: native package delivery and host compatibility ----
const NATIVE = () => {
	const config = base();
	config.skills["native-check"] = {
		package: "@example/native-check",
		version: "1.0.0",
	};
	config.roles.reviewer.skills.required.push("native-check");
	return config;
};
function nativeOutcome(result) {
	const native = skillEntry(result, "native-check");
	assert.deepEqual([native.type, native.delivery], ["host", "invoke"]);
	assertPackage(
		native,
		"native-check@1.0.0",
		record("native-check@1.0.0", "skills.native-check"),
	);
	assert.ok(!result.loaded.some((entry) => entry.id === "native-check"));
	return [native.usable, result.unsatisfied.map((entry) => entry.id)];
}
{
	const a =
		"hostless: typed host/invoke package entry, never loaded, compatibility null, nothing unsatisfied";
	const b = "host claude: compatible, never loaded, nothing unsatisfied";
	v2(
		"P4-R13 required native package skill is never loaded; claude-compatible; hostless null",
		[a, b],
		(t, reach) => {
			const repo = project(t, NATIVE());
			assert.deepEqual(nativeOutcome(resolve(repo.root, SMALL)), [null, []]);
			reach(a);
			assert.deepEqual(
				nativeOutcome(resolve(repo.root, { ...SMALL, host: "claude" })),
				[true, []],
			);
			reach(b);
		},
	);
}
{
	const ok = "positive sibling: host claude is compatible";
	const no = "host codex: incompatible and listed in unsatisfied, never loaded";
	v2(
		"P4-R13 host codex lists the native package skill as unsatisfied",
		[ok, no],
		(t, reach) => {
			const repo = project(t, NATIVE());
			assert.deepEqual(
				nativeOutcome(resolve(repo.root, { ...SMALL, host: "claude" })),
				[true, []],
			);
			reach(ok);
			assert.deepEqual(
				nativeOutcome(resolve(repo.root, { ...SMALL, host: "codex" })),
				[false, ["native-check"]],
			);
			reach(no);
		},
	);
}

// ---- P4-R14: explicit store beats a misleading environment ----
{
	const ok =
		"explicit storeRoot A returns A digest and bytes while AGENT_PROFILES_STORE names B";
	const no =
		"omitting storeRoot returns B digest and bytes (precedence, not fallback)";
	v2(
		"P4-R14 explicit storeRoot beats AGENT_PROFILES_STORE",
		[ok, no],
		(t, reach) => {
			const storeB = buildStore(scratch(t), ["security-review@1.0.0"], {
				"security-review@1.0.0": STORE_B_FILES,
			});
			storeEnv(t, storeB.root);
			const repo = project(t, singlePin(), SINGLE_PIN_FILES);
			const fromA = resolve(repo.root, SMALL);
			assert.deepEqual(
				skillEntry(fromA, "security-review").package,
				record("security-review@1.0.0", "skills.security-review"),
			);
			assertBytes(fromA.loaded[2], "security-review@1.0.0");
			reach(ok);
			const fromB = resolveInstructions({
				root: repo.root,
				lockMode: "validation",
				...SMALL,
			});
			assert.equal(
				skillEntry(fromB, "security-review").package.sha256,
				storeB.imports["security-review@1.0.0"].sha256,
			);
			assert.deepEqual(
				Buffer.from(fromB.loaded[2].content, "utf8"),
				STORE_B_FILES["SKILL.md"],
			);
			reach(no);
		},
	);
}

// ---- P4-R15: no lock writes or selection effect (validation reports it invalid); read-only fingerprints ----
{
	const a =
		"resolution with an arbitrary lock file equals resolution without it";
	const b = "lock bytes and repository fingerprint unchanged";
	const c =
		"store fingerprint unchanged; no .writer-lock or staging entry created";
	v2(
		"P4-R15 arbitrary agent-profiles.lock is ignored; repository and store bytes unchanged",
		[a, b, c],
		(t, reach) => {
			const repo = project(t, base());
			const store = sharedStore().root;
			const storeBefore = fingerprint(store);
			const requests = [LARGE_REVIEW, AUDITOR_SMALL];
			const without = requests.map((request) => resolve(repo.root, request));
			const lock = path.join(repo.root, ".agent-profiles/agent-profiles.lock");
			const lockBytes = Buffer.from(
				'{"lockVersion": 999, "pins": "arbitrary"\n',
			);
			writeFileSync(lock, lockBytes);
			const repoBefore = fingerprint(repo.root);
			const withLock = requests.map((request) => resolve(repo.root, request));
			assert.deepEqual(
				withLock.map((result) => ({ ...result, lockState: "missing" })),
				without,
				"only the reported lock state differs",
			);
			assert.deepEqual(
				withLock.map((result) => [result.lockState, result.installRequired]),
				[
					["invalid", true],
					["invalid", true],
				],
			);
			assert.equal(
				skillEntry(withLock[0], "security-review").package.version,
				"2.0.0",
			);
			reach(a);
			assert.deepEqual(readFileSync(lock), lockBytes);
			assert.deepEqual(fingerprint(repo.root), repoBefore);
			reach(b);
			assert.deepEqual(fingerprint(store), storeBefore);
			assert.equal(existsSync(path.join(store, ".writer-lock")), false);
			assert.deepEqual(
				existsSync(path.join(store, ".staging"))
					? readdirSync(path.join(store, ".staging"))
					: [],
				[],
			);
			reach(c);
		},
	);
}

// ---- P4-R16: assignments never change routing ----
for (const [name, options, route] of ROUTES) {
	const a = "routing fields equal those of the same config without assignments";
	const b = "routing fields equal the independent routing oracle";
	v2(
		`P4-R16 ${name} route: assignments leave matchedBy, identity, profile, role and roleSource unchanged`,
		[a, b],
		(t, reach) => {
			const assigned = project(t, base());
			const plain = project(t, withoutAssignments());
			const observed = [];
			for (const role of ROLES) {
				for (const host of [undefined, "claude"]) {
					observed.push([
						role,
						host,
						routingFields(resolve(assigned.root, { ...options, role, host })),
						routingFields(resolve(plain.root, { ...options, role, host })),
					]);
				}
			}
			for (const [, , withAssignments, without] of observed)
				assert.deepEqual(withAssignments, without);
			reach(a);
			for (const [role, host, fields] of observed)
				assert.deepEqual(fields, routingOf(options, route, role, host));
			reach(b);
		},
	);
}
