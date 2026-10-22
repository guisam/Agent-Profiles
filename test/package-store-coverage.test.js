import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	importPackage,
	lookupPackage,
	recoverStore,
} from "../src/package-store.js";
import { readPackage } from "../src/packages.js";

const VERSION = "1.0.0";
const OLD = "@a/old";
const NEW = "@a/new";
const WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/store-coverage-worker.mjs", import.meta.url),
);
const EXISTING_WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/store-worker.mjs", import.meta.url),
);

function scratch(t) {
	const root = realpathSync(
		mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i20-")),
	);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function source(root, name = NEW) {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		path.join(root, "package.yaml"),
		`schema_version: 1\npackage:\n  name: "${name}"\n  version: "${VERSION}"\n  type: instruction\nentrypoint: entry.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n`,
	);
	writeFileSync(path.join(root, "entry.md"), Buffer.from("Exact body\r\n\n"));
	writeFileSync(
		path.join(root, "asset.bin"),
		Buffer.from([0, 255, 128, 13, 10]),
	);
	return root;
}

// Independent inventory preserves empty directories, link targets and every raw byte.
function tree(root) {
	if (!existsSync(root)) return null;
	const entries = [];
	function visit(target, relative) {
		const stat = lstatSync(target, { bigint: true });
		const type = stat.isSymbolicLink()
			? "link"
			: stat.isDirectory()
				? "directory"
				: stat.isFile()
					? "file"
					: "special";
		const entry = {
			path: relative,
			type,
			ino: String(stat.ino),
			mode: String(stat.mode),
			nlink: String(stat.nlink),
		};
		if (type === "file") entry.bytes = readFileSync(target).toString("hex");
		if (type === "link") entry.target = readlinkSync(target);
		entries.push(entry);
		if (type === "directory")
			for (const name of readdirSync(target).sort())
				visit(path.join(target, name), relative ? `${relative}/${name}` : name);
	}
	visit(root, "");
	return entries;
}

function seed(root) {
	const store = path.join(root, "s");
	const oldSource = source(path.join(root, "old"), OLD);
	const published = importPackage({
		sourceDirectory: oldSource,
		storeRoot: store,
	});
	return { store, published, oldFiles: readPackage({ root: oldSource }).files };
}

function exactLookup(store, name, expected, sha256) {
	const found = lookupPackage({ storeRoot: store, name, version: VERSION });
	assert.ok(found);
	assert.deepEqual(found.identity, { name, version: VERSION });
	if (sha256) assert.equal(found.sha256, sha256);
	assert.deepEqual(found.files, expected);
}

function refusal(fn, message, t) {
	assert.throws(fn, (error) => {
		t.diagnostic(`observed refusal: ${error.message}`);
		assert.equal(error.message, message);
		return true;
	});
}

