import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as observedFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { parse, stringify } from "yaml";
import {
	canonicalJSON,
	hashEvaluationRecord,
	hashRecord,
	parseRecord,
	readPackage,
} from "../src/packages.js";
import {
	encodeComponent,
	importPackage,
	lookupPackage,
	readStoreFile,
} from "../src/package-store.js";
import {
	lookupRevisionManifest,
	readRevisionRecord,
	retainRevisionManifest,
} from "../src/revisions.js";
import { installDependencies } from "../src/package-lock.js";
import { resolveInstructions } from "../src/resolve.js";
import { createStamp, reconstructStamp, verifyStamp } from "../src/stamps.js";
import * as migrations from "../src/migrations.js";

const promotionExports = [
	"previewMigrationPromotion",
	"applyMigrationPromotion",
	"migrationPromotion",
];
const ready = promotionExports.every(
	(name) => typeof migrations[name] === "function",
);
const promotionTest = (name, body) =>
	test(
		name,
		{
			skip: ready
				? false
				: "promotion preview/apply/readback interface absent; downstream body UNEXECUTED",
		},
		body,
	);
const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const originalStore = process.env.AGENT_PROFILES_STORE;
const DECISION = "agent-profiles/promotion-decision/v1",
	REVISION_V2 = "agent-profiles/revision/v2";
const versions = ["1.2.3", "1.4.5", "2.3.4"],
	models = ["local-llm", "opus", "slim-llm"];
const protocol = "@example/checkin",
	release = { name: "@example/reviewer", version: "3.0.0" };
const tuple = (model) => ({ role: "worker", model, host: "claude" });
const scope = tuple(models[0]);
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
function fixture(
	t,
	{ blocked = false, exactRule = true, ruleWhen = tuple } = {},
) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-promotion-")),
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
	const packages = new Map();
	function add(key, name, version, store = storeRoot, extra = "") {
		const directory = path.join(sources, key),
			entry = `---\r\nname: ${name.split("/")[1]}\r\ndescription: Fictional ${key}\r\n---\r\n# ${key} café  \r\n${extra}`;
		const workflow = `# Workflow ${key}\r\nKeep exact check-in evidence.  \r\n`;
		put(
			path.join(directory, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name, version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(path.join(directory, "SKILL.md"), entry);
		put(path.join(directory, "WORKFLOW.md"), workflow);
		put(path.join(directory, "data.bin"), Buffer.from([0, 255, 13, 10]));
		packages.set(key, {
			...importPackage({ sourceDirectory: directory, storeRoot: store }),
			entry,
			workflow,
			directory,
		});
	}
	for (const version of versions) add(version, "@example/reviewer", version);
	add("helper", "@example/helper", "1.0.0");
	// Misleading ambient store: the same logical identity with different bytes.
	add(
		"ambient-reviewer",
		"@example/reviewer",
		versions[0],
		ambient,
		"Misleading ambient bytes.\r\n",
	);
	process.env.AGENT_PROFILES_STORE = ambient;
	const ruled = exactRule ? models : models.slice(1),
		rule = (model) => `worker-${models.indexOf(model)}`;
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "worker",
		models: Object.fromEntries(
			models.map((model) => [
				model,
				model === models[0]
					? { profile: "base", aliases: ["local-alias"] }
					: { profile: "base" },
			]),
		),
		families: {},
		roles: {
			worker: {
				file: "roles/worker.md",
				skills: { required: ["reviewer"], available: ["note"] },
			},
		},
		skills: {
			reviewer: { package: "@example/reviewer", version: versions[0] },
			note: { file: "instructions/note.md" },
		},
		assignments: Object.fromEntries(
			ruled.map((model) => [
				rule(model),
				{
					when: ruleWhen(model),
					versions: { "skills.reviewer": versions[models.indexOf(model)] },
				},
			]),
		),
	};
	const configFile = path.join(root, ".agent-profiles/agents.yaml"),
		lockFile = path.join(root, ".agent-profiles/agent-profiles.lock");
	put(configFile, stringify(config));
	put(path.join(root, ".agent-profiles/profiles/base.md"), "﻿# Base\r\n");
	put(path.join(root, ".agent-profiles/roles/worker.md"), "# Worker\r\n");
	put(
		path.join(root, "instructions/note.md"),
		"---\ndescription: Optional note\n---\nNot injected.\n",
	);
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	installDependencies({ root, storeRoot });
	const config2Bytes = fs.readFileSync(configFile),
		input = { root, storeRoot, ...scope };
	const migration = migrations.startMigration({ ...input, sharing: "fork" });
	const records = new Map();
	for (const key of ["helper", ...versions]) {
		const pkg = packages.get(key),
			helper = packages.get("helper");
		const declaration = {
			revisionVersion: 1,
			kind: "release",
			identity: pkg.identity,
			content: { identity: pkg.identity, sha256: pkg.sha256 },
			parent: null,
			candidate: null,
			dependencies:
				key === "helper"
					? []
					: [
							{
								...helper.identity,
								sha256: helper.sha256,
								revisionDigest: records.get("helper").recordDigest,
							},
						],
			workflow: {
				file: "WORKFLOW.md",
				provides: key === "helper" ? [{ protocol, major: 1 }] : [],
				requires: key === "helper" ? [] : [{ protocol, major: 1 }],
			},
			provenance: {
				kind: "legacy-adoption",
				workflowChange: {
					kind: "initial",
					reason:
						"Explicit owned fixture declaration; no compliance evaluation.",
				},
			},
		};
		const manifestFile = path.join(dir, "adoption.json");
		put(manifestFile, JSON.stringify(declaration));
		records.set(key, retainRevisionManifest({ storeRoot, manifestFile }));
	}
	// Explicit test-owned config3 preparation; promotion itself never converts configuration.
	config.version = 3;
	config.skills.reviewer.revision = records.get(versions[0]).recordDigest;
	config.assignments = Object.fromEntries(
		ruled.map((model) => {
			const i = models.indexOf(model);
			return [
				rule(model),
				{
					when: ruleWhen(model),
					bindings: {
						"skills.reviewer": {
							package: "@example/reviewer",
							version: versions[i],
							revision: records.get(versions[i]).recordDigest,
						},
					},
				},
			];
		}),
	);
	config.workflow_links = Object.fromEntries(
		models.map((model, i) => [
			`checkin-${i}`,
			{
				protocol,
				consumer: { assignment: tuple(model), binding: "skills.reviewer" },
				providers: [{ assignment: tuple(model), binding: "skills.reviewer" }],
			},
		]),
	);
	put(configFile, stringify(config));
	installDependencies({ root, storeRoot });
	const base = createStamp(input),
		pkg = packages.get(versions[0]),
		workspace = path.join(root, migration.workspace);
	const after = pkg.entry + "Check stale evidence before reporting.\r\n",
		proposalFile = path.join(dir, "proposal.json");
	put(
		proposalFile,
		JSON.stringify({
			proposalVersion: 1,
			classification: "package",
			target: { path: `packages/${pkg.sha256}/SKILL.md` },
			change: { before: pkg.entry, after },
			evidence: [
				{
					sessionId: "caller-claimed-fixture-session",
					excerpt: "A stale-evidence check was missed.",
					baseStamp: migration.bases[0].stamp,
				},
			],
		}),
	);
	const proposed = migrations.proposeMigration({
		root,
		storeRoot,
		id: migration.id,
		proposalFile,
	});
	const accepted = migrations.acceptMigrationProposal({
		root,
		storeRoot,
		id: migration.id,
		proposalId: proposed.id,
	});
	const tree = path.join(workspace, "packages", pkg.sha256),
		candidateFile = path.join(dir, "candidate.json");
	put(
		candidateFile,
		JSON.stringify({
			candidateVersion: 1,
			id: "candidate-reviewer",
			binding: "skills.reviewer",
			release,
			migrationBase: migration.bases[0].stamp,
			evaluationBase: base.digest,
			configSha256: JSON.parse(fs.readFileSync(lockFile, "utf8")).configSha256,
			expectedTreeSha256: readPackage({ root: tree }).sha256,
			proposalIds: [accepted.id],
			workflowChange: {
				kind: "task-only",
				reason: "Retain an accepted task-only check; workflow is unchanged.",
			},
		}),
	);
	const candidate = migrations.publishMigrationCandidate({
		root,
		storeRoot,
		id: migration.id,
		manifestFile: candidateFile,
	});
	const candidateSnapshot = JSON.parse(
		fs.readFileSync(
			path.join(
				storeRoot,
				"stamps/sha256",
				candidate.stampDigest,
				"snapshot.json",
			),
			"utf8",
		),
	);
	const target = (member, declaration = null) => ({
		assignment: { ...scope },
		binding: "skills.reviewer",
		member,
		protocol: declaration,
	});
	const plan = {
		planVersion: 1,
		id: "paired-plan",
		candidateId: candidate.id,
		candidateRevisionDigest: candidate.revisionDigest,
		baseStamp: base.digest,
		candidateStamp: candidate.stampDigest,
		context: {
			assignment: { ...scope },
			requestedSkills: [],
			workflowPeers: {
				base: base.snapshot.workflowPeers,
				candidate: candidateSnapshot.workflowPeers,
			},
		},
		cases: [
			{
				id: "fix",
				kind: "motivating",
				input: "Fictional stale evidence",
				expected: "Refuse stale evidence",
				target: target("@example/reviewer"),
			},
			{
				id: "retain",
				kind: "regression",
				input: "Fictional valid review",
				expected: "Keep exact review outcome",
				target: target("@example/reviewer"),
			},
			{
				id: "checkin",
				kind: "workflow",
				input: "Fictional handoff",
				expected: "Retain check-in obligations",
				target: target("@example/reviewer", { protocol, major: 1 }),
			},
			{
				id: "helper",
				kind: "collateral",
				input: "Fictional helper interaction",
				expected: "Observed within the primary trial only",
				target: target("@example/helper"),
			},
		],
		trials: 2,
		conditions: {
			harness: {
				id: "fictional-harness",
				version: "offline-1",
				settings: { seed: 17, temperature: 0 },
			},
			judge: {
				id: "fictional-judge",
				version: "claim-1",
				settings: { temperature: 0 },
			},
			rubric: {
				id: "literal-checks",
				version: "1",
				settings: { strict: true },
			},
		},
	};
	const planFile = path.join(dir, "plan.json");
	put(planFile, JSON.stringify(plan));
	const planned = migrations.planMigrationEvaluation({
		root,
		storeRoot,
		candidateId: candidate.id,
		planFile,
	});
	const results = {
		resultVersion: 1,
		id: "paired-results",
		planDigest: planned.planDigest,
		candidateRevisionDigest: candidate.revisionDigest,
		conditions: {
			base: structuredClone(plan.conditions),
			candidate: structuredClone(plan.conditions),
		},
		outcomes: plan.cases.flatMap((c) =>
			[1, 2].flatMap((trial) =>
				["base", "candidate"].map((side) => ({
					caseId: c.id,
					trial,
					side,
					stampDigest: side === "base" ? base.digest : candidate.stampDigest,
					assignment: { ...scope },
					correct:
						blocked && c.id === "retain" && side === "candidate" && trial === 1
							? false
							: side === "candidate" || c.id !== "fix",
					metrics:
						side === "base"
							? {
									costUsd: 2.25,
									tokens: 100,
									turns: 4,
									toolCalls: 3,
									latencyMs: 10,
								}
							: {
									costUsd: 1.25,
									tokens: 80,
									turns: 3,
									toolCalls: 2,
									latencyMs: 8,
								},
					evidenceRef: `opaque:caller-claim/${c.id}/${trial}/${side}`,
				})),
			),
		),
	};
	const resultFile = path.join(dir, "results.json");
	put(resultFile, JSON.stringify(results));
	const imported = migrations.importMigrationEvaluationResults({
		root,
		storeRoot,
		planId: plan.id,
		resultFile,
	});
	const report = migrations.migrationEvaluationReport({
		storeRoot,
		id: results.id,
	});
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
		config2Bytes,
		configFile,
		lockFile,
		input,
		migration,
		base,
		tree,
		after,
		candidate,
		candidateSnapshot,
		plan,
		planFile,
		planned,
		results,
		resultFile,
		imported,
		report,
		decisionFile: path.join(dir, "decision.json"),
	};
}
const roots = (f) => [f.root, f.storeRoot, f.ambient].map(files);
const report = (f) =>
	migrations.migrationEvaluationReport({
		storeRoot: f.storeRoot,
		id: f.results.id,
	});
