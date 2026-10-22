import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseRecord, readPackage } from "../src/packages.ts";

// P3 provisional seam (C05-C07), to be frozen by parent RED assessment; no production stub.
// importPackage({sourceDirectory, storeRoot?, expectedDigest?, onPhase?, rename?})
//   -> {identity: {name, version}, sha256, status: 'published' | 'reused'}.
//   storeRoot precedence: explicit, then AGENT_PROFILES_STORE, then os.homedir()/.agent-profiles/store.
//   onPhase(phase, detail) is an optional synchronous observation hook called at
//     'source-read'       once, after the first source file is copied into staging;
//     'copied'            staging complete, before the staged bytes are rehashed; detail {staging};
//     'object-published'  after the object rename, before the identity mapping;
//     'mapping-committed' after the identity rename, before the writer lock is released.
//   rename(from, to) optionally replaces the publication rename (object and identity),
//     so tests can inject observed rename error codes.
// lookupPackage({storeRoot, name, version}) -> null without an identity record, otherwise
//   {identity, sha256, files: [{path, bytes: Buffer}]} after full verification; throws on corruption.
// recoverStore({storeRoot, confirmNoActiveWriter}) -> {lock: boolean, staging: [removed staging ids]};
//   refuses unless confirmNoActiveWriter === true; never touches identities/objects.
// encodeComponent(s) / decodeComponent(s): contract E(s) and its strict inverse.
// Diagnostics are asserted by contract tokens only: store-busy, identity-conflict,
// unsupported-filesystem, publication-denied (+ observed code).
const moduleUrl = new URL("../src/package-store.ts", import.meta.url);
let sut;
let missing;
try {
	sut = await import(moduleUrl.href);
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND" || existsSync(moduleUrl))
		throw error;
	missing = error;
}
const blocked = missing
	? "BLOCKED: src/package-store.ts absent; behavioral assertions did not execute"
	: false;
const behavior = (name, fn) => test(name, { skip: blocked }, fn);

test("P3 production seam src/package-store.ts exists with the provisional exports", () => {
	assert.ok(
		sut,
		`Missing intended src/package-store.ts (${missing?.code}); not behavioral evidence`,
	);
	for (const name of [
		"importPackage",
		"lookupPackage",
		"recoverStore",
		"encodeComponent",
		"decodeComponent",
	]) {
		assert.equal(
			typeof sut[name],
			"function",
			`src/package-store.ts export ${name}`,
		);
	}
});

// ---- independent oracle and fixtures (no production store code) ----
const DOMAIN = "agent-profiles/package-tree/v1";
const NAME = "@example/security-review";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const u64 = (n) => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n));
	return b;
};
const sortFiles = (files) =>
	[...files].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
	);
const frame = (files) =>
	Buffer.concat([
		Buffer.from(DOMAIN),
		Buffer.from([0]),
		u64(files.length),
		...sortFiles(files).flatMap((f) => [
			Buffer.from([0x46]),
			u64(Buffer.byteLength(f.path)),
			Buffer.from(f.path),
			u64(f.bytes.length),
			f.bytes,
		]),
	]);
const digest = (files) => sha(frame(files));
const E = (s) => `x-${Buffer.from(s).toString("hex")}`;
const file = (name, content) => ({
	path: name,
	bytes: Buffer.isBuffer(content) ? content : Buffer.from(content),
});
const SKILL = Buffer.from(
	"---\nname: Review\ndescription: Useful review.\n---\nBODY\n",
);
function pkg({
	name = NAME,
	version = "1.0.0",
	body = SKILL,
	support = "support\r\n",
	extra = [],
} = {}) {
	return [
		file(
			"package.yaml",
			`schema_version: 1\npackage:\n  name: "${name}"\n  version: "${version}"\n  type: skill\nentrypoint: SKILL.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n`,
		),
		file("SKILL.md", body),
		file(".hidden", "hidden\n"),
		file("resources/asset.bin", Buffer.from([0, 255, 128, 13, 10])),
		file("resources/empty", ""),
		file("resources/support.txt", support),
		...extra,
	];
}
// Fixed digest of pkg(), pinned after independent oracle and P2 hashTree agreed.
const GOLDEN =
	"27f1260dabc2800dab13e42db028be38c6e207f4c6599a9497b66cd739f93bdf";

