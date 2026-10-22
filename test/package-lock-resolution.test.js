import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { stringify } from "yaml";
import { applyRoleChange, planRoleChange } from "../src/configure.ts";
import { inspectRepository } from "../src/inspect.js";
import { doctor } from "../src/install.js";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage, lookupPackage } from "../src/package-store.ts";
import { runPreset } from "../src/preset-wizard.ts";
import {
	applyPresetExport,
	applyPresetImport,
	planPresetExport,
	planPresetImport,
} from "../src/presets.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { startVisualizer } from "../src/visualize.ts";
import { configureRoles } from "../src/wizard.ts";

// P5b RED (contract section 6 "Resolver lock modes and store-root propagation", test map C10-C12/C20-C22):
// public selection defaults to lockMode "required"; configure/preset internals use "validation".
// Each case builds its own owned os.tmpdir() root: an explicit store, an empty store and a misleading ambient
// store holding the same identities with different bytes. Locks are written only by real installDependencies.
// Cases marked "guard" already pass on unchanged source; they pin behavior GREEN must not break.

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const NAME = "@lock/review";
const VERSIONS = ["1.0.0", "2.0.0", "3.0.0"];
const BIN = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const body = (version, label) =>
	`---\ndescription: Review ${version}.\n---\nReview body ${version} from the ${label} store.\r\n`;
const LOCKED = {
	lockState: "valid",
	lockMode: "required",
	installRequired: false,
};
const lockFields = (result) => ({
	lockState: result.lockState,
	lockMode: result.lockMode,
	installRequired: result.installRequired,
});

function store(dir, name, label) {
	const root = path.join(dir, name),
		digests = {};
	fs.mkdirSync(root);
	for (const version of VERSIONS) {
		const source = path.join(dir, `${name}-sources`, version);
		put(
			path.join(source, "package.yaml"),
			`schema_version: 1\npackage:\n  name: "${NAME}"\n  version: "${version}"\n  type: skill\nentrypoint: SKILL.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n`,
		);
		put(path.join(source, "SKILL.md"), body(version, label));
		digests[version] = importPackage({
			sourceDirectory: source,
			storeRoot: root,
		}).sha256;
	}
	return { root, digests };
}

// Two routes select different exact revisions; the writer-only override is declared but never selected.
const packaged = () => ({
	version: 2,
	default_profile: "base",
	default_role: "reviewer",
	models: {
		"model-large": { profile: "base" },
		"model-small": { profile: "base" },
	},
	families: {},
	roles: {
		reviewer: {
			file: "roles/reviewer.md",
			description: "Review changes",
			skills: { required: ["review"], available: [] },
		},
		writer: {
			file: "roles/writer.md",
			skills: { required: [], available: [] },
		},
	},
	skills: { review: { package: NAME, version: "1.0.0" } },
	assignments: {
		large: {
			when: { model: "model-large", role: "reviewer" },
			versions: { "skills.review": "2.0.0" },
		},
		unused: {
			when: { role: "writer" },
			versions: { "skills.review": "3.0.0" },
		},
	},
});
const local = () => {
	const config = packaged();
	config.roles.reviewer.skills.required = [];
	delete config.skills;
	delete config.assignments;
	return config;
};

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

function fingerprint(root, exclusions = []) {
	if (!fs.existsSync(root)) return null;
	return fs
		.readdirSync(root, { recursive: true })
		.map((file) => String(file).split(path.sep).join("/"))
		.filter((label) => !exclusions.includes(label))
		.sort()
		.map((label) => {
			const full = path.join(root, label);
			return fs.statSync(full).isDirectory()
				? `${label}/`
				: `${label} ${sha(fs.readFileSync(full))}`;
		});
}

/** @param {any} t @param {{locked?: boolean, ambient?: 'empty' | 'misleading', configuration?: any}} [options] */
function setup(
	t,
	{ locked = true, ambient = "misleading", configuration = packaged() } = {},
) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p5b-lock-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const explicit = store(dir, "store", "explicit");
	const misleading = store(dir, "ambient-store", "ambient");
	const empty = path.join(dir, "empty-store"),
		home = path.join(dir, "home");
	fs.mkdirSync(empty);
	fs.mkdirSync(home);
	setEnv(t, {
		AGENT_PROFILES_STORE: ambient === "empty" ? empty : misleading.root,
		HOME: home,
		USERPROFILE: home,
	});
	const root = path.join(dir, "repo");
	put(
		path.join(root, ".agent-profiles/profiles/base.md"),
		"# Base\nWork carefully.\n",
	);
	put(
		path.join(root, ".agent-profiles/roles/reviewer.md"),
		"# Reviewer\nReview changes.\n",
	);
	put(
		path.join(root, ".agent-profiles/roles/writer.md"),
		"# Writer\nWrite documentation.\n",
	);
	put(path.join(root, CONFIG), stringify(configuration));
	if (locked) installDependencies({ root, storeRoot: explicit.root });
	const f = {
		dir,
		root,
		explicit,
		misleading,
		empty,
		home,
		storeRoot: explicit.root,
		configuration,
		lock: () =>
			fs.existsSync(path.join(root, LOCK))
				? fs.readFileSync(path.join(root, LOCK))
				: null,
		config: () => fs.readFileSync(path.join(root, CONFIG)),
		state: () => [
			fingerprint(root),
			fingerprint(explicit.root),
			fingerprint(misleading.root),
			fingerprint(empty),
			fingerprint(home),
		],
		resolve: (options = {}) =>
			resolveInstructions({
				root,
				storeRoot: explicit.root,
				model: "model-large",
				role: "reviewer",
				...options,
			}),
		edit(mutate) {
			mutate(f.configuration);
			put(path.join(root, CONFIG), stringify(f.configuration));
		},
		mutateLock(mutate) {
			const lock = JSON.parse(f.lock().toString("utf8"));
			mutate(lock);
			put(path.join(root, LOCK), JSON.stringify(lock));
		},
	};
	return f;
}