const preview = (f, decisionFile = f.decisionFile, storeRoot = f.storeRoot) =>
	migrations.previewMigrationPromotion({
		root: f.root,
		storeRoot,
		decisionFile,
	});
const apply = (f, decisionFile = f.decisionFile, storeRoot = f.storeRoot) =>
	migrations.applyMigrationPromotion({ root: f.root, storeRoot, decisionFile });
const readPromotion = (f, id = "promote-reviewer") =>
	migrations.migrationPromotion({ storeRoot: f.storeRoot, id });
const labelRelative = (identity) =>
	`revisions/labels/${identity.name.slice(1).split("/").map(encodeComponent).join("/")}/${identity.version}.json`;
const indexPath = (f, id) =>
	path.join(f.storeRoot, "promotions/decisions/ids", `${id}.json`);
function decision(f, changes = {}) {
	const regressions = structuredClone(f.report.eligibility.regressions);
	return {
		decisionVersion: 1,
		id: "promote-reviewer",
		resultId: f.results.id,
		candidateId: f.candidate.id,
		candidateRevisionDigest: f.candidate.revisionDigest,
		planDigest: f.planned.planDigest,
		resultDigest: f.imported.resultDigest,
		assignment: { ...scope },
		release: { ...release },
		regressions,
		correctnessOverride: regressions.length
			? {
					gate: "per-case-correctness-drop",
					reason: "Maintainer accepts the recorded fictional retain-case drop.",
					cases: regressions.map((row) => row.caseId),
				}
			: null,
		...changes,
	};
}
const writeDecision = (f, value, file = f.decisionFile) => {
	put(file, JSON.stringify(value));
	return value;
};
function expected(f, d) {
	const decisionDigest = hashRecord(DECISION, d),
		candidate = readRevisionRecord({
			storeRoot: f.storeRoot,
			recordDigest: f.candidate.revisionDigest,
		});
	const wrapper = {
		revisionVersion: 2,
		kind: "release",
		identity: candidate.identity,
		content: candidate.content,
		parent: candidate.parent,
		candidate: f.candidate.revisionDigest,
		dependencies: candidate.dependencies,
		workflow: candidate.workflow,
		provenance: { kind: "promotion", decisionDigest },
	};
	const releaseDigest = hashRecord(REVISION_V2, wrapper),
		exact = Object.hasOwn(f.config.assignments, "worker-0");
	const target = {
		assignment: { ...scope },
		binding: "skills.reviewer",
		rule: exact
			? { id: "worker-0", when: { ...scope }, action: "replace" }
			: null,
		before: structuredClone(
			exact
				? f.config.assignments["worker-0"].bindings["skills.reviewer"]
				: f.config.skills.reviewer,
		),
		after: {
			package: release.name,
			version: release.version,
			revision: releaseDigest,
		},
	};
	return { decisionDigest, wrapper, releaseDigest, target };
}
function selection(f, model) {
	const r = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		...tuple(model),
	});
	return {
		package: r.required.find((entry) => entry.id === "reviewer").package,
		loaded: r.loaded.map((entry) => [entry.kind, entry.id, entry.content]),
		peers: r.workflow.peers,
		status: r.workflow.status,
	};
}
const composition = (f, digest) =>
	reconstructStamp({ storeRoot: f.storeRoot, digest }).composition.map(
		(part) => [part.kind, part.id, part.bytes.toString("hex")],
	);