function scratch(t) {
	const dir = realpathSync(
		mkdtempSync(
			path.join(process.env.TMPDIR ?? os.tmpdir(), "issue-20-store-"),
		),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function writeTree(root, files) {
	for (const f of files) {
		mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
		writeFileSync(path.join(root, f.path), f.bytes);
	}
	mkdirSync(path.join(root, "empty-directory"), { recursive: true });
	return root;
}
function listFiles(root, relative = "") {
	if (!existsSync(path.join(root, relative))) return [];
	return sortFiles(
		readdirSync(path.join(root, relative)).flatMap((name) => {
			const member = relative ? `${relative}/${name}` : name;
			const stat = lstatSync(path.join(root, member));
			if (stat.isSymbolicLink()) return [file(member, "LINK")];
			return stat.isDirectory()
				? listFiles(root, member)
				: [file(member, readFileSync(path.join(root, member)))];
		}),
	);
}
const fingerprint = (root) =>
	listFiles(root).map((f) => [f.path, sha(f.bytes)]);
const published = (store) =>
	["identities", "objects"].flatMap((d) =>
		listFiles(path.join(store, d)).map((f) => `${d}/${f.path}`),
	);
const staging = (store) =>
	existsSync(path.join(store, ".staging"))
		? readdirSync(path.join(store, ".staging")).sort()
		: [];
const linkDirectory = (target, link) =>
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
function identityPath(store, name, version) {
	const [namespace, base] = name.slice(1).split("/");
	return path.join(
		store,
		"identities",
		E(namespace),
		E(base),
		`${version}.json`,
	);
}
const objectTree = (store, sum) =>
	path.join(store, "objects", "sha256", sum, "tree");
// Nonempty exact membership and raw-byte comparison; an empty expectation is a fixture error.
function exactTree(actual, expected) {
	assert.ok(expected.length > 0, "expected membership must be nonempty");
	assert.deepEqual(
		actual.map((f) => f.path),
		sortFiles(expected).map((f) => f.path),
	);
	sortFiles(expected).forEach((f, i) => {
		assert.ok(
			Buffer.from(actual[i].bytes).equals(f.bytes),
			`raw bytes differ: ${f.path}`,
		);
	});
}
function checkPublished(store, files, name = NAME, version = "1.0.0") {
	const sum = digest(files);
	assert.deepEqual(
		parseRecord(readFileSync(identityPath(store, name, version))),
		{ identity: { name, version }, sha256: sum },
	);
	assert.deepEqual(readdirSync(path.join(store, "objects", "sha256", sum)), [
		"tree",
	]);
	exactTree(listFiles(objectTree(store, sum)), files);
	return sum;
}
async function rejects(fn, tokens = []) {
	await assert.rejects(
		async () => fn(),
		(error) => {
			assert.ok(
				error instanceof Error && error.message,
				"error must be diagnostic",
			);
			for (const token of tokens) assert.match(error.message, token);
			return true;
		},
	);
}
const lockPath = (store) => path.join(store, ".writer-lock");
const ino = (target) => statSync(target, { bigint: true }).ino;

// ---- independent child helper (test/fixtures/issue-20/store-worker.mjs) ----
const WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/store-worker.mjs", import.meta.url),
);
function childEnv(dir, extra = {}) {
	// Home/env always point into task scratch so a faulty store cannot reach the real home.
	return {
		...process.env,
		HOME: path.join(dir, "home"),
		USERPROFILE: path.join(dir, "home"),
		AGENT_PROFILES_STORE: path.join(dir, "env-store"),
		...extra,
	};
}
function worker(t, request, env) {
	const child = spawn(process.execPath, [WORKER, JSON.stringify(request)], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		stdout += d;
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	const closed = new Promise((resolve) =>
		child.on("close", (code, signal) => {
			let output = null;
			try {
				output = JSON.parse(stdout.trim().split("\n").pop());
			} catch {
				/* reported via stdout/stderr */
			}
			resolve({ code, signal, stdout, stderr, output });
		}),
	);
	return { child, closed };
}
async function paused(t, dir, phase, request) {
	const marker = path.join(dir, `${phase}.marker`);
	const release = path.join(dir, `${phase}.release`);
	const run = worker(
		t,
		{ ...request, barrier: { phase, marker, release } },
		childEnv(dir),
	);
	let ended = null;
	run.closed.then((result) => {
		ended = result;
	});
	for (const start = Date.now(); !existsSync(marker); await delay(10)) {
		if (ended)
			assert.fail(`worker ended before ${phase}: ${JSON.stringify(ended)}`);
		if (Date.now() - start > 20000)
			assert.fail(`timed out waiting for ${phase}`);
	}
	return {
		...run,
		release: () => {
			writeFileSync(release, "");
			return run.closed;
		},
		kill: async () => {
			run.child.kill("SIGKILL");
			const result = await run.closed;
			assert.equal(result.signal, "SIGKILL");
			return result;
		},
	};
}
const files = (result) =>
	result.files.map((f) => file(f.path, Buffer.from(f.bytes.data ?? f.bytes)));
async function read(t, dir, storeRoot, name = NAME, version = "1.0.0") {
	const result = await worker(
		t,
		{ op: "lookupPackage", args: { storeRoot, name, version } },
		childEnv(dir),
	).closed;
	assert.equal(result.code, 0, result.stderr);
	assert.ok(result.output?.ok, JSON.stringify(result.output));
	return result.output.result;
}
async function write(t, dir, args) {
	const result = await worker(t, { op: "importPackage", args }, childEnv(dir))
		.closed;
	assert.equal(result.code, 0, result.stderr);
	return result.output;
}
async function noDispatch(fn) {
	let dispatches = 0;
	const saved = [];
	for (const [object, keys] of [
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
		[http, ["request", "get"]],
		[https, ["request", "get"]],
		[globalThis, ["fetch"]],
	]) {
		for (const key of keys) {
			saved.push([object, key, object[key]]);
			object[key] = () => {
				dispatches++;
				throw new Error("Forbidden dispatch");
			};
		}
	}
	syncBuiltinESMExports();
	try {
		await fn();
	} finally {
		for (const [object, key, original] of saved) object[key] = original;
		syncBuiltinESMExports();
	}
	assert.equal(dispatches, 0, "no subprocess/network dispatch");
}

// ---- fixture/oracle controls: execute now, independent of the missing store ----
test("oracle: fixed tree digest, framing and raw bytes agree with the real P2 reader", (t) => {
	const root = writeTree(path.join(scratch(t), "src"), pkg());
	assert.ok(
		frame(pkg())
			.subarray(0, DOMAIN.length + 9)
			.equals(Buffer.concat([Buffer.from(DOMAIN), Buffer.from([0]), u64(6)])),
	);
	assert.equal(digest(pkg()), GOLDEN);
	const read = readPackage({ root });
	assert.equal(read.sha256, GOLDEN);
	assert.equal(read.manifest.package.name, NAME);
	exactTree(read.files, pkg());
});

test("oracle: otherwise-valid mutations stay P2-valid and change the digest", (t) => {
	const dir = scratch(t);
	const variants = {
		resourceByte: pkg({ support: "support\n" }),
		manifestComment: pkg().map((f) =>
			f.path === "package.yaml"
				? file(f.path, Buffer.concat([f.bytes, Buffer.from("# comment\n")]))
				: f,
		),
		extraMember: pkg({ extra: [file("resources/extra.txt", "x")] }),
		missingMember: pkg().filter((f) => f.path !== "resources/empty"),
		versionOnly: pkg({ version: "2.0.0" }),
		nameOnly: pkg({ name: "@example/other" }),
	};
	const sums = new Set([GOLDEN]);
	for (const [label, tree] of Object.entries(variants)) {
		const read = readPackage({ root: writeTree(path.join(dir, label), tree) });
		assert.equal(read.sha256, digest(tree), label);
		sums.add(read.sha256);
	}
	assert.equal(
		sums.size,
		Object.keys(variants).length + 1,
		"every mutation yields a distinct digest",
	);
});

test("oracle: exact membership comparison rejects missing, extra, altered and empty expectations", () => {
	const full = pkg();
	exactTree(sortFiles(full), full);
	assert.throws(() => exactTree(sortFiles(full.slice(1)), full));
	assert.throws(() => exactTree(sortFiles([...full, file("extra", "")]), full));
	assert.throws(() =>
		exactTree(
			sortFiles(
				full.map((f) => (f.path === "SKILL.md" ? file(f.path, "BODY") : f)),
			),
			full,
		),
	);
	assert.throws(() => exactTree([], []), /nonempty/);
});

test("oracle: Git checkout fixture has a valid package subtree and a rejected checkout root", (t) => {
	const checkout = writeTree(path.join(scratch(t), "checkout"), [
		...pkg(),
		file(".git/HEAD", "ref: refs/heads/main\n"),
	]);
	writeTree(path.join(checkout, "pkg"), pkg());
	assert.equal(
		readPackage({ root: path.join(checkout, "pkg") }).sha256,
		GOLDEN,
	);
	assert.throws(() => readPackage({ root: checkout }), /\.git/);
});

test("oracle: reserved identity encoding matches contract examples and P2 accepts reserved names", (t) => {
	assert.equal(E("con"), "x-636f6e");
	assert.equal(E("nul"), "x-6e756c");
	assert.equal(E("skills.con"), "x-736b696c6c732e636f6e");
	assert.notEqual(E("x-636f6e"), "x-636f6e");
	const dir = scratch(t);
	for (const name of ["@con/review", "@team/nul", "@x-636f6e/review"]) {
		assert.equal(
			readPackage({ root: writeTree(path.join(dir, E(name)), pkg({ name })) })
				.manifest.package.name,
			name,
		);
	}
	assert.throws(
		() =>
			readPackage({
				root: writeTree(
					path.join(dir, "con-member"),
					pkg({ extra: [file("con.txt", "x")] }),
				),
			}),
		/reserved/,
	);
});

test("oracle: same-size replacement changes observable read identity; junction fixture is a link", (t) => {
	const dir = scratch(t);
	const target = path.join(dir, "f.txt");
	writeFileSync(target, "same");
	const before = statSync(target, { bigint: true });
	const holder = path.join(dir, "holder.txt");
	renameSync(target, holder); // Keep the original object allocated until the replacement is observed.
	writeFileSync(target, "same");
	const after = statSync(target, { bigint: true });
	assert.equal(after.size, before.size);
	assert.notEqual(after.ino, before.ino);
	mkdirSync(path.join(dir, "real"));
	linkDirectory(path.join(dir, "real"), path.join(dir, "alias"));
	assert.ok(lstatSync(path.join(dir, "alias")).isSymbolicLink());
});

test("child control: barrier pauses the worker and SIGKILL lands before any post-barrier effect", async (t) => {
	const dir = scratch(t);
	const after = path.join(dir, "after");
	const run = await paused(t, dir, "control", {
		op: "control",
		args: { after },
	});
	const result = await run.kill();
	assert.equal(result.code, null);
	assert.equal(existsSync(after), false);
});

test("child control: released barrier continues and reports through stdout", async (t) => {
	const dir = scratch(t);
	const after = path.join(dir, "after");
	const run = await paused(t, dir, "control", {
		op: "control",
		args: { after },
	});
	const result = await run.release();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.output, { ok: true, result: "control" });
	assert.equal(readFileSync(after, "utf8"), "after");
});

// ---- C05 local acquisition ----
behavior(
	"C05 import local directory publishes exact copied bytes and identity record",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const store = path.join(dir, "store");
		const before = fingerprint(src);
		const phases = [];
		const result = await sut.importPackage({
			sourceDirectory: src,
			storeRoot: store,
			onPhase: (phase) => phases.push(phase),
		});
		assert.deepEqual(
			{
				identity: result.identity,
				sha256: result.sha256,
				status: result.status,
			},
			{
				identity: { name: NAME, version: "1.0.0" },
				sha256: GOLDEN,
				status: "published",
			},
		);
		assert.deepEqual(
			[...new Set(phases)],
			["source-read", "copied", "object-published", "mapping-committed"],
		);
		checkPublished(store, pkg());
		assert.deepEqual(fingerprint(src), before);
		assert.equal(existsSync(lockPath(store)), false);
		assert.deepEqual(staging(store), []);
		const found = await sut.lookupPackage({
			storeRoot: store,
			name: NAME,
			version: "1.0.0",
		});
		assert.deepEqual(
			[found.identity, found.sha256],
			[{ name: NAME, version: "1.0.0" }, GOLDEN],
		);
		exactTree(found.files, pkg());
	},
);

