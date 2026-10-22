import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { renameSync as esmRename } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { installDependencies } from "../src/package-lock.js";
import { importPackage, lookupPackage } from "../src/package-store.js";
import { canonicalJSON, hashRecord, readPackage } from "../src/packages.js";
import { resolveInstructions } from "../src/resolve.ts";

// P6a RED: contract sections 2-7, C13-C16 and the profile/role/request corrections.
// Local declared resources, diff, materialization and CLI are separate phases.
const target = new URL("../src/stamps.js", import.meta.url);
let stamps;
try {
	stamps = await import(target.href);
} catch (error) {
	if (
		!(
			error.code === "ERR_MODULE_NOT_FOUND" &&
			error.url === target.href &&
			!fs.existsSync(fileURLToPath(target))
		)
	)
		throw error;
}
const blocked = stamps
	? false
	: "P6a blocked: src/stamps.js is absent; behavior body has not executed";
const stampTest = (name, body) => test(name, { skip: blocked }, body);
const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const DOMAIN = "agent-profiles/stamp/v1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const u64 = (n) => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n));
	return b;
};

// Independent finite fixture oracle, not a second general-purpose record parser.
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
function record(value, domain = DOMAIN) {
	const bytes = Buffer.from(canonical(value));
	return sha(
		Buffer.concat([Buffer.from(`${domain}\0`), u64(bytes.length), bytes]),
	);
}
function treeHash(files) {
	const parts = [
		Buffer.from("agent-profiles/package-tree/v1\0"),
		u64(files.length),
	];
	for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
		const name = Buffer.from(file.path);
		parts.push(
			Buffer.from([0x46]),
			u64(name.length),
			name,
			u64(file.bytes.length),
			file.bytes,
		);
	}
	return sha(Buffer.concat(parts));
}
function fingerprint(root, exclude = []) {
	if (!fs.existsSync(root)) return null;
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.filter((p) => !exclude.includes(p))
		.sort(compare)
		.map((p) => {
			const stat = fs.lstatSync(path.join(root, p));
			return [
				p,
				stat.isSymbolicLink()
					? `link:${fs.readlinkSync(path.join(root, p))}`
					: stat.isDirectory()
						? "directory"
						: sha(fs.readFileSync(path.join(root, p))),
			];
		});
}
function scratch(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p6a-stamps-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function environment(t, values) {
	const old = Object.fromEntries(
		Object.keys(values).map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, values);
	t.after(() => {
		for (const [k, v] of Object.entries(old)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}
const skillBytes = (id, suffix = "") =>
	Buffer.from(
		`\uFEFF---\r\nname: ${id}\r\ndescription: ${id} description\r\n---\r\n${id} raw ${suffix}\r\n\r\n`,
	);
const LOCAL = {
	".agent-profiles/profiles/base.md": Buffer.from(
		"\uFEFF# Local profile\r\n\r\n",
	),
	".agent-profiles/roles/reviewer.md": Buffer.from("# Local role\r\n\r\n"),
	"instructions/local.md": skillBytes("local"),
	"instructions/b.md": skillBytes("b"),
	"instructions/c.md": skillBytes("c"),
	"AGENTS.md": Buffer.from("\uFEFF# Shared\r\n\r\n"),
	"shared/Z.md": Buffer.from("Z\r\n"),
	"shared/a.md": Buffer.from("a\n\n"),
};
function configuration() {
	const lists = () => ({
		required: ["local", "review", "native"],
		available: ["b", "c", "idle"],
	});
	return {
		version: 2,
		default_profile: "base",
		default_role: "reviewer",
		models: {
			small: { profile: "base", aliases: ["small-alias"] },
			large: { profile: "pack", aliases: ["large-alias"] },
		},
		families: {},
		profiles: { pack: { package: "@stamp/instructions", version: "1.0.0" } },
		roles: {
			reviewer: { file: "roles/reviewer.md", skills: lists() },
			packaged: {
				package: "@stamp/instructions",
				version: "1.0.0",
				skills: lists(),
			},
		},
		skills: {
			local: { file: "instructions/local.md" },
			b: { file: "instructions/b.md" },
			c: { file: "instructions/c.md" },
			review: { package: "@stamp/review", version: "1.0.0" },
			native: { package: "@stamp/native", version: "1.0.0" },
			idle: { package: "@stamp/idle", version: "1.0.0" },
		},
		assignments: {
			large: {
				when: { model: "large" },
				versions: {
					"profiles.pack": "2.0.0",
					"roles.packaged": "2.0.0",
					"skills.review": "2.0.0",
					"skills.native": "2.0.0",
				},
			},
		},
	};
}
function packageFixture(leaf, version, label, assetByte = 255) {
	const instruction = leaf === "instructions",
		native = leaf === "native";
	const behavior = {
		delivery: native ? "native" : "instruction",
		hosts: native ? ["claude", "codex"] : [],
		effects: [],
	};
	const entrypoint = instruction ? "ENTRY.md" : "SKILL.md";
	const manifest = {
		schema_version: 1,
		package: {
			name: `@stamp/${leaf}`,
			version,
			type: instruction ? "instruction" : "skill",
		},
		entrypoint,
		behavior,
	};
	const body = instruction
		? Buffer.from(`\uFEFF# Instruction ${version} ${label}\r\n\r\n`)
		: leaf === "native"
			? Buffer.from(
					`---\r\ndescription: native description\r\n---\r\nNative ${version} ${label}\r\n\r\n`,
				)
			: skillBytes(leaf, `${version} ${label}`);
	const files = [
		{ path: "package.yaml", bytes: Buffer.from(stringify(manifest)) },
		{ path: entrypoint, bytes: body },
		{
			path: "assets/Z.bin",
			bytes: Buffer.from([0, assetByte, 13, 10, Number(version[0])]),
		},
		{ path: "assets/a.txt", bytes: Buffer.from(`${label}\r\n\r\n`) },
		{ path: ".hidden", bytes: Buffer.alloc(0) },
		{
			path: "support/run.js",
			bytes: Buffer.from('throw new Error("inert supporting bytes");\r\n'),
		},
	].sort((a, b) => compare(a.path, b.path));
	return { manifest, files, sha256: treeHash(files) };
}
function fixture(
	t,
	{
		localOnly = false,
		ambient = "misleading",
		idleAsset = 255,
		isolateAmbient = true,
	} = {},
) {
	const dir = scratch(t),
		root = path.join(dir, "repo"),
		storeRoot = path.join(dir, "store");
	const empty = path.join(dir, "empty"),
		misleading = path.join(dir, "ambient"),
		home = path.join(dir, "home");
	for (const p of [root, storeRoot, empty, misleading, home]) fs.mkdirSync(p);
	if (isolateAmbient)
		environment(t, {
			HOME: home,
			USERPROFILE: home,
			AGENT_PROFILES_STORE: ambient === "empty" ? empty : misleading,
		});
	for (const [p, bytes] of Object.entries(LOCAL))
		put(path.join(root, p), bytes);
	const config = configuration(),
		packages = new Map();
	if (localOnly) {
		delete config.profiles;
		delete config.assignments;
		delete config.roles.packaged;
		delete config.models.large;
		config.roles.reviewer.skills = {
			required: ["local"],
			available: ["b", "c"],
		};
		for (const id of ["review", "native", "idle"]) delete config.skills[id];
	} else {
		for (const leaf of ["instructions", "review", "native", "idle"]) {
			for (const version of leaf === "idle" ? ["1.0.0"] : ["1.0.0", "2.0.0"]) {
				const p = packageFixture(
					leaf,
					version,
					"explicit",
					leaf === "idle" ? idleAsset : 255,
				);
				packages.set(`${p.manifest.package.name}@${version}`, p);
				for (const [store, label] of [
					[storeRoot, "explicit"],
					[misleading, "ambient"],
				]) {
					const input = packageFixture(
							leaf,
							version,
							label,
							leaf === "idle" && label === "explicit" ? idleAsset : 255,
						),
						source = path.join(dir, `${label}-sources`, leaf, version);
					for (const member of input.files)
						put(path.join(source, member.path), member.bytes);
					const imported = importPackage({
						sourceDirectory: source,
						storeRoot: store,
						expectedDigest: input.sha256,
					});
					assert.equal(imported.sha256, input.sha256);
				}
			}
		}
	}
	const save = () => put(path.join(root, CONFIG), stringify(config));
	save();
	if (!localOnly) installDependencies({ root, storeRoot });
	const options = {
		root,
		storeRoot,
		model: "small",
		host: "codex",
		identitySource: "user",
		skills: ["local", "c", "b", "c"],
	};
	const f = {
		dir,
		root,
		storeRoot,
		empty,
		misleading,
		home,
		config,
		packages,
		options,
		save,
		resolve: (extra = {}) => resolveInstructions({ ...options, ...extra }),
		state: () => [
			fingerprint(root),
			fingerprint(storeRoot),
			fingerprint(empty),
			fingerprint(misleading),
			fingerprint(home),
		],
	};
	return f;
}
function nativeFixture(t, requirement) {
	const f = fixture(t, { localOnly: true });
	const nativeBytes = Buffer.from(
		"---\nname: project\ndescription: project native\n---\nObserved only.\r\n",
	);
	put(path.join(f.root, ".claude/skills/project/SKILL.md"), nativeBytes);
	for (const [id, scope] of [
		["project", "project"],
		["personal", "user"],
		["plugin", "plugin"],
	]) {
		f.config.skills[id] = {
			host: "claude",
			scope,
			...(scope === "plugin" ? { id: "kit:plugin" } : {}),
		};
		f.config.roles.reviewer.skills[requirement].push(id);
	}
	f.save();
	return { ...f, nativeBytes };
}
function damageLock(f, mode) {
	if (mode === "missing") fs.unlinkSync(path.join(f.root, LOCK));
	if (mode === "stale") {
		f.config.roles.reviewer.description = "changed";
		f.save();
	}
	if (mode === "incomplete") {
		const lock = JSON.parse(fs.readFileSync(path.join(f.root, LOCK)));
		lock.pins.pop();
		put(path.join(f.root, LOCK), canonical(lock));
	}
	return mode === "missing"
		? /agent-profiles\.lock: missing/
		: mode === "stale"
			? /stale-lock/
			: /lock-coverage/;
}
const blob = (p, bytes) => ({
	type: "blob",
	path: p,
	sha256: sha(bytes),
	bytes: bytes.length,
});
function expected(f, { packaged = false, shared = ["AGENTS.md"] } = {}) {
	const version = packaged ? "2.0.0" : "1.0.0";
	const packageSelection = (leaf, binding) => {
		const v = leaf === "idle" ? "1.0.0" : version,
			p = f.packages.get(`@stamp/${leaf}@${v}`);
		return {
			binding,
			name: `@stamp/${leaf}`,
			version: v,
			sha256: p.sha256,
			selectedBy: packaged && leaf !== "idle" ? "large" : "binding-default",
			selectors: packaged && leaf !== "idle" ? { model: "large" } : {},
		};
	};
	const layer = (kind, id, p, leaf) => {
		const selection = leaf
			? packageSelection(
					leaf,
					`${kind === "profile" ? "profiles" : kind === "role" ? "roles" : "skills"}.${id}`,
				)
			: null;
		return {
			kind,
			id,
			backing: selection
				? {
						type: "package",
						sha256: selection.sha256,
						path: leaf === "instructions" ? "ENTRY.md" : "SKILL.md",
					}
				: blob(p, LOCAL[p]),
			package: selection,
			resources: [],
		};
	};
	const skill = (id, leaf) => {
		const e = layer(
			"required-skill",
			id,
			`instructions/${id === "local" ? "local" : id}.md`,
			leaf,
		);
		return {
			id,
			type: id === "native" ? "host" : "instruction",
			delivery: id === "native" ? "invoke" : "inject",
			name: id,
			nameSource: id === "native" ? "directory" : "frontmatter",
			description: `${id} description`,
			backing: e.backing,
			package: e.package,
			resources: [],
			hostReference: id === "native" ? "skills.native" : null,
		};
	};
	const localOnly = !f.packages.size;
	const required = localOnly
		? [skill("local")]
		: [skill("local"), skill("review", "review"), skill("native", "native")];
	const available = [
		skill("b"),
		skill("c"),
		...(localOnly ? [] : [skill("idle", "idle")]),
	];
	const inject = (s, kind) => ({
		kind,
		id: s.id,
		backing: s.backing,
		package: s.package,
		resources: s.resources,
	});
	const profile = packaged ? "pack" : "base",
		role = packaged ? "packaged" : "reviewer";
	const composition = [
		layer(
			"profile",
			profile,
			".agent-profiles/profiles/base.md",
			packaged ? "instructions" : null,
		),
		layer(
			"role",
			role,
			".agent-profiles/roles/reviewer.md",
			packaged ? "instructions" : null,
		),
		...required
			.filter((s) => s.type === "instruction")
			.map((s) => inject(s, "required-skill")),
		...["c", "b"].map((id) =>
			inject(
				available.find((s) => s.id === id),
				"requested-skill",
			),
		),
	];
	const selections = [...composition, ...required, ...available]
		.filter((e) => e.package)
		.map((e) => e.package);
	const keys = [
		...new Set(selections.map((p) => `${p.name}@${p.version}`)),
	].sort(compare);
	const native = required.find((s) => s.id === "native");
	return {
		stampVersion: 1,
		configurationVersion: 2,
		resolverContract: "agent-profiles/resolver/v2",
		selection: {
			host: "codex",
			identity: {
				raw: packaged ? "large" : "small",
				canonical: packaged ? "large" : "small",
				source: "user",
				matchedBy: "model",
			},
			family: null,
			familySource: null,
			profile,
			role,
			roleSource: packaged ? "assigned" : "default",
		},
		requested: ["local", "c", "b"],
		composition,
		required,
		available,
		packages: keys.map((key) => {
			const p = f.packages.get(key);
			return {
				name: p.manifest.package.name,
				version: p.manifest.package.version,
				sha256: p.sha256,
				behavior: p.manifest.behavior,
			};
		}),
		shared: shared.map((p) => ({
			path: p,
			status: "captured",
			backing: blob(p, LOCAL[p]),
			delivery: "host-controlled",
		})),
		hostReferences: native
			? [
					{
						key: "skills.native",
						id: "native",
						host: "codex",
						scope: "package",
						hostId: null,
						requirement: "required",
						compatibility: true,
						observation: "captured-file",
						backing: native.backing,
						invocation: "unverified",
						rendered: "unverified",
						supportedHosts: ["claude", "codex"],
					},
				]
			: [],
		inventory: {
			managed: "selected-required-and-available",
			host: "unobserved",
			exclusiveVisibility: "unverified",
		},
		coverage: {
			localResources: "declared-only",
			hostContext: "unobserved",
			runtimeModel: "unverified",
			renderedPrompt: "unverified",
		},
	};
}
const snapshotPath = (f, digest) =>
	path.join(f.storeRoot, "stamps/sha256", digest, "snapshot.json");
const blobPath = (f, backing) =>
	path.join(f.storeRoot, "blobs/sha256", backing.sha256);
const treePath = (f, digest) =>
	path.join(f.storeRoot, "objects/sha256", digest, "tree");
function raw(f, backing) {
	return fs.readFileSync(
		backing.type === "blob"
			? blobPath(f, backing)
			: path.join(treePath(f, backing.sha256), backing.path),
	);
}
async function capture(f, extra = {}) {
	const result = await stamps.createStamp({ ...f.options, ...extra });
	assert.match(result.digest, /^[0-9a-f]{64}$/);
	const bytes = fs.readFileSync(snapshotPath(f, result.digest));
	assert.deepEqual(
		bytes,
		Buffer.from(canonical(result.snapshot)),
		"published exact canonical snapshot, no newline/BOM",
	);
	assert.equal(
		result.digest,
		record(result.snapshot),
		"independently framed stamp RECORD",
	);
	return result;
}
function rewrite(f, snapshot, domain = DOMAIN) {
	const digest = record(snapshot, domain);
	put(snapshotPath(f, digest), Buffer.from(canonical(snapshot)));
	return digest;
}
async function verified(f, digest) {
	const before = f.state(),
		v = await stamps.verifyStamp({ digest, storeRoot: f.storeRoot });
	assert.deepEqual(f.state(), before, "verification is read-only");
	assert.equal(v.snapshotIntegrity, "verified");
	assert.equal(v.managedContent, "verified");
	assert.equal(v.managedReconstruction, "verified");
	assert.equal(v.managedReproducible, true);
	assert.equal(v.completeRuntimeReproducible, false);
	for (const k of ["hostInvocation", "runtimeIdentity", "renderedPrompt"])
		assert.equal(v[k], "unverified");
	assert.ok(Array.isArray(v.findings));
	return v;
}
async function invalid(
	f,
	digest,
	status,
	diagnostic,
	field = "snapshotIntegrity",
) {
	const before = f.state(),
		v = await stamps.verifyStamp({ digest, storeRoot: f.storeRoot });
	assert.equal(v[field], status);
	if (field === "managedContent")
		assert.equal(
			v.snapshotIntegrity,
			"verified",
			"backing damage is distinct from corrupt snapshot identity",
		);
	assert.notEqual(
		v.managedReconstruction,
		"verified",
		"invalid managed content cannot report partial reconstruction success",
	);
	assert.equal(v.managedReproducible, false);
	assert.equal(v.completeRuntimeReproducible, false);
	assert.ok(v.findings.length > 0, "invalid stamp retains findings");
	assert.match(JSON.stringify(v.findings), diagnostic);
	await assert.rejects(
		async () => stamps.reconstructStamp({ digest, storeRoot: f.storeRoot }),
		diagnostic,
	);
	assert.deepEqual(
		f.state(),
		before,
		"verification/reconstruction do not repair backing",
	);
}
function intercept(t, method, callback) {
	const original = fs[method];
	const mock = t.mock.method(fs, method, function (...args) {
		return callback(original.bind(this), ...args);
	});
	syncBuiltinESMExports();
	return () => {
		mock.mock.restore();
		syncBuiltinESMExports();
	};
}
function observeWrites(t) {
	const calls = [],
		close = [];
	for (const method of [
		"writeFileSync",
		"appendFileSync",
		"mkdirSync",
		"mkdtempSync",
		"renameSync",
		"unlinkSync",
		"rmSync",
		"copyFileSync",
		"truncateSync",
		"openSync",
	]) {
		close.push(
			intercept(t, method, (operation, ...args) => {
				const flags = args[1];
				const reading =
					method === "openSync" &&
					(typeof flags === "number"
						? (flags &
								(fs.constants.O_WRONLY |
									fs.constants.O_RDWR |
									fs.constants.O_CREAT |
									fs.constants.O_TRUNC |
									fs.constants.O_APPEND)) ===
							0
						: ["r", "rs", "sr"].includes(flags ?? "r"));
				if (!reading) calls.push(method);
				return operation(...args);
			}),
		);
	}
	return {
		calls,
		close: () => {
			for (const restore of close.reverse()) restore();
		},
	};
}

test("P6a seam exports createStamp, verifyStamp and reconstructStamp", () => {
	assert.ok(
		stamps,
		"P6a missing interface: src/stamps.js must export createStamp, verifyStamp, reconstructStamp",
	);
	for (const name of ["createStamp", "verifyStamp", "reconstructStamp"])
		assert.equal(typeof stamps[name], "function", name);
});

test("P6a control: canonical RECORD framing is independent of package and raw hashes", () => {
	const value = { z: [0, true, null], a: "\n/é" };
	const literal = Buffer.from('{"a":"\\u000a/é","z":[0,true,null]}');
	assert.deepEqual(Buffer.from(canonical(value)), literal);
	assert.deepEqual(canonicalJSON(value), literal);
	const framed = Buffer.concat([
		Buffer.from("agent-profiles/stamp/v1\0"),
		u64(literal.length),
		literal,
	]);
	// Golden independently framed with PowerShell/.NET SHA256, not the product encoder.
	assert.equal(
		record(value),
		"0c3a4d18631e86c00799d10113a8593c468c50ac5f54b2ac0beed83ad150d819",
	);
	assert.equal(record(value), sha(framed));
	assert.equal(hashRecord(DOMAIN, value), record(value));
	assert.notEqual(record(value), sha(literal));
	assert.notEqual(record(value), record(value, "agent-profiles/lock/v1"));
	assert.notEqual(record(value), record({ ...value, z: [true, 0, null] }));
	assert.equal(canonical("literal \\n /\t"), '"literal \\\\n /\\u0009"');
	assert.equal(
		treeHash([]),
		"c71fc9b6b9f9a136716177698f03033fb4d72718b67b494a67adc7e6c77795f2",
	);
	assert.equal(
		sha(Buffer.alloc(0)),
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
});

test("P6a control: fingerprint excludes only the normalized permitted path", (t) => {
	const root = scratch(t);
	put(path.join(root, "nested/allowed.md"), "first");
	put(path.join(root, "nested/protected.bin"), Buffer.from([0, 255]));
	const before = fingerprint(root, ["nested/allowed.md"]);
	put(path.join(root, "nested/allowed.md"), "second");
	assert.deepEqual(fingerprint(root, ["nested/allowed.md"]), before);
	put(path.join(root, "nested/protected.bin"), Buffer.from([0, 254]));
	assert.notDeepEqual(fingerprint(root, ["nested/allowed.md"]), before);
});

for (const ambient of ["empty", "misleading"])
	test(`P6a control: real import/install/required resolution uses explicit store over ${ambient} ambient`, (t) => {
		const f = fixture(t, { ambient }),
			before = f.state();
		const a = f.resolve(),
			b = f.resolve({ model: "large", role: "packaged" });
		assert.equal(a.lockState, "valid");
		assert.equal(a.lockMode, "required");
		assert.equal(a.installRequired, false);
		assert.deepEqual(
			a.loaded.map((e) => [e.kind, e.id]),
			[
				["profile", "base"],
				["role", "reviewer"],
				["required-skill", "local"],
				["required-skill", "review"],
				["requested-skill", "c"],
				["requested-skill", "b"],
			],
		);
		assert.deepEqual(
			a.required.map((e) => e.id),
			["local", "review", "native"],
		);
		assert.deepEqual(
			a.available.map((e) => e.id),
			["b", "c", "idle"],
		);
		for (const [result, version] of [
			[a, "1.0.0"],
			[b, "2.0.0"],
		]) {
			assert.equal(
				result.required.find((s) => s.id === "review").package.sha256,
				f.packages.get(`@stamp/review@${version}`).sha256,
			);
			assert.equal(result.required.find((s) => s.id === "native").usable, true);
		}
		for (const e of b.loaded.slice(0, 2)) {
			assert.equal(e.package.version, "2.0.0");
			assert.equal(e.package.selectedBy, "large");
			assert.deepEqual(e.package.selectors, { model: "large" });
		}
		assert.ok(!a.loaded.some((e) => e.id === "native" || e.id === "idle"));
		for (const p of f.packages.values()) {
			const loaded = lookupPackage({
				storeRoot: f.storeRoot,
				...p.manifest.package,
			});
			assert.equal(loaded.sha256, treeHash(p.files));
			assert.deepEqual(loaded.files, p.files);
			assert.deepEqual(
				readPackage({ root: treePath(f, p.sha256) }).files,
				p.files,
			);
			assert.notEqual(
				lookupPackage({ storeRoot: f.misleading, ...p.manifest.package })
					.sha256,
				p.sha256,
			);
		}
		const wanted = expected(f);
		assert.deepEqual(wanted.requested, ["local", "c", "b"]);
		assert.deepEqual(
			wanted.composition.map((e) => e.id),
			a.loaded.map((e) => e.id),
		);
		assert.deepEqual(
			wanted.packages.map((p) => p.name),
			["@stamp/idle", "@stamp/native", "@stamp/review"],
		);
		for (const [s, r] of [
			[wanted, a],
			[expected(f, { packaged: true }), b],
		]) {
			for (const e of s.composition) {
				const actual = r.loaded.find(
					(item) => item.kind === e.kind && item.id === e.id,
				);
				assert.deepEqual(actual.package ?? null, e.package);
				assert.deepEqual(
					actual.backing ?? blob(actual.path, LOCAL[actual.path]),
					e.backing,
				);
			}
			for (const key of ["required", "available"])
				for (const e of s[key]) {
					const actual = r[key].find((item) => item.id === e.id);
					for (const field of [
						"type",
						"delivery",
						"name",
						"nameSource",
						"description",
					])
						assert.equal(actual[field], e[field]);
					assert.deepEqual(actual.package ?? null, e.package);
				}
			assert.equal(
				record(s),
				hashRecord(DOMAIN, s),
				"complete snapshot oracle agrees with independently tested product encoder",
			);
			assert.deepEqual(Buffer.from(canonical(s)), canonicalJSON(s));
		}
		assert.deepEqual(
			Buffer.from(a.loaded[0].content),
			LOCAL[".agent-profiles/profiles/base.md"],
		);
		assert.notEqual(
			sha(LOCAL[".agent-profiles/profiles/base.md"]),
			sha(Buffer.from(a.loaded[0].content.trim())),
			"trimmed presentation cannot serve as raw backing",
		);
		assert.deepEqual(f.state(), before);
	});

test("P6a control: native filesystem interception observes real rename and late failure", (t) => {
	const dir = scratch(t),
		source = path.join(dir, "source"),
		targetFile = path.join(dir, "target");
	put(source, Buffer.from([0, 255, 13, 10]));
	let calls = 0;
	const close = intercept(t, "renameSync", (rename, from, to) => {
		calls++;
		assert.equal(fs.existsSync(to), false);
		return rename(from, to);
	});
	try {
		esmRename(source, targetFile);
	} finally {
		close();
	}
	assert.equal(calls, 1);
	assert.deepEqual(fs.readFileSync(targetFile), Buffer.from([0, 255, 13, 10]));
	const fail = intercept(t, "renameSync", () => {
		throw Object.assign(new Error("owned late I/O"), { code: "EIO" });
	});
	try {
		assert.throws(() => fs.renameSync(targetFile, source), /owned late I\/O/);
	} finally {
		fail();
	}
	assert.deepEqual(fs.readFileSync(targetFile), Buffer.from([0, 255, 13, 10]));
	assert.equal(fs.existsSync(source), false);
	const writes = observeWrites(t);
	try {
		fs.readFileSync(targetFile);
		assert.deepEqual(writes.calls, [], "read flags do not count as writes");
		put(source, "observable write");
		assert.ok(writes.calls.includes("writeFileSync"));
	} finally {
		writes.close();
	}
});

for (const requirement of ["required", "available"])
	test(`P6a control: current v2 local and ${requirement} project/user/plugin native fixtures resolve without a lock`, (t) => {
		const f = nativeFixture(t, requirement),
			before = f.state(),
			r = f.resolve({ host: "claude" });
		assert.equal(r.lockState, "not-required");
		assert.equal(r.lockMode, "required");
		assert.equal(r.installRequired, false);
		const refs = r[requirement].filter((e) => e.type === "host");
		assert.deepEqual(
			refs.map((e) => [e.id, e.scope, e.hostId]),
			[
				["project", "project", "project"],
				["personal", "user", "personal"],
				["plugin", "plugin", "kit:plugin"],
			],
		);
		assert.deepEqual(
			fs.readFileSync(path.join(f.root, refs[0].path)),
			f.nativeBytes,
		);
		assert.equal(refs[1].path, null);
		assert.equal(refs[2].path, null);
		assert.ok(r.loaded.every((e) => !refs.some((n) => n.id === e.id)));
		assert.deepEqual(f.state(), before);
	});

for (const mode of ["missing", "stale", "incomplete"])
	test(`P6a control: real required resolver refuses ${mode} lock while validation remains explicit`, (t) => {
		const f = fixture(t),
			pattern = damageLock(f, mode),
			before = f.state(),
			writes = observeWrites(t);
		try {
			assert.throws(() => f.resolve(), pattern);
			const selection = f.resolve({ lockMode: "validation" });
			assert.equal(selection.installRequired, true);
			assert.equal(selection.lockMode, "validation");
		} finally {
			writes.close();
		}
		assert.deepEqual(writes.calls, []);
		assert.deepEqual(f.state(), before);
	});

for (const packaged of [false, true])
	stampTest(
		`C13 exact canonical snapshot captures ${packaged ? "package profile and role" : "local profile and role"} with full selected closure`,
		async (t) => {
			const f = fixture(t),
				beforeProject = fingerprint(f.root),
				beforeAmbient = fingerprint(f.misleading);
			const result = await capture(
					f,
					packaged ? { model: "large", role: "packaged" } : {},
				),
				want = expected(f, { packaged });
			assert.deepEqual(result.snapshot, want);
			assert.equal(result.digest, record(want));
			for (const e of [
				...want.composition,
				...want.required,
				...want.available,
			]) {
				assert.deepEqual(
					raw(f, e.backing),
					e.backing.type === "blob"
						? LOCAL[e.backing.path]
						: f.packages
								.get(`${e.package.name}@${e.package.version}`)
								.files.find((p) => p.path === e.backing.path).bytes,
				);
			}
			for (const p of want.packages)
				assert.deepEqual(
					readPackage({ root: treePath(f, p.sha256) }).files,
					f.packages.get(`${p.name}@${p.version}`).files,
				);
			assert.deepEqual(raw(f, want.shared[0].backing), LOCAL["AGENTS.md"]);
			assert.deepEqual(fingerprint(f.root), beforeProject);
			assert.deepEqual(fingerprint(f.misleading), beforeAmbient);
			assert.equal(
				(await verified(f, result.digest)).declaredHostDependenciesSatisfied,
				false,
			);
		},
	);

stampTest(
	"C13 requested canonicalization keeps required IDs once and available request order",
	async (t) => {
		const f = fixture(t),
			a = await capture(f);
		const repeat = await capture(f, {
			skills: ["local", "c", "c", "b", "local"],
		});
		assert.equal(repeat.digest, a.digest);
		const reordered = await capture(f, { skills: ["local", "b", "c"] });
		assert.notEqual(a.digest, reordered.digest);
		assert.deepEqual(
			reordered.snapshot.composition.map((e) => e.id),
			["base", "reviewer", "local", "review", "b", "c"],
		);
		const before = f.state();
		await assert.rejects(
			async () => stamps.createStamp({ ...f.options, skills: ["unpermitted"] }),
			/unpermitted|not required or available/,
		);
		assert.deepEqual(f.state(), before);
	},
);

stampTest(
	"C14 roots, timestamps and unrelated freshly locked assignments do not change selected identity",
	async (t) => {
		const f = fixture(t),
			a = await capture(f),
			relocated = path.join(f.dir, "relocated");
		fs.mkdirSync(relocated);
		const root = path.join(relocated, "repo"),
			storeRoot = path.join(relocated, "store");
		fs.cpSync(f.root, root, { recursive: true });
		fs.cpSync(f.storeRoot, storeRoot, { recursive: true });
		fs.rmSync(path.join(storeRoot, "stamps"), { recursive: true });
		fs.utimesSync(
			path.join(root, ".agent-profiles/profiles/base.md"),
			new Date(0),
			new Date(0),
		);
		const next = structuredClone(f.config);
		next.assignments.unrelated = {
			when: { role: "packaged", model: "small" },
			versions: { "skills.review": "2.0.0" },
		};
		put(path.join(root, CONFIG), stringify(next));
		installDependencies({ root, storeRoot });
		const b = await stamps.createStamp({ ...f.options, root, storeRoot });
		assert.deepEqual(b.snapshot, a.snapshot);
		assert.equal(b.digest, a.digest);
		assert.deepEqual(
			fs.readFileSync(
				path.join(storeRoot, "stamps/sha256", b.digest, "snapshot.json"),
			),
			Buffer.from(canonical(a.snapshot)),
		);
	},
);

for (const [label, extra] of [
	["raw alias", { model: "small-alias" }],
	["identity source", { identitySource: "host-stated" }],
	["profile and revision", { model: "large" }],
	["role", { role: "packaged" }],
	["host omitted", { host: undefined }],
]) {
	stampTest(`C14 ${label} participates in identity`, async (t) => {
		const f = fixture(t),
			a = await capture(f),
			b = await capture(f, extra);
		assert.notEqual(a.digest, b.digest);
		assert.notDeepEqual(a.snapshot.selection, b.snapshot.selection);
	});
}
for (const kind of ["profile", "role"])
	stampTest(
		`C14 ${kind} same-tree rule identity is retained independently`,
		async (t) => {
			const f = fixture(t),
				binding = kind === "profile" ? "profiles.pack" : "roles.packaged";
			const old = f.config.assignments.large;
			delete old.versions[binding];
			(kind === "profile"
				? f.config.profiles.pack
				: f.config.roles.packaged).version = "2.0.0";
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			const a = await capture(f, { model: "large", role: "packaged" });
			f.config.assignments["pin-a"] = {
				when: { model: "large" },
				versions: { [binding]: "2.0.0" },
			};
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			const b = await capture(f, { model: "large", role: "packaged" });
			f.config.assignments["pin-b"] = f.config.assignments["pin-a"];
			delete f.config.assignments["pin-a"];
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			const c = await capture(f, { model: "large", role: "packaged" });
			const entry = (s) => s.snapshot.composition.find((e) => e.kind === kind);
			assert.equal(entry(a).package.selectedBy, "binding-default");
			assert.equal(entry(b).package.selectedBy, "pin-a");
			assert.equal(entry(c).package.selectedBy, "pin-b");
			assert.deepEqual(entry(a).backing, entry(b).backing);
			assert.deepEqual(entry(b).backing, entry(c).backing);
			assert.notEqual(a.digest, b.digest);
			assert.notEqual(b.digest, c.digest);
		},
	);

for (const p of [
	".agent-profiles/profiles/base.md",
	".agent-profiles/roles/reviewer.md",
	"instructions/c.md",
	"AGENTS.md",
])
	stampTest(
		`C14 raw-byte change in ${p} changes stamp without rewriting prior backing`,
		async (t) => {
			const f = fixture(t),
				a = await capture(f),
				prior = fs.readFileSync(snapshotPath(f, a.digest));
			fs.appendFileSync(path.join(f.root, p), "\r\n");
			const b = await capture(f);
			assert.notEqual(a.digest, b.digest);
			assert.deepEqual(fs.readFileSync(snapshotPath(f, a.digest)), prior);
			await verified(f, a.digest);
		},
	);

stampTest(
	"C14 available unrequested bytes and local paths participate without injection",
	async (t) => {
		const f = fixture(t),
			a = await capture(f, { skills: ["b"] });
		fs.appendFileSync(path.join(f.root, "instructions/c.md"), "changed\r\n");
		const b = await capture(f, { skills: ["b"] });
		assert.notEqual(a.digest, b.digest);
		assert.deepEqual(a.snapshot.composition, b.snapshot.composition);
		put(
			path.join(f.root, "instructions/relocated.md"),
			fs.readFileSync(path.join(f.root, "instructions/c.md")),
		);
		f.config.skills.c.file = "instructions/relocated.md";
		f.save();
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		const c = await capture(f, { skills: ["b"] });
		assert.notEqual(b.digest, c.digest);
		assert.equal(
			c.snapshot.available.find((s) => s.id === "c").backing.path,
			"instructions/relocated.md",
		);
	},
);

for (const list of ["required", "available"])
	stampTest(`C14 ${list} declaration order affects identity`, async (t) => {
		const f = fixture(t),
			a = await capture(f);
		f.config.roles.reviewer.skills[list].reverse();
		f.save();
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		const b = await capture(f);
		assert.notEqual(a.digest, b.digest);
		assert.deepEqual(
			b.snapshot[list].map((s) => s.id),
			[...a.snapshot[list]].reverse().map((s) => s.id),
		);
		if (list === "required")
			assert.deepEqual(
				b.snapshot.composition.map((s) => s.id),
				["base", "reviewer", "review", "local", "c", "b"],
			);
		else assert.deepEqual(a.snapshot.composition, b.snapshot.composition);
	});

stampTest(
	"C14 same package labels with changed retained assets have distinct selected digests",
	async (t) => {
		const a = fixture(t),
			first = await capture(a, { skills: [] });
		const b = fixture(t, { idleAsset: 254, isolateAmbient: false });
		const p = b.packages.get("@stamp/idle@1.0.0"),
			prior = a.packages.get("@stamp/idle@1.0.0");
		assert.equal(p.manifest.package.name, prior.manifest.package.name);
		assert.equal(p.manifest.package.version, prior.manifest.package.version);
		assert.notEqual(p.sha256, prior.sha256);
		assert.deepEqual(
			p.files.filter((e) => e.path !== "assets/Z.bin"),
			prior.files.filter((e) => e.path !== "assets/Z.bin"),
		);
		const second = await capture(b, { skills: [] });
		assert.notEqual(first.digest, second.digest);
		assert.ok(!second.snapshot.composition.some((e) => e.id === "idle"));
	},
);

for (const mode of ["missing", "stale", "incomplete"])
	stampTest(
		`C13 required ${mode} lock refuses before capture and preserves all state`,
		async (t) => {
			const f = fixture(t),
				pattern = damageLock(f, mode);
			assert.throws(() => f.resolve(), pattern);
			assert.equal(f.resolve({ lockMode: "validation" }).installRequired, true);
			const before = f.state(),
				writes = observeWrites(t);
			try {
				await assert.rejects(
					async () => stamps.createStamp(f.options),
					pattern,
				);
			} finally {
				writes.close();
			}
			assert.deepEqual(
				writes.calls,
				[],
				"required-lock refusal must precede any acquisition/publication attempt",
			);
			assert.deepEqual(f.state(), before);
		},
	);

stampTest(
	"C13 zero-pin local v2 needs no lock and leaves unrelated leftover lock untouched",
	async (t) => {
		const f = fixture(t, { localOnly: true });
		assert.equal(f.resolve().lockState, "not-required");
		const a = await capture(f);
		assert.deepEqual(a.snapshot, expected(f));
		put(path.join(f.root, LOCK), "unrelated stale lock\r\n");
		const before = fingerprint(f.root),
			b = await capture(f);
		assert.equal(a.digest, b.digest);
		assert.deepEqual(fingerprint(f.root), before);
	},
);

stampTest(
	"C13 capture owns required resolution and refuses a validation-mode override",
	async (t) => {
		const f = fixture(t),
			selection = f.resolve({ lockMode: "validation" }),
			before = f.state();
		await assert.rejects(
			async () => stamps.createStamp({ ...f.options, selection }),
			/selection|unsupported|unknown/,
		);
		await assert.rejects(
			async () => stamps.createStamp({ ...f.options, lockMode: "validation" }),
			/lockMode|validation|unsupported|unknown/,
		);
		assert.deepEqual(f.state(), before);
	},
);

stampTest(
	"C13 identical publication is idempotent and backing is complete before snapshot rename",
	async (t) => {
		const f = fixture(t),
			want = expected(f),
			digest = record(want),
			final = path.dirname(snapshotPath(f, digest));
		let observed = 0;
		const close = intercept(t, "renameSync", (rename, from, to) => {
			if (path.resolve(String(to)) === final) {
				observed++;
				assert.equal(fs.existsSync(final), false);
				assert.deepEqual(
					fs.readFileSync(path.join(String(from), "snapshot.json")),
					Buffer.from(canonical(want)),
				);
				for (const e of [
					...want.composition,
					...want.required,
					...want.available,
					...want.shared,
				]) {
					const b = e.backing;
					assert.ok(Buffer.isBuffer(raw(f, b)));
					if (b.type === "blob") {
						assert.equal(raw(f, b).length, b.bytes);
						assert.equal(sha(raw(f, b)), b.sha256);
					} else
						assert.equal(
							readPackage({ root: treePath(f, b.sha256) }).sha256,
							b.sha256,
						);
				}
			}
			return rename(from, to);
		});
		let a;
		try {
			a = await capture(f);
		} finally {
			close();
		}
		assert.equal(
			observed,
			1,
			"atomic complete directory publication, not visible file-by-file copying",
		);
		const before = fingerprint(f.storeRoot),
			restore = [];
		const immutable = (p) =>
			typeof p === "string" &&
			/\/(?:objects|blobs|stamps)\/sha256\//.test(p.split(path.sep).join("/"));
		for (const method of ["renameSync", "writeFileSync", "openSync"])
			restore.push(
				intercept(t, method, (operation, ...args) => {
					const targetFile = method === "renameSync" ? args[1] : args[0];
					const flags = args[1],
						writing =
							method !== "openSync" ||
							(typeof flags === "number"
								? (flags &
										(fs.constants.O_WRONLY |
											fs.constants.O_RDWR |
											fs.constants.O_CREAT |
											fs.constants.O_TRUNC |
											fs.constants.O_APPEND)) !==
									0
								: !["r", "rs", "sr"].includes(flags ?? "r"));
					if (writing && immutable(targetFile))
						assert.equal(
							fs.existsSync(targetFile),
							false,
							"immutable published backing cannot be overwritten even with identical bytes",
						);
					return operation(...args);
				}),
			);
		let b;
		try {
			b = await capture(f);
		} finally {
			for (const close of restore.reverse()) close();
		}
		assert.equal(a.digest, b.digest);
		assert.deepEqual(fingerprint(f.storeRoot), before);
	},
);

stampTest(
	"C13 caught late snapshot publication failure preserves prior stamps and retained backing",
	async (t) => {
		const f = fixture(t),
			a = await capture(f),
			prior = fs.readFileSync(snapshotPath(f, a.digest));
		fs.appendFileSync(
			path.join(f.root, "instructions/c.md"),
			"late change\r\n",
		);
		const project = fingerprint(f.root),
			priorBacking = raw(
				f,
				a.snapshot.available.find((e) => e.id === "c").backing,
			);
		let fired = 0,
			attempted;
		const close = intercept(t, "renameSync", (rename, from, to) => {
			if (String(to).split(path.sep).join("/").includes("/stamps/sha256/")) {
				fired++;
				attempted = String(to);
				assert.equal(fs.existsSync(to), false);
				throw Object.assign(new Error("owned snapshot publication EIO"), {
					code: "EIO",
				});
			}
			return rename(from, to);
		});
		try {
			await assert.rejects(
				async () => stamps.createStamp(f.options),
				/EIO|owned snapshot publication/,
			);
		} finally {
			close();
		}
		assert.equal(fired, 1);
		assert.equal(fs.existsSync(attempted), false);
		assert.deepEqual(fs.readFileSync(snapshotPath(f, a.digest)), prior);
		assert.deepEqual(
			raw(f, a.snapshot.available.find((e) => e.id === "c").backing),
			priorBacking,
		);
		assert.deepEqual(fingerprint(f.root), project);
		await verified(f, a.digest);
	},
);

stampTest(
	"C13 busy store refuses capture without stealing its lock while immutable readers remain usable",
	async (t) => {
		const f = fixture(t),
			a = await capture(f);
		put(
			path.join(f.storeRoot, ".writer-lock/owner.json"),
			'{"pid":0,"operation":"other-owner"}',
		);
		const before = f.state();
		await assert.rejects(
			async () => stamps.createStamp(f.options),
			/store-busy/,
		);
		assert.deepEqual(f.state(), before);
		await verified(f, a.digest);
		const r = await stamps.reconstructStamp({
			digest: a.digest,
			storeRoot: f.storeRoot,
		});
		assert.deepEqual(
			r.composition.map((e) => e.id),
			a.snapshot.composition.map((e) => e.id),
		);
		assert.deepEqual(
			f.state(),
			before,
			"readers never recover or steal the writer lock",
		);
	},
);

for (const input of ["configuration", "local instruction"])
	stampTest(
		`C13 ${input} drift during backing publication refuses final snapshot and preserves the user edit`,
		async (t) => {
			const f = fixture(t),
				want = expected(f),
				digest = record(want);
			const file = path.join(
				f.root,
				input === "configuration" ? CONFIG : "instructions/c.md",
			);
			let fired = 0,
				edited;
			const close = intercept(t, "renameSync", (rename, from, to) => {
				if (
					!fired &&
					String(to).split(path.sep).join("/").includes("/blobs/sha256/")
				) {
					fired++;
					edited = Buffer.concat([
						fs.readFileSync(file),
						Buffer.from(
							input === "configuration"
								? "\n# concurrent edit\n"
								: "concurrent bytes\r\n",
						),
					]);
					put(file, edited);
				}
				return rename(from, to);
			});
			try {
				await assert.rejects(
					async () => stamps.createStamp(f.options),
					/stale-input|changed during|changed.*capture|concurrent/,
				);
			} finally {
				close();
			}
			assert.equal(fired, 1, "actual backing publication boundary intercepted");
			assert.deepEqual(
				fs.readFileSync(file),
				edited,
				"caught failure must not revert a user edit",
			);
			assert.equal(fs.existsSync(snapshotPath(f, digest)), false);
			const finalRoot = path.join(f.storeRoot, "stamps/sha256");
			assert.deepEqual(
				fs.existsSync(finalRoot) ? fs.readdirSync(finalRoot) : [],
				[],
				"no differently named partial snapshot either",
			);
		},
	);

stampTest(
	"C13 portable capture rejects invalid UTF-8 local bytes without rewriting inputs",
	async (t) => {
		const f = fixture(t, { localOnly: true });
		put(
			path.join(f.root, ".agent-profiles/profiles/base.md"),
			Buffer.from([0xff, 0xfe, 13, 10]),
		);
		assert.equal(
			f.resolve().lockState,
			"not-required",
			"existing local resolver accepts this path; failure is the portable stamp boundary",
		);
		const before = f.state();
		await assert.rejects(
			async () => stamps.createStamp(f.options),
			/UTF-?8|encoding|decode/,
		);
		assert.deepEqual(f.state(), before);
	},
);

for (const corrupt of ["blob", "snapshot", "package resource"])
	stampTest(
		`C13 existing corrupt immutable ${corrupt} is refused without overwrite`,
		async (t) => {
			const f = fixture(t),
				a = await capture(f);
			const file =
				corrupt === "blob"
					? blobPath(f, a.snapshot.composition[0].backing)
					: corrupt === "snapshot"
						? snapshotPath(f, a.digest)
						: path.join(
								treePath(f, a.snapshot.packages[0].sha256),
								"assets/Z.bin",
							);
			fs.appendFileSync(file, Buffer.from([255]));
			const before = f.state();
			await assert.rejects(
				async () => stamps.createStamp(f.options),
				/mismatch|corrupt|digest|integrity|snapshot|UTF/,
			);
			assert.deepEqual(f.state(), before);
		},
	);

for (const missing of ["available local", "package resource"])
	stampTest(
		`C13 missing ${missing} prevents snapshot publication without repair`,
		async (t) => {
			const f = fixture(t);
			const file =
				missing === "available local"
					? path.join(f.root, "instructions/c.md")
					: path.join(
							treePath(f, f.packages.get("@stamp/idle@1.0.0").sha256),
							"assets/Z.bin",
						);
			fs.unlinkSync(file);
			const before = f.state();
			await assert.rejects(
				async () => stamps.createStamp(f.options),
				/missing|ENOENT|mismatch|cannot/,
			);
			assert.deepEqual(f.state(), before);
			assert.equal(fs.existsSync(path.join(f.storeRoot, "stamps")), false);
		},
	);

for (const packaged of [false, true])
	stampTest(
		`C15 source deletion reconstructs ${packaged ? "package" : "local"} layers and full available trees in a fresh process`,
		async (t) => {
			const f = fixture(t),
				a = await capture(
					f,
					packaged ? { model: "large", role: "packaged" } : {},
				);
			const want = expected(f, { packaged });
			fs.rmSync(f.root, { recursive: true });
			for (const p of ["explicit-sources", "ambient-sources"])
				fs.rmSync(path.join(f.dir, p), { recursive: true });
			fs.rmSync(f.misleading, { recursive: true });
			fs.mkdirSync(f.misleading);
			fs.rmSync(path.join(f.storeRoot, "identities"), { recursive: true });
			const before = f.state();
			const r = await stamps.reconstructStamp({
				digest: a.digest,
				storeRoot: f.storeRoot,
			});
			assert.deepEqual(
				r.composition.map(({ bytes, ...entry }) => entry),
				want.composition,
			);
			assert.deepEqual(r.required, want.required);
			assert.deepEqual(
				r.available.map(({ bytes, ...entry }) => entry),
				want.available,
			);
			const bytesFor = (e) =>
				e.backing.type === "blob"
					? LOCAL[e.backing.path]
					: f.packages
							.get(`${e.package.name}@${e.package.version}`)
							.files.find((p) => p.path === e.backing.path).bytes;
			for (const e of r.composition) {
				assert.ok(Buffer.isBuffer(e.bytes));
				assert.deepEqual(e.bytes, bytesFor(e));
			}
			for (const e of r.available) {
				assert.ok(Buffer.isBuffer(e.bytes));
				assert.deepEqual(e.bytes, bytesFor(e));
			}
			assert.deepEqual(r.resources, []);
			assert.deepEqual(
				r.packages,
				want.packages.map((p) => ({
					...p,
					files: f.packages.get(`${p.name}@${p.version}`).files,
				})),
			);
			assert.deepEqual(
				r.shared,
				want.shared.map((e) => ({ ...e, bytes: LOCAL[e.path] })),
			);
			assert.deepEqual(
				r.hostReferences,
				want.hostReferences.map((e) => ({
					...e,
					bytes: f.packages
						.get(`@stamp/native@${packaged ? "2.0.0" : "1.0.0"}`)
						.files.find((p) => p.path === "SKILL.md").bytes,
				})),
			);
			// Only reached with the real seam present; normal coordinator execution qualifies child spawning.
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(await m.reconstructStamp({digest:process.argv[2],storeRoot:process.argv[3]})));",
					target.href,
					a.digest,
					f.storeRoot,
				],
				{
					cwd: f.dir,
					env: { ...process.env },
					encoding: "utf8",
					timeout: 10000,
					maxBuffer: 1024 * 1024,
				},
			);
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stderr);
			const independent = JSON.parse(child.stdout, (_key, value) =>
				value?.type === "Buffer" && Array.isArray(value.data)
					? Buffer.from(value.data)
					: value,
			);
			assert.deepEqual(
				independent,
				r,
				"fresh process has no captured module memory or mutable project to consult",
			);
			assert.deepEqual(f.state(), before);
			assert.equal(
				(await verified(f, a.digest)).declaredHostDependenciesSatisfied,
				false,
			);
		},
	);

const relations = [
	[
		"unknown snapshot field",
		(s) => {
			s.createdAt = "not canonical identity";
		},
		/createdAt|unknown|field/,
	],
	[
		"resolver contract mismatch",
		(s) => {
			s.resolverContract = "agent-profiles/resolver/v1";
		},
		/resolverContract|configurationVersion|resolver/,
	],
	[
		"duplicate requested ID",
		(s) => {
			s.requested.push(s.requested[0]);
		},
		/requested|duplicate/,
	],
	[
		"unpermitted request",
		(s) => {
			s.requested.push("foreign");
		},
		/requested|foreign|permission/,
	],
	[
		"composition order",
		(s) => {
			[s.composition[0], s.composition[1]] = [
				s.composition[1],
				s.composition[0],
			];
		},
		/composition|order|profile/,
	],
	[
		"omitted required injection",
		(s) => {
			s.composition.splice(2, 1);
		},
		/composition|required/,
	],
	[
		"native injection",
		(s) => {
			const n = s.required.find((e) => e.id === "native");
			s.composition.push({
				kind: "required-skill",
				id: n.id,
				backing: n.backing,
				package: n.package,
				resources: [],
			});
		},
		/native|composition|inject/,
	],
	[
		"skill backing disagreement",
		(s) => {
			s.composition.find((e) => e.id === "c").backing = s.available.find(
				(e) => e.id === "b",
			).backing;
		},
		/composition|backing|c/,
	],
	[
		"omitted available backing",
		(s) => {
			s.available.find((e) => e.id === "c").backing = null;
		},
		/available|backing|c/,
	],
	[
		"duplicate available ID",
		(s) => {
			s.available.push(s.available[0]);
		},
		/available|duplicate/,
	],
	[
		"omitted package table member",
		(s) => {
			s.packages.pop();
		},
		/packages|closure|revision/,
	],
	[
		"foreign package table member",
		(s, f) => {
			const p = f.packages.get("@stamp/review@1.0.0");
			s.packages.push({
				name: "@stamp/review",
				version: "1.0.0",
				sha256: p.sha256,
				behavior: p.manifest.behavior,
			});
			s.packages.sort((a, b) =>
				compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
			);
		},
		/packages|foreign|closure/,
	],
	[
		"package behavior disagreement",
		(s) => {
			s.packages[0].behavior.effects = ["commands"];
		},
		/behavior|manifest|packages/,
	],
	[
		"profile missing provenance",
		(s) => {
			s.composition[0].package = null;
		},
		/profile|package|provenance|composition/,
	],
	[
		"role wrong owning binding",
		(s) => {
			s.composition[1].package.binding = "profiles.pack";
		},
		/binding|role|composition/,
	],
	[
		"profile wrong revision identity",
		(s) => {
			s.composition[0].package.version = "1.0.0";
		},
		/version|revision|package/,
	],
	[
		"role wrong entrypoint",
		(s) => {
			s.composition[1].backing.path = "assets/a.txt";
		},
		/entrypoint|role|composition/,
	],
	[
		"profile selector disagreement",
		(s) => {
			s.composition[0].package.selectors.model = "small";
		},
		/selector|model|profile/,
	],
	[
		"base rule nonempty selectors",
		(s) => {
			const p = s.available.find((e) => e.id === "idle").package;
			p.selectors.model = "large";
		},
		/selector|binding-default|base/,
	],
	[
		"resource on package entry",
		(s) => {
			s.composition[0].resources.push({
				binding: "profiles.pack",
				backing: s.required[0].backing,
			});
		},
		/resources|package/,
	],
	[
		"local resource wrong owner",
		(s) => {
			s.required[0].resources.push({
				binding: "roles.packaged",
				backing: s.available[0].backing,
			});
		},
		/resources|binding|owner/,
	],
	[
		"duplicate host reference key",
		(s) => {
			s.hostReferences.push(s.hostReferences[0]);
		},
		/hostReferences|duplicate|key/,
	],
	[
		"native compatibility fabricated",
		(s) => {
			s.hostReferences[0].compatibility = false;
		},
		/compatibility|hostReferences|host/,
	],
	[
		"captured shared without backing",
		(s) => {
			s.shared[0].backing = null;
		},
		/shared|backing|captured/,
	],
	[
		"false runtime coverage",
		(s) => {
			s.coverage.runtimeModel = "verified";
		},
		/coverage|runtimeModel|unverified/,
	],
];
for (const [label, mutate, diagnostic] of relations)
	stampTest(`C15 validly rehashed relation refuses ${label}`, async (t) => {
		const f = fixture(t),
			a = await capture(f, { model: "large", role: "packaged" });
		await verified(f, a.digest);
		const changed = structuredClone(a.snapshot);
		mutate(changed, f);
		const digest = rewrite(f, changed);
		assert.notEqual(digest, a.digest);
		assert.equal(
			record(JSON.parse(fs.readFileSync(snapshotPath(f, digest)))),
			digest,
		);
		await invalid(f, digest, "mismatched", diagnostic);
	});

for (const mode of [
	"noncanonical",
	"wrong domain",
	"missing snapshot",
	"missing blob",
	"wrong blob byte",
	"wrong blob length",
	"missing tree",
	"extra tree member",
	"changed binary resource",
	"wrong package type",
]) {
	stampTest(
		`C15 verification distinguishes ${mode} without repair or partial reconstruction`,
		async (t) => {
			const f = fixture(t),
				a = await capture(f),
				s = structuredClone(a.snapshot);
			let digest = a.digest,
				status = "mismatched",
				field = "managedContent",
				diagnostic;
			const b = s.available.find((e) => e.id === "c").backing,
				pkg = s.packages.find((p) => p.name === "@stamp/idle");
			if (mode === "noncanonical") {
				fs.appendFileSync(snapshotPath(f, digest), "\n");
				field = "snapshotIntegrity";
				diagnostic = /canonical|snapshot/;
			}
			if (mode === "wrong domain") {
				digest = rewrite(f, s, "agent-profiles/lock/v1");
				field = "snapshotIntegrity";
				diagnostic = /digest|snapshot|domain/;
			}
			if (mode === "missing snapshot") {
				fs.unlinkSync(snapshotPath(f, digest));
				field = "snapshotIntegrity";
				status = "missing";
				diagnostic = /snapshot|missing/;
			}
			if (mode === "missing blob") {
				fs.unlinkSync(blobPath(f, b));
				status = "missing";
				diagnostic = /blob|missing/;
			}
			if (mode === "wrong blob byte") {
				const bytes = fs.readFileSync(blobPath(f, b));
				bytes[bytes.length - 1] ^= 1;
				put(blobPath(f, b), bytes);
				diagnostic = /blob|digest|mismatch/;
			}
			if (mode === "wrong blob length") {
				const length = b.bytes + 1;
				for (const e of [...s.composition, ...s.required, ...s.available])
					if (e.backing?.sha256 === b.sha256) e.backing.bytes = length;
				digest = rewrite(f, s);
				diagnostic = /bytes|length|blob/;
			}
			if (mode === "missing tree") {
				fs.rmSync(treePath(f, pkg.sha256), { recursive: true });
				status = "missing";
				diagnostic = /tree|package|missing/;
			}
			if (mode === "extra tree member") {
				put(path.join(treePath(f, pkg.sha256), "extra.bin"), Buffer.from([0]));
				diagnostic = /tree|package|digest|mismatch/;
			}
			if (mode === "changed binary resource") {
				put(
					path.join(treePath(f, pkg.sha256), "assets/Z.bin"),
					Buffer.from([0, 254, 13, 10, 1]),
				);
				diagnostic = /tree|package|digest|mismatch/;
			}
			if (mode === "wrong package type") {
				const instruction = f.packages.get("@stamp/instructions@1.0.0");
				const e = s.available.find((e) => e.id === "idle");
				e.backing = {
					type: "package",
					sha256: instruction.sha256,
					path: "ENTRY.md",
				};
				e.package = {
					...e.package,
					name: "@stamp/instructions",
					sha256: instruction.sha256,
				};
				s.packages = s.packages.filter((p) => p.name !== "@stamp/idle");
				s.packages.push({
					name: "@stamp/instructions",
					version: "1.0.0",
					sha256: instruction.sha256,
					behavior: instruction.manifest.behavior,
				});
				s.packages.sort((a, b) => compare(a.name, b.name));
				digest = rewrite(f, s);
				diagnostic = /type|skill|instruction|manifest/;
			}
			await invalid(f, digest, status, diagnostic, field);
		},
	);
}

stampTest(
	"C16 ordered explicit shared observations retain raw bytes outside composition",
	async (t) => {
		const f = fixture(t),
			sharedFiles = ["shared/a.md", "AGENTS.md", "shared/Z.md"];
		const a = await capture(f, { sharedFiles });
		assert.deepEqual(a.snapshot, expected(f, { shared: sharedFiles }));
		const b = await capture(f, { sharedFiles: [...sharedFiles].reverse() });
		assert.notEqual(a.digest, b.digest);
		for (const e of a.snapshot.shared)
			assert.deepEqual(raw(f, e.backing), LOCAL[e.path]);
		const before = f.state();
		await assert.rejects(
			async () =>
				stamps.createStamp({
					...f.options,
					sharedFiles: ["AGENTS.md", "AGENTS.md"],
				}),
			/shared|duplicate/,
		);
		await assert.rejects(
			async () =>
				stamps.createStamp({ ...f.options, sharedFiles: ["../outside.md"] }),
			/shared|path|escape|traversal/,
		);
		assert.deepEqual(f.state(), before);
	},
);

stampTest(
	"C16 default shared absence changes identity and carries no fake hash",
	async (t) => {
		const f = fixture(t),
			a = await capture(f);
		fs.unlinkSync(path.join(f.root, "AGENTS.md"));
		const b = await capture(f);
		assert.deepEqual(b.snapshot.shared, [
			{
				path: "AGENTS.md",
				status: "absent",
				backing: null,
				delivery: "host-controlled",
			},
		]);
		assert.notEqual(a.digest, b.digest);
		await verified(f, b.digest);
	},
);

stampTest(
	"C16 explicitly requested shared capture is required and missing bytes refuse without publication",
	async (t) => {
		const f = fixture(t),
			before = f.state();
		await assert.rejects(
			async () =>
				stamps.createStamp({
					...f.options,
					sharedFiles: ["shared/missing.md"],
				}),
			/shared.*missing|missing.*shared|ENOENT/,
		);
		assert.deepEqual(f.state(), before);
	},
);

stampTest(
	"C16 unsafe default shared link is unobserved without following its target",
	async (t) => {
		const f = fixture(t),
			outside = path.join(f.dir, "private.md");
		put(outside, "never capture private bytes");
		fs.unlinkSync(path.join(f.root, "AGENTS.md"));
		try {
			fs.symlinkSync(outside, path.join(f.root, "AGENTS.md"));
		} catch (error) {
			if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) {
				t.skip(`native file symlink unavailable: ${error.code}`);
				return;
			}
			throw error;
		}
		const a = await capture(f);
		assert.deepEqual(a.snapshot.shared, [
			{
				path: "AGENTS.md",
				status: "unobserved",
				backing: null,
				delivery: "host-controlled",
			},
		]);
		assert.equal(
			fs.existsSync(
				path.join(
					f.storeRoot,
					"blobs/sha256",
					sha(Buffer.from("never capture private bytes")),
				),
			),
			false,
		);
	},
);

