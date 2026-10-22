import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { createStamp, reconstructStamp } from "../src/stamps.js";

const target = new URL("../src/migrations.js", import.meta.url);
let migrations;
try {
	migrations = await import(target.href);
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
const migrationTest = (name, body) =>
	test(
		name,
		{
			skip: migrations
				? false
				: "migration implementation absent; behavioral body not executed",
		},
		body,
	);
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-migration-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		source = path.join(dir, "package");
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "reviewer",
		models: {
			small: { profile: "base", aliases: ["small-alias"] },
			large: { profile: "base" },
		},
		families: {},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: ["review"], available: ["extra"] },
			},
			writer: {
				file: "roles/writer.md",
				skills: { required: [], available: [] },
			},
		},
		skills: {
			review: { package: "@example/review", version: "1.0.0" },
			extra: {
				file: "instructions/extra.md",
				resources: ["instructions/data.bin"],
			},
		},
	};
	put(path.join(root, ".agent-profiles/agents.yaml"), stringify(config));
	put(
		path.join(root, ".agent-profiles/profiles/base.md"),
		Buffer.from("\uFEFF# Profile\r\n\r\n"),
	);
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Review\r\n");
	put(path.join(root, ".agent-profiles/roles/writer.md"), "# Write\r\n");
	put(
		path.join(root, "instructions/extra.md"),
		"---\ndescription: Extra evidence\n---\nExtra\n",
	);
	put(path.join(root, "instructions/data.bin"), Buffer.from([0, 255, 13, 10]));
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: "@example/review", version: "1.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(source, "SKILL.md"),
		"---\r\ndescription: Review evidence\r\n---\r\nReview\r\n",
	);
	put(path.join(source, "support.bin"), Buffer.from([255, 0, 13, 10]));
	const pkg = importPackage({ sourceDirectory: source, storeRoot });
	installDependencies({ root, storeRoot });
	const input = {
		root,
		storeRoot,
		role: "reviewer",
		model: "small",
		host: "codex",
	};
	const protectedPaths = [
		".agent-profiles/agents.yaml",
		".agent-profiles/agent-profiles.lock",
		".agent-profiles/profiles/base.md",
		".agent-profiles/roles/reviewer.md",
		".agent-profiles/roles/writer.md",
		"instructions/extra.md",
		"instructions/data.bin",
		"AGENTS.md",
	];
	const originals = protectedPaths.map((p) => [
		p,
		fs.readFileSync(path.join(root, p)),
	]);
	return {
		...input,
		input,
		dir,
		source,
		pkg,
		unchanged: () => {
			for (const [p, bytes] of originals)
				assert.deepEqual(fs.readFileSync(path.join(root, p)), bytes, p);
		},
	};
}
const start = (f) => migrations.startMigration({ ...f.input, sharing: "fork" });
const recordPath = (f, id) =>
	path.join(f.root, ".agent-profiles/migrations", id, "record.json");
function invoke(f, ...args) {
	return spawnSync(
		process.execPath,
		[
			cli,
			"migrate",
			...args,
			"--root",
			f.root,
			"--store",
			f.storeRoot,
			"--json",
		],
		{ encoding: "utf8" },
	);
}

test("migration start/status/abandon public API exists", () => {
	assert.ok(
		migrations,
		"src/migrations.js must implement the migration workspace lifecycle",
	);
	for (const name of ["startMigration", "migrationStatus", "abandonMigration"])
		assert.equal(typeof migrations[name], "function", name);
});

test("migration fixture uses real locked packages and raw-byte stamp reconstruction", (t) => {
	const f = fixture(t),
		base = createStamp(f.input);
	assert.equal(
		reconstructStamp({ storeRoot: f.storeRoot, digest: base.digest })
			.packages[0].sha256,
		f.pkg.sha256,
	);
	f.unchanged();
});

