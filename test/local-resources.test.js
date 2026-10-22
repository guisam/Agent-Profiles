import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { parseYaml, resolveInstructions } from "../src/resolve.js";
import { validateMembers } from "../src/packages.js";
import { importPackage, readStoreFile } from "../src/package-store.js";
import { installDependencies } from "../src/package-lock.js";
import { createStamp, verifyStamp, reconstructStamp } from "../src/stamps.js";
import {
	readConfiguration,
	planRoleChange,
	applyRoleChange,
} from "../src/configure.js";
import { discoverSkills } from "../src/skills.js";
import { selectSkills, configureRoles } from "../src/wizard.js";
import {
	formatContext,
	formatProof,
	resolutionOutput,
} from "../src/diagnostics.js";
import { inspectRepository } from "../src/inspect.js";
import { startVisualizer } from "../src/visualize.js";
import {
	planPresetExport,
	applyPresetExport,
	readPreset,
	planPresetImport,
	applyPresetImport,
} from "../src/presets.js";
import { runPreset } from "../src/preset-wizard.js";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const binary = Buffer.from([0, 255, 192, 175, 13, 10, 239, 187, 191]);
const instructions = Buffer.from(
	"\uFEFF# Exact profile\r\n\r\n[not an include](unread/sentinel.bin)\r\n",
);
const skillBytes = (id) =>
	Buffer.from(
		`---\nname: ${id}\ndescription: ${id} <img src=x onerror=bad>\n---\n${id} body\n`,
	);
const metadata = {
	name: "local-review",
	display_name: "Local review",
	description: "Owned fixture",
	author: "Example",
	version: "1.0.0",
	license: "MIT",
};

// Independent finite RECORD oracle; production canonical/hash helpers are deliberately not used.
function canonical(value) {
	if (value === null || typeof value === "boolean" || typeof value === "number")
		return String(value);
	if (typeof value === "string")
		return (
			'"' +
			Array.from(value, (c) =>
				c.charCodeAt(0) < 32
					? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
					: JSON.stringify(c).slice(1, -1),
			).join("") +
			'"'
		);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort(compare)
		.map((k) => `${canonical(k)}:${canonical(value[k])}`)
		.join(",")}}`;
}
function record(value, domain = "agent-profiles/stamp/v1") {
	const bytes = Buffer.from(canonical(value)),
		length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return {
		bytes,
		digest: sha(Buffer.concat([Buffer.from(domain + "\0"), length, bytes])),
	};
}
function configDigest(config) {
	return record(
		{ profiles: {}, skills: {}, assignments: {}, ...config },
		"agent-profiles/config/v2",
	).digest;
}
function fingerprint(root, exclude = []) {
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort(compare)
		.filter((p) => !exclude.includes(p))
		.map((p) => {
			const file = path.join(root, p),
				stat = fs.lstatSync(file);
			return [
				p,
				stat.isSymbolicLink()
					? `link:${fs.readlinkSync(file)}`
					: stat.isDirectory()
						? "directory"
						: sha(fs.readFileSync(file)),
			];
		});
}
function environment(t, values) {
	for (const [key, value] of Object.entries(values)) {
		const old = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (old === undefined) delete process.env[key];
			else process.env[key] = old;
		});
	}
}
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "local-resources-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		home = path.join(dir, "home");
	fs.mkdirSync(storeRoot);
	fs.mkdirSync(home);
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "reviewer",
		models: {},
		families: {},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: ["required"], available: ["first", "idle"] },
			},
			writer: {
				file: "roles/writer.md",
				skills: { required: [], available: [] },
			},
		},
		skills: Object.fromEntries(
			["required", "first", "idle"].map((id) => [
				id,
				{ file: `instructions/${id}.md` },
			]),
		),
	};
	put(path.join(root, ".agent-profiles/profiles/base.md"), instructions);
	for (const id of ["reviewer", "writer"])
		put(path.join(root, `.agent-profiles/roles/${id}.md`), `# ${id}\r\n`);
	for (const id of ["required", "first", "idle"])
		put(path.join(root, `instructions/${id}.md`), skillBytes(id));
	put(path.join(root, "assets/a.bin"), binary);
	put(path.join(root, "assets/z.bin"), Buffer.from("Z"));
	put(path.join(root, "unread/sentinel.bin"), "never read");
	const save = () => put(path.join(root, CONFIG), stringify(config));
	save();
	const options = { root, storeRoot, sharedFiles: [] };
	const resolve = (extra) => resolveInstructions({ root, storeRoot, ...extra });
	const control = resolve();
	assert.deepEqual(
		control.loaded.map((e) => [e.kind, e.id]),
		[
			["profile", "base"],
			["role", "reviewer"],
			["required-skill", "required"],
		],
	);
	return {
		dir,
		root,
		storeRoot,
		home,
		config,
		save,
		resolve,
		options,
		control,
	};
}
function declare(f, owner, resources = ["assets/z.bin", "assets/a.bin"]) {
	if (owner === "profile") {
		f.config.profiles = { base: { file: "mapped/actual.md", resources } };
		put(path.join(f.root, ".agent-profiles/mapped/actual.md"), instructions);
		fs.rmSync(path.join(f.root, ".agent-profiles/profiles/base.md"), {
			force: true,
		});
	} else if (owner === "role") f.config.roles.reviewer.resources = resources;
	else f.config.skills[owner].resources = resources;
	f.save();
}
const ownerBinding = (owner) =>
	owner === "profile"
		? "profiles.base"
		: owner === "role"
			? "roles.reviewer"
			: `skills.${owner}`;
function snapshotEntry(snapshot, owner) {
	return owner === "profile"
		? snapshot.composition[0]
		: owner === "role"
			? snapshot.composition[1]
			: [...snapshot.required, ...snapshot.available].find(
					(e) => e.id === owner,
				);
}
const resource = (binding, file, bytes) => ({
	binding,
	backing: {
		type: "blob",
		path: file,
		bytes: bytes.length,
		sha256: sha(bytes),
	},
});
function writeSnapshot(f, snapshot) {
	const r = record(snapshot);
	put(
		path.join(f.storeRoot, "stamps/sha256", r.digest, "snapshot.json"),
		r.bytes,
	);
	return { ...r, snapshot };
}
function verified(f, digest) {
	const report = verifyStamp({ digest, storeRoot: f.storeRoot });
	assert.equal(
		report.snapshotIntegrity,
		"verified",
		report.findings.join("\n"),
	);
	assert.equal(report.managedContent, "verified", report.findings.join("\n"));
	assert.equal(report.managedReconstruction, "verified");
	assert.equal(report.managedReproducible, true);
	assert.equal(report.completeRuntimeReproducible, false);
	return reconstructStamp({ digest, storeRoot: f.storeRoot });
}
function capture(f, extra = {}) {
	const stamp = createStamp({ ...f.options, ...extra }),
		independent = record(stamp.snapshot);
	assert.equal(stamp.digest, independent.digest);
	assert.deepEqual(
		fs.readFileSync(
			path.join(f.storeRoot, "stamps/sha256", stamp.digest, "snapshot.json"),
		),
		independent.bytes,
	);
	verified(f, stamp.digest);
	return stamp;
}
function synthetic(t) {
	const f = fixture(t),
		seed = capture(f),
		snapshot = structuredClone(seed.snapshot);
	for (const owner of ["profile", "role", "required", "first", "idle"]) {
		const entries = ["assets/a.bin", "assets/z.bin"].map((p) =>
			resource(
				ownerBinding(owner),
				p,
				p.endsWith("a.bin") ? binary : Buffer.from("Z"),
			),
		);
		snapshotEntry(snapshot, owner).resources = entries;
		for (const e of snapshot.composition.slice(2).filter((e) => e.id === owner))
			e.resources = structuredClone(entries);
	}
	for (const bytes of [binary, Buffer.from("Z")])
		put(path.join(f.storeRoot, "blobs/sha256", sha(bytes)), bytes);
	const stamp = writeSnapshot(f, snapshot),
		restored = verified(f, stamp.digest);
	assert.deepEqual(
		restored.resources,
		[
			"profiles.base",
			"roles.reviewer",
			"skills.required",
			"skills.first",
			"skills.idle",
		]
			.flatMap((binding) => [
				resource(binding, "assets/a.bin", binary),
				resource(binding, "assets/z.bin", Buffer.from("Z")),
			])
			.map((r) => ({
				...r,
				bytes: r.backing.path.endsWith("a.bin") ? binary : Buffer.from("Z"),
			})),
	);
	return { ...f, stamp };
}
function refusesUnchanged(f, run, patterns) {
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	try {
		assert.throws(
			run,
			(error) => patterns.every((p) => p.test(error.message)),
			patterns.map(String).join(" + "),
		);
	} finally {
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	}
}
function intercept(methods, run) {
	const originals = Object.fromEntries(
		Object.keys(methods).map((k) => [k, fs[k]]),
	);
	for (const [k, wrap] of Object.entries(methods)) fs[k] = wrap(originals[k]);
	syncBuiltinESMExports();
	try {
		return run();
	} finally {
		Object.assign(fs, originals);
		syncBuiltinESMExports();
	}
}

