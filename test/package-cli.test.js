import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { readConfiguration } from "../src/configure.ts";
import { formatContext, resolutionOutput } from "../src/diagnostics.ts";
import { inspectRepository } from "../src/inspect.ts";
import { doctor, install } from "../src/install.ts";
import * as materializer from "../src/materialize.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage, lookupPackage } from "../src/package-store.ts";
import { readPackage } from "../src/packages.ts";
import { runPreset } from "../src/preset-wizard.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { discoverSkills } from "../src/skills.ts";
import {
	createStamp,
	diffStamps,
	reconstructStamp,
	verifyStamp,
} from "../src/stamps.ts";
import { configureRoles } from "../src/wizard.ts";

// P9a RED only. No missing-CLI skip: native CLI assertions must expose actual dispatch failures.
// Only the new digest-to-export API body is skipped when its exact export is absent.
const WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/package-cli-worker.mjs", import.meta.url),
);
const REPO = fileURLToPath(new URL("../", import.meta.url));
const CONFIG = ".agent-profiles/agents.yaml",
	LOCK = ".agent-profiles/agent-profiles.lock";
const NAME = "@example/security-review";
const MODELS = ["fictional-review-small", "fictional-review-large"];
const PROFILE = Buffer.from("\uFEFF# Profile\r\nBounded review.\r\n");
const ROLE = Buffer.from("# Reviewer\r\nInspect evidence.\r\n");
const SHARED = Buffer.from("\uFEFF# Shared\r\nRespect local policy.\r\n");
const caps = {
	bytePreservation: "verified",
	filesystemIsolation: "verified",
	nativeLayout: "unsupported",
	nativeInvocation: "unsupported",
	hostVisibilityIsolation: "unverified",
	runtimeRendering: "unverified",
};
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const canonical = (value) =>
	Array.isArray(value)
		? `[${value.map(canonical).join(",")}]`
		: value !== null && typeof value === "object"
			? `{${Object.keys(value)
					.sort(cmp)
					.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
					.join(",")}}`
			: JSON.stringify(value);
const u64 = (n) => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(BigInt(n));
	return b;
};
const recordHash = (value, domain) => {
	const bytes = Buffer.from(canonical(value));
	return sha(
		Buffer.concat([Buffer.from(`${domain}\0`), u64(bytes.length), bytes]),
	);
};
function treeHash(files, domain = "agent-profiles/package-tree/v1") {
	return sha(
		Buffer.concat([
			Buffer.from(`${domain}\0`),
			u64(files.length),
			...[...files]
				.sort((a, b) => cmp(a.path, b.path))
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
function files(root) {
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort(cmp)
		.filter((p) => fs.lstatSync(path.join(root, p)).isFile())
		.map((p) => ({ path: p, bytes: fs.readFileSync(path.join(root, p)) }));
}
function fingerprint(root, exclude = []) {
	if (!fs.existsSync(root)) return null;
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort(cmp)
		.filter((p) => !exclude.includes(p))
		.map((p) => {
			const full = path.join(root, p),
				stat = fs.lstatSync(full);
			return [
				p,
				stat.isSymbolicLink()
					? `link:${fs.readlinkSync(full)}`
					: stat.isDirectory()
						? "directory"
						: sha(fs.readFileSync(full)),
			];
		});
}
function release(version, native = false, ambient = false) {
	const manifest = {
		schema_version: 1,
		package: { name: NAME, version, type: "skill" },
		entrypoint: "SKILL.md",
		behavior: {
			delivery: native ? "native" : "instruction",
			hosts: native ? ["claude", "codex"] : [],
			effects: [],
		},
	};
	return [
		{ path: "package.yaml", bytes: Buffer.from(stringify(manifest)) },
		{
			path: "SKILL.md",
			bytes: Buffer.from(
				`---\nname: Security review\ndescription: Inspect security boundaries.\n---\n${ambient ? "Ambient WRONG" : "Security review"} ${version}\r\n`,
			),
		},
		{ path: "support/note.txt", bytes: Buffer.from(`Support ${version}\r\n`) },
		{
			path: "assets/data.bin",
			bytes: Buffer.from([
				0,
				255,
				version === "1.0.0" ? 1 : 2,
				192,
				175,
				13,
				10,
			]),
		},
	].sort((a, b) => cmp(a.path, b.path));
}
function fixture(t, { seeded = true, locked = true, native = false } = {}) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p9-cli-")),
	);
	t.after(() => {
		assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
		assert.ok(path.basename(dir).startsWith("p9-cli-"));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const root = path.join(dir, "project with spaces"),
		storeRoot = path.join(dir, "explicit store");
	const ambient = path.join(dir, "ambient store"),
		outputRoot = path.join(dir, "exports"),
		home = path.join(dir, "home");
	for (const p of [root, storeRoot, ambient, outputRoot, home]) fs.mkdirSync(p);
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "reviewer",
		models: Object.fromEntries(
			MODELS.map((model) => [model, { profile: "base" }]),
		),
		families: {
			fictional: { profile: "base", match: { prefixes: ["fictional-"] } },
		},
		profiles: { base: { file: "profiles/base.md" } },
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: ["security-review"], available: [] },
			},
		},
		skills: { "security-review": { package: NAME, version: "1.0.0" } },
		assignments: {
			"large-review": {
				when: { model: MODELS[1], role: "reviewer" },
				versions: { "skills.security-review": "2.0.0" },
			},
		},
	};
	put(path.join(root, ".agent-profiles/profiles/base.md"), PROFILE);
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), ROLE);
	put(path.join(root, "AGENTS.md"), SHARED);
	const save = () => put(path.join(root, CONFIG), stringify(config));
	save();
	const packages = ["1.0.0", "2.0.0"].map((version) => {
		const source = path.join(dir, "sources", version),
			members = release(version, native);
		for (const m of members) put(path.join(source, m.path), m.bytes);
		const pkg = readPackage({ root: source });
		assert.deepEqual(
			pkg.files,
			members,
			"fixture uses actual package validator",
		);
		assert.equal(pkg.sha256, treeHash(members), "independent full-tree digest");
		if (seeded) importPackage({ sourceDirectory: source, storeRoot });
		const misleading = path.join(dir, "ambient sources", version);
		for (const m of release(version, native, true))
			put(path.join(misleading, m.path), m.bytes);
		importPackage({ sourceDirectory: misleading, storeRoot: ambient });
		return { version, source, members, digest: pkg.sha256 };
	});
	if (seeded && locked) installDependencies({ root, storeRoot });
	const f = {
		dir,
		root,
		storeRoot,
		ambient,
		home,
		outputRoot,
		config,
		save,
		packages,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			AGENT_PROFILES_STORE: ambient,
		},
	};
	f.select = (index = 0) => ({
		root: f.root,
		storeRoot: f.storeRoot,
		host: "codex",
		model: MODELS[index],
		identitySource: "user",
		role: "reviewer",
	});
	f.args = (index = 0) => [
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		"--host",
		"codex",
		"--model",
		MODELS[index],
		"--identity-source",
		"user",
		"--role",
		"reviewer",
	];
	f.sources = () =>
		packages.flatMap((p) => ["--source", NAME, p.version, p.source]);
	return f;
}
function qualified(f) {
	for (let i = 0; i < 2; i++) {
		const r = resolveInstructions(f.select(i)),
			pkg = f.packages[i];
		assert.equal(r.lockState, "valid");
		assert.equal(r.installRequired, false);
		assert.deepEqual(
			r.loaded.map((e) => [e.kind, e.id]),
			[
				["profile", "base"],
				["role", "reviewer"],
				["required-skill", "security-review"],
			],
		);
		assert.deepEqual(r.required[0].package, {
			binding: "skills.security-review",
			name: NAME,
			version: pkg.version,
			sha256: pkg.digest,
			selectedBy: i ? "large-review" : "binding-default",
			selectors: i ? { model: MODELS[1], role: "reviewer" } : {},
		});
		assert.equal(
			r.loaded[2].content,
			pkg.members.find((m) => m.path === "SKILL.md").bytes.toString("utf8"),
		);
		assert.ok(
			!JSON.stringify(r).includes(f.storeRoot),
			"operational store is absent from portable selection",
		);
	}
	assert.throws(
		() => resolveInstructions({ ...f.select(), storeRoot: f.ambient }),
		/mismatched-package/,
	);
}
function child(f, argv, options = {}) {
	const { environment = f.env, ...requestOptions } = options;
	const defaultsBefore = [fingerprint(f.ambient), fingerprint(f.home)];
	const audit = path.join(f.dir, `audit-${child.id++}.json`);
	const request = {
		op: "cli",
		ownedRoot: f.dir,
		cwd: f.root,
		storeRoot: f.storeRoot,
		audit,
		argv,
		...requestOptions,
	};
	const r = spawnSync(process.execPath, [WORKER, JSON.stringify(request)], {
		cwd: f.dir,
		env: environment,
		encoding: "utf8",
	});
	assert.ifError(r.error);
	assert.equal(r.signal, null, "native child terminated normally");
	assert.ok(fs.existsSync(audit), `worker audit missing: ${r.stderr}`);
	assert.deepEqual(
		[fingerprint(f.ambient), fingerprint(f.home)],
		defaultsBefore,
		"explicit operations must not mutate ambient defaults",
	);
	return { ...r, counts: JSON.parse(fs.readFileSync(audit, "utf8")) };
}
child.id = 0;
function success(r, label) {
	assert.equal(r.status, 0, `${label}: ${r.stderr}\n${r.stdout}`);
	assert.equal(r.stderr, "", `${label}: no stderr`);
	assert.deepEqual(
		r.counts.dispatch,
		[],
		`${label}: no acquisition/native dispatch`,
	);
	assert.doesNotMatch(
		r.stdout,
		/^Agent Profiles\r?\nRepository:/,
		`${label}: no banner`,
	);
	return JSON.parse(r.stdout);
}
function refusal(r, diagnostic) {
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.equal(r.stdout, "", "usage/refusal stdout must be empty");
	assert.match(r.stderr, /^Agent Profiles: /);
	assert.match(r.stderr, diagnostic);
	assert.doesNotMatch(
		r.stderr,
		/Choose one command|Unknown option/,
		"must reach the named contract guard",
	);
	assert.deepEqual(r.counts.dispatch, []);
}
const capture = (f, i = 0) => {
	const stamp = createStamp(f.select(i));
	assert.ok(
		!JSON.stringify(stamp).includes(f.storeRoot),
		"stamp excludes operational store",
	);
	assert.ok(
		!JSON.stringify(stamp).includes(f.root),
		"stamp excludes absolute project root",
	);
	return stamp;
};
function materializeArgs(f, digest, destination) {
	return [
		"materialize",
		digest,
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		"--adapter",
		"filesystem-v1",
		"--output-root",
		path.dirname(destination),
		"--destination",
		destination,
		"--json",
	];
}