behavior(
	"C05 import existing Git package subtree as an ordinary directory without Git operations",
	async (t) => {
		const dir = scratch(t);
		const checkout = writeTree(path.join(dir, "checkout"), [
			...pkg(),
			file(".git/HEAD", "ref: refs/heads/main\n"),
			file(".git/config", "[core]\n"),
		]);
		writeTree(path.join(checkout, "pkg"), pkg());
		const store = path.join(dir, "store");
		const before = fingerprint(checkout);
		await noDispatch(async () => {
			const result = await sut.importPackage({
				sourceDirectory: path.join(checkout, "pkg"),
				storeRoot: store,
			});
			assert.equal(result.sha256, GOLDEN);
			const ledger = published(store);
			await rejects(
				() =>
					sut.importPackage({ sourceDirectory: checkout, storeRoot: store }),
				[/\.git/],
			);
			assert.deepEqual(published(store), ledger);
		});
		checkPublished(store, pkg());
		assert.deepEqual(fingerprint(checkout), before);
	},
);

behavior(
	"C05 expected digest: malformed syntax and mismatch publish nothing; exact match publishes",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const store = path.join(dir, "store");
		for (const expectedDigest of [
			"",
			GOLDEN.toUpperCase(),
			GOLDEN.slice(1),
			`${GOLDEN}0`,
			`g${GOLDEN.slice(1)}`,
			`sha256:${GOLDEN}`,
			123,
		]) {
			await rejects(
				() =>
					sut.importPackage({
						sourceDirectory: src,
						storeRoot: store,
						expectedDigest,
					}),
				[/digest/i],
			);
			assert.deepEqual(published(store), [], `malformed ${expectedDigest}`);
		}
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: src,
					storeRoot: store,
					expectedDigest: "0".repeat(64),
				}),
			[/mismatch/i, new RegExp(GOLDEN)],
		);
		assert.deepEqual(published(store), []);
		assert.equal(
			(
				await sut.importPackage({
					sourceDirectory: src,
					storeRoot: store,
					expectedDigest: GOLDEN,
				})
			).status,
			"published",
		);
		checkPublished(store, pkg());
	},
);