function child(t, root, request, fixture = WORKER) {
	const env = {
		...process.env,
		TMP: root,
		TEMP: root,
		TMPDIR: root,
		HOME: root,
		USERPROFILE: root,
		AGENT_PROFILES_STORE: path.join(root, "unused-store"),
	};
	const processChild = spawn(
		process.execPath,
		[fixture, JSON.stringify(request)],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	processChild.stdout.on("data", (bytes) => {
		stdout += bytes;
	});
	processChild.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	const closed = new Promise((resolve, reject) => {
		processChild.once("error", reject);
		processChild.once("close", (code, signal) => {
			try {
				assert.equal(code, 0, JSON.stringify({ code, signal, stdout, stderr }));
				assert.equal(stderr, "");
				resolve(JSON.parse(stdout.trim()));
			} catch (error) {
				reject(error);
			}
		});
	});
	// Attach immediately, including when a writer is intentionally held at a barrier.
	closed.catch(() => {});
	t.after(() => {
		if (processChild.exitCode === null && processChild.signalCode === null)
			processChild.kill("SIGKILL");
	});
	return { processChild, closed };
}

function leftovers(store) {
	for (const name of ["package-a-valid", "package-b-valid"]) {
		const directory = path.join(store, ".staging", name, "object", "tree");
		mkdirSync(path.join(directory, "empty"), { recursive: true });
		writeFileSync(
			path.join(directory, "bytes.bin"),
			Buffer.from([255, 0, 13, 10]),
		);
	}
	mkdirSync(path.join(store, ".writer-lock"));
	writeFileSync(
		path.join(store, ".writer-lock", "owner.json"),
		'{"pid":42,"operation":"preserve-exactly"}\n',
	);
}

test("C07 recovery removes safe leftovers and preserves committed content", (t) => {
	const { store, published, oldFiles } = seed(scratch(t));
	const objects = tree(path.join(store, "objects"));
	const identities = tree(path.join(store, "identities"));
	leftovers(store);
	assert.deepEqual(
		recoverStore({ storeRoot: store, confirmNoActiveWriter: true }),
		{ lock: true, staging: ["package-a-valid", "package-b-valid"] },
	);
	assert.deepEqual(readdirSync(path.join(store, ".staging")), []);
	assert.equal(existsSync(path.join(store, ".writer-lock")), false);
	assert.deepEqual(tree(path.join(store, "objects")), objects);
	assert.deepEqual(tree(path.join(store, "identities")), identities);
	exactLookup(store, OLD, oldFiles, published.sha256);
});

test("C07 recovery preflights valid-before-unknown leftovers without changing any state", (t) => {
	const root = scratch(t);
	const { store, published, oldFiles } = seed(root);
	leftovers(store);
	mkdirSync(path.join(store, ".staging", "z-unknown"));
	writeFileSync(
		path.join(store, ".staging", "z-unknown", "keep"),
		"unknown\0bytes",
	);
	assert.deepEqual(readdirSync(path.join(store, ".staging")).sort(), [
		"package-a-valid",
		"package-b-valid",
		"z-unknown",
	]);
	const before = tree(root);
	refusal(
		() => recoverStore({ storeRoot: store, confirmNoActiveWriter: true }),
		"recovery: unknown staging entry",
		t,
	);
	assert.deepEqual(tree(root), before);
	exactLookup(store, OLD, oldFiles, published.sha256);
});

test("C07 recovery preflights valid-before-linked-descendant leftovers without traversing the link", (t) => {
	const root = scratch(t);
	const { store, published, oldFiles } = seed(root);
	leftovers(store);
	const outside = path.join(root, "outside");
	mkdirSync(outside);
	writeFileSync(path.join(outside, "keep.bin"), Buffer.from([0, 128, 255]));
	const bad = path.join(store, ".staging", "package-z-invalid");
	mkdirSync(bad);
	try {
		symlinkSync(
			outside,
			path.join(bad, "unsafe"),
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		if (
			!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
				error.code,
			)
		)
			throw error;
		t.skip(
			`directory link support probe failed: ${error.code}: ${error.message}`,
		);
		return;
	}
	assert.equal(lstatSync(path.join(bad, "unsafe")).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(path.join(store, ".staging")).sort(), [
		"package-a-valid",
		"package-b-valid",
		"package-z-invalid",
	]);
	const before = tree(root);
	refusal(
		() => recoverStore({ storeRoot: store, confirmNoActiveWriter: true }),
		"unsafe: unsupported member type symlink; links and special files are forbidden",
		t,
	);
	assert.deepEqual(tree(root), before);
	exactLookup(store, OLD, oldFiles, published.sha256);
});

for (const part of ["namespace", "name"]) {
	test(`C05/C06 encoded ${part} last accepted and first rejected component`, async (t) => {
		const root = scratch(t);
		const { store, published, oldFiles } = seed(root);
		// Contract E(s): two prefix bytes plus two hex digits per ASCII identity byte.
		const limit = 255;
		const last = Math.floor((limit - Buffer.byteLength("x-")) / 2);
		assert.equal(last, 126);
		const identity = (length) =>
			part === "namespace"
				? `@${"a".repeat(length)}/b`
				: `@a/${"b".repeat(length)}`;
		const accepted = identity(last);
		const rejected = identity(last + 1);
		const good = source(path.join(root, "good"), accepted);
		const bad = source(path.join(root, "bad"), rejected);
		assert.equal(readPackage({ root: good }).manifest.package.name, accepted);
		assert.equal(readPackage({ root: bad }).manifest.package.name, rejected);
		await t.test(
			"accepted control imports and looks up the full package",
			(t) => {
				// Probe the same full path length separately, so MAX_PATH is never mistaken for the identity rule.
				const encoded = `x-${(part === "namespace" ? "61" : "62").repeat(last)}`;
				const probe = path.join(
					root,
					"p",
					"identities",
					part === "namespace" ? encoded : "x-61",
					part === "name" ? encoded : "x-62",
				);
				t.diagnostic(
					`accepted mapping length: ${path.join(probe, `${VERSION}.json`).length} UTF-16 units; component ${2 + 2 * last} bytes`,
				);
				try {
					mkdirSync(probe, { recursive: true });
					writeFileSync(path.join(probe, `${VERSION}.json`), "probe");
				} catch (error) {
					if (!["ENAMETOOLONG", "ENOENT"].includes(error.code)) throw error;
					t.skip(
						`full-path support probe failed before import: ${error.code}: ${error.message}`,
					);
					return;
				} finally {
					rmSync(path.join(root, "p"), { recursive: true, force: true });
				}
				const result = importPackage({
					sourceDirectory: good,
					storeRoot: store,
				});
				assert.equal(result.status, "published");
				exactLookup(
					store,
					accepted,
					readPackage({ root: good }).files,
					result.sha256,
				);
			},
		);
		const before = tree(store);
		assert.equal(2 + 2 * (last + 1), 256);
		refusal(
			() => importPackage({ sourceDirectory: bad, storeRoot: store }),
			"identity: generated component path-length exceeds backend limit",
			t,
		);
		refusal(
			() =>
				lookupPackage({ storeRoot: store, name: rejected, version: VERSION }),
			"identity: generated component path-length exceeds backend limit",
			t,
		);
		assert.deepEqual(tree(store), before);
		exactLookup(store, OLD, oldFiles, published.sha256);
	});
}

for (const mismatch of [false, true]) {
	test(`C07 native stat device ${mismatch ? "mismatch refuses before any rename" : "same-device control publishes"}`, async (t) => {
		const root = scratch(t);
		const { store, published, oldFiles } = seed(root);
		const incoming = source(path.join(root, "incoming"));
		const before = tree(store);
		const result = await child(t, root, {
			mode: "device",
			mismatch,
			args: { sourceDirectory: incoming, storeRoot: store },
		}).closed;
		t.diagnostic(JSON.stringify(result));
		assert.equal(
			result.counts.deviceReads,
			1,
			"the override must reach only the publication comparison",
		);
		if (mismatch) {
			assert.equal(result.ok, false);
			assert.equal(
				result.message,
				"unsupported-filesystem: staging/final device mismatch",
			);
			assert.equal(result.code, null, "not an injected EXDEV error");
			assert.equal(result.counts.renames, 0);
			assert.deepEqual(result.phases, ["source-read", "copied"]);
			assert.equal(
				lookupPackage({ storeRoot: store, name: NEW, version: VERSION }),
				null,
			);
			assert.deepEqual(tree(store), before);
		} else {
			assert.equal(result.ok, true);
			assert.equal(result.counts.renames, 2);
			assert.deepEqual(result.phases, [
				"source-read",
				"copied",
				"object-published",
				"mapping-committed",
			]);
			exactLookup(
				store,
				NEW,
				readPackage({ root: incoming }).files,
				result.result.sha256,
			);
		}
		exactLookup(store, OLD, oldFiles, published.sha256);
	});
}

test("C05/C07 local roots publish without acquisition or network access", async (t) => {
	const root = scratch(t);
	const store = path.join(root, "s");
	const incoming = source(path.join(root, "incoming"));
	const result = await child(t, root, {
		mode: "nonlocal",
		args: { sourceDirectory: incoming, storeRoot: store },
	}).closed;
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.counts.remoteAccess, 0);
	assert.equal(result.counts.network, 0);
	assert.ok(result.counts.mutations > 0, "the mutation observer is active");
	exactLookup(
		store,
		NEW,
		readPackage({ root: incoming }).files,
		result.result.sha256,
	);
});