function refuses(f, operation, diagnostic) {
	const before = roots(f);
	assert.throws(operation, diagnostic);
	assert.deepEqual(roots(f), before);
}
function priorRetained(before, after) {
	const now = new Map(after.map((row) => [row[0], row]));
	for (const row of before)
		assert.deepEqual(now.get(row[0]), row, `${row[0]} retained unchanged`);
}
function noWriters(f) {
	for (const lock of [
		path.join(f.storeRoot, ".writer-lock"),
		path.join(f.root, ".agent-profiles/.migration-writer"),
		path.join(f.root, ".agent-profiles/.dependency-writer"),
	])
		assert.equal(fs.existsSync(lock), false, lock);
}
function child(f, args, withRoot = true) {
	return spawnSync(
		process.execPath,
		[
			cli,
			...args,
			...(withRoot ? ["--root", f.root] : []),
			"--store",
			f.storeRoot,
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

// Runnable prerequisite controls: real fixtures, resolver, codecs and observers; no promotion seam is used.

test("promotion fixture: real three-version config3 coexistence, advisory candidate and complete eligible evidence", (t) => {
	const f = fixture(t),
		before = roots(f);
	for (const [i, model] of models.entries()) {
		const s = selection(f, model);
		assert.deepEqual(s.package, {
			binding: "skills.reviewer",
			name: "@example/reviewer",
			version: versions[i],
			sha256: f.packages.get(versions[i]).sha256,
			revisionDigest: f.records.get(versions[i]).recordDigest,
			selectedBy: `worker-${i}`,
			selectors: tuple(model),
		});
		assert.equal(s.status, "declared-compatible");
	}
	const alias = selection(f, "local-alias"),
		canonical = selection(f, models[0]);
	assert.deepEqual(
		[alias.package, alias.loaded],
		[canonical.package, canonical.loaded],
		"alias reaches the canonical exact rule",
	);
	assert.notEqual(
		f.packages.get("ambient-reviewer").sha256,
		f.packages.get(versions[0]).sha256,
		"ambient store is misleading, not identical",
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
			.managedReproducible,
		true,
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: f.candidate.stampDigest })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		composition(f, f.candidate.stampDigest).find(
			([kind, id]) => kind === "required-skill" && id === "reviewer",
		)[2],
		Buffer.from(f.after).toString("hex"),
	);
	assert.equal(lookupPackage({ storeRoot: f.storeRoot, ...release }), null);
	assert.throws(
		() =>
			lookupRevisionManifest({
				storeRoot: f.storeRoot,
				recordDigest: f.candidate.revisionDigest,
			}),
		/candidate|unpublished|selectable/i,
	);
	assert.deepEqual(f.report.eligibility, {
		status: "eligible",
		regressions: [],
	});
	assert.equal(f.report.evidence.promotion, "not-authorized");
	assert.deepEqual(f.report.context.assignment, scope);
	assert.deepEqual(roots(f), before, "fixture reads are read-only");
});

test("promotion fixture: blocked evidence names the exact per-case drop; rule-less variant uses the shared default binding", (t) => {
	const blocked = fixture(t, { blocked: true });
	assert.deepEqual(blocked.report.eligibility, {
		status: "blocked",
		regressions: [
			{
				caseId: "retain",
				basePassed: 2,
				candidatePassed: 1,
				trials: 2,
				reason: "per-case-correctness-drop",
			},
		],
	});
	const ruleless = fixture(t, { exactRule: false }),
		primary = selection(ruleless, models[0]);
	assert.equal(primary.package.selectedBy, "binding-default");
	assert.equal(
		primary.package.revisionDigest,
		ruleless.records.get(versions[0]).recordDigest,
	);
	assert.equal(Object.hasOwn(ruleless.config.assignments, "worker-0"), false);
	assert.equal(selection(ruleless, models[1]).package.selectedBy, "worker-1");
	assert.deepEqual(ruleless.report.eligibility.status, "eligible");
});

test("decision and release-wrapper payloads qualify on the existing integer-only record codec", (t) => {
	for (const f of [fixture(t), fixture(t, { blocked: true })]) {
		const d = decision(f),
			e = expected(f, d),
			bytes = canonicalJSON(d);
		assert.deepEqual(parseRecord(bytes), d);
		assert.deepEqual(canonicalJSON(parseRecord(bytes)), bytes);
		assert.equal(hashRecord(DECISION, parseRecord(bytes)), e.decisionDigest);
		assert.notEqual(
			hashRecord(REVISION_V2, d),
			e.decisionDigest,
			"domain-framed digests are separated",
		);
		assert.equal(
			JSON.stringify(d).includes('"rate"'),
			false,
			"fractional report rates are referenced by result digest, not copied",
		);
		for (const row of d.regressions)
			for (const key of ["basePassed", "candidatePassed", "trials"])
				assert.equal(Number.isSafeInteger(row[key]), true);
		assert.deepEqual(parseRecord(canonicalJSON(e.wrapper)), e.wrapper);
		assert.deepEqual(
			e.wrapper.content,
			f.candidate.content,
			"wrapper content is the evaluated candidate content, not a rebuild",
		);
		assert.notEqual(
			e.releaseDigest,
			f.candidate.revisionDigest,
			"approval metadata has its own record digest",
		);
		assert.throws(() => canonicalJSON({ ...d, rate: 0.5 }), /safe integer/);
		assert.throws(
			() => parseRecord(Buffer.from('{"rate":0.5}')),
			/decimal integer/,
		);
		assert.throws(
			() => hashEvaluationRecord(DECISION, d),
			/evaluation plan or result domain/,
		);
	}
});

test("public revision adoption stays legacy-strict for release wrappers and mismatched identities", (t) => {
	const f = fixture(t),
		d = decision(f),
		e = expected(f, d),
		file = path.join(f.dir, "forged-adoption.json"),
		before = roots(f);
	put(file, JSON.stringify(e.wrapper));
	assert.throws(
		() =>
			retainRevisionManifest({ storeRoot: f.storeRoot, manifestFile: file }),
		/revisionVersion|legacy|adoption/i,
	);
	const parent = readRevisionRecord({
		storeRoot: f.storeRoot,
		recordDigest: f.records.get(versions[0]).recordDigest,
	});
	put(file, JSON.stringify({ ...parent, identity: release }));
	assert.throws(
		() =>
			retainRevisionManifest({ storeRoot: f.storeRoot, manifestFile: file }),
		/identity mismatch/,
	);
	assert.deepEqual(roots(f), before);
});

test("observer control: staged-index rename EIO keeps complete staged bytes, an absent target and restored methods", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-promotion-eio-control-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const staged = path.join(dir, "stage.json"),
		target = path.join(dir, "final.json"),
		originalRename = fs.renameSync;
	const index = {
			promotionIndexVersion: 1,
			id: "harness-only",
			decisionDigest: "a".repeat(64),
			releaseDigest: "b".repeat(64),
		},
		bytes = canonicalJSON(index);
	fs.writeFileSync(staged, bytes);
	const sentinel = Object.assign(
		new Error("standalone promotion-index EIO sentinel"),
		{ code: "EIO" },
	);
	let interventions = 0;
	observeFs(
		t,
		"renameSync",
		(real, from, to, ...args) => {
			if (path.resolve(to) !== target) return real(from, to, ...args);
			interventions++;
			assert.equal(fs.existsSync(target), false);
			assert.deepEqual(fs.readFileSync(from), bytes);
			assert.deepEqual(parseRecord(fs.readFileSync(from)), index);
			throw sentinel;
		},
		() =>
			assert.throws(
				() => observedFs.renameSync(staged, target),
				(error) => error === sentinel,
			),
	);
	assert.equal(interventions, 1);
	assert.equal(fs.existsSync(target), false);
	assert.deepEqual(fs.readFileSync(staged), bytes);
	assert.equal(fs.renameSync, originalRename);
	assert.equal(observedFs.renameSync, originalRename);
	observedFs.renameSync(staged, target);
	assert.deepEqual(fs.readFileSync(target), bytes);
});

test("observer control: a complete project edit inside an intercepted rename precedes the real commit", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-promotion-edit-control-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const staged = path.join(dir, "stage.json"),
		target = path.join(dir, "final.json"),
		config = path.join(dir, "agents.yaml"),
		originalRename = fs.renameSync;
	const original = Buffer.from("version: 3\n"),
		edited = Buffer.concat([original, Buffer.from("# concurrent user note\n")]),
		bytes = canonicalJSON({ id: "harness-only" });
	fs.writeFileSync(config, original);
	fs.writeFileSync(staged, bytes);
	let edits = 0;
	observeFs(
		t,
		"renameSync",
		(real, from, to, ...args) => {
			if (path.resolve(to) === target && edits === 0) {
				fs.writeFileSync(config, edited);
				edits++;
				assert.deepEqual(fs.readFileSync(config), edited);
			}
			return real(from, to, ...args);
		},
		() => observedFs.renameSync(staged, target),
	);
	assert.equal(edits, 1);
	assert.deepEqual(fs.readFileSync(config), edited);
	assert.deepEqual(fs.readFileSync(target), bytes);
	assert.equal(fs.existsSync(staged), false);
	assert.equal(fs.renameSync, originalRename);
	assert.equal(observedFs.renameSync, originalRename);
});

test("observer control: safe-reader post-close edit returns the original complete bytes", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-promotion-close-control-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const input = path.join(dir, "decision.json"),
		original = Buffer.from('{"decisionVersion":1,"id":"original"}\n'),
		edited = Buffer.from('{"decisionVersion":1,"id":"edited"}\n');
	fs.writeFileSync(input, original);
	const originalOpen = fs.openSync,
		originalClose = fs.closeSync,
		write = fs.writeFileSync;
	let fd = null,
		edits = 0,
		editing = false;
	const returned = observeFs(
		t,
		"openSync",
		(real, target, ...args) => {
			const opened = real(target, ...args);
			if (!editing && edits === 0 && path.resolve(target) === input)
				fd = opened;
			return opened;
		},
		() =>
			observeFs(
				t,
				"closeSync",
				(real, closing, ...args) => {
					const selected = !editing && edits === 0 && closing === fd,
						closed = real(closing, ...args);
					if (selected) {
						fd = null;
						editing = true;
						try {
							write(input, edited);
							edits++;
						} finally {
							editing = false;
						}
					}
					return closed;
				},
				() => readStoreFile(dir, "decision.json"),
			),
	);
	assert.equal(edits, 1);
	assert.deepEqual(returned, original);
	assert.deepEqual(fs.readFileSync(input), edited);
	assert.equal(fs.openSync, originalOpen);
	assert.equal(observedFs.openSync, originalOpen);
	assert.equal(fs.closeSync, originalClose);
	assert.equal(observedFs.closeSync, originalClose);
});

test("promotion preview, apply and readback interfaces exist on the migrations module", () => {
	assert.deepEqual(
		promotionExports.filter((name) => typeof migrations[name] !== "function"),
		[],
		"src/migrations.js must expose the promotion preview/apply/readback seam",
	);
});

// Behavioral contract: skipped only while the promotion seam is absent.

promotionTest(
	"read-only preview reports the exact evaluated tuple target, release wrapper and gate without writes",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			before = roots(f);
		const p = preview(f);
		assert.deepEqual(p, {
			status: "preview",
			decision: { id: d.id, decisionDigest: e.decisionDigest },
			gate: { status: "eligible", regressions: [], override: null },
			release: {
				identity: release,
				content: e.wrapper.content,
				releaseDigest: e.releaseDigest,
				state: "new",
			},
			target: e.target,
		});
		assert.deepEqual(roots(f), before);
		assert.deepEqual(preview(f), p);
		assert.deepEqual(roots(f), before);
		assert.equal(
			fs.existsSync(path.join(f.storeRoot, labelRelative(release))),
			false,
		);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: f.candidate.revisionDigest,
				}),
			/candidate|unpublished|selectable/i,
		);
	},
);

