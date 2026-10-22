import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { resolveInstructions } from "../src/resolve.js";
import { createStamp, verifyStamp, reconstructStamp } from "../src/stamps.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const skillBytes = (name) =>
	Buffer.from(
		`---\nname: ${name}\ndescription: Local skill\n---\nLocal body\n`,
	);

// Independent finite fixture oracle, using the existing stamp RECORD framing.
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
function record(snapshot) {
	const bytes = Buffer.from(canonical(snapshot)),
		length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return {
		bytes,
		digest: sha(
			Buffer.concat([Buffer.from("agent-profiles/stamp/v1\0"), length, bytes]),
		),
	};
}
function fingerprint(root) {
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
function fixture(t, native = false) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "stamp-review-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store");
	const profile = path.join(root, ".agent-profiles/profiles/base.md"),
		skill = path.join(root, "instructions/local.md");
	put(profile, "# Profile\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		JSON.stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: {},
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: {
						required: native ? [] : ["local"],
						available: native ? ["personal"] : [],
					},
				},
			},
			skills: native
				? { personal: { host: "claude", scope: "user", id: "personal" } }
				: { local: { file: "instructions/local.md" } },
		}),
	);
	if (!native) put(skill, skillBytes("old"));
	const options = { root, storeRoot, host: "claude", sharedFiles: [] };
	const resolved = resolveInstructions({ root, storeRoot, host: "claude" });
	assert.equal(resolved.lockMode, "required");
	assert.equal(resolved.lockState, "not-required");
	if (native) assert.equal(resolved.available[0].hostId, "personal");
	else assert.equal(resolved.required[0].name, "old");
	return { root, storeRoot, profile, skill, options };
}
function capture(f) {
	const valid = createStamp(f.options),
		independent = record(valid.snapshot);
	assert.equal(
		valid.digest,
		independent.digest,
		"independent canonical RECORD matches the valid stamp",
	);
	assert.deepEqual(
		fs.readFileSync(
			path.join(f.storeRoot, "stamps/sha256", valid.digest, "snapshot.json"),
		),
		independent.bytes,
	);
	const report = verifyStamp({ digest: valid.digest, storeRoot: f.storeRoot });
	assert.equal(report.snapshotIntegrity, "verified");
	assert.equal(report.managedContent, "verified");
	assert.equal(report.managedReconstruction, "verified");
	assert.equal(report.managedReproducible, true);
	return valid;
}

test("P6A-R01 unchanged local metadata publishes a verifiable stamp", (t) => {
	const f = fixture(t),
		before = fingerprint(f.root),
		valid = capture(f);
	assert.equal(valid.snapshot.required[0].name, "old");
	const restored = reconstructStamp({
		digest: valid.digest,
		storeRoot: f.storeRoot,
	});
	assert.deepEqual(
		restored.composition.find((e) => e.id === "local").bytes,
		skillBytes("old"),
	);
	assert.deepEqual(fingerprint(f.root), before);
});

test("P6A-R01 concurrent local metadata edit refuses before snapshot publication", (t) => {
	const f = fixture(t),
		edited = skillBytes("new");
	const originalRead = fs.readFileSync,
		originalRename = fs.renameSync;
	const publications = [];
	let mutations = 0,
		failure;
	fs.readFileSync = function (file, ...args) {
		const bytes = originalRead.call(this, file, ...args);
		// Resolver metadata is collected before this profile read; raw capture follows it.
		if (
			!mutations &&
			typeof file === "string" &&
			path.resolve(file) === f.profile
		) {
			mutations++;
			put(f.skill, edited);
		}
		return bytes;
	};
	fs.renameSync = function (from, to) {
		if (path.dirname(to) === path.join(f.storeRoot, "stamps/sha256"))
			publications.push(to);
		return originalRename.call(this, from, to);
	};
	syncBuiltinESMExports();
	try {
		createStamp(f.options);
	} catch (error) {
		failure = error;
	} finally {
		fs.readFileSync = originalRead;
		fs.renameSync = originalRename;
		syncBuiltinESMExports();
	}
	assert.equal(
		mutations,
		1,
		"the owned concurrent edit must fire exactly once",
	);
	assert.deepEqual(
		fs.readFileSync(f.skill),
		edited,
		"creation must preserve the user edit",
	);
	assert.equal(
		resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			host: "claude",
		}).required[0].name,
		"new",
		"edited input remains valid",
	);
	assert.deepEqual(
		publications,
		[],
		"no final snapshot may become visible, even temporarily",
	);
	const snapshots = path.join(f.storeRoot, "stamps/sha256");
	assert.deepEqual(
		fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : [],
		[],
	);
	assert.match(
		failure?.message ?? "",
		/^snapshot relation skill metadata: local\.name disagreement$/,
	);
});

test("P6A-R02 string native identifier retains managed verification without runtime claims", (t) => {
	const f = fixture(t, true),
		valid = capture(f),
		before = fingerprint(f.storeRoot);
	assert.equal(valid.snapshot.hostReferences[0].hostId, "personal");
	const input = { digest: valid.digest, storeRoot: f.storeRoot };
	const report = verifyStamp(input),
		restored = reconstructStamp(input);
	assert.equal(restored.hostReferences[0].hostId, "personal");
	assert.equal(report.hostDependencies, "unverified");
	assert.equal(report.hostInvocation, "unverified");
	assert.equal(report.runtimeIdentity, "unverified");
	assert.equal(report.renderedPrompt, "unverified");
	assert.equal(report.completeRuntimeReproducible, false);
	assert.deepEqual(fingerprint(f.storeRoot), before);
});

for (const operation of ["verification", "reconstruction"])
	test(`P6A-R02 numeric native identifier refuses ${operation} after canonical rehash`, (t) => {
		const f = fixture(t, true),
			valid = capture(f),
			malformed = structuredClone(valid.snapshot);
		malformed.hostReferences[0].hostId = 123;
		const changed = record(malformed);
		assert.notEqual(changed.digest, valid.digest);
		put(
			path.join(f.storeRoot, "stamps/sha256", changed.digest, "snapshot.json"),
			changed.bytes,
		);
		const before = fingerprint(f.storeRoot),
			projectBefore = fingerprint(f.root);
		const input = { digest: changed.digest, storeRoot: f.storeRoot };
		try {
			if (operation === "verification") {
				const report = verifyStamp(input);
				assert.equal(report.snapshotIntegrity, "mismatched");
				assert.equal(report.managedReproducible, false);
				assert.notEqual(report.managedReconstruction, "verified");
				assert.deepEqual(report.findings, [
					"snapshot: hostReferences: invalid native scope/identifier",
				]);
			} else {
				assert.throws(
					() => reconstructStamp(input),
					/^Error: reconstruction: snapshot: hostReferences: invalid native scope\/identifier$/,
				);
			}
		} finally {
			assert.deepEqual(
				fingerprint(f.storeRoot),
				before,
				"malformed snapshot rejection cannot alter backing or either snapshot",
			);
			assert.deepEqual(fingerprint(f.root), projectBefore);
			assert.equal(
				verifyStamp({ digest: valid.digest, storeRoot: f.storeRoot })
					.managedReproducible,
				true,
				"original string-valued stamp stays valid",
			);
		}
	});