stampTest(
	"C16 unreadable shared observation stays unobserved by default and explicit capture refuses",
	async (t) => {
		const f = fixture(t),
			file = path.join(f.root, "AGENTS.md"),
			close = [],
			projectBefore = fingerprint(f.root);
		let fired = 0;
		for (const method of ["openSync", "readFileSync"])
			close.push(
				intercept(t, method, (read, name, ...args) => {
					const full = name instanceof URL ? fileURLToPath(name) : name;
					if (typeof full === "string" && path.resolve(full) === file) {
						fired++;
						throw Object.assign(new Error("owned shared EACCES"), {
							code: "EACCES",
						});
					}
					return read(name, ...args);
				}),
			);
		let a;
		try {
			a = await capture(f);
			const before = fingerprint(f.storeRoot);
			await assert.rejects(
				async () =>
					stamps.createStamp({ ...f.options, sharedFiles: ["AGENTS.md"] }),
				/shared|EACCES|capture/,
			);
			assert.deepEqual(fingerprint(f.storeRoot), before);
		} finally {
			for (const restore of close.reverse()) restore();
		}
		assert.deepEqual(fingerprint(f.root), projectBefore);
		assert.ok(fired > 0);
		assert.deepEqual(a.snapshot.shared, [
			{
				path: "AGENTS.md",
				status: "unobserved",
				backing: null,
				delivery: "host-controlled",
			},
		]);
	},
);

