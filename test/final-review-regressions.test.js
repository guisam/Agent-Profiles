import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyMaterialization } from "../src/materialize.ts";
import { installDependencies } from "../src/package-lock.ts";
import { lookupPackage } from "../src/package-store.ts";
import { createStamp, verifyStamp } from "../src/stamps.ts";

const CLI_WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/package-cli-worker.mjs", import.meta.url),
);
const STORE_MODULE = new URL("../src/package-store.ts", import.meta.url).href;
const LOCK_MODULE = new URL("../src/package-lock.ts", import.meta.url).href;
const CONFIG = ".agent-profiles/agents.yaml";
const PROFILE = Buffer.from("\uFEFF# Profile\r\nExact profile.\r\n");
const ROLE = Buffer.from("# Reviewer\r\nExact role.\r\n");
const MISSING = "0".repeat(64);
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};

// Raw bytes, empty directories and link targets; timestamps change on harmless reads.
function tree(root) {
	if (!fs.existsSync(root)) return null;
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort()
		.map((p) => {
			const file = path.join(root, p),
				stat = fs.lstatSync(file);
			return [
				p,
				stat.isSymbolicLink()
					? `link:${fs.readlinkSync(file)}`
					: stat.isDirectory()
						? "directory"
						: fs.readFileSync(file).toString("hex"),
			];
		});
}

function fixture(t) {
	// Reuse the CLI worker's established owned-child convention.
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p9-cli-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		home = path.join(dir, "home");
	const override = path.join(dir, "claude-config");
	for (const p of [
		root,
		storeRoot,
		home,
		override,
		path.join(home, "archives"),
		path.join(home, ".agents/skills"),
		path.join(home, ".claude/skills"),
		path.join(override, "plugins"),
	])
		fs.mkdirSync(p, { recursive: true });
	put(
		path.join(root, CONFIG),
		"version: 2\ndefault_profile: base\ndefault_role: reviewer\nmodels: {}\nfamilies: {}\nroles:\n  reviewer:\n    file: roles/reviewer.md\n    skills:\n      required: []\n      available: []\nskills: {}\n",
	);
	put(path.join(root, ".agent-profiles/profiles/base.md"), PROFILE);
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), ROLE);
	put(path.join(home, ".claude/settings.json"), '{"owned":true}\r\n');
	put(path.join(override, "plugins/keep.bin"), Buffer.from([0, 255, 13, 10]));
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		TMP: dir,
		TEMP: dir,
		TMPDIR: dir,
		AGENT_PROFILES_STORE: storeRoot,
	};
	// Absence means the default Claude config; never inherit host configuration.
	delete env.CLAUDE_CONFIG_DIR;
	delete env.AGENT_PROFILES_SKILL_SOURCES;
	delete env.NODE_OPTIONS;
	return { dir, root, storeRoot, home, override, env, auditId: 0 };
}

function cli(f, digest, outputRoot, environment = f.env) {
	const destination = path.join(outputRoot, "exported");
	const audit = path.join(f.dir, `audit-${f.auditId++}.json`);
	const argv = [
		"materialize",
		digest,
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		"--adapter",
		"filesystem-v1",
		"--output-root",
		outputRoot,
		"--destination",
		destination,
		"--json",
	];
	const result = spawnSync(
		process.execPath,
		[
			CLI_WORKER,
			JSON.stringify({
				op: "cli",
				ownedRoot: f.dir,
				cwd: f.root,
				storeRoot: f.storeRoot,
				audit,
				argv,
			}),
		],
		{ cwd: f.dir, env: environment, encoding: "utf8", timeout: 10000 },
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.ok(fs.existsSync(audit), "CLI worker reached its audit hook");
	const counts = JSON.parse(fs.readFileSync(audit, "utf8"));
	assert.deepEqual(
		counts.dispatch,
		[],
		"no native host or acquisition dispatch",
	);
	assert.equal(counts.listen, 0);
	return { ...result, counts, destination };
}

function refusal(result, diagnostic) {
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^Agent Profiles: /);
	assert.match(result.stderr, diagnostic);
}