promotionTest(
	"apply pins only the evaluated tuple to the exact evaluated bytes while side-by-side consumers keep their releases",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d);
		const lockBefore = JSON.parse(fs.readFileSync(f.lockFile, "utf8")),
			others = models.slice(1).map((model) => selection(f, model));
		const project = files(f.root),
			store = files(f.storeRoot),
			ambient = files(f.ambient),
			storeBefore = new Set(store.map((row) => row[0]));
		const result = apply(f);
		assert.match(result.stampDigest, /^[0-9a-f]{64}$/);
		assert.deepEqual(result, {
			status: "promoted",
			decision: { id: d.id, decisionDigest: e.decisionDigest },
			release: {
				identity: release,
				content: e.wrapper.content,
				releaseDigest: e.releaseDigest,
			},
			target: e.target,
			stampDigest: result.stampDigest,
		});
		const config = structuredClone(f.config);
		config.assignments["worker-0"].bindings["skills.reviewer"] = e.target.after;
		assert.deepEqual(
			parse(fs.readFileSync(f.configFile, "utf8")),
			config,
			"only the exact evaluated-tuple binding changed; defaults and other rules are intact",
		);
		const lock = JSON.parse(fs.readFileSync(f.lockFile, "utf8")),
			order = (a, b) =>
				Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) ||
				Buffer.compare(Buffer.from(a.version), Buffer.from(b.version));
		assert.deepEqual(fs.readFileSync(f.lockFile), canonicalJSON(lock));
		assert.notEqual(lock.configSha256, lockBefore.configSha256);
		assert.deepEqual(lock, {
			...lockBefore,
			configSha256: lock.configSha256,
			pins: lockBefore.pins.map((pin) =>
				pin.binding === "skills.reviewer" && pin.rule === "worker-0"
					? {
							...pin,
							version: release.version,
							sha256: e.wrapper.content.sha256,
							revisionDigest: e.releaseDigest,
						}
					: pin,
			),
			packages: [
				...lockBefore.packages,
				{
					...release,
					sha256: e.wrapper.content.sha256,
					source: { type: "provided" },
					revisionDigests: [e.releaseDigest],
				},
			].sort(order),
		});
		const changed = files(f.root),
			before = new Map(project.map((row) => [row[0], JSON.stringify(row)]));
		assert.deepEqual(
			changed
				.filter((row) => before.get(row[0]) !== JSON.stringify(row))
				.map((row) => row[0])
				.sort(),
			[".agent-profiles/agent-profiles.lock", ".agent-profiles/agents.yaml"],
		);
		assert.deepEqual(
			changed.map((row) => row[0]),
			project.map((row) => row[0]),
			"no project member added or removed",
		);
		const after = files(f.storeRoot);
		priorRetained(store, after);
		const label = labelRelative(release),
			allowed = (p) =>
				p === "promotions" ||
				p.startsWith("promotions/") ||
				p.startsWith("stamps/") ||
				p.startsWith("blobs/") ||
				p === `revisions/sha256/${e.releaseDigest}.json` ||
				p === label;
		for (const [member] of after)
			if (!storeBefore.has(member))
				assert.ok(
					allowed(member),
					`unexpected store addition ${member}; evaluated objects are never rebuilt`,
				);
		const at = (relative) => fs.readFileSync(path.join(f.storeRoot, relative));
		assert.deepEqual(
			at(`promotions/decisions/sha256/${e.decisionDigest}.json`),
			canonicalJSON(d),
		);
		assert.deepEqual(
			at(`promotions/decisions/ids/${d.id}.json`),
			canonicalJSON({
				promotionIndexVersion: 1,
				id: d.id,
				decisionDigest: e.decisionDigest,
				releaseDigest: e.releaseDigest,
			}),
		);
		assert.deepEqual(
			at(`revisions/sha256/${e.releaseDigest}.json`),
			canonicalJSON(e.wrapper),
		);
		assert.deepEqual(
			at(label),
			canonicalJSON({ identity: release, recordDigest: e.releaseDigest }),
		);
		const primary = selection(f, models[0]);
		assert.deepEqual(primary.package, {
			binding: "skills.reviewer",
			...release,
			sha256: e.wrapper.content.sha256,
			revisionDigest: e.releaseDigest,
			selectedBy: "worker-0",
			selectors: scope,
		});
		assert.deepEqual(
			primary.loaded.map(([kind, id, content]) => [
				kind,
				id,
				Buffer.from(content).toString("hex"),
			]),
			composition(f, f.candidate.stampDigest),
			"exact evaluated candidate bytes",
		);
		assert.equal(primary.peers[0].consumer.revisionDigest, e.releaseDigest);
		assert.equal(
			primary.peers[0].provider.revisionDigest,
			f.records.get("helper").recordDigest,
		);
		assert.deepEqual(
			selection(f, "local-alias").package,
			primary.package,
			"alias reaches the promoted canonical tuple",
		);
		assert.deepEqual(
			models.slice(1).map((model) => selection(f, model)),
			others,
			"other side-by-side consumers select the exact original releases",
		);
		assert.deepEqual(
			composition(f, result.stampDigest),
			composition(f, f.candidate.stampDigest),
		);
		const snapshot = JSON.parse(
			fs.readFileSync(
				path.join(
					f.storeRoot,
					"stamps/sha256",
					result.stampDigest,
					"snapshot.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(snapshot.capture, {
			kind: "active",
			migration: null,
			candidate: null,
		});
		assert.ok(
			snapshot.packages.some(
				(row) =>
					row.name === release.name &&
					row.version === release.version &&
					row.sha256 === e.wrapper.content.sha256 &&
					row.revisionDigest === e.releaseDigest,
			),
		);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
		assert.equal(
			createStamp(f.input).digest,
			result.stampDigest,
			"ordinary active capture reproduces the fresh stamp",
		);
		assert.deepEqual(
			lookupRevisionManifest({
				storeRoot: f.storeRoot,
				recordDigest: e.releaseDigest,
			}),
			e.wrapper,
		);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: f.candidate.revisionDigest,
				}),
			/candidate|unpublished|selectable/i,
		);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...release }),
			null,
			"no legacy mapping claims the embedded manifest changed",
		);
		assert.deepEqual(readPromotion(f), {
			id: d.id,
			decisionDigest: e.decisionDigest,
			releaseDigest: e.releaseDigest,
			decision: d,
			release: e.wrapper,
		});
		assert.deepEqual(report(f), f.report);
		installDependencies({ root: f.root, storeRoot: f.storeRoot, frozen: true });
		const relabeled = path.join(f.dir, "relabeled-import");
		fs.cpSync(f.tree, relabeled, { recursive: true });
		put(
			path.join(relabeled, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { ...release, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		const settled = roots(f);
		assert.throws(
			() =>
				importPackage({ sourceDirectory: relabeled, storeRoot: f.storeRoot }),
			/reserved|released|candidate|conflict|published/i,
		);
		assert.deepEqual(roots(f), settled);
		assert.deepEqual(files(f.ambient), ambient);
		noWriters(f);
	},
);

promotionTest(
	"identical replay reuses without writes; a changed decision cannot repoint the id or the release label",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			first = apply(f),
			before = roots(f);
		const replay = apply(f);
		assert.equal(replay.status, "reused");
		assert.equal(replay.release.releaseDigest, first.release.releaseDigest);
		assert.equal(replay.stampDigest, first.stampDigest);
		assert.deepEqual(roots(f), before);
		const later = structuredClone(f.results);
		later.id = "later-results";
		later.outcomes[0].metrics.costUsd = 3;
		const laterFile = path.join(f.dir, "later-results.json");
		put(laterFile, JSON.stringify(later));
		const imported = migrations.importMigrationEvaluationResults({
			root: f.root,
			storeRoot: f.storeRoot,
			planId: f.plan.id,
			resultFile: laterFile,
		});
		const sameId = writeDecision(f, {
			...d,
			resultId: later.id,
			resultDigest: imported.resultDigest,
		});
		refuses(f, () => apply(f), /immutable|conflict|repoint/i);
		writeDecision(f, { ...sameId, id: "promote-reviewer-again" });
		refuses(
			f,
			() => apply(f),
			/release|label|already|published|conflict|repoint|stale/i,
		);
		assert.equal(readPromotion(f).releaseDigest, first.release.releaseDigest);
		assert.equal(fs.existsSync(indexPath(f, "promote-reviewer-again")), false);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			first.release.releaseDigest,
		);
	},
);

promotionTest(
	"default gate refuses any per-case correctness drop before writes and names the affected case",
	(t) => {
		const f = fixture(t, { blocked: true });
		writeDecision(f, decision(f, { correctnessOverride: null }));
		for (const operation of [preview, apply])
			refuses(
				f,
				() => operation(f),
				(error) =>
					/per-case|correctness|blocked/i.test(error.message) &&
					error.message.includes("retain"),
			);
		assert.deepEqual(report(f), f.report);
	},
);

promotionTest(
	"recorded correctness-only override promotes a blocked candidate while history keeps the regression",
	(t) => {
		const f = fixture(t, { blocked: true }),
			d = writeDecision(f, decision(f)),
			e = expected(f, d);
		assert.deepEqual(preview(f).gate, {
			status: "overridden",
			regressions: f.report.eligibility.regressions,
			override: d.correctnessOverride,
		});
		assert.equal(apply(f).status, "promoted");
		assert.deepEqual(readPromotion(f), {
			id: d.id,
			decisionDigest: e.decisionDigest,
			releaseDigest: e.releaseDigest,
			decision: d,
			release: e.wrapper,
		});
		assert.deepEqual(readPromotion(f).decision.regressions, [
			{
				caseId: "retain",
				basePassed: 2,
				candidatePassed: 1,
				trials: 2,
				reason: "per-case-correctness-drop",
			},
		]);
		assert.deepEqual(
			report(f),
			f.report,
			"the historical report still shows the blocked regression",
		);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			e.releaseDigest,
		);
	},
);

promotionTest(
	"an override without any reported regression refuses rather than recording a vacuous waiver",
	(t) => {
		const f = fixture(t);
		writeDecision(
			f,
			decision(f, {
				correctnessOverride: {
					gate: "per-case-correctness-drop",
					reason: "No drop exists.",
					cases: ["retain"],
				},
			}),
		);
		for (const operation of [preview, apply])
			refuses(f, () => operation(f), /override|regression|case/i);
	},
);

const decisionFaults = [
	[
		"unknown field",
		(d) => {
			d.extra = true;
		},
		/unknown field|extra/i,
	],
	[
		"missing result id",
		(d) => {
			delete d.resultId;
		},
		/missing|resultId/i,
	],
	[
		"absent retained result",
		(d) => {
			d.resultId = "absent-results";
		},
		/ENOENT|missing|absent|result/i,
	],
	[
		"mismatched result digest",
		(d, f) => {
			d.resultDigest = f.candidate.revisionDigest;
		},
		/result.*(?:digest|binding|mismatch)|mismatch/i,
	],
	[
		"foreign plan digest",
		(d, f) => {
			d.planDigest = f.candidate.revisionDigest;
		},
		/plan.*(?:digest|binding|mismatch)|mismatch/i,
	],
	[
		"foreign candidate revision",
		(d, f) => {
			d.candidateRevisionDigest = f.records.get("helper").recordDigest;
		},
		/candidate.*(?:revision|binding|mismatch)|mismatch/i,
	],
	[
		"unevaluated peer tuple",
		(d) => {
			d.assignment = tuple(models[1]);
		},
		/assignment|evaluated|primary/i,
	],
	[
		"alias instead of the evaluated canonical model",
		(d) => {
			d.assignment.model = "local-alias";
		},
		/assignment|evaluated|primary|canonical/i,
	],
	[
		"different planned release label",
		(d) => {
			d.release.version = "9.9.9";
		},
		/release|label|planned/i,
	],
	[
		"omitted regression acknowledgement",
		(d) => {
			d.regressions = [];
		},
		/regression|report|mismatch/i,
	],
	[
		"override of another gate",
		(d) => {
			d.correctnessOverride.gate = "integrity";
		},
		/gate/i,
	],
	[
		"blank override reason",
		(d) => {
			d.correctnessOverride.reason = "  ";
		},
		/reason/i,
	],
	[
		"override omitting the affected case",
		(d) => {
			d.correctnessOverride.cases = [];
		},
		/case/i,
	],
	[
		"override naming a non-regressed case",
		(d) => {
			d.correctnessOverride.cases = ["fix"];
		},
		/case/i,
	],
];
for (const [name, mutate, diagnostic] of decisionFaults)
	promotionTest(
		`preview and apply refuse ${name} even beside a recorded override`,
		(t) => {
			const f = fixture(t, { blocked: true }),
				invalid = decision(f);
			mutate(invalid, f);
			writeDecision(f, invalid);
			for (const operation of [preview, apply])
				refuses(f, () => operation(f), diagnostic);
		},
	);

