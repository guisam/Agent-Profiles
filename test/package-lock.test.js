import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { importPackage, lookupPackage } from "../src/package-store.js";
import {
	canonicalJSON,
	hashRecord,
	hashTree,
	readPackage,
} from "../src/packages.js";
import { parseYaml, resolveInstructions } from "../src/resolve.js";

// P5a tests only: the accepted seam has no required return shape or helper exports.
const moduleURL = new URL("../src/package-lock.js", import.meta.url);
let installDependencies,
	absent = false;
try {
	({ installDependencies } = await import(moduleURL.href));
} catch (error) {
	if (
		error.code !== "ERR_MODULE_NOT_FOUND" ||
		error.url !== moduleURL.href ||
		fs.existsSync(fileURLToPath(moduleURL))
	)
		throw error;
	absent = true;
}
const blocked = absent
	? "P5a blocked: src/package-lock.js is absent; install assertions unexecuted"
	: false;
const configPath = ".agent-profiles/agents.yaml";
const lockPath = ".agent-profiles/agent-profiles.lock";
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const copy = (value) => structuredClone(value);

// Independent §3 oracle, never calling production canonical/hash helpers.
function json(value) {
	if (typeof value === "string")
		return (
			'"' +
			[...value]
				.map((c) => {
					const n = c.codePointAt(0);
					assert.ok(n < 0xd800 || n > 0xdfff, "unpaired surrogate");
					return n < 32
						? `\\u${n.toString(16).padStart(4, "0")}`
						: c === '"' || c === "\\"
							? `\\${c}`
							: c;
				})
				.join("") +
			'"'
		);
	if (value === null || typeof value === "boolean") return String(value);
	if (typeof value === "number") {
		assert.ok(Number.isSafeInteger(value) && !Object.is(value, -0));
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
	assert.equal(Object.getPrototypeOf(value), Object.prototype);
	return (
		"{" +
		Object.keys(value)
			.sort(byteOrder)
			.map((k) => `${json(k)}:${json(value[k])}`)
			.join(",") +
		"}"
	);
}
function u64(n) {
	assert.ok(Number.isSafeInteger(n) && n >= 0);
	const bytes = Buffer.alloc(8);
	bytes.writeBigUInt64BE(BigInt(n));
	return bytes;
}
function record(domain, value) {
	const bytes = Buffer.from(json(value));
	return sha(
		Buffer.concat([
			Buffer.from(domain),
			Buffer.from([0]),
			u64(bytes.length),
			bytes,
		]),
	);
}
function tree(files) {
	const fields = [
		Buffer.from("agent-profiles/package-tree/v1\0"),
		u64(files.length),
	];
	for (const file of [...files].sort((a, b) => byteOrder(a.path, b.path))) {
		const name = Buffer.from(file.path);
		fields.push(
			Buffer.from([0x46]),
			u64(name.length),
			name,
			u64(file.bytes.length),
			file.bytes,
		);
	}
	return sha(Buffer.concat(fields));
}
function configDigest(config) {
	const value = copy(config);
	for (const key of ["skills", "profiles", "assignments"])
		if (!Object.hasOwn(value, key)) value[key] = {};
	return record("agent-profiles/config/v2", value);
}
function plain(value) {
	if (value instanceof Map)
		return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
	return Array.isArray(value) ? value.map(plain) : value;
}
function write(root, relative, bytes) {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, bytes);
}
function fingerprint(root, exclusions = []) {
	const result = [];
	function visit(dir) {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir)) {
			const file = path.join(dir, entry);
			const label = path.relative(root, file).split(path.sep).join("/");
			if (exclusions.includes(label)) continue;
			const stat = fs.lstatSync(file);
			if (stat.isSymbolicLink())
				result.push([label, "link", fs.readlinkSync(file)]);
			else if (stat.isDirectory()) {
				result.push([label, "directory"]);
				visit(file);
			} else result.push([label, "file", sha(fs.readFileSync(file))]);
		}
	}
	visit(root);
	return result.sort((a, b) => byteOrder(a[0], b[0]));
}
const releases = [
	["review", "1.0.0", "skill"],
	["review", "2.0.0", "skill"],
	["review", "3.0.0", "skill"],
	["optional", "1.0.0", "skill"],
	["orphan", "1.0.0", "skill"],
	["context", "1.0.0", "instruction"],
	["context", "2.0.0", "instruction"],
];
function configuration() {
	return {
		version: 2,
		default_profile: "alpha",
		default_role: "reviewer",
		models: {
			"fiction-small": { profile: "alpha", aliases: ["fiction-alias"] },
			"fiction-large": { profile: "beta" },
		},
		families: {
			fiction: { profile: "alpha", match: { prefixes: ["fiction-"] } },
		},
		profiles: {
			alpha: { package: "@fixture/context", version: "1.0.0" },
			beta: { package: "@fixture/context", version: "1.0.0" },
			unused: { package: "@fixture/context", version: "1.0.0" },
		},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: ["review"], available: ["optional", "orphan"] },
			},
			idle: {
				package: "@fixture/context",
				version: "1.0.0",
				skills: { required: [], available: [] },
			},
		},
		skills: {
			review: { package: "@fixture/review", version: "1.0.0" },
			optional: { package: "@fixture/optional", version: "1.0.0" },
			orphan: { package: "@fixture/orphan", version: "1.0.0" },
		},
		assignments: {
			fallback: { when: {}, versions: { "skills.review": "3.0.0" } },
			small: {
				when: { model: "fiction-small", role: "reviewer" },
				versions: { "skills.review": "1.0.0" },
			},
			large: {
				when: { model: "fiction-large", role: "reviewer" },
				versions: { "skills.review": "2.0.0" },
			},
			idle: { when: { role: "idle" }, versions: { "roles.idle": "2.0.0" } },
			unused: {
				when: { model: "fiction-small" },
				versions: { "profiles.unused": "2.0.0" },
			},
		},
	};
}
// Explicit declaration table prevents a second copy of the installer's pin walker.
const declaredPins = [
	["profiles.alpha", null, "context", "1.0.0"],
	["profiles.beta", null, "context", "1.0.0"],
	["profiles.unused", null, "context", "1.0.0"],
	["profiles.unused", "unused", "context", "2.0.0"],
	["roles.idle", null, "context", "1.0.0"],
	["roles.idle", "idle", "context", "2.0.0"],
	["skills.optional", null, "optional", "1.0.0"],
	["skills.orphan", null, "orphan", "1.0.0"],
	["skills.review", null, "review", "1.0.0"],
	["skills.review", "fallback", "review", "3.0.0"],
	["skills.review", "large", "review", "2.0.0"],
	["skills.review", "small", "review", "1.0.0"],
];
function makePackage(root, id, version, type) {
	const directory = `vendor/${id}-${version}`;
	const files = [
		{
			path: "package.yaml",
			bytes: Buffer.from(
				`schema_version: 1\npackage:\n  name: "@fixture/${id}"\n  version: "${version}"\n  type: ${type}\nentrypoint: ENTRY.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n`,
			),
		},
		{
			path: "ENTRY.md",
			bytes: Buffer.from(
				`${
					type === "skill"
						? `---\ndescription: Fixture ${id}.\n---\n`
						: "\ufeff"
				}${id} ${version}\r\n\r\n`,
			),
		},
		{
			path: "assets/data.bin",
			bytes: Buffer.from([0, 255, Number(version[0]), 13, 10]),
		},
		{ path: ".hidden", bytes: Buffer.alloc(0) },
	];
	for (const file of files)
		write(root, `${directory}/${file.path}`, file.bytes);
	const source = { name: `@fixture/${id}`, version, directory };
	return {
		...source,
		files: files.sort((a, b) => byteOrder(a.path, b.path)),
		sha256: tree(files),
	};
}
function fixture(t, { cached = false } = {}) {
	const owned = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-p5a-")),
	);
	t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
	const root = path.join(owned, "project"),
		storeRoot = path.join(owned, "store");
	fs.mkdirSync(root);
	fs.mkdirSync(storeRoot);
	const config = configuration();
	write(root, configPath, JSON.stringify(config, null, 2));
	write(root, ".agent-profiles/roles/reviewer.md", "Local reviewer\r\n");
	write(root, "AGENTS.md", "Host-owned instructions\r\n");
	write(root, ".claude/keep.txt", "host setting\n");
	const packages = releases.map((args) => makePackage(root, ...args));
	for (const pkg of packages) {
		const validated = readPackage({
			root: path.join(root, pkg.directory),
			approvedRoot: root,
		});
		assert.equal(validated.sha256, pkg.sha256);
		assert.deepEqual(validated.files, pkg.files);
		if (cached)
			importPackage({
				storeRoot,
				sourceDirectory: path.join(root, pkg.directory),
				expectedDigest: pkg.sha256,
			});
	}
	const sources = packages.map(({ name, version, directory }) => ({
		name,
		version,
		directory,
	}));
	return { owned, root, storeRoot, config, packages, sources };
}
function golden(f, provenance = "local-directory") {
	const pins = declaredPins.map(([binding, rule, id, version]) => ({
		binding,
		rule,
		package: `@fixture/${id}`,
		version,
		sha256: f.packages.find(
			(p) => p.name === `@fixture/${id}` && p.version === version,
		).sha256,
	}));
	const packages = f.packages
		.map(({ name, version, sha256, directory }) => ({
			name,
			version,
			sha256,
			source:
				provenance === "local-directory"
					? { type: provenance, locator: directory }
					: { type: provenance },
		}))
		.sort(
			(a, b) => byteOrder(a.name, b.name) || byteOrder(a.version, b.version),
		);
	return {
		lockVersion: 1,
		configurationVersion: 2,
		resolverContract: "agent-profiles/resolver/v2",
		configSha256: configDigest(f.config),
		pins,
		packages,
	};
}
function saveLock(f, lock = golden(f)) {
	write(f.root, lockPath, Buffer.from(json(lock)));
}
function verifyStore(f) {
	for (const pkg of f.packages) {
		const found = lookupPackage({
			storeRoot: f.storeRoot,
			name: pkg.name,
			version: pkg.version,
		});
		assert.ok(found, `missing ${pkg.name}@${pkg.version}`);
		assert.equal(found.sha256, pkg.sha256);
		assert.deepEqual(found.files, pkg.files);
	}
}
async function invoke(f, options = {}) {
	await installDependencies({
		root: f.root,
		storeRoot: f.storeRoot,
		sources: [],
		frozen: false,
		offline: false,
		...options,
	});
}
async function refusal(
	f,
	options,
	diagnostic,
	{ unchangedStore = false } = {},
) {
	const project = fingerprint(f.root),
		store = fingerprint(f.storeRoot);
	await assert.rejects(async () => invoke(f, options), diagnostic);
	assert.deepEqual(
		fingerprint(f.root),
		project,
		"refusal changed config/lock/source/host bytes",
	);
	if (unchangedStore)
		assert.deepEqual(
			fingerprint(f.storeRoot),
			store,
			"preflight imported an earlier source",
		);
}
function acquisitionGuard(t) {
	const calls = [],
		mocks = [];
	for (const [target, names] of [
		[
			childProcess,
			[
				"spawn",
				"spawnSync",
				"exec",
				"execSync",
				"execFile",
				"execFileSync",
				"fork",
			],
		],
		[net, ["connect", "createConnection"]],
		[tls, ["connect"]],
		[http, ["request", "get"]],
		[https, ["request", "get"]],
		[dns, ["lookup", "resolve"]],
		[dns.promises, ["lookup", "resolve"]],
		[globalThis, ["fetch"]],
	])
		for (const name of names)
			mocks.push(
				t.mock.method(target, name, () => {
					calls.push(name);
					throw new Error(`forbidden acquisition/dispatch: ${name}`);
				}),
			);
	syncBuiltinESMExports();
	return {
		calls,
		close() {
			for (const mock of mocks) mock.mock.restore();
			syncBuiltinESMExports();
		},
	};
}
function installTest(name, body) {
	test(`P5a ${name}`, { skip: blocked }, async (t) => {
		const guard = acquisitionGuard(t);
		try {
			await body(t);
		} finally {
			guard.close();
			assert.deepEqual(
				guard.calls,
				[],
				"network/npm/native dispatch attempted",
			);
		}
	});
}