const protectedCases = [
	["default Codex user skills", (f) => path.join(f.home, ".agents/skills")],
	["default Claude skills", (f) => path.join(f.home, ".claude/skills")],
	["entire default Claude config", (f) => path.join(f.home, ".claude")],
	[
		"explicit Claude config plugins",
		(f) => path.join(f.override, "plugins"),
		(f) => ({ ...f.env, CLAUDE_CONFIG_DIR: f.override }),
	],
	[
		"empty Claude override fails closed",
		(f) => path.join(f.home, "archives"),
		(f) => ({ ...f.env, CLAUDE_CONFIG_DIR: "" }),
		/CLAUDE_CONFIG_DIR/,
	],
];
for (const [
	name,
	output,
	environment,
	diagnostic = /protected overlap/,
] of protectedCases) {
	test(`F01 ${name}: refusal precedes absent stamp backing`, (t) => {
		const f = fixture(t),
			outputRoot = output(f);
		const before = [
			tree(f.root),
			tree(f.storeRoot),
			tree(f.home),
			tree(f.override),
		];
		const result = cli(
			f,
			MISSING,
			outputRoot,
			environment ? environment(f) : f.env,
		);
		// These checks execute even when the current CLI gives the wrong refusal.
		assert.equal(fs.existsSync(result.destination), false);
		assert.deepEqual(
			[tree(f.root), tree(f.storeRoot), tree(f.home), tree(f.override)],
			before,
		);
		refusal(result, diagnostic);
		assert.doesNotMatch(result.stderr, /backing-missing|stamp-missing/);
		assert.equal(
			result.counts.backingReads,
			0,
			"host-root denial must precede backing access",
		);
	});
}

test("F01 ordinary missing-stamp control admits CLI arguments and reaches stamp lookup", (t) => {
	const f = fixture(t),
		before = [tree(f.root), tree(f.storeRoot), tree(f.home), tree(f.override)];
	const result = cli(f, MISSING, path.join(f.home, "archives"));
	assert.equal(fs.existsSync(result.destination), false);
	assert.deepEqual(
		[tree(f.root), tree(f.storeRoot), tree(f.home), tree(f.override)],
		before,
	);
	refusal(result, /backing-missing|stamp-missing/);
	// Missing directories may fail lstat before open; the valid-stamp control below
	// independently qualifies the backing-read observer with real reads.
});

test("F01 valid stamp exports normally to an ordinary fake-HOME archive", (t) => {
	const f = fixture(t),
		stamp = createStamp({
			root: f.root,
			storeRoot: f.storeRoot,
			host: "codex",
		});
	assert.equal(
		verifyStamp({ digest: stamp.digest, storeRoot: f.storeRoot })
			.managedReproducible,
		true,
	);
	const output = path.join(f.home, "archives");
	const before = [
		tree(f.root),
		tree(f.storeRoot),
		tree(path.join(f.home, ".claude")),
		tree(path.join(f.home, ".agents")),
		tree(f.override),
	];
	const result = cli(f, stamp.digest, output);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.status, "committed");
	assert.equal(receipt.stampDigest, stamp.digest);
	assert.ok(result.counts.backingReads > 0, "real valid backing was read");
	assert.deepEqual(
		fs.readFileSync(
			path.join(result.destination, "content/instructions/0000.md"),
		),
		PROFILE,
	);
	assert.deepEqual(
		fs.readFileSync(
			path.join(result.destination, "content/instructions/0001.md"),
		),
		ROLE,
	);
	assert.deepEqual(
		verifyMaterialization({
			destination: result.destination,
			expectedStampDigest: stamp.digest,
			storeRoot: f.storeRoot,
		}),
		{ verified: true, findings: [] },
	);
	assert.deepEqual(
		[
			tree(f.root),
			tree(f.storeRoot),
			tree(path.join(f.home, ".claude")),
			tree(path.join(f.home, ".agents")),
			tree(f.override),
		],
		before,
	);
	assert.deepEqual(
		fs.readdirSync(output),
		["exported"],
		"no leftover staging or lock",
	);
});