for (const host of ["codex", "hermes", undefined])
	stampTest(
		`C16 native package compatibility for ${host ?? "omitted host"} never claims invocation`,
		async (t) => {
			const f = fixture(t),
				a = await capture(f, { host });
			const n = a.snapshot.hostReferences.find(
				(e) => e.key === "skills.native",
			);
			assert.equal(
				n.compatibility,
				host === undefined ? null : host === "codex",
			);
			assert.equal(n.host, host ?? null);
			assert.equal(n.hostId, null);
			assert.equal(n.scope, "package");
			assert.deepEqual(n.supportedHosts, ["claude", "codex"]);
			assert.equal(n.invocation, "unverified");
			assert.equal(n.rendered, "unverified");
			assert.ok(!a.snapshot.composition.some((e) => e.id === "native"));
			const v = await verified(f, a.digest);
			assert.equal(v.declaredHostDependenciesSatisfied, false);
			const r = await stamps.reconstructStamp({
				digest: a.digest,
				storeRoot: f.storeRoot,
			});
			assert.ok(r.composition.every((e) => Buffer.isBuffer(e.bytes)));
			await assert.rejects(
				async () =>
					stamps.reconstructStamp({
						digest: a.digest,
						storeRoot: f.storeRoot,
						nativeReady: true,
					}),
				/unsupported-native/,
			);
		},
	);