const liveFaults = [
	[
		"stale routing of the evaluated tuple",
		(f) => {
			const c = structuredClone(f.config);
			c.assignments["worker-0"].bindings["skills.reviewer"] = {
				package: "@example/reviewer",
				version: versions[1],
				revision: f.records.get(versions[1]).recordDigest,
			};
			put(f.configFile, stringify(c));
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
		},
		/stale|selection|changed/i,
		true,
	],
	[
		"stale loaded local role bytes",
		(f) =>
			put(
				path.join(f.root, ".agent-profiles/roles/worker.md"),
				"# Worker changed\r\n",
			),
		/stale|loaded|changed/i,
		true,
	],
	[
		"stale lock",
		(f) => {
			const c = structuredClone(f.config);
			c.models.opus.aliases = ["opus-alias"];
			put(f.configFile, stringify(c));
		},
		/stale-lock|lock/i,
		true,
	],
	[
		"config2 without automatic conversion",
		(f) => {
			put(f.configFile, f.config2Bytes);
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
		},
		/config3|version 3|prepare/i,
		true,
	],
	[
		"unresolved required workflow",
		(f) => {
			const c = structuredClone(f.config);
			delete c.workflow_links["checkin-0"];
			put(f.configFile, stringify(c));
			installDependencies({ root: f.root, storeRoot: f.storeRoot });
		},
		/workflow/i,
		true,
	],
	[
		"corrupt retained results",
		(f) => {
			const file = path.join(
				f.storeRoot,
				"evaluations/results/sha256",
				`${f.imported.resultDigest}.json`,
			);
			put(file, Buffer.concat([fs.readFileSync(file), Buffer.from(" ")]));
		},
		/record|digest|integrity|canonical/i,
		false,
	],
	[
		"corrupt evaluated candidate task backing",
		(f) =>
			put(
				path.join(
					f.storeRoot,
					"objects/sha256",
					f.candidate.content.sha256,
					"tree/SKILL.md",
				),
				"# Corrupted\n",
			),
		/object|digest|integrity|backing/i,
		false,
	],
];
for (const [name, mutate, diagnostic, historical] of liveFaults)
	promotionTest(
		`preview and apply refuse ${name} even with a recorded override, without writes`,
		(t) => {
			const f = fixture(t, { blocked: true });
			writeDecision(f, decision(f));
			mutate(f);
			const configBytes = fs.readFileSync(f.configFile);
			for (const operation of [preview, apply])
				refuses(f, () => operation(f), diagnostic);
			assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
			noWriters(f);
			if (historical)
				assert.deepEqual(
					report(f),
					f.report,
					"routing/live changes do not invalidate retained history",
				);
		},
	);

for (const obstacle of [
	"protected migration namespace store",
	"decision file inside the store",
	"busy store writer",
])
	promotionTest(
		`promotion refuses ${obstacle} without modifying protected state`,
		(t) => {
			const f = fixture(t);
			writeDecision(f, decision(f));
			if (obstacle === "protected migration namespace store") {
				const nested = path.join(f.root, ".agent-profiles/migrations/store");
				fs.cpSync(f.storeRoot, nested, { recursive: true });
				assert.equal(
					verifyStamp({ storeRoot: nested, digest: f.candidate.stampDigest })
						.managedReproducible,
					true,
				);
				for (const operation of [preview, apply])
					refuses(
						f,
						() => operation(f, f.decisionFile, nested),
						/overlap|namespace|migration.*store/i,
					);
			} else if (obstacle === "decision file inside the store") {
				const inside = path.join(f.storeRoot, "incoming", "decision.json");
				writeDecision(f, decision(f), inside);
				for (const operation of [preview, apply])
					refuses(f, () => operation(f, inside), /overlap|inside|store/i);
			} else {
				put(
					path.join(f.storeRoot, ".writer-lock/owner.json"),
					canonicalJSON({ pid: 12345, operation: "fictional-other-writer" }),
				);
				refuses(
					f,
					() => apply(f),
					/store.busy|writer.*(?:busy|exists)|lock.*exists/i,
				);
			}
		},
	);

promotionTest(
	"promotion readback is rootless and survives project, source and decision-file removal",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			result = apply(f),
			retained = readPromotion(f);
		fs.rmSync(f.root, { recursive: true });
		fs.rmSync(f.sources, { recursive: true });
		fs.unlinkSync(f.decisionFile);
		assert.deepEqual(readPromotion(f), retained);
		assert.equal(retained.releaseDigest, e.releaseDigest);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
		const verified = child(f, ["verify", result.stampDigest, "--json"], false);
		assert.equal(verified.error, undefined);
		assert.equal(verified.status, 0, verified.stderr);
		assert.equal(JSON.parse(verified.stdout).managedReproducible, true);
		assert.deepEqual(report(f), f.report);
	},
);

promotionTest(
	"promoted reads revalidate decision and wrapper relations without repair",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d);
		apply(f);
		const decisionObject = path.join(
				f.storeRoot,
				"promotions/decisions/sha256",
				`${e.decisionDigest}.json`,
			),
			original = fs.readFileSync(decisionObject);
		put(decisionObject, Buffer.concat([original, Buffer.from(" ")]));
		let broken = roots(f),
			diagnostic = /decision|record|digest|integrity|canonical/i;
		assert.throws(() => readPromotion(f), diagnostic);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: e.releaseDigest,
				}),
			diagnostic,
		);
		assert.throws(() => resolveInstructions(f.input), diagnostic);
		assert.throws(() => apply(f), diagnostic);
		assert.deepEqual(roots(f), broken);
		put(decisionObject, original);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			e.releaseDigest,
		);
		const parent = readRevisionRecord({
			storeRoot: f.storeRoot,
			recordDigest: f.records.get(versions[0]).recordDigest,
		});
		const forged = { ...e.wrapper, content: parent.content },
			forgedDigest = hashRecord(REVISION_V2, forged),
			forgedFile = path.join(
				f.storeRoot,
				"revisions/sha256",
				`${forgedDigest}.json`,
			);
		const labelFile = path.join(f.storeRoot, labelRelative(release)),
			label = fs.readFileSync(labelFile);
		put(forgedFile, canonicalJSON(forged));
		put(
			labelFile,
			canonicalJSON({ identity: release, recordDigest: forgedDigest }),
		);
		broken = roots(f);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: forgedDigest,
				}),
			/candidate|content|evaluated|mismatch/i,
		);
		assert.throws(
			() => readPromotion(f),
			/label|release|candidate|content|mismatch/i,
		);
		assert.deepEqual(roots(f), broken);
		put(labelFile, label);
		fs.unlinkSync(forgedFile);
		assert.equal(readPromotion(f).releaseDigest, e.releaseDigest);
	},
);

promotionTest(
	"without an exact rule, apply adds one most-specific evaluated-tuple rule and leaves the shared default binding",
	(t) => {
		const f = fixture(t, { exactRule: false }),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			others = models.slice(1).map((model) => selection(f, model));
		const p = preview(f);
		assert.equal(p.target.rule.action, "add");
		assert.deepEqual(p.target.rule.when, scope);
		assert.equal(typeof p.target.rule.id, "string");
		assert.equal(Object.hasOwn(f.config.assignments, p.target.rule.id), false);
		assert.deepEqual({ ...p.target, rule: null }, e.target);
		const result = apply(f);
		assert.deepEqual(result.target, p.target);
		const config = structuredClone(f.config);
		config.assignments[p.target.rule.id] = {
			when: { ...scope },
			bindings: { "skills.reviewer": e.target.after },
		};
		assert.deepEqual(
			parse(fs.readFileSync(f.configFile, "utf8")),
			config,
			"the shared default skills.reviewer binding is not rewritten",
		);
		const primary = selection(f, models[0]);
		assert.equal(primary.package.version, release.version);
		assert.equal(primary.package.selectedBy, p.target.rule.id);
		assert.deepEqual(selection(f, "local-alias").package, primary.package);
		assert.deepEqual(
			models.slice(1).map((model) => selection(f, model)),
			others,
		);
	},
);