test("P5a independent RECORD framing has fixed Unicode control vector", () => {
	const value = { z: 0, a: [true, null, "é/\n"] };
	assert.equal(json(value), '{"a":[true,null,"é/\\u000a"],"z":0}');
	assert.equal(
		record("agent-profiles/config/v2", value),
		"a692502839e48b360fe61bdbd5465ee1b05086cf8bfce94c5d79ff382b14ae55",
	);
	assert.equal(
		hashRecord("agent-profiles/config/v2", value),
		record("agent-profiles/config/v2", value),
	);
	assert.deepEqual(canonicalJSON(value), Buffer.from(json(value)));
	assert.notEqual(
		record("agent-profiles/lock/v1", value),
		record("agent-profiles/config/v2", value),
	);
	assert.notEqual(
		record("agent-profiles/config/v2", ["ab", "c"]),
		record("agent-profiles/config/v2", ["a", "bc"]),
	);
	for (const bad of [-0, 1.5, Infinity, "\ud800"])
		assert.throws(() => json(bad));
});
test("P5a independent TREE framing includes binary empty manifest resources and order", (t) => {
	const f = fixture(t);
	for (const pkg of f.packages) {
		assert.equal(hashTree([...pkg.files].reverse()), pkg.sha256);
		assert.equal(tree([...pkg.files].reverse()), pkg.sha256);
		for (const file of pkg.files) {
			const altered = pkg.files.map((p) => ({
				...p,
				bytes:
					p === file ? Buffer.concat([p.bytes, Buffer.from([0])]) : p.bytes,
			}));
			assert.notEqual(tree(altered), pkg.sha256, file.path);
		}
	}
	assert.notEqual(
		tree([{ path: "a", bytes: Buffer.from("bc") }]),
		tree([{ path: "ab", bytes: Buffer.from("c") }]),
	);
});
test("P5a preservation fingerprint excludes only permitted forward-slash label", (t) => {
	const f = fixture(t);
	saveLock(f);
	const before = fingerprint(f.root, [lockPath]);
	write(f.root, lockPath, "changed permitted lock");
	assert.deepEqual(fingerprint(f.root, [lockPath]), before);
	write(f.root, ".agent-profiles/roles/reviewer.md", "changed protected role");
	assert.notDeepEqual(fingerprint(f.root, [lockPath]), before);
	assert.ok(before.some(([label]) => label === configPath));
	assert.ok(before.every(([label]) => !label.includes("\\")));
});
test("P5a real validated store and two fictional models select exact releases", (t) => {
	const f = fixture(t, { cached: true });
	verifyStore(f);
	saveLock(f);
	const before = fingerprint(f.owned);
	for (const [model, profile, version, rule] of [
		["fiction-small", "alpha", "1.0.0", "small"],
		["fiction-large", "beta", "2.0.0", "large"],
	]) {
		const result = resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			model,
		});
		assert.equal(result.identity.canonical, model);
		assert.equal(result.matchedBy, "model");
		assert.equal(result.profile, profile);
		assert.equal(result.role, "reviewer");
		assert.deepEqual(
			result.required.map((s) => s.id),
			["review"],
		);
		assert.deepEqual(
			result.available.map((s) => s.id),
			["optional", "orphan"],
		);
		const pkg = f.packages.find(
			(p) => p.name === "@fixture/review" && p.version === version,
		);
		assert.deepEqual(result.required[0].package, {
			binding: "skills.review",
			name: pkg.name,
			version,
			sha256: pkg.sha256,
			selectedBy: rule,
			selectors: { model, role: "reviewer" },
		});
		assert.equal(
			result.loaded.find((p) => p.id === "review").content,
			pkg.files.find((p) => p.path === "ENTRY.md").bytes.toString("utf8"),
		);
	}
	assert.deepEqual(fingerprint(f.owned), before);
});
test("P5a golden coverage oracle rejects each missing and foreign member", (t) => {
	const f = fixture(t),
		expected = golden(f);
	assert.equal(expected.pins.length, 12);
	assert.equal(expected.packages.length, 7);
	assert.equal(
		new Set(expected.pins.map((p) => JSON.stringify([p.binding, p.rule]))).size,
		12,
	);
	const bytes = Buffer.from(json(expected));
	for (const key of ["pins", "packages"]) {
		for (let i = 0; i < expected[key].length; i++) {
			const changed = copy(expected);
			changed[key].splice(i, 1);
			assert.notDeepEqual(Buffer.from(json(changed)), bytes);
		}
		const changed = copy(expected);
		changed[key].push(copy(expected[key][0]));
		assert.notDeepEqual(Buffer.from(json(changed)), bytes);
		const foreign = copy(expected);
		if (key === "pins")
			foreign.pins.push({ ...expected.pins[0], binding: "skills.foreign" });
		else
			foreign.packages.push({
				...expected.packages[0],
				name: "@fixture/foreign",
			});
		assert.notDeepEqual(Buffer.from(json(foreign)), bytes);
	}
	assert.equal(
		configDigest(f.config),
		configDigest(
			plain(parseYaml(fs.readFileSync(path.join(f.root, configPath), "utf8"))),
		),
	);
});
test("P5a independent config oracle preserves lists and ignores formatting and map order", (t) => {
	const f = fixture(t, { cached: true });
	const parsed = plain(
		parseYaml(`# comment\n${JSON.stringify(f.config, null, 4)}`),
	);
	assert.deepEqual(parsed, f.config);
	const reversed = Object.fromEntries(Object.entries(parsed).reverse());
	reversed.assignments = Object.fromEntries(
		Object.entries(parsed.assignments).reverse(),
	);
	assert.equal(configDigest(reversed), configDigest(f.config));
	for (const [name, change] of drift) {
		const altered = copy(parsed);
		change(altered);
		assert.notEqual(configDigest(altered), configDigest(parsed), name);
	}
	const zero = zeroPins(f);
	const local = resolveInstructions({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(local.profile, "local");
	assert.equal(configDigest(f.config), zero.configSha256);
	for (const key of ["skills", "profiles", "assignments"]) f.config[key] = {};
	assert.equal(configDigest(f.config), zero.configSha256);
	write(f.root, configPath, JSON.stringify(f.config));
	assert.equal(
		resolveInstructions({ root: f.root, storeRoot: f.storeRoot }).profile,
		"local",
	);
});
test("P5a acquisition guard detects network and native dispatch without executing them", (t) => {
	const guard = acquisitionGuard(t);
	try {
		assert.throws(
			() => http.request("https://invalid.example"),
			/forbidden acquisition/,
		);
		assert.throws(
			() => childProcess.spawn("never-executed"),
			/forbidden acquisition/,
		);
		assert.throws(
			() => globalThis.fetch("https://invalid.example"),
			/forbidden acquisition/,
		);
		assert.deepEqual(guard.calls, ["request", "spawn", "fetch"]);
	} finally {
		guard.close();
	}
});
test("P5a source permission control rejects outside approved boundary", (t) => {
	const f = fixture(t);
	const pkg = f.packages[0],
		source = path.join(f.root, pkg.directory);
	assert.equal(
		readPackage({ root: source, approvedRoot: f.root }).sha256,
		pkg.sha256,
	);
	const before = fingerprint(f.owned);
	assert.throws(
		() =>
			readPackage({
				root: source,
				approvedRoot: path.join(f.root, ".agent-profiles"),
			}),
		/outside approved root/,
	);
	assert.deepEqual(fingerprint(f.owned), before);
});
test("P5a independent fixture identities survive relocation to another owned root", (t) => {
	const a = fixture(t),
		b = fixture(t);
	assert.notEqual(a.root, b.root);
	assert.notEqual(a.storeRoot, b.storeRoot);
	assert.equal(configDigest(a.config), configDigest(b.config));
	assert.deepEqual(
		a.packages.map((p) => [p.name, p.version, p.sha256, p.files]),
		b.packages.map((p) => [p.name, p.version, p.sha256, p.files]),
	);
	assert.equal(json(golden(a)), json(golden(b)));
});
test("P5a source permission control rejects native hard-linked package member", (t) => {
	const f = fixture(t),
		pkg = f.packages[0];
	const source = path.join(f.root, pkg.directory);
	try {
		fs.linkSync(
			path.join(source, "assets/data.bin"),
			path.join(source, "linked.bin"),
		);
	} catch (error) {
		if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
		t.skip(
			`native hard link unavailable: ${error.code}; qualification unverified`,
		);
		return;
	}
	const before = fingerprint(f.owned);
	assert.throws(
		() => readPackage({ root: source, approvedRoot: f.root }),
		/hard.?link|nlink/i,
	);
	assert.deepEqual(fingerprint(f.owned), before);
});
test("P5a source permission control rejects native directory junction", (t) => {
	const f = fixture(t),
		pkg = f.packages[0],
		link = path.join(f.root, "vendor/link");
	try {
		fs.symlinkSync(
			path.join(f.root, pkg.directory),
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
		t.skip(
			`native directory link unavailable: ${error.code}; qualification unverified`,
		);
		return;
	}
	const before = fingerprint(f.owned);
	assert.throws(
		() => readPackage({ root: link, approvedRoot: f.root }),
		/link|junction/i,
	);
	assert.deepEqual(fingerprint(f.owned), before);
});
test("P5a installDependencies public seam exists", () => {
	assert.equal(
		typeof installDependencies,
		"function",
		"missing accepted src/package-lock.js installDependencies API",
	);
});

installTest(
	"creation writes complete deterministic canonical lock bytes",
	async (t) => {
		const f = fixture(t),
			project = fingerprint(f.root, [lockPath]);
		await invoke(f, { sources: [...f.sources].reverse() });
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(golden(f))),
		);
		assert.deepEqual(fingerprint(f.root, [lockPath]), project);
		verifyStore(f);
		await invoke(f, { sources: f.sources });
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(golden(f))),
		);
	},
);
installTest(
	"verified cache creation records provided provenance",
	async (t) => {
		const f = fixture(t, { cached: true }),
			project = fingerprint(f.root, [lockPath]);
		fs.rmSync(path.join(f.root, "vendor"), { recursive: true });
		const afterSourceRemoval = fingerprint(f.root, [lockPath]);
		assert.notDeepEqual(afterSourceRemoval, project);
		await invoke(f);
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(golden(f, "provided"))),
		);
		assert.deepEqual(fingerprint(f.root, [lockPath]), afterSourceRemoval);
		verifyStore(f);
	},
);
installTest(
	"external explicitly supplied directories record provided without absolute paths",
	async (t) => {
		const f = fixture(t);
		const external = path.join(f.owned, "external");
		fs.renameSync(path.join(f.root, "vendor"), external);
		const sources = f.sources.map((s) => ({
			...s,
			directory: path.join(external, path.basename(s.directory)),
		}));
		await invoke(f, { sources });
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(golden(f, "provided"))),
		);
		verifyStore(f);
	},
);
for (const type of ["provided", "local-directory", "git"])
	installTest(`verified reuse preserves ${type} provenance`, async (t) => {
		const f = fixture(t, { cached: true }),
			lock = golden(f);
		if (type === "git")
			for (const pkg of lock.packages)
				pkg.source = {
					type,
					repository: "https://invalid.example/fixture.git",
					commit: "a".repeat(40),
					subdirectory: "packages/fixture",
				};
		else if (type === "provided")
			for (const pkg of lock.packages) pkg.source = { type };
		saveLock(f, lock);
		const before = fingerprint(f.owned);
		await invoke(f);
		assert.deepEqual(fingerprint(f.owned), before);
	});