// Fixture prerequisite, independent of lock enforcement: a real complete lock, distinct stores, and the
// explicit store's exact bytes through the accepted P4 validation seam.
function prerequisite(f) {
	const lock = JSON.parse(f.lock().toString("utf8"));
	const d = f.explicit.digests;
	assert.deepEqual(
		[lock.lockVersion, lock.configurationVersion, lock.resolverContract],
		[1, 2, "agent-profiles/resolver/v2"],
	);
	assert.match(lock.configSha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(
		lock.pins,
		[
			["1.0.0", null],
			["2.0.0", "large"],
			["3.0.0", "unused"],
		].map(([version, rule]) => ({
			binding: "skills.review",
			rule,
			package: NAME,
			version,
			sha256: d[version],
		})),
		"lock covers base, selected and unselected override pins",
	);
	assert.deepEqual(
		lock.packages,
		VERSIONS.map((version) => ({
			name: NAME,
			version,
			sha256: d[version],
			source: { type: "provided" },
		})),
	);
	for (const version of VERSIONS) {
		assert.equal(
			lookupPackage({ storeRoot: f.explicit.root, name: NAME, version }).sha256,
			d[version],
		);
		assert.notEqual(
			f.misleading.digests[version],
			d[version],
			"ambient store must hold different bytes",
		);
	}
	const large = f.resolve({ lockMode: "validation" });
	assert.deepEqual(large.required[0].package, {
		binding: "skills.review",
		name: NAME,
		version: "2.0.0",
		sha256: d["2.0.0"],
		selectedBy: "large",
		selectors: { model: "model-large", role: "reviewer" },
	});
	assert.equal(
		large.loaded.find((entry) => entry.id === "review").content,
		body("2.0.0", "explicit"),
	);
	return lock;
}

// Native write sentinel: records (and still performs) every write-capable fs call, including production named imports.
function writeSentinel(t) {
	const calls = [],
		mocks = [];
	for (const name of [
		"writeFileSync",
		"appendFileSync",
		"renameSync",
		"mkdirSync",
		"mkdtempSync",
		"rmSync",
		"rmdirSync",
		"unlinkSync",
		"copyFileSync",
		"cpSync",
		"linkSync",
		"symlinkSync",
		"truncateSync",
		"openSync",
	]) {
		const original = fs[name];
		mocks.push(
			t.mock.method(fs, name, function (...args) {
				const flags = args[1];
				const reading =
					name === "openSync" &&
					(typeof flags === "number"
						? (flags &
								(fs.constants.O_WRONLY |
									fs.constants.O_RDWR |
									fs.constants.O_CREAT |
									fs.constants.O_TRUNC |
									fs.constants.O_APPEND)) ===
							0
						: ["r", "rs", "sr"].includes(flags ?? "r"));
				if (!reading) calls.push(`${name} ${String(args[0])}`);
				return original.apply(this, args);
			}),
		);
	}
	syncBuiltinESMExports();
	return {
		calls,
		close() {
			for (const mock of mocks) mock.mock.restore();
			syncBuiltinESMExports();
		},
	};
}
function readOnly(t, fn) {
	const sentinel = writeSentinel(t);
	try {
		return fn();
	} finally {
		sentinel.close();
		assert.deepEqual(sentinel.calls, [], "read-only resolve attempted a write");
	}
}

// Real late failure: after the configuration rename commits, change one byte of a declared package in the explicit store.
function afterConfigRename(t, f, action) {
	const original = fs.renameSync,
		target = path.join(f.root, CONFIG);
	let fired = 0;
	const mock = t.mock.method(fs, "renameSync", function (from, to) {
		const result = original.call(this, from, to);
		if (!fired && path.resolve(String(to)) === target) {
			fired++;
			action();
		}
		return result;
	});
	syncBuiltinESMExports();
	return {
		fired: () => fired,
		close() {
			mock.mock.restore();
			syncBuiltinESMExports();
		},
	};
}
function corrupt(f, version) {
	const file = path.join(
		f.explicit.root,
		"objects/sha256",
		f.explicit.digests[version],
		"tree/SKILL.md",
	);
	assert.ok(fs.existsSync(file), "fixture store layout");
	fs.appendFileSync(file, "x");
}

function refuses(fn, pattern) {
	assert.throws(fn, (error) => {
		assert.match(error.message, pattern);
		assert.doesNotMatch(
			error.message,
			/missing-package/,
			`refusal came from package loading: ${error.message}`,
		);
		return true;
	});
}

// ---- fixture machinery (expected PASS) ----

test("P5B-F01 fixture prerequisite: real installDependencies writes a complete lock for distinct explicit/ambient stores", (t) => {
	const f = setup(t);
	const before = f.state();
	prerequisite(f);
	assert.deepEqual(f.state(), before, "prerequisite resolution wrote files");
	const zero = setup(t, { locked: false, configuration: local() });
	assert.equal(zero.lock(), null);
	assert.deepEqual(
		zero.resolve({ lockMode: "validation" }).loaded.map((entry) => entry.path),
		[".agent-profiles/profiles/base.md", ".agent-profiles/roles/reviewer.md"],
	);
});

test("P5B-F02 fingerprint excludes only the permitted forward-slash label and detects protected changes", (t) => {
	const f = setup(t);
	const before = fingerprint(f.root, [LOCK]);
	assert.ok(
		before.some((line) => line.startsWith(`${CONFIG} `)) &&
			before.every((line) => !line.includes("\\")),
	);
	put(path.join(f.root, LOCK), "permitted change");
	assert.deepEqual(fingerprint(f.root, [LOCK]), before);
	put(path.join(f.root, ".agent-profiles/roles/writer.md"), "protected change");
	assert.notDeepEqual(fingerprint(f.root, [LOCK]), before);
});

test("P5B-F03 write sentinel observes production named-import writes and a read-only resolve records none", (t) => {
	const f = setup(t);
	const sentinel = writeSentinel(t);
	try {
		importPackage({
			sourceDirectory: path.join(f.dir, "store-sources", "1.0.0"),
			storeRoot: path.join(f.dir, "scratch-store"),
		});
	} finally {
		sentinel.close();
	}
	assert.ok(
		sentinel.calls.some((call) => call.startsWith("mkdirSync ")),
		JSON.stringify(sentinel.calls),
	);
	readOnly(t, () => f.resolve({ lockMode: "validation" }));
});

// ---- 1. public required mode ----

test("P5B-R01 public default resolve with a valid complete lock reports valid/required and the exact locked selection", (t) => {
	const f = setup(t);
	const lock = prerequisite(f),
		bytes = f.lock(),
		before = f.state();
	const [large, small, explicit] = readOnly(t, () => [
		f.resolve(),
		f.resolve({ model: "model-small" }),
		f.resolve({ lockMode: "required" }),
	]);
	assert.deepEqual(f.state(), before);
	assert.deepEqual(f.lock(), bytes);
	assert.deepEqual(large.required[0].package, {
		binding: "skills.review",
		name: NAME,
		version: "2.0.0",
		sha256: f.explicit.digests["2.0.0"],
		selectedBy: "large",
		selectors: { model: "model-large", role: "reviewer" },
	});
	assert.equal(
		large.required[0].package.sha256,
		lock.pins.find((pin) => pin.rule === "large").sha256,
	);
	assert.equal(
		large.loaded.find((entry) => entry.id === "review").content,
		body("2.0.0", "explicit"),
	);
	assert.deepEqual(
		[
			small.required[0].package.version,
			small.required[0].package.sha256,
			small.required[0].package.selectedBy,
		],
		["1.0.0", f.explicit.digests["1.0.0"], "binding-default"],
	);
	for (const result of [large, small, explicit])
		assert.deepEqual(lockFields(result), LOCKED);
});

test("P5B-R02 public resolve of v2 with zero package pins needs no lock and leaves a leftover lock untouched", (t) => {
	const f = setup(t, { locked: false, configuration: local() });
	const expected = {
		lockState: "not-required",
		lockMode: "required",
		installRequired: false,
	};
	const unusable = path.join(f.dir, "not-a-store");
	put(unusable, "regular file");
	const before = f.state();
	const fresh = readOnly(t, () => f.resolve({ storeRoot: unusable }));
	assert.deepEqual(f.state(), before);
	assert.equal(f.lock(), null);
	assert.deepEqual(
		fresh.loaded.map((entry) => entry.path),
		[".agent-profiles/profiles/base.md", ".agent-profiles/roles/reviewer.md"],
	);
	assert.deepEqual(lockFields(fresh), expected);
	for (const leftover of [
		'{"leftover": not json',
		JSON.stringify({ lockVersion: 1, pins: [{ binding: "skills.gone" }] }),
	]) {
		put(path.join(f.root, LOCK), leftover);
		const result = readOnly(t, () => f.resolve());
		assert.deepEqual(
			f.lock(),
			Buffer.from(leftover),
			"leftover lock is not dependency authority and stays unchanged",
		);
		assert.deepEqual(lockFields(result), expected);
	}
});

test("P5B-R03 unknown or invalid lockMode values reject specifically", (t) => {
	const f = setup(t);
	prerequisite(f);
	assert.equal(f.resolve().required[0].package.version, "2.0.0");
	for (const mode of ["required", "validation"])
		assert.doesNotThrow(() => f.resolve({ lockMode: mode }), mode);
	for (const mode of ["frozen", "REQUIRED", "", null, 1, true]) {
		assert.throws(
			() => f.resolve({ lockMode: mode }),
			/lockMode/,
			`lockMode ${JSON.stringify(mode)} must reject`,
		);
	}
});

const refusals = [
	[
		"missing lock",
		(f) => fs.rmSync(path.join(f.root, LOCK)),
		/agent-profiles\.lock/,
		true,
	],
	[
		"malformed lock",
		(f) => put(path.join(f.root, LOCK), '{"lockVersion": 1,'),
		/lock/i,
		true,
	],
	[
		"unsupported lock version",
		(f) =>
			f.mutateLock((lock) => {
				lock.lockVersion = 3;
			}),
		/lockVersion/,
		true,
	],
	[
		"stale lock after a legitimate description edit",
		(f) =>
			f.edit((config) => {
				config.roles.reviewer.description = "Changed";
			}),
		/stale-lock/,
		true,
	],
	[
		"incomplete lock without the unselected override pin",
		(f) =>
			f.mutateLock((lock) => {
				lock.pins = lock.pins.filter((pin) => pin.rule !== "unused");
				lock.packages = lock.packages.filter((pkg) => pkg.version !== "3.0.0");
			}),
		/lock-coverage/,
		true,
	],
	[
		"lock with an extra foreign override pin",
		(f) =>
			f.mutateLock((lock) => {
				lock.pins.push({
					binding: "skills.review",
					rule: "zz-ghost",
					package: NAME,
					version: "1.0.0",
					sha256: f.explicit.digests["1.0.0"],
				});
			}),
		/lock-coverage/,
		true,
	],
	[
		"locked digest that differs from the verified store",
		(f) =>
			f.mutateLock((lock) => {
				for (const entry of [...lock.pins, ...lock.packages])
					if (entry.version === "2.0.0")
						entry.sha256 = f.misleading.digests["2.0.0"];
			}),
		/mismatched-package/,
		false,
	],
];
for (const [name, mutate, pattern, lockOnly] of refusals) {
	test(`P5B-R04 public required resolve refuses ${name} before selected package loading`, (t) => {
		const f = setup(t);
		prerequisite(f);
		assert.equal(
			f.resolve().required[0].package.sha256,
			f.explicit.digests["2.0.0"],
			"valid sibling resolves",
		);
		mutate(f);
		const bytes = f.lock(),
			before = f.state();
		readOnly(t, () => refuses(() => f.resolve(), pattern));
		// An empty explicit store cannot mask a lock-state refusal as missing-package.
		if (lockOnly)
			readOnly(t, () =>
				refuses(() => f.resolve({ storeRoot: f.empty }), pattern),
			);
		assert.deepEqual(f.lock(), bytes, "lock was repaired or rewritten");
		assert.deepEqual(f.state(), before, "refusal wrote project/store/home");
	});
}

test("P5B-R05 public required resolve refuses explicit store bytes that differ from the lock, without fallback", (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const before = f.state();
	readOnly(t, () =>
		refuses(
			() => f.resolve({ storeRoot: f.misleading.root }),
			/mismatched-package/,
		),
	);
	// Explicit empty store with the correct bytes elsewhere: missing, never a silent ambient/home substitute.
	setEnv(t, { AGENT_PROFILES_STORE: f.explicit.root });
	assert.throws(
		() => f.resolve({ storeRoot: f.empty }),
		/missing-package|agent-profiles\.lock/,
	);
	assert.deepEqual(f.state(), before);
});

// ---- 2. internal validation mode ----

const validationStates = [
	["valid lock", (_f) => {}, "valid", false, "2.0.0"],
	[
		"missing lock",
		(f) => fs.rmSync(path.join(f.root, LOCK)),
		"missing",
		true,
		"2.0.0",
	],
	// The current configuration selects 3.0.0; the stale lock still pins 2.0.0 and must not be used.
	[
		"stale lock",
		(f) =>
			f.edit((config) => {
				config.assignments.large.versions["skills.review"] = "3.0.0";
			}),
		"stale",
		true,
		"3.0.0",
	],
	[
		"malformed lock",
		(f) => put(path.join(f.root, LOCK), "not json"),
		"invalid",
		true,
		"2.0.0",
	],
	[
		"coverage-invalid lock",
		(f) =>
			f.mutateLock((lock) => {
				lock.pins = lock.pins.filter((pin) => pin.rule !== "unused");
			}),
		"invalid",
		true,
		"2.0.0",
	],
];
for (const [
	name,
	mutate,
	lockState,
	installRequired,
	version,
] of validationStates) {
	test(`P5B-V01 validation mode with ${name} selects verified store bytes and reports ${lockState}`, (t) => {
		const f = setup(t);
		prerequisite(f);
		mutate(f);
		const bytes = f.lock(),
			before = f.state();
		const result = readOnly(t, () => f.resolve({ lockMode: "validation" }));
		assert.deepEqual(
			[result.required[0].package.version, result.required[0].package.sha256],
			[version, f.explicit.digests[version]],
		);
		assert.equal(
			result.loaded.find((entry) => entry.id === "review").content,
			body(version, "explicit"),
		);
		assert.deepEqual(
			f.lock(),
			bytes,
			"validation repaired or rewrote the lock",
		);
		assert.deepEqual(f.state(), before);
		assert.deepEqual(lockFields(result), {
			lockState,
			lockMode: "validation",
			installRequired,
		});
	});
}

test("P5B-V02 validation mode of v2 with zero package pins reports not-required", (t) => {
	const f = setup(t, { locked: false, configuration: local() });
	const result = readOnly(t, () => f.resolve({ lockMode: "validation" }));
	assert.equal(f.lock(), null);
	assert.deepEqual(lockFields(result), {
		lockState: "not-required",
		lockMode: "validation",
		installRequired: false,
	});
});

test("P5B-V03 guard: validation mode still rejects ambiguity and missing or corrupt package bytes without touching the lock", (t) => {
	const f = setup(t);
	prerequisite(f);
	const bytes = f.lock();
	f.edit((config) => {
		config.assignments.small = {
			when: { model: "model-small" },
			versions: { "skills.review": "2.0.0" },
		};
		config.assignments.role = {
			when: { role: "reviewer" },
			versions: { "skills.review": "2.0.0" },
		};
	});
	assert.throws(
		() => f.resolve({ lockMode: "validation" }),
		/skills\.review: ambiguous assignments role, small/,
	);
	f.edit((config) => {
		delete config.assignments.small;
		delete config.assignments.role;
	});
	assert.throws(
		() => f.resolve({ lockMode: "validation", storeRoot: f.empty }),
		/missing-package @lock\/review@1\.0\.0/,
	);
	corrupt(f, "3.0.0");
	assert.throws(
		() => f.resolve({ lockMode: "validation" }),
		/assignments\.unused\.versions\.skills\.review: .*digest mismatch/,
	);
	assert.deepEqual(f.lock(), bytes);
});

// ---- 3. configure and preset preview/apply chains ----

const edits = [
	[
		"description edit of reviewer",
		{ action: "edit", id: "reviewer", description: "Review changes carefully" },
	],
	[
		"skill-list edit of writer",
		{ action: "edit", id: "writer", available: ["review"] },
	],
];

test("P5B-C01 planRoleChange preview of a legitimate edit reports validation mode, stale lock and install-required", (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const before = f.state();
	const plan = planRoleChange({
		root: f.root,
		storeRoot: f.storeRoot,
		...edits[0][1],
	});
	assert.deepEqual(
		plan.changes.map((change) => change.file),
		[CONFIG],
	);
	assert.deepEqual(f.state(), before, "preview wrote files");
	assert.equal(
		plan.resolution.required[0].package.sha256,
		f.explicit.digests["1.0.0"],
	);
	assert.deepEqual(lockFields(plan.resolution), {
		lockState: "stale",
		lockMode: "validation",
		installRequired: true,
	});
});

for (const [name, input] of edits) {
	test(`P5B-C02 applyRoleChange ${name} commits through validation and returns install-required with the old lock unchanged`, (t) => {
		const f = setup(t, { ambient: "empty" });
		prerequisite(f);
		const bytes = f.lock(),
			store = fingerprint(f.storeRoot);
		const plan = planRoleChange({
			root: f.root,
			storeRoot: f.storeRoot,
			...input,
		});
		const result = applyRoleChange(plan);
		assert.deepEqual(result.modified, [CONFIG]);
		assert.deepEqual(f.config(), plan.after);
		assert.deepEqual(
			f.lock(),
			bytes,
			"configure re-locked or rewrote the lock",
		);
		assert.deepEqual(fingerprint(f.storeRoot), store);
		assert.deepEqual(lockFields(result.resolution), {
			lockState: "stale",
			lockMode: "validation",
			installRequired: true,
		});
	});
}

test("P5B-C03 after a committed configure edit, public required resolve refuses the stale lock", (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const bytes = f.lock();
	applyRoleChange(
		planRoleChange({ root: f.root, storeRoot: f.storeRoot, ...edits[0][1] }),
	);
	assert.match(f.config().toString("utf8"), /Review changes carefully/);
	readOnly(t, () => refuses(() => f.resolve(), /stale-lock/));
	assert.deepEqual(lockFields(f.resolve({ lockMode: "validation" })), {
		lockState: "stale",
		lockMode: "validation",
		installRequired: true,
	});
	assert.deepEqual(f.lock(), bytes);
});

for (const initial of ["missing", "stale"]) {
	test(`P5B-C04 configure stays editable when the lock is already ${initial} and verified bytes exist`, (t) => {
		const f = setup(t, { ambient: "empty", locked: initial !== "missing" });
		if (initial === "stale")
			f.edit((config) => {
				config.roles.reviewer.description = "Earlier manual edit";
			});
		const bytes = f.lock();
		const plan = planRoleChange({
			root: f.root,
			storeRoot: f.storeRoot,
			...edits[0][1],
		});
		const result = applyRoleChange(plan);
		assert.deepEqual(f.config(), plan.after);
		assert.deepEqual(
			f.lock(),
			bytes,
			"configure created, repaired or rewrote the lock",
		);
		assert.deepEqual(lockFields(result.resolution), {
			lockState: initial,
			lockMode: "validation",
			installRequired: true,
		});
	});
}

test("P5B-C05 guard: real postwrite package failure rolls the configure edit back using the explicit store", (t) => {
	// Under the misleading ambient store, a postwrite resolve that dropped storeRoot would succeed and keep the edit.
	const f = setup(t);
	prerequisite(f);
	const config = f.config(),
		bytes = f.lock();
	const plan = planRoleChange({
		root: f.root,
		storeRoot: f.storeRoot,
		...edits[0][1],
	});
	const hook = afterConfigRename(t, f, () => corrupt(f, "3.0.0"));
	try {
		assert.throws(
			() => applyRoleChange(plan),
			(error) => {
				assert.match(error.message, /digest mismatch/);
				assert.match(error.message, /rolled back/);
				assert.doesNotMatch(error.message, /stale-lock/);
				return true;
			},
		);
	} finally {
		hook.close();
	}
	assert.equal(hook.fired(), 1, "postwrite boundary was not reached");
	assert.deepEqual(f.config(), config);
	assert.deepEqual(f.lock(), bytes);
});

function preset(f) {
	const source = path.join(f.dir, "preset");
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
					skills: { required: ["review"], available: [] },
				},
			},
			skills: { requires: ["review"], includes: {} },
		}),
	);
	put(path.join(source, "roles/tester.md"), "# Tester\nTest changes.\n");
	return source;
}