// Finite literal output table, not traversal of the materializer's plan/reconstruction.
function golden(f, stamp, index = 0) {
	const pkg = f.packages[index],
		content = [],
		mappings = [],
		planFiles = [];
	const row = (outputPath, backing, binding, bytes) => {
		content.push({ path: outputPath.slice(8), bytes });
		planFiles.push({ path: outputPath, backing });
		mappings.push({
			binding,
			sourceKind: backing.type,
			sourceDigest: backing.sha256,
			packageDigest: backing.type === "package" ? backing.sha256 : null,
			sourcePath: backing.type === "snapshot" ? "snapshot.json" : backing.path,
			outputPath,
			hostName: null,
		});
	};
	const blob = (output, source, binding, bytes) =>
		row(
			`content/${output}`,
			{ type: "blob", path: source, sha256: sha(bytes), bytes: bytes.length },
			binding,
			bytes,
		);
	row(
		"content/snapshot.json",
		{ type: "snapshot", sha256: stamp.digest },
		null,
		Buffer.from(canonical(stamp.snapshot)),
	);
	blob(
		"instructions/0000.md",
		".agent-profiles/profiles/base.md",
		"profiles.base",
		PROFILE,
	);
	blob(
		"instructions/0001.md",
		".agent-profiles/roles/reviewer.md",
		"roles.reviewer",
		ROLE,
	);
	row(
		"content/instructions/0002.md",
		{ type: "package", sha256: pkg.digest, path: "SKILL.md" },
		"skills.security-review",
		pkg.members.find((m) => m.path === "SKILL.md").bytes,
	);
	for (const m of pkg.members)
		row(
			`content/packages/sha256/${pkg.digest}/${m.path}`,
			{ type: "package", sha256: pkg.digest, path: m.path },
			"skills.security-review",
			m.bytes,
		);
	blob("shared/AGENTS.md", "AGENTS.md", null, SHARED);
	content.sort((a, b) => cmp(a.path, b.path));
	planFiles.sort((a, b) => cmp(a.path, b.path));
	mappings.sort((a, b) => cmp(a.outputPath, b.outputPath));
	const plan = {
		planVersion: 1,
		stampDigest: stamp.digest,
		adapter: { id: "filesystem-v1", contractVersion: 1 },
		options: {},
		files: planFiles,
		mappings,
		capabilities: caps,
	};
	const receipt = {
		receiptVersion: 1,
		stampDigest: stamp.digest,
		planDigest: recordHash(plan, "agent-profiles/materialization-plan/v1"),
		adapter: plan.adapter,
		options: {},
		outputDigest: treeHash(content, "agent-profiles/materialized-tree/v1"),
		mappings,
		capabilities: caps,
		status: "committed",
	};
	return { plan, receipt, content };
}
function exactOutput(f, stamp, destination, index = 0) {
	const g = golden(f, stamp, index);
	assert.deepEqual(
		files(destination),
		[
			...g.content.map((m) => ({ path: `content/${m.path}`, bytes: m.bytes })),
			{ path: "receipt.json", bytes: Buffer.from(canonical(g.receipt)) },
		].sort((a, b) => cmp(a.path, b.path)),
	);
	assert.deepEqual(
		materializer.verifyMaterialization({
			destination,
			expectedStampDigest: stamp.digest,
			storeRoot: f.storeRoot,
		}),
		{ verified: true, findings: [] },
	);
	return g.receipt;
}
function expectedDiff(f, before, after) {
	const rows = [],
		change = (p, a, b) =>
			rows.push({ path: p, kind: "changed", before: a, after: b });
	const add = (p, b) =>
		rows.push({ path: p, kind: "added", before: null, after: b });
	for (const p of ["/composition/2", "/required/0"]) {
		change(`${p}/backing/sha256`, f.packages[0].digest, f.packages[1].digest);
		change(`${p}/package/selectedBy`, "binding-default", "large-review");
		add(`${p}/package/selectors/model`, MODELS[1]);
		add(`${p}/package/selectors/role`, "reviewer");
		change(`${p}/package/sha256`, f.packages[0].digest, f.packages[1].digest);
		change(`${p}/package/version`, "1.0.0", "2.0.0");
	}
	change("/packages/0/sha256", f.packages[0].digest, f.packages[1].digest);
	change("/packages/0/version", "1.0.0", "2.0.0");
	change("/selection/identity/canonical", MODELS[0], MODELS[1]);
	change("/selection/identity/raw", MODELS[0], MODELS[1]);
	return {
		complete: true,
		beforeVerification: verifyStamp({
			digest: before.digest,
			storeRoot: f.storeRoot,
		}),
		afterVerification: verifyStamp({
			digest: after.digest,
			storeRoot: f.storeRoot,
		}),
		changes: rows.sort((a, b) => cmp(a.path, b.path)),
	};
}

test("P9-01 fixture qualification: real two-release routing, finite diff and raw export goldens", (t) => {
	const f = fixture(t);
	qualified(f);
	const a = capture(f),
		b = capture(f, 1);
	assert.equal(a.digest, recordHash(a.snapshot, "agent-profiles/stamp/v1"));
	assert.deepEqual(
		diffStamps({ before: a.digest, after: b.digest, storeRoot: f.storeRoot }),
		expectedDiff(f, a, b),
	);
	for (const [i, stamp] of [a, b].entries()) {
		const g = golden(f, stamp, i);
		assert.deepEqual(
			materializer.planMaterialization({
				stampDigest: stamp.digest,
				storeRoot: f.storeRoot,
				adapterId: "filesystem-v1",
				adapterContractVersion: 1,
			}),
			g.plan,
		);
		const destination = path.join(f.outputRoot, `golden-${i}`);
		assert.deepEqual(
			materializer.materialize({
				plan: g.plan,
				storeRoot: f.storeRoot,
				destination,
				outputRoot: f.outputRoot,
				deniedRoots: [f.root],
			}),
			g.receipt,
		);
		exactOutput(f, stamp, destination, i);
	}
});

for (const command of [
	"add",
	"install",
	"stamp",
	"verify",
	"diff",
	"materialize",
]) {
	test(`P9-01 public ${command}: exact JSON API record and truthful text`, (t) => {
		const f = fixture(t);
		qualified(f);
		const a = capture(f),
			b = capture(f, 1),
			pkg = f.packages[0];
		// Existing flags only: current CLI must expose unknown-command RED rather than
		// hiding every dispatch behind its earlier unknown --store/--source parser error.
		const admissionArgs = {
			add: ["add", `${NAME}@1.0.0`],
			install: ["install", "--root", f.root, "--json"],
			stamp: ["stamp", "--root", f.root, "--json"],
			verify: ["verify", a.digest, "--json"],
			diff: ["diff", a.digest, b.digest, "--json"],
			materialize: ["materialize", a.digest, "--root", f.root],
		}[command];
		const admission = child(f, admissionArgs, {
			environment: { ...f.env, AGENT_PROFILES_STORE: f.storeRoot },
			cwd: f.dir,
		});
		if (command === "add")
			refusal(
				admission,
				/source.*required|required.*source|source.*directory/i,
			);
		else if (command === "materialize")
			refusal(
				admission,
				/adapter.*required|required.*adapter|adapter.*filesystem-v1/i,
			);
		else
			assert.deepEqual(
				success(admission, `${command} default-store dispatch`),
				{
					install: { lockState: "valid", installRequired: false },
					stamp: createStamp({ root: f.root, storeRoot: f.storeRoot }),
					verify: verifyStamp({ digest: a.digest, storeRoot: f.storeRoot }),
					diff: expectedDiff(f, a, b),
				}[command],
			);
		const target = path.join(f.outputRoot, "dispatch");
		const args = {
			add: [
				"add",
				`${NAME}@1.0.0`,
				"--source",
				pkg.source,
				"--store",
				f.storeRoot,
			],
			install: [
				"install",
				"--root",
				f.root,
				"--store",
				f.storeRoot,
				"--offline",
				"--frozen-lockfile",
			],
			stamp: ["stamp", ...f.args()],
			verify: ["verify", a.digest, "--store", f.storeRoot],
			diff: ["diff", a.digest, b.digest, "--store", f.storeRoot],
			materialize: materializeArgs(f, a.digest, target).slice(0, -1),
		}[command];
		const expected = {
			add: {
				identity: { name: NAME, version: "1.0.0" },
				sha256: pkg.digest,
				status: "reused",
			},
			install: { lockState: "valid", installRequired: false },
			stamp: a,
			verify: verifyStamp({ digest: a.digest, storeRoot: f.storeRoot }),
			diff: expectedDiff(f, a, b),
			materialize: golden(f, a).receipt,
		}[command];
		const result = success(
			child(f, [...args, "--json"], { cwd: f.dir }),
			`${command} JSON`,
		);
		assert.deepEqual(result, expected);
		if (command === "materialize") exactOutput(f, a, target);
		const textArgs =
			command === "materialize"
				? materializeArgs(f, a.digest, path.join(f.outputRoot, "text")).slice(
						0,
						-1,
					)
				: args;
		const text = child(f, textArgs, { cwd: f.dir });
		assert.equal(text.status, 0, text.stderr);
		assert.deepEqual(text.counts.dispatch, []);
		assert.ok(text.stdout.trim());
		if (["add", "stamp", "verify", "diff", "materialize"].includes(command))
			assert.ok(
				text.stdout.includes(command === "add" ? pkg.digest : a.digest),
				"full digest in text",
			);
		if (command === "add") assert.ok(text.stdout.includes(`${NAME}@1.0.0`));
		if (["verify", "materialize"].includes(command))
			assert.match(text.stdout, /unverified|unsupported/i);
	});
}