migrationTest(
	"start retains an immutable base and editable local/package/resource bytes outside active configuration",
	(t) => {
		const f = fixture(t),
			base = createStamp(f.input),
			result = start(f);
		assert.equal(result.recordVersion, 1);
		assert.equal(result.state, "open");
		assert.deepEqual(result.scope, [
			{ role: "reviewer", model: "small", host: "codex" },
		]);
		assert.equal(result.bases[0].stamp, base.digest);
		assert.equal(result.sharing, "fork");
		assert.deepEqual(result.collateral, []);
		const workspace = path.join(f.root, result.workspace);
		assert.deepEqual(
			fs.readFileSync(
				path.join(workspace, "local/.agent-profiles/profiles/base.md"),
			),
			fs.readFileSync(path.join(f.root, ".agent-profiles/profiles/base.md")),
		);
		assert.deepEqual(
			fs.readFileSync(path.join(workspace, "local/instructions/data.bin")),
			Buffer.from([0, 255, 13, 10]),
		);
		assert.deepEqual(
			fs.readFileSync(
				path.join(workspace, "packages", f.pkg.sha256, "support.bin"),
			),
			Buffer.from([255, 0, 13, 10]),
		);
		assert.ok(
			result.shared.some(
				(item) =>
					item.assignment.model === "large" &&
					item.assignment.role === "reviewer" &&
					item.assignment.host === "codex" &&
					item.bindings.includes("skills.review"),
			),
		);
		assert.ok(
			result.shared.some(
				(item) =>
					item.assignment.role === "writer" &&
					item.bindings.includes("profiles.base"),
			),
		);
		f.unchanged();
	},
);

migrationTest(
	"sharing must be chosen before recording a migration and invalid choices refuse",
	(t) => {
		const f = fixture(t);
		for (const sharing of [undefined, "automatic"])
			assert.throws(
				() => migrations.startMigration({ ...f.input, sharing }),
				/sharing.*fork.*shared/,
			);
		assert.equal(
			fs.existsSync(path.join(f.root, ".agent-profiles/migrations")),
			false,
		);
		f.unchanged();
	},
);

migrationTest(
	"shared revision includes all discovered collateral assignments and their immutable bases",
	(t) => {
		const f = fixture(t),
			result = migrations.startMigration({ ...f.input, sharing: "shared" });
		assert.deepEqual(
			result.collateral,
			result.shared.map((item) => item.assignment),
		);
		assert.equal(result.bases.length, result.collateral.length + 1);
		for (const base of result.bases)
			assert.ok(
				reconstructStamp({ digest: base.stamp, storeRoot: f.storeRoot })
					.composition.length >= 2,
			);
		assert.ok(
			result.collateral.some(
				(item) =>
					item.model === "large" &&
					item.role === "writer" &&
					item.host === "hermes",
			),
		);
		f.unchanged();
	},
);

migrationTest(
	"one open migration per canonical assignment includes model aliases and shared collateral",
	(t) => {
		const f = fixture(t),
			first = start(f);
		assert.throws(
			() =>
				migrations.startMigration({
					...f.input,
					model: "small-alias",
					sharing: "fork",
				}),
			/open migration/,
		);
		assert.throws(
			() =>
				migrations.startMigration({
					...f.input,
					model: "large",
					sharing: "shared",
				}),
			/open migration/,
		);
		assert.deepEqual(
			migrations.migrationStatus({ root: f.root }).map((item) => item.id),
			[first.id],
		);
		assert.equal(
			migrations.migrationStatus({ root: f.root, id: first.id }).state,
			"open",
		);
	},
);

migrationTest(
	"workspace edits/additions/deletions are reported without changing original resolution or base stamp",
	(t) => {
		const f = fixture(t),
			before = resolveInstructions(f.input),
			result = start(f);
		const workspace = path.join(f.root, result.workspace);
		const changed = `packages/${f.pkg.sha256}/SKILL.md`,
			removed = "local/instructions/data.bin",
			added = "local/instructions/new.md";
		put(path.join(workspace, changed), "# Candidate review\n");
		fs.unlinkSync(path.join(workspace, removed));
		put(path.join(workspace, added), "# New resource\n");
		const status = migrations.migrationStatus({ root: f.root, id: result.id });
		assert.equal(status.dirty, true);
		assert.equal(status.workspaceChanged, true);
		assert.deepEqual(
			status.changes,
			[
				{ path: removed, kind: "removed" },
				{ path: added, kind: "added" },
				{ path: changed, kind: "changed" },
			].sort((a, b) => a.path.localeCompare(b.path)),
		);
		assert.deepEqual(resolveInstructions(f.input), before);
		assert.equal(createStamp(f.input).digest, result.bases[0].stamp);
		const original = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: result.bases[0].stamp,
		});
		assert.match(
			original.packages[0].files
				.find((item) => item.path === "SKILL.md")
				.bytes.toString(),
			/Review\r\n/,
		);
		f.unchanged();
	},
);