for (const frozen of [false, true])
	for (const offline of [false, true])
		installTest(
			`exact bytes install frozen=${frozen} offline=${offline}`,
			async (t) => {
				const f = fixture(t);
				if (frozen) saveLock(f);
				const before = fingerprint(f.root, [lockPath]),
					lock = frozen && fs.readFileSync(path.join(f.root, lockPath));
				await invoke(f, { frozen, offline, sources: f.sources });
				if (frozen)
					assert.deepEqual(fs.readFileSync(path.join(f.root, lockPath)), lock);
				else
					assert.deepEqual(
						fs.readFileSync(path.join(f.root, lockPath)),
						Buffer.from(json(golden(f))),
					);
				assert.deepEqual(fingerprint(f.root, [lockPath]), before);
				verifyStore(f);
			},
		);
installTest(
	"frozen verified-cache success preserves every project and store byte",
	async (t) => {
		const f = fixture(t, { cached: true });
		saveLock(f);
		const before = fingerprint(f.owned);
		await invoke(f, { frozen: true, offline: true });
		assert.deepEqual(fingerprint(f.owned), before);
		verifyStore(f);
	},
);
for (const supplied of [false, true])
	installTest(
		`fresh-root offline reproduction uses ${supplied ? "explicit sources" : "portable lock locators"}`,
		async (t) => {
			const original = fixture(t),
				fresh = fixture(t);
			saveLock(original);
			fs.copyFileSync(
				path.join(original.root, lockPath),
				path.join(fresh.root, lockPath),
			);
			const before = fingerprint(fresh.root),
				old = fingerprint(original.owned);
			await invoke(fresh, {
				frozen: true,
				offline: true,
				sources: supplied ? fresh.sources : [],
			});
			assert.deepEqual(fingerprint(fresh.root), before);
			assert.deepEqual(fingerprint(original.owned), old);
			verifyStore(fresh);
			assert.deepEqual(
				fs.readFileSync(path.join(fresh.root, lockPath)),
				Buffer.from(json(golden(original))),
			);
		},
	);

