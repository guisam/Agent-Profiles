import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import * as migrations from "../src/migrations.js";
import { installDependencies } from "../src/package-lock.js";
import { importPackage, lookupPackage } from "../src/package-store.ts";
import { canonicalJSON, readPackage } from "../src/packages.ts";
import { resolveInstructions } from "../src/resolve.ts";
import {
	lookupRevisionManifest,
	readRevisionRecord,
	retainRevisionManifest,
} from "../src/revisions.js";
import { createStamp, reconstructStamp, verifyStamp } from "../src/stamps.js";

const exportsNeeded = ["publishMigrationCandidate", "migrationCandidate"];
const ready = exportsNeeded.every(
	(name) => typeof migrations[name] === "function",
);
const candidateTest = (name, body) =>
	test(
		name,
		{
			skip: ready
				? false
				: "candidate publication/readback exports absent; downstream body UNEXECUTED",
		},
		body,
	);
const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const originalStore = process.env.AGENT_PROFILES_STORE;
const versions = ["1.2.3", "1.4.5", "2.3.4"],
	models = ["local-llm", "opus", "slim-llm"];
const protocol = "@example/checkin";
const tuple = (model) => ({ role: "worker", model, host: "claude" });
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
function files(root) {
	const result = [];
	function visit(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name,
				stat = fs.lstatSync(path.join(root, member));
			if (stat.isSymbolicLink())
				result.push([member, "link", fs.readlinkSync(path.join(root, member))]);
			else if (stat.isDirectory()) {
				result.push([member, "directory"]);
				visit(member);
			} else
				result.push([
					member,
					stat.nlink,
					fs.readFileSync(path.join(root, member)).toString("hex"),
				]);
		}
	}
	visit();
	return result;
}
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-candidate-")),
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
	fs.mkdirSync(ambient);
	fs.mkdirSync(home);
	put(path.join(ambient, "marker.txt"), "Unrelated store\r\n");
	process.env.AGENT_PROFILES_STORE = ambient;
	const packages = new Map();
	function add(key, name, version) {
		const directory = path.join(sources, key),
			entry = `---\r\nname: ${name.split("/")[1]}\r\ndescription: Fictional ${key}\r\n---\r\n# ${key} café  \r\n`;
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
		const imported = importPackage({ sourceDirectory: directory, storeRoot });
		packages.set(key, { ...imported, entry, workflow, directory });
	}
	for (const version of versions) add(version, "@example/reviewer", version);
	add("helper", "@example/helper", "1.0.0");
	const config = {
		version: 2,
		default_profile: "base",
		default_role: "worker",
		models: Object.fromEntries(
			models.map((model) => [model, { profile: "base" }]),
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
			models.map((model, i) => [
				`worker-${i}`,
				{ when: tuple(model), versions: { "skills.reviewer": versions[i] } },
			]),
		),
	};
	const configFile = path.join(root, ".agent-profiles/agents.yaml"),
		lockFile = path.join(root, ".agent-profiles/agent-profiles.lock");
	put(configFile, stringify(config));
	put(path.join(root, ".agent-profiles/profiles/base.md"), "\uFEFF# Base\r\n");
	put(path.join(root, ".agent-profiles/roles/worker.md"), "# Worker\r\n");
	put(
		path.join(root, "instructions/note.md"),
		"---\ndescription: Optional note\n---\nNot injected.\n",
	);
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	installDependencies({ root, storeRoot });
	const input = { root, storeRoot, ...tuple(models[0]) };
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
	// Explicit test setup conversion; the original workspace/base record is never rebased.
	config.version = 3;
	config.skills.reviewer.revision = records.get(versions[0]).recordDigest;
	config.assignments = Object.fromEntries(
		models.map((model, i) => [
			`worker-${i}`,
			{
				when: tuple(model),
				bindings: {
					"skills.reviewer": {
						package: "@example/reviewer",
						version: versions[i],
						revision: records.get(versions[i]).recordDigest,
					},
				},
			},
		]),
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
	const target = `packages/${pkg.sha256}/SKILL.md`,
		after = `${pkg.entry}Check stale evidence before reporting.\r\n`;
	const proposal = {
		proposalVersion: 1,
		classification: "package",
		target: { path: target },
		change: { before: pkg.entry, after },
		evidence: [
			{
				sessionId: "caller-claimed-fixture-session",
				excerpt: "A stale-evidence check was missed.",
				baseStamp: migration.bases[0].stamp,
			},
		],
		draftCase: {
			input: "Fictional stale result",
			expected: "Refuse stale evidence",
		},
	};
	const proposalFile = path.join(dir, "proposal.json");
	put(proposalFile, JSON.stringify(proposal));
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
		expectedTreeSha256 = readPackage({ root: tree }).sha256;
	const manifest = {
		candidateVersion: 1,
		id: "candidate-reviewer",
		binding: "skills.reviewer",
		release: { name: "@example/reviewer", version: "3.0.0" },
		migrationBase: migration.bases[0].stamp,
		evaluationBase: base.digest,
		configSha256: JSON.parse(fs.readFileSync(lockFile, "utf8")).configSha256,
		expectedTreeSha256,
		proposalIds: [accepted.id],
		workflowChange: {
			kind: "task-only",
			reason: "Retain an accepted task-only check; workflow is unchanged.",
		},
	};
	const manifestFile = path.join(dir, "candidate.json");
	put(manifestFile, JSON.stringify(manifest));
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
		input,
		migration,
		base,
		workspace,
		tree,
		target,
		after,
		accepted,
		manifest,
		manifestFile,
	};
}
const publication = (f) =>
	migrations.publishMigrationCandidate({
		root: f.root,
		storeRoot: f.storeRoot,
		id: f.migration.id,
		manifestFile: f.manifestFile,
	});
const readCandidate = (f, id = f.manifest.id) =>
	migrations.migrationCandidate({ storeRoot: f.storeRoot, id });
const roots = (f) => [f.root, f.storeRoot, f.ambient].map(files);
const indexPath = (f) =>
	path.join(f.storeRoot, "candidates/ids", `${f.manifest.id}.json`);
function assertNoPublication(f, operation, diagnostic) {
	const before = roots(f);
	assert.throws(operation, diagnostic);
	assert.deepEqual(files(f.root), before[0]);
	assert.deepEqual(files(f.ambient), before[2]);
	assert.equal(
		fs.existsSync(indexPath(f)),
		false,
		"no durable candidate index",
	);
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
		false,
	);
	assert.equal(fs.existsSync(path.join(f.storeRoot, ".writer-lock")), false);
}
function selections(f) {
	return models.map((model) =>
		resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			...tuple(model),
		}),
	);
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