migrationTest(
	"status is read-only and absent migration directories remain absent",
	(t) => {
		const f = fixture(t);
		assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
		assert.equal(
			fs.existsSync(path.join(f.root, ".agent-profiles/migrations")),
			false,
		);
		const result = start(f),
			file = recordPath(f, result.id),
			bytes = fs.readFileSync(file),
			time = fs.statSync(file).mtimeMs;
		const status = migrations.migrationStatus({ root: f.root, id: result.id });
		assert.equal(status.dirty, true);
		assert.equal(status.workspaceChanged, false);
		assert.deepEqual(status.changes, []);
		assert.deepEqual(fs.readFileSync(file), bytes);
		assert.equal(fs.statSync(file).mtimeMs, time);
	},
);

migrationTest(
	"abandon requires a reason, preserves workspace/evidence/base and releases the assignment",
	(t) => {
		const f = fixture(t),
			first = start(f),
			workspace = path.join(f.root, first.workspace);
		put(path.join(workspace, "notes.md"), "# Why this did not work\n");
		assert.throws(
			() =>
				migrations.abandonMigration({
					root: f.root,
					id: first.id,
					reason: " ",
				}),
			/reason/,
		);
		const result = migrations.abandonMigration({
			root: f.root,
			id: first.id,
			reason: "Try a narrower change",
		});
		assert.equal(result.state, "abandoned");
		assert.equal(result.reason, "Try a narrower change");
		assert.equal(
			migrations.migrationStatus({ root: f.root, id: first.id }).state,
			"abandoned",
		);
		assert.equal(
			fs.readFileSync(path.join(workspace, "notes.md"), "utf8"),
			"# Why this did not work\n",
		);
		assert.ok(
			reconstructStamp({
				digest: first.bases[0].stamp,
				storeRoot: f.storeRoot,
			}),
		);
		assert.notEqual(start(f).id, first.id);
		assert.throws(
			() =>
				migrations.abandonMigration({
					root: f.root,
					id: first.id,
					reason: "Again",
				}),
			/not open/,
		);
		f.unchanged();
	},
);

migrationTest(
	"explicit scope, safe IDs and strict record validation reject malformed input before writes",
	(t) => {
		const f = fixture(t);
		for (const key of ["role", "model", "host"])
			assert.throws(
				() =>
					migrations.startMigration({
						...f.input,
						[key]: undefined,
						sharing: "fork",
					}),
				new RegExp(key),
			);
		assert.throws(
			() =>
				migrations.startMigration({
					...f.input,
					surprise: true,
					sharing: "fork",
				}),
			/unknown.*surprise/,
		);
		assert.throws(
			() => migrations.migrationStatus({ root: f.root, id: "../outside" }),
			/id/,
		);
		assert.throws(
			() =>
				migrations.startMigration({
					...f.input,
					host: "unknown",
					sharing: "fork",
				}),
			/host/,
		);
		const result = start(f),
			file = recordPath(f, result.id),
			record = JSON.parse(fs.readFileSync(file, "utf8"));
		record.workspace = "../../outside";
		fs.writeFileSync(file, JSON.stringify(record));
		assert.throws(
			() => migrations.migrationStatus({ root: f.root, id: result.id }),
			/workspace/,
		);
		f.unchanged();
	},
);

migrationTest(
	"existing project writer prevents starting or abandoning without deleting the foreign lock",
	(t) => {
		const f = fixture(t),
			lock = path.join(f.root, ".agent-profiles/.migration-writer");
		fs.mkdirSync(lock);
		put(path.join(lock, "owner.txt"), "another operation");
		assert.throws(() => start(f), /migration-busy/);
		assert.equal(
			fs.readFileSync(path.join(lock, "owner.txt"), "utf8"),
			"another operation",
		);
		fs.rmSync(lock, { recursive: true });
		const result = start(f);
		fs.mkdirSync(lock);
		assert.throws(
			() =>
				migrations.abandonMigration({
					root: f.root,
					id: result.id,
					reason: "stop",
				}),
			/migration-busy/,
		);
		assert.equal(
			migrations.migrationStatus({ root: f.root, id: result.id }).state,
			"open",
		);
	},
);