// Only these exact current admission errors block named downstream bodies. Other errors are setup failures.
const blocked = new Map();
before((t) => {
	for (const [owner, diagnostic] of [
		["profile", "profiles.base.file: unknown field"],
		["role", "roles.reviewer.resources: unknown field"],
		["required", "skills.required.resources: unknown field"],
	]) {
		const f = fixture(t);
		declare(f, owner, []);
		try {
			f.resolve();
			blocked.set(owner, null);
		} catch (error) {
			if (error.message !== diagnostic) throw error;
			blocked.set(owner, diagnostic);
		}
	}
});
function resourceTest(name, owner, body) {
	test(name, async (t) => {
		const reason = blocked.get(
			owner === "first" || owner === "idle" ? "required" : owner,
		);
		if (reason) {
			t.skip(`unreachable until local v2 admission: ${reason}`);
			return;
		}
		await body(t);
	});
}

test("P6B control ordinary v2 exact legacy shapes and raw capture", (t) => {
	const f = fixture(t),
		before = fingerprint(f.root),
		r = f.control;
	assert.deepEqual(r.required[0], {
		id: "required",
		type: "instruction",
		delivery: "inject",
		name: "required",
		nameSource: "frontmatter",
		description: "required <img src=x onerror=bad>",
		path: "instructions/required.md",
		bytes: skillBytes("required").length,
		characters: skillBytes("required").length,
	});
	assert.deepEqual(r.loaded[0], {
		path: ".agent-profiles/profiles/base.md",
		kind: "profile",
		id: "base",
		content: instructions.toString("utf8"),
		bytes: instructions.length,
		characters: [...instructions.toString("utf8")].length,
	});
	for (const e of [...r.loaded, ...r.required, ...r.available])
		assert.equal(Object.hasOwn(e, "resources"), false);
	const stamp = capture(f);
	assert.deepEqual(
		verified(f, stamp.digest).composition[0].bytes,
		instructions,
	);
	assert.deepEqual(fingerprint(f.root), before);
});
for (const owner of ["profile", "role", "required"])
	test(`P6B admission ${owner} minimal v2 local declaration`, (t) => {
		const f = fixture(t);
		declare(f, owner, []);
		assert.doesNotThrow(() => f.resolve());
	});

test("P6B control canonical RECORD and portable fingerprint exclusions", (t) => {
	assert.equal(
		canonical({ z: "\n", a: [0, true, null] }),
		'{"a":[0,true,null],"z":"\\u000a"}',
	);
	const f = fixture(t),
		seed = createStamp(f.options);
	assert.equal(seed.digest, record(seed.snapshot).digest);
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(f.root, LOCK), "utf8")).configSha256,
		configDigest(f.config),
	);
	const before = fingerprint(f.root, [CONFIG]);
	f.config.models.x = { profile: "base" };
	f.save();
	assert.deepEqual(fingerprint(f.root, [CONFIG]), before);
	put(path.join(f.root, "assets/a.bin"), "changed protected bytes");
	assert.notDeepEqual(fingerprint(f.root, [CONFIG]), before);
});

for (const owner of ["profile", "role", "required", "first"])
	resourceTest(
		`P6B metadata ${owner} sorted nonempty resources`,
		owner,
		(t) => {
			const f = fixture(t);
			declare(f, owner);
			const r = f.resolve({ skills: ["first", "first"] }),
				paths = ["assets/a.bin", "assets/z.bin"];
			const e =
				owner === "profile"
					? r.loaded[0]
					: owner === "role"
						? r.loaded[1]
						: [...r.required, ...r.available].find((e) => e.id === owner);
			assert.deepEqual(e.resources, paths);
			if (["required", "first"].includes(owner))
				assert.deepEqual(r.loaded.find((e) => e.id === owner).resources, paths);
			if (owner === "profile") {
				assert.equal(e.path, ".agent-profiles/mapped/actual.md");
				assert.equal(e.content, instructions.toString("utf8"));
			}
			assert.deepEqual(
				r.loaded.map((e) => e.id),
				["base", "reviewer", "required", "first"],
			);
		},
	);

for (const owner of ["profile", "role", "required"])
	resourceTest(
		`P6B empty ${owner} omitted versus explicit list`,
		owner,
		(t) => {
			const f = fixture(t);
			if (owner === "profile") {
				declare(f, owner, []);
				delete f.config.profiles.base.resources;
				f.save();
			}
			const a = f.resolve(),
				first = capture(f);
			declare(f, owner, []);
			assert.deepEqual(
				f.resolve(),
				a,
				"optional empty resources do not change old result shapes",
			);
			assert.deepEqual(capture(f), first);
			const emptySha = configDigest(f.config);
			const entry =
				owner === "profile"
					? f.config.profiles.base
					: owner === "role"
						? f.config.roles.reviewer
						: f.config.skills.required;
			delete entry.resources;
			assert.notEqual(configDigest(f.config), emptySha);
		},
	);

for (const kind of ["profile", "role", "skill", "native"])
	for (const list of [[], ["assets/a.bin"]]) {
		test(`P6B union ${kind} rejects resources ${list.length ? "nonempty" : "empty"}`, (t) => {
			const f = fixture(t);
			addPackage(f);
			let binding, entry;
			if (kind === "profile") {
				binding = "profiles.other";
				entry = { package: "@example/check", version: "1.0.0" };
				f.config.profiles = { other: entry };
			} else if (kind === "role") {
				binding = "roles.other";
				entry = {
					package: "@example/instruction",
					version: "1.0.0",
					skills: { required: [], available: [] },
				};
				f.config.roles.other = entry;
				addPackage(f, "instruction");
			} else {
				binding = "skills.extra";
				entry =
					kind === "native"
						? { host: "claude", scope: "user", id: "personal" }
						: { package: "@example/check", version: "1.0.0" };
				f.config.skills.extra = entry;
			}
			// Profile package must be an actual instruction package, with no conflicting conventional sibling.
			if (kind === "profile") {
				addPackage(f, "instruction");
				entry.package = "@example/instruction";
			}
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			f.resolve();
			entry.resources = list;
			f.save();
			refusesUnchanged(f, () => f.resolve(), [
				new RegExp(binding.replaceAll(".", "\\.")),
				/resources/,
				/unknown|forbidden|not (?:allowed|supported)/i,
			]);
		});
	}
for (const [label, mutate, binding] of [
	[
		"file-package",
		(f) => {
			f.config.skills.required.package = "@example/check";
			f.config.skills.required.version = "1.0.0";
		},
		"skills.required",
	],
	[
		"host-package",
		(f) => {
			f.config.skills.extra = {
				host: "claude",
				scope: "user",
				package: "@example/check",
				version: "1.0.0",
			};
		},
		"skills.extra",
	],
	[
		"role-file-package",
		(f) => {
			Object.assign(f.config.roles.reviewer, {
				package: "@example/instruction",
				version: "1.0.0",
			});
		},
		"roles.reviewer",
	],
])
	test(`P6B union mixed ${label} refuses before writes`, (t) => {
		const f = fixture(t);
		mutate(f);
		f.save();
		refusesUnchanged(f, () => f.resolve(), [
			new RegExp(binding.replaceAll(".", "\\.")),
			/unknown|exclusive|either|ambiguous/i,
		]);
	});
for (const owner of ["profile", "role", "required"])
	test(`P6B v1 ${owner} new field has migration guidance`, (t) => {
		const f = fixture(t);
		f.config.version = 1;
		f.save();
		f.resolve();
		declare(f, owner, []);
		refusesUnchanged(f, () => f.resolve(), [
			owner === "profile" ? /profiles/ : /resources/,
			/(?:version\s*2|v2)/i,
			/migrat|upgrade/i,
		]);
	});

function addPackage(
	f,
	id = "check",
	variant = "explicit",
	storeRoot = f.storeRoot,
) {
	const directory = path.join(f.dir, `source-${id}-${variant}`);
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: {
				name: `@example/${id}`,
				version: "1.0.0",
				type: id === "instruction" ? "instruction" : "skill",
			},
			entrypoint: "entry.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "entry.md"),
		id === "instruction" ? `# ${variant}\n` : skillBytes(variant),
	);
	return importPackage({ sourceDirectory: directory, storeRoot });
}