// Portable root-unavailable model, NOT native missing-drive qualification. Only
// ancestor lstat results are replaced; parent evidence separately confirms Windows.
const rootUnavailable = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  const q = JSON.parse(process.argv[1]);
  const native = fs.lstatSync, terminal = path.parse(q.target).root;
  const ancestors = new Set();
  for (let p = q.target;; p = path.dirname(p)) {
    ancestors.add(path.resolve(p));
    if (p === path.dirname(p)) break;
  }
  assert.ok(native(terminal).isDirectory(), 'real root remains available');
  assert.ok(native(q.project).isDirectory(), 'real project exists');
  let rootObservations = 0;
  fs.lstatSync = function (file, ...args) {
    const selected = path.resolve(String(file));
    if (!ancestors.has(selected)) return native.call(fs, file, ...args);
    if (selected === path.resolve(terminal) && ++rootObservations >= 20) {
      throw Object.assign(new Error('ROOT_OBSERVATION_CAP'), { code: 'TEST_ROOT_CAP' });
    }
    throw Object.assign(new Error('modeled unavailable ancestor: ' + selected), { code: 'ENOENT', path: selected });
  };
  syncBuiltinESMExports();
  const observed = await import('node:fs');
  assert.throws(() => observed.lstatSync(terminal), { code: 'ENOENT' });
  assert.equal(rootObservations, 1, 'named ESM lstat interception qualified');
  assert.ok(observed.lstatSync(q.project).isDirectory(), 'unrelated owned IO delegates');
  rootObservations = 0;
  // Imports and qualification are outside the operation-error catch.
  const store = await import(q.storeModule), lock = await import(q.lockModule);
  let error;
  try {
    if (q.op === 'lookup') store.lookupPackage({ storeRoot: q.target, name: '@example/absent', version: '1.0.0' });
    else lock.installDependencies({ root: q.project, storeRoot: q.target });
  } catch (caught) { error = { code: caught.code ?? null, message: caught.message }; }
  fs.lstatSync = native; syncBuiltinESMExports();
  console.log(JSON.stringify({ qualified: true, rootObservations, terminal, target: q.target, error: error ?? null }));
`;

for (const op of ["lookup", "install"]) {
	test(`F03 ${op}: unavailable terminal root fails actionably before 20 observations`, (t) => {
		const f = fixture(t),
			target = path.join(f.dir, "unavailable-volume", "store");
		const before = tree(f.dir);
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				rootUnavailable,
				JSON.stringify({
					op,
					target,
					project: f.root,
					storeModule: STORE_MODULE,
					lockModule: LOCK_MODULE,
				}),
			],
			{ cwd: f.dir, env: f.env, encoding: "utf8", timeout: 10000 },
		);
		assert.ifError(result.error);
		assert.equal(result.signal, null);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const observed = JSON.parse(result.stdout);
		assert.equal(observed.qualified, true);
		assert.deepEqual(
			tree(f.dir),
			before,
			"no project, store, home or fixture changes",
		);
		assert.equal(fs.existsSync(target), false);
		assert.ok(
			observed.rootObservations > 0,
			"public operation reached the modeled terminal root",
		);
		assert.ok(observed.error, "missing terminal root must refuse");
		assert.notEqual(
			observed.error.code,
			"TEST_ROOT_CAP",
			"observation sentinel is a regression failure, never an accepted error",
		);
		assert.ok(
			observed.rootObservations < 20,
			"production must terminate before the cap",
		);
		assert.match(observed.error.message, /store/i);
		assert.match(
			observed.error.message,
			/root|ancestor|directory|filesystem|ENOENT/i,
		);
		assert.match(
			observed.error.message,
			/missing|exist|unavailable|cannot|not found|ENOENT/i,
		);
	});
}

test("F03 lookup accepts an ordinary missing child beneath an existing ancestor", (t) => {
	const f = fixture(t),
		storeRoot = path.join(f.dir, "ordinary", "nested-store"),
		before = tree(f.dir);
	assert.equal(
		lookupPackage({ storeRoot, name: "@example/absent", version: "1.0.0" }),
		null,
	);
	assert.deepEqual(tree(f.dir), before);
	assert.equal(fs.existsSync(storeRoot), false);
});

test("F03 install accepts an ordinary missing child beneath an existing ancestor", (t) => {
	const f = fixture(t),
		storeRoot = path.join(f.dir, "ordinary", "nested-store");
	const before = tree(f.dir),
		lockPath = ".agent-profiles/agent-profiles.lock";
	installDependencies({ root: f.root, storeRoot });
	const lock = JSON.parse(fs.readFileSync(path.join(f.root, lockPath), "utf8"));
	assert.equal(lock.lockVersion, 1);
	assert.equal(lock.configurationVersion, 2);
	assert.deepEqual(lock.pins, []);
	assert.deepEqual(lock.packages, []);
	assert.equal(
		fs.existsSync(storeRoot),
		false,
		"zero-pin installation need not create the store",
	);
	assert.deepEqual(
		tree(f.dir).filter(([p]) => p !== `project/${lockPath}`),
		before,
		"only the expected empty lock was added",
	);
});