behavior(
	"C05 unsafe, remote and archive sources reject without dispatch or store publication",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const outside = writeTree(path.join(dir, "outside"), [
			file("secret.txt", "secret"),
		]);
		const outsideBefore = fingerprint(outside);
		const linkedMember = writeTree(path.join(dir, "linked-member"), pkg());
		linkDirectory(outside, path.join(linkedMember, "resources", "escape"));
		const real = writeTree(path.join(dir, "real"), pkg());
		const linkedRoot = path.join(dir, "linked-root");
		linkDirectory(real, linkedRoot);
		const archive = path.join(dir, "pkg.tgz");
		writeFileSync(archive, Buffer.from([0x1f, 0x8b, 8, 0]));
		const sources = [
			linkedMember,
			linkedRoot,
			writeTree(path.join(dir, "git-member"), [
				...pkg(),
				file(".git/HEAD", "x\n"),
			]),
			path.join(dir, "absent"),
			archive,
			"https://example.invalid/pkg.tgz",
			"git+https://example.invalid/pkg.git",
		];
		await noDispatch(async () => {
			for (const sourceDirectory of sources) {
				await rejects(() =>
					sut.importPackage({ sourceDirectory, storeRoot: store }),
				);
				assert.deepEqual(published(store), [], sourceDirectory);
			}
		});
		assert.deepEqual(fingerprint(outside), outsideBefore);
	},
);

behavior(
	"C05 source/store overlap, linked store roots, linked store descendants and blank roots reject",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const before = fingerprint(src);
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: src,
					storeRoot: path.join(src, "store"),
				}),
			[/source/i, /store/i],
		);
		await rejects(
			() => sut.importPackage({ sourceDirectory: src, storeRoot: src }),
			[/source/i, /store/i],
		);
		assert.deepEqual(fingerprint(src), before);
		const store = path.join(dir, "store");
		const inner = writeTree(path.join(store, "inner-src"), pkg());
		await rejects(
			() => sut.importPackage({ sourceDirectory: inner, storeRoot: store }),
			[/source/i, /store/i],
		);
		assert.deepEqual(published(store), []);
		const realStore = path.join(dir, "real-store");
		mkdirSync(realStore);
		linkDirectory(realStore, path.join(dir, "linked-store"));
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: src,
					storeRoot: path.join(dir, "linked-store"),
				}),
			[/link|junction/i],
		);
		assert.deepEqual(readdirSync(realStore), []);
		const outside = path.join(dir, "outside-objects");
		mkdirSync(outside);
		mkdirSync(path.join(dir, "store-with-link"));
		linkDirectory(outside, path.join(dir, "store-with-link", "objects"));
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: src,
					storeRoot: path.join(dir, "store-with-link"),
				}),
			[/link|junction/i],
		);
		assert.deepEqual(readdirSync(outside), []);
		for (const storeRoot of ["", "   "])
			await rejects(
				() => sut.importPackage({ sourceDirectory: src, storeRoot }),
				[/store/i],
			);
		assert.deepEqual(fingerprint(src), before);
	},
);

const mutations = {
	size: (src) =>
		listFiles(src).forEach((f) => {
			writeFileSync(
				path.join(src, f.path),
				Buffer.concat([f.bytes, Buffer.from("!")]),
			);
		}),
	readIdentity: (src) =>
		listFiles(src).forEach((f) => {
			unlinkSync(path.join(src, f.path));
			writeFileSync(path.join(src, f.path), f.bytes);
		}),
	addedMember: (src) =>
		writeFileSync(path.join(src, "resources", "late.txt"), "late"),
	removedMember: (src) => unlinkSync(path.join(src, "resources", "empty")),
};
for (const [label, mutate] of Object.entries(mutations)) {
	behavior(
		`C05 source ${label} change during copy aborts before publication`,
		async (t) => {
			const dir = scratch(t);
			const src = writeTree(path.join(dir, "src"), pkg());
			const store = path.join(dir, "store");
			let reached = 0;
			await rejects(() =>
				sut.importPackage({
					sourceDirectory: src,
					storeRoot: store,
					onPhase: (phase) => {
						if (phase === "source-read" && !reached++) mutate(src);
					},
				}),
			);
			assert.equal(reached, 1, "mutation barrier reached");
			assert.deepEqual(published(store), []);
			assert.equal(existsSync(lockPath(store)), false);
			const clean = writeTree(path.join(dir, "clean"), pkg());
			assert.equal(
				(await sut.importPackage({ sourceDirectory: clean, storeRoot: store }))
					.sha256,
				GOLDEN,
			);
		},
	);
}

