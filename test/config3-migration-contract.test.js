import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, * as observedFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { integrations } from "../src/integrations.ts";
import * as migrations from "../src/migrations.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage, lookupPackage } from "../src/package-store.ts";
import { readPackage } from "../src/packages.ts";
import { resolveInstructions } from "../src/resolve.ts";
import {
	readRevisionRecord,
	retainRevisionManifest,
} from "../src/revisions.ts";
import { createStamp, reconstructStamp, verifyStamp } from "../src/stamps.ts";

// The only refusal allowed to block downstream bodies: the existing config3 start guard.
const GUARD =
	"migration start: configuration version 3 workspaces are not supported; use configuration version 1 or 2";
const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const originalStore = process.env.AGENT_PROFILES_STORE;
const tuple = (model, host = "claude") => ({ role: "worker", model, host });
const primary = tuple("local-llm");
const key = (a) => JSON.stringify([a.role, a.model, a.host]);
const byKey = (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const protocol = "@example/checkin";
const roleText = "# Worker\r\nKeep evidence exact.  \r\n",
	roleResource = Buffer.from([0, 255, 13, 10]);
const noteText = "---\ndescription: Optional note\n---\nNot injected.\n";
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
function files(root) {
	const rows = [];
	function visit(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name,
				stat = fs.lstatSync(path.join(root, member));
			if (stat.isSymbolicLink())
				rows.push([member, "link", fs.readlinkSync(path.join(root, member))]);
			else if (stat.isDirectory()) {
				rows.push([member, "directory"]);
				visit(member);
			} else
				rows.push([
					member,
					stat.nlink,
					fs.readFileSync(path.join(root, member)).toString("hex"),
				]);
		}
	}
	visit();
	return rows;
}
// A project born directly in config3: no config1/2 start or conversion anywhere in setup.
function fixture(t, requiredWorkflow = false) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-config3-migration-")),
	);
	t.after(() => {
		if (originalStore === undefined) delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = originalStore;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		sources = path.join(dir, "sources");
	const ambient = path.join(dir, "ambient"),
		home = path.join(dir, "home");
	fs.mkdirSync(home);
	const packages = new Map(),
		records = new Map();
	function add(
		key,
		name,
		version,
		type,
		entrypoint,
		members,
		store = storeRoot,
	) {
		const directory = path.join(sources, key);
		put(
			path.join(directory, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name, version, type },
				entrypoint,
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		for (const [member, bytes] of Object.entries(members))
			put(path.join(directory, member), bytes);
		packages.set(key, {
			...importPackage({ sourceDirectory: directory, storeRoot: store }),
			directory,
			members,
		});
	}
	const skill = (name, label) =>
		`---\r\nname: ${name}\r\ndescription: Fictional ${label}\r\n---\r\n# ${label} café  \r\n`;
	add("house", "@example/house-style", "1.0.0", "instruction", "STYLE.md", {
		"STYLE.md": "# House style\r\nPrefer exact evidence.  \r\n",
	});
	add(
		"profile",
		"@example/base-profile",
		"1.0.0",
		"instruction",
		"PROFILE.md",
		{ "PROFILE.md": "﻿# Base profile\r\n" },
	);
	add("helper", "@example/helper", "1.0.0", "skill", "SKILL.md", {
		"SKILL.md": skill("helper", "helper"),
		"WORKFLOW.md": "# Helper workflow\r\nProvide check-in evidence.  \r\n",
		"data.bin": Buffer.from([1, 0, 255]),
	});
	add("reviewer", "@example/reviewer", "1.2.3", "skill", "SKILL.md", {
		"SKILL.md": skill("reviewer", "reviewer"),
		"WORKFLOW.md": "# Reviewer workflow\r\nKeep the evidence trail.  \r\n",
		"data.bin": Buffer.from([0, 255, 13, 10]),
	});
	// Misleading ambient store: the same logical identity with different bytes.
	add(
		"ambient-reviewer",
		"@example/reviewer",
		"1.2.3",
		"skill",
		"SKILL.md",
		{ "SKILL.md": skill("reviewer", "misleading ambient") },
		ambient,
	);
	process.env.AGENT_PROFILES_STORE = ambient;
	function adopt(key, dependencies, workflow) {
		const pkg = packages.get(key),
			manifestFile = path.join(dir, `${key}-adoption.json`);
		put(
			manifestFile,
			JSON.stringify({
				revisionVersion: 1,
				kind: "release",
				identity: pkg.identity,
				content: { identity: pkg.identity, sha256: pkg.sha256 },
				parent: null,
				candidate: null,
				workflow,
				dependencies: dependencies.map((dep) => ({
					...packages.get(dep).identity,
					sha256: packages.get(dep).sha256,
					revisionDigest: records.get(dep).recordDigest,
				})),
				provenance: {
					kind: "legacy-adoption",
					workflowChange: {
						kind: "initial",
						reason:
							"Owned config3 fixture declaration; no compliance evaluation.",
					},
				},
			}),
		);
		records.set(key, retainRevisionManifest({ storeRoot, manifestFile }));
	}
	const none = { file: null, provides: [], requires: [] };
	adopt("house", [], none);
	adopt("profile", ["house"], none);
	adopt("helper", [], {
		file: "WORKFLOW.md",
		provides: [{ protocol, major: 1 }],
		requires: [],
	});
	adopt("reviewer", ["helper"], {
		file: "WORKFLOW.md",
		provides: [],
		requires: requiredWorkflow ? [{ protocol, major: 1 }] : [],
	});
	const config = {
		version: 3,
		default_profile: "base",
		default_role: "worker",
		models: {
			"local-llm": { profile: "base", aliases: ["local-alias"] },
			opus: { profile: "base" },
		},
		families: {},
		profiles: {
			base: {
				package: "@example/base-profile",
				version: "1.0.0",
				revision: records.get("profile").recordDigest,
			},
		},
		roles: {
			worker: {
				file: "roles/worker.md",
				resources: ["assets/role.bin"],
				skills: { required: ["reviewer"], available: ["note"] },
			},
		},
		skills: {
			reviewer: {
				package: "@example/reviewer",
				version: "1.2.3",
				revision: records.get("reviewer").recordDigest,
			},
			note: { file: "instructions/note.md" },
		},
	};
	const configFile = path.join(root, ".agent-profiles/agents.yaml"),
		lockFile = path.join(root, ".agent-profiles/agent-profiles.lock");
	if (requiredWorkflow)
		config.workflow_links = {
			checkin: {
				protocol,
				consumer: { assignment: { ...primary }, binding: "skills.reviewer" },
				providers: [{ assignment: { ...primary }, binding: "skills.reviewer" }],
			},
		};
	put(configFile, stringify(config));
	put(path.join(root, ".agent-profiles/roles/worker.md"), roleText);
	put(path.join(root, "assets/role.bin"), roleResource);
	put(path.join(root, "instructions/note.md"), noteText);
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	installDependencies({ root, storeRoot });
	return {
		dir,
		root,
		storeRoot,
		sources,
		ambient,
		home,
		packages,
		records,
		config,
		configFile,
		lockFile,
		input: { root, storeRoot, ...primary },
	};
}
const roots = (f) => [f.root, f.storeRoot, f.ambient].map(files);
const outsideMigrations = (rows) =>
	rows.filter(
		([member]) =>
			member !== ".agent-profiles/migrations" &&
			!member.startsWith(".agent-profiles/migrations/"),
	);
const migrationDirs = (f) => {
	const dir = path.join(f.root, ".agent-profiles/migrations");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
function selection(f, assignment = primary) {
	const r = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		...assignment,
	});
	return {
		loaded: r.loaded.map((part) => [part.kind, part.id, part.content]),
		required: r.required.map((entry) => entry.package ?? null),
		status: r.workflow.status,
	};
}
function noWriters(f) {
	for (const lock of [
		path.join(f.storeRoot, ".writer-lock"),
		path.join(f.root, ".agent-profiles/.migration-writer"),
	])
		assert.equal(fs.existsSync(lock), false, lock);
}
// Exact editable overlay owed by a native start: selected local task/resource bytes and complete selected/dependency package trees.
function expectedOverlay(f) {
	const rows = new Map();
	for (const relative of [
		".agent-profiles/roles/worker.md",
		"assets/role.bin",
		"instructions/note.md",
	])
		rows.set(`local/${relative}`, fs.readFileSync(path.join(f.root, relative)));
	for (const name of ["house", "profile", "helper", "reviewer"]) {
		const pkg = f.packages.get(name);
		for (const [member, kind] of files(pkg.directory))
			if (kind !== "directory")
				rows.set(
					`packages/${pkg.sha256}/${member}`,
					fs.readFileSync(path.join(pkg.directory, member)),
				);
	}
	return rows;
}
// Collateral tuples that share every selected root with the primary in this fixture.
function collateralTuples() {
	const rows = [];
	for (const model of ["local-llm", "opus"])
		for (const { id } of integrations)
			if (key(tuple(model, id)) !== key(primary)) rows.push(tuple(model, id));
	return rows.sort(byKey);
}
const sharedBindings = [
	"profiles.base",
	"roles.worker",
	"skills.note",
	"skills.reviewer",
];
function startNative(t, input) {
	try {
		return migrations.startMigration(input);
	} catch (error) {
		if (error.message === GUARD) {
			t.skip(`${GUARD} — downstream body UNEXECUTED`);
			return null;
		}
		throw error;
	}
}
function proposalFile(f, record, value) {
	const file = path.join(
		f.dir,
		`proposal-${Math.random().toString(16).slice(2)}.json`,
	);
	put(
		file,
		JSON.stringify({
			proposalVersion: 1,
			...value,
			evidence: [
				{
					sessionId: "caller-claimed-config3-session",
					excerpt: "A caller claims the task missed a stale-evidence check.",
					baseStamp: record.bases[0].stamp,
				},
			],
		}),
	);
	return file;
}
function propose(f, record, value) {
	return migrations.proposeMigration({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalFile: proposalFile(f, record, value),
	});
}
const reviewerTarget = (f) =>
	`packages/${f.packages.get("reviewer").sha256}/SKILL.md`;
const reviewerAfter = (f) =>
	f.packages.get("reviewer").members["SKILL.md"] +
	"Check stale evidence before reporting.\r\n";
function candidateFile(f, record, proposalIds) {
	const tree = path.join(
			f.root,
			record.workspace,
			"packages",
			f.packages.get("reviewer").sha256,
		),
		file = path.join(f.dir, "candidate.json");
	put(
		file,
		JSON.stringify({
			candidateVersion: 1,
			id: "config3-candidate",
			binding: "skills.reviewer",
			release: { name: "@example/reviewer", version: "2.0.0" },
			migrationBase: record.bases[0].stamp,
			evaluationBase: record.bases[0].stamp,
			configSha256: JSON.parse(fs.readFileSync(f.lockFile, "utf8"))
				.configSha256,
			expectedTreeSha256: readPackage({ root: tree }).sha256,
			proposalIds,
			workflowChange: {
				kind: "task-only",
				reason: "Retain the accepted task check; workflow unchanged.",
			},
		}),
	);
	return file;
}
function child(f, args) {
	return spawnSync(
		process.execPath,
		[cli, ...args, "--root", f.root, "--store", f.storeRoot],
		{
			cwd: f.dir,
			encoding: "utf8",
			env: {
				...process.env,
				AGENT_PROFILES_STORE: f.ambient,
				TMP: f.dir,
				TEMP: f.dir,
				TMPDIR: f.dir,
				HOME: f.home,
				USERPROFILE: f.home,
				CODEX_HOME: path.join(f.home, ".codex"),
				CLAUDE_CONFIG_DIR: path.join(f.home, ".claude"),
			},
		},
	);
}
function observeFs(t, method, observe, operation) {
	const real = fs[method],
		mock = t.mock.method(fs, method, (...args) => observe(real, ...args));
	syncBuiltinESMExports();
	try {
		return operation();
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
	}
}

// Runnable controls: real fixture, explicit store, observer and the overlap guard that precedes the config3 refusal.

test("config3 fixture: real release closure, dependency-first context, lock2 and stamp2 resolve before any workspace start", (t) => {
	const f = fixture(t),
		project = files(f.root),
		ambient = files(f.ambient),
		r = resolveInstructions(f.input);
	assert.deepEqual(
		r.loaded.slice(0, 3).map((part) => [part.kind, part.id]),
		[
			["dependency", "@example/house-style"],
			["profile", "base"],
			["role", "worker"],
		],
		"a package-backed profile loads its dependency first, so the first two parts are not profile and role",
	);
	assert.equal(
		r.loaded[1].package.revisionDigest,
		f.records.get("profile").recordDigest,
	);
	assert.equal(r.loaded.find((part) => part.kind === "role").content, roleText);
	assert.equal(
		r.loaded.find((part) => part.kind === "required-skill").content,
		f.packages.get("reviewer").members["SKILL.md"],
	);
	assert.equal(
		r.loaded.filter((part) => part.kind === "workflow").length,
		2,
		"helper and reviewer companions",
	);
	assert.equal(r.workflow.status, "declared-compatible");
	const reviewer = r.required.find((entry) => entry.id === "reviewer").package;
	assert.equal(reviewer.sha256, f.packages.get("reviewer").sha256);
	assert.notEqual(reviewer.sha256, f.packages.get("ambient-reviewer").sha256);
	assert.equal(reviewer.revisionDigest, f.records.get("reviewer").recordDigest);
	assert.deepEqual(
		selection(f, { ...primary, model: "local-alias" }).loaded,
		selection(f).loaded,
		"alias reaches the canonical tuple",
	);
	const lock = JSON.parse(fs.readFileSync(f.lockFile, "utf8"));
	assert.equal(lock.lockVersion, 2);
	assert.equal(lock.configurationVersion, 3);
	const stamp = createStamp(f.input),
		rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: stamp.digest,
		});
	assert.equal(stamp.snapshot.stampVersion, 2);
	assert.deepEqual(stamp.snapshot.capture, {
		kind: "active",
		migration: null,
		candidate: null,
	});
	assert.equal(stamp.snapshot.selection.profile, "base");
	assert.equal(stamp.snapshot.selection.identity.canonical, "local-llm");
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: stamp.digest })
			.managedReproducible,
		true,
	);
	assert.ok(
		rebuilt.resources.some(
			(entry) =>
				entry.backing?.path === "assets/role.bin" &&
				entry.bytes.equals(roleResource),
		),
		"declared role resource retained",
	);
	assert.deepEqual(files(f.root), project);
	assert.deepEqual(files(f.ambient), ambient);
	assert.deepEqual(migrationDirs(f), []);
});