test("P5B-P01 preset import requiring the package skill applies, keeps lock bytes, then public resolve refuses stale-lock", (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const bytes = f.lock();
	const plan = planPresetImport({
		root: f.root,
		source: preset(f),
		storeRoot: f.storeRoot,
	});
	assert.deepEqual([plan.ready, plan.conflicts, plan.errors], [true, [], []]);
	applyPresetImport(plan, true);
	assert.match(f.config().toString("utf8"), /tester:/);
	assert.deepEqual(
		f.lock(),
		bytes,
		"preset import re-locked or rewrote the lock",
	);
	readOnly(t, () => refuses(() => f.resolve({ role: "tester" }), /stale-lock/));
	const tester = f.resolve({
		role: "tester",
		model: "model-small",
		lockMode: "validation",
	});
	assert.equal(tester.required[0].package.sha256, f.explicit.digests["1.0.0"]);
	assert.deepEqual(lockFields(tester), {
		lockState: "stale",
		lockMode: "validation",
		installRequired: true,
	});
});

for (const initial of ["missing", "stale"]) {
	test(`P5B-P02 guard: preset import plans and applies when the lock is already ${initial}`, (t) => {
		const f = setup(t, { ambient: "empty", locked: initial !== "missing" });
		if (initial === "stale")
			f.edit((config) => {
				config.roles.reviewer.description = "Earlier manual edit";
			});
		const bytes = f.lock();
		const plan = planPresetImport({
			root: f.root,
			source: preset(f),
			storeRoot: f.storeRoot,
		});
		assert.deepEqual([plan.ready, plan.errors], [true, []]);
		applyPresetImport(plan, true);
		assert.match(f.config().toString("utf8"), /tester:/);
		assert.deepEqual(f.lock(), bytes);
	});
}