behavior(
	"C05 staged copied bytes are independently rehashed before object publication",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const store = path.join(dir, "store");
		let reached = 0;
		await rejects(() =>
			sut.importPackage({
				sourceDirectory: src,
				storeRoot: store,
				onPhase: (phase, detail) => {
					if (phase !== "copied") return;
					const staged = listFiles(detail.staging).find((f) =>
						f.path.endsWith("SKILL.md"),
					);
					writeFileSync(
						path.join(detail.staging, staged.path),
						Buffer.from(staged.bytes.toString().replace("BODY", "EVIL")),
					);
					reached++;
				},
			}),
		);
		assert.equal(reached, 1, "staged corruption barrier reached");
		assert.deepEqual(published(store), []);
	},
);

behavior(
	"C05 store root precedence: explicit, then AGENT_PROFILES_STORE, then injected home",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const explicit = path.join(dir, "explicit");
		const envStore = path.join(dir, "env-store");
		const home = path.join(dir, "home");
		const homeStore = path.join(home, ".agent-profiles", "store");
		mkdirSync(home);
		const run = async (args, extra) => {
			const result = await worker(
				t,
				{ op: "importPackage", args },
				childEnv(dir, extra),
			).closed;
			assert.equal(result.code, 0, result.stderr);
			return result.output;
		};
		assert.ok((await run({ sourceDirectory: src, storeRoot: explicit })).ok);
		checkPublished(explicit, pkg());
		assert.deepEqual(
			[existsSync(envStore), existsSync(homeStore)],
			[false, false],
		);
		assert.ok((await run({ sourceDirectory: src })).ok);
		checkPublished(envStore, pkg());
		assert.equal(existsSync(homeStore), false);
		const blank = await run(
			{ sourceDirectory: src },
			{ AGENT_PROFILES_STORE: "   " },
		);
		assert.equal(blank.ok, false);
		assert.equal(existsSync(homeStore), false);
		const env = childEnv(dir);
		delete env.AGENT_PROFILES_STORE;
		const fallback = await worker(
			t,
			{ op: "importPackage", args: { sourceDirectory: src } },
			env,
		).closed;
		assert.ok(fallback.output?.ok, JSON.stringify(fallback));
		checkPublished(homeStore, pkg());
	},
);

// ---- C06 immutable coexistence, reuse and integrity ----
const V2 = pkg({
	version: "2.0.0",
	body: Buffer.from(
		"---\nname: Review\ndescription: Useful review.\n---\nBODY v2\n",
	),
});

behavior(
	"C06 two releases coexist side by side with independently verified trees",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "v1"), pkg()),
			storeRoot: store,
		});
		const first = fingerprint(objectTree(store, GOLDEN));
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "v2"), V2),
			storeRoot: store,
		});
		checkPublished(store, pkg());
		checkPublished(store, V2, NAME, "2.0.0");
		assert.deepEqual(
			readdirSync(path.join(store, "objects", "sha256")).sort(),
			[GOLDEN, digest(V2)].sort(),
		);
		assert.deepEqual(fingerprint(objectTree(store, GOLDEN)), first);
		exactTree(
			(
				await sut.lookupPackage({
					storeRoot: store,
					name: NAME,
					version: "1.0.0",
				})
			).files,
			pkg(),
		);
		exactTree(
			(
				await sut.lookupPackage({
					storeRoot: store,
					name: NAME,
					version: "2.0.0",
				})
			).files,
			V2,
		);
	},
);

behavior(
	"C06 same identity and digest from another source root is reused, not replaced",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "a"), pkg()),
			storeRoot: store,
		});
		const record = readFileSync(identityPath(store, NAME, "1.0.0"));
		const member = ino(path.join(objectTree(store, GOLDEN), "package.yaml"));
		const result = await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "b"), pkg()),
			storeRoot: store,
		});
		assert.deepEqual([result.status, result.sha256], ["reused", GOLDEN]);
		assert.deepEqual(readdirSync(path.join(store, "objects", "sha256")), [
			GOLDEN,
		]);
		assert.ok(readFileSync(identityPath(store, NAME, "1.0.0")).equals(record));
		assert.equal(
			ino(path.join(objectTree(store, GOLDEN), "package.yaml")),
			member,
		);
	},
);

behavior(
	"C06 identical body under a different manifest identity is a different tree",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const other = pkg({ name: "@example/other" });
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "a"), pkg()),
			storeRoot: store,
		});
		assert.equal(
			(
				await sut.importPackage({
					sourceDirectory: writeTree(path.join(dir, "b"), other),
					storeRoot: store,
				})
			).sha256,
			digest(other),
		);
		checkPublished(store, other, "@example/other");
		assert.equal(readdirSync(path.join(store, "objects", "sha256")).length, 2);
	},
);

behavior(
	"C06 same version with a changed resource is identity-conflict and never overwrites",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "a"), pkg()),
			storeRoot: store,
		});
		const before = fingerprint(store);
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: writeTree(
						path.join(dir, "b"),
						pkg({ support: "changed\r\n" }),
					),
					storeRoot: store,
				}),
			[/identity-conflict/],
		);
		assert.deepEqual(fingerprint(store), before);
		exactTree(
			(
				await sut.lookupPackage({
					storeRoot: store,
					name: NAME,
					version: "1.0.0",
				})
			).files,
			pkg(),
		);
	},
);