test("candidate fixture keeps a real config2 workspace and stamp1 after explicit config3 preparation", (t) => {
	const f = fixture(t),
		original = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: f.migration.bases[0].stamp,
		});
	assert.equal(f.migration.recordVersion, 1);
	assert.equal(f.migration.sharing, "fork");
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: f.migration.bases[0].stamp })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		original.composition[2].bytes,
		Buffer.from(f.packages.get(versions[0]).entry),
	);
	assert.equal(
		migrations.migrationStatus({ root: f.root, id: f.migration.id }).state,
		"open",
	);
	assert.equal(f.accepted.status, "accepted");
	assert.deepEqual(
		fs.readFileSync(path.join(f.workspace, f.target)),
		Buffer.from(f.after),
	);
	assert.notEqual(
		f.manifest.expectedTreeSha256,
		f.packages.get(versions[0]).sha256,
	);
	assert.deepEqual(
		fs.readFileSync(path.join(f.tree, "package.yaml")),
		fs.readFileSync(
			path.join(f.packages.get(versions[0]).directory, "package.yaml"),
		),
	);
	assert.throws(
		() => migrations.startMigration({ ...f.input, sharing: "fork" }),
		{
			message: `open migration ${f.migration.id} already targets an assignment in this scope`,
		},
	);
});

test("candidate fixture has three independent published selections and real compatible stamp2 backing", (t) => {
	const f = fixture(t),
		before = roots(f);
	for (const [i, result] of selections(f).entries()) {
		assert.equal(result.required[0].package.version, versions[i]);
		assert.equal(
			result.required[0].package.sha256,
			f.packages.get(versions[i]).sha256,
		);
		assert.equal(result.workflow.status, "declared-compatible");
		assert.equal(result.workflow.runtime, "unverified");
		assert.equal(
			result.workflow.peers[0].provider.revisionDigest,
			f.records.get("helper").recordDigest,
		);
		assert.equal(
			result.loaded.filter((part) => part.kind === "workflow").length,
			2,
		);
	}
	assert.equal(f.base.snapshot.stampVersion, 2);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		readPackage({ root: f.tree }).sha256,
		f.manifest.expectedTreeSha256,
	);
	assert.equal(
		lookupPackage({ storeRoot: f.storeRoot, ...f.manifest.release }),
		null,
	);
	assert.deepEqual(
		roots(f),
		before,
		"fixture validators and selection are read-only",
	);
});

test("migration candidate publication and verified readback APIs exist", () => {
	assert.deepEqual(
		exportsNeeded.filter((name) => typeof migrations[name] !== "function"),
		[],
		"src/migrations.js must provide the candidate publication/readback seam",
	);
});

candidateTest(
	"publication retains candidate task workflow dependency and accepted evidence without activation",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			ambient = files(f.ambient),
			active = selections(f);
		const result = publication(f),
			retained = readCandidate(f);
		assert.equal(result.status, "published");
		assert.equal(result.id, f.manifest.id);
		assert.equal(result.migrationId, f.migration.id);
		assert.deepEqual(result.release, f.manifest.release);
		assert.deepEqual(result.content, {
			identity: f.packages.get(versions[0]).identity,
			sha256: f.manifest.expectedTreeSha256,
		});
		const { status, ...index } = result;
		assert.equal(status, "published");
		assert.deepEqual(retained, index);
		const revision = readRevisionRecord({
			storeRoot: f.storeRoot,
			recordDigest: result.revisionDigest,
		});
		assert.equal(revision.revisionVersion, 2);
		assert.equal(revision.kind, "candidate");
		assert.deepEqual(revision.identity, f.manifest.release);
		assert.deepEqual(revision.content, result.content);
		assert.equal(revision.parent, f.records.get(versions[0]).recordDigest);
		assert.deepEqual(revision.provenance.proposals, [f.accepted]);
		assert.equal(revision.provenance.migrationBase, f.manifest.migrationBase);
		assert.equal(revision.provenance.evaluationBase, f.base.digest);
		assert.deepEqual(
			revision.dependencies,
			readRevisionRecord({
				storeRoot: f.storeRoot,
				recordDigest: f.records.get(versions[0]).recordDigest,
			}).dependencies,
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
			kind: "candidate",
			migration: f.migration.id,
			candidate: result.revisionDigest,
		});
		assert.equal(
			snapshot.workflowPeers[0].consumer.revisionDigest,
			result.revisionDigest,
		);
		assert.equal(
			snapshot.workflowPeers[0].provider.revisionDigest,
			f.records.get("helper").recordDigest,
		);
		assert.equal(snapshot.coverage.runtimeModel, "unverified");
		const rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: result.stampDigest,
		});
		assert.deepEqual(
			rebuilt.composition.find(
				(part) =>
					part.package?.revisionDigest === result.revisionDigest &&
					part.kind !== "workflow",
			).bytes,
			Buffer.from(f.after),
		);
		assert.deepEqual(
			rebuilt.composition.find(
				(part) =>
					part.package?.revisionDigest === result.revisionDigest &&
					part.kind === "workflow",
			).bytes,
			Buffer.from(f.packages.get(versions[0]).workflow),
		);
		assert.ok(
			rebuilt.packages.some(
				(pkg) => pkg.sha256 === f.packages.get("helper").sha256,
			),
		);
		assert.deepEqual(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
		assert.deepEqual(selections(f), active);
		assert.deepEqual(files(f.root), project);
		assert.deepEqual(files(f.ambient), ambient);
	},
);

candidateTest(
	"candidate reconstruction survives mutable workspace source and project removal",
	(t) => {
		const f = fixture(t),
			result = publication(f),
			retained = readCandidate(f);
		const original = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: result.stampDigest,
		});
		put(path.join(f.tree, "SKILL.md"), "# Later workspace edits\n");
		assert.deepEqual(readCandidate(f), retained);
		fs.rmSync(f.root, { recursive: true });
		fs.rmSync(f.sources, { recursive: true });
		fs.unlinkSync(f.manifestFile);
		assert.deepEqual(readCandidate(f), retained);
		assert.deepEqual(
			reconstructStamp({ storeRoot: f.storeRoot, digest: result.stampDigest }),
			original,
		);
	},
);