test("P5B-P03 guard: real postwrite package failure rolls the preset import back using the explicit store", (t) => {
	const f = setup(t);
	prerequisite(f);
	const plan = planPresetImport({
		root: f.root,
		source: preset(f),
		storeRoot: f.storeRoot,
	});
	assert.equal(plan.ready, true);
	const before = fingerprint(f.root);
	const hook = afterConfigRename(t, f, () => corrupt(f, "3.0.0"));
	try {
		assert.throws(
			() => applyPresetImport(plan, true),
			(error) => {
				assert.match(error.message, /digest mismatch/);
				assert.match(error.message, /rolled back/);
				assert.doesNotMatch(error.message, /stale-lock/);
				return true;
			},
		);
	} finally {
		hook.close();
	}
	assert.equal(hook.fired(), 1, "postwrite boundary was not reached");
	assert.deepEqual(fingerprint(f.root), before);
});

test("P5B-P04 guard: preset export validates the current stale-locked project without locked selection", (t) => {
	const f = setup(t, { ambient: "empty" });
	f.edit((config) => {
		config.roles.reviewer.description = "Edited after install";
	});
	const bytes = f.lock();
	fs.mkdirSync(path.join(f.dir, "out"));
	const metadata = {
		name: "writer-preset",
		display_name: "Writer",
		description: "Writer role",
		author: "Example",
		version: "1.0.0",
		license: "MIT",
	};
	const plan = planPresetExport({
		root: f.root,
		destination: path.join(f.dir, "out/writer"),
		metadata,
		roles: ["writer"],
		profiles: [],
		storeRoot: f.storeRoot,
	});
	applyPresetExport(plan, true);
	assert.equal(
		fs.readFileSync(path.join(f.dir, "out/writer/roles/writer.md"), "utf8"),
		"# Writer\nWrite documentation.\n",
	);
	assert.throws(
		() =>
			planPresetExport({
				root: f.root,
				destination: path.join(f.dir, "out/reviewer"),
				metadata,
				roles: ["reviewer"],
				profiles: [],
				storeRoot: f.storeRoot,
			}),
		(error) =>
			/preset-package-unsupported/.test(error.message) &&
			!/stale-lock|missing-package/.test(error.message),
	);
	assert.equal(fs.existsSync(path.join(f.dir, "out/reviewer")), false);
	assert.deepEqual(f.lock(), bytes);
});