const corruptions = {
	alteredMemberByte: (store) =>
		writeFileSync(
			path.join(objectTree(store, GOLDEN), "resources", "asset.bin"),
			Buffer.from([1, 255, 128, 13, 10]),
		),
	missingMember: (store) =>
		unlinkSync(path.join(objectTree(store, GOLDEN), "resources", "empty")),
	extraMember: (store) =>
		writeFileSync(path.join(objectTree(store, GOLDEN), "extra.txt"), "x"),
	extraObjectSibling: (store) =>
		writeFileSync(
			path.join(store, "objects", "sha256", GOLDEN, "receipt.json"),
			"{}",
		),
	missingObject: (store) =>
		rmSync(path.join(store, "objects", "sha256", GOLDEN), { recursive: true }),
	malformedIdentityRecord: (store) =>
		writeFileSync(identityPath(store, NAME, "1.0.0"), "{"),
	identityRecordUnknownField: (store) =>
		writeFileSync(
			identityPath(store, NAME, "1.0.0"),
			JSON.stringify({
				identity: { name: NAME, version: "1.0.0" },
				sha256: GOLDEN,
				extra: true,
			}),
		),
	identityRecordWrongIdentity: (store) =>
		writeFileSync(
			identityPath(store, NAME, "1.0.0"),
			JSON.stringify({
				identity: { name: NAME, version: "9.9.9" },
				sha256: GOLDEN,
			}),
		),
};
for (const [label, corrupt] of Object.entries(corruptions)) {
	behavior(
		`C06 corrupt store (${label}) fails reuse and lookup without repair`,
		async (t) => {
			const dir = scratch(t);
			const store = path.join(dir, "store");
			const src = writeTree(path.join(dir, "src"), pkg());
			await sut.importPackage({ sourceDirectory: src, storeRoot: store });
			corrupt(store);
			const damaged = published(store).map((p) => [
				p,
				sha(readFileSync(path.join(store, p))),
			]);
			await rejects(() =>
				sut.importPackage({ sourceDirectory: src, storeRoot: store }),
			);
			await rejects(() =>
				sut.lookupPackage({ storeRoot: store, name: NAME, version: "1.0.0" }),
			);
			assert.deepEqual(
				published(store).map((p) => [
					p,
					sha(readFileSync(path.join(store, p))),
				]),
				damaged,
			);
		},
	);
}

behavior(
	"C06 lookup requires a complete identity record, not object directory existence",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await sut.importPackage({
			sourceDirectory: writeTree(path.join(dir, "src"), pkg()),
			storeRoot: store,
		});
		unlinkSync(identityPath(store, NAME, "1.0.0"));
		assert.equal(
			await sut.lookupPackage({
				storeRoot: store,
				name: NAME,
				version: "1.0.0",
			}),
			null,
		);
		exactTree(listFiles(objectTree(store, GOLDEN)), pkg());
	},
);

behavior(
	"C06 reserved identities encode safely without narrowing logical names",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const sums = new Set();
		for (const name of ["@con/review", "@team/nul", "@x-636f6e/review"]) {
			await sut.importPackage({
				sourceDirectory: writeTree(path.join(dir, E(name)), pkg({ name })),
				storeRoot: store,
			});
			sums.add(checkPublished(store, pkg({ name }), name));
			exactTree(
				(await sut.lookupPackage({ storeRoot: store, name, version: "1.0.0" }))
					.files,
				pkg({ name }),
			);
		}
		assert.equal(sums.size, 3);
		assert.ok(
			existsSync(
				path.join(
					store,
					"identities",
					"x-636f6e",
					"x-726576696577",
					"1.0.0.json",
				),
			),
		);
		assert.ok(
			existsSync(
				path.join(store, "identities", "x-7465616d", "x-6e756c", "1.0.0.json"),
			),
		);
		assert.ok(
			existsSync(
				path.join(
					store,
					"identities",
					"x-782d363336663665",
					"x-726576696577",
					"1.0.0.json",
				),
			),
		);
		for (const f of listFiles(path.join(store, "identities"))) {
			f.path
				.split("/")
				.slice(0, 2)
				.forEach((component) => {
					assert.match(component, /^x-(?:[0-9a-f]{2})+$/);
				});
		}
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: writeTree(
						path.join(dir, "member"),
						pkg({ extra: [file("con.txt", "x")] }),
					),
					storeRoot: store,
				}),
			[/reserved/],
		);
	},
);

behavior(
	"C06 identity component decoding accepts only canonical lowercase x- hex UTF-8",
	() => {
		for (const value of ["con", "nul", "skills.con", "x-636f6e"]) {
			assert.equal(sut.encodeComponent(value), E(value));
			assert.equal(sut.decodeComponent(E(value)), value);
		}
		for (const alias of [
			"X-636f6e",
			"x-636F6E",
			"x-636f6",
			"x-zz",
			"636f6e",
			"x-ff",
			"x-c0af",
		]) {
			assert.throws(() => sut.decodeComponent(alias), Error, alias);
		}
	},
);

// ---- C07 interruption, recovery and concurrent publication (independent child processes) ----
async function committedOther(_t, dir, store) {
	await sut.importPackage({
		sourceDirectory: writeTree(path.join(dir, "other"), V2),
		storeRoot: store,
	});
	return fingerprint(store);
}