candidateTest(
	"candidate id replays identical publication but never repoints after an edit",
	(t) => {
		const f = fixture(t),
			first = publication(f),
			before = roots(f);
		assert.deepEqual(publication(f), { ...first, status: "reused" });
		assert.deepEqual(roots(f), before);
		const index = fs.readFileSync(indexPath(f));
		put(path.join(f.tree, "SKILL.md"), `${f.after}Different candidate bytes\n`);
		f.manifest.expectedTreeSha256 = readPackage({ root: f.tree }).sha256;
		put(f.manifestFile, JSON.stringify(f.manifest));
		const changed = roots(f);
		assert.throws(
			() => publication(f),
			/candidate.*(?:immutable|conflict|already|repoint)|stale/i,
		);
		assert.deepEqual(fs.readFileSync(indexPath(f)), index);
		assert.deepEqual(roots(f), changed);
		assert.equal(readCandidate(f).stampDigest, first.stampDigest);
	},
);

candidateTest(
	"candidate metadata tampering refuses verified readback and stamp reconstruction",
	(t) => {
		const f = fixture(t),
			result = publication(f),
			target = path.join(
				f.storeRoot,
				"revisions/sha256",
				`${result.revisionDigest}.json`,
			);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
		const original = fs.readFileSync(target);
		put(target, Buffer.concat([original, Buffer.from(" ")]));
		const before = roots(f);
		assert.throws(() => readCandidate(f), /revision|record|integrity|digest/i);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			false,
		);
		assert.throws(
			() =>
				reconstructStamp({
					storeRoot: f.storeRoot,
					digest: result.stampDigest,
				}),
			/revision|record|integrity|digest/i,
		);
		assert.deepEqual(roots(f), before);
		put(target, original);
		assert.equal(readCandidate(f).stampDigest, result.stampDigest);
	},
);

candidateTest(
	"candidate retained task tampering refuses without changing metadata or repairing bytes",
	(t) => {
		const f = fixture(t),
			result = publication(f),
			target = path.join(
				f.storeRoot,
				"objects/sha256",
				result.content.sha256,
				"tree/SKILL.md",
			);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
		const original = fs.readFileSync(target);
		put(target, "# Corrupted retained candidate task\n");
		const before = roots(f);
		assert.throws(() => readCandidate(f), /object|digest|backing|integrity/i);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			false,
		);
		assert.throws(
			() =>
				reconstructStamp({
					storeRoot: f.storeRoot,
					digest: result.stampDigest,
				}),
			/object|digest|backing|integrity/i,
		);
		assert.deepEqual(roots(f), before);
		put(target, original);
		assert.equal(readCandidate(f).stampDigest, result.stampDigest);
	},
);

candidateTest(
	"task-only candidate refuses a changed companion even with a fresh expected tree digest",
	(t) => {
		const f = fixture(t);
		put(
			path.join(f.tree, "WORKFLOW.md"),
			f.packages.get(versions[0]).workflow +
				"Different workflow obligation\r\n",
		);
		f.manifest.expectedTreeSha256 = readPackage({ root: f.tree }).sha256;
		put(f.manifestFile, JSON.stringify(f.manifest));
		assertNoPublication(
			f,
			() => publication(f),
			/task.only|workflow.*(?:changed|unchanged|proposal)|unapproved|outside.*(?:target|scope)/i,
		);
	},
);

for (const member of ["WORKFLOW.md", "SKILL.md"])
	candidateTest(
		`candidate publication refuses missing declared helper ${member} backing`,
		(t) => {
			const f = fixture(t),
				helper = f.packages.get("helper"),
				target = path.join(
					f.storeRoot,
					"objects/sha256",
					helper.sha256,
					"tree",
					member,
				);
			assert.equal(
				verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
					.managedReproducible,
				true,
			);
			fs.unlinkSync(target);
			assertNoPublication(
				f,
				() => publication(f),
				/base|backing|closure|missing|digest|object/i,
			);
		},
	);

for (const fault of ["foreign", "missing"])
	candidateTest(
		`candidate publication refuses ${fault} dependency metadata backing`,
		(t) => {
			const f = fixture(t),
				target = path.join(
					f.storeRoot,
					"revisions/sha256",
					`${f.records.get("helper").recordDigest}.json`,
				);
			if (fault === "foreign") {
				const wrong = readRevisionRecord({
					storeRoot: f.storeRoot,
					recordDigest: f.records.get(versions[1]).recordDigest,
				});
				put(target, canonicalJSON(wrong));
			} else fs.unlinkSync(target);
			assertNoPublication(
				f,
				() => publication(f),
				/revision|record|integrity|digest|ENOENT|missing/i,
			);
		},
	);

candidateTest(
	"reserved candidate and planned release stay out of legacy and ordinary revision selection",
	(t) => {
		const f = fixture(t),
			active = selections(f),
			result = publication(f);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...f.manifest.release }),
			null,
		);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...result.content.identity })
				.sha256,
			f.packages.get(versions[0]).sha256,
		);
		assert.throws(
			() =>
				lookupRevisionManifest({
					storeRoot: f.storeRoot,
					recordDigest: result.revisionDigest,
				}),
			/candidate|unpublished|not.*release|not.*selectable/i,
		);
		const reservedSource = path.join(f.dir, "reserved-legacy-import");
		fs.cpSync(f.tree, reservedSource, { recursive: true });
		put(
			path.join(reservedSource, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { ...f.manifest.release, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		assert.equal(
			readPackage({ root: reservedSource }).manifest.package.version,
			f.manifest.release.version,
		);
		assert.notEqual(
			readPackage({ root: reservedSource }).sha256,
			result.content.sha256,
			"rewriting manifest version changes the full tree",
		);
		const project = files(f.root),
			ambient = files(f.ambient),
			index = fs.readFileSync(indexPath(f));
		assert.throws(
			() =>
				importPackage({
					sourceDirectory: reservedSource,
					storeRoot: f.storeRoot,
				}),
			/candidate|reserved|unpublished/i,
		);
		assert.deepEqual(files(f.root), project);
		assert.deepEqual(files(f.ambient), ambient);
		assert.deepEqual(fs.readFileSync(indexPath(f)), index);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...f.manifest.release }),
			null,
		);
		const replacement = structuredClone(f.config);
		replacement.assignments["worker-0"].bindings["skills.reviewer"] = {
			package: f.manifest.release.name,
			version: f.manifest.release.version,
			revision: result.revisionDigest,
		};
		put(f.configFile, stringify(replacement));
		const before = roots(f);
		assert.throws(
			() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
			/candidate|unpublished|not.*release|not.*selectable/i,
		);
		assert.deepEqual(roots(f), before);
		put(f.configFile, stringify(f.config));
		assert.deepEqual(selections(f), active);
	},
);