const unsafePaths = [
	["traversal", "../outside.bin"],
	["absolute", "/outside.bin"],
	["drive", "C:/outside.bin"],
	["UNC", "//server/share/a"],
	["backslash", "assets\\a.bin"],
	["URL", "https://example.invalid/a"],
	["colon", "assets/a:stream"],
	["empty", ""],
	["dot", "assets/./a.bin"],
	["empty-component", "assets//a.bin"],
	["trailing-dot", "assets/a."],
	["git", ".git/config"],
	["device", "assets/CON.txt"],
	["control", "assets/a\n.bin"],
	["unicode", "assets/é.bin"],
];
for (const [label, file] of unsafePaths) {
	test(`P6B path descriptor ${label} rejects spelling`, () => {
		validateMembers([{ path: "assets/a.bin", type: "file", nlink: 1 }]);
		assert.throws(
			() => validateMembers([{ path: file, type: "file", nlink: 1 }]),
			/portable|component|reserved/,
		);
	});
	resourceTest(
		`P6B path admission ${label} refuses without outside read`,
		"role",
		(t) => {
			const f = fixture(t);
			declare(f, "role", ["assets/a.bin"]);
			f.resolve();
			capture(f);
			const outside = path.join(f.dir, "outside.bin");
			put(outside, "outside unchanged");
			declare(f, "role", [file]);
			const reads = [];
			const before = [
				fingerprint(f.root),
				fingerprint(f.storeRoot),
				sha(fs.readFileSync(outside)),
			];
			intercept(
				{
					openSync: (original) =>
						function (target, ...args) {
							if (
								typeof target === "string" &&
								![f.root, f.storeRoot].some(
									(root) =>
										path.resolve(target) === root ||
										path.resolve(target).startsWith(root + path.sep),
								)
							) {
								reads.push(target);
								throw new Error("unexpected outside resource read");
							}
							return original.call(this, target, ...args);
						},
				},
				() => {
					assert.throws(
						() => createStamp(f.options),
						(error) =>
							/roles\.reviewer.*resources/.test(error.message) &&
							/path|portable|component|relative|reserved/i.test(error.message),
					);
				},
			);
			assert.deepEqual(reads, []);
			assert.deepEqual(
				[
					fingerprint(f.root),
					fingerprint(f.storeRoot),
					sha(fs.readFileSync(outside)),
				],
				before,
			);
		},
	);
}
resourceTest(
	"P6B path valid nested hidden zero binary and inert script",
	"role",
	(t) => {
		const f = fixture(t),
			files = new Map([
				["assets/nested/a.bin", binary],
				[".hidden/data", Buffer.from("hidden")],
				["assets/zero", Buffer.alloc(0)],
				[
					"assets/inert.js",
					Buffer.from('throw new Error("MUST NEVER EXECUTE");\n'),
				],
			]);
		for (const [p, bytes] of files) put(path.join(f.root, p), bytes);
		declare(f, "role", [...files.keys()]);
		const stamp = capture(f),
			restored = verified(f, stamp.digest);
		const expected = [...files]
			.sort(([a], [b]) => compare(a, b))
			.map(([p, bytes]) => ({
				...resource("roles.reviewer", p, bytes),
				bytes,
			}));
		assert.deepEqual(restored.resources, expected);
		assert.equal(stamp.snapshot.composition.length, 3);
		assert.deepEqual(
			f.resolve().diagnostics.managed,
			f.control.diagnostics.managed,
		);
	},
);

for (const [label, members, diagnostic] of [
	["parent-case", ["Assets/a.bin", "assets/b.bin"], /case collision/],
	["prefix", ["assets/data", "assets/data/child"], /prefix collision/],
	["exact-duplicate", ["assets/a.bin", "assets/a.bin"], /duplicate/],
])
	test(`P6B path descriptor ${label} collision`, () => {
		validateMembers(
			["assets/a.bin", "assets/b.bin"].map((p) => ({
				path: p,
				type: "file",
				nlink: 1,
			})),
		);
		assert.throws(
			() =>
				validateMembers(
					members.map((p) => ({ path: p, type: "file", nlink: 1 })),
				),
			diagnostic,
		);
	});
for (const type of ["symlink", "special"])
	test(`P6B path descriptor ${type} refusal`, () => {
		assert.throws(
			() => validateMembers([{ path: "assets/member", type, nlink: 1 }]),
			/links and special files are forbidden/,
		);
	});

for (const mode of [
	"leaf-symlink",
	"ancestor-link",
	"hardlink",
	"directory",
	"missing",
]) {
	resourceTest(`P6B native resource ${mode} refusal`, "role", (t) => {
		const f = fixture(t);
		declare(f, "role", ["assets/a.bin"]);
		f.resolve();
		const outside = path.join(f.dir, "outside");
		put(path.join(outside, "data.bin"), binary);
		let member = "assets/unsafe.bin";
		if (
			mode === "leaf-symlink" ||
			mode === "ancestor-link" ||
			mode === "hardlink"
		) {
			try {
				if (mode === "hardlink")
					fs.linkSync(
						path.join(outside, "data.bin"),
						path.join(f.root, member),
					);
				else if (mode === "leaf-symlink")
					fs.symlinkSync(
						path.join(outside, "data.bin"),
						path.join(f.root, member),
						"file",
					);
				else {
					fs.symlinkSync(
						outside,
						path.join(f.root, "linked"),
						process.platform === "win32" ? "junction" : "dir",
					);
					member = "linked/data.bin";
				}
			} catch (error) {
				if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
				t.skip(
					`native ${mode} capability unavailable (${error.code}); descriptor controls do not qualify it`,
				);
				return;
			}
		} else if (mode === "directory") fs.mkdirSync(path.join(f.root, member));
		declare(f, "role", ["assets/a.bin", member]);
		const outsideBefore = fingerprint(outside),
			before = fingerprint(f.root),
			storeBefore = fingerprint(f.storeRoot);
		const reads = [];
		intercept(
			{
				openSync: (original) =>
					function (target, ...args) {
						if (
							typeof target === "string" &&
							(path.resolve(target).startsWith(outside + path.sep) ||
								path.resolve(target) === path.join(f.root, member))
						)
							reads.push(target);
						return original.call(this, target, ...args);
					},
			},
			() =>
				assert.throws(
					() => createStamp(f.options),
					(error) =>
						error.message.includes(member) &&
						(mode === "missing"
							? /missing|ENOENT|cannot access/i
							: mode === "directory"
								? /regular|file|directory/i
								: /link|unsafe/i
						).test(error.message),
				),
		);
		assert.deepEqual(reads, []);
		assert.deepEqual(fingerprint(outside), outsideBefore);
		assert.deepEqual(fingerprint(f.root), before);
		assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
	});
}
for (const mode of ["duplicate", "own-entrypoint"])
	resourceTest(`P6B capture rejects ${mode} resource`, "role", (t) => {
		const f = fixture(t);
		declare(f, "role", ["assets/a.bin"]);
		capture(f);
		declare(
			f,
			"role",
			mode === "duplicate"
				? ["assets/a.bin", "assets/a.bin"]
				: [".agent-profiles/roles/reviewer.md"],
		);
		refusesUnchanged(f, () => createStamp(f.options), [
			/roles\.reviewer|composition\.role/,
			/duplicate|owner\/path|entrypoint|instruction/i,
		]);
	});

for (const owner of ["profile", "role", "required", "first"])
	resourceTest(`P6B binary ${owner} exact qualified backing`, owner, (t) => {
		const f = fixture(t);
		declare(f, owner);
		const before = fingerprint(f.root),
			stamp = capture(f, {
				skills: owner === "first" ? ["first", "first"] : [],
			});
		const expected = [
			resource(ownerBinding(owner), "assets/a.bin", binary),
			resource(ownerBinding(owner), "assets/z.bin", Buffer.from("Z")),
		];
		assert.deepEqual(snapshotEntry(stamp.snapshot, owner).resources, expected);
		const restored = verified(f, stamp.digest);
		assert.deepEqual(
			restored.resources,
			expected.map((r) => ({
				...r,
				bytes: r.backing.path.endsWith("a.bin") ? binary : Buffer.from("Z"),
			})),
		);
		assert.deepEqual(
			restored.composition[0].bytes,
			instructions,
			"instruction BOM and CRLF retained",
		);
		assert.deepEqual(
			f.resolve({ skills: owner === "first" ? ["first"] : [] }).diagnostics
				.managed.total,
			{
				files: owner === "first" ? 4 : 3,
				bytes:
					instructions.length +
					Buffer.byteLength("# reviewer\r\n") +
					skillBytes("required").length +
					(owner === "first" ? skillBytes("first").length : 0),
				characters:
					[...instructions.toString("utf8")].length +
					"# reviewer\r\n".length +
					skillBytes("required").length +
					(owner === "first" ? skillBytes("first").length : 0),
			},
		);
		assert.deepEqual(fingerprint(f.root), before);
	});