behavior(
	"C07 kill during copy: no installed revision, store-busy until confirmed recovery, then re-import",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await committedOther(t, dir, store);
		const committed = [
			fingerprint(path.join(store, "identities")),
			fingerprint(path.join(store, "objects")),
		];
		const src = writeTree(path.join(dir, "src"), pkg());
		const writer = await paused(t, dir, "source-read", {
			op: "importPackage",
			args: { sourceDirectory: src, storeRoot: store },
		});
		await writer.kill();
		assert.equal(await read(t, dir, store), null);
		exactTree(files(await read(t, dir, store, NAME, "2.0.0")), V2);
		assert.deepEqual(
			[
				fingerprint(path.join(store, "identities")),
				fingerprint(path.join(store, "objects")),
			],
			committed,
		);
		const lock = fingerprint(lockPath(store));
		await rejects(
			() => sut.importPackage({ sourceDirectory: src, storeRoot: store }),
			[/store-busy/],
		);
		await rejects(() => sut.recoverStore({ storeRoot: store }));
		assert.deepEqual(fingerprint(lockPath(store)), lock);
		const leftover = staging(store);
		assert.ok(leftover.length > 0, "killed copy leaves uncommitted staging");
		const recovered = await sut.recoverStore({
			storeRoot: store,
			confirmNoActiveWriter: true,
		});
		assert.deepEqual(
			[recovered.lock, [...recovered.staging].sort()],
			[true, leftover],
		);
		assert.deepEqual(
			[existsSync(lockPath(store)), staging(store)],
			[false, []],
		);
		assert.deepEqual(
			[
				fingerprint(path.join(store, "identities")),
				fingerprint(path.join(store, "objects")),
			],
			committed,
		);
		assert.equal(
			(await sut.importPackage({ sourceDirectory: src, storeRoot: store }))
				.status,
			"published",
		);
		checkPublished(store, pkg());
	},
);

behavior(
	"C07 kill after object publication before mapping: orphan invisible, preserved, verified and reused",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const src = writeTree(path.join(dir, "src"), pkg());
		const writer = await paused(t, dir, "object-published", {
			op: "importPackage",
			args: { sourceDirectory: src, storeRoot: store },
		});
		await writer.kill();
		exactTree(listFiles(objectTree(store, GOLDEN)), pkg());
		assert.equal(existsSync(identityPath(store, NAME, "1.0.0")), false);
		assert.equal(await read(t, dir, store), null);
		await rejects(
			() => sut.importPackage({ sourceDirectory: src, storeRoot: store }),
			[/store-busy/],
		);
		const orphan = fingerprint(path.join(store, "objects"));
		const member = ino(path.join(objectTree(store, GOLDEN), "package.yaml"));
		assert.equal(
			(
				await sut.recoverStore({
					storeRoot: store,
					confirmNoActiveWriter: true,
				})
			).lock,
			true,
		);
		assert.deepEqual(fingerprint(path.join(store, "objects")), orphan);
		await sut.importPackage({ sourceDirectory: src, storeRoot: store });
		checkPublished(store, pkg());
		assert.equal(
			ino(path.join(objectTree(store, GOLDEN), "package.yaml")),
			member,
		);
		exactTree(files(await read(t, dir, store)), pkg());
	},
);

behavior(
	"C07 corrupt orphan object after interruption is neither reused nor replaced",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const src = writeTree(path.join(dir, "src"), pkg());
		await (
			await paused(t, dir, "object-published", {
				op: "importPackage",
				args: { sourceDirectory: src, storeRoot: store },
			})
		).kill();
		await sut.recoverStore({ storeRoot: store, confirmNoActiveWriter: true });
		writeFileSync(
			path.join(objectTree(store, GOLDEN), "SKILL.md"),
			Buffer.from(SKILL.toString().replace("BODY", "EVIL")),
		);
		const damaged = fingerprint(path.join(store, "objects"));
		await rejects(() =>
			sut.importPackage({ sourceDirectory: src, storeRoot: store }),
		);
		assert.deepEqual(fingerprint(path.join(store, "objects")), damaged);
		assert.equal(existsSync(identityPath(store, NAME, "1.0.0")), false);
	},
);

behavior(
	"C07 kill after mapping commit leaves a complete committed revision behind a stale lock",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const src = writeTree(path.join(dir, "src"), pkg());
		await (
			await paused(t, dir, "mapping-committed", {
				op: "importPackage",
				args: { sourceDirectory: src, storeRoot: store },
			})
		).kill();
		checkPublished(store, pkg());
		exactTree(files(await read(t, dir, store)), pkg());
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: writeTree(path.join(dir, "v2"), V2),
					storeRoot: store,
				}),
			[/store-busy/],
		);
		const committed = fingerprint(path.join(store, "identities")).concat(
			fingerprint(path.join(store, "objects")),
		);
		assert.equal(
			(
				await sut.recoverStore({
					storeRoot: store,
					confirmNoActiveWriter: true,
				})
			).lock,
			true,
		);
		assert.deepEqual(
			fingerprint(path.join(store, "identities")).concat(
				fingerprint(path.join(store, "objects")),
			),
			committed,
		);
		assert.equal(
			(await sut.importPackage({ sourceDirectory: src, storeRoot: store }))
				.status,
			"reused",
		);
	},
);

behavior(
	"C07 independent reader processes see only complete committed trees while a writer is paused",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		await committedOther(t, dir, store);
		const writer = await paused(t, dir, "copied", {
			op: "importPackage",
			args: {
				sourceDirectory: writeTree(path.join(dir, "src"), pkg()),
				storeRoot: store,
			},
		});
		assert.equal(await read(t, dir, store), null);
		exactTree(files(await read(t, dir, store, NAME, "2.0.0")), V2);
		const result = await writer.release();
		assert.ok(result.output?.ok, JSON.stringify(result));
		exactTree(files(await read(t, dir, store)), pkg());
	},
);