test("P9-02 parser isolation: bounded paired command grammar and no mutation", (t) => {
	const f = fixture(t);
	qualified(f);
	const a = capture(f);
	const valid = [
		[
			"add",
			`${NAME}@1.0.0`,
			"--source",
			f.packages[0].source,
			"--store",
			f.storeRoot,
		],
		["install", "--root", f.root, "--store", f.storeRoot, "--offline"],
		["stamp", ...f.args()],
		["verify", a.digest, "--store", f.storeRoot],
		["diff", a.digest, a.digest, "--store", f.storeRoot],
		materializeArgs(f, a.digest, path.join(f.outputRoot, "valid")).slice(0, -1),
	];
	for (const args of valid) {
		success(child(f, [...args, "--json"]), `${args[0]} paired syntax control`);
		for (const [suffix, diagnostic] of [
			[["extra"], /position|argument|usage|exactly|accepts/i],
			[["--unknown-p9"], /unknown.*unknown-p9/i],
			[
				[args[0] === "add" ? "--frozen-lockfile" : "--package", "inert"],
				/only|supported|option|usage/i,
			],
		]) {
			const before = [
				fingerprint(f.root),
				fingerprint(f.storeRoot),
				fingerprint(f.outputRoot),
			];
			const r = child(f, [...args, ...suffix, "--json"]);
			assert.equal(r.status, 1);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /^Agent Profiles: /);
			assert.match(r.stderr, diagnostic);
			assert.deepEqual(r.counts.dispatch, []);
			assert.deepEqual(
				[
					fingerprint(f.root),
					fingerprint(f.storeRoot),
					fingerprint(f.outputRoot),
				],
				before,
			);
		}
	}
	const bad = [
		[
			[
				"add",
				"example/security-review@1.0.0",
				"--source",
				f.packages[0].source,
			],
			/identity|namespace|package|spec/i,
		],
		[["add", `${NAME}@1.0.0`, "--source"], /source|argument/i],
		[
			[
				"add",
				`${NAME}@1.0.0`,
				"--source",
				f.packages[0].source,
				"--source",
				f.packages[1].source,
			],
			/source.*one|source.*repeat|source.*once|duplicate/i,
		],
		[
			["install", "--source", NAME, "1.0.0"],
			/source.*three|source.*directory|source.*operand|source.*triple/i,
		],
		[
			["install", "--offline", "--offline"],
			/offline.*repeat|offline.*once|duplicate/i,
		],
		[
			["stamp", "--role", "reviewer", "--role", "reviewer"],
			/one.*role|role.*one|role.*repeat/i,
		],
		...["a".repeat(63), "A".repeat(64), "g".repeat(64)].map((d) => [
			["verify", d],
			/digest.*64|digest.*lowercase|64.*hex/i,
		]),
		[["diff", a.digest], /two|before.*after|usage/i],
		[
			[
				"materialize",
				a.digest,
				"--adapter",
				"filesystem-v1",
				"--output-root",
				f.outputRoot,
			],
			/destination/i,
		],
	];
	for (const [args, diagnostic] of bad) {
		const before = [
			fingerprint(f.root),
			fingerprint(f.storeRoot),
			fingerprint(f.outputRoot),
		];
		refusal(
			child(f, [...args, "--root", f.root, "--store", f.storeRoot, "--json"]),
			diagnostic,
		);
		assert.deepEqual(
			[
				fingerprint(f.root),
				fingerprint(f.storeRoot),
				fingerprint(f.outputRoot),
			],
			before,
		);
	}
});

test("P9-03 add: publication, identical reuse, support conflict, identity mismatch and local-only source", (t) => {
	const f = fixture(t, { seeded: false });
	const pkg = f.packages[0];
	const args = [
		"add",
		`${NAME}@1.0.0`,
		"--source",
		path.relative(f.dir, pkg.source),
		"--store",
		f.storeRoot,
		"--json",
	];
	assert.deepEqual(success(child(f, args, { cwd: f.dir }), "first import"), {
		identity: { name: NAME, version: "1.0.0" },
		sha256: pkg.digest,
		status: "published",
	});
	assert.deepEqual(success(child(f, args, { cwd: f.dir }), "reuse"), {
		identity: { name: NAME, version: "1.0.0" },
		sha256: pkg.digest,
		status: "reused",
	});
	const before = fingerprint(f.storeRoot),
		project = fingerprint(f.root);
	put(path.join(pkg.source, "support/note.txt"), "Changed support bytes\r\n");
	refusal(child(f, args, { cwd: f.dir }), /identity-conflict/);
	assert.deepEqual(fingerprint(f.storeRoot), before);
	assert.deepEqual(
		lookupPackage({ storeRoot: f.storeRoot, name: NAME, version: "1.0.0" })
			.files,
		pkg.members,
	);
	for (const [spec, source, diagnostic] of [
		[
			`${NAME}@9.0.0`,
			pkg.source,
			/identity|version.*mismatch|mismatch.*version/i,
		],
		[
			`${NAME}@1.0.0`,
			"https://invalid.example/pkg",
			/local|nonlocal|remote|source/i,
		],
	]) {
		const untouchedStore = path.join(f.dir, `refusal-store-${child.id}`);
		fs.mkdirSync(untouchedStore);
		const untouched = fingerprint(untouchedStore);
		refusal(
			child(f, [
				"add",
				spec,
				"--source",
				source,
				"--store",
				untouchedStore,
				"--json",
			]),
			diagnostic,
		);
		assert.deepEqual(
			fingerprint(untouchedStore),
			untouched,
			"basic refusal creates no operational scaffolding",
		);
		assert.deepEqual(fingerprint(f.storeRoot), before);
	}
	assert.deepEqual(fingerprint(f.root), project, "add never edits config");
});

test("P9-03 add binds inspected manifest and full-tree digest across native source drift", (t) => {
	const f = fixture(t, { seeded: false }),
		pkg = f.packages[0];
	const file = path.join(pkg.source, "package.yaml");
	const replacement = fs.readFileSync(file, "utf8").replace("1.0.0", "9.0.0");
	const result = child(
		f,
		[
			"add",
			`${NAME}@1.0.0`,
			"--source",
			pkg.source,
			"--store",
			f.storeRoot,
			"--json",
		],
		{ drift: { file, bytes: Buffer.from(replacement).toString("base64") } },
	);
	refusal(result, /expected digest|source.*changed|identity.*mismatch/i);
	assert.equal(result.counts.drift, 1);
	assert.equal(
		lookupPackage({ storeRoot: f.storeRoot, name: NAME, version: "1.0.0" }),
		null,
	);
	assert.equal(
		lookupPackage({ storeRoot: f.storeRoot, name: NAME, version: "9.0.0" }),
		null,
	);
	assert.deepEqual(
		files(path.join(f.storeRoot, "objects/sha256")),
		[],
		"no object publication",
	);
});

test("P9-04 install: all pins, fresh frozen offline triples relative to selected root, immutable lock", (t) => {
	const f = fixture(t);
	qualified(f);
	f.config.skills.idle = { package: NAME, version: "2.0.0" };
	f.config.roles.reviewer.skills.available = ["idle"];
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	assert.deepEqual(
		resolveInstructions(f.select()).available.map((s) => s.id),
		["idle"],
	);
	const lock = fs.readFileSync(path.join(f.root, LOCK)),
		parsed = JSON.parse(lock);
	assert.deepEqual(
		parsed.packages.map((p) => [p.name, p.version, p.sha256]),
		f.packages.map((p) => [NAME, p.version, p.digest]),
	);
	assert.deepEqual(
		parsed.pins.map((p) => [p.binding, p.rule, p.version]),
		[
			["skills.idle", null, "2.0.0"],
			["skills.security-review", null, "1.0.0"],
			["skills.security-review", "large-review", "2.0.0"],
		],
		"available declaration, base and unselected override all locked",
	);
	const fresh = path.join(f.dir, "fresh store");
	fs.mkdirSync(fresh);
	for (const p of f.packages)
		fs.cpSync(p.source, path.join(f.root, "offline-sources", p.version), {
			recursive: true,
		});
	const triples = f.packages.flatMap((p) => [
		"--source",
		NAME,
		p.version,
		`offline-sources/${p.version}`,
	]);
	const before = fingerprint(f.root);
	const args = [
		"install",
		"--root",
		f.root,
		"--store",
		fresh,
		"--frozen-lockfile",
		"--offline",
		...triples,
		"--json",
	];
	assert.deepEqual(
		success(child(f, args, { cwd: f.dir }), "fresh offline install"),
		{ lockState: "valid", installRequired: false },
	);
	for (const p of f.packages)
		assert.deepEqual(
			lookupPackage({ storeRoot: fresh, name: NAME, version: p.version }).files,
			p.members,
		);
	assert.deepEqual(success(child(f, args), "frozen reuse"), {
		lockState: "valid",
		installRequired: false,
	});
	assert.deepEqual(fs.readFileSync(path.join(f.root, LOCK)), lock);
	assert.deepEqual(fingerprint(f.root), before);
});