test("P6B control invalid UTF8 instruction refuses while binary resource verifies", (t) => {
	const f = synthetic(t);
	assert.equal(verified(f, f.stamp.digest).resources[0].bytes[1], 255);
	put(path.join(f.root, ".agent-profiles/profiles/base.md"), binary);
	assert.throws(() => createStamp(f.options), /encoded data|UTF-8/i);
	assert.equal(
		verifyStamp({ digest: f.stamp.digest, storeRoot: f.storeRoot })
			.managedReproducible,
		true,
	);
});
resourceTest(
	"P6B shared physical asset keeps two qualified owners and one blob",
	"role",
	(t) => {
		const f = fixture(t);
		declare(f, "role", ["assets/a.bin"]);
		declare(f, "required", ["assets/a.bin"]);
		const stamp = capture(f),
			restored = verified(f, stamp.digest);
		assert.deepEqual(
			restored.resources,
			["roles.reviewer", "skills.required"].map((binding) => ({
				...resource(binding, "assets/a.bin", binary),
				bytes: binary,
			})),
		);
		assert.deepEqual(
			fs
				.readdirSync(path.join(f.storeRoot, "blobs/sha256"))
				.filter((n) => n === sha(binary)),
			[sha(binary)],
		);
	},
);
resourceTest(
	"P6B available unrequested resource is retained and changes identity",
	"idle",
	(t) => {
		const f = fixture(t);
		declare(f, "idle", ["assets/a.bin"]);
		const a = capture(f);
		assert.equal(
			a.snapshot.composition.some((e) => e.id === "idle"),
			false,
		);
		assert.deepEqual(
			a.snapshot.available.find((e) => e.id === "idle").resources,
			[resource("skills.idle", "assets/a.bin", binary)],
		);
		put(path.join(f.root, "assets/a.bin"), Buffer.from([1, 2, 255]));
		const b = capture(f);
		assert.notEqual(a.digest, b.digest);
		const expected = structuredClone(a.snapshot);
		snapshotEntry(expected, "idle").resources = [
			resource("skills.idle", "assets/a.bin", Buffer.from([1, 2, 255])),
		];
		assert.deepEqual(b.snapshot, expected);
		assert.deepEqual(verified(f, a.digest).resources[0].bytes, binary);
	},
);
resourceTest(
	"P6B resource declaration order and relocated roots keep canonical stamp",
	"role",
	(t) => {
		const a = fixture(t),
			b = fixture(t);
		declare(a, "role");
		declare(b, "role", ["assets/a.bin", "assets/z.bin"]);
		const first = capture(a),
			second = capture(b);
		assert.deepEqual(second, first);
		assert.notEqual(configDigest(a.config), configDigest(b.config));
		assert.deepEqual(
			first.snapshot.composition[1].resources.map((r) => r.backing.path),
			["assets/a.bin", "assets/z.bin"],
		);
	},
);

function mixed(f, t, ambient = "empty") {
	const explicit = addPackage(f),
		otherStore = path.join(f.dir, "ambient");
	fs.mkdirSync(otherStore);
	if (ambient === "misleading") {
		const other = addPackage(f, "check", "ambient", otherStore);
		assert.notEqual(other.sha256, explicit.sha256);
	}
	environment(t, {
		AGENT_PROFILES_STORE: otherStore,
		HOME: f.home,
		USERPROFILE: f.home,
	});
	f.config.skills.check = { package: "@example/check", version: "1.0.0" };
	f.config.roles.reviewer.skills.available.push("check");
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(
		f.resolve().available.find((e) => e.id === "check").package.sha256,
		explicit.sha256,
	);
	if (ambient === "empty")
		assert.throws(
			() => resolveInstructions({ root: f.root }),
			/missing-package/,
		);
	else
		assert.throws(
			() => resolveInstructions({ root: f.root }),
			/mismatched-package/,
		);
	return explicit.sha256;
}
resourceTest(
	"P6B configSha supplied resource paths order and declaration versus bytes",
	"role",
	(t) => {
		const f = fixture(t);
		declare(f, "role");
		mixed(f, t);
		const lockPath = path.join(f.root, LOCK),
			readLock = () => JSON.parse(fs.readFileSync(lockPath, "utf8"));
		assert.equal(readLock().configSha256, configDigest(f.config));
		const initial = capture(f),
			lockBytes = fs.readFileSync(lockPath);
		put(
			path.join(f.root, CONFIG),
			"# formatting only\n" +
				stringify(Object.fromEntries(Object.entries(f.config).reverse())),
		);
		assert.equal(f.resolve().lockState, "valid");
		assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
		put(path.join(f.root, "assets/a.bin"), Buffer.from([42, 255]));
		assert.equal(f.resolve().lockState, "valid");
		assert.notEqual(capture(f).digest, initial.digest);
		f.config.roles.reviewer.resources.reverse();
		f.save();
		refusesUnchanged(f, () => f.resolve(), [/stale-lock/]);
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		assert.equal(readLock().configSha256, configDigest(f.config));
		assert.notEqual(
			readLock().configSha256,
			JSON.parse(lockBytes).configSha256,
		);
		const ordered = capture(f);
		f.config.roles.reviewer.resources.reverse();
		f.save();
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		assert.deepEqual(capture(f), ordered);
		for (const list of [["assets/z.bin"], []]) {
			f.config.roles.reviewer.resources = list;
			f.save();
			assert.throws(() => f.resolve(), /stale-lock/);
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			assert.equal(readLock().configSha256, configDigest(f.config));
		}
		const empty = readLock().configSha256;
		delete f.config.roles.reviewer.resources;
		f.save();
		assert.throws(() => f.resolve(), /stale-lock/);
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		assert.equal(readLock().configSha256, configDigest(f.config));
		assert.notEqual(readLock().configSha256, empty);
	},
);

test("P6B control nonempty synthetic resources reconstruct exact ownership and Buffers", (t) => {
	const f = synthetic(t),
		before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	assert.equal(verified(f, f.stamp.digest).resources.length, 10);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});
const relationMutations = [
	[
		"owner",
		(s) => {
			s.composition[0].resources[0].binding = "roles.reviewer";
		},
		/composition\.profile: resources binding owner\/path mismatch/,
	],
	[
		"own-entrypoint",
		(s) => {
			s.composition[0].resources[0].backing.path =
				s.composition[0].backing.path;
		},
		/composition\.profile: resources binding owner\/path mismatch/,
	],
	[
		"duplicate",
		(s) => {
			s.composition[0].resources.push(
				structuredClone(s.composition[0].resources[1]),
			);
		},
		/resources must be sorted and unique/,
	],
	[
		"order",
		(s) => {
			s.composition[0].resources.reverse();
		},
		/resources must be sorted and unique/,
	],
	[
		"composition",
		(s) => {
			s.composition[2].resources = [];
		},
		/skill required backing\/package\/resources disagreement/,
	],
	[
		"whole-closure-case",
		(s) => {
			s.composition[0].resources[0].backing.path = "Assets/a.bin";
		},
		/case collision/,
	],
	[
		"whole-closure-prefix",
		(s) => {
			s.composition[0].resources[0].backing.path = "assets";
		},
		/prefix collision/,
	],
];
for (const [label, mutate, diagnostic] of relationMutations)
	test(`P6B synthetic relation ${label} canonical rehash refusal`, (t) => {
		const f = synthetic(t),
			malformed = structuredClone(f.stamp.snapshot);
		mutate(malformed);
		const changed = writeSnapshot(f, malformed);
		assert.notEqual(changed.digest, f.stamp.digest);
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)],
			input = { storeRoot: f.storeRoot, digest: changed.digest };
		const report = verifyStamp(input);
		assert.equal(report.snapshotIntegrity, "mismatched");
		assert.equal(report.managedReproducible, false);
		assert.equal(report.managedReconstruction, "unverified");
		assert.ok(
			report.findings.some((v) => diagnostic.test(v)),
			report.findings.join("\n"),
		);
		assert.throws(() => reconstructStamp(input), diagnostic);
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
		verified(f, f.stamp.digest);
	});
for (const mode of ["missing", "byte", "length"])
	test(`P6B synthetic backing ${mode} distinct managed refusal without repair`, (t) => {
		const f = synthetic(t),
			snapshot = structuredClone(f.stamp.snapshot),
			backing = snapshot.composition[0].resources[0].backing;
		let digest = f.stamp.digest;
		const blobFile = path.join(f.storeRoot, "blobs/sha256", backing.sha256);
		if (mode === "missing") fs.rmSync(blobFile);
		if (mode === "byte") {
			const altered = Buffer.from(binary);
			altered[0] = 42;
			put(blobFile, altered);
		}
		if (mode === "length") {
			backing.bytes++;
			digest = writeSnapshot(f, snapshot).digest;
		}
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)],
			input = { digest, storeRoot: f.storeRoot },
			report = verifyStamp(input);
		assert.equal(report.snapshotIntegrity, "verified");
		assert.equal(
			report.managedContent,
			mode === "missing" ? "missing" : "mismatched",
		);
		assert.equal(report.managedReconstruction, "unverified");
		assert.equal(report.managedReproducible, false);
		const diagnostic =
			mode === "missing" ? /ENOENT/ : /blob: bytes length\/digest mismatch/;
		assert.ok(
			report.findings.some((v) => diagnostic.test(v)),
			report.findings.join("\n"),
		);
		assert.ok(report.findings.join("\n").includes(backing.sha256));
		assert.throws(() => reconstructStamp(input), diagnostic);
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	});