test("config3 observer control: an intercepted real rename performs a complete owned edit and restores methods", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-config3-observer-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const staged = path.join(dir, "stage"),
		target = path.join(dir, "final"),
		input = path.join(dir, "worker.md"),
		originalRename = fs.renameSync;
	const edited = Buffer.from("# Worker\r\nConcurrent edit.\r\n");
	fs.writeFileSync(staged, "stamp");
	fs.writeFileSync(input, roleText);
	let edits = 0;
	observeFs(
		t,
		"renameSync",
		(real, from, to, ...args) => {
			const result = real(from, to, ...args);
			if (path.resolve(to) === target && edits === 0) {
				fs.writeFileSync(input, edited);
				edits++;
			}
			return result;
		},
		() => observedFs.renameSync(staged, target),
	);
	assert.equal(edits, 1);
	assert.deepEqual(fs.readFileSync(input), edited);
	assert.equal(fs.readFileSync(target, "utf8"), "stamp");
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.renameSync, originalRename);
	assert.equal(observedFs.renameSync, originalRename);
});

test("config3 start refuses a store inside the protected migration namespace before capture or writes", (t) => {
	const f = fixture(t),
		nested = path.join(f.root, ".agent-profiles/migrations/store");
	fs.cpSync(f.storeRoot, nested, { recursive: true });
	const before = roots(f);
	for (const sharing of ["fork", "shared"])
		assert.throws(
			() =>
				migrations.startMigration({ ...f.input, storeRoot: nested, sharing }),
			/store overlap/,
		);
	assert.deepEqual(roots(f), before);
	noWriters(f);
});