test("P9-04 install refusal pairs: stale/coverage/backing/source validation even with cached identities", (t) => {
	const f = fixture(t);
	qualified(f);
	const lockFile = path.join(f.root, LOCK),
		original = fs.readFileSync(lockFile);
	const base = [
		"install",
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		"--frozen-lockfile",
		"--offline",
	];
	success(child(f, [...base, "--json"]), "valid locked control");
	const cases = [
		[
			"missing pin",
			(data) => {
				data.pins.pop();
			},
			/lock-coverage: missing or extra pins\/packages/,
		],
		[
			"extra pin",
			(data) => {
				data.pins.unshift({ ...data.pins[0], binding: "skills.foreign" });
			},
			/lock-coverage: missing or extra pins\/packages/,
		],
	];
	for (const [label, mutate, diagnostic] of cases) {
		const data = JSON.parse(original);
		mutate(data);
		put(lockFile, canonical(data));
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
		refusal(child(f, [...base, "--json"]), diagnostic);
		assert.deepEqual(
			[fingerprint(f.root), fingerprint(f.storeRoot)],
			before,
			label,
		);
		put(lockFile, original);
	}
	f.config.roles.reviewer.description = "stale change";
	f.save();
	const stale = [fingerprint(f.root), fingerprint(f.storeRoot)];
	refusal(child(f, [...base, "--json"]), /stale-lock/);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], stale);
	delete f.config.roles.reviewer.description;
	f.save();
	const p = f.packages[0];
	for (const [triples, diagnostic] of [
		[
			[
				"--source",
				NAME,
				p.version,
				p.source,
				"--source",
				NAME,
				p.version,
				p.source,
			],
			/duplicate.*identity|sources.*duplicate/i,
		],
		[
			["--source", "@example/foreign", p.version, p.source],
			/foreign|undeclared/i,
		],
		[
			["--source", NAME, p.version, "https://invalid.example/pkg"],
			/nonlocal|local|remote/i,
		],
		[
			["--source", NAME, p.version, "sources/../sources"],
			/sources.directory: unsafe traversal/,
		],
		[
			["--source", NAME, p.version, f.packages[1].source],
			/mismatched-package.*identity/i,
		],
	]) {
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
		refusal(child(f, [...base, ...triples, "--json"]), diagnostic);
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	}
	put(path.join(p.source, "assets/data.bin"), Buffer.from([0, 1, 2]));
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	refusal(
		child(f, [...base, "--source", NAME, p.version, p.source, "--json"]),
		/identity-conflict|mismatched-package/,
	);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	const empty = path.join(f.dir, "empty store");
	fs.mkdirSync(empty);
	for (const p of f.packages) fs.rmSync(p.source, { recursive: true });
	const missingBefore = [fingerprint(f.root), fingerprint(empty)];
	refusal(
		child(f, [
			"install",
			"--root",
			f.root,
			"--store",
			empty,
			"--frozen-lockfile",
			"--json",
		]),
		/missing-package/,
	);
	assert.deepEqual(
		[fingerprint(f.root), fingerprint(empty)],
		missingBefore,
		"no implicit download without offline",
	);
});

test("P9-04 fixture qualification: available pins, safe relative triples and exact lock-coverage sabotage", (t) => {
	const f = fixture(t);
	qualified(f);
	f.config.skills.idle = { package: NAME, version: "2.0.0" };
	f.config.roles.reviewer.skills.available = ["idle"];
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const lockFile = path.join(f.root, LOCK),
		original = fs.readFileSync(lockFile),
		fresh = path.join(f.dir, "fresh");
	fs.mkdirSync(fresh);
	for (const p of f.packages)
		fs.cpSync(p.source, path.join(f.root, "offline-sources", p.version), {
			recursive: true,
		});
	installDependencies({
		root: f.root,
		storeRoot: fresh,
		frozen: true,
		offline: true,
		sources: f.packages.map((p) => ({
			name: NAME,
			version: p.version,
			directory: `offline-sources/${p.version}`,
		})),
	});
	assert.deepEqual(fs.readFileSync(lockFile), original);
	assert.equal(
		resolveInstructions({ ...f.select(), storeRoot: fresh }).available[0]
			.package.sha256,
		f.packages[1].digest,
	);
	for (const extra of [false, true]) {
		const lock = JSON.parse(original);
		if (extra)
			lock.pins.unshift({ ...lock.pins[0], binding: "skills.foreign" });
		else lock.pins.pop();
		put(lockFile, canonical(lock));
		const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
		assert.throws(
			() =>
				installDependencies({
					root: f.root,
					storeRoot: f.storeRoot,
					frozen: true,
				}),
			/lock-coverage: missing or extra pins\/packages/,
		);
		assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
	}
});

test("P9-05 P4B07 real API install forwards A through preflight, apply doctor and returned doctor", (t) => {
	const f = fixture(t);
	qualified(f);
	const old = process.env.AGENT_PROFILES_STORE;
	process.env.AGENT_PROFILES_STORE = f.ambient;
	t.after(() => {
		if (old === undefined) delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = old;
	});
	assert.throws(
		() => install({ root: f.root, agents: ["codex"] }),
		/mismatched-package/,
	);
	const preserved = [
		fs.readFileSync(path.join(f.root, CONFIG)),
		fs.readFileSync(path.join(f.root, LOCK)),
		fingerprint(f.storeRoot),
		fingerprint(f.ambient),
	];
	const result = install({
		root: f.root,
		agents: ["codex"],
		storeRoot: f.storeRoot,
	});
	assert.deepEqual(result.errors, []);
	assert.equal(result.profile, "base");
	assert.equal(result.role, "reviewer");
	assert.ok(result.modified.includes(".agent-profiles/BOOTSTRAP.md"));
	assert.equal(
		result.availability.runnable,
		false,
		"bootstrap availability is independent",
	);
	assert.deepEqual(doctor(f.root, { storeRoot: f.storeRoot }).errors, []);
	const after = fingerprint(f.root);
	assert.deepEqual(
		install({ root: f.root, agents: ["codex"], storeRoot: f.storeRoot })
			.modified,
		[],
	);
	assert.deepEqual(fingerprint(f.root), after);
	assert.deepEqual(
		[
			fs.readFileSync(path.join(f.root, CONFIG)),
			fs.readFileSync(path.join(f.root, LOCK)),
			fingerprint(f.storeRoot),
			fingerprint(f.ambient),
		],
		preserved,
	);
	qualified(f);
});

for (const command of [
	"resolve",
	"proof",
	"configure",
	"preset",
	"skills",
	"doctor",
	"visualize",
	"init",
]) {
	test(`P9-05 CLI --store reaches ${command} caller (explicit A, misleading B)`, (t) => {
		const f = fixture(t);
		qualified(f);
		const before = [
			fingerprint(f.storeRoot),
			fingerprint(f.ambient),
			fs.readFileSync(path.join(f.root, CONFIG)),
			fs.readFileSync(path.join(f.root, LOCK)),
		];
		let args = [command, "--root", f.root, "--store", f.storeRoot];
		if (["resolve", "proof", "skills"].includes(command)) args.push("--json");
		if (command === "init") args.push("--agent", "codex");
		if (command === "preset")
			args = [
				"preset",
				"inspect",
				path.join(f.dir, "preset"),
				"--root",
				f.root,
				"--store",
				f.storeRoot,
			];
		if (command === "preset")
			fs.cpSync(
				path.join(REPO, "examples/presets/release-review"),
				path.join(f.dir, "preset"),
				{ recursive: true },
			);
		const r = child(f, args);
		assert.deepEqual(r.counts.dispatch, []);
		assert.doesNotMatch(
			r.stderr,
			/Unknown option|mismatched-package|missing-package/,
		);
		if (["resolve", "proof"].includes(command))
			assert.deepEqual(
				success(r, command),
				plain(
					resolutionOutput(
						resolveInstructions({ root: f.root, storeRoot: f.storeRoot }),
					),
				),
			);
		else if (command === "skills") {
			const found = success(r, command).skills.find(
				(s) => s.id === "security-review",
			);
			assert.equal(found.verification, "not-checked");
			assert.equal(found.availability, "declared");
			assert.equal(found.path, null);
			assert.deepEqual(found.package, {
				binding: "skills.security-review",
				name: NAME,
				version: "1.0.0",
			});
			const text = child(
				f,
				args.filter((a) => a !== "--json"),
			);
			assert.equal(text.status, 0, text.stderr);
			assert.match(text.stdout, /@example\/security-review@1\.0\.0/);
			assert.match(text.stdout, /declared|not-checked/);
			assert.doesNotMatch(text.stdout, /undefined|host-provided\)/);
		} else if (command === "configure") {
			assert.equal(r.status, 1);
			assert.match(r.stderr, /Interactive input is unavailable/);
		} else if (command === "visualize") {
			assert.equal(r.status, 1);
			assert.match(r.stderr, /owned-listen-stop/);
			assert.equal(r.counts.listen, 1);
		} else if (command === "preset") {
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /No changes have been made/);
		} else if (command === "doctor") {
			assert.equal(r.status, 1);
			assert.match(r.stdout, /Configuration:/);
			assert.doesNotMatch(r.stderr, /mismatched-package|missing-package/);
		} else {
			assert.equal(
				r.status,
				1,
				"init reports unavailable executable separately",
			);
			assert.match(r.stdout, /Default profile: base; default role: reviewer/);
			assert.match(r.stderr, /Bootstrap:/);
			assert.doesNotMatch(
				r.stderr,
				/Configuration|mismatched-package|missing-package/,
			);
			assert.deepEqual(
				doctor(f.root, { storeRoot: f.storeRoot }).errors,
				[],
				"real CLI post-init doctor used explicit store",
			);
			const again = child(f, args);
			assert.match(again.stdout, /Already installed/);
		}
		assert.deepEqual(
			[
				fingerprint(f.storeRoot),
				fingerprint(f.ambient),
				fs.readFileSync(path.join(f.root, CONFIG)),
				fs.readFileSync(path.join(f.root, LOCK)),
			],
			before,
		);
	});
}

test("P9-05 init --package safely counts native executable dispatch; dependency install never dispatches npm", (t) => {
	const f = fixture(t);
	// Local-only supported v2 isolates executable-install dispatch from P4B07.
	f.config.skills = {};
	f.config.assignments = {};
	f.config.roles.reviewer.skills.required = [];
	f.save();
	const r = child(
		f,
		[
			"init",
			"--root",
			f.root,
			"--agent",
			"codex",
			"--package",
			"agent-profiles@0.0.0-owned-counter",
		],
		{ allowExecutableCounter: true },
	);
	assert.equal(
		r.status,
		1,
		"no real executable is installed; bootstrap remains unavailable",
	);
	assert.equal(r.counts.dispatch.length, 1);
	assert.equal(r.counts.dispatch[0].name, "spawnSync");
	assert.deepEqual(r.counts.dispatch[0].argv.slice(1), [
		"install",
		"--save-dev",
		"--no-audit",
		"--no-fund",
		"agent-profiles@0.0.0-owned-counter",
	]);
	assert.match(r.stderr, /Bootstrap:/);
	const g = fixture(t);
	qualified(g);
	success(
		child(g, [
			"install",
			"--root",
			g.root,
			"--store",
			g.storeRoot,
			"--offline",
			"--json",
		]),
		"dependency install",
	);
	refusal(
		child(g, [
			"install",
			"--root",
			g.root,
			"--store",
			g.storeRoot,
			"--package",
			"inert",
			"--json",
		]),
		/package.*only|only.*init/i,
	);
});