promotionTest(
	"concurrent project edit after the store commit refuses honestly, preserves the edit and a replay applies around it",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			indexFile = indexPath(f, d.id);
		const lockBytes = fs.readFileSync(f.lockFile),
			edited = Buffer.concat([
				fs.readFileSync(f.configFile),
				Buffer.from("# concurrent user note\n"),
			]);
		let edits = 0,
			error;
		observeFs(
			t,
			"renameSync",
			(real, from, to, ...args) => {
				if (path.resolve(to) === indexFile && edits === 0) {
					fs.writeFileSync(f.configFile, edited);
					edits++;
					assert.deepEqual(fs.readFileSync(f.configFile), edited);
				}
				return real(from, to, ...args);
			},
			() => {
				try {
					apply(f);
				} catch (caught) {
					error = caught;
				}
			},
		);
		assert.equal(
			edits,
			1,
			"the real user edit happened at the store success commit",
		);
		assert.ok(error, "a project changed after validation must refuse");
		assert.match(error.message, /stale|changed/i);
		assert.match(error.message, /partial|incomplete/i);
		assert.equal(
			fs.existsSync(indexFile),
			true,
			"the committed decision index is reported, not hidden",
		);
		assert.deepEqual(fs.readFileSync(f.configFile), edited);
		assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
		noWriters(f);
		assert.equal(
			selection(f, models[0]).package.version,
			versions[0],
			"binding not applied",
		);
		const replay = apply(f);
		assert.equal(replay.status, "promoted");
		assert.equal(replay.release.releaseDigest, e.releaseDigest);
		assert.ok(
			fs.readFileSync(f.configFile, "utf8").includes("# concurrent user note"),
			"the concurrent user edit is preserved",
		);
		const config = structuredClone(f.config);
		config.assignments["worker-0"].bindings["skills.reviewer"] = e.target.after;
		assert.deepEqual(parse(fs.readFileSync(f.configFile, "utf8")), config);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			e.releaseDigest,
		);
	},
);

promotionTest(
	"caught decision-index EIO leaves no success index or label and no project change",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			indexFile = indexPath(f, d.id);
		const labelFile = path.join(f.storeRoot, labelRelative(release)),
			configBytes = fs.readFileSync(f.configFile),
			lockBytes = fs.readFileSync(f.lockFile),
			before = roots(f);
		const sentinel = Object.assign(
			new Error("promotion decision-index EIO sentinel"),
			{ code: "EIO" },
		);
		let observations = 0,
			error;
		observeFs(
			t,
			"renameSync",
			(real, from, to, ...args) => {
				if (path.resolve(to) !== indexFile) return real(from, to, ...args);
				observations++;
				assert.equal(fs.existsSync(indexFile), false);
				assert.deepEqual(
					fs.readFileSync(from),
					canonicalJSON({
						promotionIndexVersion: 1,
						id: d.id,
						decisionDigest: e.decisionDigest,
						releaseDigest: e.releaseDigest,
					}),
				);
				assert.deepEqual(
					fs.readFileSync(
						path.join(
							f.storeRoot,
							"promotions/decisions/sha256",
							`${e.decisionDigest}.json`,
						),
					),
					canonicalJSON(d),
				);
				assert.deepEqual(
					fs.readFileSync(
						path.join(
							f.storeRoot,
							"revisions/sha256",
							`${e.releaseDigest}.json`,
						),
					),
					canonicalJSON(e.wrapper),
				);
				assert.equal(fs.existsSync(labelFile), false);
				assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
				assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
				throw sentinel;
			},
			() => {
				try {
					apply(f);
				} catch (caught) {
					error = caught;
				}
			},
		);
		assert.equal(observations, 1);
		assert.ok(error);
		assert.match(error.message, /promotion decision-index EIO sentinel/);
		assert.equal(fs.existsSync(indexFile), false);
		assert.equal(fs.existsSync(labelFile), false);
		assert.deepEqual(files(f.root), before[0]);
		assert.deepEqual(files(f.ambient), before[2]);
		priorRetained(before[1], files(f.storeRoot));
		noWriters(f);
		const stages = (rows) =>
			rows.filter(
				(row) => row[0] === ".staging" || row[0].startsWith(".staging/"),
			);
		assert.deepEqual(stages(files(f.storeRoot)), stages(before[1]));
		assert.equal(selection(f, models[0]).package.version, versions[0]);
		assert.equal(
			apply(f).status,
			"promoted",
			"a later replay revalidates and reuses retained immutable backing",
		);
	},
);

promotionTest(
	"decision input edited after its validated read refuses before any success index or label",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			editedBytes = Buffer.from(
				JSON.stringify({ ...d, id: "edited-decision" }),
			);
		const commits = [
				indexPath(f, d.id),
				indexPath(f, "edited-decision"),
				path.join(f.storeRoot, labelRelative(release)),
			],
			before = roots(f);
		let inputFd = null,
			mutations = 0,
			editing = false,
			attempts = 0,
			error;
		observeFs(
			t,
			"openSync",
			(real, target, ...args) => {
				const fd = real(target, ...args);
				if (
					!editing &&
					mutations === 0 &&
					path.resolve(target) === f.decisionFile
				)
					inputFd = fd;
				return fd;
			},
			() =>
				observeFs(
					t,
					"closeSync",
					(real, fd, ...args) => {
						const selected = !editing && mutations === 0 && fd === inputFd,
							closed = real(fd, ...args);
						if (selected) {
							inputFd = null;
							editing = true;
							try {
								fs.writeFileSync(f.decisionFile, editedBytes);
								mutations++;
							} finally {
								editing = false;
							}
						}
						return closed;
					},
					() =>
						observeFs(
							t,
							"renameSync",
							(real, from, to, ...args) => {
								if (commits.includes(path.resolve(to))) attempts++;
								return real(from, to, ...args);
							},
							() => {
								try {
									apply(f);
								} catch (caught) {
									error = caught;
								}
							},
						),
				),
		);
		assert.equal(
			mutations,
			1,
			"mutation follows the original safe-reader close",
		);
		assert.ok(error, "changed decision input must refuse");
		assert.match(error.message, /stale|changed/i);
		assert.equal(attempts, 0);
		for (const target of commits)
			assert.equal(fs.existsSync(target), false, target);
		assert.deepEqual(fs.readFileSync(f.decisionFile), editedBytes);
		assert.deepEqual(files(f.root), before[0]);
		assert.deepEqual(files(f.ambient), before[2]);
		priorRetained(before[1], files(f.storeRoot));
		noWriters(f);
	},
);

promotionTest(
	"public CLI admits preview/promote only, previews read-only, refuses blocked input and reads back through resolve and verify",
	(t) => {
		const f = fixture(t, { blocked: true }),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			ambient = files(f.ambient);
		const blockedFile = path.join(f.dir, "blocked-decision.json");
		put(blockedFile, JSON.stringify({ ...d, correctnessOverride: null }));
		for (const args of [
			["migrate", "promote", f.decisionFile, "--reason", "x"],
			["migrate", "promote"],
			["migrate", "preview", f.decisionFile, "extra"],
		]) {
			const before = roots(f),
				rejected = child(f, args);
			assert.equal(rejected.error, undefined);
			assert.notEqual(rejected.status, 0);
			assert.match(rejected.stderr, /not supported|Usage/i);
			assert.deepEqual(roots(f), before);
		}
		const before = roots(f),
			previewed = child(f, ["migrate", "preview", f.decisionFile, "--json"]);
		assert.equal(
			previewed.error,
			undefined,
			"spawn/setup denial is not business RED",
		);
		assert.equal(previewed.status, 0, previewed.stderr);
		assert.equal(previewed.stderr, "");
		assert.deepEqual(JSON.parse(previewed.stdout), preview(f));
		assert.deepEqual(roots(f), before);
		const text = child(f, ["migrate", "preview", f.decisionFile]);
		assert.equal(text.status, 0, text.stderr);
		assert.ok(text.stdout.includes(d.id));
		assert.match(text.stdout, /preview/i);
		assert.deepEqual(roots(f), before);
		const refused = child(f, ["migrate", "promote", blockedFile, "--json"]);
		assert.equal(refused.error, undefined);
		assert.notEqual(refused.status, 0);
		assert.equal(refused.stdout.trim(), "");
		assert.match(refused.stderr, /per-case|correctness|blocked/i);
		assert.ok(refused.stderr.includes("retain"));
		assert.deepEqual(roots(f), before);
		const promoted = child(f, ["migrate", "promote", f.decisionFile, "--json"]);
		assert.equal(promoted.status, 0, promoted.stderr);
		assert.equal(promoted.stderr, "");
		const result = JSON.parse(promoted.stdout);
		assert.equal(result.status, "promoted");
		assert.equal(result.release.releaseDigest, e.releaseDigest);
		const resolved = child(f, [
			"resolve",
			"--json",
			"--contents",
			"--role",
			"worker",
			"--model",
			"local-alias",
			"--host",
			"claude",
		]);
		assert.equal(resolved.status, 0, resolved.stderr);
		const json = JSON.parse(resolved.stdout);
		assert.deepEqual(
			json.required.find((entry) => entry.id === "reviewer").package,
			{
				binding: "skills.reviewer",
				...release,
				sha256: e.wrapper.content.sha256,
				revisionDigest: e.releaseDigest,
				selectedBy: "worker-0",
				selectors: scope,
			},
		);
		assert.equal(
			json.loaded.find(
				(entry) => entry.kind === "required-skill" && entry.id === "reviewer",
			).content,
			f.after,
		);
		const opus = child(f, [
			"resolve",
			"--json",
			"--role",
			"worker",
			"--model",
			"opus",
			"--host",
			"claude",
		]);
		assert.equal(opus.status, 0, opus.stderr);
		assert.equal(
			JSON.parse(opus.stdout).required.find((entry) => entry.id === "reviewer")
				.package.sha256,
			f.packages.get(versions[1]).sha256,
		);
		const verified = child(f, ["verify", result.stampDigest, "--json"]);
		assert.equal(verified.status, 0, verified.stderr);
		assert.equal(JSON.parse(verified.stdout).managedReproducible, true);
		assert.deepEqual(files(f.ambient), ambient);
	},
);