const schemaChanges = [
	[
		"lock version",
		(l) => {
			l.lockVersion = 3;
		},
		/lockVersion|lock.version|unsupported.*lock/i,
	],
	[
		"configuration version",
		(l) => {
			l.configurationVersion = 1;
		},
		/configurationVersion|configuration.version/i,
	],
	[
		"resolver contract",
		(l) => {
			l.resolverContract = "agent-profiles/resolver/v3";
		},
		/resolverContract|resolver.contract/i,
	],
	[
		"unknown top-level key",
		(l) => {
			l.timestamp = 0;
		},
		/timestamp|unknown/i,
	],
	[
		"unknown pin key",
		(l) => {
			l.pins[0].extra = true;
		},
		/extra|unknown/i,
	],
	[
		"unknown package key",
		(l) => {
			l.packages[0].extra = true;
		},
		/extra|unknown/i,
	],
	[
		"unknown source key",
		(l) => {
			l.packages[0].source.extra = true;
		},
		/extra|unknown/i,
	],
	[
		"pins object",
		(l) => {
			l.pins = {};
		},
		/pins/i,
	],
	[
		"packages object",
		(l) => {
			l.packages = {};
		},
		/packages/i,
	],
	[
		"pin null",
		(l) => {
			l.pins[0] = null;
		},
		/pin/i,
	],
	[
		"package null",
		(l) => {
			l.packages[0] = null;
		},
		/package/i,
	],
	[
		"pin nonstring rule",
		(l) => {
			l.pins[0].rule = false;
		},
		/rule/i,
	],
	[
		"pin invalid binding",
		(l) => {
			l.pins[0].binding = "skills../bad";
		},
		/binding|lock-coverage/i,
	],
	[
		"pin invalid package name",
		(l) => {
			l.pins[0].package = "@INVALID/name";
		},
		/package|name/i,
	],
	[
		"package invalid name",
		(l) => {
			l.packages[0].name = "@INVALID/name";
		},
		/package|name/i,
	],
	[
		"source null",
		(l) => {
			l.packages[0].source = null;
		},
		/source/i,
	],
	[
		"source array",
		(l) => {
			l.packages[0].source = [];
		},
		/source/i,
	],
	[
		"unknown source type",
		(l) => {
			l.packages[0].source = { type: "registry" };
		},
		/source|registry/i,
	],
	[
		"unsorted pins",
		(l) => {
			l.pins.reverse();
		},
		/pin|order|sort/i,
	],
	[
		"unsorted packages",
		(l) => {
			l.packages.reverse();
		},
		/package|order|sort/i,
	],
	[
		"provided extra locator",
		(l) => {
			l.packages[0].source = { type: "provided", locator: "vendor/a" };
		},
		/locator|source|unknown/i,
	],
	[
		"git shortened commit",
		(l) => {
			l.packages[0].source = {
				type: "git",
				repository: "https://invalid.example/p.git",
				commit: "abc123",
				subdirectory: "p",
			};
		},
		/commit/i,
	],
	[
		"git missing repository",
		(l) => {
			l.packages[0].source = {
				type: "git",
				commit: "a".repeat(40),
				subdirectory: "p",
			};
		},
		/repository/i,
	],
	[
		"local source missing locator",
		(l) => {
			l.packages[0].source = { type: "local-directory" };
		},
		/locator/i,
	],
	[
		"local source nonstring locator",
		(l) => {
			l.packages[0].source.locator = 4;
		},
		/locator|path/i,
	],
	[
		"git missing subdirectory",
		(l) => {
			l.packages[0].source = {
				type: "git",
				repository: "https://invalid.example/p.git",
				commit: "a".repeat(40),
			};
		},
		/subdirectory/i,
	],
	[
		"git unsafe subdirectory",
		(l) => {
			l.packages[0].source = {
				type: "git",
				repository: "https://invalid.example/p.git",
				commit: "a".repeat(40),
				subdirectory: "../outside",
			};
		},
		/subdirectory|path|traversal/i,
	],
];
for (const field of [
	"lockVersion",
	"configurationVersion",
	"resolverContract",
	"configSha256",
	"pins",
	"packages",
])
	schemaChanges.push([
		`missing ${field}`,
		(l) => {
			delete l[field];
		},
		new RegExp(field, "i"),
	]);
for (const field of ["binding", "rule", "package", "version", "sha256"])
	schemaChanges.push([
		`missing pin ${field}`,
		(l) => {
			delete l.pins[0][field];
		},
		new RegExp(field, "i"),
	]);
for (const field of ["name", "version", "sha256", "source"])
	schemaChanges.push([
		`missing package ${field}`,
		(l) => {
			delete l.packages[0][field];
		},
		new RegExp(field, "i"),
	]);
for (const field of [
	"lockVersion",
	"configurationVersion",
	"resolverContract",
	"configSha256",
])
	schemaChanges.push([
		`wrong type ${field}`,
		(l) => {
			l[field] = false;
		},
		new RegExp(field, "i"),
	]);
for (const value of ["", "A".repeat(64), "0".repeat(63), "g".repeat(64), 123]) {
	for (const location of ["config", "pin", "package"])
		schemaChanges.push([
			`${location} digest ${JSON.stringify(value)}`,
			(l) => {
				if (location === "config") l.configSha256 = value;
				else l[location === "pin" ? "pins" : "packages"][0].sha256 = value;
			},
			/sha256|digest/i,
		]);
}
for (const version of [
	"^1.0.0",
	"latest",
	"1.0.0-rc.1",
	"1.0.0+build",
	"01.0.0",
	"9007199254740992.0.0",
	1,
	null,
]) {
	for (const location of ["pin", "package"])
		schemaChanges.push([
			`${location} rejects version ${JSON.stringify(version)}`,
			(l) => {
				l[location === "pin" ? "pins" : "packages"][0].version = version;
			},
			/version/i,
		]);
}
for (const [location, key] of [
	["pins", "binding"],
	["pins", "package"],
	["pins", "version"],
	["packages", "name"],
	["packages", "version"],
]) {
	schemaChanges.push([
		`wrong type ${location}.${key}`,
		(l) => {
			l[location][0][key] = false;
		},
		new RegExp(key, "i"),
	]);
}
for (const [name, change, diagnostic] of schemaChanges)
	installTest(`strict lock schema ${name}`, async (t) => {
		const f = fixture(t, { cached: true }),
			lock = golden(f);
		change(lock);
		saveLock(f, lock);
		await refusal(f, { frozen: true, offline: true }, diagnostic, {
			unchangedStore: true,
		});
	});

const rawChanges = [
	[
		"duplicate root key",
		(s) => s.replace('"lockVersion":1', '"lockVersion":1,"lockVersion":1'),
		/duplicate|unique/i,
	],
	[
		"escaped duplicate root key",
		(s) =>
			s.replace('"lockVersion":1', '"lockVersion":1,"lock\\u0056ersion":1'),
		/duplicate|unique/i,
	],
	[
		"duplicate nested key",
		(s) => s.replace('"rule":null', '"rule":null,"rule":null'),
		/duplicate|unique/i,
	],
	[
		"fractional version token",
		(s) => s.replace('"lockVersion":1', '"lockVersion":1.0'),
		/integer|decimal|lockVersion/i,
	],
	[
		"exponent version token",
		(s) => s.replace('"lockVersion":1', '"lockVersion":1e0'),
		/integer|decimal|lockVersion/i,
	],
	[
		"negative zero",
		(s) => s.replace('"lockVersion":1', '"lockVersion":-0'),
		/zero|lockVersion|integer/i,
	],
	["trailing bytes", (s) => `${s}{}`, /JSON|record|trailing|unexpected/i],
	["BOM", (s) => `\ufeff${s}`, /BOM|JSON|record/i],
	["null root", () => "null", /lock|record|mapping|object/i],
	["array root", () => "[]", /lock|record|mapping|object/i],
	[
		"unpaired surrogate",
		(s) =>
			s.replace(
				'"resolverContract":"agent-profiles/resolver/v2"',
				'"resolverContract":"\\ud800"',
			),
		/surrogate|resolverContract/i,
	],
];
for (const [name, change, diagnostic] of rawChanges)
	installTest(`strict lock JSON ${name}`, async (t) => {
		const f = fixture(t, { cached: true });
		write(f.root, lockPath, change(json(golden(f))));
		await refusal(f, { frozen: true }, diagnostic, { unchangedStore: true });
	});
for (const [binding, rule] of declaredPins)
	installTest(`coverage requires pin ${binding} rule=${rule}`, async (t) => {
		const f = fixture(t, { cached: true }),
			lock = golden(f);
		lock.pins = lock.pins.filter(
			(p) => p.binding !== binding || p.rule !== rule,
		);
		saveLock(f, lock);
		await refusal(f, { frozen: true }, /lock-coverage/, {
			unchangedStore: true,
		});
	});