test("config3 start capability: a valid config3 project starts a native migration workspace", (t) => {
	const f = fixture(t);
	let error;
	try {
		migrations.startMigration({ ...f.input, sharing: "fork" });
	} catch (caught) {
		error = caught;
	}
	assert.equal(
		error,
		undefined,
		`config3 workspace start must be supported: ${error?.message}`,
	);
});

// Behavioral contract: only the exact existing config3 guard may skip these bodies.

test("config3 start: captures the active stamp2 and a complete editable overlay without changing active inputs", (t) => {
	const f = fixture(t),
		active = selection(f),
		project = files(f.root),
		ambient = files(f.ambient);
	const record = startNative(t, { ...f.input, sharing: "fork" });
	if (!record) return;
	assert.match(record.id, /^migration-[a-f0-9-]{36}$/);
	assert.equal(record.state, "open");
	assert.deepEqual(record.scope, [primary]);
	assert.equal(record.sharing, "fork");
	assert.deepEqual(record.collateral, []);
	assert.equal(record.bases.length, 1);
	assert.deepEqual(record.bases[0].assignment, primary);
	const base = record.bases[0].stamp,
		snapshot = JSON.parse(
			fs.readFileSync(
				path.join(f.storeRoot, "stamps/sha256", base, "snapshot.json"),
				"utf8",
			),
		);
	assert.equal(snapshot.stampVersion, 2);
	assert.equal(snapshot.configurationVersion, 3);
	assert.deepEqual(snapshot.capture, {
		kind: "active",
		migration: null,
		candidate: null,
	});
	assert.deepEqual(
		[
			snapshot.selection.role,
			snapshot.selection.identity.canonical,
			snapshot.selection.host,
			snapshot.selection.profile,
		],
		["worker", "local-llm", "claude", "base"],
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: base }).managedReproducible,
		true,
	);
	assert.equal(
		createStamp(f.input).digest,
		base,
		"base is the actual current active capture",
	);
	const expected = expectedOverlay(f),
		workspace = path.join(f.root, record.workspace);
	assert.deepEqual(
		record.files,
		[...expected]
			.map(([p, bytes]) => ({ path: p, sha256: sha(bytes) }))
			.sort(byPath),
	);
	assert.deepEqual(
		files(workspace)
			.filter(([, kind]) => kind !== "directory")
			.map(([member]) => member)
			.sort(),
		[...expected.keys()].sort(),
	);
	for (const [p, bytes] of expected)
		assert.deepEqual(fs.readFileSync(path.join(workspace, p)), bytes, p);
	assert.deepEqual(
		outsideMigrations(files(f.root)),
		project,
		"active config, lock and sources unchanged",
	);
	assert.deepEqual(selection(f), active, "ordinary selected content unchanged");
	assert.deepEqual(files(f.ambient), ambient);
	const reopened = migrations.migrationStatus({ root: f.root, id: record.id });
	assert.deepEqual(
		{
			...reopened,
			dirty: undefined,
			workspaceChanged: undefined,
			changes: undefined,
		},
		{
			...record,
			dirty: undefined,
			workspaceChanged: undefined,
			changes: undefined,
		},
	);
	assert.equal(reopened.workspaceChanged, false);
	assert.deepEqual(reopened.changes, []);
	assert.deepEqual(
		migrations.migrationStatus({ root: f.root }).map((item) => item.id),
		[record.id],
	);
	noWriters(f);
});