migrationTest(
	"migration directories and editable workspace refuse links instead of following them",
	(t) => {
		const f = fixture(t),
			outside = path.join(f.dir, "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(
			outside,
			path.join(f.root, ".agent-profiles/migrations"),
			process.platform === "win32" ? "junction" : "dir",
		);
		assert.throws(() => start(f), /link|junction/);
		assert.deepEqual(fs.readdirSync(outside), []);
		fs.unlinkSync(path.join(f.root, ".agent-profiles/migrations"));
		const result = start(f);
		fs.symlinkSync(
			outside,
			path.join(f.root, result.workspace, "escape"),
			process.platform === "win32" ? "junction" : "dir",
		);
		assert.throws(
			() => migrations.migrationStatus({ root: f.root, id: result.id }),
			/link|junction|unsupported member/,
		);
		f.unchanged();
	},
);

function localFixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-migration-store-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { small: { profile: "base" } },
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Profile\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	return {
		root,
		role: "reviewer",
		model: "small",
		host: "codex",
		sharing: "fork",
	};
}
for (const member of [
	".migration-writer",
	".migration-writer/store",
	"migrations",
	"migrations/nested/store",
]) {
	for (const source of ["explicit", "environment"])
		migrationTest(
			`store overlap with ${member} via ${source} refuses before capture or project writes`,
			(t) => {
				const input = localFixture(t),
					storeRoot = path.join(input.root, ".agent-profiles", member);
				const paths = [
					".agent-profiles/agents.yaml",
					".agent-profiles/profiles/base.md",
					".agent-profiles/roles/reviewer.md",
				];
				const original = paths.map((p) => [
					p,
					fs.readFileSync(path.join(input.root, p)),
				]);
				const old = process.env.AGENT_PROFILES_STORE;
				if (source === "environment")
					process.env.AGENT_PROFILES_STORE = storeRoot;
				try {
					assert.throws(
						() =>
							migrations.startMigration({
								...input,
								...(source === "explicit" ? { storeRoot } : {}),
							}),
						/store.*overlap/,
					);
					assert.equal(fs.existsSync(storeRoot), false);
					assert.equal(
						fs.existsSync(
							path.join(input.root, ".agent-profiles/.migration-writer"),
						),
						false,
					);
					assert.equal(
						fs.existsSync(path.join(input.root, ".agent-profiles/migrations")),
						false,
					);
					for (const [p, bytes] of original)
						assert.deepEqual(fs.readFileSync(path.join(input.root, p)), bytes);
				} finally {
					if (old === undefined) delete process.env.AGENT_PROFILES_STORE;
					else process.env.AGENT_PROFILES_STORE = old;
				}
			},
		);
}
migrationTest(
	"a sibling store is permitted and explicit selection overrides a forbidden environment store",
	(t) => {
		const input = localFixture(t),
			storeRoot = path.join(input.root, ".agent-profiles/migrations-archive");
		const old = process.env.AGENT_PROFILES_STORE;
		process.env.AGENT_PROFILES_STORE = path.join(
			input.root,
			".agent-profiles/.migration-writer/store",
		);
		try {
			const result = migrations.startMigration({ ...input, storeRoot });
			assert.ok(
				reconstructStamp({ digest: result.bases[0].stamp, storeRoot })
					.composition.length >= 2,
			);
			assert.deepEqual(
				migrations.migrationStatus({ root: input.root }).map((item) => item.id),
				[result.id],
			);
		} finally {
			if (old === undefined) delete process.env.AGENT_PROFILES_STORE;
			else process.env.AGENT_PROFILES_STORE = old;
		}
	},
);

function intercept(t, name, wrapper) {
	const original = fs[name];
	fs[name] = wrapper(original);
	syncBuiltinESMExports();
	t.after(() => {
		fs[name] = original;
		syncBuiltinESMExports();
	});
}