// ---- 4. wizard wrappers ----

test("P5B-W01 configureRoles forwards storeRoot through two consecutive edits; the lock stays stale and public resolve refuses", async (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const bytes = f.lock(),
		output = [],
		descriptions = ["First wizard edit", "Second wizard edit"];
	let round = 0;
	const ask = async (prompt) => {
		if (prompt.startsWith("Roles:"))
			return round < descriptions.length ? "e" : "q";
		if (prompt.startsWith("Role identifier")) return "reviewer";
		if (prompt.startsWith("Description")) return descriptions[round];
		if (prompt.startsWith("Save role")) {
			round++;
			return "y";
		}
		return "";
	};
	await configureRoles({
		root: f.root,
		storeRoot: f.storeRoot,
		ask,
		write: (line) => output.push(String(line)),
	});
	assert.deepEqual(
		output.filter((line) => line.startsWith("Error:")),
		[],
	);
	assert.equal(round, 2, "both edits were saved");
	assert.match(f.config().toString("utf8"), /Second wizard edit/);
	assert.deepEqual(f.lock(), bytes);
	readOnly(t, () => refuses(() => f.resolve(), /stale-lock/));
	assert.deepEqual(lockFields(f.resolve({ lockMode: "validation" })), {
		lockState: "stale",
		lockMode: "validation",
		installRequired: true,
	});
});