test("config3 start: sharing discovery uses actual direct roots and canonical alias ownership for fork and shared intent", (t) => {
	const f = fixture(t),
		collateral = collateralTuples(),
		expectedShared = collateral.map((assignment) => ({
			assignment,
			bindings: sharedBindings,
		}));
	const forked = startNative(t, {
		...f.input,
		model: "local-alias",
		sharing: "fork",
	});
	if (!forked) return;
	assert.deepEqual(
		forked.scope,
		[primary],
		"alias is owned by its canonical model",
	);
	assert.deepEqual(
		forked.shared,
		expectedShared,
		"direct profile/role/skill roots; dependency parts are not logical bindings",
	);
	assert.ok(
		forked.shared.every((row) =>
			row.bindings.every((binding) =>
				/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(binding),
			),
		),
		"no skills.@namespace ids",
	);
	assert.deepEqual(forked.collateral, []);
	assert.equal(forked.bases.length, 1);
	migrations.abandonMigration({
		root: f.root,
		id: forked.id,
		reason: "Retry with shared intent",
	});
	const shared = migrations.startMigration({ ...f.input, sharing: "shared" });
	assert.equal(shared.sharing, "shared");
	assert.deepEqual(shared.shared, expectedShared);
	assert.deepEqual(shared.collateral, collateral);
	assert.deepEqual(
		shared.bases.map((base) => base.assignment),
		[primary, ...collateral],
	);
	for (const base of shared.bases) {
		const snapshot = JSON.parse(
			fs.readFileSync(
				path.join(f.storeRoot, "stamps/sha256", base.stamp, "snapshot.json"),
				"utf8",
			),
		);
		assert.equal(snapshot.stampVersion, 2);
		assert.deepEqual(snapshot.capture, {
			kind: "active",
			migration: null,
			candidate: null,
		});
		assert.deepEqual(
			[
				snapshot.selection.role,
				snapshot.selection.identity.canonical,
				snapshot.selection.host,
			],
			[base.assignment.role, base.assignment.model, base.assignment.host],
		);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: base.stamp })
				.managedReproducible,
			true,
		);
	}
	assert.equal(
		fs.existsSync(path.join(f.storeRoot, "candidates")),
		false,
		"intent recording publishes no fork or shared candidate",
	);
});

test("config3 start: open primary and collateral reservations are exclusive while status stays read-only and detects edits", (t) => {
	const f = fixture(t),
		record = startNative(t, { ...f.input, sharing: "shared" });
	if (!record) return;
	const reserved = roots(f);
	for (const assignment of [primary, tuple("opus", "codex")]) {
		assert.throws(
			() =>
				migrations.startMigration({
					...f.input,
					...assignment,
					sharing: "fork",
				}),
			new RegExp(`open migration ${record.id} already targets`),
		);
	}
	assert.deepEqual(roots(f), reserved, "refused starts write nothing");
	noWriters(f);
	const listed = migrations.migrationStatus({ root: f.root });
	assert.ok(Array.isArray(listed));
	assert.deepEqual(
		listed.map((item) => item.id),
		[record.id],
		"no implicit current migration",
	);
	assert.deepEqual(roots(f), reserved, "status is read-only");
	const workspace = path.join(f.root, record.workspace),
		active = selection(f);
	put(
		path.join(workspace, "local/.agent-profiles/roles/worker.md"),
		`${roleText}Workspace-only edit.\r\n`,
	);
	put(path.join(workspace, "local/notes.txt"), "New workspace note.\r\n");
	const status = migrations.migrationStatus({ root: f.root, id: record.id });
	assert.equal(status.workspaceChanged, true);
	assert.deepEqual(status.changes, [
		{ path: "local/.agent-profiles/roles/worker.md", kind: "changed" },
		{ path: "local/notes.txt", kind: "added" },
	]);
	assert.equal(
		fs.readFileSync(
			path.join(f.root, ".agent-profiles/roles/worker.md"),
			"utf8",
		),
		roleText,
		"active source untouched",
	);
	assert.deepEqual(selection(f), active);
});