migrationTest(
	"staged workspace bytes are read back before publishing a migration",
	(t) => {
		const f = fixture(t);
		let corrupted = false;
		intercept(t, "openSync", (original) => (target, ...args) => {
			const value = String(target).split(path.sep).join("/");
			if (
				!corrupted &&
				value.includes("/.migration-writer/migration-") &&
				value.endsWith("/record.json")
			) {
				corrupted = true;
				fs.writeFileSync(
					path.join(
						path.dirname(String(target)),
						"workspace/packages",
						f.pkg.sha256,
						"support.bin",
					),
					"damaged copy",
				);
			}
			return original(target, ...args);
		});
		assert.throws(() => start(f), /workspace.*mismatch/);
		assert.equal(corrupted, true);
		assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
		f.unchanged();
	},
);

migrationTest(
	"a local edit during staging refuses publication and preserves the edit",
	(t) => {
		const f = fixture(t),
			target = path.join(f.root, ".agent-profiles/roles/reviewer.md");
		let edited = false;
		intercept(t, "openSync", (original) => (file, ...args) => {
			const value = String(file).split(path.sep).join("/");
			if (
				!edited &&
				value.includes("/.migration-writer/migration-") &&
				value.endsWith("/record.json")
			) {
				edited = true;
				fs.writeFileSync(target, "# Concurrent user edit\n");
			}
			return original(file, ...args);
		});
		assert.throws(() => start(f), /stale-input/);
		assert.equal(edited, true);
		assert.equal(fs.readFileSync(target, "utf8"), "# Concurrent user edit\n");
		assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
	},
);

migrationTest(
	"late publication failure leaves no partial migration or lock and preserves existing data",
	(t) => {
		const f = fixture(t);
		let attempted = false;
		intercept(t, "renameSync", (original) => (from, to) => {
			if (
				String(from)
					.split(path.sep)
					.join("/")
					.includes("/.migration-writer/migration-")
			) {
				attempted = true;
				throw Object.assign(new Error("injected rename denied"), {
					code: "EACCES",
				});
			}
			return original(from, to);
		});
		assert.throws(() => start(f), /injected rename denied/);
		assert.equal(attempted, true);
		assert.equal(
			fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
			false,
		);
		assert.deepEqual(migrations.migrationStatus({ root: f.root }), []);
		f.unchanged();
	},
);

migrationTest(
	"abandon preserves a concurrently edited record rather than overwriting it",
	(t) => {
		const f = fixture(t),
			result = start(f),
			target = recordPath(f, result.id);
		let edited = false,
			concurrent;
		intercept(t, "openSync", (original) => (file, ...args) => {
			if (
				!edited &&
				String(file)
					.split(path.sep)
					.join("/")
					.endsWith("/.migration-writer/record.json")
			) {
				edited = true;
				concurrent = Buffer.concat([
					fs.readFileSync(target),
					Buffer.from("\n"),
				]);
				fs.writeFileSync(target, concurrent);
			}
			return original(file, ...args);
		});
		assert.throws(
			() =>
				migrations.abandonMigration({
					root: f.root,
					id: result.id,
					reason: "stop",
				}),
			/stale-input/,
		);
		assert.equal(edited, true);
		assert.deepEqual(fs.readFileSync(target), concurrent);
		assert.equal(
			migrations.migrationStatus({ root: f.root, id: result.id }).state,
			"open",
		);
	},
);

migrationTest(
	"CLI start/status/abandon returns clean JSON and validates action-specific options",
	(t) => {
		const f = fixture(t);
		const created = invoke(
			f,
			"start",
			"--role",
			f.role,
			"--model",
			f.model,
			"--host",
			f.host,
			"--sharing",
			"fork",
		);
		assert.equal(created.status, 0, created.stderr);
		const record = JSON.parse(created.stdout);
		const status = invoke(f, "status", record.id);
		assert.equal(status.status, 0, status.stderr);
		assert.equal(
			JSON.parse(status.stdout).bases[0].stamp,
			record.bases[0].stamp,
		);
		const abandoned = invoke(
			f,
			"abandon",
			record.id,
			"--reason",
			"No longer needed",
		);
		assert.equal(abandoned.status, 0, abandoned.stderr);
		assert.equal(JSON.parse(abandoned.stdout).state, "abandoned");
		for (const args of [
			["publish"],
			["status", "--role", "reviewer"],
			["start", "--role", "reviewer", "--role", "writer"],
			["start", "--skill", "extra"],
			["status", record.id, "--sharing", "fork"],
		]) {
			const rejected = invoke(f, ...args);
			assert.notEqual(rejected.status, 0, args.join(" "));
		}
		f.unchanged();
	},
);