for (const [id, version] of releases)
	installTest(
		`coverage requires package @fixture/${id}@${version}`,
		async (t) => {
			const f = fixture(t, { cached: true }),
				lock = golden(f);
			lock.packages = lock.packages.filter(
				(p) => p.name !== `@fixture/${id}` || p.version !== version,
			);
			saveLock(f, lock);
			await refusal(f, { frozen: true }, /lock-coverage/, {
				unchangedStore: true,
			});
		},
	);
for (const [name, change] of [
	[
		"extra pin",
		(l) => l.pins.push({ ...l.pins[0], binding: "skills.foreign" }),
	],
	["duplicate pin", (l) => l.pins.push(copy(l.pins[0]))],
	[
		"extra package",
		(l) => l.packages.push({ ...l.packages[0], name: "@fixture/foreign" }),
	],
	["duplicate package", (l) => l.packages.push(copy(l.packages[0]))],
	[
		"changed exact pin",
		(l) => {
			l.pins[0].version = "9.0.0";
		},
	],
	[
		"inconsistent pin digest",
		(l) => {
			l.pins[0].sha256 = "0".repeat(64);
		},
	],
	[
		"inconsistent package digest",
		(l) => {
			l.packages[0].sha256 = "0".repeat(64);
		},
	],
])
	installTest(`coverage rejects ${name}`, async (t) => {
		const f = fixture(t, { cached: true }),
			lock = golden(f);
		change(lock);
		saveLock(f, lock);
		await refusal(f, { frozen: true }, /lock-coverage|mismatched-package/, {
			unchangedStore: true,
		});
	});

const drift = [
	["skill order", (c) => c.roles.reviewer.skills.available.reverse()],
	[
		"required skill order",
		(c) => {
			c.roles.reviewer.skills = {
				required: ["optional", "review"],
				available: ["orphan"],
			};
		},
	],
	[
		"routing",
		(c) => {
			c.models["fiction-small"].profile = "beta";
		},
	],
	[
		"selector",
		(c) => {
			c.assignments.small.when.role = "idle";
		},
	],
	[
		"base pin",
		(c) => {
			c.skills.review.version = "2.0.0";
		},
	],
	[
		"override pin",
		(c) => {
			c.assignments.large.versions["skills.review"] = "1.0.0";
		},
	],
	[
		"unused profile pin",
		(c) => {
			c.profiles.unused.version = "2.0.0";
		},
	],
	[
		"role description",
		(c) => {
			c.roles.reviewer.description = "changed";
		},
	],
];
for (const [name, change] of drift)
	installTest(`configuration digest detects ${name}`, async (t) => {
		const f = fixture(t, { cached: true });
		saveLock(f);
		change(f.config);
		write(f.root, configPath, JSON.stringify(f.config));
		assert.notEqual(
			configDigest(f.config),
			golden({ ...f, config: configuration() }).configSha256,
		);
		assert.deepEqual(
			plain(parseYaml(fs.readFileSync(path.join(f.root, configPath), "utf8"))),
			f.config,
		);
		await refusal(f, { frozen: true }, /stale-lock/, { unchangedStore: true });
	});
const invalidConfigurations = [
	[
		"unsupported version",
		(c) => {
			c.version = 3;
		},
		/version/i,
	],
	[
		"unknown field",
		(c) => {
			c.extra = true;
		},
		/extra|unknown/i,
	],
	[
		"unknown assignment selector",
		(c) => {
			c.assignments.large.when.extra = "fiction-large";
		},
		/extra|unknown/i,
	],
	[
		"alias selector",
		(c) => {
			c.assignments.large.when.model = "fiction-alias";
		},
		/assignments.large.when.model/i,
	],
	[
		"undeclared override binding",
		(c) => {
			c.assignments.large.versions = { "skills.foreign": "2.0.0" };
		},
		/assignments.large.versions.skills.foreign/i,
	],
	[
		"local role override",
		(c) => {
			c.assignments.large.versions = { "roles.reviewer": "2.0.0" };
		},
		/assignments.large.versions.roles.reviewer/i,
	],
	[
		"empty override map",
		(c) => {
			c.assignments.large.versions = {};
		},
		/versions|at least one/i,
	],
	[
		"duplicate selectors",
		(c) => {
			c.assignments.duplicate = copy(c.assignments.large);
		},
		/ambiguous.*(duplicate|large)|duplicate.*large/i,
	],
	[
		"range base version",
		(c) => {
			c.skills.review.version = "^1.0.0";
		},
		/version/i,
	],
	[
		"range override version",
		(c) => {
			c.assignments.large.versions["skills.review"] = "^2.0.0";
		},
		/version/i,
	],
];
for (const key of ["profiles", "skills", "assignments"])
	for (const value of [null, [], "invalid"]) {
		invalidConfigurations.push([
			`${key} present ${JSON.stringify(value)}`,
			(c) => {
				c[key] = value;
			},
			new RegExp(`${key}.*mapping`, "i"),
		]);
	}
for (const [name, change, diagnostic] of invalidConfigurations)
	installTest(`invalid configuration refuses ${name}`, async (t) => {
		const f = fixture(t, { cached: true });
		saveLock(f);
		change(f.config);
		write(f.root, configPath, JSON.stringify(f.config));
		await refusal(f, { sources: f.sources }, diagnostic, {
			unchangedStore: true,
		});
	});
installTest(
	"format comments map and assignment key order do not stale config digest",
	async (t) => {
		const f = fixture(t, { cached: true });
		saveLock(f);
		function reverse(value) {
			if (Array.isArray(value)) return value.map(reverse);
			if (!value || typeof value !== "object") return value;
			return Object.fromEntries(
				Object.entries(value)
					.reverse()
					.map(([k, v]) => [k, reverse(v)]),
			);
		}
		write(
			f.root,
			configPath,
			`# formatting only\n${JSON.stringify(reverse(f.config), null, 4)}\n`,
		);
		const before = fingerprint(f.owned);
		await invoke(f, { frozen: true });
		assert.deepEqual(fingerprint(f.owned), before);
	},
);
installTest(
	"instruction byte changes do not stale dependency lock",
	async (t) => {
		const f = fixture(t, { cached: true });
		saveLock(f);
		write(
			f.root,
			".agent-profiles/roles/reviewer.md",
			"\ufeffchanged local bytes\r\n",
		);
		const before = fingerprint(f.owned);
		await invoke(f, { frozen: true });
		assert.deepEqual(fingerprint(f.owned), before);
	},
);

const sourceChanges = [
	["duplicate equal source", (_f, s) => s.push(copy(s[0])), /duplicate/i],
	[
		"foreign identity",
		(_f, s) => s.push({ ...s[0], name: "@fixture/foreign" }),
		/foreign|undeclared|coverage/i,
	],
	[
		"unknown key",
		(_f, s) => {
			s[1].extra = true;
		},
		/extra|unknown/i,
	],
	[
		"missing name",
		(_f, s) => {
			delete s[1].name;
		},
		/name/i,
	],
	[
		"missing version",
		(_f, s) => {
			delete s[1].version;
		},
		/version/i,
	],
	[
		"missing directory",
		(_f, s) => {
			delete s[1].directory;
		},
		/directory/i,
	],
	[
		"blank directory",
		(_f, s) => {
			s[1].directory = " ";
		},
		/directory|local|path/i,
	],
	[
		"nonstring directory",
		(_f, s) => {
			s[1].directory = 42;
		},
		/directory|local|path/i,
	],
	[
		"range version",
		(_f, s) => {
			s[1].version = "^2.0.0";
		},
		/version/i,
	],
	[
		"URL directory",
		(_f, s) => {
			s[1].directory = "https://invalid.example/fixture";
		},
		/remote-acquisition-unsupported|nonlocal|local.*path/i,
	],
	[
		"UNC directory",
		(_f, s) => {
			s[1].directory = "//invalid.example/share/pkg";
		},
		/remote-acquisition-unsupported|nonlocal|local.*path/i,
	],
	[
		"traversal directory",
		(_f, s) => {
			s[1].directory = "../outside";
		},
		/traversal|outside|boundary|unsafe/i,
	],
	[
		"identity mismatch",
		(_f, s) => {
			s[1].directory = s[0].directory;
		},
		/mismatched-package|identity.*mismatch|manifest.*match/i,
	],
	[
		"source store overlap",
		(f, s) => {
			s[1].directory = f.storeRoot;
		},
		/overlap/i,
	],
];
for (const cached of [false, true])
	for (const [name, change, diagnostic] of sourceChanges)
		installTest(
			`whole source batch preflight ${name} cached=${cached}`,
			async (t) => {
				const f = fixture(t, { cached }),
					sources = copy(f.sources);
				saveLock(f);
				change(f, sources);
				await refusal(f, { sources, frozen: true }, diagnostic, {
					unchangedStore: true,
				});
			},
		);