// Same bounded literal decoding as package-caller-review-regressions.test.js: no shell evaluation.
function commandArgs(section, shell) {
	const command = section.match(
		new RegExp(`Command \\(${shell}\\): \`([\\s\\S]*?)\`(?:\\n|$)`),
	)?.[1];
	assert.ok(command, `${shell} command exists`);
	const prefix = "npx --no agent-profiles resolve";
	assert.ok(command.startsWith(prefix));
	const tail = command.slice(prefix.length),
		args = [];
	const pair =
		shell === "Bash"
			? / (--[\w-]+) ('[^']*'(?:"'"'[^']*')*)/gy
			: / (--[\w-]+) ('(?:[^']|'')*')/gy;
	let offset = 0;
	while (offset < tail.length) {
		pair.lastIndex = offset;
		const match = pair.exec(tail);
		assert.ok(match, "literal flag/value pair");
		args.push(
			match[1],
			match[2]
				.slice(1, -1)
				.replaceAll(shell === "Bash" ? "'\"'\"'" : "''", "'"),
		);
		offset = pair.lastIndex;
	}
	return args;
}
test("P9-06 real generated load/rerun replay retains ordered first and second requests plus operational context", (t) => {
	const f = fixture(t);
	for (const id of ["first", "second"])
		f.config.skills[id] = { package: NAME, version: "1.0.0" };
	f.config.roles.reviewer.skills.available = ["first", "second"];
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const selectors = [...f.args(), "--family", "fictional", "--skill", "first"];
	const first = resolveInstructions({
		...f.select(),
		family: "fictional",
		skills: ["first"],
	});
	assert.ok(
		!formatContext(first).includes(f.storeRoot),
		"frozen default formatter remains store-free",
	);
	const direct = formatContext(first, { root: f.root, storeRoot: f.storeRoot });
	const real = child(f, ["resolve", ...selectors]);
	assert.equal(real.status, 0, real.stderr);
	assert.equal(real.stdout.trimEnd(), direct);
	for (const shell of ["Bash", "PowerShell"]) {
		for (const [section, expected] of [
			[
				real.stdout.split("- second")[1].split("## Run again")[0],
				["first", "second"],
			],
			[real.stdout.split("## Run again\n")[1], ["first"]],
		]) {
			const args = commandArgs(section, shell);
			for (const [flag, value] of [
				["--root", f.root],
				["--store", f.storeRoot],
				["--host", "codex"],
				["--identity-source", "user"],
				["--model", MODELS[0]],
				["--family", "fictional"],
				["--role", "reviewer"],
			])
				assert.equal(args[args.indexOf(flag) + 1], value, flag);
			const replay = success(
				child(f, ["resolve", ...args, "--json", "--contents"]),
				"literal replay",
			);
			assert.deepEqual(
				replay.loaded
					.filter((e) => e.kind === "requested-skill")
					.map((e) => e.id),
				expected,
			);
			for (const e of replay.loaded.filter((e) => e.kind.endsWith("-skill"))) {
				assert.equal(e.package.sha256, f.packages[0].digest);
				assert.equal(
					e.content,
					f.packages[0].members
						.find((m) => m.path === "SKILL.md")
						.bytes.toString("utf8"),
				);
			}
		}
	}
});

test("P9-07 store-only verify/equal diff/changed diff and missing backing retain complete independent states", (t) => {
	const f = fixture(t);
	qualified(f);
	const a = capture(f),
		b = capture(f, 1);
	const store = ["--store", f.storeRoot, "--json"];
	assert.deepEqual(
		success(
			child(f, ["verify", a.digest, ...store], { cwd: f.dir }),
			"store-only verification",
		),
		verifyStamp({ digest: a.digest, storeRoot: f.storeRoot }),
	);
	assert.deepEqual(
		success(
			child(f, ["diff", a.digest, a.digest, ...store], { cwd: f.dir }),
			"equal diff",
		).changes,
		[],
	);
	assert.deepEqual(
		success(
			child(f, ["diff", a.digest, b.digest, ...store], { cwd: f.dir }),
			"changed diff",
		),
		expectedDiff(f, a, b),
	);
	const backing = path.join(
		f.storeRoot,
		"objects/sha256",
		f.packages[0].digest,
		"tree/assets/data.bin",
	);
	fs.rmSync(backing);
	const before = fingerprint(f.storeRoot),
		report = verifyStamp({ digest: a.digest, storeRoot: f.storeRoot });
	assert.equal(report.snapshotIntegrity, "verified");
	assert.equal(report.managedReproducible, false);
	assert.match(
		report.findings.join("\n"),
		/assets\/data.bin|tree|digest|missing|ENOENT/i,
	);
	const verify = child(f, ["verify", a.digest, ...store], { cwd: f.dir });
	assert.equal(verify.status, 1);
	assert.equal(verify.stderr, "");
	assert.deepEqual(JSON.parse(verify.stdout), report);
	const diff = child(f, ["diff", a.digest, b.digest, ...store], { cwd: f.dir });
	assert.equal(diff.status, 1);
	assert.equal(diff.stderr, "");
	assert.deepEqual(JSON.parse(diff.stdout), {
		complete: false,
		beforeVerification: report,
		afterVerification: verifyStamp({
			digest: b.digest,
			storeRoot: f.storeRoot,
		}),
		changes: [],
	});
	const destination = path.join(f.outputRoot, "missing");
	refusal(
		child(f, materializeArgs(f, a.digest, destination)),
		/backing-missing/,
	);
	assert.equal(fs.existsSync(destination), false);
	assert.deepEqual(fingerprint(f.storeRoot), before);
});

test("P9-07 fixture qualification: missing and corrupt backing fail managed verification without rewriting bytes", (t) => {
	for (const corruption of ["missing", "changed"]) {
		const f = fixture(t),
			a = capture(f),
			b = capture(f, 1);
		const backing = path.join(
			f.storeRoot,
			"objects/sha256",
			f.packages[0].digest,
			"tree/assets/data.bin",
		);
		assert.equal(
			verifyStamp({ digest: a.digest, storeRoot: f.storeRoot })
				.managedReproducible,
			true,
		);
		if (corruption === "missing") fs.rmSync(backing);
		else put(backing, Buffer.from([0, 1, 2]));
		const before = fingerprint(f.storeRoot),
			report = verifyStamp({ digest: a.digest, storeRoot: f.storeRoot });
		assert.equal(report.snapshotIntegrity, "verified");
		assert.equal(report.managedReproducible, false);
		assert.equal(report.managedContent, "mismatched");
		assert.deepEqual(report.findings, [
			`object: digest mismatch ${f.packages[0].digest}`,
		]);
		assert.deepEqual(
			diffStamps({ before: a.digest, after: b.digest, storeRoot: f.storeRoot }),
			{
				complete: false,
				beforeVerification: report,
				afterVerification: verifyStamp({
					digest: b.digest,
					storeRoot: f.storeRoot,
				}),
				changes: [],
			},
		);
		assert.throws(
			() =>
				materializer.planMaterialization({
					stampDigest: a.digest,
					storeRoot: f.storeRoot,
					adapterId: "filesystem-v1",
					adapterContractVersion: 1,
				}),
			/backing-missing/,
		);
		assert.deepEqual(fingerprint(f.storeRoot), before);
	}
});

test("P9-07 CLI corrupted backing reports mismatched managed content and incomplete same-digest diff", (t) => {
	const f = fixture(t),
		a = capture(f);
	success(
		child(f, ["verify", a.digest, "--store", f.storeRoot, "--json"]),
		"valid paired backing",
	);
	put(
		path.join(
			f.storeRoot,
			"objects/sha256",
			f.packages[0].digest,
			"tree/assets/data.bin",
		),
		Buffer.from([0, 1, 2]),
	);
	const before = fingerprint(f.storeRoot),
		report = verifyStamp({ digest: a.digest, storeRoot: f.storeRoot });
	assert.equal(report.snapshotIntegrity, "verified");
	assert.equal(report.managedContent, "mismatched");
	assert.equal(report.managedReproducible, false);
	const r = child(f, ["verify", a.digest, "--store", f.storeRoot, "--json"]);
	assert.equal(r.status, 1);
	assert.equal(r.stderr, "");
	assert.deepEqual(JSON.parse(r.stdout), report);
	const diff = child(f, [
		"diff",
		a.digest,
		a.digest,
		"--store",
		f.storeRoot,
		"--json",
	]);
	assert.equal(diff.status, 1);
	assert.equal(diff.stderr, "");
	assert.deepEqual(JSON.parse(diff.stdout), {
		complete: false,
		beforeVerification: report,
		afterVerification: report,
		changes: [],
	});
	assert.deepEqual(fingerprint(f.storeRoot), before);
});

test("P9-08 materializeStamp public boundary-first API export exists", () => {
	assert.equal(
		typeof materializer.materializeStamp,
		"function",
		"missing accepted materializeStamp digest-to-export seam",
	);
});
test("P9-08 new API boundary-first body: missing stamp cannot mask forbidden destination", {
	skip:
		typeof materializer.materializeStamp === "function"
			? false
			: "materializeStamp export absent: only new API body unexecuted",
}, (t) => {
	const f = fixture(t);
	const stamp = capture(f),
		destination = path.join(f.outputRoot, "safe");
	const args = {
		stampDigest: stamp.digest,
		storeRoot: f.storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
		options: {},
		destination,
		outputRoot: f.outputRoot,
		deniedRoots: [f.root],
	};
	assert.deepEqual(
		materializer.materializeStamp(args),
		golden(f, stamp).receipt,
	);
	exactOutput(f, stamp, destination);
	for (const [patch, diagnostic] of [
		[{ adapterId: "unknown" }, /adapter|unsupported/],
		[{ options: null }, /options/],
		[{ deniedRoots: [] }, /boundary-context-required/],
		[{ unexpected: true }, /unexpected|unknown/],
	]) {
		const before = [
			fingerprint(f.root),
			fingerprint(f.storeRoot),
			fingerprint(f.outputRoot),
		];
		assert.throws(
			() =>
				materializer.materializeStamp({
					...args,
					destination: path.join(f.outputRoot, "invalid"),
					...patch,
				}),
			diagnostic,
		);
		assert.deepEqual(
			[
				fingerprint(f.root),
				fingerprint(f.storeRoot),
				fingerprint(f.outputRoot),
			],
			before,
		);
	}
	assert.throws(
		() =>
			materializer.materializeStamp({
				...args,
				stampDigest: "0".repeat(64),
				destination: path.join(f.root, "denied"),
				outputRoot: f.root,
			}),
		/protected overlap/,
	);
});