test("config3 start: role and package proposals use the captured base while role acceptance grants no candidate", (t) => {
	const f = fixture(t),
		record = startNative(t, { ...f.input, sharing: "fork" });
	if (!record) return;
	const roleTarget = "local/.agent-profiles/roles/worker.md",
		roleAfter = `${roleText}Cite the captured base stamp.\r\n`;
	const roleProposal = propose(f, record, {
		classification: "role",
		target: { path: roleTarget },
		change: { before: roleText, after: roleAfter },
	});
	assert.equal(roleProposal.status, "proposed");
	assert.equal(
		roleProposal.proposal.evidence[0].baseStamp,
		record.bases[0].stamp,
	);
	const accepted = migrations.acceptMigrationProposal({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalId: roleProposal.id,
	});
	assert.equal(accepted.status, "accepted");
	assert.equal(
		fs.readFileSync(path.join(f.root, record.workspace, roleTarget), "utf8"),
		roleAfter,
	);
	assert.equal(
		fs.readFileSync(
			path.join(f.root, ".agent-profiles/roles/worker.md"),
			"utf8",
		),
		roleText,
		"active role unchanged",
	);
	const packageProposal = propose(f, record, {
		classification: "package",
		target: { path: reviewerTarget(f) },
		change: {
			before: f.packages.get("reviewer").members["SKILL.md"],
			after: reviewerAfter(f),
		},
	});
	const rejected = migrations.rejectMigrationProposal({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalId: packageProposal.id,
		reason: "Keep the task unchanged",
	});
	assert.equal(rejected.status, "rejected");
	assert.equal(
		fs.readFileSync(
			path.join(f.root, record.workspace, reviewerTarget(f)),
			"utf8",
		),
		f.packages.get("reviewer").members["SKILL.md"],
	);
	assert.deepEqual(
		migrations.migrationProposals({ root: f.root, id: record.id }),
		[accepted, rejected],
	);
	const foreign = createStamp({ ...f.input, ...tuple("opus") }).digest,
		foreignFile = path.join(f.dir, "foreign-proposal.json");
	put(
		foreignFile,
		JSON.stringify({
			proposalVersion: 1,
			classification: "role",
			target: { path: roleTarget },
			change: { before: roleAfter, after: `${roleAfter}x\r\n` },
			evidence: [
				{
					sessionId: "caller-claimed-config3-session",
					excerpt: "Foreign base.",
					baseStamp: foreign,
				},
			],
		}),
	);
	assert.throws(
		() =>
			migrations.proposeMigration({
				root: f.root,
				storeRoot: f.storeRoot,
				id: record.id,
				proposalFile: foreignFile,
			}),
		/base stamp is not retained/,
	);
	const before = roots(f);
	assert.throws(
		() =>
			migrations.publishMigrationCandidate({
				root: f.root,
				storeRoot: f.storeRoot,
				id: record.id,
				manifestFile: candidateFile(f, record, [accepted.id]),
			}),
		/unsupported target|accepted proposal/,
	);
	assert.deepEqual(
		outsideMigrations(roots(f)[0]),
		outsideMigrations(before[0]),
	);
	assert.equal(fs.existsSync(path.join(f.storeRoot, "candidates")), false);
});