const { retainRevisionManifest } = await import("../src/revisions.ts");
const { verifyStamp } = await import("../src/stamps.js");
const { parseYaml } = await import("../src/resolve.ts");
const workspaceBoundaryOriginalStore = process.env.AGENT_PROFILES_STORE;
function workspaceBoundaryFixture(t) {
	const f = fixture(t),
		ambient = path.join(f.dir, "ambient-store"),
		home = path.join(f.dir, "home");
	fs.mkdirSync(ambient);
	fs.mkdirSync(home);
	put(path.join(ambient, "marker.txt"), "Unrelated synthetic store\r\n");
	process.env.AGENT_PROFILES_STORE = ambient;
	t.after(() => {
		if (workspaceBoundaryOriginalStore === undefined)
			delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = workspaceBoundaryOriginalStore;
	});
	return { ...f, ambient, home };
}
function workspaceBoundarySnapshot(root) {
	const rows = [];
	function scan(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name,
				target = path.join(root, member),
				stat = fs.lstatSync(target);
			if (stat.isSymbolicLink())
				rows.push([member, "link", fs.readlinkSync(target)]);
			else if (stat.isDirectory()) {
				rows.push([member, "directory"]);
				scan(member);
			} else
				rows.push([
					member,
					stat.nlink,
					fs.readFileSync(target).toString("hex"),
				]);
		}
	}
	scan();
	return rows;
}
const workspaceBoundaryState = (f) =>
	[f.root, f.storeRoot, f.ambient].map(workspaceBoundarySnapshot);