test("P9-08 CLI boundary refusals precede backing lookup and preserve known project/source/store/extra roots", (t) => {
	const f = fixture(t);
	qualified(f);
	const stamp = capture(f);
	const safe = path.join(f.outputRoot, "safe");
	assert.deepEqual(
		success(child(f, materializeArgs(f, stamp.digest, safe)), "safe export"),
		golden(f, stamp).receipt,
	);
	exactOutput(f, stamp, safe);
	const extra = path.join(f.dir, "extra protected");
	fs.mkdirSync(extra);
	const hostRoot = path.join(f.root, ".claude");
	fs.mkdirSync(hostRoot);
	const knownSource = path.join(f.root, "known-source");
	fs.cpSync(f.packages[0].source, knownSource, { recursive: true });
	installDependencies({
		root: f.root,
		storeRoot: f.storeRoot,
		sources: [{ name: NAME, version: "1.0.0", directory: "known-source" }],
	});
	const existingFile = path.join(f.outputRoot, "file");
	put(existingFile, Buffer.from([0, 255]));
	for (const [output, destination, diagnostic, guards] of [
		[f.outputRoot, safe, /destination-exists/, []],
		[f.outputRoot, existingFile, /destination-exists/, []],
		[f.outputRoot, path.join(f.dir, "escape"), /direct child/, []],
		[f.root, path.join(f.root, "denied"), /protected overlap/, []],
		[f.storeRoot, path.join(f.storeRoot, "denied"), /protected overlap/, []],
		[hostRoot, path.join(hostRoot, "denied"), /protected overlap/, []],
		[knownSource, path.join(knownSource, "denied"), /protected overlap/, []],
		[
			extra,
			path.join(extra, "denied"),
			/protected overlap/,
			["--protect-root", extra],
		],
	]) {
		const before = [
			fingerprint(f.root),
			fingerprint(f.storeRoot),
			fingerprint(f.outputRoot),
			fingerprint(extra),
		];
		const args = materializeArgs(f, "0".repeat(64), destination);
		args[args.indexOf("--output-root") + 1] = output;
		const r = child(f, [...args, ...guards]);
		refusal(r, diagnostic);
		assert.equal(
			r.counts.backingReads,
			0,
			"boundary before missing stamp read",
		);
		assert.deepEqual(
			[
				fingerprint(f.root),
				fingerprint(f.storeRoot),
				fingerprint(f.outputRoot),
				fingerprint(extra),
			],
			before,
		);
	}
});

async function start(f, request) {
	const audit = path.join(f.dir, `audit-async-${child.id++}.json`);
	const q = {
		op: "cli",
		ownedRoot: f.dir,
		cwd: f.root,
		storeRoot: f.storeRoot,
		audit,
		...request,
	};
	const processChild = spawn(process.execPath, [WORKER, JSON.stringify(q)], {
		cwd: f.dir,
		env: f.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "",
		stderr = "",
		spawnError;
	processChild.stdout.on("data", (b) => {
		stdout += b;
	});
	processChild.stderr.on("data", (b) => {
		stderr += b;
	});
	processChild.on("error", (e) => {
		spawnError = e;
	});
	let closed = false;
	const done = new Promise((resolve) =>
		processChild.on("close", (status, signal) => {
			closed = true;
			resolve({ status, signal, stdout, stderr });
		}),
	);
	return {
		process: processChild,
		done,
		audit,
		get closed() {
			return closed;
		},
		get error() {
			return spawnError;
		},
	};
}
test("export barrier waits for the complete marker, not an empty created file", async (t) => {
	const f = fixture(t);
	const marker = path.join(f.dir, "incomplete-marker");
	const descriptor = fs.openSync(marker, "w");
	try {
		let reached = false;
		const waiting = atBarrier([{ closed: false }], [marker]).then(() => {
			reached = true;
		});
		await Promise.resolve();
		assert.equal(
			reached,
			false,
			"creation is not the completed barrier signal",
		);
		fs.writeSync(descriptor, "before-final-rename");
		await waiting;
		assert.equal(reached, true);
	} finally {
		fs.closeSync(descriptor);
	}
});

async function atBarrier(children, markers) {
	for (let i = 0; i < 500; i++) {
		for (const child of children) assert.ifError(child.error);
		// Creation is visible before the worker finishes writing its phase signal.
		if (
			markers.every(
				(p) =>
					fs.existsSync(p) &&
					fs.readFileSync(p, "utf8") === "before-final-rename",
			)
		)
			return;
		assert.ok(
			children.every((c) => !c.closed),
			"child exited before before-final-rename barrier",
		);
		await delay(10);
	}
	assert.fail("owned before-final-rename barrier not reached");
}
async function concurrent(f, stamps) {
	const releaseFile = path.join(f.dir, "release"),
		markers = stamps.map((_, i) => path.join(f.dir, `marker-${i}`));
	const destinations = stamps.map((_, i) =>
		path.join(f.outputRoot, `concurrent-${i}`),
	);
	const children = [];
	try {
		for (let i = 0; i < stamps.length; i++)
			children.push(
				await start(f, {
					argv: materializeArgs(f, stamps[i].digest, destinations[i]),
					destination: destinations[i],
					marker: markers[i],
					release: releaseFile,
				}),
			);
		await atBarrier(children, markers);
		assert.ok(
			destinations.every((p) => !fs.existsSync(p)),
			"both publications paused before final rename",
		);
		for (const marker of markers)
			assert.equal(fs.readFileSync(marker, "utf8"), "before-final-rename");
		put(releaseFile, "release");
		for (let i = 0; i < children.length; i++) {
			const r = await children[i].done;
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.signal, null);
			assert.equal(r.stderr, "");
			assert.deepEqual(
				JSON.parse(r.stdout),
				exactOutput(f, stamps[i], destinations[i], i),
			);
			const counts = JSON.parse(fs.readFileSync(children[i].audit));
			assert.equal(counts.renames, 1);
			assert.deepEqual(counts.dispatch, []);
		}
		return destinations;
	} finally {
		put(releaseFile, "release");
		for (const child of children)
			if (!child.closed) child.process.kill("SIGKILL");
		await Promise.all(children.map((c) => c.done));
	}
}
test("P9-09 real two-target CLI exports both reach deterministic barrier before either commits", async (t) => {
	const f = fixture(t);
	qualified(f);
	const stamps = [capture(f), capture(f, 1)];
	const before = [
		fingerprint(f.root),
		fingerprint(f.storeRoot),
		fingerprint(f.ambient),
	];
	await concurrent(f, stamps);
	assert.deepEqual(
		[fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(f.ambient)],
		before,
	);
});

for (const entry of ["sync", "callback", "promise"])
	test(`P9-09 fixture qualification: ${entry} native interception and real rename barrier`, async (t) => {
		const f = fixture(t),
			destination = path.join(f.outputRoot, "control"),
			marker = path.join(f.dir, "marker"),
			releaseFile = path.join(f.dir, "release");
		const child = await start(f, {
			op: "control",
			entry,
			destination,
			marker,
			release: releaseFile,
			storeRoot: destination,
		});
		try {
			await atBarrier([child], [marker]);
			assert.equal(fs.existsSync(destination), false);
			put(releaseFile, "release");
			const r = await child.done;
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.stderr, "");
			const result = JSON.parse(r.stdout);
			assert.deepEqual(result.raw, [0, 255, 13, 10]);
			assert.equal(result.counts.renames, 1);
			assert.ok(result.counts.backingReads > 0);
			assert.deepEqual(
				result.counts.dispatch.map((c) => c.name),
				["spawnSync", "fetch"],
			);
		} finally {
			put(releaseFile, "release");
			if (!child.closed) child.process.kill("SIGKILL");
			await child.done;
		}
	});
test("P9-09 fixture qualification: no-request helper is inert and native drift observation is real", (t) => {
	const f = fixture(t),
		before = fingerprint(f.dir);
	const inert = spawnSync(process.execPath, [WORKER], {
		cwd: f.dir,
		env: f.env,
		encoding: "utf8",
	});
	assert.ifError(inert.error);
	assert.equal(inert.status, 0);
	assert.equal(inert.stdout, "");
	assert.equal(inert.stderr, "");
	assert.deepEqual(fingerprint(f.dir), before);
	const file = path.join(f.packages[0].source, "package.yaml"),
		bytes = fs.readFileSync(file, "utf8").replace("1.0.0", "9.0.0");
	const r = child(f, [], {
		op: "drift-control",
		cwd: f.packages[0].source,
		drift: { file, bytes: Buffer.from(bytes).toString("base64") },
	});
	assert.equal(r.status, 0, r.stderr);
	const result = JSON.parse(r.stdout);
	assert.equal(result.first.version, "1.0.0");
	assert.equal(result.second.version, "9.0.0");
	assert.equal(result.counts.drift, 1);
});

test("P9-09 fixture qualification: an outside request is rejected before production import or mutation", (t) => {
	const f = fixture(t),
		before = fingerprint(f.dir);
	const q = {
		op: "cli",
		ownedRoot: f.dir,
		cwd: f.root,
		argv: ["verify", "0".repeat(64), "--store", path.dirname(f.dir)],
	};
	const r = spawnSync(process.execPath, [WORKER, JSON.stringify(q)], {
		cwd: f.dir,
		env: f.env,
		encoding: "utf8",
	});
	assert.ifError(r.error);
	assert.equal(r.status, 1);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /worker path escapes owned root/);
	assert.doesNotMatch(r.stderr, /Agent Profiles:/);
	assert.deepEqual(fingerprint(f.dir), before);
});