for (const sources of [null, {}, "vendor"])
	installTest(`source map rejects ${JSON.stringify(sources)}`, async (t) => {
		const f = fixture(t);
		saveLock(f);
		await refusal(f, { sources, frozen: true }, /sources|array|list/i, {
			unchangedStore: true,
		});
	});
for (const cached of [false, true])
	installTest(
		`whole batch rejects late changed resource cached=${cached}`,
		async (t) => {
			const f = fixture(t, { cached });
			saveLock(f);
			const last = f.packages.at(-1);
			write(
				f.root,
				`${last.directory}/assets/data.bin`,
				Buffer.from([9, 9, 9]),
			);
			await refusal(
				f,
				{ sources: f.sources, frozen: true },
				/mismatched-package/,
				{ unchangedStore: true },
			);
		},
	);
installTest(
	"nonfrozen batch preflight rejects late identity before first import",
	async (t) => {
		const f = fixture(t),
			sources = copy(f.sources);
		sources.at(-1).directory = sources[0].directory;
		await refusal(
			f,
			{ sources },
			/mismatched-package|identity.*mismatch|manifest.*match/i,
			{ unchangedStore: true },
		);
	},
);
installTest(
	"source relative directory resolves against project not cwd",
	async (t) => {
		const f = fixture(t),
			cwd = process.cwd();
		assert.notEqual(path.resolve(cwd), f.root);
		await invoke(f, { sources: f.sources });
		assert.equal(process.cwd(), cwd);
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(golden(f))),
		);
		verifyStore(f);
	},
);
for (const locator of [
	"../outside",
	"/outside/pkg",
	"C:/outside/pkg",
	"//invalid.example/share/pkg",
	"https://invalid.example/pkg",
	".",
	"vendor/../review",
	"vendor\\review",
])
	installTest(`lock locator refuses ${JSON.stringify(locator)}`, async (t) => {
		const f = fixture(t, { cached: true }),
			lock = golden(f);
		lock.packages[0].source.locator = locator;
		saveLock(f, lock);
		await refusal(
			f,
			{ frozen: true },
			/locator|path|boundary|outside|traversal|remote|root/i,
			{ unchangedStore: true },
		);
	});
for (const cached of [false, true])
	installTest(
		`lock local locator revalidates junction cached=${cached}`,
		async (t) => {
			const f = fixture(t, { cached }),
				lock = golden(f),
				pkg = lock.packages[0];
			const real = path.join(f.root, pkg.source.locator),
				moved = path.join(f.owned, "outside");
			fs.renameSync(real, moved);
			try {
				fs.symlinkSync(
					moved,
					real,
					process.platform === "win32" ? "junction" : "dir",
				);
			} catch (error) {
				if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
				t.skip(
					`native directory link unavailable: ${error.code}; locator qualification unverified`,
				);
				return;
			}
			saveLock(f, lock);
			await refusal(f, { frozen: true }, /link|junction|escape|boundary/i, {
				unchangedStore: true,
			});
		},
	);
installTest(
	"supplied source junction is refused before earlier batch imports",
	async (t) => {
		const f = fixture(t),
			pkg = f.packages.at(-1),
			real = path.join(f.root, pkg.directory),
			moved = path.join(f.owned, "outside");
		fs.renameSync(real, moved);
		try {
			fs.symlinkSync(
				moved,
				real,
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
			t.skip(
				`native directory link unavailable: ${error.code}; supplied-source qualification unverified`,
			);
			return;
		}
		await refusal(f, { sources: f.sources }, /link|junction|boundary/i, {
			unchangedStore: true,
		});
	},
);
installTest(
	"supplied hard-linked resource is refused before earlier batch imports",
	async (t) => {
		const f = fixture(t),
			pkg = f.packages.at(-1),
			dir = path.join(f.root, pkg.directory);
		try {
			fs.linkSync(
				path.join(dir, "assets/data.bin"),
				path.join(dir, "linked.bin"),
			);
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
			t.skip(
				`native hard link unavailable: ${error.code}; source qualification unverified`,
			);
			return;
		}
		await refusal(f, { sources: f.sources }, /hard.?link|nlink/i, {
			unchangedStore: true,
		});
	},
);

for (const offline of [false, true])
	for (const provenance of ["provided", "git"])
		installTest(
			`unavailable ${provenance} has no implicit acquisition offline=${offline}`,
			async (t) => {
				const f = fixture(t),
					lock = golden(f, "provided");
				if (provenance === "git")
					for (const p of lock.packages)
						p.source = {
							type: "git",
							repository: "https://invalid.example/p.git",
							commit: "b".repeat(64),
							subdirectory: "packages/review",
						};
				saveLock(f, lock);
				fs.rmSync(path.join(f.root, "vendor"), { recursive: true });
				await refusal(f, { frozen: true, offline }, /missing-package/, {
					unchangedStore: true,
				});
			},
		);
for (const [id, version] of releases)
	installTest(
		`offline missing exact unselected-or-selected @fixture/${id}@${version}`,
		async (t) => {
			const f = fixture(t);
			saveLock(f, golden(f, "provided"));
			const omitted = f.packages.find(
				(p) => p.name === `@fixture/${id}` && p.version === version,
			);
			for (const pkg of f.packages.filter((p) => p !== omitted))
				importPackage({
					storeRoot: f.storeRoot,
					sourceDirectory: path.join(f.root, pkg.directory),
				});
			fs.rmSync(path.join(f.root, "vendor"), { recursive: true });
			await refusal(
				f,
				{ frozen: true, offline: true },
				new RegExp(
					`missing-package.*@fixture/${id}.*${version.replaceAll(".", "\\.")}`,
				),
				{ unchangedStore: true },
			);
		},
	);
installTest(
	"nonfrozen missing artifacts never search implicit local or registry sources",
	async (t) => {
		const f = fixture(t);
		await refusal(f, {}, /missing-package/, { unchangedStore: true });
	},
);
installTest(
	"frozen requires a lock even with all exact objects cached",
	async (t) => {
		const f = fixture(t, { cached: true });
		await refusal(f, { frozen: true }, /missing.*lock|lock.*missing/i, {
			unchangedStore: true,
		});
	},
);
for (const frozen of [false, true])
	installTest(
		`corrupt immutable object is not repaired frozen=${frozen}`,
		async (t) => {
			const f = fixture(t, { cached: true });
			saveLock(f);
			const pkg = f.packages[0];
			write(
				f.storeRoot,
				`objects/sha256/${pkg.sha256}/tree/assets/data.bin`,
				Buffer.from([99]),
			);
			await refusal(
				f,
				{ frozen, sources: f.sources },
				frozen
					? /mismatched-package/
					: /mismatched-package|corrupt|digest mismatch/i,
				{ unchangedStore: true },
			);
		},
	);
installTest(
	"existing immutable identity cannot be replaced with changed same-version bytes",
	async (t) => {
		const f = fixture(t, { cached: true });
		write(
			f.root,
			`${f.packages[0].directory}/assets/data.bin`,
			Buffer.from([88]),
		);
		await refusal(
			f,
			{ sources: f.sources },
			/identity-conflict|mismatched-package/,
			{ unchangedStore: true },
		);
	},
);
installTest(
	"offered newer revision cannot replace missing exact locked revision",
	async (t) => {
		const f = fixture(t),
			newer = makePackage(f.root, "review", "4.0.0", "skill");
		saveLock(f, golden(f, "provided"));
		await refusal(
			f,
			{
				frozen: true,
				offline: true,
				sources: [
					{
						name: newer.name,
						version: newer.version,
						directory: newer.directory,
					},
				],
			},
			/foreign|undeclared|coverage/i,
			{ unchangedStore: true },
		);
	},
);
installTest(
	"wrong package type for unselected binding prevents lock publication",
	async (t) => {
		const f = fixture(t),
			pkg = f.packages.find((p) => p.name === "@fixture/orphan");
		const manifest = pkg.files
			.find((p) => p.path === "package.yaml")
			.bytes.toString()
			.replace("type: skill", "type: instruction");
		write(f.root, `${pkg.directory}/package.yaml`, manifest);
		assert.equal(
			readPackage({ root: path.join(f.root, pkg.directory) }).manifest.package
				.type,
			"instruction",
		);
		await refusal(
			f,
			{ sources: f.sources },
			/skills.orphan.*(type|skill)|expected.*skill/i,
		);
	},
);

function zeroPins(f) {
	f.config = {
		version: 2,
		default_profile: "local",
		default_role: "reviewer",
		models: {},
		families: {},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: [], available: [] },
			},
		},
	};
	write(f.root, configPath, JSON.stringify(f.config));
	write(f.root, ".agent-profiles/profiles/local.md", "local profile\n");
	return {
		lockVersion: 1,
		configurationVersion: 2,
		resolverContract: "agent-profiles/resolver/v2",
		configSha256: configDigest(f.config),
		pins: [],
		packages: [],
	};
}
installTest(
	"zero-pin explicit install writes canonical empty coverage lock",
	async (t) => {
		const f = fixture(t),
			lock = zeroPins(f),
			before = fingerprint(f.root, [lockPath]);
		await invoke(f);
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, lockPath)),
			Buffer.from(json(lock)),
		);
		assert.deepEqual(fingerprint(f.root, [lockPath]), before);
		assert.deepEqual(fingerprint(f.storeRoot), []);
	},
);
installTest("zero-pin frozen install still refuses missing lock", async (t) => {
	const f = fixture(t);
	zeroPins(f);
	await refusal(f, { frozen: true }, /missing.*lock|lock.*missing/i, {
		unchangedStore: true,
	});
});
installTest(
	"zero-pin empty lock accepts omitted optional maps and explicit empty maps equivalently",
	async (t) => {
		const f = fixture(t),
			lock = zeroPins(f);
		saveLock(f, lock);
		for (const key of ["profiles", "skills", "assignments"]) f.config[key] = {};
		write(f.root, configPath, JSON.stringify(f.config));
		assert.equal(configDigest(f.config), lock.configSha256);
		const before = fingerprint(f.owned);
		await invoke(f, { frozen: true, offline: true });
		assert.deepEqual(fingerprint(f.owned), before);
	},
);

