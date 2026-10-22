import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { stringify } from "yaml";
import * as stamps from "../src/stamps.js";
import { importPackage, lookupPackage } from "../src/package-store.js";
import { installDependencies } from "../src/package-lock.js";
import { integrations } from "../src/integrations.js";

const CONFIG = ".agent-profiles/agents.yaml";
const PROFILE = ".agent-profiles/mapped/base.md";
const ROLE = ".agent-profiles/roles/reviewer.md";
const instruction = Buffer.from("\uFEFF# Exact\r\n\r\n");
const binary = Buffer.from([0, 255, 192, 175, 13, 10, 239, 187, 191]);
const skillBytes = (id) =>
	Buffer.from(
		`---\nname: ${id}\ndescription: ${id} description\n---\n${id} body\r\n`,
	);
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

// Independent RECORD and tree framing; no production hash/canonical helper is an oracle.
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
function record(snapshot, domain = "agent-profiles/stamp/v1") {
	const bytes = Buffer.from(canonical(snapshot));
	return {
		bytes,
		digest: sha(
			Buffer.concat([Buffer.from(domain + "\0"), u64(bytes.length), bytes]),
		),
	};
}
function treeHash(files) {
	return sha(
		Buffer.concat([
			Buffer.from("agent-profiles/package-tree/v1\0"),
			u64(files.length),
			...[...files]
				.sort((a, b) => compare(a.path, b.path))
				.flatMap((f) => {
					const name = Buffer.from(f.path);
					return [
						Buffer.from([0x46]),
						u64(name.length),
						name,
						u64(f.bytes.length),
						f.bytes,
					];
				}),
		]),
	);
}
function fingerprint(root) {
	if (!fs.existsSync(root)) return null;
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort(compare)
		.map((p) => [
			p,
			fs.lstatSync(path.join(root, p)).isDirectory()
				? "directory"
				: sha(fs.readFileSync(path.join(root, p))),
		]);
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
		fs.mkdtempSync(path.join(os.tmpdir(), "stamp-diff-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store");
	fs.mkdirSync(storeRoot);
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "reviewer",
		models: {
			small: { profile: "base", aliases: ["alias"] },
			other: { profile: "base" },
		},
		families: { family: { profile: "base", match: { prefixes: ["family-"] } } },
		profiles: {
			base: { file: "mapped/base.md", resources: ["assets/profile.bin"] },
		},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				resources: ["assets/role.bin"],
				skills: { required: ["q"], available: ["a", "b"] },
			},
		},
		skills: Object.fromEntries(
			["q", "a", "b"].map((id) => [
				id,
				{ file: `instructions/${id}.md`, resources: [`assets/${id}.bin`] },
			]),
		),
	};
	const files = new Map();
	const write = (p, bytes) => {
		const b = Buffer.from(bytes);
		files.set(p, b);
		put(path.join(root, p), b);
	};
	write(PROFILE, instruction);
	write(ROLE, instruction);
	for (const id of ["q", "a", "b"]) {
		write(`instructions/${id}.md`, skillBytes(id));
		write(`assets/${id}.bin`, binary);
	}
	write("assets/profile.bin", binary);
	write("assets/role.bin", binary);
	write("AGENTS.md", instruction);
	write("shared/second.md", Buffer.from("Second\n"));
	const save = () => write(CONFIG, stringify(config));
	save();
	return {
		dir,
		root,
		storeRoot,
		config,
		files,
		write,
		save,
		packages: new Map(),
		options: {
			root,
			storeRoot,
			host: "codex",
			model: "small",
			identitySource: "user",
			sharedFiles: [],
		},
	};
}
const blob = (p, bytes) => ({
	type: "blob",
	path: p,
	sha256: sha(bytes),
	bytes: bytes.length,
});
const resource = (binding, p, bytes = binary) => ({
	binding,
	backing: blob(p, bytes),
});
const layer = (kind, id, p, resources = []) => ({
	kind,
	id,
	backing: blob(p, kind.endsWith("skill") ? skillBytes(id) : instruction),
	package: null,
	resources,
});
const localSkill = (id) => ({
	id,
	type: "instruction",
	delivery: "inject",
	name: id,
	nameSource: "frontmatter",
	description: `${id} description`,
	backing: blob(`instructions/${id}.md`, skillBytes(id)),
	package: null,
	resources: [resource(`skills.${id}`, `assets/${id}.bin`)],
	hostReference: null,
});
const shared = (p, bytes = instruction) => ({
	path: p,
	status: "captured",
	backing: blob(p, bytes),
	delivery: "host-controlled",
});
const changed = (p, before, after) => ({
	path: p,
	kind: "changed",
	before,
	after,
});
const added = (p, after) => ({ path: p, kind: "added", before: null, after });
const removed = (p, before) => ({
	path: p,
	kind: "removed",
	before,
	after: null,
});
const snapshotPath = (f, digest) =>
	path.join(f.storeRoot, "stamps/sha256", digest, "snapshot.json");