test("config3 start: package proposal acceptance publishes a native candidate and paired evidence without changing selection", (t) => {
	const f = fixture(t),
		active = selection(f),
		record = startNative(t, { ...f.input, sharing: "fork" });
	if (!record) return;
	const reviewer = f.packages.get("reviewer"),
		base = record.bases[0].stamp;
	const proposed = propose(f, record, {
		classification: "package",
		target: { path: reviewerTarget(f) },
		change: { before: reviewer.members["SKILL.md"], after: reviewerAfter(f) },
	});
	const accepted = migrations.acceptMigrationProposal({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalId: proposed.id,
	});
	const result = migrations.publishMigrationCandidate({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		manifestFile: candidateFile(f, record, [accepted.id]),
	});
	assert.equal(result.status, "published");
	assert.equal(result.migrationId, record.id);
	const { status, ...index } = result;
	assert.equal(status, "published");
	assert.deepEqual(
		migrations.migrationCandidate({ storeRoot: f.storeRoot, id: result.id }),
		index,
	);
	const revision = readRevisionRecord({
		storeRoot: f.storeRoot,
		recordDigest: result.revisionDigest,
	});
	assert.equal(revision.kind, "candidate");
	assert.equal(revision.parent, f.records.get("reviewer").recordDigest);
	assert.deepEqual(
		revision.content.identity,
		reviewer.identity,
		"embedded manifest identity is unchanged",
	);
	assert.equal(revision.provenance.migrationBase, base);
	assert.equal(
		revision.provenance.evaluationBase,
		base,
		"authoring and evaluation bindings are distinct fields",
	);
	assert.deepEqual(revision.provenance.proposals, [accepted]);
	const rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: result.stampDigest,
		}),
		original = reconstructStamp({ storeRoot: f.storeRoot, digest: base });
	assert.deepEqual(rebuilt.capture, {
		kind: "candidate",
		migration: record.id,
		candidate: result.revisionDigest,
	});
	assert.deepEqual(
		rebuilt.composition.map((part) => part.kind),
		original.composition.map((part) => part.kind),
	);
	assert.deepEqual(
		rebuilt.composition.find((part) => part.kind === "required-skill").bytes,
		Buffer.from(reviewerAfter(f)),
	);
	assert.deepEqual(
		rebuilt.composition.find((part) => part.kind === "profile").bytes,
		Buffer.from(f.packages.get("profile").members["PROFILE.md"]),
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		selection(f),
		active,
		"ordinary selection unchanged until explicit promotion",
	);
	assert.equal(
		lookupPackage({
			storeRoot: f.storeRoot,
			name: "@example/reviewer",
			version: "2.0.0",
		}),
		null,
	);
	const target = {
		assignment: { ...primary },
		binding: "skills.reviewer",
		member: "@example/reviewer",
		protocol: null,
	};
	const plan = {
		planVersion: 1,
		id: "config3-plan",
		candidateId: result.id,
		candidateRevisionDigest: result.revisionDigest,
		baseStamp: base,
		candidateStamp: result.stampDigest,
		context: {
			assignment: { ...primary },
			requestedSkills: [],
			workflowPeers: {
				base: original.workflowPeers,
				candidate: rebuilt.workflowPeers,
			},
		},
		cases: ["motivating", "regression"].map((kind) => ({
			id: kind,
			kind,
			input: `Fictional ${kind} input`,
			expected: "Preserve exact evidence",
			target,
		})),
		trials: 1,
		conditions: {
			harness: { id: "offline-fixture", version: "1", settings: {} },
			judge: { id: "caller-claim", version: "1", settings: {} },
			rubric: { id: "literal-fixture", version: "1", settings: {} },
		},
	};
	const planFile = path.join(f.dir, "plan.json");
	put(planFile, JSON.stringify(plan));
	const planned = migrations.planMigrationEvaluation({
		root: f.root,
		storeRoot: f.storeRoot,
		candidateId: result.id,
		planFile,
	});
	const results = {
		resultVersion: 1,
		id: "config3-results",
		planDigest: planned.planDigest,
		candidateRevisionDigest: result.revisionDigest,
		conditions: { base: plan.conditions, candidate: plan.conditions },
		outcomes: plan.cases.flatMap((item) =>
			["base", "candidate"].map((side) => ({
				caseId: item.id,
				trial: 1,
				side,
				stampDigest: side === "base" ? base : result.stampDigest,
				assignment: { ...primary },
				correct: true,
				metrics: {
					costUsd: null,
					tokens: null,
					turns: null,
					toolCalls: null,
					latencyMs: null,
				},
				evidenceRef: `opaque:config3/${item.id}/${side}`,
			})),
		),
	};
	const resultFile = path.join(f.dir, "results.json");
	put(resultFile, JSON.stringify(results));
	migrations.importMigrationEvaluationResults({
		root: f.root,
		storeRoot: f.storeRoot,
		planId: plan.id,
		resultFile,
	});
	const report = migrations.migrationEvaluationReport({
		storeRoot: f.storeRoot,
		id: results.id,
	});
	assert.deepEqual(report.eligibility, { status: "eligible", regressions: [] });
	assert.equal(report.evidence.promotion, "not-authorized");
	assert.deepEqual(selection(f), active);
});

test("config3 start: abandon preserves accepted and rejected history, candidate evidence and user edits and releases the reservation", (t) => {
	const f = fixture(t),
		record = startNative(t, { ...f.input, sharing: "fork" });
	if (!record) return;
	const reviewer = f.packages.get("reviewer");
	const proposed = propose(f, record, {
		classification: "package",
		target: { path: reviewerTarget(f) },
		change: { before: reviewer.members["SKILL.md"], after: reviewerAfter(f) },
	});
	const accepted = migrations.acceptMigrationProposal({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalId: proposed.id,
	});
	const roleProposal = propose(f, record, {
		classification: "role",
		target: { path: "local/.agent-profiles/roles/worker.md" },
		change: { before: roleText, after: `${roleText}Unused.\r\n` },
	});
	const rejected = migrations.rejectMigrationProposal({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		proposalId: roleProposal.id,
		reason: "Not needed",
	});
	const candidate = migrations.publishMigrationCandidate({
		root: f.root,
		storeRoot: f.storeRoot,
		id: record.id,
		manifestFile: candidateFile(f, record, [accepted.id]),
	});
	const workspace = path.join(f.root, record.workspace),
		userEdit = Buffer.from("User workspace note.\r\n");
	put(path.join(workspace, "local/user-notes.md"), userEdit);
	const abandoned = migrations.abandonMigration({
		root: f.root,
		id: record.id,
		reason: "Superseded by a narrower change",
	});
	assert.equal(abandoned.state, "abandoned");
	assert.equal(abandoned.reason, "Superseded by a narrower change");
	assert.deepEqual(
		migrations.migrationProposals({ root: f.root, id: record.id }),
		[accepted, rejected],
	);
	assert.equal(
		migrations.migrationCandidate({ storeRoot: f.storeRoot, id: candidate.id })
			.stampDigest,
		candidate.stampDigest,
	);
	for (const digest of [record.bases[0].stamp, candidate.stampDigest])
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest }).managedReproducible,
			true,
		);
	assert.deepEqual(
		fs.readFileSync(path.join(workspace, "local/user-notes.md")),
		userEdit,
	);
	assert.equal(
		fs.readFileSync(path.join(workspace, reviewerTarget(f)), "utf8"),
		reviewerAfter(f),
	);
	const status = migrations.migrationStatus({ root: f.root, id: record.id });
	assert.equal(status.state, "abandoned");
	assert.ok(
		status.changes.some(
			(change) =>
				change.path === "local/user-notes.md" && change.kind === "added",
		),
	);
	assert.throws(
		() =>
			propose(f, record, {
				classification: "role",
				target: { path: "local/.agent-profiles/roles/worker.md" },
				change: { before: roleText, after: `${roleText}y\r\n` },
			}),
		/not open/,
	);
	const restarted = migrations.startMigration({ ...f.input, sharing: "fork" });
	assert.notEqual(restarted.id, record.id);
	assert.equal(restarted.state, "open");
	assert.deepEqual(
		migrations
			.migrationStatus({ root: f.root })
			.map((item) => item.id)
			.sort(),
		[record.id, restarted.id].sort(),
	);
});