const { integrations: workspaceConfig3Hosts } = await import(
	"../src/integrations.ts"
);
// A successful native start may add only the migration namespace and immutable stamp/blob backing; everything else is preserved.
function workspaceConfig3Started(f, record, before, sharing) {
	const key = (a) => JSON.stringify([a.role, a.model, a.host]),
		primary = { role: f.role, model: f.model, host: f.host };
	const others = ["small", "large"]
		.flatMap((model) =>
			workspaceConfig3Hosts.map(({ id }) => ({
				role: f.role,
				model,
				host: id,
			})),
		)
		.filter((a) => key(a) !== key(primary))
		.sort((a, b) => (key(a) < key(b) ? -1 : 1));
	assert.equal(record.state, "open");
	assert.equal(record.sharing, sharing);
	assert.deepEqual(record.scope, [primary]);
	assert.deepEqual(
		record.shared,
		others.map((assignment) => ({
			assignment,
			bindings: ["profiles.base", "roles.reviewer"],
		})),
		"direct profile/role roots only; dependency and workflow parts are not logical bindings",
	);
	assert.deepEqual(record.collateral, sharing === "shared" ? others : []);
	assert.deepEqual(
		record.bases.map((base) => base.assignment),
		[primary, ...record.collateral],
	);
	for (const base of record.bases) {
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
	const [project, store, ambient] = workspaceBoundaryState(f),
		namespace = ".agent-profiles/migrations";
	assert.deepEqual(
		project.filter(
			([member]) => member !== namespace && !member.startsWith(`${namespace}/`),
		),
		before[0],
		"active config, lock and sources unchanged",
	);
	assert.ok(
		project.some(
			([member]) => member === `${namespace}/${record.id}/record.json`,
		),
		"recorded migration published",
	);
	const now = new Map(store.map((row) => [row[0], row])),
		prior = new Set(before[1].map((row) => row[0]));
	for (const row of before[1])
		assert.deepEqual(
			now.get(row[0]),
			row,
			`existing store row ${row[0]} unchanged`,
		);
	for (const [member] of store)
		if (!prior.has(member))
			assert.match(
				member,
				/^(stamps|blobs)(\/|$)/,
				`only immutable stamp/blob backing added: ${member}`,
			);
	assert.deepEqual(ambient, before[2], "ambient store untouched");
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
		false,
	);
	assert.equal(fs.existsSync(path.join(f.storeRoot, ".writer-lock")), false);
	const status = migrations.migrationStatus({ root: f.root, id: record.id });
	assert.equal(status.id, record.id);
	assert.equal(status.workspaceChanged, false);
	assert.deepEqual(status.changes, []);
	assert.deepEqual(
		migrations.migrationStatus({ root: f.root }).map((item) => item.id),
		[record.id],
	);
}
function dependencyProfileConfig3(t) {
	const f = workspaceBoundaryFixture(t);
	function add(name, type, entrypoint, entry, workflow) {
		const source = path.join(f.dir, name);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: `@example/${name}`, version: "1.0.0", type },
				entrypoint,
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(path.join(source, entrypoint), entry);
		if (workflow !== null) put(path.join(source, "WORKFLOW.md"), workflow);
		return importPackage({ sourceDirectory: source, storeRoot: f.storeRoot });
	}
	const helperTask =
		"---\r\nname: helper\r\ndescription: Fictional helper\r\n---\r\n# Helper task\r\n";
	const helperWorkflow = "# Helper workflow\r\nRetain evidence.  \r\n",
		profileTask = "\uFEFF# Package profile\r\n";
	const helper = add("helper", "skill", "SKILL.md", helperTask, helperWorkflow);
	const profile = add(
		"profile-base",
		"instruction",
		"PROFILE.md",
		profileTask,
		null,
	);
	function record(pkg, workflow, dependencies = []) {
		const manifestFile = path.join(f.dir, "workspace-boundary-revision.json");
		put(
			manifestFile,
			JSON.stringify({
				revisionVersion: 1,
				identity: pkg.identity,
				kind: "release",
				content: { identity: pkg.identity, sha256: pkg.sha256 },
				parent: null,
				candidate: null,
				dependencies,
				workflow,
				provenance: {
					kind: "legacy-adoption",
					workflowChange: {
						kind: "initial",
						reason: "Fictional owned workspace-boundary fixture.",
					},
				},
			}),
		);
		return retainRevisionManifest({ storeRoot: f.storeRoot, manifestFile });
	}
	const helperRecord = record(helper, {
		file: "WORKFLOW.md",
		provides: [],
		requires: [],
	});
	const profileRecord = record(
		profile,
		{ file: null, provides: [], requires: [] },
		[
			{
				...helper.identity,
				sha256: helper.sha256,
				revisionDigest: helperRecord.recordDigest,
			},
		],
	);
	fs.unlinkSync(path.join(f.root, ".agent-profiles/profiles/base.md"));
	put(
		path.join(f.root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 3,
			default_profile: "base",
			default_role: f.role,
			profiles: {
				base: {
					package: profile.identity.name,
					version: profile.identity.version,
					revision: profileRecord.recordDigest,
				},
			},
			models: { small: { profile: "base" }, large: { profile: "base" } },
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
			skills: {},
		}),
	);
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const resolved = resolveInstructions(f.input);
	assert.deepEqual(
		resolved.loaded.map((part) => part.kind),
		["dependency", "workflow", "profile", "role"],
	);
	assert.deepEqual(
		resolved.loaded.slice(0, 3).map((part) => part.content),
		[helperTask, helperWorkflow, profileTask],
	);
	assert.equal(resolved.loaded[0].backing.sha256, helper.sha256);
	assert.equal(
		resolved.loaded[2].package.revisionDigest,
		profileRecord.recordDigest,
	);
	const captured = createStamp({ ...f.input, model: "large" });
	assert.equal(captured.snapshot.stampVersion, 2);
	assert.equal(
		captured.snapshot.selection.identity.canonical,
		"large",
		"other-model stamp leaves start scope uncaptured",
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/migrations")),
		false,
	);
	return f;
}

test("config3 dependency-first profile migration start succeeds for both sharing choices with direct-root sharing", (t) => {
	for (const sharing of ["fork", "shared"]) {
		const f = dependencyProfileConfig3(t),
			before = workspaceBoundaryState(f),
			active = resolveInstructions(f.input);
		const record = migrations.startMigration({ ...f.input, sharing });
		workspaceConfig3Started(f, record, before, sharing);
		assert.deepEqual(
			resolveInstructions(f.input),
			active,
			"ordinary selection unchanged",
		);
	}
});