function resourceReads(f, run) {
	const reads = [],
		forbidden = [path.join(f.root, "unread"), f.home];
	const guard = (original) =>
		function (file, ...args) {
			const target = typeof file === "string" ? path.resolve(file) : "";
			if (
				forbidden.some((p) => target === p || target.startsWith(p + path.sep))
			)
				throw new Error(`undeclared read: ${target}`);
			if (target.startsWith(path.join(f.root, "assets") + path.sep))
				reads.push(target);
			return original.call(this, file, ...args);
		};
	intercept({ openSync: guard, readFileSync: guard, readdirSync: guard }, run);
	return reads;
}
test("P6B control declared-only read interception observes real open and rejects sentinel", (t) => {
	const f = fixture(t);
	const reads = resourceReads(f, () => {
		assert.deepEqual(readStoreFile(f.root, "assets/a.bin"), binary);
		assert.throws(
			() => readStoreFile(f.root, "unread/sentinel.bin"),
			/undeclared read/,
		);
		assert.throws(() => fs.readdirSync(f.home), /undeclared read/);
	});
	assert.ok(reads.includes(path.join(f.root, "assets/a.bin")));
});
resourceTest(
	"P6B declared-only capture never scans unrelated repository or home assets",
	"role",
	(t) => {
		const f = fixture(t);
		declare(f, "role", ["assets/a.bin"]);
		let stamp;
		const reads = resourceReads(f, () => {
			stamp = capture(f);
		});
		assert.ok(reads.includes(path.join(f.root, "assets/a.bin")));
		assert.deepEqual(verified(f, stamp.digest).resources, [
			{ ...resource("roles.reviewer", "assets/a.bin", binary), bytes: binary },
		]);
		assert.equal(
			fs.existsSync(
				path.join(f.storeRoot, "blobs/sha256", sha(Buffer.from("never read"))),
			),
			false,
		);
	},
);

test("P6B control read and backing-rename interception each edits once", (t) => {
	const f = fixture(t),
		asset = path.join(f.root, "assets/a.bin"),
		edited = Buffer.from("edited"),
		events = [];
	const staging = path.join(f.dir, "temporary"),
		final = path.join(f.dir, "published");
	put(staging, binary);
	intercept(
		{
			openSync: (original) =>
				function (file, ...args) {
					const result = original.call(this, file, ...args);
					if (
						typeof file === "string" &&
						path.resolve(file) === asset &&
						!events.includes("read")
					) {
						events.push("read");
						put(asset, edited);
					}
					return result;
				},
			renameSync: (original) =>
				function (from, to) {
					const result = original.call(this, from, to);
					if (to === final && !events.includes("publication")) {
						events.push("publication");
						put(asset, binary);
					}
					return result;
				},
		},
		() => {
			assert.throws(
				() => readStoreFile(f.root, "assets/a.bin"),
				/changed|identity/,
			);
			fs.renameSync(staging, final);
		},
	);
	assert.deepEqual(events, ["read", "publication"]);
	assert.deepEqual(fs.readFileSync(final), binary);
	assert.deepEqual(fs.readFileSync(asset), binary);
});
resourceTest(
	"P6B resource drift during backing publication preserves edits and prior stamp",
	"role",
	(t) => {
		const f = fixture(t);
		declare(f, "role", ["assets/a.bin"]);
		const prior = capture(f);
		const priorStore = fingerprint(f.storeRoot),
			asset = path.join(f.root, "assets/a.bin");
		const captured = Buffer.from([3, 4, 255]),
			edited = Buffer.from([5, 6, 255]);
		put(asset, captured);
		let edits = 0,
			failure;
		const publications = [];
		intercept(
			{
				renameSync: (original) =>
					function (from, to) {
						if (path.dirname(to) === path.join(f.storeRoot, "stamps/sha256"))
							publications.push(to);
						const result = original.call(this, from, to);
						if (
							to === path.join(f.storeRoot, "blobs/sha256", sha(captured)) &&
							edits === 0
						) {
							edits++;
							put(asset, edited);
						}
						return result;
					},
			},
			() => {
				try {
					createStamp(f.options);
				} catch (error) {
					failure = error;
				}
			},
		);
		assert.equal(
			edits,
			1,
			"owned edit must occur at actual backing publication",
		);
		assert.match(
			failure?.message ?? "",
			/assets\/a\.bin: stale-input: changed during capture/,
		);
		assert.deepEqual(publications, []);
		assert.deepEqual(fs.readFileSync(asset), edited);
		assert.deepEqual(fs.readdirSync(path.join(f.storeRoot, "stamps/sha256")), [
			prior.digest,
		]);
		for (const [p, value] of priorStore)
			assert.deepEqual(
				fingerprint(f.storeRoot).find(([q]) => q === p),
				[p, value],
				"all existing immutable backing preserved",
			);
		assert.deepEqual(verified(f, prior.digest).resources[0].bytes, binary);
	},
);

for (const mode of ["leaf-symlink", "ancestor-link", "hardlink"])
	test(`P6B control native ${mode} qualification against real reader`, (t) => {
		const f = fixture(t),
			outside = path.join(f.dir, "outside");
		put(path.join(outside, "data.bin"), binary);
		let relative = "assets/link.bin";
		try {
			if (mode === "hardlink")
				fs.linkSync(
					path.join(outside, "data.bin"),
					path.join(f.root, relative),
				);
			else if (mode === "leaf-symlink")
				fs.symlinkSync(
					path.join(outside, "data.bin"),
					path.join(f.root, relative),
					"file",
				);
			else {
				fs.symlinkSync(
					outside,
					path.join(f.root, "linked"),
					process.platform === "win32" ? "junction" : "dir",
				);
				relative = "linked/data.bin";
			}
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
			t.skip(`native ${mode} unavailable (${error.code})`);
			return;
		}
		assert.deepEqual(readStoreFile(f.root, "assets/a.bin"), binary);
		if (mode === "hardlink")
			assert.equal(fs.lstatSync(path.join(f.root, relative)).nlink, 2);
		else
			assert.equal(
				fs
					.lstatSync(
						path.join(f.root, mode === "ancestor-link" ? "linked" : relative),
					)
					.isSymbolicLink(),
				true,
			);
		assert.throws(() => readStoreFile(f.root, relative), /link|unsafe/);
		assert.deepEqual(fs.readFileSync(path.join(outside, "data.bin")), binary);
	});

for (const owner of ["profile", "role", "file-skill"])
	resourceTest(
		`P6B fresh child deleted-source ${owner} reconstruction`,
		owner === "file-skill" ? "required" : owner,
		(t) => {
			const f = fixture(t);
			if (owner === "file-skill") {
				declare(f, "required", ["assets/a.bin"]);
				declare(f, "idle", ["assets/z.bin"]);
			} else declare(f, owner, ["assets/a.bin"]);
			const stamp = capture(f),
				expected = verified(f, stamp.digest),
				storeBefore = fingerprint(f.storeRoot);
			assert.deepEqual(
				expected.resources,
				owner === "file-skill"
					? [
							{
								...resource("skills.required", "assets/a.bin", binary),
								bytes: binary,
							},
							{
								...resource("skills.idle", "assets/z.bin", Buffer.from("Z")),
								bytes: Buffer.from("Z"),
							},
						]
					: [
							{
								...resource(ownerBinding(owner), "assets/a.bin", binary),
								bytes: binary,
							},
						],
			);
			assert.deepEqual(
				expected.composition.map((e) => e.bytes),
				[instructions, Buffer.from("# reviewer\r\n"), skillBytes("required")],
			);
			fs.rmSync(f.root, { recursive: true });
			const moduleURL = new URL("../src/stamps.js", import.meta.url).href;
			const code = `import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
    import { reconstructStamp } from ${JSON.stringify(moduleURL)};
    const deleted = ${JSON.stringify(f.root)};
    for (const method of ['openSync','readFileSync','readdirSync','statSync','lstatSync','realpathSync']) {
      const original = fs[method]; fs[method] = function(file, ...args) {
        if (typeof file === 'string' && (path.resolve(file) === deleted || path.resolve(file).startsWith(deleted + path.sep))) throw new Error('live source read');
        return original.call(this, file, ...args);
      };
    } syncBuiltinESMExports();
    const r = reconstructStamp(${JSON.stringify({ digest: stamp.digest, storeRoot: f.storeRoot })});
    console.log(JSON.stringify(r));`;
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "--eval", code],
				{
					cwd: f.dir,
					env: {
						...process.env,
						HOME: f.home,
						USERPROFILE: f.home,
						AGENT_PROFILES_STORE: path.join(f.dir, "empty"),
					},
					encoding: "utf8",
				},
			);
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stderr);
			assert.equal(child.stderr, "");
			assert.deepEqual(
				JSON.parse(child.stdout),
				JSON.parse(JSON.stringify(expected)),
			);
			assert.equal(expected.resources.length, owner === "file-skill" ? 2 : 1);
			assert.deepEqual(
				expected.resources.map((r) => r.binding),
				owner === "file-skill"
					? ["skills.required", "skills.idle"]
					: [ownerBinding(owner)],
			);
			assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
			assert.equal(fs.existsSync(f.root), false);
		},
	);