for (const fault of [
	"foreign base",
	"missing base",
	"stale evaluation base",
	"stale workspace",
])
	candidateTest(
		`candidate publication refuses ${fault} before durable index publication`,
		(t) => {
			const f = fixture(t);
			if (fault === "foreign base")
				f.manifest.evaluationBase = createStamp({
					...f.input,
					model: models[1],
				}).digest;
			else if (fault === "missing base")
				f.manifest.evaluationBase = "0".repeat(64);
			else if (fault === "stale evaluation base") {
				f.config.assignments["worker-0"].bindings["skills.reviewer"] = {
					package: "@example/reviewer",
					version: versions[1],
					revision: f.records.get(versions[1]).recordDigest,
				};
				put(f.configFile, stringify(f.config));
				installDependencies({ root: f.root, storeRoot: f.storeRoot });
				f.manifest.configSha256 = JSON.parse(
					fs.readFileSync(f.lockFile, "utf8"),
				).configSha256;
				assert.equal(
					resolveInstructions(f.input).required[0].package.version,
					versions[1],
				);
				assert.equal(
					verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
						.managedReproducible,
					true,
				);
			} else
				put(path.join(f.tree, "SKILL.md"), `${f.after}Concurrent edit\r\n`);
			put(f.manifestFile, JSON.stringify(f.manifest));
			const diagnostic =
				fault === "foreign base"
					? /base.*(?:assignment|scope|foreign|mismatch)|assignment.*base/i
					: fault === "missing base"
						? /base|stamp|missing|ENOENT/i
						: fault === "stale evaluation base"
							? /base.*(?:stale|selection|mismatch|changed)|stale.*(?:base|selection)|selection.*(?:changed|mismatch)/i
							: /stale|expected.*(?:tree|digest)|workspace.*changed/i;
			assertNoPublication(f, () => publication(f), diagnostic);
		},
	);

for (const location of ["store inside source", "source inside store"])
	candidateTest(`candidate publication refuses ${location} overlap`, (t) => {
		const f = fixture(t),
			destination =
				location === "store inside source"
					? path.join(f.tree, "candidate-store")
					: f.workspace;
		const before = roots(f),
			existed = fs.existsSync(destination);
		assert.throws(
			() =>
				migrations.publishMigrationCandidate({
					root: f.root,
					storeRoot: destination,
					id: f.migration.id,
					manifestFile: f.manifestFile,
				}),
			/overlap|inside|outside|nested/i,
		);
		assert.deepEqual(roots(f), before);
		assert.equal(fs.existsSync(destination), existed);
	});

candidateTest(
	"candidate publication separates unresolved required workflow from valid immutable backing",
	(t) => {
		const f = fixture(t);
		delete f.config.workflow_links["checkin-0"];
		put(f.configFile, stringify(f.config));
		installDependencies({ root: f.root, storeRoot: f.storeRoot });
		f.manifest.configSha256 = JSON.parse(
			fs.readFileSync(f.lockFile, "utf8"),
		).configSha256;
		put(f.manifestFile, JSON.stringify(f.manifest));
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
				.managedReproducible,
			true,
		);
		assert.throws(
			() => resolveInstructions(f.input),
			/workflow.*(?:required|missing|link)/i,
		);
		assertNoPublication(
			f,
			() => publication(f),
			/workflow.*(?:required|missing|link)/i,
		);
	},
);

candidateTest(
	"public CLI publishes clean candidate JSON and existing verify reads it without activation",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			active = selections(f);
		const published = child(f, [
			"migrate",
			"candidate",
			f.migration.id,
			f.manifestFile,
			"--json",
		]);
		assert.equal(
			published.error,
			undefined,
			"spawn denial is not behavioral RED",
		);
		assert.equal(published.status, 0, published.stderr);
		assert.equal(published.stderr, "");
		const result = JSON.parse(published.stdout);
		assert.equal(result.id, f.manifest.id);
		assert.equal(result.status, "published");
		const verified = child(f, ["verify", result.stampDigest, "--json"]);
		assert.equal(verified.error, undefined);
		assert.equal(verified.status, 0, verified.stderr);
		assert.equal(JSON.parse(verified.stdout).managedReproducible, true);
		const text = child(f, [
			"migrate",
			"candidate",
			f.migration.id,
			f.manifestFile,
		]);
		assert.equal(text.error, undefined);
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /candidate/i);
		assert.ok(text.stdout.includes(result.id));
		assert.equal(readCandidate(f).stampDigest, result.stampDigest);
		assert.deepEqual(files(f.root), project);
		assert.deepEqual(selections(f), active);
	},
);

import * as observedFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function observeCandidateRename(t, observe, operation) {
	const io = {
		renameSync: fs.renameSync,
		readFileSync: fs.readFileSync,
		writeFileSync: fs.writeFileSync,
		existsSync: fs.existsSync,
	};
	const mock = t.mock.method(fs, "renameSync", (from, to, ...options) =>
		observe(from, to, () => io.renameSync(from, to, ...options), io),
	);
	syncBuiltinESMExports();
	try {
		return operation();
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
	}
}
const sameCandidatePath = (actual, expected) =>
	path.resolve(actual) === path.resolve(expected);