test("P5B-W02 runPreset import forwards storeRoot, inspect still previews the stale project, and public resolve refuses", async (t) => {
	const f = setup(t, { ambient: "empty" });
	prerequisite(f);
	const bytes = f.lock(),
		source = preset(f),
		output = [];
	const write = (line) => output.push(String(line));
	await runPreset({
		command: "import",
		location: source,
		root: f.root,
		roles: ["tester"],
		storeRoot: f.storeRoot,
		write,
		ask: async (prompt) =>
			prompt.startsWith("Apply these preset changes") ? "y" : "n",
	});
	assert.ok(
		output.some((line) => line.startsWith("Imported preset")),
		output.join("\n"),
	);
	assert.deepEqual(f.lock(), bytes);
	await runPreset({
		command: "inspect",
		location: source,
		root: f.root,
		roles: ["tester"],
		storeRoot: f.storeRoot,
		write,
		ask: async () => "",
	});
	assert.ok(
		output.some((line) => line.startsWith("Conflict: roles.tester")),
		output.join("\n"),
	);
	readOnly(t, () => refuses(() => f.resolve({ role: "tester" }), /stale-lock/));
});

test("P5B-W03 guard: runPreset export forwards storeRoot and exports a local role from a stale-locked project", async (t) => {
	const f = setup(t, { ambient: "empty" });
	f.edit((config) => {
		config.roles.reviewer.description = "Edited after install";
	});
	const bytes = f.lock(),
		destination = path.join(f.dir, "out/writer");
	fs.mkdirSync(path.dirname(destination));
	const values = {
		name: "writer-preset",
		display_name: "Writer",
		description: "Writer role",
		author: "Example",
		version: "1.0.0",
		license: "MIT",
	};
	const ask = async (prompt) => {
		const key = /^Preset (\w+): $/.exec(prompt)?.[1];
		if (key) return values[key];
		return prompt.startsWith("Export this preset") ? "y" : "";
	};
	await runPreset({
		command: "export",
		location: destination,
		root: f.root,
		roles: ["writer"],
		storeRoot: f.storeRoot,
		ask,
		write: () => {},
	});
	assert.equal(
		fs.readFileSync(path.join(destination, "roles/writer.md"), "utf8"),
		"# Writer\nWrite documentation.\n",
	);
	assert.deepEqual(f.lock(), bytes);
});

// ---- 5. public inspect/doctor/diagnostics/visualizer surfaces ----

const lockError =
	/stale-lock|lock-coverage|agent-profiles\.lock|missing-package|mismatched-package/;

test("P5B-D01 doctor with explicit storeRoot reports stale and missing locks as dependency errors", (t) => {
	const f = setup(t);
	prerequisite(f);
	assert.deepEqual(
		doctor(f.root, { storeRoot: f.storeRoot }).errors.filter((error) =>
			lockError.test(error),
		),
		[],
		"valid lock control",
	);
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	const bytes = f.lock();
	assert.ok(
		doctor(f.root, { storeRoot: f.storeRoot }).errors.some((error) =>
			/stale-lock/.test(error),
		),
		"stale lock reported",
	);
	assert.deepEqual(f.lock(), bytes);
	fs.rmSync(path.join(f.root, LOCK));
	assert.ok(
		doctor(f.root, { storeRoot: f.storeRoot }).errors.some(
			(error) =>
				/agent-profiles\.lock/.test(error) && !/missing-package/.test(error),
		),
		"missing lock reported",
	);
	assert.equal(f.lock(), null, "doctor created a lock");
});

function cli(f, args) {
	const result = spawnSync(process.execPath, [BIN, ...args, "--root", f.root], {
		encoding: "utf8",
		timeout: 60000,
		env: {
			...process.env,
			AGENT_PROFILES_STORE: f.storeRoot,
			HOME: f.home,
			USERPROFILE: f.home,
		},
	});
	assert.equal(result.error, undefined);
	return result;
}