behavior(
	"C07 concurrent writer processes get store-busy without stealing; explicit retry publishes or reuses",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const first = await paused(t, dir, "copied", {
			op: "importPackage",
			args: {
				sourceDirectory: writeTree(path.join(dir, "a"), pkg()),
				storeRoot: store,
			},
		});
		const lock = fingerprint(lockPath(store));
		assert.ok(lock.length > 0, "writer lock owner record present");
		const different = {
			sourceDirectory: writeTree(path.join(dir, "b"), V2),
			storeRoot: store,
		};
		const same = {
			sourceDirectory: writeTree(path.join(dir, "c"), pkg()),
			storeRoot: store,
		};
		for (const args of [different, same]) {
			const busy = await write(t, dir, args);
			assert.equal(busy.ok, false);
			assert.match(busy.message, /store-busy/);
			assert.deepEqual(fingerprint(lockPath(store)), lock);
		}
		assert.ok((await first.release()).output?.ok);
		assert.equal((await write(t, dir, different)).result.status, "published");
		assert.equal((await write(t, dir, same)).result.status, "reused");
		assert.deepEqual(
			readdirSync(path.join(store, "objects", "sha256")).sort(),
			[GOLDEN, digest(V2)].sort(),
		);
	},
);

behavior(
	"C07 an old or dead-owner writer lock is never stolen; recovery requires operator confirmation",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		mkdirSync(lockPath(store), { recursive: true });
		const owner = path.join(lockPath(store), "owner.json");
		writeFileSync(
			owner,
			JSON.stringify({ pid: 2147483646, created: "2000-01-01T00:00:00.000Z" }),
		);
		utimesSync(owner, new Date("2000-01-01"), new Date("2000-01-01"));
		const lock = fingerprint(lockPath(store));
		await rejects(
			() =>
				sut.importPackage({
					sourceDirectory: writeTree(path.join(dir, "src"), pkg()),
					storeRoot: store,
				}),
			[/store-busy/],
		);
		for (const confirmNoActiveWriter of [undefined, false, "yes"])
			await rejects(() =>
				sut.recoverStore({ storeRoot: store, confirmNoActiveWriter }),
			);
		assert.deepEqual(fingerprint(lockPath(store)), lock);
		assert.deepEqual(published(store), []);
	},
);

const renameFailures = [
	["EXDEV", /unsupported-filesystem/],
	["ENOTSUP", /unsupported-filesystem/],
	["EOPNOTSUPP", /unsupported-filesystem/],
	["EPERM", /publication-denied/],
	["EACCES", /publication-denied/],
	["EIO", /EIO/],
];
for (const [code, token] of renameFailures) {
	behavior(
		`C07 observed object rename ${code} is reported without copying fallback`,
		async (t) => {
			const dir = scratch(t);
			const store = path.join(dir, "store");
			const src = writeTree(path.join(dir, "src"), pkg());
			const rename = () => {
				throw Object.assign(new Error("injected rename failure"), { code });
			};
			await assert.rejects(
				async () =>
					sut.importPackage({ sourceDirectory: src, storeRoot: store, rename }),
				(error) => {
					assert.match(error.message, token);
					assert.match(error.message, new RegExp(code));
					if (code === "EIO")
						assert.doesNotMatch(
							error.message,
							/unsupported-filesystem|publication-denied/,
						);
					return true;
				},
			);
			assert.deepEqual(published(store), []);
			assert.equal(existsSync(lockPath(store)), false);
		},
	);
}

behavior(
	"C07 identity rename EPERM leaves no mapping; any published object is complete and reusable",
	async (t) => {
		const dir = scratch(t);
		const store = path.join(dir, "store");
		const src = writeTree(path.join(dir, "src"), pkg());
		let calls = 0;
		const rename = (from, to) => {
			if (calls++)
				throw Object.assign(new Error("injected rename failure"), {
					code: "EPERM",
				});
			renameSync(from, to);
		};
		await rejects(
			() =>
				sut.importPackage({ sourceDirectory: src, storeRoot: store, rename }),
			[/publication-denied/, /EPERM/],
		);
		assert.equal(existsSync(identityPath(store, NAME, "1.0.0")), false);
		if (existsSync(objectTree(store, GOLDEN)))
			exactTree(listFiles(objectTree(store, GOLDEN)), pkg());
		await sut.importPackage({ sourceDirectory: src, storeRoot: store });
		checkPublished(store, pkg());
	},
);

behavior(
	"store cache switch: off re-reads every object file; unknown values are refused",
	async (t) => {
		const dir = scratch(t);
		const src = writeTree(path.join(dir, "src"), pkg());
		const store = path.join(dir, "store");
		await sut.importPackage({ sourceDirectory: src, storeRoot: store });
		const previous = process.env.AGENT_PROFILES_STORE_CACHE;
		t.after(() => {
			if (previous === undefined) delete process.env.AGENT_PROFILES_STORE_CACHE;
			else process.env.AGENT_PROFILES_STORE_CACHE = previous;
		});
		const treeOpens = (setting) => {
			process.env.AGENT_PROFILES_STORE_CACHE = setting;
			let opens = 0;
			const real = fs.openSync;
			const mock = t.mock.method(fs, "openSync", (file, ...args) => {
				if (String(file).includes(`${path.sep}tree${path.sep}`)) opens++;
				return real(file, ...args);
			});
			syncBuiltinESMExports();
			try {
				sut.storeSession(() => {
					for (let i = 0; i < 2; i++)
						sut.lookupPackage({
							storeRoot: store,
							name: NAME,
							version: "1.0.0",
						});
				});
			} finally {
				mock.mock.restore();
				syncBuiltinESMExports();
			}
			return opens;
		};
		const files = pkg().length;
		assert.equal(treeOpens("off"), 2 * files);
		// At most one read per file in a session; fewer when an earlier verification is still valid.
		assert.ok(treeOpens("on") <= files);
		process.env.AGENT_PROFILES_STORE_CACHE = "false";
		assert.throws(
			() =>
				sut.lookupPackage({ storeRoot: store, name: NAME, version: "1.0.0" }),
			/AGENT_PROFILES_STORE_CACHE: expected on or off, got "false"/,
		);
	},
);