promotionTest(
	"an orphan decision and wrapper stay unselectable after a different decision publishes the same label",
	(t) => {
		const f = fixture(t),
			dA = writeDecision(f, decision(f)),
			eA = expected(f, dA),
			configBytes = fs.readFileSync(f.configFile),
			lockBytes = fs.readFileSync(f.lockFile);
		const sentinel = Object.assign(
			new Error("orphan decision-index EIO sentinel"),
			{ code: "EIO" },
		);
		let observations = 0,
			error;
		observeFs(
			t,
			"renameSync",
			(real, from, to, ...args) => {
				if (path.resolve(to) !== indexPath(f, dA.id))
					return real(from, to, ...args);
				observations++;
				throw sentinel;
			},
			() => {
				try {
					apply(f);
				} catch (caught) {
					error = caught;
				}
			},
		);
		assert.equal(observations, 1);
		assert.ok(error);
		assert.match(error.message, /orphan decision-index EIO sentinel/);
		const orphanDecision = path.join(
				f.storeRoot,
				"promotions/decisions/sha256",
				`${eA.decisionDigest}.json`,
			),
			orphanWrapper = path.join(
				f.storeRoot,
				"revisions/sha256",
				`${eA.releaseDigest}.json`,
			);
		assert.deepEqual(fs.readFileSync(orphanDecision), canonicalJSON(dA));
		assert.deepEqual(fs.readFileSync(orphanWrapper), canonicalJSON(eA.wrapper));
		assert.equal(fs.existsSync(indexPath(f, dA.id)), false);
		assert.equal(
			fs.existsSync(path.join(f.storeRoot, labelRelative(release))),
			false,
		);
		assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
		assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
		noWriters(f);
		const orphaned = files(f.storeRoot),
			bFile = path.join(f.dir, "decision-b.json");
		const dB = writeDecision(
				f,
				decision(f, { id: "promote-reviewer-b" }),
				bFile,
			),
			eB = expected(f, dB);
		assert.notEqual(eB.releaseDigest, eA.releaseDigest);
		assert.deepEqual(
			eB.wrapper.content,
			eA.wrapper.content,
			"equal physical evaluated bytes",
		);
		const promoted = apply(f, bFile);
		assert.equal(promoted.status, "promoted");
		assert.equal(promoted.release.releaseDigest, eB.releaseDigest);
		assert.deepEqual(
			lookupRevisionManifest({
				storeRoot: f.storeRoot,
				recordDigest: eB.releaseDigest,
			}),
			eB.wrapper,
		);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			eB.releaseDigest,
		);
		assert.deepEqual(readPromotion(f, dB.id), {
			id: dB.id,
			decisionDigest: eB.decisionDigest,
			releaseDigest: eB.releaseDigest,
			decision: dB,
			release: eB.wrapper,
		});
		priorRetained(orphaned, files(f.storeRoot));
		const appliedConfig = fs.readFileSync(f.configFile),
			appliedLock = fs.readFileSync(f.lockFile),
			authority = /label|index|decision|authori|publish|release|mismatch/i;
		let before = roots(f);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: eA.releaseDigest,
				}),
			authority,
		);
		assert.throws(
			() => readPromotion(f, dA.id),
			/ENOENT|missing|index|decision/i,
		);
		assert.deepEqual(roots(f), before);
		const orphanConfig = structuredClone(f.config);
		orphanConfig.assignments["worker-0"].bindings["skills.reviewer"] = {
			package: release.name,
			version: release.version,
			revision: eA.releaseDigest,
		};
		put(f.configFile, stringify(orphanConfig));
		before = roots(f);
		assert.throws(
			() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
			authority,
		);
		assert.deepEqual(roots(f), before);
		assert.deepEqual(fs.readFileSync(f.lockFile), appliedLock);
		noWriters(f);
		put(f.configFile, appliedConfig);
		assert.equal(
			selection(f, models[0]).package.revisionDigest,
			eB.releaseDigest,
		);
		assert.deepEqual(report(f), f.report);
		assert.deepEqual(fs.readFileSync(orphanDecision), canonicalJSON(dA));
		assert.deepEqual(fs.readFileSync(orphanWrapper), canonicalJSON(eA.wrapper));
	},
);

promotionTest(
	"label-rename EIO after the decision index commit is an honest partial that reads never repair and replay completes",
	(t) => {
		const f = fixture(t),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			indexFile = indexPath(f, d.id),
			labelFile = path.join(f.storeRoot, labelRelative(release));
		const decisionObject = path.join(
				f.storeRoot,
				"promotions/decisions/sha256",
				`${e.decisionDigest}.json`,
			),
			wrapperFile = path.join(
				f.storeRoot,
				"revisions/sha256",
				`${e.releaseDigest}.json`,
			);
		const configBytes = fs.readFileSync(f.configFile),
			lockBytes = fs.readFileSync(f.lockFile),
			before = roots(f);
		const indexBytes = canonicalJSON({
			promotionIndexVersion: 1,
			id: d.id,
			decisionDigest: e.decisionDigest,
			releaseDigest: e.releaseDigest,
		});
		const sentinel = Object.assign(new Error("promotion label EIO sentinel"), {
			code: "EIO",
		});
		let observations = 0,
			error;
		observeFs(
			t,
			"renameSync",
			(real, from, to, ...args) => {
				if (path.resolve(to) !== labelFile) return real(from, to, ...args);
				observations++;
				assert.equal(fs.existsSync(labelFile), false);
				assert.deepEqual(
					fs.readFileSync(from),
					canonicalJSON({ identity: release, recordDigest: e.releaseDigest }),
				);
				assert.deepEqual(
					fs.readFileSync(indexFile),
					indexBytes,
					"the decision index already committed",
				);
				assert.deepEqual(fs.readFileSync(decisionObject), canonicalJSON(d));
				assert.deepEqual(
					fs.readFileSync(wrapperFile),
					canonicalJSON(e.wrapper),
				);
				assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
				assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
				throw sentinel;
			},
			() => {
				try {
					apply(f);
				} catch (caught) {
					error = caught;
				}
			},
		);
		assert.equal(observations, 1);
		assert.ok(error);
		assert.match(error.message, /promotion label EIO sentinel/);
		assert.match(error.message, /partial|incomplete/i);
		assert.equal(fs.existsSync(labelFile), false);
		assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
		assert.deepEqual(fs.readFileSync(f.lockFile), lockBytes);
		assert.deepEqual(fs.readFileSync(indexFile), indexBytes);
		assert.deepEqual(fs.readFileSync(decisionObject), canonicalJSON(d));
		assert.deepEqual(fs.readFileSync(wrapperFile), canonicalJSON(e.wrapper));
		assert.deepEqual(files(f.root), before[0]);
		assert.deepEqual(files(f.ambient), before[2]);
		priorRetained(before[1], files(f.storeRoot));
		noWriters(f);
		const stages = (rows) =>
			rows.filter(
				(row) => row[0] === ".staging" || row[0].startsWith(".staging/"),
			);
		assert.deepEqual(stages(files(f.storeRoot)), stages(before[1]));
		const partial = roots(f);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: e.releaseDigest,
				}),
			/label|publish|incomplete|partial|missing/i,
		);
		assert.throws(
			() => readPromotion(f),
			/label|publish|incomplete|partial|missing/i,
		);
		assert.equal(selection(f, models[0]).package.version, versions[0]);
		assert.deepEqual(
			roots(f),
			partial,
			"reads never repair a partial promotion",
		);
		const replay = apply(f);
		assert.equal(replay.status, "promoted");
		assert.equal(replay.release.releaseDigest, e.releaseDigest);
		priorRetained(partial[1], files(f.storeRoot));
		assert.deepEqual(
			fs.readFileSync(labelFile),
			canonicalJSON({ identity: release, recordDigest: e.releaseDigest }),
		);
		const primary = selection(f, models[0]);
		assert.equal(primary.package.revisionDigest, e.releaseDigest);
		assert.deepEqual(
			primary.loaded.map(([kind, id, content]) => [
				kind,
				id,
				Buffer.from(content).toString("hex"),
			]),
			composition(f, f.candidate.stampDigest),
		);
		assert.deepEqual(readPromotion(f), {
			id: d.id,
			decisionDigest: e.decisionDigest,
			releaseDigest: e.releaseDigest,
			decision: d,
			release: e.wrapper,
		});
		noWriters(f);
	},
);

promotionTest(
	"promotion freshness: completed replay refuses after the evaluated local role bytes change despite a recorded override",
	(t) => {
		const f = fixture(t, { blocked: true });
		writeDecision(f, decision(f));
		assert.equal(apply(f).status, "promoted");
		const role = path.join(f.root, ".agent-profiles/roles/worker.md"),
			edited = Buffer.from("# Worker\r\nAlso review the release notes.\r\n");
		put(role, edited);
		const before = roots(f),
			attempt = (operation) => {
				try {
					return { result: operation(f) };
				} catch (error) {
					return { error };
				}
			};
		const previewed = attempt(preview),
			replayed = attempt(apply);
		assert.deepEqual(
			roots(f),
			before,
			"no replacement stamp, repair or project/store/ambient mutation after the user edit",
		);
		for (const [name, outcome] of [
			["preview", previewed],
			["apply", replayed],
		]) {
			assert.equal(
				outcome.result,
				undefined,
				`${name} must refuse, not return ${outcome.result?.status}`,
			);
			assert.match(outcome.error.message, /stale|changed|fresh|evaluat/i);
		}
		assert.deepEqual(fs.readFileSync(role), edited);
		assert.deepEqual(
			report(f),
			f.report,
			"readable history is not active freshness",
		);
	},
);