for (const remote of [
	"\\\\issue20.invalid\\share\\package",
	"//issue20.invalid/share/package",
	"file://issue20.invalid/share/package",
	"https://issue20.invalid/package",
]) {
	for (const selection of ["source", "store", "lookup", "recovery"]) {
		test(`C05/C07 ${selection} refuses nonlocal ${JSON.stringify(remote)} before IO`, async (t) => {
			const root = scratch(t);
			const { store, published, oldFiles } = seed(root);
			const incoming = source(path.join(root, "incoming"));
			const before = tree(root);
			const op =
				selection === "lookup"
					? "lookupPackage"
					: selection === "recovery"
						? "recoverStore"
						: "importPackage";
			const args =
				selection === "source"
					? { sourceDirectory: remote, storeRoot: store }
					: {
							sourceDirectory: incoming,
							storeRoot: remote,
							name: NEW,
							version: VERSION,
							confirmNoActiveWriter: true,
						};
			const result = await child(t, root, { mode: "nonlocal", op, args })
				.closed;
			t.diagnostic(JSON.stringify(result));
			assert.equal(result.ok, false);
			assert.equal(
				result.message,
				`${selection === "source" ? "source" : "store"}: unsupported-filesystem: nonlocal path`,
			);
			assert.equal(result.counts.remoteAccess, 0);
			assert.equal(result.counts.network, 0);
			assert.equal(
				result.counts.mutations,
				0,
				"no writer acquisition, staging, or publication",
			);
			assert.deepEqual(tree(root), before);
			exactLookup(store, OLD, oldFiles, published.sha256);
		});
	}
}