function stagedCandidateIndex(f, from, io) {
	assert.equal(
		io.existsSync(indexPath(f)),
		false,
		"the final index is absent until commit",
	);
	const bytes = io.readFileSync(from),
		index = JSON.parse(bytes.toString("utf8"));
	assert.deepEqual(
		bytes,
		Buffer.from(canonicalJSON(index)),
		"the complete staged index is canonical",
	);
	assert.deepEqual(
		Object.keys(index).sort(),
		[
			"candidateVersion",
			"content",
			"id",
			"migrationId",
			"release",
			"revisionDigest",
			"stampDigest",
		].sort(),
	);
	assert.equal(index.candidateVersion, 1);
	assert.equal(index.id, f.manifest.id);
	assert.equal(index.migrationId, f.migration.id);
	assert.deepEqual(index.release, f.manifest.release);
	assert.deepEqual(index.content, {
		identity: f.packages.get(versions[0]).identity,
		sha256: f.manifest.expectedTreeSha256,
	});
	assert.match(index.revisionDigest, /^[a-f0-9]{64}$/);
	assert.match(index.stampDigest, /^[a-f0-9]{64}$/);
	const record = readRevisionRecord({
		storeRoot: f.storeRoot,
		recordDigest: index.revisionDigest,
	});
	assert.deepEqual(record.content, index.content);
	assert.deepEqual(record.identity, index.release);
	assert.equal(record.candidate, index.id);
	assert.deepEqual(record.provenance.proposals, [f.accepted]);
	assert.equal(record.provenance.evaluationBase, f.manifest.evaluationBase);
	assert.equal(
		record.provenance.expectedTreeSha256,
		f.manifest.expectedTreeSha256,
	);
	assert.equal(
		readPackage({
			root: path.join(
				f.storeRoot,
				"objects/sha256",
				index.content.sha256,
				"tree",
			),
		}).sha256,
		index.content.sha256,
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: index.stampDigest })
			.managedReproducible,
		true,
	);
	const rebuilt = reconstructStamp({
		storeRoot: f.storeRoot,
		digest: index.stampDigest,
	});
	assert.deepEqual(
		rebuilt.composition.find(
			(part) =>
				part.package?.revisionDigest === index.revisionDigest &&
				part.kind !== "workflow",
		).bytes,
		Buffer.from(f.after),
	);
	const snapshot = JSON.parse(
		io.readFileSync(
			path.join(
				f.storeRoot,
				"stamps/sha256",
				index.stampDigest,
				"snapshot.json",
			),
			"utf8",
		),
	);
	assert.deepEqual(snapshot.capture, {
		kind: "candidate",
		migration: f.migration.id,
		candidate: index.revisionDigest,
	});
	return { bytes, index };
}
function candidateFailureCleanup(f, priorStore) {
	assert.equal(fs.existsSync(indexPath(f)), false);
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
		false,
	);
	assert.equal(fs.existsSync(path.join(f.storeRoot, ".writer-lock")), false);
	const after = files(f.storeRoot),
		byPath = new Map(after.map((row) => [row[0], row]));
	for (const row of priorStore)
		assert.deepEqual(
			byPath.get(row[0]),
			row,
			`prior store evidence ${row[0]} stays unchanged`,
		);
	const staged = (rows) =>
		rows.filter(
			(row) => row[0] === ".staging" || row[0].startsWith(".staging/"),
		);
	assert.deepEqual(
		staged(after),
		staged(priorStore),
		"caught failure cleans owned store staging",
	);
}

test("candidate rename observer proves complete staging sentinel refusal restoration and real retry", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-candidate-observer-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const originalRename = fs.renameSync,
		expected = Buffer.from(
			canonicalJSON({
				candidateVersion: 1,
				id: "observer-control",
				complete: true,
			}),
		);
	for (const existing of [false, true]) {
		const target = path.join(dir, existing ? "existing.json" : "absent.json"),
			stage = path.join(dir, existing ? "replacement.json" : "new.json");
		const original = Buffer.from("original target\r\n"),
			sentinel = Object.assign(
				new Error("candidate observer control EIO sentinel"),
				{ code: "EIO" },
			);
		if (existing) fs.writeFileSync(target, original);
		fs.writeFileSync(stage, expected);
		let observations = 0;
		observeCandidateRename(
			t,
			(from, to, rename, io) => {
				if (!sameCandidatePath(to, target)) return rename();
				observations++;
				assert.deepEqual(io.readFileSync(from), expected);
				if (existing) assert.deepEqual(io.readFileSync(target), original);
				else assert.equal(io.existsSync(target), false);
				throw sentinel;
			},
			() =>
				assert.throws(
					() => observedFs.renameSync(stage, target),
					(error) => error === sentinel,
				),
		);
		assert.equal(observations, 1);
		assert.equal(fs.renameSync, originalRename);
		assert.equal(observedFs.renameSync, originalRename);
		assert.deepEqual(fs.readFileSync(stage), expected);
		if (existing) assert.deepEqual(fs.readFileSync(target), original);
		else assert.equal(fs.existsSync(target), false);
		observedFs.renameSync(stage, target);
		assert.deepEqual(fs.readFileSync(target), expected);
		assert.equal(fs.existsSync(stage), false);
	}
});

candidateTest(
	"candidate refuses an unapproved task edit even with accepted proposal and fresh tree digest",
	(t) => {
		const f = fixture(t);
		put(
			path.join(f.tree, "SKILL.md"),
			`${f.after}Unapproved additional task obligation\r\n`,
		);
		f.manifest.expectedTreeSha256 = readPackage({ root: f.tree }).sha256;
		put(f.manifestFile, JSON.stringify(f.manifest));
		assert.equal(f.manifest.proposalIds[0], f.accepted.id);
		assert.equal(f.accepted.status, "accepted");
		assert.notEqual(
			f.manifest.expectedTreeSha256,
			f.packages.get(versions[0]).sha256,
		);
		assertNoPublication(
			f,
			() => publication(f),
			/unapproved|accepted.*(?:history|change|bytes|proposal)|proposal.*(?:replay|explain|match)|task.*(?:history|mismatch)/i,
		);
	},
);

candidateTest(
	"candidate commits one complete canonical final index only after real backing verifies",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			ambient = files(f.ambient);
		let observations = 0,
			staged;
		const result = observeCandidateRename(
			t,
			(from, to, rename, io) => {
				if (!sameCandidatePath(to, indexPath(f))) return rename();
				observations++;
				staged = stagedCandidateIndex(f, from, io);
				const renamed = rename();
				assert.deepEqual(io.readFileSync(to), staged.bytes);
				return renamed;
			},
			() => publication(f),
		);
		assert.equal(
			observations,
			1,
			"publication must use the observed complete final-index rename",
		);
		const { status, ...index } = result;
		assert.equal(status, "published");
		assert.deepEqual(index, staged.index);
		assert.deepEqual(readCandidate(f), staged.index);
		assert.deepEqual(fs.readFileSync(indexPath(f)), staged.bytes);
		assert.deepEqual(files(f.root), project);
		assert.deepEqual(files(f.ambient), ambient);
	},
);