test("P5B-D02 CLI resolve and proof show locked package text, then refuse a stale lock without printing package text", (t) => {
	const f = setup(t);
	prerequisite(f);
	const selectors = ["--model", "model-large", "--role", "reviewer"];
	const resolved = cli(f, ["resolve", ...selectors]);
	assert.equal(resolved.status, 0, resolved.stderr);
	assert.ok(
		resolved.stdout.includes("Review body 2.0.0 from the explicit store."),
		resolved.stdout,
	);
	const proof = cli(f, ["proof", ...selectors]);
	assert.equal(proof.status, 0, proof.stderr);
	assert.ok(
		proof.stdout.includes(
			`${NAME}@2.0.0 sha256:${f.explicit.digests["2.0.0"]}`,
		),
		proof.stdout,
	);
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	for (const command of ["resolve", "proof"]) {
		const refused = cli(f, [command, ...selectors]);
		assert.notEqual(
			refused.status,
			0,
			`${command} accepted a stale lock: ${refused.stdout}`,
		);
		assert.match(refused.stdout + refused.stderr, /stale-lock/);
		assert.ok(
			!refused.stdout.includes("Review body") &&
				!refused.stdout.includes(f.explicit.digests["2.0.0"]),
			refused.stdout,
		);
	}
});

test("P5B-D03 guard: bounded inspect stays store-free and never repairs a stale or missing lock", (t) => {
	const f = setup(t);
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	for (const step of ["stale", "missing"]) {
		if (step === "missing") fs.rmSync(path.join(f.root, LOCK));
		const before = f.state();
		const { configuration } = inspectRepository({
			root: f.root,
			environmentOptions: { env: {} },
		}).repository;
		assert.equal(configuration.status, "partial", step);
		assert.deepEqual(
			configuration.roles.map((role) => role.id),
			["reviewer", "writer"],
		);
		assert.deepEqual(f.state(), before, `${step}: inspect wrote files`);
	}
});

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
async function get(url, query, init) {
	const response = await fetch(`${url}api/resolve?${query}`, init);
	return { status: response.status, body: await response.json() };
}

test("P5B-D04 visualizer HTTP resolve uses the server-held explicit store and reports the valid required lock", async (t) => {
	const f = setup(t);
	prerequisite(f);
	const { url } = await serve(t, {
		root: f.root,
		storeRoot: f.storeRoot,
		model: "model-large",
		role: "reviewer",
	});
	const { status, body: result } = await get(
		url,
		"model=model-large&role=reviewer",
	);
	assert.equal(status, 200, JSON.stringify(result));
	assert.equal(
		result.required[0].package.sha256,
		f.explicit.digests["2.0.0"],
		"not the misleading ambient store",
	);
	for (const key of ["store", "storeRoot"]) {
		assert.deepEqual(
			await get(
				url,
				`${key}=${encodeURIComponent(f.misleading.root)}&model=model-large`,
			),
			{ status: 400, body: { error: `Unknown parameter: ${key}` } },
		);
	}
	assert.deepEqual(
		await get(url, "model=model-large", {
			method: "POST",
			body: JSON.stringify({ storeRoot: f.misleading.root }),
		}),
		{ status: 405, body: { error: "Read-only: GET required" } },
	);
	assert.deepEqual(lockFields(result), LOCKED);
});

test("P5B-D05 visualizer startup refuses a stale lock", async (t) => {
	const f = setup(t);
	prerequisite(f);
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	let app;
	try {
		await assert.rejects(async () => {
			app = await startVisualizer({
				root: f.root,
				storeRoot: f.storeRoot,
				model: "model-large",
				role: "reviewer",
			});
		}, /stale-lock/);
	} finally {
		if (app)
			await new Promise((resolve) => {
				app.server.close(resolve);
				app.server.closeAllConnections();
			});
	}
});

test("P5B-D06 visualizer HTTP re-resolution refuses a lock made stale after startup", async (t) => {
	const f = setup(t);
	prerequisite(f);
	const { url } = await serve(t, {
		root: f.root,
		storeRoot: f.storeRoot,
		model: "model-large",
		role: "reviewer",
	});
	assert.equal((await get(url, "model=model-large&role=reviewer")).status, 200);
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	const { status, body: result } = await get(
		url,
		"model=model-large&role=reviewer",
	);
	assert.equal(status, 400, JSON.stringify(result).slice(0, 300));
	assert.match(result.error, /stale-lock/);
});

// Only the DOM operations app.js uses; innerHTML fails. fetch is proxied to the real local server.
async function runApp(url) {
	class Node {
		children = [];
		textContent = "";
		className = "";
		value = "";
		hidden = false;
		disabled = false;
		listeners = {};
		append(...nodes) {
			this.children.push(...nodes);
		}
		replaceChildren(...nodes) {
			this.children = nodes;
		}
		add(node) {
			this.children.push(node);
		}
		addEventListener(name, fn) {
			this.listeners[name] = fn;
		}
		setAttribute() {}
		removeAttribute() {}
		focus() {}
		set innerHTML(_) {
			throw new Error("HTML is forbidden: use text nodes");
		}
	}
	class Option extends Node {
		constructor(text, value) {
			super();
			this.textContent = text;
			this.value = value;
		}
	}
	const nodes = new Map();
	const document = {
		getElementById(id) {
			if (!nodes.has(id)) nodes.set(id, new Node());
			return nodes.get(id);
		},
		createElement: () => new Node(),
		createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
	};
	const context = vm.createContext({
		document,
		Option,
		URLSearchParams,
		fetch: (endpoint, init) => fetch(new URL(endpoint, url), init),
	});
	vm.runInContext(
		fs.readFileSync(
			new URL("../src/visualizer/app.js", import.meta.url),
			"utf8",
		),
		context,
	);
	const status = document.getElementById("status");
	for (
		let i = 0;
		i < 300 && !/^(Unable|Resolved)/.test(status.textContent);
		i++
	)
		await new Promise((resolve) => setTimeout(resolve, 10));
	const texts = (node) =>
		[node.textContent, ...node.children.flatMap(texts)].join("\n");
	return { nodes, text: (id) => texts(document.getElementById(id)) };
}