test("CLI config3 dependency-first profile start succeeds with success JSON and reopenable status", (t) => {
	const f = dependencyProfileConfig3(t),
		before = workspaceBoundaryState(f);
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"migrate",
			"start",
			"--role",
			f.role,
			"--model",
			f.model,
			"--host",
			f.host,
			"--sharing",
			"fork",
			"--root",
			f.root,
			"--store",
			f.storeRoot,
			"--json",
		],
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
	assert.equal(result.error, undefined, "spawn denial is not business RED");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const record = JSON.parse(result.stdout);
	workspaceConfig3Started(f, record, before, "fork");
	const status = spawnSync(
		process.execPath,
		[cli, "migrate", "status", record.id, "--root", f.root, "--json"],
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
	assert.equal(status.error, undefined);
	assert.equal(status.status, 0, status.stderr);
	const reopened = JSON.parse(status.stdout);
	assert.equal(reopened.id, record.id);
	assert.deepEqual(reopened.bases, record.bases);
	assert.equal(reopened.workspaceChanged, false);
});

test("existing config2 workspace status and abandon survive active base conversion to config3 with valid stamp2", (t) => {
	const f = workspaceBoundaryFixture(t),
		created = start(f);
	assert.equal(created.sharing, "fork");
	assert.ok(created.shared.length > 0);
	assert.ok(created.bases.length > 0);
	assert.ok(
		created.shared.every((row) =>
			row.bindings.every((binding) =>
				/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(binding),
			),
		),
	);
	const base = created.bases[0].stamp,
		original = reconstructStamp({ storeRoot: f.storeRoot, digest: base });
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: base }).managedReproducible,
		true,
	);
	assert.equal(
		migrations.migrationStatus({ root: f.root, id: created.id }).state,
		"open",
	);
	const configFile = path.join(f.root, ".agent-profiles/agents.yaml"),
		config = fs.readFileSync(configFile, "utf8");
	assert.equal(parseYaml(config).get("version"), 2);
	put(configFile, config.replace(/^version: 2(?=\r?$)/m, "version: 3"));
	assert.equal(
		parseYaml(fs.readFileSync(configFile, "utf8")).get("version"),
		3,
	);
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(
		JSON.parse(
			fs.readFileSync(
				path.join(f.root, ".agent-profiles/agent-profiles.lock"),
				"utf8",
			),
		).lockVersion,
		2,
	);
	assert.ok(resolveInstructions(f.input).loaded.length > 0);
	const active = createStamp(f.input);
	assert.equal(active.snapshot.stampVersion, 2);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: active.digest })
			.managedReproducible,
		true,
	);
	const before = workspaceBoundaryState(f),
		recordBytes = fs.readFileSync(recordPath(f, created.id));
	const status = migrations.migrationStatus({ root: f.root, id: created.id });
	assert.equal(status.state, "open");
	assert.equal(status.workspaceChanged, false);
	assert.deepEqual(status.bases, created.bases);
	assert.deepEqual(status.shared, created.shared);
	assert.deepEqual(
		migrations.migrationStatus({ root: f.root }).map((item) => item.id),
		[created.id],
	);
	assert.deepEqual(
		reconstructStamp({ storeRoot: f.storeRoot, digest: base }),
		original,
	);
	assert.deepEqual(
		workspaceBoundaryState(f),
		before,
		"old record/base reads do not touch active v3 inputs or retained stores",
	);
	const reason = "Retain the old workspace after an explicit base conversion";
	const abandoned = migrations.abandonMigration({
		root: f.root,
		id: created.id,
		reason,
	});
	assert.deepEqual(abandoned, {
		...JSON.parse(recordBytes.toString("utf8")),
		state: "abandoned",
		reason,
	});
	assert.equal(
		migrations.migrationStatus({ root: f.root, id: created.id }).state,
		"abandoned",
	);
	const after = workspaceBoundaryState(f),
		relativeRecord = `.agent-profiles/migrations/${created.id}/record.json`;
	assert.deepEqual(
		after[0].filter((row) => row[0] !== relativeRecord),
		before[0].filter((row) => row[0] !== relativeRecord),
		"only the existing record may change",
	);
	assert.deepEqual(
		after.slice(1),
		before.slice(1),
		"abandon preserves immutable bases and ambient store",
	);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(recordPath(f, created.id), "utf8")),
		abandoned,
	);
	assert.deepEqual(
		reconstructStamp({ storeRoot: f.storeRoot, digest: base }),
		original,
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: active.digest })
			.managedReproducible,
		true,
	);
});