promotionTest(
	"promotion freshness: an evaluated role edit before project application leaves the target config and lock untouched",
	(t) => {
		const f = fixture(t, { blocked: true }),
			d = writeDecision(f, decision(f)),
			e = expected(f, d),
			indexFile = indexPath(f, d.id);
		const role = path.join(f.root, ".agent-profiles/roles/worker.md"),
			originalRole = fs.readFileSync(role),
			edited = Buffer.from("# Worker\r\nAlso review the release notes.\r\n");
		const configBytes = fs.readFileSync(f.configFile),
			lockBytes = fs.readFileSync(f.lockFile),
			ambient = files(f.ambient);
		const others = models.slice(1).map((model) => selection(f, model).package);
		let edits = 0,
			result,
			error;
		observeFs(
			t,
			"renameSync",
			(real, from, to, ...args) => {
				if (path.resolve(to) === indexFile && edits === 0) {
					fs.writeFileSync(role, edited);
					edits++;
				}
				return real(from, to, ...args);
			},
			() => {
				try {
					result = apply(f);
				} catch (caught) {
					error = caught;
				}
			},
		);
		assert.equal(
			edits,
			1,
			"the real role edit happened at the decision-index commit",
		);
		assert.equal(
			result,
			undefined,
			"unevaluated managed input must not be promoted",
		);
		assert.ok(error);
		assert.match(error.message, /stale|changed|fresh|evaluat/i);
		assert.deepEqual(fs.readFileSync(role), edited);
		assert.deepEqual(
			fs.readFileSync(f.configFile),
			configBytes,
			"target config unchanged",
		);
		assert.deepEqual(
			fs.readFileSync(f.lockFile),
			lockBytes,
			"target lock unchanged",
		);
		noWriters(f);
		assert.equal(
			selection(f, models[0]).package.version,
			versions[0],
			"the evaluated consumer still selects its original release",
		);
		assert.deepEqual(
			models.slice(1).map((model) => selection(f, model).package),
			others,
		);
		assert.deepEqual(report(f), f.report);
		assert.deepEqual(files(f.ambient), ambient);
		put(role, originalRole);
		const replay = apply(f);
		assert.equal(replay.status, "promoted");
		assert.equal(replay.release.releaseDigest, e.releaseDigest);
		const primary = selection(f, models[0]);
		assert.equal(primary.package.revisionDigest, e.releaseDigest);
		assert.deepEqual(
			primary.loaded.map(([kind, id, content]) => [
				kind,
				id,
				Buffer.from(content).toString("hex"),
			]),
			composition(f, f.candidate.stampDigest),
		);
	},
);

const profiledRule = (model) => ({ ...tuple(model), profile: "base" });
const attemptPromotion = (f, operation) => {
	try {
		return { result: operation(f) };
	} catch (error) {
		return { error };
	}
};
// Shared post-apply oracle: the previewed rule is what ordinary resolution selects, with exact evaluated bytes and unchanged collateral.
function profilePromotionVerified(
	f,
	d,
	previewed,
	applied,
	others,
	lockBefore,
) {
	const e = expected(f, d);
	assert.equal(
		applied.error,
		undefined,
		`apply must fully succeed, not partially: ${applied.error?.message}`,
	);
	assert.equal(applied.result.status, "promoted");
	assert.deepEqual(applied.result.target, previewed.target);
	assert.deepEqual(applied.result.release, {
		identity: release,
		content: e.wrapper.content,
		releaseDigest: e.releaseDigest,
	});
	assert.deepEqual(previewed.target.after, {
		package: release.name,
		version: release.version,
		revision: e.releaseDigest,
	});
	const primary = selection(f, models[0]);
	assert.deepEqual(
		primary.package,
		{
			binding: "skills.reviewer",
			...release,
			sha256: e.wrapper.content.sha256,
			revisionDigest: e.releaseDigest,
			selectedBy: previewed.target.rule.id,
			selectors: previewed.target.rule.when,
		},
		"the previewed rule is the one ordinary resolution selects",
	);
	assert.equal(primary.status, "declared-compatible");
	assert.deepEqual(
		primary.loaded.map(([kind, id, content]) => [
			kind,
			id,
			Buffer.from(content).toString("hex"),
		]),
		composition(f, f.candidate.stampDigest),
	);
	assert.deepEqual(
		models.slice(1).map((model) => selection(f, model)),
		others,
		"collateral consumers keep their exact releases",
	);
	const lock = JSON.parse(fs.readFileSync(f.lockFile, "utf8"));
	assert.deepEqual(fs.readFileSync(f.lockFile), canonicalJSON(lock));
	assert.ok(
		lock.pins.some(
			(pin) =>
				pin.binding === "skills.reviewer" &&
				pin.rule === previewed.target.rule.id &&
				pin.version === release.version &&
				pin.sha256 === e.wrapper.content.sha256 &&
				pin.revisionDigest === e.releaseDigest,
		),
	);
	for (const pin of lockBefore.pins)
		if (pin.rule !== previewed.target.rule.id)
			assert.ok(
				lock.pins.some((row) => equalRow(row, pin)),
				`unrelated pin ${pin.binding}/${pin.rule} preserved`,
			);
	installDependencies({ root: f.root, storeRoot: f.storeRoot, frozen: true });
	assert.equal(createStamp(f.input).digest, applied.result.stampDigest);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: applied.result.stampDigest })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		composition(f, applied.result.stampDigest),
		composition(f, f.candidate.stampDigest),
	);
	assert.deepEqual(readPromotion(f), {
		id: d.id,
		decisionDigest: e.decisionDigest,
		releaseDigest: e.releaseDigest,
		decision: d,
		release: e.wrapper,
	});
	assert.deepEqual(
		report(f),
		f.report,
		"historical regression evidence is unchanged",
	);
	const settled = roots(f),
		replay = attemptPromotion(f, apply);
	assert.equal(
		replay.error,
		undefined,
		`completed replay must be reused: ${replay.error?.message}`,
	);
	assert.equal(replay.result.status, "reused");
	assert.equal(replay.result.stampDigest, applied.result.stampDigest);
	assert.deepEqual(roots(f), settled, "completed replay writes nothing");
}
const equalRow = (a, b) => canonicalJSON(a).equals(canonicalJSON(b));

promotionTest(
	"promotion profile: a selected profile-qualified exact rule is replaced in place and replays unchanged",
	(t) => {
		const f = fixture(t, { blocked: true, ruleWhen: profiledRule }),
			d = writeDecision(f, decision(f));
		const start = selection(f, models[0]);
		assert.equal(start.package.selectedBy, "worker-0");
		assert.deepEqual(start.package.selectors, profiledRule(models[0]));
		assert.equal(
			start.package.revisionDigest,
			f.records.get(versions[0]).recordDigest,
		);
		assert.equal(start.status, "declared-compatible");
		assert.equal(f.report.eligibility.status, "blocked");
		assert.ok(d.correctnessOverride, "real recorded correctness-only override");
		const others = models.slice(1).map((model) => selection(f, model)),
			lockBefore = JSON.parse(fs.readFileSync(f.lockFile, "utf8")),
			before = roots(f);
		const previewed = attemptPromotion(f, preview),
			afterPreview = roots(f),
			applied = attemptPromotion(f, apply);
		assert.equal(
			previewed.error,
			undefined,
			`preview: ${previewed.error?.message}`,
		);
		assert.deepEqual(afterPreview, before, "preview is read-only");
		assert.deepEqual(previewed.result.target.rule, {
			id: "worker-0",
			when: profiledRule(models[0]),
			action: "replace",
		});
		assert.deepEqual(
			previewed.result.target.before,
			f.config.assignments["worker-0"].bindings["skills.reviewer"],
		);
		const config = structuredClone(f.config);
		config.assignments["worker-0"].bindings["skills.reviewer"] =
			previewed.result.target.after;
		profilePromotionVerified(
			f,
			d,
			previewed.result,
			applied,
			others,
			lockBefore,
		);
		assert.deepEqual(
			parse(fs.readFileSync(f.configFile, "utf8")),
			config,
			"worker-0 keeps its four-key when/id; only the evaluated binding changes",
		);
	},
);

promotionTest(
	"promotion profile: a broader profile-qualified rule gains one more-specific evaluated-tuple rule that actually wins",
	(t) => {
		const broader = (model) => ({ role: "worker", model, profile: "base" });
		const f = fixture(t, { blocked: true, ruleWhen: broader }),
			d = writeDecision(f, decision(f));
		const start = selection(f, models[0]);
		assert.equal(start.package.selectedBy, "worker-0");
		assert.deepEqual(start.package.selectors, broader(models[0]));
		assert.equal(
			start.package.revisionDigest,
			f.records.get(versions[0]).recordDigest,
		);
		assert.equal(start.status, "declared-compatible");
		assert.equal(f.report.eligibility.status, "blocked");
		assert.ok(d.correctnessOverride, "real recorded correctness-only override");
		const others = models.slice(1).map((model) => selection(f, model)),
			lockBefore = JSON.parse(fs.readFileSync(f.lockFile, "utf8")),
			before = roots(f);
		const previewed = attemptPromotion(f, preview),
			repeated = attemptPromotion(f, preview),
			afterPreview = roots(f),
			applied = attemptPromotion(f, apply);
		assert.equal(
			previewed.error,
			undefined,
			`preview: ${previewed.error?.message}`,
		);
		assert.deepEqual(afterPreview, before, "preview is read-only");
		assert.deepEqual(repeated.result, previewed.result, "deterministic target");
		const rule = previewed.result.target.rule;
		assert.equal(rule.action, "add");
		assert.equal(
			Object.hasOwn(f.config.assignments, rule.id),
			false,
			"fresh rule id",
		);
		assert.deepEqual(
			rule.when,
			{ ...tuple(models[0]), profile: "base" },
			"pins the exact evaluated tuple and keeps the applicable profile qualifier",
		);
		assert.deepEqual(
			previewed.result.target.before,
			f.config.assignments["worker-0"].bindings["skills.reviewer"],
		);
		const config = structuredClone(f.config);
		config.assignments[rule.id] = {
			when: rule.when,
			bindings: { "skills.reviewer": previewed.result.target.after },
		};
		profilePromotionVerified(
			f,
			d,
			previewed.result,
			applied,
			others,
			lockBefore,
		);
		assert.deepEqual(
			parse(fs.readFileSync(f.configFile, "utf8")),
			config,
			"broader worker-0 and shared defaults stay exact",
		);
	},
);