function rewrite(f, snapshot, domain) {
	const r = record(snapshot, domain);
	put(snapshotPath(f, r.digest), r.bytes);
	return { ...r, snapshot };
}
function report(f, stamp) {
	return stamps.verifyStamp({ digest: stamp.digest, storeRoot: f.storeRoot });
}
function healthy(f, stamp) {
	const r = report(f, stamp);
	assert.equal(r.snapshotIntegrity, "verified", r.findings.join("\n"));
	assert.equal(r.managedContent, "verified", r.findings.join("\n"));
	assert.equal(r.managedReconstruction, "verified");
	assert.equal(r.managedReproducible, true);
	assert.equal(r.completeRuntimeReproducible, false);
	return r;
}
function capture(f, extra = {}) {
	const s = stamps.createStamp({ ...f.options, ...extra }),
		r = record(s.snapshot);
	assert.equal(s.digest, r.digest);
	assert.deepEqual(fs.readFileSync(snapshotPath(f, s.digest)), r.bytes);
	healthy(f, s);
	const restored = stamps.reconstructStamp({
		digest: s.digest,
		storeRoot: f.storeRoot,
	});
	const raw = (backing) =>
		backing.type === "blob"
			? f.files.get(backing.path)
			: f.packages
					.get(backing.sha256)
					.files.find((e) => e.path === backing.path).bytes;
	for (const e of [
		...restored.composition,
		...restored.available.filter((e) => e.type === "instruction"),
		...restored.shared,
		...restored.hostReferences,
	]) {
		assert.deepEqual(e.bytes, e.backing ? raw(e.backing) : null);
	}
	for (const e of restored.resources) assert.deepEqual(e.bytes, raw(e.backing));
	for (const p of restored.packages)
		assert.deepEqual(p.files, f.packages.get(p.sha256).files);
	return s;
}
function golden() {
	return {
		stampVersion: 1,
		configurationVersion: 2,
		resolverContract: "agent-profiles/resolver/v2",
		selection: {
			host: "codex",
			identity: {
				raw: "small",
				canonical: "small",
				source: "user",
				matchedBy: "model",
			},
			family: null,
			familySource: null,
			profile: "base",
			role: "reviewer",
			roleSource: "default",
		},
		requested: [],
		composition: [
			layer("profile", "base", PROFILE, [
				resource("profiles.base", "assets/profile.bin"),
			]),
			layer("role", "reviewer", ROLE, [
				resource("roles.reviewer", "assets/role.bin"),
			]),
			layer("required-skill", "q", "instructions/q.md", [
				resource("skills.q", "assets/q.bin"),
			]),
		],
		required: [localSkill("q")],
		available: [localSkill("a"), localSkill("b")],
		packages: [],
		shared: [],
		hostReferences: [],
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
function packageInput(kind, version = "1.0.0", variant = "A", native = false) {
	const skill = kind === "skill",
		entrypoint = skill ? "SKILL.md" : "ENTRY.md";
	const behavior = {
		delivery: native ? "native" : "instruction",
		hosts: native ? ["claude", "codex"] : [],
		effects: [],
	};
	const manifest = {
		schema_version: 1,
		package: {
			name: `@diff/${kind}`,
			version,
			type: skill ? "skill" : "instruction",
		},
		entrypoint,
		behavior,
	};
	const files = [
		{ path: entrypoint, bytes: skill ? skillBytes("pack") : instruction },
		{
			path: "assets/data.bin",
			bytes: Buffer.from([0, variant === "A" ? 255 : 254]),
		},
		{ path: "package.yaml", bytes: Buffer.from(stringify(manifest)) },
	].sort((a, b) => compare(a.path, b.path));
	return { manifest, files, sha256: treeHash(files) };
}
function importInput(f, p, storeRoot = f.storeRoot) {
	const sourceDirectory = path.join(f.dir, "sources", p.sha256);
	for (const e of p.files) put(path.join(sourceDirectory, e.path), e.bytes);
	const r = importPackage({
		sourceDirectory,
		storeRoot,
		expectedDigest: p.sha256,
	});
	assert.equal(r.sha256, p.sha256);
	f.packages.set(p.sha256, p);
	return p;
}
function bind(f, kind, p) {
	if (kind === "profile") {
		f.config.profiles.base = {
			package: p.manifest.package.name,
			version: p.manifest.package.version,
		};
	} else if (kind === "role") {
		f.config.roles.reviewer = {
			package: p.manifest.package.name,
			version: p.manifest.package.version,
			skills: f.config.roles.reviewer.skills,
		};
	} else
		f.config.skills.q = {
			package: p.manifest.package.name,
			version: p.manifest.package.version,
		};
	if (kind !== "skill")
		fs.rmSync(
			path.join(
				f.root,
				kind === "profile" ? ".agent-profiles/profiles/base.md" : ROLE,
			),
			{ force: true },
		);
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
}
function immutableMerge(from, to) {
	for (const category of ["objects/sha256", "blobs/sha256", "stamps/sha256"]) {
		const source = path.join(from, category);
		if (!fs.existsSync(source)) continue;
		for (const id of fs.readdirSync(source)) {
			const target = path.join(to, category, id);
			if (fs.existsSync(target)) {
				if (fs.statSync(target).isDirectory())
					assert.deepEqual(
						fingerprint(path.join(source, id)),
						fingerprint(target),
					);
				else
					assert.deepEqual(
						fs.readFileSync(path.join(source, id)),
						fs.readFileSync(target),
					);
			} else {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.cpSync(path.join(source, id), target, { recursive: true });
			}
		}
	}
}
function result(f, a, b, rows, complete = true) {
	const beforeVerification = report(f, a),
		afterVerification = report(f, b),
		before = fingerprint(f.dir);
	const actual = stamps.diffStamps({
		before: a.digest,
		after: b.digest,
		storeRoot: f.storeRoot,
	});
	assert.deepEqual(actual, {
		complete,
		beforeVerification,
		afterVerification,
		changes: rows,
	});
	assert.deepEqual(fingerprint(f.dir), before, "comparison is read-only");
	assert.notStrictEqual(
		actual.beforeVerification,
		actual.afterVerification,
		"two independent reports even for equal digests",
	);
	return actual;
}
const cases = [];
function scenario(cid, name, prepare) {
	cases.push({ cid, name, prepare });
}

scenario("C17-01", "equal golden snapshot", (t) => {
	const f = fixture(t),
		a = capture(f);
	assert.deepEqual(a.snapshot, golden());
	return { f, a, b: a, rows: [] };
});
scenario(
	"C17-02",
	"relocated roots formatting and unused assignments preserve equality",
	(t) => {
		const f = fixture(t),
			p = importInput(f, packageInput("profile"));
		bind(f, "profile", p);
		const a = capture(f),
			root = path.join(f.dir, "relocated"),
			storeRoot = path.join(f.dir, "other-store");
		fs.cpSync(f.root, root, { recursive: true });
		fs.cpSync(f.storeRoot, storeRoot, { recursive: true });
		fs.rmSync(path.join(storeRoot, "stamps"), { recursive: true });
		const config = structuredClone(f.config);
		config.assignments = {
			unused: {
				when: { model: "other" },
				versions: { "profiles.base": "1.0.0" },
			},
		};
		put(
			path.join(root, CONFIG),
			"# changed formatting\n" + stringify(config, { sortMapEntries: true }),
		);
		installDependencies({ root, storeRoot });
		const b = capture(f, { root, storeRoot });
		immutableMerge(storeRoot, f.storeRoot);
		assert.equal(a.digest, b.digest);
		return { f, a, b, rows: [] };
	},
);
for (const [cid, name, extra, rows] of [
	[
		"C17-03",
		"raw alias retains canonical selection",
		{ model: "alias" },
		[
			changed("/selection/identity/matchedBy", "model", "alias"),
			changed("/selection/identity/raw", "small", "alias"),
		],
	],
	[
		"C17-04",
		"canonical model identity",
		{ model: "other" },
		[
			changed("/selection/identity/canonical", "small", "other"),
			changed("/selection/identity/raw", "small", "other"),
		],
	],
	[
		"C17-05",
		"identity source",
		{ identitySource: "host-stated" },
		[changed("/selection/identity/source", "user", "host-stated")],
	],
	[
		"C17-06",
		"host null is changed not removed",
		{ host: undefined },
		[changed("/selection/host", "codex", null)],
	],
	[
		"C17-07",
		"supported hermes host",
		{ host: "hermes" },
		[changed("/selection/host", "codex", "hermes")],
	],
	[
		"C17-08",
		"supplied family provenance",
		{ family: "family" },
		[
			changed("/selection/family", null, "family"),
			changed("/selection/familySource", null, "supplied"),
		],
	],
	[
		"C17-09",
		"prefix routing provenance",
		{ model: "family-new" },
		[
			changed("/selection/family", null, "family"),
			changed("/selection/familySource", null, "configured-prefix"),
			changed("/selection/identity/canonical", "small", null),
			changed("/selection/identity/matchedBy", "model", "family-prefix"),
			changed("/selection/identity/raw", "small", "family-new"),
		],
	],
	[
		"C17-09D",
		"unknown identity uses default routing",
		{ model: "unknown" },
		[
			changed("/selection/identity/canonical", "small", null),
			changed("/selection/identity/matchedBy", "model", "default"),
			changed("/selection/identity/raw", "small", "unknown"),
		],
	],
	[
		"C17-09F",
		"supplied family routes without model identity",
		{ model: undefined, family: "family" },
		[
			changed("/selection/family", null, "family"),
			changed("/selection/familySource", null, "supplied"),
			changed("/selection/identity/canonical", "small", null),
			changed("/selection/identity/matchedBy", "model", "family"),
			changed("/selection/identity/raw", "small", null),
			changed("/selection/identity/source", "user", null),
		],
	],
	[
		"C17-10",
		"explicit same role provenance",
		{ role: "reviewer" },
		[changed("/selection/roleSource", "default", "assigned")],
	],
])
	scenario(cid, name, (t) => {
		const f = fixture(t),
			a = capture(f),
			b = capture(f, extra);
		return { f, a, b, rows };
	});

for (const [cid, kind, index, file, binding, resourceFile] of [
	["C17-11", "profile", "0", PROFILE, "profiles.base", "assets/profile.bin"],
	["C17-12", "role", "1", ROLE, "roles.reviewer", "assets/role.bin"],
]) {
	scenario(cid, `${kind} identity with unchanged bytes`, (t) => {
		const f = fixture(t),
			a = capture(f);
		if (kind === "profile") {
			f.config.profiles.second = structuredClone(f.config.profiles.base);
			f.config.models.small.profile = "second";
		} else {
			f.config.roles.second = structuredClone(f.config.roles.reviewer);
			f.config.default_role = "second";
		}
		f.save();
		const b = capture(f);
		return {
			f,
			a,
			b,
			rows: [
				changed(
					index === "0" ? "/composition/0/id" : "/composition/1/id",
					kind === "profile" ? "base" : "reviewer",
					"second",
				),
				changed(
					index === "0"
						? "/composition/0/resources/0/binding"
						: "/composition/1/resources/0/binding",
					binding,
					kind === "profile" ? "profiles.second" : "roles.second",
				),
				changed(
					kind === "profile" ? "/selection/profile" : "/selection/role",
					kind === "profile" ? "base" : "reviewer",
					"second",
				),
			],
		};
	});
	scenario(`${cid}B`, `${kind} raw BOM CRLF bytes`, (t) => {
		const f = fixture(t),
			a = capture(f),
			next = Buffer.from("# Exact\n\n");
		f.write(file, next);
		const b = capture(f);
		return {
			f,
			a,
			b,
			rows: [
				changed(
					index === "0"
						? "/composition/0/backing/bytes"
						: "/composition/1/backing/bytes",
					instruction.length,
					next.length,
				),
				changed(
					index === "0"
						? "/composition/0/backing/sha256"
						: "/composition/1/backing/sha256",
					sha(instruction),
					sha(next),
				),
			],
		};
	});
	scenario(`${cid}R`, `${kind} qualified binary resource`, (t) => {
		const f = fixture(t),
			a = capture(f),
			next = Buffer.from([0, 254]);
		f.write(resourceFile, next);
		const b = capture(f);
		return {
			f,
			a,
			b,
			rows: [
				changed(
					index === "0"
						? "/composition/0/resources/0/backing/bytes"
						: "/composition/1/resources/0/backing/bytes",
					binary.length,
					next.length,
				),
				changed(
					index === "0"
						? "/composition/0/resources/0/backing/sha256"
						: "/composition/1/resources/0/backing/sha256",
					sha(binary),
					sha(next),
				),
			],
		};
	});
}
scenario("C17-13", "same hash different instruction path", (t) => {
	const f = fixture(t),
		a = capture(f);
	f.write(".agent-profiles/mapped/next.md", instruction);
	f.config.profiles.base.file = "mapped/next.md";
	f.save();
	const b = capture(f);
	return {
		f,
		a,
		b,
		rows: [
			changed(
				"/composition/0/backing/path",
				PROFILE,
				".agent-profiles/mapped/next.md",
			),
		],
	};
});
for (const [cid, id, prefixes, request] of [
	[
		"C17-14",
		"q",
		[
			"/composition/2/resources/0/backing/bytes",
			"/composition/2/resources/0/backing/sha256",
			"/required/0/resources/0/backing/bytes",
			"/required/0/resources/0/backing/sha256",
		],
		[],
	],
	[
		"C17-15",
		"a",
		[
			"/available/0/resources/0/backing/bytes",
			"/available/0/resources/0/backing/sha256",
			"/composition/3/resources/0/backing/bytes",
			"/composition/3/resources/0/backing/sha256",
		],
		["a"],
	],
	[
		"C17-16",
		"b",
		[
			"/available/1/resources/0/backing/bytes",
			"/available/1/resources/0/backing/sha256",
		],
		[],
	],
])
	scenario(cid, `${id} binary skill resource with qualified ownership`, (t) => {
		const f = fixture(t),
			a = capture(f, { skills: request }),
			next = Buffer.from([0, 253]);
		f.write(`assets/${id}.bin`, next);
		const b = capture(f, { skills: request });
		const rows = prefixes.map((p, i) =>
			changed(
				p,
				i % 2 ? sha(binary) : binary.length,
				i % 2 ? sha(next) : next.length,
			),
		);
		return { f, a, b, rows };
	});
scenario("C17-17", "unused available instruction bytes", (t) => {
	const f = fixture(t),
		a = capture(f),
		old = skillBytes("b"),
		next = Buffer.concat([old, Buffer.from("\r\n")]);
	f.write("instructions/b.md", next);
	const b = capture(f);
	assert.equal(
		b.snapshot.composition.some((e) => e.id === "b"),
		false,
	);
	return {
		f,
		a,
		b,
		rows: [
			changed("/available/1/backing/bytes", old.length, next.length),
			changed("/available/1/backing/sha256", sha(old), sha(next)),
		],
	};
});
scenario("C17-18", "resource declarations path sorted", (t) => {
	const f = fixture(t);
	f.write("assets/second.bin", Buffer.from("Z"));
	f.config.profiles.base.resources.push("assets/second.bin");
	f.save();
	const a = capture(f);
	f.config.profiles.base.resources.reverse();
	f.save();
	const b = capture(f);
	assert.deepEqual(a.snapshot.composition[0].resources, [
		resource("profiles.base", "assets/profile.bin"),
		resource("profiles.base", "assets/second.bin", Buffer.from("Z")),
	]);
	return { f, a, b, rows: [] };
});
scenario("C17-19", "request order swaps two IDs", (t) => {
	const f = fixture(t),
		a = capture(f, { skills: ["a", "b"] }),
		b = capture(f, { skills: ["b", "a"] });
	return {
		f,
		a,
		b,
		rows: [
			changed(
				"/composition/3/backing/path",
				"instructions/a.md",
				"instructions/b.md",
			),
			changed(
				"/composition/3/backing/sha256",
				sha(skillBytes("a")),
				sha(skillBytes("b")),
			),
			changed("/composition/3/id", "a", "b"),
			changed(
				"/composition/3/resources/0/backing/path",
				"assets/a.bin",
				"assets/b.bin",
			),
			changed("/composition/3/resources/0/binding", "skills.a", "skills.b"),
			changed(
				"/composition/4/backing/path",
				"instructions/b.md",
				"instructions/a.md",
			),
			changed(
				"/composition/4/backing/sha256",
				sha(skillBytes("b")),
				sha(skillBytes("a")),
			),
			changed("/composition/4/id", "b", "a"),
			changed(
				"/composition/4/resources/0/backing/path",
				"assets/b.bin",
				"assets/a.bin",
			),
			changed("/composition/4/resources/0/binding", "skills.b", "skills.a"),
			changed("/requested/0", "a", "b"),
			changed("/requested/1", "b", "a"),
		],
	};
});
scenario("C17-20", "required order swaps two IDs", (t) => {
	const f = fixture(t);
	f.config.roles.reviewer.skills = { required: ["a", "b"], available: ["q"] };
	f.save();
	const a = capture(f);
	f.config.roles.reviewer.skills.required.reverse();
	f.save();
	const b = capture(f);
	const rows = [
		changed(
			"/composition/2/backing/path",
			"instructions/a.md",
			"instructions/b.md",
		),
		changed(
			"/composition/2/backing/sha256",
			sha(skillBytes("a")),
			sha(skillBytes("b")),
		),
		changed("/composition/2/id", "a", "b"),
		changed(
			"/composition/2/resources/0/backing/path",
			"assets/a.bin",
			"assets/b.bin",
		),
		changed("/composition/2/resources/0/binding", "skills.a", "skills.b"),
		changed(
			"/composition/3/backing/path",
			"instructions/b.md",
			"instructions/a.md",
		),
		changed(
			"/composition/3/backing/sha256",
			sha(skillBytes("b")),
			sha(skillBytes("a")),
		),
		changed("/composition/3/id", "b", "a"),
		changed(
			"/composition/3/resources/0/backing/path",
			"assets/b.bin",
			"assets/a.bin",
		),
		changed("/composition/3/resources/0/binding", "skills.b", "skills.a"),
		changed(
			"/required/0/backing/path",
			"instructions/a.md",
			"instructions/b.md",
		),
		changed(
			"/required/0/backing/sha256",
			sha(skillBytes("a")),
			sha(skillBytes("b")),
		),
		changed("/required/0/description", "a description", "b description"),
		changed("/required/0/id", "a", "b"),
		changed("/required/0/name", "a", "b"),
		changed(
			"/required/0/resources/0/backing/path",
			"assets/a.bin",
			"assets/b.bin",
		),
		changed("/required/0/resources/0/binding", "skills.a", "skills.b"),
		changed(
			"/required/1/backing/path",
			"instructions/b.md",
			"instructions/a.md",
		),
		changed(
			"/required/1/backing/sha256",
			sha(skillBytes("b")),
			sha(skillBytes("a")),
		),
		changed("/required/1/description", "b description", "a description"),
		changed("/required/1/id", "b", "a"),
		changed("/required/1/name", "b", "a"),
		changed(
			"/required/1/resources/0/backing/path",
			"assets/b.bin",
			"assets/a.bin",
		),
		changed("/required/1/resources/0/binding", "skills.b", "skills.a"),
	];
	return { f, a, b, rows };
});
scenario("C17-21", "available order swaps two IDs", (t) => {
	const f = fixture(t),
		a = capture(f);
	f.config.roles.reviewer.skills.available.reverse();
	f.save();
	const b = capture(f);
	return {
		f,
		a,
		b,
		rows: [
			changed(
				"/available/0/backing/path",
				"instructions/a.md",
				"instructions/b.md",
			),
			changed(
				"/available/0/backing/sha256",
				sha(skillBytes("a")),
				sha(skillBytes("b")),
			),
			changed("/available/0/description", "a description", "b description"),
			changed("/available/0/id", "a", "b"),
			changed("/available/0/name", "a", "b"),
			changed(
				"/available/0/resources/0/backing/path",
				"assets/a.bin",
				"assets/b.bin",
			),
			changed("/available/0/resources/0/binding", "skills.a", "skills.b"),
			changed(
				"/available/1/backing/path",
				"instructions/b.md",
				"instructions/a.md",
			),
			changed(
				"/available/1/backing/sha256",
				sha(skillBytes("b")),
				sha(skillBytes("a")),
			),
			changed("/available/1/description", "b description", "a description"),
			changed("/available/1/id", "b", "a"),
			changed("/available/1/name", "b", "a"),
			changed(
				"/available/1/resources/0/backing/path",
				"assets/b.bin",
				"assets/a.bin",
			),
			changed("/available/1/resources/0/binding", "skills.b", "skills.a"),
		],
	};
});
scenario("C17-22", "requested tail whole member add", (t) => {
	const f = fixture(t),
		a = capture(f),
		b = capture(f, { skills: ["a"] });
	return {
		f,
		a,
		b,
		rows: [
			added(
				"/composition/3",
				layer("requested-skill", "a", "instructions/a.md", [
					resource("skills.a", "assets/a.bin"),
				]),
			),
			added("/requested/0", "a"),
		],
	};
});
scenario("C17-23", "available tail whole member remove", (t) => {
	const f = fixture(t),
		a = capture(f);
	f.config.roles.reviewer.skills.available.pop();
	f.save();
	const b = capture(f);
	return { f, a, b, rows: [removed("/available/1", localSkill("b"))] };
});
scenario("C17-23R", "resource tail whole member add", (t) => {
	const f = fixture(t),
		a = capture(f);
	f.write("assets/z.bin", Buffer.from("Z"));
	f.config.profiles.base.resources.push("assets/z.bin");
	f.save();
	const b = capture(f);
	return {
		f,
		a,
		b,
		rows: [
			added(
				"/composition/0/resources/1",
				resource("profiles.base", "assets/z.bin", Buffer.from("Z")),
			),
		],
	};
});
scenario("C17-23P", "same binary digest different resource path", (t) => {
	const f = fixture(t),
		a = capture(f);
	f.write("assets/renamed.bin", binary);
	f.config.profiles.base.resources = ["assets/renamed.bin"];
	f.save();
	const b = capture(f);
	return {
		f,
		a,
		b,
		rows: [
			changed(
				"/composition/0/resources/0/backing/path",
				"assets/profile.bin",
				"assets/renamed.bin",
			),
		],
	};
});

for (const [cid, kind, binding, entryPaths, hashPaths, versionPaths] of [
	[
		"C17-24",
		"profile",
		"profiles.base",
		[
			"/composition/0/package/selectedBy",
			"/composition/0/package/selectors/model",
		],
		[
			"/composition/0/backing/sha256",
			"/composition/0/package/sha256",
			"/packages/0/sha256",
		],
		["/composition/0/package/version", "/packages/0/version"],
	],
	[
		"C17-25",
		"role",
		"roles.reviewer",
		[
			"/composition/1/package/selectedBy",
			"/composition/1/package/selectors/model",
		],
		[
			"/composition/1/backing/sha256",
			"/composition/1/package/sha256",
			"/packages/0/sha256",
		],
		["/composition/1/package/version", "/packages/0/version"],
	],
	[
		"C17-26",
		"skill",
		"skills.q",
		[
			"/composition/2/package/selectedBy",
			"/composition/2/package/selectors/model",
			"/required/0/package/selectedBy",
			"/required/0/package/selectors/model",
		],
		[
			"/composition/2/backing/sha256",
			"/composition/2/package/sha256",
			"/packages/0/sha256",
			"/required/0/backing/sha256",
			"/required/0/package/sha256",
		],
		[
			"/composition/2/package/version",
			"/packages/0/version",
			"/required/0/package/version",
		],
	],
]) {
	scenario(`${cid}A`, `${kind} base to same-byte rule selectors`, (t) => {
		const f = fixture(t),
			p = importInput(f, packageInput(kind));
		bind(f, kind, p);
		const a = capture(f);
		f.config.assignments = {
			"pin-a": { when: { model: "small" }, versions: { [binding]: "1.0.0" } },
		};
		f.save();
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		const b = capture(f);
		return {
			f,
			a,
			b,
			rows: entryPaths.map((p, i) =>
				i % 2 ? added(p, "small") : changed(p, "binding-default", "pin-a"),
			),
		};
	});
	scenario(
		`${cid}B`,
		`${kind} rule names retain identical package bytes`,
		(t) => {
			const f = fixture(t),
				p = importInput(f, packageInput(kind));
			bind(f, kind, p);
			f.config.assignments = {
				"pin-a": { when: { model: "small" }, versions: { [binding]: "1.0.0" } },
			};
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			const a = capture(f);
			f.config.assignments["pin-b"] = f.config.assignments["pin-a"];
			delete f.config.assignments["pin-a"];
			f.save();
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
			const b = capture(f);
			return {
				f,
				a,
				b,
				rows: entryPaths
					.filter((_, i) => i % 2 === 0)
					.map((p) => changed(p, "pin-a", "pin-b")),
			};
		},
	);
	scenario(`${cid}V`, `${kind} selected release and digest`, (t) => {
		const f = fixture(t),
			p = importInput(f, packageInput(kind)),
			next = importInput(f, packageInput(kind, "2.0.0"));
		bind(f, kind, p);
		const a = capture(f);
		bind(f, kind, next);
		const b = capture(f);
		const rows = [
			changed(hashPaths[0], p.sha256, next.sha256),
			changed(hashPaths[1], p.sha256, next.sha256),
			changed(versionPaths[0], "1.0.0", "2.0.0"),
			changed(hashPaths[2], p.sha256, next.sha256),
			changed(versionPaths[1], "1.0.0", "2.0.0"),
		];
		if (kind === "skill")
			rows.push(
				changed(hashPaths[3], p.sha256, next.sha256),
				changed(hashPaths[4], p.sha256, next.sha256),
				changed(versionPaths[2], "1.0.0", "2.0.0"),
			);
		return { f, a, b, rows };
	});
	scenario(
		`${cid}D`,
		`${kind} same version distinct verified orphan tree`,
		(t) => {
			const f = fixture(t),
				p = importInput(f, packageInput(kind));
			bind(f, kind, p);
			const a = capture(f);
			const second = fixture(t),
				next = importInput(second, packageInput(kind, "1.0.0", "B"));
			bind(second, kind, next);
			const b = capture(second);
			const identity = {
				name: p.manifest.package.name,
				version: "1.0.0",
				storeRoot: f.storeRoot,
			};
			assert.equal(lookupPackage(identity).sha256, p.sha256);
			immutableMerge(second.storeRoot, f.storeRoot);
			f.packages.set(next.sha256, next);
			assert.equal(
				lookupPackage(identity).sha256,
				p.sha256,
				"immutable merge must retain A identity mapping",
			);
			healthy(f, a);
			healthy(f, b);
			assert.deepEqual(
				stamps.reconstructStamp({ digest: b.digest, storeRoot: f.storeRoot })
					.packages[0].files,
				next.files,
			);
			return {
				f,
				a,
				b,
				rows: hashPaths.map((pth) => changed(pth, p.sha256, next.sha256)),
			};
		},
	);
}
scenario(
	"C17-27",
	"package behavior and entrypoint change with verified asset closure",
	(t) => {
		const f = fixture(t),
			p = importInput(f, packageInput("profile"));
		bind(f, "profile", p);
		const a = capture(f);
		const second = fixture(t),
			next = packageInput("profile", "1.0.0", "B");
		next.manifest.entrypoint = "NEXT.md";
		next.manifest.behavior.effects = ["external-references"];
		next.files.find((e) => e.path === "ENTRY.md").path = "NEXT.md";
		next.files.find((e) => e.path === "NEXT.md").bytes =
			Buffer.from("# Other entry\n");
		next.files.find((e) => e.path === "package.yaml").bytes = Buffer.from(
			stringify(next.manifest),
		);
		next.files.sort((a, b) => compare(a.path, b.path));
		next.sha256 = treeHash(next.files);
		importInput(second, next);
		bind(second, "profile", next);
		const b = capture(second);
		immutableMerge(second.storeRoot, f.storeRoot);
		f.packages.set(next.sha256, next);
		healthy(f, a);
		healthy(f, b);
		return {
			f,
			a,
			b,
			rows: [
				changed("/composition/0/backing/path", "ENTRY.md", "NEXT.md"),
				changed("/composition/0/backing/sha256", p.sha256, next.sha256),
				changed("/composition/0/package/sha256", p.sha256, next.sha256),
				added("/packages/0/behavior/effects/0", "external-references"),
				changed("/packages/0/sha256", p.sha256, next.sha256),
			],
		};
	},
);
scenario("C17-28", "shared raw AGENTS bytes", (t) => {
	const f = fixture(t),
		a = capture(f, { sharedFiles: ["AGENTS.md"] }),
		next = Buffer.from("# Exact\n\n");
	f.write("AGENTS.md", next);
	const b = capture(f, { sharedFiles: ["AGENTS.md"] });
	return {
		f,
		a,
		b,
		rows: [
			changed("/shared/0/backing/bytes", instruction.length, next.length),
			changed("/shared/0/backing/sha256", sha(instruction), sha(next)),
		],
	};
});
scenario("C17-29", "explicit shared order", (t) => {
	const f = fixture(t),
		a = capture(f, { sharedFiles: ["AGENTS.md", "shared/second.md"] }),
		b = capture(f, { sharedFiles: ["shared/second.md", "AGENTS.md"] });
	const second = Buffer.from("Second\n");
	return {
		f,
		a,
		b,
		rows: [
			changed("/shared/0/backing/bytes", instruction.length, second.length),
			changed("/shared/0/backing/path", "AGENTS.md", "shared/second.md"),
			changed("/shared/0/backing/sha256", sha(instruction), sha(second)),
			changed("/shared/0/path", "AGENTS.md", "shared/second.md"),
			changed("/shared/1/backing/bytes", second.length, instruction.length),
			changed("/shared/1/backing/path", "shared/second.md", "AGENTS.md"),
			changed("/shared/1/backing/sha256", sha(second), sha(instruction)),
			changed("/shared/1/path", "shared/second.md", "AGENTS.md"),
		],
	};
});
scenario("C17-30", "default shared captured to absent", (t) => {
	const f = fixture(t),
		a = capture(f, { sharedFiles: undefined });
	fs.unlinkSync(path.join(f.root, "AGENTS.md"));
	const b = capture(f, { sharedFiles: undefined });
	return {
		f,
		a,
		b,
		rows: [
			changed("/shared/0/backing", blob("AGENTS.md", instruction), null),
			changed("/shared/0/status", "captured", "absent"),
		],
	};
});
scenario("C17-31", "default shared absent to unobserved", (t) => {
	const f = fixture(t);
	fs.unlinkSync(path.join(f.root, "AGENTS.md"));
	const a = capture(f, { sharedFiles: undefined });
	f.write("AGENTS.md", instruction);
	let hits = 0;
	const guard =
		(read) =>
		(file, ...args) => {
			if (
				typeof file === "string" &&
				path.resolve(file) === path.join(f.root, "AGENTS.md")
			) {
				hits++;
				throw Object.assign(new Error("owned shared EACCES"), {
					code: "EACCES",
				});
			}
			return read(file, ...args);
		};
	const b = intercept({ openSync: guard, readFileSync: guard }, () =>
		capture(f, { sharedFiles: undefined }),
	);
	assert.ok(hits > 0);
	assert.equal(b.snapshot.shared[0].status, "unobserved");
	return {
		f,
		a,
		b,
		rows: [changed("/shared/0/status", "absent", "unobserved")],
	};
});
scenario("C17-32", "numeric array tails remain depth first", (t) => {
	const f = fixture(t),
		names = [
			"shared/f00.md",
			"shared/f01.md",
			"shared/f02.md",
			"shared/f03.md",
			"shared/f04.md",
			"shared/f05.md",
			"shared/f06.md",
			"shared/f07.md",
			"shared/f08.md",
			"shared/f09.md",
			"shared/f10.md",
			"shared/f11.md",
			"shared/f12.md",
		];
	for (const name of names) f.write(name, instruction);
	const a = capture(f, { sharedFiles: names.slice(0, 2) }),
		b = capture(f, { sharedFiles: names });
	return {
		f,
		a,
		b,
		rows: [
			added("/shared/2", shared("shared/f02.md")),
			added("/shared/3", shared("shared/f03.md")),
			added("/shared/4", shared("shared/f04.md")),
			added("/shared/5", shared("shared/f05.md")),
			added("/shared/6", shared("shared/f06.md")),
			added("/shared/7", shared("shared/f07.md")),
			added("/shared/8", shared("shared/f08.md")),
			added("/shared/9", shared("shared/f09.md")),
			added("/shared/10", shared("shared/f10.md")),
			added("/shared/11", shared("shared/f11.md")),
			added("/shared/12", shared("shared/f12.md")),
		],
	};
});

function native(f, scope, requirement = "available", host = "claude") {
	const hostId = scope === "plugin" ? "kit:native" : "native";
	f.config.skills.native = { host, scope, id: hostId };
	f.config.roles.reviewer.skills[requirement].push("native");
	f.save();
	if (scope === "project")
		f.write(".claude/skills/native/SKILL.md", skillBytes("native"));
	return {
		id: "native",
		type: "host",
		delivery: "invoke",
		name: scope === "project" ? "native" : hostId,
		nameSource: scope === "project" ? "frontmatter" : "host",
		description: scope === "project" ? "native description" : null,
		backing:
			scope === "project"
				? blob(".claude/skills/native/SKILL.md", skillBytes("native"))
				: null,
		package: null,
		resources: [],
		hostReference: "skills.native",
	};
}
function nativeReference(
	scope,
	requirement = "available",
	host = "claude",
	selectedHost = "codex",
) {
	return {
		key: "skills.native",
		id: "native",
		host,
		scope,
		hostId: scope === "plugin" ? "kit:native" : "native",
		requirement,
		compatibility: host === selectedHost,
		observation:
			scope === "project" ? "captured-file" : "host-provided-unverified",
		backing:
			scope === "project"
				? blob(".claude/skills/native/SKILL.md", skillBytes("native"))
				: null,
		invocation: "unverified",
		rendered: "unverified",
		supportedHosts: [host],
	};
}
for (const [cid, scope] of [
	["C17-33", "user"],
	["C17-34", "plugin"],
	["C17-35", "project"],
])
	scenario(cid, `${scope} native reference addition`, (t) => {
		const f = fixture(t),
			a = capture(f),
			expected = native(f, scope),
			b = capture(f);
		assert.deepEqual(b.snapshot.available[2], expected);
		assert.deepEqual(b.snapshot.hostReferences[0], nativeReference(scope));
		const r = healthy(f, b);
		assert.equal(r.declaredHostDependenciesSatisfied, true);
		assert.deepEqual(r.findings, [
			"Host dependencies and native invocation remain unverified",
		]);
		return {
			f,
			a,
			b,
			rows: [
				added("/available/2", expected),
				added("/hostReferences/0", nativeReference(scope)),
			],
		};
	});
scenario(
	"C17-36",
	"required incompatible native remains managed complete",
	(t) => {
		const f = fixture(t);
		native(f, "user", "available");
		const a = capture(f);
		f.config.roles.reviewer.skills.available.pop();
		f.config.roles.reviewer.skills.required.push("native");
		f.save();
		const b = capture(f);
		const r = healthy(f, b);
		assert.equal(r.declaredHostDependenciesSatisfied, false);
		assert.equal(r.hostDependencies, "unverified");
		return {
			f,
			a,
			b,
			rows: [
				removed("/available/2", {
					id: "native",
					type: "host",
					delivery: "invoke",
					name: "native",
					nameSource: "host",
					description: null,
					backing: null,
					package: null,
					resources: [],
					hostReference: "skills.native",
				}),
				changed("/hostReferences/0/requirement", "available", "required"),
				added("/required/1", {
					id: "native",
					type: "host",
					delivery: "invoke",
					name: "native",
					nameSource: "host",
					description: null,
					backing: null,
					package: null,
					resources: [],
					hostReference: "skills.native",
				}),
			],
		};
	},
);
scenario(
	"C17-37",
	"native compatibility follows supported host without readiness claim",
	(t) => {
		const f = fixture(t);
		native(f, "user", "required");
		const a = capture(f),
			b = capture(f, { host: "claude" });
		assert.equal(
			integrations.some(
				(e) => e.id === "claude" && e.skills.user.id.test("native"),
			),
			true,
		);
		assert.equal(
			integrations.some((e) => e.id === "codex"),
			true,
		);
		assert.equal(b.snapshot.hostReferences[0].compatibility, true);
		assert.equal(healthy(f, b).declaredHostDependenciesSatisfied, false);
		return {
			f,
			a,
			b,
			rows: [
				changed("/hostReferences/0/compatibility", false, true),
				changed("/selection/host", "codex", "claude"),
			],
		};
	},
);
scenario(
	"C17-38",
	"package native verified bytes still unverified invocation",
	(t) => {
		const f = fixture(t),
			p = importInput(f, packageInput("skill", "1.0.0", "A", true));
		bind(f, "skill", p);
		const a = capture(f);
		const b = capture(f, { host: "hermes" });
		assert.equal(a.snapshot.required[0].type, "host");
		assert.equal(a.snapshot.hostReferences[0].scope, "package");
		assert.deepEqual(p.manifest.behavior.hosts, ["claude", "codex"]);
		assert.equal(
			integrations.some((e) => e.id === "hermes"),
			true,
		);
		assert.equal(a.snapshot.hostReferences[0].compatibility, true);
		assert.equal(b.snapshot.hostReferences[0].compatibility, false);
		for (const s of [a, b]) {
			const r = healthy(f, s);
			assert.equal(r.declaredHostDependenciesSatisfied, false);
			assert.equal(r.hostInvocation, "unverified");
		}
		return {
			f,
			a,
			b,
			rows: [
				changed("/hostReferences/0/compatibility", true, false),
				changed("/hostReferences/0/host", "codex", "hermes"),
				changed("/selection/host", "codex", "hermes"),
			],
		};
	},
);

scenario("C17-39", "two available user native references reorder", (t) => {
	const f = fixture(t),
		first = native(f, "user");
	const adapter = integrations.find((e) => e.id === "claude");
	assert.equal(adapter.skills.user.id.test("native"), true);
	assert.equal(adapter.skills.user.id.test("personal"), true);
	f.config.skills.personal = { host: "claude", scope: "user", id: "personal" };
	f.config.roles.reviewer.skills.available.push("personal");
	f.save();
	const a = capture(f);
	const personal = {
		id: "personal",
		type: "host",
		delivery: "invoke",
		name: "personal",
		nameSource: "host",
		description: null,
		backing: null,
		package: null,
		resources: [],
		hostReference: "skills.personal",
	};
	const personalReference = {
		key: "skills.personal",
		id: "personal",
		host: "claude",
		scope: "user",
		hostId: "personal",
		requirement: "available",
		compatibility: false,
		observation: "host-provided-unverified",
		backing: null,
		invocation: "unverified",
		rendered: "unverified",
		supportedHosts: ["claude"],
	};
	assert.deepEqual(a.snapshot.available.slice(2), [first, personal]);
	assert.deepEqual(a.snapshot.hostReferences, [
		nativeReference("user"),
		personalReference,
	]);
	f.config.roles.reviewer.skills.available = ["a", "b", "personal", "native"];
	f.save();
	const b = capture(f);
	assert.deepEqual(b.snapshot.available.slice(2), [personal, first]);
	assert.deepEqual(b.snapshot.hostReferences, [
		personalReference,
		nativeReference("user"),
	]);
	for (const s of [a, b]) {
		const r = healthy(f, s),
			restored = stamps.reconstructStamp({
				digest: s.digest,
				storeRoot: f.storeRoot,
			});
		assert.deepEqual(
			restored.available.slice(2),
			s === a ? [first, personal] : [personal, first],
		);
		assert.equal(r.hostDependencies, "unverified");
		assert.equal(r.hostInvocation, "unverified");
		assert.equal(r.runtimeIdentity, "unverified");
		assert.equal(r.renderedPrompt, "unverified");
		assert.equal(r.declaredHostDependenciesSatisfied, true);
		assert.equal(r.completeRuntimeReproducible, false);
		assert.deepEqual(r.findings, [
			"Host dependencies and native invocation remain unverified",
		]);
	}
	return {
		f,
		a,
		b,
		rows: [
			changed("/available/2/hostReference", "skills.native", "skills.personal"),
			changed("/available/2/id", "native", "personal"),
			changed("/available/2/name", "native", "personal"),
			changed("/available/3/hostReference", "skills.personal", "skills.native"),
			changed("/available/3/id", "personal", "native"),
			changed("/available/3/name", "personal", "native"),
			changed("/hostReferences/0/hostId", "native", "personal"),
			changed("/hostReferences/0/id", "native", "personal"),
			changed("/hostReferences/0/key", "skills.native", "skills.personal"),
			changed("/hostReferences/1/hostId", "personal", "native"),
			changed("/hostReferences/1/id", "personal", "native"),
			changed("/hostReferences/1/key", "skills.personal", "skills.native"),
		],
	};
});

test("C17-API namespace exports diffStamps", () => {
	assert.equal(typeof stamps.diffStamps, "function");
});
for (const c of cases) {
	test(`${c.cid} fixture ${c.name}`, (t) => {
		const { f, a, b, rows } = c.prepare(t);
		healthy(f, a);
		healthy(f, b);
		assert.equal(a.digest === b.digest, rows.length === 0);
		assert.deepEqual(record(a.snapshot).digest, a.digest);
		assert.deepEqual(record(b.snapshot).digest, b.digest);
	});
	test(`${c.cid} diff ${c.name}`, {
		skip:
			typeof stamps.diffStamps !== "function"
				? "blocked: src/stamps.js does not export diffStamps"
				: false,
	}, (t) => {
		const { f, a, b, rows } = c.prepare(t);
		result(f, a, b, rows);
		// Reverse comparison covers removal, null placeholders and the same numeric traversal.
		const reverse = rows.map((r) => ({
			path: r.path,
			kind:
				r.kind === "added"
					? "removed"
					: r.kind === "removed"
						? "added"
						: "changed",
			before: r.after,
			after: r.before,
		}));
		result(f, b, a, reverse);
	});
}

const damageCases = [
	[
		"C17-40",
		"missing snapshot",
		"snapshotIntegrity",
		"missing",
		/snapshot: .*ENOENT/,
	],
	[
		"C17-41",
		"noncanonical snapshot",
		"snapshotIntegrity",
		"mismatched",
		/^snapshot: snapshot: noncanonical encoding$/,
	],
	[
		"C17-42",
		"wrong domain",
		"snapshotIntegrity",
		"mismatched",
		/^snapshot: snapshot: digest\/domain mismatch$/,
	],
	[
		"C17-43",
		"unknown schema field",
		"snapshotIntegrity",
		"mismatched",
		/^snapshot: snapshot\.foreign: unknown field$/,
	],
	[
		"C17-44",
		"rehashed resource ownership relation",
		"snapshotIntegrity",
		"mismatched",
		/^snapshot: composition\.profile: resources binding owner\/path mismatch$/,
	],
	[
		"C17-45",
		"missing blob",
		"managedContent",
		"missing",
		/ENOENT.*blobs|blobs.*ENOENT/,
	],
	[
		"C17-46",
		"changed blob",
		"managedContent",
		"mismatched",
		/^blob: bytes length\/digest mismatch [0-9a-f]{64}$/,
	],
	[
		"C17-47",
		"wrong recorded length",
		"managedContent",
		"mismatched",
		/^blob: bytes length\/digest mismatch [0-9a-f]{64}$/,
	],
	[
		"C17-48",
		"missing tree",
		"managedContent",
		"missing",
		/ENOENT.*tree|tree.*ENOENT/,
	],
	[
		"C17-49",
		"extra package asset",
		"managedContent",
		"mismatched",
		/^object: digest mismatch [0-9a-f]{64}$/,
	],
	[
		"C17-50",
		"changed package asset",
		"managedContent",
		"mismatched",
		/^object: digest mismatch [0-9a-f]{64}$/,
	],
	[
		"C17-51",
		"rehashed manifest entrypoint relation",
		"snapshotIntegrity",
		"mismatched",
		/^snapshot relation composition\.entrypoint: manifest entrypoint disagreement$/,
	],
];
function damaged(t, mode) {
	const f = fixture(t);
	if (
		[
			"missing tree",
			"extra package asset",
			"changed package asset",
			"rehashed manifest entrypoint relation",
		].includes(mode)
	) {
		bind(f, "profile", importInput(f, packageInput("profile")));
	}
	const original = capture(f),
		clean = fixture(t),
		healthyStamp = capture(clean);
	immutableMerge(clean.storeRoot, f.storeRoot);
	const s = structuredClone(original.snapshot);
	let bad = original;
	const backing = s.available[1].resources[0].backing;
	const blobFile = path.join(f.storeRoot, "blobs/sha256", backing.sha256);
	const tree = s.packages.length
		? path.join(f.storeRoot, "objects/sha256", s.packages[0].sha256, "tree")
		: null;
	// Make a distinct bad snapshot first, so a healthy same-content control keeps its RECORD.
	s.selection.identity.source = "host-stated";
	bad = rewrite(f, s);
	healthy(f, bad);
	if (mode === "missing snapshot") fs.unlinkSync(snapshotPath(f, bad.digest));
	if (mode === "noncanonical snapshot")
		fs.appendFileSync(snapshotPath(f, bad.digest), "\n");
	if (mode === "wrong domain") bad = rewrite(f, s, "agent-profiles/lock/v1");
	if (mode === "unknown schema field") {
		s.foreign = true;
		bad = rewrite(f, s);
	}
	if (mode === "rehashed resource ownership relation") {
		s.composition[0].resources[0].binding = "roles.reviewer";
		bad = rewrite(f, s);
	}
	if (mode === "wrong recorded length") {
		s.available[1].resources[0].backing.bytes++;
		bad = rewrite(f, s);
	}
	// All fixture resources initially share bytes. Give the bad record its own blob first.
	if (mode === "missing blob" || mode === "changed blob") {
		const own = Buffer.from([0, 252, 13]);
		s.available[1].resources[0].backing = blob("assets/b.bin", own);
		put(path.join(f.storeRoot, "blobs/sha256", sha(own)), own);
		bad = rewrite(f, s);
		healthy(f, bad);
		const target = path.join(f.storeRoot, "blobs/sha256", sha(own));
		if (mode === "missing blob") fs.unlinkSync(target);
		else put(target, Buffer.from([0, 251, 13]));
	}
	if (mode === "missing tree") fs.rmSync(tree, { recursive: true });
	if (mode === "extra package asset")
		put(path.join(tree, "extra.bin"), Buffer.from([0]));
	if (mode === "changed package asset")
		put(path.join(tree, "assets/data.bin"), Buffer.from([0, 254]));
	if (mode === "rehashed manifest entrypoint relation") {
		s.composition[0].backing.path = "package.yaml";
		bad = rewrite(f, s);
	}
	assert.equal(
		fs.existsSync(blobFile),
		true,
		"unrelated original binary blob remains",
	);
	return { f, a: bad, b: healthyStamp };
}
function invalidReport(f, stamp, field, status, diagnostic) {
	const r = report(f, stamp);
	assert.equal(r[field], status, r.findings.join("\n"));
	assert.equal(r.managedReproducible, false);
	assert.notEqual(r.managedReconstruction, "verified");
	assert.equal(r.completeRuntimeReproducible, false);
	assert.equal(r.findings.length, 1);
	assert.match(r.findings[0], diagnostic);
	return r;
}
for (const [cid, name, field, status, diagnostic] of damageCases) {
	test(`${cid} fixture ${name}`, (t) => {
		const { f, a, b } = damaged(t, name),
			before = fingerprint(f.dir);
		invalidReport(f, a, field, status, diagnostic);
		healthy(f, b);
		assert.throws(
			() =>
				stamps.reconstructStamp({ digest: a.digest, storeRoot: f.storeRoot }),
			/reconstruction:/,
		);
		assert.deepEqual(fingerprint(f.dir), before);
	});
	for (const direction of ["before", "after", "equal"])
		test(`${cid} diff ${name} ${direction}`, {
			skip:
				typeof stamps.diffStamps !== "function"
					? "blocked: src/stamps.js does not export diffStamps"
					: false,
		}, (t) => {
			const { f, a, b } = damaged(t, name);
			invalidReport(f, a, field, status, diagnostic);
			healthy(f, b);
			result(
				f,
				direction === "after" ? b : a,
				direction === "before" ? b : a,
				[],
				false,
			);
			result(f, b, b, []);
			invalidReport(f, a, field, status, diagnostic);
		});
}
test("C17-52 fixture both invalid reports have distinct findings", (t) => {
	const first = damaged(t, "missing snapshot"),
		second = damaged(t, "rehashed resource ownership relation");
	put(
		snapshotPath(first.f, second.a.digest),
		fs.readFileSync(snapshotPath(second.f, second.a.digest)),
	);
	invalidReport(first.f, first.a, "snapshotIntegrity", "missing", /ENOENT/);
	invalidReport(
		first.f,
		second.a,
		"snapshotIntegrity",
		"mismatched",
		/resources binding owner\/path mismatch/,
	);
});
test("C17-52 diff both invalid reports have distinct findings", {
	skip:
		typeof stamps.diffStamps !== "function"
			? "blocked: src/stamps.js does not export diffStamps"
			: false,
}, (t) => {
	const first = damaged(t, "missing snapshot"),
		second = damaged(t, "rehashed resource ownership relation");
	put(
		snapshotPath(first.f, second.a.digest),
		fs.readFileSync(snapshotPath(second.f, second.a.digest)),
	);
	const r = result(first.f, first.a, second.a, [], false);
	assert.equal(r.beforeVerification.snapshotIntegrity, "missing");
	assert.equal(r.afterVerification.snapshotIntegrity, "mismatched");
	assert.notDeepEqual(
		r.beforeVerification.findings,
		r.afterVerification.findings,
	);
});

function readGuard(f, observations) {
	const root = path.resolve(f.root),
		store = path.resolve(f.storeRoot);
	return (read) =>
		(file, ...args) => {
			if (typeof file === "string") {
				const full = path.resolve(file);
				if (full === root || full.startsWith(root + path.sep))
					throw new Error("forbidden mutable project read");
				if (full === store || full.startsWith(store + path.sep))
					observations.push(full);
			}
			return read(file, ...args);
		};
}
test("C17-53 fixture immutable read interception and raw oracle controls", (t) => {
	assert.equal(
		canonical({ z: "\n", a: [0, true, null] }),
		'{"a":[0,true,null],"z":"\\u000a"}',
	);
	assert.deepEqual(["\u{10000}", "\ue000", "a"].sort(compare), [
		"a",
		"\ue000",
		"\u{10000}",
	]);
	const f = fixture(t);
	bind(f, "profile", importInput(f, packageInput("profile")));
	const a = capture(f);
	const stable = fingerprint(f.root);
	f.write("owned-control.bin", Buffer.from([0]));
	assert.notDeepEqual(fingerprint(f.root), stable);
	fs.unlinkSync(path.join(f.root, "owned-control.bin"));
	assert.deepEqual(fingerprint(f.root), stable);
	const before = fingerprint(f.dir),
		seen = [],
		guard = readGuard(f, seen);
	intercept({ openSync: guard, readFileSync: guard }, () => {
		assert.throws(
			() => fs.readFileSync(path.join(f.root, CONFIG)),
			/^Error: forbidden mutable project read$/,
		);
		healthy(f, a);
		stamps.reconstructStamp({ digest: a.digest, storeRoot: f.storeRoot });
	});
	assert.ok(seen.includes(snapshotPath(f, a.digest)));
	assert.ok(seen.some((p) => p.includes(path.join("objects", "sha256"))));
	assert.ok(seen.some((p) => p.includes(path.join("blobs", "sha256"))));
	assert.deepEqual(fingerprint(f.dir), before);
});
test("C17-53 diff equal digest rereads snapshots every tree and blob without mutable reads", {
	skip:
		typeof stamps.diffStamps !== "function"
			? "blocked: src/stamps.js does not export diffStamps"
			: false,
}, (t) => {
	const f = fixture(t);
	bind(f, "profile", importInput(f, packageInput("profile")));
	const a = capture(f);
	const required = [
		snapshotPath(f, a.digest),
		...f.packages
			.get(a.snapshot.packages[0].sha256)
			.files.map((e) =>
				path.join(
					f.storeRoot,
					"objects/sha256",
					a.snapshot.packages[0].sha256,
					"tree",
					e.path,
				),
			),
		...new Set(
			[
				...a.snapshot.composition,
				...a.snapshot.required,
				...a.snapshot.available,
			]
				.flatMap((e) => [e.backing, ...e.resources.map((r) => r.backing)])
				.filter((b) => b.type === "blob")
				.map((b) => path.join(f.storeRoot, "blobs/sha256", b.sha256)),
		),
	];
	const expectedReport = healthy(f, a);
	fs.rmSync(f.root, { recursive: true });
	const before = fingerprint(f.dir),
		seen = [],
		guard = readGuard(f, seen);
	const noWrite = () => () => {
		throw new Error("comparison attempted filesystem mutation");
	};
	const readOnlyOpen =
		(original) =>
		(file, flags, ...args) => {
			assert.ok(
				flags === "r" ||
					(typeof flags === "number" &&
						(flags &
							(fs.constants.O_WRONLY |
								fs.constants.O_RDWR |
								fs.constants.O_CREAT |
								fs.constants.O_TRUNC |
								fs.constants.O_APPEND)) ===
							0),
				"read-only open",
			);
			return guard(original)(file, flags, ...args);
		};
	const output = intercept(
		{
			openSync: readOnlyOpen,
			readFileSync: guard,
			...Object.fromEntries(
				[
					"lstatSync",
					"statSync",
					"readdirSync",
					"realpathSync",
					"existsSync",
				].map((m) => [m, readGuard(f, [])]),
			),
			...Object.fromEntries(
				[
					"mkdirSync",
					"mkdtempSync",
					"writeFileSync",
					"appendFileSync",
					"renameSync",
					"unlinkSync",
					"rmSync",
					"copyFileSync",
				].map((m) => [m, noWrite]),
			),
		},
		() =>
			stamps.diffStamps({
				before: a.digest,
				after: a.digest,
				storeRoot: f.storeRoot,
			}),
	);
	assert.deepEqual(output, {
		complete: true,
		beforeVerification: expectedReport,
		afterVerification: expectedReport,
		changes: [],
	});
	assert.notStrictEqual(output.beforeVerification, output.afterVerification);
	// openSync is the actual byte-acquisition boundary; no synthetic verify calls inside the measured span.
	for (const file of required)
		assert.ok(
			seen.filter((p) => p === file).length >= 2,
			`both independent verifications read ${file}`,
		);
	assert.deepEqual(fingerprint(f.dir), before);
});

const malformed = [
	["C17-54", "null options", null, /^Error: options: expected an object$/],
	["C17-55", "array options", [], /^Error: options: expected an object$/],
	["C17-56", "numeric options", 7, /^Error: options: expected an object$/],
	[
		"C17-57",
		"missing both digests",
		{},
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-58",
		"missing before",
		{ after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-59",
		"missing after",
		{ before: "VALID" },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-60",
		"null before",
		{ before: null, after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-61",
		"numeric before",
		{ before: 7, after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-62",
		"uppercase before",
		{ before: "A".repeat(64), after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-63",
		"short before",
		{ before: "a".repeat(12), after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-64",
		"null after",
		{ before: "VALID", after: null },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-65",
		"numeric after",
		{ before: "VALID", after: 7 },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-66",
		"uppercase after",
		{ before: "VALID", after: "A".repeat(64) },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-67",
		"short after",
		{ before: "VALID", after: "a".repeat(12) },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-68",
		"unknown root option",
		{ before: "VALID", after: "VALID", root: "." },
		/^Error: root: unknown option$/,
	],
	[
		"C17-69",
		"unknown host option",
		{ before: "VALID", after: "VALID", host: "codex" },
		/^Error: host: unknown option$/,
	],
	[
		"C17-70",
		"unknown model option",
		{ before: "VALID", after: "VALID", model: "small" },
		/^Error: model: unknown option$/,
	],
	[
		"C17-71",
		"nonhex before",
		{ before: "g".repeat(64), after: "VALID" },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-72",
		"whitespace after",
		{ before: "VALID", after: " " + "a".repeat(64) },
		/^Error: after: expected 64 lowercase hexadecimal characters$/,
	],
	[
		"C17-72B",
		"both malformed digests report before first",
		{ before: null, after: 7 },
		/^Error: before: expected 64 lowercase hexadecimal characters$/,
	],
];
test("C17-54 fixture valid input precedes strict preflight matrix", (t) => {
	const f = fixture(t),
		a = capture(f);
	healthy(f, a);
	let hits = 0;
	intercept(
		{
			lstatSync:
				(original) =>
				(...args) => {
					hits++;
					return original(...args);
				},
		},
		() => healthy(f, a),
	);
	assert.ok(hits > 0, "preflight I/O interception observes the real verifier");
});
for (const [cid, name, input, diagnostic] of malformed)
	test(`${cid} diff strict preflight ${name}`, {
		skip:
			typeof stamps.diffStamps !== "function"
				? "blocked: src/stamps.js does not export diffStamps"
				: false,
	}, (t) => {
		const f = fixture(t),
			a = capture(f);
		result(f, a, a, []);
		const supplied =
			input && !Array.isArray(input) && typeof input === "object"
				? {
						...Object.fromEntries(
							Object.entries(input).map(([k, v]) => [
								k,
								v === "VALID" ? a.digest : v,
							]),
						),
						storeRoot: f.storeRoot,
					}
				: input;
		let io = 0;
		const reject = () => () => {
			io++;
			throw new Error("unexpected I/O before input validation");
		};
		const before = fingerprint(f.dir);
		intercept(
			Object.fromEntries(
				[
					"lstatSync",
					"statSync",
					"openSync",
					"readFileSync",
					"readdirSync",
					"realpathSync",
					"mkdirSync",
				].map((m) => [m, reject]),
			),
			() => {
				assert.throws(() => stamps.diffStamps(supplied), diagnostic);
			},
		);
		assert.equal(io, 0, "both digest syntax checks precede store I/O");
		assert.deepEqual(fingerprint(f.dir), before);
	});

function storeFixture(t) {
	const f = fixture(t);
	bind(f, "profile", importInput(f, packageInput("profile")));
	const a = capture(f);
	const ambient = fixture(t),
		other = importInput(ambient, packageInput("profile", "1.0.0", "B"));
	bind(ambient, "profile", other);
	const misleading = capture(ambient);
	assert.notEqual(a.digest, misleading.digest);
	const empty = path.join(f.dir, "empty"),
		missing = path.join(f.dir, "never-created"),
		home = path.join(f.dir, "home");
	fs.mkdirSync(empty);
	fs.mkdirSync(home);
	fs.cpSync(ambient.storeRoot, path.join(home, ".agent-profiles", "store"), {
		recursive: true,
	});
	return { f, a, ambient, empty, missing, home };
}
test("C17-73 fixture explicit empty misleading and absent stores", (t) => {
	const { f, a, ambient, empty, missing } = storeFixture(t);
	healthy(f, a);
	for (const storeRoot of [empty, missing, ambient.storeRoot]) {
		const before = fingerprint(storeRoot),
			r = stamps.verifyStamp({ digest: a.digest, storeRoot });
		assert.equal(r.snapshotIntegrity, "missing");
		assert.equal(r.managedReproducible, false);
		assert.match(r.findings.join("\n"), /ENOENT/);
		assert.deepEqual(fingerprint(storeRoot), before);
	}
});
test("C17-73 diff explicit store beats empty misleading environment and home", {
	skip:
		typeof stamps.diffStamps !== "function"
			? "blocked: src/stamps.js does not export diffStamps"
			: false,
}, (t) => {
	const { f, a, ambient, empty, missing, home } = storeFixture(t);
	environment(t, {
		AGENT_PROFILES_STORE: empty,
		HOME: home,
		USERPROFILE: home,
	});
	result(f, a, a, []);
	process.env.AGENT_PROFILES_STORE = ambient.storeRoot;
	const ambientBefore = fingerprint(ambient.dir),
		before = fingerprint(f.dir);
	fs.rmSync(f.root, { recursive: true });
	const deleted = fingerprint(f.dir);
	result(f, a, a, []);
	for (const storeRoot of [empty, missing, ambient.storeRoot]) {
		const prior = fingerprint(storeRoot),
			r = stamps.diffStamps({ before: a.digest, after: a.digest, storeRoot });
		assert.deepEqual(r, {
			complete: false,
			beforeVerification: stamps.verifyStamp({ digest: a.digest, storeRoot }),
			afterVerification: stamps.verifyStamp({ digest: a.digest, storeRoot }),
			changes: [],
		});
		assert.equal(r.beforeVerification.snapshotIntegrity, "missing");
		assert.deepEqual(fingerprint(storeRoot), prior);
	}
	const r = stamps.diffStamps({ before: a.digest, after: a.digest });
	assert.equal(r.complete, false);
	assert.equal(r.beforeVerification.snapshotIntegrity, "missing");
	delete process.env.AGENT_PROFILES_STORE;
	assert.equal(
		os.homedir(),
		home,
		"home fallback must be owned by this fixture",
	);
	result(f, a, a, []);
	const homeResult = stamps.diffStamps({ before: a.digest, after: a.digest });
	assert.equal(homeResult.complete, false);
	assert.equal(homeResult.beforeVerification.snapshotIntegrity, "missing");
	assert.deepEqual(fingerprint(f.dir), deleted);
	assert.notDeepEqual(deleted, before);
	assert.deepEqual(fingerprint(ambient.dir), ambientBefore);
});
test("C17-74 diff store safety rejects nonlocal and malformed roots without creation", {
	skip:
		typeof stamps.diffStamps !== "function"
			? "blocked: src/stamps.js does not export diffStamps"
			: false,
}, (t) => {
	const f = fixture(t),
		a = capture(f);
	result(f, a, a, []);
	for (const storeRoot of [
		null,
		7,
		"",
		"https://invalid.example/store",
		"//server/share",
	]) {
		const before = fingerprint(f.dir),
			r = stamps.diffStamps({ before: a.digest, after: a.digest, storeRoot });
		assert.equal(r.complete, false);
		assert.deepEqual(r.changes, []);
		for (const v of [r.beforeVerification, r.afterVerification]) {
			assert.equal(v.snapshotIntegrity, "mismatched");
			assert.equal(v.managedReproducible, false);
			assert.match(
				v.findings.join("\n"),
				/store: expected a nonempty local directory|store: unsupported-filesystem: nonlocal path/,
			);
		}
		assert.deepEqual(fingerprint(f.dir), before);
	}
});
test("C17-75 fixture local qualified binaries and package trees reconstruct after source deletion", (t) => {
	const local = fixture(t),
		a = capture(local, { skills: ["a"] });
	const packaged = fixture(t),
		p = importInput(packaged, packageInput("profile"));
	bind(packaged, "profile", p);
	const b = capture(packaged);
	for (const [f, s] of [
		[local, a],
		[packaged, b],
	]) {
		fs.rmSync(f.root, { recursive: true });
		fs.rmSync(path.join(f.dir, "sources"), { recursive: true, force: true });
		const before = fingerprint(f.dir),
			r = healthy(f, s),
			restored = stamps.reconstructStamp({
				digest: s.digest,
				storeRoot: f.storeRoot,
			});
		assert.equal(r.hostInvocation, "unverified");
		assert.equal(r.runtimeIdentity, "unverified");
		assert.equal(r.renderedPrompt, "unverified");
		assert.deepEqual(restored.composition[0].bytes, instruction);
		assert.deepEqual(restored.composition[1].bytes, instruction);
		assert.deepEqual(
			restored.resources,
			(f === local
				? [
						resource("profiles.base", "assets/profile.bin"),
						resource("roles.reviewer", "assets/role.bin"),
						resource("skills.q", "assets/q.bin"),
						resource("skills.a", "assets/a.bin"),
						resource("skills.b", "assets/b.bin"),
					]
				: [
						resource("roles.reviewer", "assets/role.bin"),
						resource("skills.q", "assets/q.bin"),
						resource("skills.a", "assets/a.bin"),
						resource("skills.b", "assets/b.bin"),
					]
			).map((e) => ({ ...e, bytes: binary })),
		);
		if (f === packaged) assert.deepEqual(restored.packages[0].files, p.files);
		assert.deepEqual(fingerprint(f.dir), before);
	}
});