for (const requirement of ["required", "available"])
	stampTest(
		`C16 ${requirement} project/user/plugin native observations remain honest with no ambient scans`,
		async (t) => {
			const f = nativeFixture(t, requirement),
				{ nativeBytes } = f;
			assert.equal(f.resolve({ host: "claude" }).lockState, "not-required");
			put(
				path.join(f.home, ".claude/skills/personal/SKILL.md"),
				skillBytes("ambient-private"),
			);
			const homeBefore = fingerprint(f.home),
				reads = [],
				close = [];
			for (const method of ["readdirSync", "openSync", "readFileSync"])
				close.push(
					intercept(t, method, (read, name, ...args) => {
						if (typeof name === "string" || name instanceof URL) {
							const full = path.resolve(
								name instanceof URL ? fileURLToPath(name) : name,
							);
							reads.push(full);
							assert.ok(
								!full.startsWith(f.home + path.sep) && full !== f.home,
								"no home/native inventory reads",
							);
						}
						return read(name, ...args);
					}),
				);
			let a;
			try {
				a = await capture(f, { host: "claude" });
			} finally {
				for (const restore of close.reverse()) restore();
			}
			assert.ok(reads.length > 0);
			assert.equal(a.snapshot.hostReferences.length, 3);
			for (const n of a.snapshot.hostReferences) {
				assert.equal(n.requirement, requirement);
				assert.equal(n.compatibility, true);
				assert.equal(n.host, "claude");
				assert.equal(n.invocation, "unverified");
				assert.equal(n.rendered, "unverified");
				assert.deepEqual(n.supportedHosts, ["claude"]);
				if (n.scope === "project") {
					assert.equal(n.observation, "captured-file");
					assert.deepEqual(raw(f, n.backing), nativeBytes);
				} else {
					assert.equal(n.observation, "host-provided-unverified");
					assert.equal(n.backing, null);
					assert.equal(
						n.hostId,
						n.scope === "plugin" ? "kit:plugin" : "personal",
					);
				}
			}
			assert.ok(
				!a.snapshot.composition.some((e) =>
					["project", "personal", "plugin"].includes(e.id),
				),
			);
			const v = await verified(f, a.digest);
			assert.equal(
				v.declaredHostDependenciesSatisfied,
				requirement !== "required",
			);
			assert.equal(v.hostDependencies, "unverified");
			assert.deepEqual(fingerprint(f.home), homeBefore);
			fs.rmSync(f.root, { recursive: true });
			const r = await stamps.reconstructStamp({
				digest: a.digest,
				storeRoot: f.storeRoot,
			});
			assert.deepEqual(
				r.hostReferences,
				a.snapshot.hostReferences.map((e) => ({
					...e,
					bytes: e.backing ? nativeBytes : null,
				})),
			);
			assert.ok(r.composition.every((e) => Buffer.isBuffer(e.bytes)));
		},
	);