test("config3 start: public CLI starts with an alias and reopens status in JSON and text", (t) => {
	const f = fixture(t),
		project = files(f.root);
	const started = child(f, [
		"migrate",
		"start",
		"--role",
		"worker",
		"--model",
		"local-alias",
		"--host",
		"claude",
		"--sharing",
		"fork",
		"--json",
	]);
	assert.equal(
		started.error,
		undefined,
		"spawn/setup denial is not business RED",
	);
	if (started.status !== 0 && started.stderr.includes(GUARD)) {
		t.skip(`${GUARD} — downstream body UNEXECUTED`);
		return;
	}
	assert.equal(started.status, 0, started.stderr);
	assert.equal(started.stderr, "");
	const record = JSON.parse(started.stdout);
	assert.deepEqual(record.scope, [primary]);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: record.bases[0].stamp })
			.managedReproducible,
		true,
	);
	const status = child(f, ["migrate", "status", record.id, "--json"]);
	assert.equal(status.status, 0, status.stderr);
	const reopened = JSON.parse(status.stdout);
	assert.equal(reopened.id, record.id);
	assert.equal(reopened.workspaceChanged, false);
	const list = child(f, ["migrate", "status", "--json"]);
	assert.equal(list.status, 0, list.stderr);
	assert.deepEqual(
		JSON.parse(list.stdout).map((item) => item.id),
		[record.id],
	);
	const text = child(f, ["migrate", "status", record.id]);
	assert.equal(text.status, 0, text.stderr);
	assert.ok(text.stdout.includes(record.id));
	assert.deepEqual(
		outsideMigrations(files(f.root)),
		project,
		"active config, lock and sources unchanged",
	);
	noWriters(f);
});

test("config3 start: a loaded local input edited after its stamp capture refuses before workspace publication", (t) => {
	const f = fixture(t),
		role = path.join(f.root, ".agent-profiles/roles/worker.md"),
		edited = Buffer.from("# Worker\r\nConcurrent edit.\r\n");
	const configBytes = fs.readFileSync(f.configFile),
		lockBytes = fs.readFileSync(f.lockFile),
		stamps = path.join(f.storeRoot, "stamps", "sha256") + path.sep;
	let edits = 0,
		record,
		error;
	observeFs(
		t,
		"renameSync",
		(real, from, to, ...args) => {
			const result = real(from, to, ...args);
			if (edits === 0 && path.resolve(to).startsWith(stamps)) {
				fs.writeFileSync(role, edited);
				edits++;
			}
			return result;
		},
		() => {
			try {
				record = migrations.startMigration({ ...f.input, sharing: "fork" });
			} catch (caught) {
				error = caught;
			}
		},
	);
	if (error?.message === GUARD) {
		t.skip(`${GUARD} — downstream body UNEXECUTED`);
		return;
	}
	assert.equal(
		edits,
		1,
		"the real edit happened right after the base stamp publication",
	);
	assert.equal(
		record,
		undefined,
		"no workspace may be recorded from inputs that changed during capture",
	);
	assert.ok(error);
	assert.match(error.message, /stale-input/);
	assert.deepEqual(
		fs.readFileSync(role),
		edited,
		"concurrent user edit preserved",
	);
	assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
	assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
	assert.deepEqual(migrationDirs(f), []);
	noWriters(f);
});