// Callers are independent: a resolver refusal in one never skips another caller's assertions.
test("P6B caller discovery keeps configured membership metadata and resources", (t) => {
	const f = fixture(t);
	declare(f, "required");
	const before = fingerprint(f.root),
		found = discoverSkills(
			f.root,
			parseYaml(fs.readFileSync(path.join(f.root, CONFIG), "utf8")),
		);
	const selected = found.skills.find((e) => e.id === "required");
	assert.ok(selected);
	assert.deepEqual(selected.resources, ["assets/a.bin", "assets/z.bin"]);
	assert.equal(selected.name, "required");
	assert.equal(selected.description, "required <img src=x onerror=bad>");
	assert.equal(selected.path, "instructions/required.md");
	assert.deepEqual(found.warnings, []);
	assert.deepEqual(fingerprint(f.root), before);
});
test("P6B caller wizard selection and preselection retain resource metadata", async (t) => {
	const f = fixture(t);
	declare(f, "required");
	const found = discoverSkills(
			f.root,
			parseYaml(fs.readFileSync(path.join(f.root, CONFIG), "utf8")),
		),
		lines = [];
	const choice = found.skills.find((e) => e.id === "required");
	assert.ok(choice);
	assert.deepEqual(choice.resources, ["assets/a.bin", "assets/z.bin"]);
	const answers = ["1", ""];
	const chosen = await selectSkills({
		choices: [choice],
		label: "Required",
		ask: async () => {
			assert.ok(answers.length);
			return answers.shift();
		},
		write: (line) => lines.push(line),
	});
	assert.deepEqual(chosen, [choice]);
	const preselected = await selectSkills({
		choices: [choice],
		initial: chosen,
		label: "Required",
		ask: async () => "",
		write: (line) => lines.push(line),
	});
	assert.deepEqual(preselected, chosen);
	assert.ok(lines.join("\n").includes("assets/a.bin"));
});
for (const action of ["noop", "description", "lists"])
	test(`P6B caller configure ${action} preserves declarations and asset bytes`, (t) => {
		const f = fixture(t);
		declare(f, "role");
		declare(f, "required");
		const digest = mixed(f, t, "misleading");
		f.resolve();
		const before = fingerprint(f.root),
			original = fs.readFileSync(path.join(f.root, CONFIG));
		const input =
			action === "description"
				? { description: "Updated review" }
				: action === "lists"
					? { required: ["first"], available: ["required", "idle", "check"] }
					: {};
		const plan = planRoleChange({
			root: f.root,
			storeRoot: f.storeRoot,
			action: "edit",
			id: "reviewer",
			...input,
		});
		assert.deepEqual(fingerprint(f.root), before);
		assert.deepEqual(plan.resolution.loaded[1].resources, [
			"assets/a.bin",
			"assets/z.bin",
		]);
		const out = applyRoleChange(plan);
		assert.equal(out.resolution.installRequired, action !== "noop");
		assert.equal(
			out.resolution.available.find((e) => e.id === "check").package.sha256,
			digest,
		);
		const config = readConfiguration(f.root, {
			storeRoot: f.storeRoot,
		}).configuration;
		assert.deepEqual(config.get("roles").get("reviewer").get("resources"), [
			"assets/z.bin",
			"assets/a.bin",
		]);
		assert.deepEqual(config.get("skills").get("required").get("resources"), [
			"assets/z.bin",
			"assets/a.bin",
		]);
		assert.deepEqual(
			fingerprint(f.root, [CONFIG]),
			before.filter(([p]) => p !== CONFIG),
		);
		if (action === "noop") {
			assert.deepEqual(out.modified, []);
			assert.deepEqual(fs.readFileSync(path.join(f.root, CONFIG)), original);
		} else assert.deepEqual(out.modified, [CONFIG]);
		if (action === "lists")
			assert.deepEqual(
				out.resolution.required.map((e) => e.id),
				["first"],
			);
		if (action !== "noop") assert.throws(() => f.resolve(), /stale-lock/);
	});