for (const sharedFiles of [["shared/Z.md", "shared/a.md"], []])
	stampTest(
		`C16 explicit ${sharedFiles.length ? "non-AGENTS list replaces default in caller order" : "empty shared list differs from omitted default"} despite unreadable AGENTS`,
		async (t) => {
			const f = fixture(t),
				before = fingerprint(f.root),
				close = [];
			const agentsBlob = blobPath(f, blob("AGENTS.md", LOCAL["AGENTS.md"]));
			assert.equal(
				fs.existsSync(agentsBlob),
				false,
				"fresh store has no default shared blob",
			);
			const a = await capture(f, { sharedFiles });
			assert.deepEqual(a.snapshot, expected(f, { shared: sharedFiles }));
			for (const e of a.snapshot.shared)
				assert.deepEqual(raw(f, e.backing), LOCAL[e.path]);
			assert.equal(
				fs.existsSync(agentsBlob),
				false,
				"explicit capture must not archive readable default AGENTS bytes",
			);
			assert.deepEqual(
				fs.readdirSync(path.join(f.storeRoot, "stamps/sha256")),
				[a.digest],
				"only the exact explicit snapshot is associated",
			);
			const denied = fixture(t, { isolateAmbient: false }),
				file = path.join(denied.root, "AGENTS.md"),
				deniedBefore = fingerprint(denied.root);
			const deniedBlob = blobPath(
				denied,
				blob("AGENTS.md", LOCAL["AGENTS.md"]),
			);
			assert.equal(
				fs.existsSync(deniedBlob),
				false,
				"unreadable case also starts without default backing",
			);
			for (const method of ["openSync", "readFileSync"])
				close.push(
					intercept(t, method, (read, name, ...args) => {
						const full = name instanceof URL ? fileURLToPath(name) : name;
						if (typeof full === "string" && path.resolve(full) === file)
							throw Object.assign(new Error("owned shared EACCES"), {
								code: "EACCES",
							});
						return read(name, ...args);
					}),
				);
			try {
				const unreadable = await capture(denied, { sharedFiles });
				assert.deepEqual(
					unreadable.snapshot,
					a.snapshot,
					"unreadable default cannot affect explicit capture",
				);
				assert.equal(unreadable.digest, a.digest);
				for (const e of unreadable.snapshot.shared)
					assert.deepEqual(raw(denied, e.backing), LOCAL[e.path]);
				assert.equal(
					fs.existsSync(deniedBlob),
					false,
					"explicit capture must not archive default AGENTS bytes",
				);
				assert.deepEqual(
					fs.readdirSync(path.join(denied.storeRoot, "stamps/sha256")),
					[a.digest],
					"only the exact explicit snapshot is associated",
				);
			} finally {
				for (const restore of close.reverse()) restore();
			}
			const b = await capture(f);
			assert.deepEqual(b.snapshot, expected(f));
			assert.notEqual(a.digest, b.digest);
			assert.deepEqual(
				a.snapshot,
				{ ...b.snapshot, shared: expected(f, { shared: sharedFiles }).shared },
				"other fields and selection provenance stay identical",
			);
			assert.deepEqual(
				raw(f, b.snapshot.shared[0].backing),
				LOCAL["AGENTS.md"],
			);
			assert.deepEqual(
				JSON.parse(fs.readFileSync(snapshotPath(f, a.digest))),
				a.snapshot,
				"later default capture does not change the explicit association",
			);
			assert.deepEqual(fingerprint(f.root), before);
			assert.deepEqual(fingerprint(denied.root), deniedBefore);
			await verified(f, a.digest);
			await verified(f, b.digest);
		},
	);