test("P9-10 native/eval prerequisite: managed content verifies while native readiness and runtime remain unverified", (t) => {
	const f = fixture(t, { native: true });
	const a = capture(f),
		report = verifyStamp({ digest: a.digest, storeRoot: f.storeRoot });
	assert.equal(report.managedReproducible, true);
	assert.equal(report.declaredHostDependenciesSatisfied, false);
	assert.equal(report.completeRuntimeReproducible, false);
	for (const field of [
		"hostDependencies",
		"hostInvocation",
		"runtimeIdentity",
		"renderedPrompt",
	])
		assert.equal(report[field], "unverified", field);
	assert.match(
		report.findings.join("\n"),
		/Host dependencies and native invocation remain unverified/,
	);
	assert.equal(a.snapshot.hostReferences[0].requirement, "required");
	assert.equal(a.snapshot.hostReferences[0].compatibility, true);
	assert.throws(
		() =>
			reconstructStamp({
				digest: a.digest,
				storeRoot: f.storeRoot,
				nativeReady: true,
			}),
		/unsupported-native/,
	);
	const before = fingerprint(f.storeRoot),
		record = {
			stampDigest: a.digest,
			model: MODELS[0],
			provider: "fictional-provider",
			suite: "inert-review",
			environment: "offline-owned",
		};
	put(path.join(f.dir, "eval.json"), JSON.stringify(record));
	record.model = MODELS[1];
	record.provider = "other-fictional-provider";
	put(path.join(f.dir, "eval.json"), JSON.stringify(record));
	assert.deepEqual(fingerprint(f.storeRoot), before);
});
test("P9-10 CLI native verification preserves independent consumer-readiness fields and capability text", (t) => {
	const f = fixture(t, { native: true }),
		a = capture(f);
	assert.deepEqual(
		success(
			child(f, ["verify", a.digest, "--store", f.storeRoot, "--json"]),
			"native managed verification",
		),
		verifyStamp({ digest: a.digest, storeRoot: f.storeRoot }),
	);
	const r = child(f, ["resolve", ...f.args()]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Native package @example\/security-review@1\.0\.0/);
	assert.ok(r.stdout.includes(f.packages[0].digest));
	assert.match(r.stdout, /invocation unverified/);
	assert.doesNotMatch(r.stdout, /Read `null`|Invoke the .* skill `null`/);
});