candidateTest(
	"candidate refuses a concurrent config edit after fresh backing publication before any index commit",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			ambient = files(f.ambient),
			priorStore = files(f.storeRoot);
		const object = path.join(
			f.storeRoot,
			"objects/sha256",
			f.manifest.expectedTreeSha256,
		);
		assert.equal(
			fs.existsSync(object),
			false,
			"this race control qualifies a fresh object path",
		);
		const changed = structuredClone(f.config);
		changed.models["observer-model"] = { profile: "base" };
		const edited = Buffer.from(stringify(changed));
		let mutations = 0,
			indexAttempts = 0;
		observeCandidateRename(
			t,
			(_from, to, rename, io) => {
				if (sameCandidatePath(to, indexPath(f))) indexAttempts++;
				if (!sameCandidatePath(to, object)) return rename();
				assert.equal(io.existsSync(object), false);
				const renamed = rename();
				assert.equal(
					readPackage({ root: path.join(object, "tree") }).sha256,
					f.manifest.expectedTreeSha256,
				);
				mutations++;
				assert.equal(mutations, 1);
				io.writeFileSync(f.configFile, edited);
				return renamed;
			},
			() =>
				assert.throws(
					() => publication(f),
					/stale|config(?:uration)?.*(?:changed|mismatch)|input.*changed/i,
				),
		);
		assert.equal(mutations, 1);
		assert.equal(
			indexAttempts,
			0,
			"stale input refuses before even attempting the index commit",
		);
		assert.deepEqual(fs.readFileSync(f.configFile), edited);
		const relative = path
			.relative(f.root, f.configFile)
			.split(path.sep)
			.join("/");
		assert.deepEqual(
			files(f.root),
			project.map((row) =>
				row[0] === relative ? [row[0], row[1], edited.toString("hex")] : row,
			),
		);
		assert.deepEqual(files(f.ambient), ambient);
		candidateFailureCleanup(f, priorStore);
		assert.equal(
			readPackage({ root: path.join(object, "tree") }).sha256,
			f.manifest.expectedTreeSha256,
		);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
				.managedReproducible,
			true,
		);
	},
);

candidateTest(
	"candidate refuses a concurrent task edit after fresh backing publication before any index commit",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			ambient = files(f.ambient),
			priorStore = files(f.storeRoot);
		const object = path.join(
				f.storeRoot,
				"objects/sha256",
				f.manifest.expectedTreeSha256,
			),
			task = path.join(f.tree, "SKILL.md");
		assert.equal(
			fs.existsSync(object),
			false,
			"this race control qualifies a fresh object path",
		);
		const edited = Buffer.from(`${f.after}Concurrent developer task edit\r\n`),
			submitted = f.manifest.expectedTreeSha256;
		let mutations = 0,
			indexAttempts = 0;
		observeCandidateRename(
			t,
			(_from, to, rename, io) => {
				if (sameCandidatePath(to, indexPath(f))) indexAttempts++;
				if (!sameCandidatePath(to, object)) return rename();
				assert.equal(io.existsSync(object), false);
				const renamed = rename();
				assert.equal(
					readPackage({ root: path.join(object, "tree") }).sha256,
					submitted,
				);
				mutations++;
				assert.equal(mutations, 1);
				io.writeFileSync(task, edited);
				return renamed;
			},
			() =>
				assert.throws(
					() => publication(f),
					/stale|workspace.*changed|input.*changed|expected.*(?:tree|digest)|source.*changed/i,
				),
		);
		assert.equal(mutations, 1);
		assert.equal(indexAttempts, 0);
		assert.equal(f.manifest.expectedTreeSha256, submitted);
		assert.deepEqual(fs.readFileSync(task), edited);
		assert.notEqual(readPackage({ root: f.tree }).sha256, submitted);
		const relative = path.relative(f.root, task).split(path.sep).join("/");
		assert.deepEqual(
			files(f.root),
			project.map((row) =>
				row[0] === relative ? [row[0], row[1], edited.toString("hex")] : row,
			),
		);
		assert.deepEqual(files(f.ambient), ambient);
		candidateFailureCleanup(f, priorStore);
		assert.equal(
			readPackage({ root: path.join(object, "tree") }).sha256,
			submitted,
		);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest })
				.managedReproducible,
			true,
		);
	},
);

candidateTest(
	"candidate late index EIO preserves project prior evidence and valid retained backing without publication",
	(t) => {
		const f = fixture(t),
			project = files(f.root),
			ambient = files(f.ambient),
			priorStore = files(f.storeRoot);
		const sentinel = Object.assign(
			new Error("candidate final-index publication EIO sentinel"),
			{ code: "EIO" },
		);
		let observations = 0,
			staged;
		observeCandidateRename(
			t,
			(from, to, rename, io) => {
				if (!sameCandidatePath(to, indexPath(f))) return rename();
				observations++;
				staged = stagedCandidateIndex(f, from, io);
				throw sentinel;
			},
			() =>
				assert.throws(
					() => publication(f),
					/candidate final-index publication EIO sentinel/,
				),
		);
		assert.equal(
			observations,
			1,
			"the distinctive failure occurs after staged index and backing validation",
		);
		assert.deepEqual(files(f.root), project);
		assert.deepEqual(files(f.ambient), ambient);
		candidateFailureCleanup(f, priorStore);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: staged.index.stampDigest })
				.managedReproducible,
			true,
		);
		assert.deepEqual(
			readRevisionRecord({
				storeRoot: f.storeRoot,
				recordDigest: staged.index.revisionDigest,
			}).content,
			staged.index.content,
		);
		assert.equal(
			readPackage({
				root: path.join(
					f.storeRoot,
					"objects/sha256",
					staged.index.content.sha256,
					"tree",
				),
			}).sha256,
			staged.index.content.sha256,
		);
		assert.equal(
			verifyStamp({
				storeRoot: f.storeRoot,
				digest: f.migration.bases[0].stamp,
			}).managedReproducible,
			true,
		);
	},
);

import { readLockState } from "../src/package-lock.js";
import { validateConfiguration } from "../src/resolve.ts";
import { revisionClosure } from "../src/revisions.js";

