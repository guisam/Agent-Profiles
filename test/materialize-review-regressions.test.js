import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	planMaterialization,
	recoverMaterialization,
	verifyMaterialization,
} from "../src/materialize.ts";
import { createStamp } from "../src/stamps.ts";

const WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/materialize-worker.mjs", import.meta.url),
);
const profile = Buffer.from("\uFEFF# Profile\r\n\r\n");
const role = Buffer.from("# Role\r\n\r\n");
const keep = Buffer.from([0, 255, 13, 10]);
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};

// Preserve raw bytes and file identities; never follow links or normalize content.
function fingerprint(root) {
	const rows = [];
	function walk(directory, relative = "") {
		for (const name of fs.readdirSync(directory).sort()) {
			const file = path.join(directory, name),
				label = relative + name,
				stat = fs.lstatSync(file, { bigint: true });
			const identity = [String(stat.dev), String(stat.ino)];
			if (stat.isSymbolicLink())
				rows.push([label, "link", ...identity, fs.readlinkSync(file)]);
			else if (stat.isDirectory()) {
				rows.push([label, "directory", ...identity]);
				walk(file, `${label}/`);
			} else {
				assert.equal(stat.isFile(), true, label);
				rows.push([
					label,
					"file",
					...identity,
					String(stat.nlink),
					fs.readFileSync(file).toString("hex"),
				]);
			}
		}
	}
	walk(root);
	return rows;
}

async function committedAfterKill(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p8-f1-")));
	let child,
		closed,
		ended = false;
	t.after(async () => {
		try {
			if (child?.pid && !ended) {
				child.kill("SIGKILL");
				await closed;
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		outputRoot = path.join(dir, "out");
	for (const folder of [root, storeRoot, outputRoot]) fs.mkdirSync(folder);
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		"version: 2\ndefault_profile: base\ndefault_role: main\nmodels: {}\nfamilies: {}\nprofiles:\n  base:\n    file: profile.md\nroles:\n  main:\n    file: role.md\n    skills:\n      required: []\n      available: []\nskills: {}\n",
	);
	put(path.join(root, ".agent-profiles/profile.md"), profile);
	put(path.join(root, ".agent-profiles/role.md"), role);
	put(path.join(outputRoot, "unrelated/keep.bin"), keep);
	const stamp = createStamp({
		root,
		storeRoot,
		host: "codex",
		sharedFiles: [],
	});
	const plan = planMaterialization({
		stampDigest: stamp.digest,
		storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
	});
	const destination = path.join(outputRoot, "Run"),
		requested = path.join(outputRoot, "run");
	const marker = path.join(dir, "marker"),
		release = path.join(dir, "release");
	const args = {
		plan,
		storeRoot,
		destination,
		outputRoot,
		deniedRoots: [root],
	};
	child = spawn(
		process.execPath,
		[
			WORKER,
			JSON.stringify({
				ownedRoot: dir,
				storeRoot,
				args,
				barrier: { phase: "after-rename", marker, release },
			}),
		],
		{
			env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (bytes) => {
		stdout += bytes;
	});
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			ended = true;
			resolve({ code, signal });
		});
	});
	closed.catch(() => {});
	for (const start = Date.now(); !fs.existsSync(marker); await delay(10)) {
		assert.equal(
			ended,
			false,
			`writer ended before after-rename: ${stdout}; ${stderr}`,
		);
		assert.ok(Date.now() - start < 20000, "after-rename barrier not reached");
	}
	assert.equal(fs.readFileSync(marker, "utf8"), "after-rename");
	assert.ok(child.pid > 0 && child.pid !== process.pid);
	assert.equal(child.kill("SIGKILL"), true);
	const exit = await closed;
	assert.ok(
		exit.signal === "SIGKILL" ||
			(process.platform === "win32" && exit.code !== null && exit.code !== 0),
		JSON.stringify(exit),
	);
	assert.equal(
		stdout,
		"",
		"no acknowledgment before actual writer termination",
	);
	assert.equal(stderr, "");
	const lockName = ".materialize-x-72756e.lock",
		lock = path.join(outputRoot, lockName);
	const owner = JSON.parse(
		fs.readFileSync(path.join(lock, "owner.json"), "utf8"),
	);
	assert.deepEqual(Object.keys(owner).sort(), [
		"operation",
		"staging",
		"stampDigest",
		"target",
	]);
	assert.match(owner.operation, /^[a-zA-Z0-9-]+$/);
	assert.equal(owner.target, "Run");
	assert.equal(owner.stampDigest, stamp.digest);
	assert.equal(owner.staging, `.materialize-x-72756e-${owner.operation}.stage`);
	assert.equal(
		fs.existsSync(path.join(outputRoot, owner.staging)),
		false,
		"stage was renamed into committed final",
	);
	assert.deepEqual(
		fs.readFileSync(path.join(destination, "content/instructions/0000.md")),
		profile,
	);
	assert.deepEqual(
		fs.readFileSync(path.join(destination, "content/instructions/0001.md")),
		role,
	);
	const verify = (target) =>
		verifyMaterialization({
			destination: target,
			expectedStampDigest: stamp.digest,
			storeRoot,
		});
	assert.deepEqual(verify(destination), { verified: true, findings: [] });
	const recovery = {
		destination: requested,
		outputRoot,
		expectedStampDigest: stamp.digest,
		storeRoot,
		deniedRoots: [root],
		confirmNoActiveWriter: true,
	};
	return {
		dir,
		root,
		storeRoot,
		outputRoot,
		destination,
		requested,
		lock,
		lockName,
		stamp,
		verify,
		recovery,
	};
}