// Observe owned output operations without selecting an installer API style or private filename.
function finalizationIO(t, f, observe) {
	const mocks = [],
		failures = [];
	let observing = false;
	const directory = path.dirname(path.join(f.root, lockPath));
	const label = (value) => {
		if (value instanceof URL) value = fileURLToPath(value);
		if (Buffer.isBuffer(value)) value = value.toString();
		return typeof value === "string" ? path.resolve(value) : null;
	};
	function event(operation, args, phase) {
		if (observing) return;
		const first = label(args[0]),
			second = label(args[1]);
		const target = ["rename", "copyFile", "cp", "link"].includes(operation)
			? second
			: first;
		const output = [first, target].some(
			(p) => p && (p === directory || p.startsWith(directory + path.sep)),
		);
		const publication =
			operation === "rename" &&
			target &&
			/^objects\/sha256\/[a-f0-9]{64}$/.test(
				path.relative(f.storeRoot, target).split(path.sep).join("/"),
			);
		if (!output && !publication) return;
		observing = true;
		try {
			observe({ operation, args, first, target, output, publication, phase });
		} catch (error) {
			failures.push(error);
			throw error;
		} finally {
			observing = false;
		}
	}
	for (const operation of [
		"open",
		"writeFile",
		"appendFile",
		"truncate",
		"unlink",
		"rm",
		"rmdir",
		"rename",
		"copyFile",
		"cp",
		"link",
	]) {
		for (const style of ["sync", "callback", "promise"]) {
			const owner = style === "promise" ? fs.promises : fs;
			const name = operation + (style === "sync" ? "Sync" : "");
			if (typeof owner[name] !== "function") continue;
			const original = owner[name];
			mocks.push(
				t.mock.method(owner, name, function (...args) {
					if (style === "promise")
						return (async () => {
							event(operation, args, "before");
							const result = await original.apply(this, args);
							event(operation, args, "after");
							return result;
						})();
					if (style === "callback") {
						const callback = args.at(-1);
						try {
							event(operation, args, "before");
						} catch (error) {
							queueMicrotask(() => callback(error));
							return;
						}
						return original.call(
							this,
							...args.slice(0, -1),
							(error, ...result) => {
								if (!error)
									try {
										event(operation, args, "after");
									} catch (caught) {
										error = caught;
									}
								callback(error, ...result);
							},
						);
					}
					event(operation, args, "before");
					const result = original.apply(this, args);
					event(operation, args, "after");
					return result;
				}),
			);
		}
	}
	const stream = fs.createWriteStream;
	mocks.push(
		t.mock.method(fs, "createWriteStream", function (...args) {
			event("open", [args[0], args[1]?.flags ?? "w"], "before");
			return stream.apply(this, args);
		}),
	);
	syncBuiltinESMExports();
	return {
		failures,
		close() {
			for (const mock of mocks) mock.mock.restore();
			syncBuiltinESMExports();
		},
	};
}

function readingOpen(e) {
	return (
		e.operation === "open" &&
		(typeof e.args[1] === "number"
			? (e.args[1] &
					(fs.constants.O_WRONLY |
						fs.constants.O_RDWR |
						fs.constants.O_CREAT |
						fs.constants.O_TRUNC |
						fs.constants.O_APPEND)) ===
				0
			: ["r", "rs", "sr"].includes(e.args[1] ?? "r"))
	);
}
function atomicLockObserver(f, old, expected) {
	const target = path.join(f.root, lockPath);
	const state = { creations: 0, publications: 0 };
	function unchanged() {
		if (old === null)
			assert.equal(
				fs.existsSync(target),
				false,
				"lock visible before publication",
			);
		else
			assert.deepEqual(
				fs.readFileSync(target),
				old,
				"old lock changed while replacement was created",
			);
	}
	return {
		state,
		observe(e) {
			if (!e.output) return;
			if (e.phase === "before") {
				if (
					!readingOpen(e) &&
					!(e.operation === "rename" && e.target === target)
				) {
					assert.notEqual(
						e.target,
						target,
						"direct lock write/truncate/unlink is not atomic publication",
					);
					if (e.operation === "rename")
						assert.notEqual(e.first, target, "old lock must not be moved");
					assert.notEqual(
						e.target,
						path.dirname(target),
						"lock directory must not be removed",
					);
					if (
						["open", "writeFile", "appendFile", "copyFile"].includes(
							e.operation,
						)
					)
						state.creations++;
				}
			}
			if (
				e.phase === "after" &&
				e.operation === "rename" &&
				e.target === target
			) {
				state.publications++;
				assert.deepEqual(fs.readFileSync(target), expected);
				return;
			}
			if (state.publications) {
				assert.deepEqual(fs.readFileSync(target), expected);
				return;
			}
			unchanged();
			if (e.phase !== "before") return;
			if (e.operation === "rename" && e.target === target) {
				assert.notEqual(e.first, target);
				assert.deepEqual(
					fs.readFileSync(e.first),
					expected,
					"publication source must already contain complete golden bytes",
				);
			}
		},
	};
}

for (const style of ["sync", "callback", "promise"])
	test(`P5a finalization interception real filesystem control ${style}`, async (t) => {
		const f = fixture(t),
			target = path.join(f.root, lockPath),
			staged = path.join(f.root, ".agent-profiles/control-output");
		const before = [fs.renameSync, fs.rename, fs.promises.rename],
			sentinel = new Error("P5a owned publication sentinel");
		write(f.root, lockPath, "old");
		fs.writeFileSync(staged, "complete");
		let fired = 0;
		const watch = finalizationIO(t, f, (e) => {
			if (
				e.operation === "rename" &&
				e.target === target &&
				e.phase === "before" &&
				!fired
			) {
				assert.equal(fs.readFileSync(target, "utf8"), "old");
				assert.equal(fs.readFileSync(e.first, "utf8"), "complete");
				fired++;
				fs.writeFileSync(path.join(f.root, configPath), "user edit");
				throw sentinel;
			}
		});
		const rename = () =>
			style === "sync"
				? fs.renameSync(staged, target)
				: style === "promise"
					? fs.promises.rename(staged, target)
					: new Promise((resolve, reject) =>
							fs.rename(staged, target, (error) =>
								error ? reject(error) : resolve(),
							),
						);
		try {
			await assert.rejects(
				async () => rename(),
				(error) => error === sentinel,
			);
			assert.equal(fired, 1);
			assert.equal(
				fs.readFileSync(path.join(f.root, configPath), "utf8"),
				"user edit",
			);
			assert.equal(fs.readFileSync(target, "utf8"), "old");
			await rename();
			assert.equal(fired, 1, "injection must be one-shot");
			assert.equal(fs.readFileSync(target, "utf8"), "complete");
		} finally {
			watch.close();
		}
		assert.deepEqual([fs.renameSync, fs.rename, fs.promises.rename], before);
		fs.writeFileSync(staged, "restored");
		await rename();
		assert.equal(fs.readFileSync(target, "utf8"), "restored");
	});