function reviewAttempt(operation) {
	try {
		return { value: operation(), error: null };
	} catch (error) {
		return { value: null, error };
	}
}
function observeReviewFs(t, method, observe, operation) {
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
function reviewSource(f, version = f.manifest.release.version) {
	const source = path.join(f.dir, `review-source-${version}`);
	fs.cpSync(f.tree, source, { recursive: true });
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: f.manifest.release.name, version, type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	return source;
}
function reviewCandidateStamp(f) {
	const folder = path.join(f.storeRoot, "stamps/sha256");
	for (const digest of fs.readdirSync(folder)) {
		if (!/^[a-f0-9]{64}$/.test(digest)) continue;
		const snapshot = JSON.parse(
			fs.readFileSync(path.join(folder, digest, "snapshot.json"), "utf8"),
		);
		if (
			snapshot.capture?.kind === "candidate" &&
			snapshot.capture.migration === f.migration.id
		)
			return digest;
	}
	return null;
}
function reviewLegacyReference(f, version, release) {
	const config = structuredClone(f.config);
	config.assignments["worker-0"].bindings["skills.reviewer"] = {
		package: release.name,
		version: release.version,
	};
	if (version === 2) {
		config.version = 2;
		delete config.workflow_links;
		delete config.skills.reviewer.revision;
		assert.equal(
			config.skills.reviewer.package,
			release.name,
			"config2 version overrides keep the actual package name",
		);
		config.assignments = Object.fromEntries(
			Object.entries(config.assignments).map(([id, rule]) => [
				id,
				{
					when: rule.when,
					versions: Object.fromEntries(
						Object.entries(rule.bindings).map(([binding, reference]) => [
							binding,
							reference.version,
						]),
					),
				},
			]),
		);
	} else
		assert.equal(
			Object.hasOwn(
				config.assignments["worker-0"].bindings["skills.reviewer"],
				"revision",
			),
			false,
		);
	put(f.configFile, stringify(config));
	const validated = validateConfiguration({ root: f.root });
	assert.equal(
		validated.config.get("version"),
		version,
		"actual written configuration passes structural validation before acquisition",
	);
	return config;
}

test("R1 competing ordinary release wins before final candidate writer and remains normally usable", (t) => {
	const f = fixture(t),
		source = reviewSource(f),
		expected = readPackage({ root: source }).sha256;
	const project = files(f.root),
		ambient = files(f.ambient),
		priorStore = files(f.storeRoot),
		sourceBefore = files(source);
	const writer = path.join(f.storeRoot, ".writer-lock");
	let interventions = 0,
		intervening = false,
		imported,
		stampDigest;
	const outcome = observeReviewFs(
		t,
		"mkdirSync",
		(real, target, ...args) => {
			if (
				!intervening &&
				interventions === 0 &&
				sameCandidatePath(target, writer) &&
				!fs.existsSync(writer)
			) {
				const retained = reviewCandidateStamp(f);
				if (retained !== null) {
					assert.equal(
						verifyStamp({ storeRoot: f.storeRoot, digest: retained })
							.managedReproducible,
						true,
					);
					stampDigest = retained;
					intervening = true;
					try {
						imported = importPackage({
							sourceDirectory: source,
							storeRoot: f.storeRoot,
						});
						interventions++;
					} finally {
						intervening = false;
					}
				}
			}
			return real(target, ...args);
		},
		() => reviewAttempt(() => publication(f)),
	);
	assert.equal(
		interventions,
		1,
		"one ordinary writer runs after real candidate backing and before final lock acquisition",
	);
	assert.equal(
		imported.status,
		"published",
		"competing import actually succeeds rather than encountering store-busy",
	);
	assert.equal(imported.sha256, expected);
	assert.deepEqual(imported.identity, f.manifest.release);
	const ordinary = lookupPackage({
		storeRoot: f.storeRoot,
		...f.manifest.release,
	});
	assert.equal(ordinary.sha256, expected);
	assert.deepEqual(
		files(path.join(f.storeRoot, "objects/sha256", expected, "tree")),
		sourceBefore,
	);
	const closure = reviewAttempt(() =>
		revisionClosure({ storeRoot: f.storeRoot, ...f.manifest.release }),
	);
	assert.ok(
		outcome.error,
		"candidate must refuse after the ordinary release wins",
	);
	assert.match(
		outcome.error.message,
		/candidate.*(?:published|conflict|release)|release.*(?:published|conflict)|identity.conflict/i,
	);
	assert.equal(
		closure.error,
		null,
		"the successful ordinary release stays usable without revision metadata",
	);
	assert.deepEqual(
		closure.value.map((member) => [
			member.identity,
			member.sha256,
			member.revisionDigest,
		]),
		[[f.manifest.release, expected, null]],
	);
	assert.deepEqual(files(f.root), project);
	assert.deepEqual(files(f.ambient), ambient);
	assert.deepEqual(files(source), sourceBefore);
	candidateFailureCleanup(f, priorStore);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: stampDigest })
			.managedReproducible,
		true,
		"legitimate retained candidate backing may remain",
	);
});

test("R2 abandonment after original validated record close cannot become a new guard baseline", (t) => {
	const f = fixture(t),
		recordPath = path.join(
			f.root,
			".agent-profiles/migrations",
			f.migration.id,
			"record.json",
		);
	const priorStore = files(f.storeRoot),
		ambient = files(f.ambient),
		reason =
			"Operator abandoned this fictional migration after its original validated intake.";
	let recordFd = null,
		interventions = 0,
		intervening = false,
		abandoned,
		abandonedBytes,
		abandonedProject;
	const outcome = observeReviewFs(
		t,
		"openSync",
		(real, target, ...args) => {
			const fd = real(target, ...args);
			if (
				!intervening &&
				interventions === 0 &&
				sameCandidatePath(target, recordPath)
			)
				recordFd = fd;
			return fd;
		},
		() =>
			observeReviewFs(
				t,
				"closeSync",
				(real, fd, ...args) => {
					const originalRecord =
						!intervening && interventions === 0 && fd === recordFd;
					const closed = real(fd, ...args);
					if (originalRecord) {
						recordFd = null;
						intervening = true;
						try {
							assert.equal(
								fs.existsSync(
									path.join(f.root, ".agent-profiles/.migration-writer"),
								),
								false,
								"legitimate operator can acquire the free project writer",
							);
							abandoned = migrations.abandonMigration({
								root: f.root,
								id: f.migration.id,
								reason,
							});
							interventions++;
							abandonedBytes = fs.readFileSync(recordPath);
							abandonedProject = files(f.root);
						} finally {
							intervening = false;
						}
					}
					return closed;
				},
				() => reviewAttempt(() => publication(f)),
			),
	);
	assert.equal(
		interventions,
		1,
		"abandonment occurs after successful safe-reader close, not inside its stat window",
	);
	assert.equal(abandoned.state, "abandoned");
	assert.equal(abandoned.reason, reason);
	const retained = JSON.parse(fs.readFileSync(recordPath, "utf8"));
	assert.equal(retained.state, "abandoned");
	assert.equal(retained.reason, reason);
	assert.ok(
		outcome.error,
		"a legitimately closed migration must refuse candidate publication",
	);
	assert.match(
		outcome.error.message,
		/stale|closed|abandon|record.*changed|not open/i,
	);
	assert.deepEqual(fs.readFileSync(recordPath), abandonedBytes);
	assert.deepEqual(files(f.root), abandonedProject);
	assert.deepEqual(
		fs.readFileSync(path.join(f.tree, "SKILL.md")),
		Buffer.from(f.after),
	);
	assert.deepEqual(files(f.ambient), ambient);
	candidateFailureCleanup(f, priorStore);
	assert.equal(
		migrations.migrationStatus({ root: f.root, id: f.migration.id }).state,
		"abandoned",
	);
});