test("P9-11 inherited API preservation controls: configure, preset, inventory and default diagnostics", async (t) => {
	const f = fixture(t);
	qualified(f);
	const before = [
		fingerprint(f.root),
		fingerprint(f.storeRoot),
		fingerprint(f.ambient),
	];
	const state = readConfiguration(f.root, { storeRoot: f.storeRoot });
	const found = discoverSkills(f.root, state.configuration).skills.find(
		(s) => s.id === "security-review",
	);
	assert.equal(found.path, null);
	assert.equal(found.verification, "not-checked");
	assert.equal(found.availability, "declared");
	const inventory = inspectRepository({ root: f.root });
	assert.ok(
		inventory.repository.configuration.roles.some((r) => r.id === "reviewer"),
	);
	await configureRoles({
		root: f.root,
		storeRoot: f.storeRoot,
		ask: async () => "q",
		write: () => {},
	});
	const source = path.join(f.dir, "preset");
	fs.cpSync(path.join(REPO, "examples/presets/release-review"), source, {
		recursive: true,
	});
	const lines = [];
	await runPreset({
		command: "inspect",
		location: source,
		root: f.root,
		storeRoot: f.storeRoot,
		write: (line) => lines.push(line),
	});
	assert.match(lines.join("\n"), /No changes have been made/);
	const formatted = formatContext(resolveInstructions(f.select()));
	assert.ok(!formatted.includes(f.storeRoot));
	assert.doesNotMatch(formatted, /Read `null`|objects\/sha256/);
	assert.deepEqual(
		[fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(f.ambient)],
		before,
	);
});
test("P9-11 preservation fingerprint qualification: exact exclusion and protected-byte change", (t) => {
	const f = fixture(t);
	const before = fingerprint(f.root, [CONFIG]);
	put(path.join(f.root, CONFIG), "permitted change");
	assert.deepEqual(fingerprint(f.root, [CONFIG]), before);
	put(
		path.join(f.root, ".agent-profiles/roles/reviewer.md"),
		"protected change",
	);
	assert.notDeepEqual(fingerprint(f.root, [CONFIG]), before);
});
test("P9-11 CLI inspect remains declaration-only with explicit store and stale lock", (t) => {
	const f = fixture(t);
	qualified(f);
	f.config.roles.reviewer.description = "stale declaration";
	f.save();
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	const r = child(f, [
		"inspect",
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		"--json",
	]);
	const actual = success(r, "bounded declaration inventory");
	assert.equal(actual.repository.configuration.status, "partial");
	assert.ok(
		actual.repository.configuration.roles.some(
			(role) => role.id === "reviewer",
		),
	);
	assert.equal(r.counts.backingReads, 0);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

test("P9-12 complete offline two-revision CLI workflow with raw bytes, frozen fresh install and concurrent exports", async (t) => {
	const f = fixture(t, { seeded: false, locked: false });
	for (const p of f.packages)
		assert.deepEqual(
			success(
				child(f, [
					"add",
					`${NAME}@${p.version}`,
					"--source",
					p.source,
					"--store",
					f.storeRoot,
					"--json",
				]),
				`workflow add ${p.version}`,
			),
			{
				identity: { name: NAME, version: p.version },
				sha256: p.digest,
				status: "published",
			},
		);
	assert.deepEqual(
		success(
			child(f, [
				"install",
				"--root",
				f.root,
				"--store",
				f.storeRoot,
				"--offline",
				...f.sources(),
				"--json",
			]),
			"workflow lock",
		),
		{ lockState: "valid", installRequired: false },
	);
	qualified(f);
	const stamps = [];
	for (let i = 0; i < 2; i++) {
		assert.deepEqual(
			success(
				child(f, ["resolve", ...f.args(i), "--json", "--contents"]),
				"workflow resolve",
			),
			plain(resolveInstructions(f.select(i))),
		);
		const stamp = success(
			child(f, ["stamp", ...f.args(i), "--json"]),
			"workflow stamp",
		);
		assert.deepEqual(stamp, capture(f, i));
		assert.equal(
			stamp.digest,
			recordHash(stamp.snapshot, "agent-profiles/stamp/v1"),
		);
		assert.deepEqual(
			success(
				child(f, ["verify", stamp.digest, "--store", f.storeRoot, "--json"], {
					cwd: f.dir,
				}),
				"workflow verify",
			),
			verifyStamp({ digest: stamp.digest, storeRoot: f.storeRoot }),
		);
		stamps.push(stamp);
	}
	assert.deepEqual(
		success(
			child(f, [
				"diff",
				stamps[0].digest,
				stamps[1].digest,
				"--store",
				f.storeRoot,
				"--json",
			]),
			"workflow finite diff",
		),
		expectedDiff(f, ...stamps),
	);
	const configBytes = fs.readFileSync(path.join(f.root, CONFIG)),
		lockBytes = fs.readFileSync(path.join(f.root, LOCK));
	const retained = path.join(f.dir, "approved offline copies");
	fs.mkdirSync(retained);
	for (const p of f.packages)
		fs.cpSync(p.source, path.join(retained, p.version), { recursive: true });
	const freshRoot = path.join(f.dir, "fresh project"),
		freshStore = path.join(f.dir, "fresh store");
	fs.mkdirSync(freshRoot);
	fs.mkdirSync(freshStore);
	put(path.join(freshRoot, CONFIG), configBytes);
	put(path.join(freshRoot, LOCK), lockBytes);
	put(path.join(freshRoot, ".agent-profiles/profiles/base.md"), PROFILE);
	put(path.join(freshRoot, ".agent-profiles/roles/reviewer.md"), ROLE);
	put(path.join(freshRoot, "AGENTS.md"), SHARED);
	fs.rmSync(path.join(f.root, ".agent-profiles"), { recursive: true });
	fs.rmSync(path.join(f.root, "AGENTS.md"));
	for (const p of f.packages) fs.rmSync(p.source, { recursive: true });
	const storeBefore = fingerprint(f.storeRoot);
	for (const [i, stamp] of stamps.entries()) {
		const verification = success(
			child(f, ["verify", stamp.digest, "--store", f.storeRoot, "--json"], {
				cwd: f.dir,
			}),
			"after mutable deletion",
		);
		assert.equal(verification.managedReproducible, true);
		const rebuilt = reconstructStamp({
			digest: stamp.digest,
			storeRoot: f.storeRoot,
		});
		assert.deepEqual(
			rebuilt.composition.map((e) => e.bytes),
			[
				PROFILE,
				ROLE,
				f.packages[i].members.find((m) => m.path === "SKILL.md").bytes,
			],
		);
		assert.deepEqual(rebuilt.packages[0].files, f.packages[i].members);
	}
	const triples = f.packages.flatMap((p) => [
		"--source",
		NAME,
		p.version,
		path.join(retained, p.version),
	]);
	assert.deepEqual(
		success(
			child(f, [
				"install",
				"--root",
				freshRoot,
				"--store",
				freshStore,
				"--frozen-lockfile",
				"--offline",
				...triples,
				"--json",
			]),
			"fresh frozen offline",
		),
		{ lockState: "valid", installRequired: false },
	);
	assert.deepEqual(fs.readFileSync(path.join(freshRoot, LOCK)), lockBytes);
	assert.deepEqual(
		fs.readdirSync(path.join(freshStore, "objects/sha256")).sort(),
		f.packages.map((p) => p.digest).sort(),
	);
	assert.equal(
		fs.existsSync(path.join(freshStore, "stamps")),
		false,
		"package installation is not stamp transfer",
	);
	for (let i = 0; i < 2; i++) {
		const result = success(
			child(f, [
				"resolve",
				"--root",
				freshRoot,
				"--store",
				freshStore,
				"--model",
				MODELS[i],
				"--role",
				"reviewer",
				"--json",
				"--contents",
			]),
			"fresh resolution",
		);
		assert.equal(result.required[0].package.sha256, f.packages[i].digest);
		assert.equal(
			result.loaded[2].content,
			f.packages[i].members
				.find((m) => m.path === "SKILL.md")
				.bytes.toString("utf8"),
		);
	}
	await concurrent(f, stamps);
	assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
	const evalRecord = {
		stampDigest: stamps[0].digest,
		model: MODELS[0],
		provider: "fictional-provider",
		suite: "offline-review",
		environment: "owned-fixture",
	};
	put(path.join(f.dir, "eval.json"), JSON.stringify(evalRecord));
	evalRecord.model = MODELS[1];
	evalRecord.environment = "different-inert-environment";
	put(path.join(f.dir, "eval.json"), JSON.stringify(evalRecord));
	assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
	assert.equal(
		verifyStamp({ digest: stamps[0].digest, storeRoot: f.storeRoot })
			.completeRuntimeReproducible,
		false,
	);
});
test("P9-12 sabotage: incomparable assignment rules name binding and both rules before acquisition", (t) => {
	const f = fixture(t);
	qualified(f);
	f.config.assignments = {
		"by-model": {
			when: { model: MODELS[1] },
			versions: { "skills.security-review": "2.0.0" },
		},
		"by-role": {
			when: { role: "reviewer" },
			versions: { "skills.security-review": "1.0.0" },
		},
	};
	f.save();
	assert.throws(
		() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
		(error) => {
			for (const pattern of [
				/skills.security-review/,
				/by-model/,
				/by-role/,
				/incomparable|ambiguous/,
			])
				assert.match(error.message, pattern);
			return true;
		},
	);
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	const r = child(f, [
		"install",
		"--root",
		f.root,
		"--store",
		f.storeRoot,
		...f.sources(),
		"--json",
	]);
	refusal(r, /skills.security-review/);
	assert.match(r.stderr, /by-model/);
	assert.match(r.stderr, /by-role/);
	assert.match(r.stderr, /incomparable|ambiguous/);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

test("P9-12 fixture qualification: incomparable rules are rejected by the actual configuration validator", (t) => {
	const f = fixture(t);
	qualified(f);
	f.config.assignments = {
		"by-model": {
			when: { model: MODELS[1] },
			versions: { "skills.security-review": "2.0.0" },
		},
		"by-role": {
			when: { role: "reviewer" },
			versions: { "skills.security-review": "1.0.0" },
		},
	};
	f.save();
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	assert.throws(
		() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
		(error) => {
			for (const pattern of [
				/skills.security-review/,
				/by-model/,
				/by-role/,
				/incomparable|ambiguous/,
			])
				assert.match(error.message, pattern);
			return true;
		},
	);
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

test("P9-01 sanitation fixture qualification: clean and escaped-control package metadata remain exact and available", (t) => {
	for (const adversarial of [false, true]) {
		const f = fixture(t, { seeded: false, locked: false }),
			source = f.packages[0].source;
		const frontmatter = adversarial
			? String.raw`name: "Security \u001b[34mmetadata\u001b[0m name\u0007"
description: "Inspect \u001b[31msecurity\u001b[0m boundaries.\u0007\u007f\r\nP9-METADATA-LINE: keep evidence."`
			: 'name: "Security metadata name"\ndescription: "Inspect security boundaries. P9-METADATA-LINE: keep evidence."';
		const name = adversarial
			? "Security \x1b[34mmetadata\x1b[0m name\x07"
			: "Security metadata name";
		const description = adversarial
			? "Inspect \x1b[31msecurity\x1b[0m boundaries.\x07\x7f\r\nP9-METADATA-LINE: keep evidence."
			: "Inspect security boundaries. P9-METADATA-LINE: keep evidence.";
		const entry = Buffer.from(
			"---\n" +
				frontmatter +
				"\n---\nPackage instruction bytes: \x1b[32mARCHIVE\x1b[0m\tkeep.\r\n\r\n",
		);
		assert.ok(
			!frontmatter.includes("\x1b"),
			"YAML source encodes metadata controls; raw body bytes are separate",
		);
		if (adversarial)
			assert.ok(
				frontmatter.includes("\\u001b") && frontmatter.includes("\\r\\n"),
			);
		put(path.join(source, "SKILL.md"), entry);
		const members = f.packages[0].members.map((m) =>
			m.path === "SKILL.md" ? { ...m, bytes: entry } : m,
		);
		const pkg = readPackage({ root: source });
		assert.deepEqual(pkg.files, members);
		assert.equal(pkg.sha256, treeHash(members));
		assert.deepEqual(pkg.manifest.package, {
			name: NAME,
			version: "1.0.0",
			type: "skill",
		});
		assert.deepEqual(
			importPackage({
				sourceDirectory: source,
				storeRoot: f.storeRoot,
				expectedDigest: pkg.sha256,
			}),
			{
				identity: { name: NAME, version: "1.0.0" },
				sha256: pkg.sha256,
				status: "published",
			},
		);
		f.config.assignments = {};
		f.config.roles.reviewer.skills = {
			required: [],
			available: ["security-review"],
		};
		f.save();
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		const roots = [
				f.root,
				path.join(f.dir, "sources"),
				f.storeRoot,
				f.home,
				f.ambient,
			],
			before = roots.map((root) => fingerprint(root));
		try {
			assert.deepEqual(readPackage({ root: source }).files, members);
			const retained = lookupPackage({
				storeRoot: f.storeRoot,
				name: NAME,
				version: "1.0.0",
			});
			assert.equal(retained.sha256, pkg.sha256);
			assert.deepEqual(retained.files, members);
			const resolved = resolveInstructions(f.select());
			assert.equal(resolved.lockState, "valid");
			assert.deepEqual(resolved.required, []);
			assert.deepEqual(
				resolved.loaded.map((e) => [e.kind, e.id]),
				[
					["profile", "base"],
					["role", "reviewer"],
				],
			);
			assert.equal(resolved.available.length, 1);
			const available = resolved.available[0];
			assert.deepEqual(
				[
					available.id,
					available.name,
					available.nameSource,
					available.description,
					available.type,
					available.delivery,
					available.path,
				],
				[
					"security-review",
					name,
					"frontmatter",
					description,
					"instruction",
					"inject",
					null,
				],
			);
			assert.deepEqual(available.package, {
				binding: "skills.security-review",
				name: NAME,
				version: "1.0.0",
				sha256: pkg.sha256,
				selectedBy: "binding-default",
				selectors: {},
			});
			assert.deepEqual(available.backing, {
				type: "package",
				sha256: pkg.sha256,
				path: "SKILL.md",
			});
		} finally {
			assert.deepEqual(
				roots.map((root) => fingerprint(root)),
				before,
				"metadata reads preserve all owned inputs/defaults",
			);
		}
	}
});

test("P9-01 CLI sanitation: clean and adversarial available metadata retain meaning and provenance without terminal injection", (t) => {
	for (const adversarial of [false, true]) {
		const f = fixture(t, { seeded: false, locked: false }),
			source = f.packages[0].source;
		const frontmatter = adversarial
			? String.raw`name: "Security \u001b[34mmetadata\u001b[0m name\u0007"
description: "Inspect \u001b[31msecurity\u001b[0m boundaries.\u0007\u007f\r\nP9-METADATA-LINE: keep evidence."`
			: 'name: "Security metadata name"\ndescription: "Inspect security boundaries. P9-METADATA-LINE: keep evidence."';
		const entry = Buffer.from(
			"---\n" +
				frontmatter +
				"\n---\nPackage instruction bytes: \x1b[32mARCHIVE\x1b[0m\tkeep.\r\n\r\n",
		);
		put(path.join(source, "SKILL.md"), entry);
		const pkg = readPackage({ root: source });
		importPackage({
			sourceDirectory: source,
			storeRoot: f.storeRoot,
			expectedDigest: pkg.sha256,
		});
		f.config.assignments = {};
		f.config.roles.reviewer.skills = {
			required: [],
			available: ["security-review"],
		};
		f.save();
		const rawBody = "Intentional instruction bytes: \x1b[35mBODY\x1b[0m\tkeep.";
		const profile = Buffer.from(`# Profile\r\n${rawBody}\r\n\r\n`);
		put(path.join(f.root, ".agent-profiles/profiles/base.md"), profile);
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		const resolved = resolveInstructions(f.select());
		assert.deepEqual(
			resolved.available.map((e) => e.id),
			["security-review"],
		);
		assert.ok(!resolved.loaded.some((e) => e.id === "security-review"));
		assert.equal(resolved.loaded[0].content, profile.toString("utf8"));
		assert.deepEqual(
			lookupPackage({ storeRoot: f.storeRoot, name: NAME, version: "1.0.0" })
				.files,
			pkg.files,
		);
		const roots = [
				f.root,
				path.join(f.dir, "sources"),
				f.storeRoot,
				f.home,
				f.ambient,
			],
			before = roots.map((root) => fingerprint(root));
		try {
			const result = child(f, ["resolve", ...f.args()]);
			assert.equal(
				result.status,
				0,
				`real resolve text admission: ${result.stderr}`,
			);
			assert.equal(result.stderr, "");
			assert.deepEqual(result.counts.dispatch, []);
			assert.ok(
				result.stdout.includes(rawBody),
				"intentional instruction-body controls are preserved, not globally stripped",
			);
			assert.ok(
				!result.stdout.includes("ARCHIVE"),
				"available package instruction body is not injected",
			);
			const start = result.stdout.indexOf("\n## Available skills\n"),
				end = result.stdout.indexOf("\n## Run again\n");
			assert.ok(
				start >= 0 && end > start,
				"positive available metadata section exists",
			);
			const section = result.stdout.slice(
				start + "\n## Available skills\n".length,
				end,
			);
			const bullets = section
				.split("\n")
				.filter((line) => line.startsWith("- security-review"));
			assert.equal(
				bullets.length,
				1,
				"available binding is retained exactly once",
			);
			assert.match(
				bullets[0],
				/ — Inspect .*security.* boundaries\..*P9-METADATA-LINE: keep evidence\./,
				"meaningful nonempty description and injection marker remain on the same metadata line",
			);
			if (!adversarial)
				assert.ok(
					bullets[0].includes(
						"Inspect security boundaries. P9-METADATA-LINE: keep evidence.",
					),
				);
			assert.doesNotMatch(
				section,
				/[\x00-\x09\x0b-\x1f\x7f-\x9f]/,
				"metadata contains no actual terminal controls or CR",
			);
			assert.doesNotMatch(
				section,
				/^P9-METADATA-LINE:/m,
				"decoded metadata LF cannot create an injected line",
			);
			assert.ok(
				section.includes(`Package ${NAME}@1.0.0 (sha256 ${pkg.sha256})`),
				"full verified package identity",
			);
			assert.match(section, /Load by binding ID:/);
			assert.match(
				section,
				/--skill 'security-review'/,
				"load command preserves binding provenance",
			);
			assert.doesNotMatch(
				section,
				/Read .null.|objects\/sha256|Invoke the .* skill|host-provided|undefined/,
			);
		} finally {
			assert.deepEqual(
				roots.map((root) => fingerprint(root)),
				before,
				"read-only CLI preserves config/source/store/home/ambient",
			);
		}
	}
});