test("P5a atomic observer rejects direct target mutation with real files", (t) => {
	const f = fixture(t),
		target = path.join(f.root, lockPath),
		old = Buffer.from("old"),
		expected = Buffer.from(json(golden(f)));
	write(f.root, lockPath, old);
	const oracle = atomicLockObserver(f, old, expected),
		watch = finalizationIO(t, f, oracle.observe);
	try {
		for (const action of [
			() => fs.writeFileSync(target, "partial"),
			() => fs.truncateSync(target),
			() => fs.unlinkSync(target),
			() => fs.openSync(target, "w"),
		]) {
			assert.throws(action, /direct lock/);
			assert.deepEqual(fs.readFileSync(target), old);
		}
		const staged = path.join(f.root, ".agent-profiles/control-output");
		fs.writeFileSync(staged, expected);
		fs.renameSync(staged, target);
		assert.ok(oracle.state.creations > 0);
		assert.equal(oracle.state.publications, 1);
	} finally {
		watch.close();
	}
});

test("P5a absent-lock observer rejects partial publication through promises", async (t) => {
	const f = fixture(t),
		target = path.join(f.root, lockPath),
		staged = path.join(f.root, ".agent-profiles/control-output");
	const expected = Buffer.from(json(golden(f))),
		oracle = atomicLockObserver(f, null, expected);
	const watch = finalizationIO(t, f, oracle.observe);
	try {
		await fs.promises.writeFile(staged, "partial");
		await assert.rejects(
			() => fs.promises.rename(staged, target),
			/complete golden bytes/,
		);
		assert.equal(fs.existsSync(target), false);
		await fs.promises.writeFile(staged, expected);
		await fs.promises.rename(staged, target);
		assert.ok(oracle.state.creations > 0);
		assert.equal(oracle.state.publications, 1);
		await assert.rejects(
			() => fs.promises.writeFile(target, "partial"),
			/direct lock/,
		);
		assert.deepEqual(fs.readFileSync(target), expected);
	} finally {
		watch.close();
	}
});

for (const mutate of [false, true])
	test(`P5a real store publication mutation control mutate=${mutate}`, (t) => {
		const f = fixture(t),
			before = fingerprint(f.root, [configPath]);
		const original = fs.renameSync,
			edited = Buffer.from(`# user comment\n${JSON.stringify(f.config)}`);
		let fired = 0;
		const watch = finalizationIO(t, f, (e) => {
			if (e.publication && e.phase === "after" && !fired) {
				assert.equal(fs.statSync(e.target).isDirectory(), true);
				fired++;
				if (mutate) write(f.root, configPath, edited);
			}
		});
		try {
			for (const pkg of f.packages.slice(0, 2))
				importPackage({
					storeRoot: f.storeRoot,
					sourceDirectory: path.join(f.root, pkg.directory),
					expectedDigest: pkg.sha256,
				});
		} finally {
			watch.close();
		}
		assert.equal(fs.renameSync, original);
		assert.deepEqual(watch.failures, []);
		assert.equal(fired, 1);
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, configPath)),
			mutate ? edited : Buffer.from(JSON.stringify(f.config, null, 2)),
		);
		assert.deepEqual(fingerprint(f.root, [configPath]), before);
		for (const pkg of f.packages.slice(0, 2))
			assert.equal(
				lookupPackage({
					storeRoot: f.storeRoot,
					name: pkg.name,
					version: pkg.version,
				}).sha256,
				pkg.sha256,
			);
	});

function legacyFixture(f) {
	zeroPins(f);
	f.config.version = 1;
	write(f.root, configPath, JSON.stringify(f.config));
	// Existing resolver validates the refusal input only; legacy support is separate work.
	assert.equal(
		resolveInstructions({ root: f.root, storeRoot: f.storeRoot }).profile,
		"local",
	);
}
test("P5a legacy refusal fixture is valid through the real resolver", (t) => {
	legacyFixture(fixture(t));
});
for (const frozen of [false, true])
	installTest(
		`v1 install actionably refuses without migration frozen=${frozen}`,
		async (t) => {
			const f = fixture(t, { cached: true });
			legacyFixture(f);
			saveLock(f);
			await refusal(
				f,
				{ frozen, offline: true, sources: f.sources },
				(error) => {
					assert.match(error.message, /version.?1|v1|unsupported.*version/i);
					assert.match(error.message, /migrat|upgrade/i);
					assert.match(error.message, /version.?2|v2/i);
					return true;
				},
				{ unchangedStore: true },
			);
		},
	);

for (const existing of [false, true])
	installTest(
		`atomic lock publication preserves initial state existing=${existing}`,
		async (t) => {
			const f = fixture(t),
				expected = Buffer.from(json(golden(f)));
			if (existing) {
				const stale = golden(f);
				stale.configSha256 = "0".repeat(64);
				saveLock(f, stale);
			}
			const old = existing
				? fs.readFileSync(path.join(f.root, lockPath))
				: null;
			const project = fingerprint(f.root, [lockPath]);
			const oracle = atomicLockObserver(f, old, expected),
				watch = finalizationIO(t, f, oracle.observe);
			try {
				await invoke(f, { sources: f.sources });
			} finally {
				watch.close();
			}
			assert.deepEqual(watch.failures, []);
			assert.ok(
				oracle.state.creations > 0,
				"replacement creation was not observed",
			);
			assert.equal(
				oracle.state.publications,
				1,
				"complete atomic publication was not observed",
			);
			assert.deepEqual(fs.readFileSync(path.join(f.root, lockPath)), expected);
			assert.deepEqual(fingerprint(f.root, [lockPath]), project);
			verifyStore(f);
		},
	);

for (const frozen of [false, true])
	for (const edited of [null, configPath, lockPath])
		installTest(
			`finalization detects owned edit ${edited ?? "no mutation"} frozen=${frozen}`,
			async (t) => {
				const f = fixture(t);
				saveLock(f);
				const project = fingerprint(f.root, edited ? [edited] : []);
				const config = copy(f.config);
				config.models["fiction-small"].profile = "beta";
				const lock = golden(f);
				lock.packages[0].source = { type: "provided" };
				const bytes = Buffer.from(
					edited === configPath
						? `# concurrent user edit\n${JSON.stringify(config, null, 2)}`
						: json(lock),
				);
				let boundary = 0,
					mutations = 0;
				const watch = finalizationIO(t, f, (e) => {
					if (frozen && e.phase === "before" && !readingOpen(e)) {
						const target = path.join(f.root, lockPath);
						assert.notEqual(
							e.target,
							target,
							"frozen install must not rewrite even identical lock bytes",
						);
						if (e.operation === "rename")
							assert.notEqual(
								e.first,
								target,
								"frozen install must not move the lock",
							);
					}
					if (e.publication && e.phase === "after" && !boundary) {
						boundary++;
						if (edited) {
							write(f.root, edited, bytes);
							mutations++;
						}
					}
				});
				try {
					if (edited)
						await assert.rejects(
							() => invoke(f, { frozen, sources: f.sources }),
							/stale|changed|concurrent/i,
						);
					else await invoke(f, { frozen, sources: f.sources });
				} finally {
					watch.close();
				}
				assert.deepEqual(watch.failures, []);
				assert.equal(
					boundary,
					1,
					"real immutable publication boundary was not reached",
				);
				assert.equal(mutations, edited ? 1 : 0);
				if (edited)
					assert.deepEqual(
						fs.readFileSync(path.join(f.root, edited)),
						bytes,
						"user edit overwritten",
					);
				assert.deepEqual(fingerprint(f.root, edited ? [edited] : []), project);
				if (!edited) verifyStore(f);
			},
		);

for (const existing of [false, true])
	installTest(
		`caught late output failure preserves published objects existing=${existing}`,
		async (t) => {
			const f = fixture(t);
			if (existing) {
				const stale = golden(f);
				stale.configSha256 = "0".repeat(64);
				saveLock(f, stale);
			}
			const project = fingerprint(f.root),
				target = path.join(f.root, lockPath);
			const sentinel = "P5a late owned output EIO sentinel";
			let fired = 0,
				published;
			const watch = finalizationIO(t, f, (e) => {
				if (
					e.phase === "before" &&
					e.operation === "rename" &&
					e.target === target &&
					!fired
				) {
					verifyStore(f);
					assert.deepEqual(
						fs.readFileSync(e.first),
						Buffer.from(json(golden(f))),
					);
					published = fingerprint(path.join(f.storeRoot, "objects"));
					assert.ok(published.some(([, type]) => type === "file"));
					fired++;
					throw Object.assign(new Error(sentinel), { code: "EIO" });
				}
			});
			try {
				await assert.rejects(
					() => invoke(f, { sources: f.sources }),
					(error) => error.message.includes(sentinel),
				);
			} finally {
				watch.close();
			}
			assert.equal(fired, 1, "late sentinel injection did not execute");
			assert.equal(watch.failures.length, 1);
			assert.deepEqual(
				fingerprint(f.root),
				project,
				"old lock/config/host/source or private output cleanup changed",
			);
			assert.deepEqual(
				fingerprint(path.join(f.storeRoot, "objects")),
				published,
				"published immutable objects were rolled back",
			);
			verifyStore(f);
		},
	);