// Exact lowercase lstat absence only: all publication, backing, bytes and cleanup use native owned I/O.
async function withRequestedAbsent(t, f, body) {
	const original = fs.lstatSync;
	let nativeAlias;
	try {
		nativeAlias = original(f.requested, { bigint: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const recorded = original(f.destination, { bigint: true });
	t.diagnostic(
		`native Run/run same identity: ${Boolean(nativeAlias && nativeAlias.dev === recorded.dev && nativeAlias.ino === recorded.ino)}; lowercase-only lstat ENOENT model, not native case-sensitive-platform qualification`,
	);
	let observations = 0;
	fs.lstatSync = (file, ...args) => {
		if (typeof file === "string" && path.resolve(file) === f.requested) {
			observations++;
			throw Object.assign(new Error("owned lowercase lookup absent"), {
				code: "ENOENT",
			});
		}
		return original(file, ...args);
	};
	syncBuiltinESMExports();
	try {
		assert.throws(
			() => fs.lstatSync(f.requested),
			(error) => error.code === "ENOENT",
		);
		assert.equal(fs.lstatSync(f.destination).isDirectory(), true);
		observations = 0;
		const result = await body();
		assert.ok(
			observations > 0,
			"recovery exercised the modeled requested lookup",
		);
		return result;
	} finally {
		fs.lstatSync = original;
		syncBuiltinESMExports();
	}
}

for (const state of ["valid", "damaged-output", "missing-backing"])
	test(`F1 alternate spelling recovery ${state} verifies owner-recorded final before cleanup`, async (t) => {
		const f = await committedAfterKill(t);
		if (state === "damaged-output")
			put(
				path.join(f.destination, "content/instructions/0000.md"),
				Buffer.from([0, 255]),
			);
		const backingDigest = f.stamp.snapshot.composition[0].backing.sha256;
		if (state === "missing-backing")
			fs.unlinkSync(path.join(f.storeRoot, "blobs/sha256", backingDigest));
		const verification = f.verify(f.destination);
		assert.equal(
			verification.verified,
			state === "valid",
			JSON.stringify(verification),
		);
		if (state === "damaged-output")
			assert.ok(
				verification.findings.some(
					(s) =>
						s.startsWith("output-mismatch:") &&
						s.includes("instructions/0000.md"),
				),
				JSON.stringify(verification),
			);
		if (state === "missing-backing")
			assert.ok(
				verification.findings.some(
					(s) => s.startsWith("backing-missing:") && s.includes(backingDigest),
				),
				JSON.stringify(verification),
			);
		const before = fingerprint(f.dir),
			committed = fingerprint(f.destination);
		const recovered = await withRequestedAbsent(t, f, () =>
			recoverMaterialization(f.recovery),
		);
		const after = fingerprint(f.dir),
			final = fingerprint(f.destination),
			lockRetained = fs.existsSync(f.lock);
		const lockLabel = `out/${f.lockName}`;
		const expectedState =
			state === "valid"
				? before.filter(
						(row) =>
							row[0] !== lockLabel && !row[0].startsWith(`${lockLabel}/`),
					)
				: before;
		assert.deepEqual(
			{ recovered, after, final, lockRetained },
			{
				recovered: {
					removed: state === "valid" ? [f.lockName] : [],
					verification,
				},
				after: expectedState,
				final: committed,
				lockRetained: state !== "valid",
			},
			"recorded final verification and complete stale-state preservation are independent of requested spelling",
		);
		assert.deepEqual(f.verify(f.destination), verification);
	});

test("F1 distinct requested and owner-recorded final identities refuse ambiguity before cleanup", async (t) => {
	const f = await committedAfterKill(t),
		second = path.join(f.outputRoot, "Second");
	fs.cpSync(f.destination, second, { recursive: true });
	assert.deepEqual(f.verify(second), { verified: true, findings: [] });
	const original = fs.lstatSync,
		recorded = original(f.destination, { bigint: true }),
		distinct = original(second, { bigint: true });
	assert.equal(recorded.isDirectory(), true);
	assert.equal(distinct.isDirectory(), true);
	assert.equal(recorded.isSymbolicLink(), false);
	assert.equal(distinct.isSymbolicLink(), false);
	assert.ok(
		recorded.dev !== distinct.dev || recorded.ino !== distinct.ino,
		"two real ordinary final directories have different native identities",
	);
	const before = fingerprint(f.dir);
	let observations = 0,
		refusal;
	// Only the requested lstat returns Second's real descriptor; no bytes or other lookups are redirected.
	// This models distinct case-sensitive finals on Windows, not native platform qualification.
	fs.lstatSync = (file, ...args) => {
		if (typeof file === "string" && path.resolve(file) === f.requested) {
			observations++;
			return original(second, ...args);
		}
		return original(file, ...args);
	};
	syncBuiltinESMExports();
	try {
		assert.equal(fs.lstatSync(f.requested, { bigint: true }).ino, distinct.ino);
		assert.equal(
			fs.lstatSync(f.destination, { bigint: true }).ino,
			recorded.ino,
		);
		observations = 0;
		try {
			await recoverMaterialization(f.recovery);
		} catch (error) {
			refusal = error;
		}
	} finally {
		fs.lstatSync = original;
		syncBuiltinESMExports();
	}
	const after = fingerprint(f.dir);
	t.diagnostic(
		"exact lowercase lstat identity model backed by two distinct real ordinary directories; not native case-sensitive-platform qualification",
	);
	assert.ok(observations > 0, "recovery observed the distinct requested final");
	assert.deepEqual(
		after,
		before,
		"both finals, complete stale owner state, source, backing and unrelated sibling remain unchanged",
	);
	assert.ok(
		refusal instanceof Error,
		"distinct final identities must explicitly refuse ambiguity",
	);
	assert.match(refusal.message, /ambigu/i);
	assert.deepEqual(f.verify(f.destination), { verified: true, findings: [] });
	assert.deepEqual(f.verify(second), { verified: true, findings: [] });
});
