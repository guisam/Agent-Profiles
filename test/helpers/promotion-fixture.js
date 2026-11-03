// Shared promotion fixture (moved verbatim from migration-promotion-contract.test.js
// so the library evidence tests can build the same real candidate, plan and result chain).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import * as migrations from "../../src/migrations.ts";
import { installDependencies } from "../../src/package-lock.ts";
import { importPackage } from "../../src/package-store.ts";
import { readPackage } from "../../src/packages.ts";
import { retainRevisionManifest } from "../../src/revisions.ts";
import { createStamp } from "../../src/stamps.ts";

const originalStore = process.env.AGENT_PROFILES_STORE;

export const versions = ["1.2.3", "1.4.5", "2.3.4"],
	models = ["local-llm", "opus", "slim-llm"];
export const protocol = "@example/checkin",
	release = { name: "@example/reviewer", version: "3.0.0" };
export const tuple = (model) => ({ role: "worker", model, host: "claude" });
export const scope = tuple(models[0]);

export const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
export function files(root) {
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
export function fixture(
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
	const after = `${pkg.entry}Check stale evidence before reporting.\r\n`,
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
export function decision(f, changes = {}) {
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
export const writeDecision = (f, value, file = f.decisionFile) => {
	put(file, JSON.stringify(value));
	return value;
};