test("C04/C05 ordinary separate files are accepted; a hard-linked source member is refused", async (t) => {
	const root = scratch(t);
	const { store, published, oldFiles } = seed(root);
	const incoming = source(path.join(root, "incoming"));
	writeFileSync(
		path.join(incoming, "copy.bin"),
		readFileSync(path.join(incoming, "asset.bin")),
	);
	const control = importPackage({
		sourceDirectory: incoming,
		storeRoot: store,
	});
	exactLookup(
		store,
		NEW,
		readPackage({ root: incoming }).files,
		control.sha256,
	);
	await t.test("hardlink support probe and unchanged-store refusal", (t) => {
		const bad = source(path.join(root, "bad"), "@a/hardlink");
		try {
			linkSync(path.join(bad, "asset.bin"), path.join(bad, "copy.bin"));
		} catch (error) {
			if (
				![
					"EPERM",
					"EACCES",
					"ENOTSUP",
					"EOPNOTSUPP",
					"ENOSYS",
					"EXDEV",
				].includes(error.code)
			)
				throw error;
			t.skip(`hardlink support probe failed: ${error.code}: ${error.message}`);
			return;
		}
		assert.ok(lstatSync(path.join(bad, "asset.bin")).nlink > 1);
		const before = tree(root);
		refusal(
			() => importPackage({ sourceDirectory: bad, storeRoot: store }),
			"asset.bin: hard-linked file (nlink > 1) is forbidden",
			t,
		);
		assert.deepEqual(tree(root), before);
		assert.equal(
			lookupPackage({
				storeRoot: store,
				name: "@a/hardlink",
				version: VERSION,
			}),
			null,
		);
		exactLookup(store, OLD, oldFiles, published.sha256);
	});
});