test("P6a control: unreadable default interception preserves explicit shared bytes and empty-list oracle", (t) => {
	const f = fixture(t, { localOnly: true }),
		file = path.join(f.root, "AGENTS.md"),
		before = f.state(),
		close = [];
	const shared = ["shared/Z.md", "shared/a.md"];
	assert.deepEqual(
		expected(f, { shared }).shared,
		shared.map((p) => ({
			path: p,
			status: "captured",
			backing: blob(p, LOCAL[p]),
			delivery: "host-controlled",
		})),
	);
	assert.deepEqual(expected(f, { shared: [] }), { ...expected(f), shared: [] });
	for (const method of ["openSync", "readFileSync"])
		close.push(
			intercept(t, method, (read, name, ...args) => {
				const full = name instanceof URL ? fileURLToPath(name) : name;
				if (typeof full === "string" && path.resolve(full) === file)
					throw Object.assign(new Error("owned shared EACCES"), {
						code: "EACCES",
					});
				return read(name, ...args);
			}),
		);
	try {
		assert.throws(() => fs.openSync(file, "r"), { code: "EACCES" });
		assert.throws(() => fs.readFileSync(file), { code: "EACCES" });
		for (const p of shared)
			assert.deepEqual(fs.readFileSync(path.join(f.root, p)), LOCAL[p]);
		assert.equal(f.resolve().lockState, "not-required");
	} finally {
		for (const restore of close.reverse()) restore();
	}
	assert.deepEqual(fs.readFileSync(file), LOCAL["AGENTS.md"]);
	assert.deepEqual(f.state(), before);
});