for (const selection of ["explicit", "environment"])
	test(`R3 ${selection} store inside protected migration namespace refuses with complete valid backing`, (t) => {
		const f = fixture(t),
			nested = path.join(f.root, ".agent-profiles/migrations/store");
		fs.cpSync(f.storeRoot, nested, { recursive: true });
		assert.equal(
			verifyStamp({ storeRoot: nested, digest: f.base.digest })
				.managedReproducible,
			true,
		);
		assert.equal(
			verifyStamp({ storeRoot: nested, digest: f.migration.bases[0].stamp })
				.managedReproducible,
			true,
		);
		if (selection === "environment") process.env.AGENT_PROFILES_STORE = nested;
		const before = roots(f),
			nestedBefore = files(nested);
		const input = {
			root: f.root,
			id: f.migration.id,
			manifestFile: f.manifestFile,
			...(selection === "explicit" ? { storeRoot: nested } : {}),
		};
		assert.throws(
			() => migrations.publishMigrationCandidate(input),
			/overlap|migration.*(?:namespace|store)|reserved.*(?:store|directory)/i,
		);
		assert.deepEqual(roots(f), before);
		assert.deepEqual(files(nested), nestedBefore);
		assert.equal(
			fs.existsSync(
				path.join(nested, "candidates/ids", `${f.manifest.id}.json`),
			),
			false,
		);
		assert.equal(
			fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
			false,
		);
	});

test("R3 migrations-archive sibling store permits publication while protected project selections stay unchanged", (t) => {
	const f = fixture(t),
		relative = ".agent-profiles/migrations-archive",
		sibling = path.join(f.root, relative);
	fs.cpSync(f.storeRoot, sibling, { recursive: true });
	assert.equal(
		verifyStamp({ storeRoot: sibling, digest: f.base.digest })
			.managedReproducible,
		true,
	);
	const protectedProject = (rows) =>
		rows.filter(
			(row) => row[0] !== relative && !row[0].startsWith(`${relative}/`),
		);
	const before = protectedProject(files(f.root)),
		originalStore = files(f.storeRoot),
		ambient = files(f.ambient);
	const active = resolveInstructions({ ...f.input, storeRoot: sibling });
	const result = migrations.publishMigrationCandidate({
		root: f.root,
		storeRoot: sibling,
		id: f.migration.id,
		manifestFile: f.manifestFile,
	});
	assert.equal(result.status, "published");
	const { status, ...index } = result;
	assert.equal(status, "published");
	assert.deepEqual(
		migrations.migrationCandidate({ storeRoot: sibling, id: f.manifest.id }),
		index,
	);
	assert.equal(
		verifyStamp({ storeRoot: sibling, digest: result.stampDigest })
			.managedReproducible,
		true,
	);
	assert.deepEqual(
		resolveInstructions({ ...f.input, storeRoot: sibling }),
		active,
	);
	assert.deepEqual(protectedProject(files(f.root)), before);
	assert.deepEqual(files(f.storeRoot), originalStore);
	assert.deepEqual(files(f.ambient), ambient);
	assert.equal(fs.existsSync(path.join(sibling, ".writer-lock")), false);
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/.migration-writer")),
		false,
	);
});

for (const version of [2, 3])
	test(`R4 config${version} reserved planned label without revision refuses before acquisition`, (t) => {
		const f = fixture(t),
			result = publication(f),
			retained = readCandidate(f);
		reviewLegacyReference(f, version, f.manifest.release);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...f.manifest.release }),
			null,
		);
		const before = roots(f);
		assert.throws(
			() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
			/candidate|reserved|unpublished/i,
		);
		assert.deepEqual(roots(f), before);
		assert.deepEqual(readCandidate(f), retained);
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: result.stampDigest })
				.managedReproducible,
			true,
		);
	});

for (const version of [2, 3])
	test(`R4 config${version} unreserved legacy label without revision acquires an explicit local source`, (t) => {
		const f = fixture(t);
		publication(f);
		const retained = readCandidate(f),
			release = { name: f.manifest.release.name, version: "3.0.1" },
			source = reviewSource(f, release.version);
		const expected = readPackage({ root: source }).sha256,
			sourceBefore = files(source);
		reviewLegacyReference(f, version, release);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...release }),
			null,
			"a real missing unreserved identity needs acquisition",
		);
		const project = files(f.root),
			priorStore = files(f.storeRoot),
			ambient = files(f.ambient);
		installDependencies({
			root: f.root,
			storeRoot: f.storeRoot,
			sources: [{ ...release, directory: source }],
		});
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...release }).sha256,
			expected,
		);
		const lock = JSON.parse(fs.readFileSync(f.lockFile, "utf8"));
		assert.equal(lock.lockVersion, version === 3 ? 2 : 1);
		assert.equal(lock.configurationVersion, version);
		const pin = lock.pins.find(
			(row) =>
				row.binding === "skills.reviewer" && row.version === release.version,
		);
		assert.equal(pin.package, release.name);
		assert.equal(pin.sha256, expected);
		if (version === 3) assert.equal(pin.revisionDigest, null);
		else assert.equal(Object.hasOwn(pin, "revisionDigest"), false);
		assert.equal(
			lock.packages.find(
				(row) => row.name === release.name && row.version === release.version,
			).sha256,
			expected,
		);
		assert.equal(
			readLockState(
				f.root,
				validateConfiguration({ root: f.root }),
				f.storeRoot,
			).state,
			"valid",
		);
		const lockPath = path
			.relative(f.root, f.lockFile)
			.split(path.sep)
			.join("/");
		assert.deepEqual(
			files(f.root).filter((row) => row[0] !== lockPath),
			project.filter((row) => row[0] !== lockPath),
		);
		const afterStore = new Map(files(f.storeRoot).map((row) => [row[0], row]));
		for (const row of priorStore)
			assert.deepEqual(
				afterStore.get(row[0]),
				row,
				`prior evidence ${row[0]} stays unchanged`,
			);
		assert.deepEqual(files(f.ambient), ambient);
		assert.deepEqual(files(source), sourceBefore);
		assert.deepEqual(readCandidate(f), retained);
		assert.deepEqual(
			files(path.join(f.storeRoot, "objects/sha256", expected, "tree")),
			sourceBefore,
		);
		assert.equal(fs.existsSync(path.join(f.storeRoot, ".writer-lock")), false);
	});