for (const member of ["caf\u00e9.bin", "cafe\u0301.bin", "\u96ea.bin"]) {
	test(`C04/C05 Unicode source member ${JSON.stringify(member)} refuses while ASCII control imports`, (t) => {
		const root = scratch(t);
		const { store, published, oldFiles } = seed(root);
		const incoming = source(path.join(root, "incoming"));
		writeFileSync(path.join(incoming, "cafe.bin"), "portable");
		const result = importPackage({
			sourceDirectory: incoming,
			storeRoot: store,
		});
		exactLookup(
			store,
			NEW,
			readPackage({ root: incoming }).files,
			result.sha256,
		);
		const bad = source(path.join(root, "bad"), "@a/unicode");
		writeFileSync(path.join(bad, member), "nonportable");
		assert.ok(
			readdirSync(bad).some((name) => /[^\x00-\x7f]/.test(name)),
			"real non-ASCII fixture member",
		);
		const before = tree(root);
		refusal(
			() => importPackage({ sourceDirectory: bad, storeRoot: store }),
			"member path: expected a portable relative ASCII path",
			t,
		);
		assert.deepEqual(tree(root), before);
		assert.equal(
			lookupPackage({ storeRoot: store, name: "@a/unicode", version: VERSION }),
			null,
		);
		exactLookup(store, OLD, oldFiles, published.sha256);
	});
}