test("P6B caller role wizard selects resource skill into unassigned role", async (t) => {
	const f = fixture(t);
	declare(f, "required");
	f.resolve();
	const before = fingerprint(f.root, [CONFIG]);
	const answers = [
			"e",
			"writer",
			"Writer edited",
			"",
			"/required",
			"1",
			"",
			"",
			"y",
			"q",
		],
		lines = [];
	await configureRoles({
		root: f.root,
		storeRoot: f.storeRoot,
		ask: async () => {
			assert.ok(answers.length, "bounded wizard transcript");
			return answers.shift();
		},
		write: (text) => lines.push(text),
	});
	assert.deepEqual(answers, []);
	assert.doesNotMatch(lines.join("\n"), /Error:/);
	assert.ok(lines.join("\n").includes("assets/a.bin"));
	assert.deepEqual(f.resolve({ role: "writer" }).required[0].resources, [
		"assets/a.bin",
		"assets/z.bin",
	]);
	assert.deepEqual(fingerprint(f.root, [CONFIG]), before);
});
test("P6B caller inspect mapped local profile has paths not package provenance", (t) => {
	const f = fixture(t);
	declare(f, "profile");
	declare(f, "role");
	declare(f, "required");
	const before = fingerprint(f.root),
		reads = [];
	const inventory = resourceReads(f, () => {
		intercept(
			{
				openSync: (original) =>
					function (file, ...args) {
						if (
							typeof file === "string" &&
							path.resolve(file).startsWith(f.storeRoot + path.sep)
						)
							reads.push(file);
						return original.call(this, file, ...args);
					},
			},
			() => {
				f.inventory = inspectRepository({
					root: f.root,
					environmentOptions: { env: {} },
				});
			},
		);
	});
	assert.deepEqual(
		inventory,
		[],
		"bounded inventory does not read resource bodies",
	);
	assert.deepEqual(reads, []);
	const config = f.inventory.repository.configuration;
	assert.equal(config.status, "valid");
	assert.equal(config.profiles[0].path, ".agent-profiles/mapped/actual.md");
	assert.equal(Object.hasOwn(config.profiles[0], "package"), false);
	for (const e of [
		config.profiles[0],
		config.roles.find((e) => e.id === "reviewer"),
		f.inventory.skills.skills.find((e) => e.id === "required"),
	])
		assert.deepEqual(e.resources, ["assets/a.bin", "assets/z.bin"]);
	assert.ok(!JSON.stringify(f.inventory).includes(binary.toString("base64")));
	assert.deepEqual(fingerprint(f.root), before);
});
for (const formatter of ["agent", "proof"])
	test(`P6B caller ${formatter} text exposes resources without instruction count inflation`, (t) => {
		const f = fixture(t);
		declare(f, "role");
		declare(f, "first");
		declare(f, "idle");
		const result = f.resolve({ skills: ["first"] }),
			text =
				formatter === "agent" ? formatContext(result) : formatProof(result);
		for (const p of ["assets/a.bin", "assets/z.bin"])
			assert.ok(text.includes(p), `resource reference ${p}`);
		assert.ok(text.includes("idle"));
		assert.doesNotMatch(text, /Read `null`|undefined|Invoke the null/);
		assert.deepEqual(
			result.diagnostics.managed,
			f.resolve({ skills: ["first"] }).diagnostics.managed,
		);
		assert.equal(
			result.diagnostics.managed.total.bytes,
			f.control.diagnostics.managed.total.bytes + skillBytes("first").length,
		);
		assert.equal(result.loaded.length, 4);
		assert.ok(!text.includes(f.storeRoot));
		assert.ok(!text.includes(binary.toString("base64")));
		if (formatter === "agent") {
			const replay = (output) => {
				const command = output
					.split("## Run again\n")[1]
					.match(/Command \(PowerShell\): `([^`]+)`/)[1];
				assert.ok(command.startsWith("npx --no agent-profiles resolve"));
				const tail = command.slice("npx --no agent-profiles resolve".length),
					ids = [];
				let rest = tail;
				while (rest) {
					const pair = /^ --skill '([a-z0-9-]+)'/.exec(rest);
					assert.ok(pair, rest);
					ids.push(pair[1]);
					rest = rest.slice(pair[0].length);
				}
				return f.resolve({ skills: ids });
			};
			assert.deepEqual(
				replay(text).loaded,
				result.loaded,
				"actual emitted re-entry command retains first selection",
			);
			const second = f.resolve({ skills: ["first", "idle"] });
			assert.deepEqual(
				second.loaded
					.filter((e) => e.kind === "requested-skill")
					.map((e) => e.id),
				["first", "idle"],
			);
			assert.deepEqual(second.loaded.find((e) => e.id === "first").resources, [
				"assets/a.bin",
				"assets/z.bin",
			]);
			assert.deepEqual(
				replay(formatContext(second)).loaded,
				second.loaded,
				"second re-entry preserves both ordered bodies",
			);
		}
	});

for (const command of ["resolve-json", "skills-json", "skills-text"])
	test(`P6B caller CLI ${command} retains local resources`, (t) => {
		const f = fixture(t);
		declare(f, "required");
		f.resolve();
		const before = fingerprint(f.root);
		const args =
			command === "resolve-json"
				? ["resolve", "--json", "--contents"]
				: command === "skills-json"
					? ["skills", "--json"]
					: ["skills"];
		const child = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url)),
				...args,
				"--root",
				f.root,
			],
			{
				cwd: f.dir,
				env: {
					...process.env,
					AGENT_PROFILES_STORE: f.storeRoot,
					HOME: f.home,
					USERPROFILE: f.home,
				},
				encoding: "utf8",
			},
		);
		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		if (command === "resolve-json")
			assert.deepEqual(JSON.parse(child.stdout).required[0].resources, [
				"assets/a.bin",
				"assets/z.bin",
			]);
		else if (command === "skills-json")
			assert.deepEqual(
				JSON.parse(child.stdout).skills.find((e) => e.id === "required")
					.resources,
				["assets/a.bin", "assets/z.bin"],
			);
		else
			for (const p of ["required", "assets/a.bin", "assets/z.bin"])
				assert.ok(child.stdout.includes(p));
		assert.deepEqual(fingerprint(f.root), before);
	});

for (const ambient of ["empty", "misleading"])
	test(`P6B caller visualizer initial and HTTP use explicit store with ${ambient} ambient`, async (t) => {
		const f = fixture(t);
		declare(f, "required");
		const digest = mixed(f, t, ambient);
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
		const { server, url } = await startVisualizer({
			root: f.root,
			storeRoot: f.storeRoot,
			skills: ["first"],
		});
		t.after(
			() =>
				new Promise((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				}),
		);
		const get = async (route) => {
			const response = await fetch(url + route);
			return { status: response.status, data: await response.json() };
		};
		const config = await get("api/config");
		assert.equal(config.status, 200);
		assert.deepEqual(config.data.initial.skills, ["first"]);
		const response = await get(
			"api/resolve?skill=first&skill=idle&skill=first",
		);
		assert.equal(response.status, 200);
		assert.deepEqual(response.data.required[0].resources, [
			"assets/a.bin",
			"assets/z.bin",
		]);
		assert.equal(
			response.data.available.find((e) => e.id === "check").package.sha256,
			digest,
		);
		assert.deepEqual(
			response.data.loaded
				.filter((e) => e.kind === "requested-skill")
				.map((e) => e.id),
			["first", "idle"],
		);
		const override = await get("api/resolve?storeRoot=elsewhere");
		assert.equal(override.status, 400);
		assert.match(override.data.error, /Unknown parameter: storeRoot/);
		f.config.roles.reviewer.description = "stales lock";
		f.save();
		for (const route of ["api/config", "api/resolve"]) {
			const stale = await get(route);
			assert.equal(stale.status, 400);
			assert.match(stale.data.error, /stale-lock/);
		}
		assert.deepEqual(
			fingerprint(f.root, [CONFIG]),
			before[0].filter(([p]) => p !== CONFIG),
		);
		assert.deepEqual(fingerprint(f.storeRoot), before[1]);
	});

// Minimal existing DOM seam, not full-browser qualification. Input resource metadata follows the accepted JSON contract.
function frontend(f) {
	class Node {
		constructor(tag = "") {
			this.tag = tag;
			this.children = [];
			this.textContent = "";
			this.listeners = {};
		}
		append(...children) {
			this.children.push(...children);
		}
		replaceChildren(...children) {
			this.children = children;
		}
		addEventListener(name, fn) {
			this.listeners[name] = fn;
		}
		setAttribute() {}
		removeAttribute() {}
		focus() {}
		set innerHTML(_) {
			throw new Error("resource and instruction metadata must use text nodes");
		}
	}
	const nodes = new Map(),
		queries = [];
	const document = {
		getElementById(id) {
			if (!nodes.has(id)) nodes.set(id, new Node());
			return nodes.get(id);
		},
		createElement: (tag) => new Node(tag),
		createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
	};
	const result = (skills) => {
		const r = resolutionOutput(f.resolve({ skills }), true);
		for (const e of [...r.loaded, ...r.required, ...r.available])
			e.resources = ["assets/a.bin", "assets/z.bin"];
		return r;
	};
	const context = vm.createContext({
		document,
		URLSearchParams,
		result: result(["first"]),
		fetch: async (endpoint) => {
			if (endpoint === "api/config") return new Promise(() => {});
			queries.push(endpoint);
			return {
				ok: true,
				json: async () =>
					result(new URLSearchParams(endpoint.split("?")[1]).getAll("skill")),
			};
		},
	});
	vm.runInContext(
		fs.readFileSync(
			new URL("../src/visualizer/app.js", import.meta.url),
			"utf8",
		) + "\nrequested = new Set(['first']); render(result);",
		context,
	);
	const texts = (node) =>
		[node.textContent, ...node.children.flatMap(texts)].join("\n");
	const all = (node) => [node, ...node.children.flatMap(all)];
	return {
		nodes,
		queries,
		text: (id) => texts(nodes.get(id)),
		descendants: (id) => all(nodes.get(id)),
	};
}
test("P6B caller real frontend renders resource references as text and retains available selection", async (t) => {
	const f = fixture(t),
		before = fingerprint(f.root),
		ui = frontend(f);
	assert.ok(
		ui.text("layers").includes(".agent-profiles/profiles/base.md"),
		"existing render path control",
	);
	assert.ok(
		ui.text("available").includes("<img src=x onerror=bad>"),
		"metadata remains literal text",
	);
	for (const id of ["layers", "required", "available"])
		for (const p of ["assets/a.bin", "assets/z.bin"])
			assert.ok(ui.text(id).includes(p), `${id}: ${p}`);
	const checkbox = ui
		.descendants("available")
		.find((n) => n.id === "skill-idle");
	assert.ok(checkbox);
	checkbox.checked = true;
	checkbox.listeners.change();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.queries, ["api/resolve?skill=first&skill=idle"]);
	assert.equal(
		ui.descendants("available").find((n) => n.id === "skill-first").checked,
		true,
	);
	assert.equal(
		ui.descendants("available").find((n) => n.id === "skill-idle").checked,
		true,
	);
	assert.doesNotMatch(ui.text("available"), /null: null|undefined|Read null/);
	assert.deepEqual(fingerprint(f.root), before);
});

function exportOptions(f, extra = {}) {
	return {
		root: f.root,
		storeRoot: f.storeRoot,
		destination: path.join(f.dir, "export"),
		metadata,
		roles: ["writer"],
		profiles: [],
		...extra,
	};
}
test("P6B caller preset mapped profile without assets exports actual raw path", (t) => {
	const f = fixture(t);
	declare(f, "profile", []);
	delete f.config.profiles.base.resources;
	f.save();
	f.resolve();
	const before = fingerprint(f.root),
		options = exportOptions(f, { profiles: ["base"] });
	const plan = planPresetExport(options);
	assert.equal(fs.existsSync(options.destination), false);
	assert.deepEqual(plan.preset.payload.get("profiles/base.md"), instructions);
	applyPresetExport(plan, true);
	assert.equal(readPreset(options.destination).data.get("schema_version"), 1);
	assert.deepEqual(
		fs.readFileSync(path.join(options.destination, "profiles/base.md")),
		instructions,
	);
	assert.deepEqual(fingerprint(f.root), before);
});
for (const [owner, included] of [
	["profile", false],
	["role", false],
	["required", true],
	["required", false],
	["idle", false],
]) {
	test(`P6B caller preset export refuses ${owner} resources ${included ? "included" : "referenced"}`, (t) => {
		const f = fixture(t);
		declare(f, owner);
		f.resolve();
		const options = exportOptions(f, {
			roles: owner === "profile" ? ["writer"] : ["reviewer"],
			profiles: owner === "profile" ? ["base"] : [],
			includeSkills: included ? ["required"] : [],
		});
		refusesUnchanged(f, () => planPresetExport(options), [
			new RegExp(ownerBinding(owner).replaceAll(".", "\\.")),
			/preset-resources-unsupported/,
		]);
		assert.equal(fs.existsSync(options.destination), false);
	});
}
test("P6B caller preset unrelated resource bindings do not block ordinary export", (t) => {
	const f = fixture(t);
	declare(f, "role");
	declare(f, "required");
	f.resolve();
	const before = fingerprint(f.root),
		options = exportOptions(f),
		plan = planPresetExport(options);
	applyPresetExport(plan, true);
	assert.deepEqual(
		[...readPreset(options.destination).roles.keys()],
		["writer"],
	);
	assert.deepEqual(fingerprint(f.root), before);
});
test("P6B caller preset wizard refuses resource export before output creation", async (t) => {
	const f = fixture(t);
	declare(f, "role");
	f.resolve();
	const before = fingerprint(f.root),
		destination = path.join(f.dir, "export");
	const answers = [
		"clear",
		"",
		"",
		"local-review",
		"Local review",
		"Owned fixture",
		"Example",
		"1.0.0",
		"MIT",
	];
	await assert.rejects(
		() =>
			runPreset({
				command: "export",
				location: destination,
				root: f.root,
				storeRoot: f.storeRoot,
				roles: ["reviewer"],
				ask: async () => {
					assert.ok(answers.length, "bounded preset transcript");
					return answers.shift();
				},
				write: () => {},
			}),
		/roles\.reviewer: preset-resources-unsupported/,
	);
	assert.equal(fs.existsSync(destination), false);
	assert.deepEqual(fingerprint(f.root), before);
});
function incoming(f, owner) {
	const source = path.join(f.dir, "preset"),
		role = owner === "role" ? "reviewer" : "incoming";
	const data = {
		schema_version: 1,
		preset: metadata,
		roles: {
			[role]: {
				file: `roles/${role}.md`,
				skills: {
					required: owner === "required" ? ["required"] : [],
					available: [],
				},
			},
		},
		profiles: owner === "profile" ? { base: { file: "profiles/base.md" } } : {},
		skills: {
			requires: [],
			includes:
				owner === "required"
					? { required: { file: "skills/required.md" } }
					: {},
		},
	};
	put(path.join(source, `roles/${role}.md`), "# Incoming role\n");
	if (owner === "profile")
		put(path.join(source, "profiles/base.md"), "# Incoming profile\n");
	if (owner === "required")
		put(path.join(source, "skills/required.md"), skillBytes("incoming"));
	put(path.join(source, "preset.yaml"), stringify(data));
	readPreset(source);
	return source;
}
for (const owner of ["profile", "role", "required"])
	for (const decision of ["keep", "rename"]) {
		test(`P6B caller preset import ${decision} preserves existing ${owner} resources`, (t) => {
			const f = fixture(t);
			declare(f, owner);
			f.resolve();
			const source = incoming(f, owner),
				before = fingerprint(f.root);
			const binding = ownerBinding(owner),
				choices = new Map([
					[binding, decision === "keep" ? "keep" : "rename:renamed"],
				]);
			const plan = planPresetImport({
				root: f.root,
				storeRoot: f.storeRoot,
				source,
				decisions: choices,
			});
			assert.equal(plan.ready, true, plan.errors.join("\n"));
			assert.deepEqual(fingerprint(f.root), before);
			applyPresetImport(plan, true);
			const r = f.resolve();
			const e =
				owner === "profile"
					? r.loaded[0]
					: owner === "role"
						? r.loaded[1]
						: r.required.find((e) => e.id === "required");
			assert.deepEqual(e.resources, ["assets/a.bin", "assets/z.bin"]);
			for (const [p, hash] of before.filter(([p]) => p !== CONFIG))
				assert.deepEqual(
					fingerprint(f.root).find(([q]) => q === p),
					[p, hash],
				);
			if (decision === "rename") {
				const file =
					owner === "required"
						? ".agent-profiles/skills/renamed/SKILL.md"
						: `.agent-profiles/${owner === "profile" ? "profiles" : "roles"}/renamed.md`;
				assert.ok(fs.existsSync(path.join(f.root, file)));
				assert.deepEqual(
					fs.readFileSync(path.join(f.root, file)),
					owner === "required"
						? skillBytes("incoming")
						: Buffer.from(
								owner === "profile"
									? "# Incoming profile\n"
									: "# Incoming role\n",
							),
				);
				if (owner === "role")
					assert.equal(
						f.resolve({ role: "renamed" }).loaded[1].content,
						"# Incoming role\n",
					);
				if (owner === "required")
					assert.equal(
						f
							.resolve({ role: "incoming" })
							.loaded.find((e) => e.id === "renamed").content,
						skillBytes("incoming").toString("utf8"),
					);
			}
		});
	}
for (const owner of ["profile", "role", "required"])
	test(`P6B caller preset replace refuses identity loss for ${owner} resources`, (t) => {
		const f = fixture(t);
		declare(f, owner);
		f.resolve();
		const source = incoming(f, owner),
			before = [fingerprint(f.root), fingerprint(f.storeRoot)];
		let plan, refusal;
		try {
			plan = planPresetImport({
				root: f.root,
				storeRoot: f.storeRoot,
				source,
				decisions: new Map([[ownerBinding(owner), "replace"]]),
			});
		} catch (error) {
			refusal = error.message;
		}
		if (plan) {
			assert.equal(
				plan.ready,
				false,
				"replacement must not silently discard declared assets",
			);
			refusal = plan.errors.join("\n");
			assert.throws(
				() => applyPresetImport(plan, true),
				/conflicts|dependencies|resources/,
			);
		}
		assert.ok(refusal?.includes(ownerBinding(owner)), refusal);
		assert.match(refusal ?? "", /resource|mapped|identity/i);
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	});
test("P6B caller mapped profile replace cannot report ineffective success", (t) => {
	const f = fixture(t);
	declare(f, "profile", []);
	f.resolve();
	const source = incoming(f, "profile"),
		before = fingerprint(f.root);
	let plan, refusal;
	try {
		plan = planPresetImport({
			root: f.root,
			storeRoot: f.storeRoot,
			source,
			decisions: new Map([["profiles.base", "replace"]]),
		});
	} catch (error) {
		refusal = error.message;
	}
	if (plan?.ready) {
		const result = applyPresetImport(plan, true);
		assert.equal(result.resolution.loaded[0].content, "# Incoming profile\n");
		assert.equal(f.resolve().loaded[0].content, "# Incoming profile\n");
	} else {
		refusal ??= plan?.errors.join("\n");
		assert.match(refusal ?? "", /profiles\.base/);
		assert.match(refusal ?? "", /mapped|replace|identity/i);
		assert.deepEqual(fingerprint(f.root), before);
	}
});

for (const [owner, label, invalid] of [
	["role", "null", null],
	["role", "string", "assets/a.bin"],
	["role", "number", 7],
	["role", "boolean", true],
	["role", "map", { member: "assets/a.bin" }],
	["role", "[null]", [null]],
	["role", "[number]", [987654321]],
	["profile", "null", null],
	["required", "null", null],
])
	resourceTest(
		`P6B completion ${owner} resources ${label} refuses invalid collection`,
		owner,
		(t) => {
			const f = fixture(t);
			declare(f, owner, ["assets/a.bin"]);
			const resolved = f.resolve(),
				binding = ownerBinding(owner);
			const selected =
				owner === "profile"
					? resolved.loaded[0]
					: owner === "role"
						? resolved.loaded[1]
						: resolved.required[0];
			assert.deepEqual(selected.resources, ["assets/a.bin"]);
			const valid = capture(f),
				expected = [resource(binding, "assets/a.bin", binary)];
			assert.deepEqual(
				snapshotEntry(valid.snapshot, owner).resources,
				expected,
			);
			assert.deepEqual(
				verified(f, valid.digest).resources,
				expected.map((r) => ({ ...r, bytes: binary })),
			);
			const declaration =
				owner === "profile"
					? f.config.profiles.base
					: owner === "role"
						? f.config.roles.reviewer
						: f.config.skills.required;
			declaration.resources = invalid;
			f.save();
			const patterns = [
				new RegExp(binding.replaceAll(".", "\\.") + ".*resources"),
				Array.isArray(invalid) ? /\bstrings?\b/i : /\b(?:array|list)\b/i,
			];
			const refuse = () => {
				refusesUnchanged(f, () => f.resolve(), patterns);
				refusesUnchanged(f, () => createStamp(f.options), patterns);
			};
			if (Array.isArray(invalid)) {
				const member = invalid[0],
					accesses = [];
				intercept(
					Object.fromEntries(
						[
							"existsSync",
							"openSync",
							"readFileSync",
							"statSync",
							"lstatSync",
							"realpathSync",
						].map((method) => [
							method,
							(original) =>
								function (file, ...args) {
									if (
										file === member ||
										file === String(member) ||
										file === path.join(f.root, String(member))
									) {
										accesses.push(method);
										throw new Error(
											"nonstring resource member reached filesystem",
										);
									}
									return original.call(this, file, ...args);
								},
						]),
					),
					refuse,
				);
				assert.deepEqual(
					accesses,
					[],
					"nonstring resource members must refuse before filesystem access",
				);
			} else refuse();
		},
	);

for (const mode of ["malformed-list", "missing-asset"])
	resourceTest(
		`P6B completion unused local profile ${mode} refuses before capture`,
		"profile",
		(t) => {
			const f = fixture(t),
				profilePath = "mapped/unused.md",
				asset = "assets/a.bin";
			put(
				path.join(f.root, ".agent-profiles", profilePath),
				"# Unused local profile\n",
			);
			f.config.profiles = { unused: { file: profilePath, resources: [asset] } };
			f.save();
			assert.deepEqual(fs.readFileSync(path.join(f.root, asset)), binary);
			const resolved = f.resolve();
			assert.equal(f.config.default_profile, "base");
			assert.equal(resolved.profile, "base");
			assert.equal(
				resolved.loaded.some((e) => e.id === "unused"),
				false,
			);
			assert.equal(resolved.loaded[0].path, ".agent-profiles/profiles/base.md");
			assert.deepEqual(
				fs.readFileSync(path.join(f.root, ".agent-profiles/profiles/base.md")),
				instructions,
			);
			const valid = capture(f),
				restored = verified(f, valid.digest);
			assert.deepEqual(valid.snapshot.composition[0].backing, {
				type: "blob",
				path: ".agent-profiles/profiles/base.md",
				sha256: sha(instructions),
				bytes: instructions.length,
			});
			assert.equal(
				valid.snapshot.composition.some((e) => e.id === "unused"),
				false,
			);
			assert.deepEqual(restored.composition[0].bytes, instructions);
			assert.deepEqual(restored.resources, []);
			const missing = "assets/missing-unused.bin";
			f.config.profiles.unused.resources =
				mode === "malformed-list" ? asset : [missing];
			f.save();
			const patterns = [
				/profiles\.unused.*resources/,
				mode === "malformed-list"
					? /\b(?:array|list)\b/i
					: /assets\/missing-unused\.bin/,
			];
			if (mode === "missing-asset") {
				assert.equal(fs.existsSync(path.join(f.root, missing)), false);
				patterns.push(/missing|ENOENT|cannot access/i);
			}
			refusesUnchanged(f, () => f.resolve(), patterns);
			refusesUnchanged(f, () => createStamp(f.options), patterns);
		},
	);