test("config3 readiness: fork captures only the valid primary while inventory includes unready sharing assignments", (t) => {
	const f = fixture(t, true),
		collateral = collateralTuples(),
		active = selection(f),
		resolved = resolveInstructions(f.input);
	assert.equal(resolved.workflow.status, "declared-compatible");
	assert.equal(resolved.lockState, "valid");
	assert.deepEqual(
		resolved.loaded.slice(0, 3).map((part) => [part.kind, part.id]),
		[
			["dependency", "@example/house-style"],
			["profile", "base"],
			["role", "worker"],
		],
	);
	assert.deepEqual(
		resolved.loaded
			.filter((part) => part.kind === "dependency")
			.map((part) => part.id),
		["@example/house-style", "@example/helper"],
	);
	assert.deepEqual(
		resolved.workflow.peers.map((row) => [
			row.protocol,
			row.major,
			row.consumer.assignment,
			row.provider.assignment,
		]),
		[[protocol, 1, primary, primary]],
	);
	for (const assignment of collateral)
		assert.throws(
			() => resolveInstructions({ ...f.input, ...assignment }),
			/workflow required: missing explicit workflow link/,
		);
	const stamp = createStamp(f.input);
	assert.equal(stamp.snapshot.stampVersion, 2);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: stamp.digest })
			.managedReproducible,
		true,
	);
	const project = files(f.root),
		store = files(f.storeRoot),
		ambient = files(f.ambient),
		sources = files(f.sources),
		home = files(f.home);
	const record = migrations.startMigration({ ...f.input, sharing: "fork" });
	assert.equal(record.state, "open");
	assert.equal(record.sharing, "fork");
	assert.deepEqual(record.scope, [primary]);
	assert.deepEqual(record.collateral, []);
	assert.deepEqual(
		record.bases,
		[{ assignment: primary, stamp: stamp.digest }],
		"only the primary is captured",
	);
	assert.deepEqual(
		record.shared,
		collateral.map((assignment) => ({ assignment, bindings: sharedBindings })),
		"complete sorted sharing inventory includes hosts that cannot ordinarily resolve",
	);
	const rebuilt = reconstructStamp({
		storeRoot: f.storeRoot,
		digest: record.bases[0].stamp,
	});
	assert.deepEqual(
		rebuilt.composition.find((part) => part.kind === "role").bytes,
		Buffer.from(roleText),
	);
	assert.deepEqual(
		rebuilt.composition.find((part) => part.kind === "profile").bytes,
		Buffer.from(f.packages.get("profile").members["PROFILE.md"]),
	);
	assert.deepEqual(
		rebuilt.composition.find((part) => part.kind === "required-skill").bytes,
		Buffer.from(f.packages.get("reviewer").members["SKILL.md"]),
	);
	assert.deepEqual(rebuilt.capture, {
		kind: "active",
		migration: null,
		candidate: null,
	});
	const snapshot = JSON.parse(
		fs.readFileSync(
			path.join(
				f.storeRoot,
				"stamps/sha256",
				record.bases[0].stamp,
				"snapshot.json",
			),
			"utf8",
		),
	);
	assert.deepEqual(snapshot, stamp.snapshot);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: record.bases[0].stamp })
			.managedReproducible,
		true,
	);
	const expected = expectedOverlay(f),
		workspace = path.join(f.root, record.workspace);
	assert.deepEqual(
		record.files,
		[...expected]
			.map(([p, bytes]) => ({ path: p, sha256: sha(bytes) }))
			.sort(byPath),
	);
	assert.deepEqual(
		files(workspace)
			.filter(([, kind]) => kind !== "directory")
			.map(([member]) => member)
			.sort(),
		[...expected.keys()].sort(),
	);
	for (const [p, bytes] of expected)
		assert.deepEqual(fs.readFileSync(path.join(workspace, p)), bytes, p);
	assert.deepEqual(selection(f), active);
	for (const assignment of collateral)
		assert.throws(
			() => resolveInstructions({ ...f.input, ...assignment }),
			/workflow required: missing explicit workflow link/,
		);
	const reopened = migrations.migrationStatus({ root: f.root, id: record.id });
	assert.deepEqual(
		{
			...reopened,
			dirty: undefined,
			workspaceChanged: undefined,
			changes: undefined,
		},
		{
			...record,
			dirty: undefined,
			workspaceChanged: undefined,
			changes: undefined,
		},
	);
	assert.equal(reopened.workspaceChanged, false);
	assert.deepEqual(reopened.changes, []);
	assert.deepEqual(
		migrations.migrationStatus({ root: f.root }).map((item) => item.id),
		[record.id],
	);
	assert.deepEqual(
		outsideMigrations(files(f.root)),
		project,
		"active config, lock and other consumer inputs preserved",
	);
	assert.deepEqual(
		files(f.storeRoot),
		store,
		"no collateral capture or other store mutation",
	);
	assert.deepEqual(files(f.ambient), ambient);
	assert.deepEqual(files(f.sources), sources);
	assert.deepEqual(files(f.home), home);
	noWriters(f);
});

test("config3 readiness: an unready primary refuses fork without mutating any fixture root", (t) => {
	const f = fixture(t, true);
	assert.equal(
		resolveInstructions(f.input).workflow.status,
		"declared-compatible",
	);
	delete f.config.workflow_links;
	put(f.configFile, stringify(f.config));
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const lock = JSON.parse(fs.readFileSync(f.lockFile, "utf8"));
	assert.equal(lock.lockVersion, 2);
	assert.equal(lock.configurationVersion, 3);
	assert.doesNotThrow(
		() =>
			installDependencies({
				root: f.root,
				storeRoot: f.storeRoot,
				frozen: true,
			}),
		"refreshed lock is valid",
	);
	assert.throws(
		() => resolveInstructions(f.input),
		/workflow required: missing explicit workflow link/,
	);
	const before = files(f.dir);
	assert.throws(
		() => migrations.startMigration({ ...f.input, sharing: "fork" }),
		/workflow required: missing explicit workflow link/,
	);
	assert.deepEqual(
		files(f.dir),
		before,
		"complete project, store, sources, ambient and home roots preserved",
	);
	assert.deepEqual(migrationDirs(f), []);
	assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
	assert.throws(
		() => resolveInstructions(f.input),
		/workflow required: missing explicit workflow link/,
	);
	noWriters(f);
	assert.deepEqual(files(f.dir), before);
});

test("config3 readiness: shared refuses an unready collateral workflow without publication or writer leaks", (t) => {
	const f = fixture(t, true),
		collateral = tuple("local-llm", "codex"),
		active = selection(f);
	assert.equal(active.status, "declared-compatible");
	assert.equal(resolveInstructions(f.input).lockState, "valid");
	assert.ok(
		collateralTuples().some(
			(assignment) => key(assignment) === key(collateral),
		),
		"the unready collateral shares the primary profile, local role and skill roots",
	);
	assert.throws(
		() => resolveInstructions({ ...f.input, ...collateral }),
		/workflow required: missing explicit workflow link/,
	);
	const before = files(f.dir);
	assert.throws(
		() => migrations.startMigration({ ...f.input, sharing: "shared" }),
		/workflow required: missing explicit workflow link/,
	);
	assert.deepEqual(
		files(f.dir),
		before,
		"full roots preserved, including immutable store backing; no publication is permitted",
	);
	assert.deepEqual(migrationDirs(f), []);
	assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
	assert.deepEqual(selection(f), active);
	assert.throws(
		() => resolveInstructions({ ...f.input, ...collateral }),
		/workflow required: missing explicit workflow link/,
	);
	noWriters(f);
	assert.deepEqual(files(f.dir), before);
});