test("C04/C05 regular member control imports; supported filesystem socket is refused without reading", async (t) => {
	const root = scratch(t);
	const { store, published, oldFiles } = seed(root);
	const incoming = source(path.join(root, "incoming"));
	writeFileSync(path.join(incoming, "special"), "ordinary file");
	const control = importPackage({
		sourceDirectory: incoming,
		storeRoot: store,
	});
	exactLookup(
		store,
		NEW,
		readPackage({ root: incoming }).files,
		control.sha256,
	);
	await t.test(
		"filesystem socket support probe and unchanged-store refusal",
		async (t) => {
			const bad = source(path.join(root, "bad"), "@a/special");
			const socket = path.join(bad, "special");
			const server = net.createServer();
			try {
				try {
					await new Promise((resolve, reject) => {
						server.once("error", reject);
						server.listen(socket, resolve);
					});
				} catch (error) {
					if (
						![
							"EPERM",
							"EACCES",
							"ENOTSUP",
							"EOPNOTSUPP",
							"ENOSYS",
							"EINVAL",
							"ENOENT",
							"ENAMETOOLONG",
						].includes(error.code)
					)
						throw error;
					t.skip(
						`filesystem socket support probe failed: ${error.code}: ${error.message}`,
					);
					return;
				}
				assert.equal(lstatSync(socket).isSocket(), true);
				const before = tree(root);
				refusal(
					() => importPackage({ sourceDirectory: bad, storeRoot: store }),
					"special: unsupported member type special; links and special files are forbidden",
					t,
				);
				assert.deepEqual(tree(root), before);
				assert.equal(
					lookupPackage({
						storeRoot: store,
						name: "@a/special",
						version: VERSION,
					}),
					null,
				);
				exactLookup(store, OLD, oldFiles, published.sha256);
			} finally {
				if (server.listening)
					await new Promise((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
			}
		},
	);
});

test("C07 independent reader sees no identity between object publication and mapping commit", async (t) => {
	const root = scratch(t);
	const { store, published, oldFiles } = seed(root);
	const incoming = source(path.join(root, "incoming"));
	const expected = readPackage({ root: incoming });
	const oldObjects = tree(
		path.join(store, "objects", "sha256", published.sha256),
	);
	const oldIdentities = tree(path.join(store, "identities"));
	const marker = path.join(root, "object-published.marker");
	const release = path.join(root, "object-published.release");
	let writer;
	let timer;
	let watcher;
	const ready = new Promise((resolve, reject) => {
		// Register before spawning: an actual phase marker, not elapsed time, releases the reader.
		watcher = watch(root, () => {
			if (
				existsSync(marker) &&
				readFileSync(marker, "utf8") === "object-published"
			)
				resolve();
		});
		watcher.on("error", reject);
		timer = setTimeout(
			() =>
				reject(
					new Error("writer did not reach object-published within 20000ms"),
				),
			20000,
		);
		writer = child(
			t,
			root,
			{
				op: "importPackage",
				args: { sourceDirectory: incoming, storeRoot: store },
				barrier: { phase: "object-published", marker, release },
			},
			EXISTING_WORKER,
		);
		writer.closed.then(
			(result) =>
				reject(
					new Error(`writer exited before release: ${JSON.stringify(result)}`),
				),
			reject,
		);
	});
	try {
		await ready;
		clearTimeout(timer);
		watcher.close();
		assert.equal(readFileSync(marker, "utf8"), "object-published");
		assert.equal(writer.processChild.exitCode, null);
		assert.equal(
			existsSync(path.join(store, ".writer-lock", "owner.json")),
			true,
		);
		assert.deepEqual(
			readdirSync(path.join(store, "objects", "sha256")).sort(),
			[published.sha256, expected.sha256].sort(),
		);
		assert.deepEqual(
			readdirSync(path.join(store, "objects", "sha256", expected.sha256)),
			["tree"],
		);
		const objectFiles = tree(
			path.join(store, "objects", "sha256", expected.sha256, "tree"),
		).filter((entry) => entry.type === "file");
		assert.deepEqual(
			objectFiles.map((entry) => ({
				path: entry.path,
				bytes: Buffer.from(entry.bytes, "hex"),
			})),
			expected.files,
		);
		assert.deepEqual(tree(path.join(store, "identities")), oldIdentities);
		const unseenReader = child(
			t,
			root,
			{
				op: "lookupPackage",
				args: { storeRoot: store, name: NEW, version: VERSION },
			},
			EXISTING_WORKER,
		);
		assert.notEqual(unseenReader.processChild.pid, writer.processChild.pid);
		assert.notEqual(unseenReader.processChild.pid, process.pid);
		const unseen = await unseenReader.closed;
		assert.deepEqual(unseen, { ok: true, result: null });
		const oldReader = child(
			t,
			root,
			{
				op: "lookupPackage",
				args: { storeRoot: store, name: OLD, version: VERSION },
			},
			EXISTING_WORKER,
		);
		assert.notEqual(oldReader.processChild.pid, writer.processChild.pid);
		assert.notEqual(oldReader.processChild.pid, process.pid);
		const previous = await oldReader.closed;
		assert.equal(previous.ok, true);
		assert.equal(previous.result.sha256, published.sha256);
		assert.deepEqual(
			previous.result.files.map((file) => ({
				path: file.path,
				bytes: Buffer.from(file.bytes.data),
			})),
			oldFiles,
		);
		assert.equal(existsSync(release), false);
		assert.deepEqual(
			tree(path.join(store, "objects", "sha256", published.sha256)),
			oldObjects,
		);
		writeFileSync(release, "release after both independent readers");
		const committed = await writer.closed;
		assert.equal(committed.ok, true, JSON.stringify(committed));
		assert.equal(committed.result.sha256, expected.sha256);
		const after = await child(
			t,
			root,
			{
				op: "lookupPackage",
				args: { storeRoot: store, name: NEW, version: VERSION },
			},
			EXISTING_WORKER,
		).closed;
		assert.equal(after.ok, true);
		assert.equal(after.result.sha256, expected.sha256);
		assert.deepEqual(
			after.result.files.map((file) => ({
				path: file.path,
				bytes: Buffer.from(file.bytes.data),
			})),
			expected.files,
		);
		exactLookup(store, OLD, oldFiles, published.sha256);
		assert.deepEqual(
			tree(path.join(store, "objects", "sha256", published.sha256)),
			oldObjects,
		);
		assert.equal(existsSync(path.join(store, ".writer-lock")), false);
		assert.deepEqual(readdirSync(path.join(store, ".staging")), []);
	} finally {
		clearTimeout(timer);
		watcher?.close();
		if (!existsSync(release))
			writeFileSync(release, "release on assertion failure");
		if (writer) await writer.closed;
	}
});