test("P5B-D07 visualizer browser app renders the stale-lock refusal instead of package content", async (t) => {
	const f = setup(t);
	prerequisite(f);
	const { url } = await serve(t, {
		root: f.root,
		storeRoot: f.storeRoot,
		model: "model-large",
		role: "reviewer",
	});
	const control = await runApp(url);
	assert.match(
		control.text("status"),
		/^Resolved reviewer/,
		"valid lock renders",
	);
	assert.ok(control.text("required").includes(f.explicit.digests["2.0.0"]));
	f.edit((config) => {
		config.roles.reviewer.description = "Changed";
	});
	const app = await runApp(url);
	assert.match(app.text("status"), /^Unable to resolve/);
	assert.equal(app.nodes.get("error").hidden, false);
	assert.match(app.text("error"), /stale-lock/);
	assert.ok(
		![...app.nodes.keys()].some((id) => app.text(id).includes("Review body")),
		"package text rendered for a stale lock",
	);
});

// ---- RED completion: preset result reporting and public api/config preflight ----

// Parent decision: like configure, a ready preset plan reports plan.resolution and a confirmed apply returns
// { modified, resolution } with the actual validation-mode selection. The stale-pin start makes a locked-selection shortcut visible.
const presetStates = [
	["valid", () => {}, "stale", "1.0.0"],
	["missing", (f) => fs.rmSync(path.join(f.root, LOCK)), "missing", "1.0.0"],
	[
		"stale-pin",
		(f) =>
			f.edit((config) => {
				config.skills.review.version = "3.0.0";
			}),
		"stale",
		"3.0.0",
	],
];
function explicitSelection(f, resolution, version) {
	assert.ok(resolution, "no validation-mode resolution reported");
	const { package: selected } = resolution.required.find(
		(entry) => entry.package?.binding === "skills.review",
	);
	assert.deepEqual(
		[selected.version, selected.sha256],
		[version, f.explicit.digests[version]],
		"explicit store and current configuration, not the locked pin",
	);
	assert.equal(
		resolution.loaded.find((entry) => entry.id === "review").content,
		body(version, "explicit"),
	);
}

for (const [initial, mutate, lockState, version] of presetStates) {
	test(`P5B-P05 ready preset preview from a ${initial} lock reports ${lockState}/validation/install-required and writes nothing`, (t) => {
		const f = setup(t);
		prerequisite(f);
		mutate(f);
		const source = preset(f),
			bytes = f.lock(),
			before = f.state();
		const plan = planPresetImport({
			root: f.root,
			source,
			storeRoot: f.storeRoot,
		});
		assert.deepEqual([plan.ready, plan.conflicts, plan.errors], [true, [], []]);
		assert.deepEqual(f.lock(), bytes);
		assert.deepEqual(f.state(), before, "preview wrote files");
		explicitSelection(f, plan.resolution, version);
		assert.deepEqual(lockFields(plan.resolution), {
			lockState,
			lockMode: "validation",
			installRequired: true,
		});
	});

	test(`P5B-P06 confirmed preset apply from a ${initial} lock returns modified files and a ${lockState} validation resolution`, (t) => {
		const f = setup(t);
		prerequisite(f);
		mutate(f);
		const plan = planPresetImport({
			root: f.root,
			source: preset(f),
			storeRoot: f.storeRoot,
		});
		assert.equal(plan.ready, true);
		const bytes = f.lock(),
			stores = f.state().slice(1);
		const result = applyPresetImport(plan, true);
		assert.match(f.config().toString("utf8"), /tester:/);
		assert.deepEqual(
			f.lock(),
			bytes,
			"preset import re-locked or rewrote the lock",
		);
		assert.deepEqual(f.state().slice(1), stores, "apply wrote a store or home");
		assert.deepEqual(
			result.modified,
			plan.changes.map((change) => change.file),
		);
		assert.ok(result.modified.includes(CONFIG));
		explicitSelection(f, result.resolution, version);
		assert.deepEqual(lockFields(result.resolution), {
			lockState,
			lockMode: "validation",
			installRequired: true,
		});
	});
}

// api/config is a public read-only endpoint: it keeps the required lock preflight whatever readConfiguration's internal default becomes.
const configRefusals = [
	[
		"stale",
		(f) =>
			f.edit((config) => {
				config.roles.reviewer.description = "Changed";
			}),
		/stale-lock/,
	],
	[
		"missing",
		(f) => fs.rmSync(path.join(f.root, LOCK)),
		/agent-profiles\.lock/,
	],
];
for (const [name, mutate, pattern] of configRefusals) {
	test(`P5B-D08 visualizer api/config serves a valid lock, then refuses a ${name} lock with 400`, async (t) => {
		const f = setup(t);
		prerequisite(f);
		const { url } = await serve(t, {
			root: f.root,
			storeRoot: f.storeRoot,
			model: "model-large",
			role: "reviewer",
		});
		const getConfig = async () => {
			const response = await fetch(`${url}api/config`);
			return { status: response.status, body: await response.json() };
		};
		const valid = await getConfig();
		assert.equal(valid.status, 200, JSON.stringify(valid.body));
		assert.deepEqual(
			[valid.body.models, valid.body.roles],
			[
				["model-large", "model-small"],
				["reviewer", "writer"],
			],
		);
		mutate(f);
		const bytes = f.lock(),
			before = f.state();
		const { status, body: result } = await getConfig();
		assert.deepEqual(
			f.lock(),
			bytes,
			"api/config repaired or rewrote the lock",
		);
		assert.deepEqual(f.state(), before, "api/config wrote files");
		assert.equal(status, 400, JSON.stringify(result).slice(0, 300));
		assert.match(result.error, pattern);
		assert.doesNotMatch(result.error, /missing-package/);
	});
}
