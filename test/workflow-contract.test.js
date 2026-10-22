import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { formatContext, formatProof } from "../src/diagnostics.js";
import {
	materializeStamp,
	planMaterialization,
	verifyMaterialization,
} from "../src/materialize.js";
import { installDependencies } from "../src/package-lock.js";
import { importPackage, lookupPackage } from "../src/package-store.js";
import { hashRecord } from "../src/packages.js";
import { resolveInstructions } from "../src/resolve.js";
import { createStamp, reconstructStamp, verifyStamp } from "../src/stamps.js";

const service = new URL("../src/revisions.js", import.meta.url);
let revisions;
try {
	revisions = await import(service.href);
} catch (error) {
	if (
		!(
			error.code === "ERR_MODULE_NOT_FOUND" &&
			error.url === service.href &&
			!fs.existsSync(fileURLToPath(service))
		)
	)
		throw error;
}
const ready = typeof revisions?.retainRevisionManifest === "function";
const workflowTest = (name, body) =>
	test(
		name,
		{
			skip: ready
				? false
				: "retainRevisionManifest service absent; workflow behavioral body not executed",
		},
		body,
	);
const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const protocol = "@example/agent-checkin";
const versions = ["1.2.3", "1.4.5", "2.3.4"];
const models = ["local-llm", "opus", "slim-llm"];
const originalStore = process.env.AGENT_PROFILES_STORE;
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const copy = (value) => structuredClone(value);
const assignment = (model, role = "worker") => ({
	role,
	model,
	host: "claude",
});
const provides = (major) => ({
	file: "WORKFLOW.md",
	provides: [{ protocol, major }],
	requires: [],
});
const requires = () => ({
	file: "WORKFLOW.md",
	provides: [],
	requires: [{ protocol, major: 1 }],
});

function snapshot(root) {
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
function fixture(
	t,
	workflowBytes = "# Check-in major 1\r\nRecord ticket_id, worker_id, state and next_step.\r\n",
) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-workflow-")),
	);
	t.after(() => {
		if (originalStore === undefined) delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = originalStore;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		sources = path.join(dir, "sources");
	const ambient = path.join(dir, "misleading-store"),
		empty = path.join(dir, "empty-store"),
		outputRoot = path.join(dir, "exports"),
		home = path.join(dir, "home");
	fs.mkdirSync(empty);
	fs.mkdirSync(outputRoot);
	fs.mkdirSync(home);
	process.env.AGENT_PROFILES_STORE = ambient;
	const packages = new Map();
	function add(key, name, version, body, workflow) {
		const source = path.join(sources, key),
			entry = `---\r\nname: ${key.split("-")[0]}\r\ndescription: Fixture ${key}\r\n---\r\n${body}\r\nRead WORKFLOW.md before working.\r\n`;
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name, version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(path.join(source, "SKILL.md"), entry);
		put(path.join(source, "WORKFLOW.md"), workflow);
		put(path.join(source, "data.bin"), Buffer.from([0, 255, 13, 10]));
		const result = importPackage({ sourceDirectory: source, storeRoot });
		packages.set(key, { ...result, source, name, version, entry, workflow });
	}
	for (const version of versions)
		add(
			`reviewer-${version}`,
			"@example/reviewer",
			version,
			`# Review ${version} café  `,
			workflowBytes,
		);
	add(
		"orchestrator",
		"@example/orchestrator",
		"1.0.0",
		"# Coordinate workers",
		"# Require check-in major 1\r\nWait for worker evidence.\r\n",
	);
	add(
		"extra",
		"@example/extra",
		"1.0.0",
		"# Optional task",
		"# Optional workflow\r\nKeep optional evidence.\r\n",
	);
	const misleading = path.join(dir, "misleading-source");
	fs.cpSync(packages.get("reviewer-1.2.3").source, misleading, {
		recursive: true,
	});
	put(
		path.join(misleading, "SKILL.md"),
		"---\ndescription: Misleading ambient content\n---\nWrong reviewer\n",
	);
	importPackage({ sourceDirectory: misleading, storeRoot: ambient });
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
				skills: { required: ["reviewer"], available: ["extra", "note"] },
			},
			coordinator: {
				file: "roles/coordinator.md",
				skills: { required: ["orchestrator"], available: [] },
			},
			observer: {
				file: "roles/observer.md",
				skills: { required: [], available: ["reviewer"] },
			},
		},
		skills: {
			reviewer: { package: "@example/reviewer", version: "1.2.3" },
			orchestrator: { package: "@example/orchestrator", version: "1.0.0" },
			extra: { package: "@example/extra", version: "1.0.0" },
			note: {
				file: "instructions/note.md",
				resources: ["instructions/reference.md"],
			},
		},
		assignments: Object.fromEntries(
			models.map((model, i) => [
				`worker-${i}`,
				{
					when: assignment(model),
					versions: { "skills.reviewer": versions[i] },
				},
			]),
		),
	};
	put(path.join(root, ".agent-profiles/agents.yaml"), stringify(config));
	put(
		path.join(root, ".agent-profiles/profiles/base.md"),
		"\uFEFF# Profile\r\n",
	);
	for (const role of ["worker", "coordinator", "observer"])
		put(path.join(root, `.agent-profiles/roles/${role}.md`), `# ${role}\r\n`);
	put(
		path.join(root, "instructions/note.md"),
		"---\ndescription: Local note\n---\nA local note.\n",
	);
	put(
		path.join(root, "instructions/reference.md"),
		"# Retained resource; never implicit workflow\n",
	);
	put(path.join(root, "AGENTS.md"), "# Host-supplied repository rules\n");
	installDependencies({ root, storeRoot });
	return {
		dir,
		root,
		storeRoot,
		sources,
		ambient,
		empty,
		outputRoot,
		home,
		packages,
		config,
		configFile: path.join(root, ".agent-profiles/agents.yaml"),
		input: { root, storeRoot, ...assignment(models[0]) },
	};
}
function manifest(f, key) {
	const pkg = f.packages.get(key);
	return {
		revisionVersion: 1,
		identity: { name: pkg.name, version: pkg.version },
		kind: "release",
		content: {
			identity: { name: pkg.name, version: pkg.version },
			sha256: pkg.sha256,
		},
		parent: null,
		candidate: null,
		dependencies: [],
		workflow:
			key === "orchestrator"
				? requires()
				: key === "extra"
					? { file: "WORKFLOW.md", provides: [], requires: [] }
					: provides(1),
		provenance: {
			kind: "legacy-adoption",
			workflowChange: {
				kind: "initial",
				reason:
					"Explicitly declare the existing workflow; no new evaluation is claimed.",
			},
		},
	};
}
function retain(f, value) {
	const manifestFile = path.join(f.dir, "revision.json");
	put(manifestFile, JSON.stringify(value));
	return revisions.retainRevisionManifest({
		storeRoot: f.storeRoot,
		manifestFile,
	});
}
function adopt(f, adjust = () => {}) {
	const records = new Map();
	for (const key of f.packages.keys()) {
		const value = manifest(f, key);
		adjust(value, key, records);
		const result = retain(f, value);
		assert.deepEqual(result.identity, value.identity);
		assert.equal(result.sha256, value.content.sha256);
		assert.equal(
			result.recordDigest,
			hashRecord("agent-profiles/revision/v1", value),
		);
		assert.equal(result.status, "published");
		records.set(key, { ...result, manifest: value });
	}
	return records;
}
function config3(f, records) {
	const value = copy(f.config);
	value.version = 3;
	for (const [id, key] of [
		["reviewer", "reviewer-1.2.3"],
		["orchestrator", "orchestrator"],
		["extra", "extra"],
	])
		value.skills[id].revision = records.get(key).recordDigest;
	for (const [i, model] of models.entries())
		value.assignments[`worker-${i}`] = {
			when: assignment(model),
			bindings: {
				"skills.reviewer": {
					package: "@example/reviewer",
					version: versions[i],
					revision: records.get(`reviewer-${versions[i]}`).recordDigest,
				},
			},
		};
	value.workflow_links = {
		checkin: {
			protocol,
			consumer: {
				assignment: assignment("opus", "coordinator"),
				binding: "skills.orchestrator",
			},
			providers: models.map((model) => ({
				assignment: assignment(model),
				binding: "skills.reviewer",
			})),
		},
	};
	return value;
}
function activate(f, value) {
	put(f.configFile, stringify(value));
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
}
const resolve = (f, model = "local-llm", role = "worker", skills = []) =>
	resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		...assignment(model, role),
		skills,
	});
function peerRows(records) {
	return models.map((model, i) => ({
		protocol,
		major: 1,
		consumer: {
			assignment: assignment("opus", "coordinator"),
			binding: "skills.orchestrator",
			revisionDigest: records.get("orchestrator").recordDigest,
		},
		provider: {
			assignment: assignment(model),
			binding: "skills.reviewer",
			revisionDigest: records.get(`reviewer-${versions[i]}`).recordDigest,
		},
	}));
}
function refuses(f, operation, diagnostic) {
	const project = snapshot(f.root),
		store = snapshot(f.storeRoot),
		ambient = snapshot(f.ambient);
	assert.throws(operation, diagnostic);
	assert.deepEqual(
		snapshot(f.root),
		project,
		"refusal leaves project bytes/membership unchanged",
	);
	assert.deepEqual(
		snapshot(f.storeRoot),
		store,
		"refusal leaves store bytes/membership unchanged",
	);
	assert.deepEqual(
		snapshot(f.ambient),
		ambient,
		"refusal leaves ambient store unchanged",
	);
}
function invoke(f, args, ambient = f.ambient) {
	const result = spawnSync(
		process.execPath,
		[cli, ...args, "--root", f.root, "--store", f.storeRoot],
		{
			cwd: f.dir,
			encoding: "utf8",
			env: {
				...process.env,
				AGENT_PROFILES_STORE: ambient,
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
	assert.equal(result.error, undefined, "a spawn denial is not behavioral RED");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return result.stdout;
}
function materialize(f, digest, name) {
	const destination = path.join(f.outputRoot, name);
	materializeStamp({
		stampDigest: digest,
		storeRoot: f.storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
		destination,
		outputRoot: f.outputRoot,
		deniedRoots: [f.root, f.storeRoot],
	});
	assert.deepEqual(
		verifyMaterialization({
			destination,
			expectedStampDigest: digest,
			storeRoot: f.storeRoot,
		}),
		{ verified: true, findings: [] },
	);
	return destination;
}

test("workflow foundation public revision service exists", () => {
	assert.equal(
		typeof revisions?.retainRevisionManifest,
		"function",
		"src/revisions.js must export retainRevisionManifest",
	);
});

test("workflow fixture legacy raw capture and materialization retain resources without injecting companions", (t) => {
	const f = fixture(t),
		result = resolve(f),
		captured = createStamp(f.input),
		rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: captured.digest,
		});
	assert.equal(captured.snapshot.stampVersion, 1);
	assert.deepEqual(
		result.loaded.map((e) => e.kind),
		["profile", "role", "required-skill"],
	);
	assert.equal(
		result.loaded[2].content,
		f.packages.get("reviewer-1.2.3").entry,
	);
	assert.deepEqual(
		rebuilt.composition[2].bytes,
		Buffer.from(f.packages.get("reviewer-1.2.3").entry),
	);
	assert.deepEqual(
		rebuilt.packages
			.find((p) => p.name === "@example/reviewer")
			.files.find((p) => p.path === "WORKFLOW.md").bytes,
		Buffer.from(f.packages.get("reviewer-1.2.3").workflow),
	);
	assert.ok(
		rebuilt.resources.some(
			(r) => r.backing.path === "instructions/reference.md",
		),
	);
	const plan = planMaterialization({
		stampDigest: captured.digest,
		storeRoot: f.storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
	});
	assert.equal(
		plan.mappings.filter(
			(r) =>
				r.outputPath.startsWith("content/instructions/") &&
				r.sourcePath === "WORKFLOW.md",
		).length,
		0,
	);
	materialize(f, captured.digest, "legacy");
	assert.throws(
		() => resolveInstructions({ ...f.input, storeRoot: f.ambient }),
		/mismatched-package/,
	);
	assert.throws(
		() => resolveInstructions({ ...f.input, storeRoot: f.empty }),
		/missing-package/,
	);
	const legacyRoot = path.join(f.dir, "config-v1");
	put(
		path.join(legacyRoot, ".agent-profiles/agents.yaml"),
		stringify({
			version: 1,
			default_profile: "base",
			default_role: "worker",
			models: {},
			families: {},
			roles: {
				worker: {
					file: "roles/worker.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	put(
		path.join(legacyRoot, ".agent-profiles/profiles/base.md"),
		"\uFEFF# Old profile\r\n",
	);
	put(
		path.join(legacyRoot, ".agent-profiles/roles/worker.md"),
		"# Old worker\r\n",
	);
	const old = createStamp({
		root: legacyRoot,
		storeRoot: f.storeRoot,
		role: "worker",
		model: "unconfigured",
		host: "claude",
	});
	assert.equal(old.snapshot.stampVersion, 1);
	assert.equal(old.snapshot.configurationVersion, 1);
	assert.deepEqual(
		reconstructStamp({ storeRoot: f.storeRoot, digest: old.digest })
			.composition[0].bytes,
		Buffer.from("\uFEFF# Old profile\r\n"),
	);
});

test("workflow fixture all three legacy releases coexist under real exact model role host selection", (t) => {
	const f = fixture(t),
		before = snapshot(f.storeRoot);
	for (const [i, model] of models.entries()) {
		const selected = resolve(f, model).loaded.find((e) => e.id === "reviewer");
		assert.equal(selected.package.version, versions[i]);
		assert.equal(
			selected.package.sha256,
			f.packages.get(`reviewer-${versions[i]}`).sha256,
		);
		assert.equal(
			selected.content,
			f.packages.get(`reviewer-${versions[i]}`).entry,
		);
	}
	assert.deepEqual(snapshot(f.storeRoot), before);
});

test("workflow preservation snapshots detect project and store edits independently", (t) => {
	const f = fixture(t),
		project = snapshot(f.root),
		store = snapshot(f.storeRoot);
	const file = path.join(f.root, "instructions/reference.md"),
		bytes = fs.readFileSync(file);
	put(file, "# Changed resource\n");
	assert.notDeepEqual(snapshot(f.root), project);
	assert.deepEqual(snapshot(f.storeRoot), store);
	put(file, bytes);
	assert.deepEqual(snapshot(f.root), project);
	put(path.join(f.storeRoot, "oracle-marker"), "changed");
	assert.notDeepEqual(snapshot(f.storeRoot), store);
	assert.deepEqual(snapshot(f.root), project);
});

workflowTest(
	"release metadata adoption is immutable and legacy pins do not silently opt into workflow",
	(t) => {
		const f = fixture(t),
			value = manifest(f, "reviewer-1.2.3"),
			before = resolve(f),
			result = retain(f, value),
			stored = snapshot(f.storeRoot);
		assert.deepEqual(result, {
			identity: value.identity,
			sha256: value.content.sha256,
			recordDigest: hashRecord("agent-profiles/revision/v1", value),
			status: "published",
		});
		assert.deepEqual(retain(f, value), { ...result, status: "reused" });
		assert.deepEqual(snapshot(f.storeRoot), stored);
		assert.deepEqual(
			resolve(f),
			before,
			"legacy source without revision keeps its exact output",
		);
		const changed = copy(value);
		changed.workflow.provides[0].major = 2;
		refuses(
			f,
			() => retain(f, changed),
			/identity-conflict|immutable|repoint|already/i,
		);
		const backing = path.join(
				f.storeRoot,
				"objects/sha256",
				value.content.sha256,
				"tree/WORKFLOW.md",
			),
			beforeBytes = fs.readFileSync(backing);
		put(backing, "# Corrupt retained tree\n");
		refuses(f, () => retain(f, value), /digest mismatch|integrity|backing/i);
		put(backing, beforeBytes);
		assert.equal(
			lookupPackage({ storeRoot: f.storeRoot, ...value.identity }).sha256,
			value.content.sha256,
		);
	},
);

workflowTest(
	"config3 opt-in selects all three release records through normal resolution without a global upgrade",
	(t) => {
		const f = fixture(t),
			records = adopt(f),
			value = config3(f, records);
		activate(f, value);
		const original = snapshot(f.storeRoot),
			configBytes = fs.readFileSync(f.configFile);
		for (const [i, model] of models.entries()) {
			const result = resolve(f, model),
				task = result.loaded.find(
					(e) => e.id === "reviewer" && e.kind === "required-skill",
				);
			assert.equal(task.package.version, versions[i]);
			assert.equal(
				task.package.sha256,
				f.packages.get(`reviewer-${versions[i]}`).sha256,
			);
			assert.equal(
				task.package.revisionDigest,
				records.get(`reviewer-${versions[i]}`).recordDigest,
			);
			assert.equal(
				task.content,
				f.packages.get(`reviewer-${versions[i]}`).entry,
			);
		}
		const lock = JSON.parse(
			fs.readFileSync(
				path.join(f.root, ".agent-profiles/agent-profiles.lock"),
				"utf8",
			),
		);
		assert.equal(lock.lockVersion, 2);
		assert.equal(lock.configurationVersion, 3);
		for (const [i, version] of versions.entries())
			assert.ok(
				lock.pins.some(
					(p) =>
						p.binding === "skills.reviewer" &&
						p.rule === `worker-${i}` &&
						p.version === version &&
						p.revisionDigest ===
							records.get(`reviewer-${version}`).recordDigest,
				),
			);
		assert.deepEqual(fs.readFileSync(f.configFile), configBytes);
		assert.deepEqual(snapshot(f.storeRoot), original);
		const changed = copy(value);
		changed.assignments["worker-2"].bindings["skills.reviewer"] = {
			package: "@example/reviewer",
			version: "1.4.5",
			revision: records.get("reviewer-1.4.5").recordDigest,
		};
		activate(f, changed);
		assert.equal(
			resolve(f, "local-llm").loaded.find((e) => e.kind === "required-skill")
				.package.version,
			"1.2.3",
		);
		assert.equal(
			resolve(f, "opus").loaded.find((e) => e.kind === "required-skill").package
				.version,
			"1.4.5",
		);
		assert.equal(
			resolve(f, "slim-llm").loaded.find((e) => e.kind === "required-skill")
				.package.version,
			"1.4.5",
		);
		for (const version of versions)
			assert.equal(
				lookupPackage({
					storeRoot: f.storeRoot,
					name: "@example/reviewer",
					version,
				}).sha256,
				f.packages.get(`reviewer-${version}`).sha256,
			);
		assert.deepEqual(
			snapshot(f.storeRoot),
			original,
			"changing one exact selection neither repoints nor deletes releases",
		);
	},
);

workflowTest(
	"requiring orchestrator checks actual selected worker peers using named major one across package majors",
	(t) => {
		const f = fixture(t),
			records = adopt(f);
		activate(f, config3(f, records));
		const result = resolve(f, "opus", "coordinator");
		assert.deepEqual(result.workflow, {
			status: "declared-compatible",
			runtime: "unverified",
			peers: peerRows(records),
		});
		assert.equal(
			result.loaded.filter((e) => e.id === "reviewer").length,
			0,
			"workers are checked, not injected into the orchestrator",
		);
		assert.ok(formatProof(result).includes(protocol));
		for (const version of versions)
			assert.ok(formatProof(result).includes(version));
	},
);

workflowTest(
	"required workflow is a distinct ordered backed context part counted by proof and selected-only loading",
	(t) => {
		const f = fixture(t),
			records = adopt(f);
		activate(f, config3(f, records));
		const result = resolve(f),
			pkg = f.packages.get("reviewer-1.2.3");
		assert.deepEqual(
			result.loaded.map((e) => e.kind),
			["profile", "role", "required-skill", "workflow"],
		);
		const part = result.loaded[3];
		assert.equal(part.id, "reviewer");
		assert.equal(part.binding, "skills.reviewer");
		assert.deepEqual(part.backing, {
			type: "package",
			sha256: pkg.sha256,
			path: "WORKFLOW.md",
		});
		assert.equal(part.content, pkg.workflow);
		assert.equal(part.bytes, Buffer.byteLength(pkg.workflow));
		assert.equal(result.diagnostics.managed.total.files, 4);
		assert.equal(
			result.diagnostics.managed.total.bytes,
			result.loaded.reduce((n, e) => n + Buffer.byteLength(e.content), 0),
		);
		assert.ok(formatProof(result).includes("WORKFLOW.md"));
		assert.ok(
			formatContext(result, { root: f.root, storeRoot: f.storeRoot }).includes(
				pkg.workflow,
			),
		);
		assert.equal(
			result.loaded.some((e) => e.id === "extra"),
			false,
		);
		assert.equal(
			result.loaded.some((e) => e.content.includes("Retained resource;")),
			false,
		);
		const requested = resolve(f, "local-llm", "worker", ["extra"]);
		assert.deepEqual(
			requested.loaded.slice(-2).map((e) => e.kind),
			["requested-skill", "workflow"],
		);
		assert.equal(
			requested.loaded.at(-1).content,
			f.packages.get("extra").workflow,
		);
	},
);

workflowTest(
	"stamp2 and materialization retain task workflow metadata and peers after mutable sources disappear",
	(t) => {
		const f = fixture(t),
			records = adopt(f);
		activate(f, config3(f, records));
		const captured = createStamp({
			...f.input,
			...assignment("opus", "coordinator"),
		});
		assert.equal(captured.snapshot.stampVersion, 2);
		assert.equal(captured.snapshot.configurationVersion, 3);
		assert.deepEqual(captured.snapshot.capture, {
			kind: "active",
			migration: null,
			candidate: null,
		});
		assert.deepEqual(captured.snapshot.workflowPeers, peerRows(records));
		assert.equal(
			captured.snapshot.packages.find((p) => p.name === "@example/orchestrator")
				.revisionDigest,
			records.get("orchestrator").recordDigest,
		);
		const rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: captured.digest,
		});
		const part = rebuilt.composition.find((e) => e.kind === "workflow");
		assert.deepEqual(
			part.bytes,
			Buffer.from(f.packages.get("orchestrator").workflow),
		);
		fs.rmSync(f.sources, { recursive: true });
		fs.rmSync(f.root, { recursive: true });
		fs.unlinkSync(path.join(f.dir, "revision.json"));
		assert.deepEqual(
			reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
			rebuilt,
		);
		const destination = materialize(f, captured.digest, "workflow");
		assert.deepEqual(
			JSON.parse(
				fs.readFileSync(
					path.join(destination, "content/snapshot.json"),
					"utf8",
				),
			).workflowPeers,
			peerRows(records),
		);
		const plan = planMaterialization({
			stampDigest: captured.digest,
			storeRoot: f.storeRoot,
			adapterId: "filesystem-v1",
			adapterContractVersion: 1,
		});
		const mappings = plan.mappings.filter(
			(r) =>
				r.sourceDigest === f.packages.get("orchestrator").sha256 &&
				r.sourcePath === "WORKFLOW.md" &&
				r.outputPath.startsWith("content/instructions/"),
		);
		assert.equal(mappings.length, 1);
		assert.deepEqual(
			fs.readFileSync(path.join(destination, mappings[0].outputPath)),
			part.bytes,
		);
		const peerBacking = path.join(
			f.storeRoot,
			"objects/sha256",
			f.packages.get("reviewer-2.3.4").sha256,
			"tree/WORKFLOW.md",
		);
		const peerBefore = fs.readFileSync(peerBacking);
		put(peerBacking, "# Tampered peer workflow\n");
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
				.managedReproducible,
			false,
		);
		assert.throws(
			() =>
				reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
			/workflow|peer|digest mismatch|reconstruction|backing/i,
		);
		put(peerBacking, peerBefore);
		const backing = path.join(
			f.storeRoot,
			"objects/sha256",
			f.packages.get("orchestrator").sha256,
			"tree/WORKFLOW.md",
		);
		put(backing, "# Tampered accepted workflow\n");
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
				.managedReproducible,
			false,
		);
		assert.throws(
			() =>
				reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
			/digest mismatch|reconstruction|backing/i,
		);
	},
);

workflowTest(
	"workflow readiness refuses missing unknown incompatible or unloaded peers with no writes",
	(t) => {
		const f = fixture(t),
			records = adopt(f),
			good = config3(f, records);
		activate(f, good);
		assert.equal(
			resolve(f, "opus", "coordinator").workflow.status,
			"declared-compatible",
		);
		const cases = [
			[
				(v) => {
					delete v.workflow_links;
				},
				/workflow.*(?:link|required|missing)/i,
			],
			[
				(v) => {
					v.workflow_links.checkin.providers[0].binding = "skills.extra";
				},
				/workflow.*(?:provide|protocol|loaded)|provider.*(?:loaded|protocol)/i,
			],
			[
				(v) => {
					v.roles.worker.skills = {
						required: [],
						available: ["reviewer", "extra", "note"],
					};
				},
				/provider.*(?:loaded|required)|workflow.*(?:loaded|provider)/i,
			],
			[
				(v) => {
					delete v.assignments["worker-0"].bindings["skills.reviewer"].revision;
				},
				/workflow.*(?:unknown|declaration)|provider.*(?:unknown|metadata)/i,
			],
		];
		for (const [mutate, diagnostic] of cases) {
			const value = copy(good);
			mutate(value);
			activate(f, value);
			refuses(f, () => resolve(f, "opus", "coordinator"), diagnostic);
		}
		activate(f, good);
		for (const [workflow, diagnostic] of [
			[
				provides(2),
				/workflow.*(?:major|incompatible)|protocol.*(?:major|incompatible)/i,
			],
			[
				null,
				/workflow.*(?:unknown|declaration)|provider.*(?:unknown|metadata)/i,
			],
		]) {
			const g = fixture(t),
				altered = adopt(g, (value, key) => {
					if (key === "reviewer-2.3.4") value.workflow = workflow;
				});
			const value = config3(g, altered);
			activate(g, value);
			refuses(g, () => resolve(g, "opus", "coordinator"), diagnostic);
		}
	},
);

workflowTest(
	"distinct loaded providers conflict while exact dependency reuse and multiple worker actors remain valid",
	(t) => {
		const f = fixture(t),
			records = adopt(f, (value, key) => {
				if (key === "extra") value.workflow = provides(1);
			});
		const value = config3(f, records);
		value.roles.worker.skills.required.push("extra");
		value.roles.worker.skills.available = ["note"];
		activate(f, value);
		refuses(
			f,
			() => resolve(f, "opus", "coordinator"),
			/workflow.*(?:conflict|multiple|ambiguous)|provider.*(?:conflict|multiple)/i,
		);
		const g = fixture(t),
			reused = adopt(g, (entry, key, retained) => {
				if (key === "extra")
					entry.dependencies = [
						{
							name: "@example/reviewer",
							version: "1.2.3",
							sha256: g.packages.get("reviewer-1.2.3").sha256,
							revisionDigest: retained.get("reviewer-1.2.3").recordDigest,
						},
					];
			});
		const selected = config3(g, reused);
		selected.roles.worker.skills.required.push("extra");
		selected.roles.worker.skills.available = ["note"];
		selected.workflow_links.checkin.providers = [
			selected.workflow_links.checkin.providers[0],
		];
		activate(g, selected);
		const result = resolve(g),
			pkg = g.packages.get("reviewer-1.2.3");
		assert.equal(
			result.loaded.filter(
				(e) =>
					e.backing?.sha256 === pkg.sha256 && e.backing.path === "SKILL.md",
			).length,
			1,
		);
		assert.equal(
			result.loaded.filter(
				(e) =>
					e.backing?.sha256 === pkg.sha256 && e.backing.path === "WORKFLOW.md",
			).length,
			1,
		);
		assert.equal(
			resolve(g, "opus", "coordinator").workflow.status,
			"declared-compatible",
		);
	},
);

workflowTest(
	"companion declaration rejects unsafe noninstruction or invalid text backing rather than treating resources as loaded",
	(t) => {
		const f = fixture(t),
			good = manifest(f, "reviewer-1.2.3");
		for (const file of [
			"../WORKFLOW.md",
			"/WORKFLOW.md",
			"C:/WORKFLOW.md",
			"SKILL.md",
			"data.bin",
			"missing.md",
			"package.yaml",
		]) {
			const value = copy(good);
			value.workflow.file = file;
			refuses(
				f,
				() => retain(f, value),
				/workflow|companion|path|entrypoint|Markdown|member|missing|ENOENT/i,
			);
		}
		for (const bytes of [
			Buffer.from([255, 254]),
			Buffer.from("# Invalid\0workflow\n"),
		]) {
			const g = fixture(t, bytes);
			assert.equal(
				resolve(g).loaded[2].content,
				g.packages.get("reviewer-1.2.3").entry,
				"legacy fixture is valid before workflow opt-in",
			);
			refuses(
				g,
				() => retain(g, manifest(g, "reviewer-1.2.3")),
				/workflow|companion|UTF|encoding|NUL/i,
			);
		}
		const target = path.join(
			f.storeRoot,
			"objects/sha256",
			f.packages.get("reviewer-1.2.3").sha256,
			"tree/WORKFLOW.md",
		);
		const outside = path.join(f.dir, "owned-outside.md");
		put(outside, f.packages.get("reviewer-1.2.3").workflow);
		fs.unlinkSync(target);
		fs.linkSync(outside, target);
		refuses(f, () => retain(f, good), /link|unsafe store member|nlink/i);
		fs.unlinkSync(target);
		put(target, f.packages.get("reviewer-1.2.3").workflow);
		const outsideDirectory = path.join(f.dir, "owned-workflows");
		put(
			path.join(outsideDirectory, "WORKFLOW.md"),
			"# Owned external workflow\n",
		);
		fs.symlinkSync(
			outsideDirectory,
			path.join(path.dirname(target), "redirect"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const redirected = copy(good);
		redirected.workflow.file = "redirect/WORKFLOW.md";
		refuses(f, () => retain(f, redirected), /link|junction|unsafe|member/i);
	},
);

workflowTest(
	"adoption record validates strict workflow shapes and matching existing release identity before retention",
	(t) => {
		const f = fixture(t),
			good = manifest(f, "reviewer-1.2.3");
		const values = [
			null,
			[],
			{ ...good, surprise: true },
			{ ...good, revisionVersion: 2 },
			{ ...good, kind: "candidate" },
			{ ...good, parent: { name: "@example/other" } },
			{ ...good, candidate: "unverified" },
			{
				...good,
				workflow: {
					file: null,
					provides: [{ protocol, major: 1 }],
					requires: [],
				},
			},
		];
		for (const field of ["workflow", "provenance", "content", "identity"]) {
			const value = copy(good);
			delete value[field];
			values.push(value);
		}
		for (const invalid of [
			null,
			"1",
			0,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			const value = copy(good);
			value.workflow.provides[0].major = invalid;
			values.push(value);
		}
		for (const invalid of [
			null,
			{},
			"text",
			[
				{ protocol, major: 1 },
				{ protocol, major: 1 },
			],
		]) {
			const value = copy(good);
			value.workflow.provides = invalid;
			values.push(value);
		}
		const unknown = copy(good);
		unknown.workflow.unverified = true;
		values.push(unknown);
		const unnamespaced = copy(good);
		unnamespaced.workflow.provides[0].protocol = "checkin";
		values.push(unnamespaced);
		for (const value of values)
			refuses(
				f,
				() => retain(f, value),
				/revision|workflow|protocol|major|field|record|identity|content|provenance|parent|candidate|release|integer/i,
			);
		const wrong = copy(good);
		wrong.content.sha256 = f.packages.get("reviewer-1.4.5").sha256;
		refuses(
			f,
			() => retain(f, wrong),
			/legacy.*(?:digest|content)|identity.*(?:mismatch|conflict)|content.*(?:mismatch|digest)/i,
		);
		const absent = copy(good);
		absent.identity.version = "9.9.9";
		absent.content.identity.version = "9.9.9";
		refuses(
			f,
			() => retain(f, absent),
			/legacy|existing release|identity.*missing/i,
		);
		const unknownWorkflow = { ...good, workflow: null };
		assert.equal(
			retain(f, unknownWorkflow).status,
			"published",
			"unknown may be retained but never counts as provided compatibility",
		);
		const g = fixture(t),
			none = manifest(g, "reviewer-1.2.3");
		none.workflow = { file: null, provides: [], requires: [] };
		assert.equal(retain(g, none).status, "published");
	},
);

workflowTest(
	"config3 preflight validates inactive fields and mixed versions before acquiring from an empty store",
	(t) => {
		const f = fixture(t),
			records = adopt(f),
			good = config3(f, records);
		activate(f, good);
		assert.equal(resolve(f).lockState, "valid");
		const cases = [
			[
				(v) => {
					v.skills.extra.revision = "bad";
				},
				/skills\.extra.*revision|revision.*digest/i,
			],
			[
				(v) => {
					v.assignments["worker-2"].bindings["skills.reviewer"].surprise = true;
				},
				/worker-2.*(?:surprise|field)|surprise.*field/i,
			],
			[
				(v) => {
					v.workflow_links.checkin.providers = null;
				},
				/providers.*(?:array|list)/i,
			],
			[
				(v) => {
					v.workflow_links.checkin.providers = [];
				},
				/providers.*(?:nonempty|empty|required)/i,
			],
			[
				(v) => {
					v.version = 2;
				},
				/version 3|requires.*3|unknown.*(?:revision|bindings|workflow)/i,
			],
			[
				(v) => {
					v.version = 4;
				},
				/version.*(?:supported|unsupported)/i,
			],
		];
		for (const [mutate, diagnostic] of cases) {
			const value = copy(good);
			mutate(value);
			put(f.configFile, stringify(value));
			const project = snapshot(f.root),
				empty = snapshot(f.empty);
			assert.throws(
				() => installDependencies({ root: f.root, storeRoot: f.empty }),
				diagnostic,
			);
			assert.deepEqual(snapshot(f.root), project);
			assert.deepEqual(snapshot(f.empty), empty);
		}
		put(f.configFile, stringify(good));
		const lockFile = path.join(f.root, ".agent-profiles/agent-profiles.lock"),
			before = fs.readFileSync(lockFile);
		activate(f, f.config);
		const oldLock = fs.readFileSync(lockFile);
		put(f.configFile, stringify(good));
		refuses(
			f,
			() => resolve(f),
			/lockVersion|lock version|lock2|lock 2|requires.*(?:v3|version 3).*install/i,
		);
		assert.deepEqual(fs.readFileSync(lockFile), oldLock);
		put(lockFile, before);
	},
);

workflowTest(
	"public revision resolve proof stamp verify and materialize honor explicit stores and expose real workflow parts",
	(t) => {
		const f = fixture(t),
			records = new Map();
		for (const key of f.packages.keys()) {
			const value = manifest(f, key),
				manifestFile = path.join(f.dir, "cli-revision.json");
			put(manifestFile, JSON.stringify(value));
			const retained = JSON.parse(
				invoke(f, ["revision", "record", manifestFile, "--json"]),
			);
			assert.equal(retained.status, "published");
			assert.equal(
				retained.recordDigest,
				hashRecord("agent-profiles/revision/v1", value),
			);
			records.set(key, retained);
			const before = snapshot(f.storeRoot),
				text = invoke(f, ["revision", "record", manifestFile]);
			assert.match(text, /revision|record/i);
			assert.ok(text.includes(retained.recordDigest));
			assert.ok(text.includes(value.identity.version));
			assert.deepEqual(
				snapshot(f.storeRoot),
				before,
				"text replay verifies and reuses the immutable record",
			);
		}
		activate(f, config3(f, records));
		const args = [
			"--role",
			"coordinator",
			"--model",
			"opus",
			"--host",
			"claude",
		];
		for (const ambient of [f.empty, f.ambient]) {
			const result = JSON.parse(
				invoke(f, ["resolve", ...args, "--json", "--contents"], ambient),
			);
			assert.deepEqual(result.workflow.peers, peerRows(records));
			assert.equal(
				result.loaded.find((e) => e.kind === "workflow").content,
				f.packages.get("orchestrator").workflow,
			);
			const proof = JSON.parse(
				invoke(f, ["proof", ...args, "--json"], ambient),
			);
			assert.equal(proof.diagnostics.managed.total.files, 4);
			assert.ok(invoke(f, ["proof", ...args], ambient).includes("WORKFLOW.md"));
			assert.ok(
				invoke(f, ["resolve", ...args], ambient).includes(
					f.packages.get("orchestrator").workflow,
				),
			);
			const captured = JSON.parse(
				invoke(f, ["stamp", ...args, "--json"], ambient),
			);
			assert.equal(captured.snapshot.stampVersion, 2);
			assert.deepEqual(captured.snapshot.workflowPeers, peerRows(records));
			assert.equal(
				JSON.parse(invoke(f, ["verify", captured.digest, "--json"], ambient))
					.managedReproducible,
				true,
			);
			const destination = path.join(
				f.outputRoot,
				ambient === f.empty ? "cli-empty" : "cli-misleading",
			);
			const receipt = JSON.parse(
				invoke(
					f,
					[
						"materialize",
						captured.digest,
						"--adapter",
						"filesystem-v1",
						"--output-root",
						f.outputRoot,
						"--destination",
						destination,
						"--json",
					],
					ambient,
				),
			);
			assert.equal(receipt.status, "committed");
			const plan = planMaterialization({
				stampDigest: captured.digest,
				storeRoot: f.storeRoot,
				adapterId: "filesystem-v1",
				adapterContractVersion: 1,
			});
			const part = plan.mappings.find(
				(r) =>
					r.sourcePath === "WORKFLOW.md" &&
					r.outputPath.startsWith("content/instructions/"),
			);
			assert.ok(part);
			assert.deepEqual(
				fs.readFileSync(path.join(destination, part.outputPath)),
				Buffer.from(f.packages.get("orchestrator").workflow),
			);
		}
	},
);

// C tests retain records by digest; label indexes are lookup inputs, not historical evidence.
function cRecord(f, recordDigest) {
	const value = revisions.lookupRevisionManifest({
		storeRoot: f.storeRoot,
		recordDigest,
	});
	const file = path.join(
		f.storeRoot,
		"revisions/sha256",
		`${recordDigest}.json`,
	);
	const bytes = fs.readFileSync(file);
	assert.deepEqual(JSON.parse(bytes.toString("utf8")), value);
	assert.equal(hashRecord("agent-profiles/revision/v1", value), recordDigest);
	return { file, bytes };
}
function cReadOnly(f, operation) {
	const roots = [f.root, f.storeRoot, f.ambient];
	const before = roots.map((root) =>
		fs.existsSync(root) ? snapshot(root) : null,
	);
	try {
		return operation();
	} finally {
		assert.deepEqual(
			roots.map((root) => (fs.existsSync(root) ? snapshot(root) : null)),
			before,
		);
	}
}
function cForgetMutable(f) {
	fs.rmSync(f.sources, { recursive: true });
	fs.rmSync(f.root, { recursive: true });
	fs.unlinkSync(path.join(f.dir, "revision.json"));
	fs.rmSync(path.join(f.storeRoot, "revisions/labels"), { recursive: true });
}
function cExportRecords(destination, records) {
	const files = [];
	function visit(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(file);
			else files.push(fs.readFileSync(file));
		}
	}
	visit(path.join(destination, "content"));
	for (const record of records)
		assert.equal(
			files.filter((bytes) => bytes.equals(record.bytes)).length,
			1,
			"export includes one actual canonical record, not just its digest",
		);
}
function cMetadataRefuses(f, digest) {
	cReadOnly(f, () => {
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest }).managedReproducible,
			false,
		);
		assert.throws(
			() => reconstructStamp({ storeRoot: f.storeRoot, digest }),
			/revision|metadata|record|integrity|digest mismatch|backing/i,
		);
	});
}

test("C alias capture preserves dependency-first raw bodies direct pins and retained exports", (t) => {
	const f = fixture(t),
		records = adopt(f, (value, key, retained) => {
			if (key === "extra") {
				const reviewer = retained.get("reviewer-1.2.3");
				value.dependencies = [
					{
						...reviewer.identity,
						sha256: reviewer.sha256,
						revisionDigest: reviewer.recordDigest,
					},
				];
			}
		});
	const value = config3(f, records);
	delete value.workflow_links;
	value.skills["reviewer-copy"] = copy(value.skills.reviewer);
	value.roles.worker.skills = {
		required: ["extra", "reviewer", "reviewer-copy"],
		available: ["note"],
	};
	activate(f, value);
	const result = resolve(f),
		reviewer = f.packages.get("reviewer-1.2.3"),
		extra = f.packages.get("extra");
	assert.deepEqual(
		result.loaded
			.slice(2)
			.map((part) => [part.kind, part.backing.sha256, part.backing.path]),
		[
			["required-skill", reviewer.sha256, "SKILL.md"],
			["workflow", reviewer.sha256, "WORKFLOW.md"],
			["required-skill", extra.sha256, "SKILL.md"],
			["workflow", extra.sha256, "WORKFLOW.md"],
		],
	);
	for (const id of ["reviewer", "reviewer-copy"]) {
		const direct = result.required.find((item) => item.id === id);
		assert.equal(direct.package.binding, `skills.${id}`);
		assert.equal(
			direct.package.revisionDigest,
			records.get("reviewer-1.2.3").recordDigest,
		);
		assert.equal(direct.bytes, Buffer.byteLength(reviewer.entry));
		assert.equal(direct.characters, [...reviewer.entry].length);
	}
	assert.equal(
		result.diagnostics.managed.total.bytes,
		result.loaded.reduce(
			(sum, part) => sum + Buffer.byteLength(part.content),
			0,
		),
	);
	const metadata = [
		cRecord(f, records.get("extra").recordDigest),
		cRecord(f, records.get("reviewer-1.2.3").recordDigest),
	];
	const captured = createStamp(f.input),
		rebuilt = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: captured.digest,
		});
	assert.equal(captured.snapshot.stampVersion, 2);
	assert.deepEqual(
		rebuilt.composition.map((part) => [part.kind, part.bytes]),
		result.loaded.map((part) => [part.kind, Buffer.from(part.content)]),
	);
	assert.deepEqual(
		rebuilt.composition.map((part) => part.package),
		result.loaded.map((part) => part.package ?? null),
	);
	for (const direct of result.required)
		assert.deepEqual(
			rebuilt.required.find((item) => item.id === direct.id).package,
			direct.package,
		);
	assert.deepEqual(
		rebuilt.packages
			.find((pkg) => pkg.sha256 === reviewer.sha256)
			.files.find((file) => file.path === "data.bin").bytes,
		Buffer.from([0, 255, 13, 10]),
	);
	assert.deepEqual(
		rebuilt.resources.find(
			(resource) => resource.backing.path === "instructions/reference.md",
		).bytes,
		fs.readFileSync(path.join(f.root, "instructions/reference.md")),
	);
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
	cForgetMutable(f);
	assert.deepEqual(
		cReadOnly(f, () =>
			reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
		),
		rebuilt,
	);
	const destination = materialize(f, captured.digest, "alias-capture");
	cExportRecords(destination, metadata);
	const plan = planMaterialization({
		stampDigest: captured.digest,
		storeRoot: f.storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
	});
	assert.equal(
		new Set(plan.files.map((file) => file.path)).size,
		plan.files.length,
	);
	assert.equal(
		plan.files.filter((file) =>
			file.path.startsWith(`content/packages/sha256/${reviewer.sha256}/`),
		).length,
		rebuilt.packages.find((pkg) => pkg.sha256 === reviewer.sha256).files.length,
	);
	const tasks = plan.mappings.filter(
		(row) =>
			row.sourceDigest === reviewer.sha256 &&
			row.sourcePath === "SKILL.md" &&
			row.outputPath.startsWith("content/instructions/"),
	);
	assert.equal(new Set(tasks.map((row) => row.outputPath)).size, 1);
	for (const id of ["reviewer", "reviewer-copy"])
		assert.ok(
			plan.mappings.some(
				(row) =>
					row.binding === `skills.${id}` &&
					row.sourceDigest === reviewer.sha256,
			),
		);
});

function cTamperSelectedMetadata(t, peer) {
	const f = fixture(t),
		records = adopt(f);
	activate(f, config3(f, records));
	const selectors = peer
		? assignment("opus", "coordinator")
		: assignment("local-llm");
	const result = resolveInstructions({ ...f.input, ...selectors });
	assert.equal(result.workflow.status, "declared-compatible");
	if (peer) assert.deepEqual(result.workflow.peers, peerRows(records));
	const key = peer ? "reviewer-2.3.4" : "reviewer-1.2.3",
		pkg = f.packages.get(key);
	const retained = cRecord(f, records.get(key).recordDigest);
	const captured = createStamp({ ...f.input, ...selectors });
	const rebuilt = reconstructStamp({
		storeRoot: f.storeRoot,
		digest: captured.digest,
	});
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
	try {
		put(retained.file, Buffer.concat([retained.bytes, Buffer.from(" ")]));
		assert.equal(
			lookupPackage({
				storeRoot: f.storeRoot,
				name: pkg.name,
				version: pkg.version,
			}).sha256,
			pkg.sha256,
			"tree remains valid",
		);
		cMetadataRefuses(f, captured.digest);
	} finally {
		put(retained.file, retained.bytes);
	}
	assert.equal(
		cReadOnly(f, () =>
			verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
		).managedReproducible,
		true,
	);
	assert.deepEqual(
		cReadOnly(f, () =>
			reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
		),
		rebuilt,
	);
}
test("C selected root revision metadata corruption refuses without changing valid tree bytes", (t) =>
	cTamperSelectedMetadata(t, false));
test("C selected peer revision metadata corruption refuses without changing valid tree bytes", (t) =>
	cTamperSelectedMetadata(t, true));

test("C rehashed snapshot refuses a valid but wrongly selected peer revision", async (t) => {
	const f = fixture(t),
		records = adopt(f);
	activate(f, config3(f, records));
	const result = resolve(f, "opus", "coordinator");
	assert.deepEqual(result.workflow.peers, peerRows(records));
	cRecord(f, records.get("reviewer-1.2.3").recordDigest);
	cRecord(f, records.get("reviewer-1.4.5").recordDigest);
	const captured = createStamp({
		...f.input,
		...assignment("opus", "coordinator"),
	});
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
	const changed = copy(captured.snapshot);
	changed.workflowPeers[0].provider.revisionDigest =
		records.get("reviewer-1.4.5").recordDigest;
	assert.notEqual(
		changed.workflowPeers[0].provider.revisionDigest,
		captured.snapshot.workflowPeers[0].provider.revisionDigest,
	);
	const digest = hashRecord("agent-profiles/stamp/v2", changed);
	assert.notEqual(digest, captured.digest);
	const { canonicalJSON } = await import("../src/packages.js");
	const file = path.join(f.storeRoot, "stamps/sha256", digest, "snapshot.json");
	assert.equal(
		fs.existsSync(path.dirname(file)),
		false,
		"new owned snapshot directory",
	);
	put(file, canonicalJSON(changed));
	assert.equal(
		hashRecord(
			"agent-profiles/stamp/v2",
			JSON.parse(fs.readFileSync(file, "utf8")),
		),
		digest,
		"self-hash is valid",
	);
	cReadOnly(f, () => {
		assert.equal(
			verifyStamp({ storeRoot: f.storeRoot, digest }).managedReproducible,
			false,
		);
		assert.throws(
			() => reconstructStamp({ storeRoot: f.storeRoot, digest }),
			/peer|relation|selection|binding/i,
		);
	});
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
});

test("C native peer capture retains actual empty root metadata and providing dependency independently", (t) => {
	const f = fixture(t),
		records = adopt(f),
		source = path.join(f.sources, "invoke");
	const entry =
		"---\r\nname: invoke\r\ndescription: Fictional native invocation\r\n---\r\nNative body is never injected.\r\n";
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: "@example/invoke", version: "1.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "native", hosts: ["claude"], effects: [] },
		}),
	);
	put(path.join(source, "SKILL.md"), entry);
	const native = importPackage({
			sourceDirectory: source,
			storeRoot: f.storeRoot,
		}),
		dependency = records.get("reviewer-1.2.3");
	const declaration = manifest(f, "extra");
	declaration.identity = native.identity;
	declaration.content = { identity: native.identity, sha256: native.sha256 };
	declaration.workflow = { file: null, provides: [], requires: [] };
	declaration.dependencies = [
		{
			...dependency.identity,
			sha256: dependency.sha256,
			revisionDigest: dependency.recordDigest,
		},
	];
	const nativeRecord = retain(f, declaration),
		value = config3(f, records);
	value.skills.invoke = {
		package: native.identity.name,
		version: native.identity.version,
		revision: nativeRecord.recordDigest,
	};
	value.roles.worker.skills = { required: ["invoke"], available: [] };
	value.workflow_links.checkin.providers = [
		{ assignment: assignment("local-llm"), binding: "skills.invoke" },
	];
	activate(f, value);
	const worker = resolve(f),
		root = worker.required.find((item) => item.id === "invoke");
	assert.equal(root.type, "host");
	assert.equal(root.delivery, "invoke");
	assert.equal(root.bytes, null);
	assert.equal(worker.workflow.status, "declared-compatible");
	assert.equal(worker.workflow.runtime, "unverified");
	assert.equal(
		worker.loaded.some((part) => part.backing?.sha256 === native.sha256),
		false,
	);
	assert.equal(
		worker.loaded.filter(
			(part) =>
				part.backing?.sha256 === dependency.sha256 &&
				part.backing.path === "SKILL.md",
		).length,
		1,
	);
	const result = resolve(f, "opus", "coordinator");
	const peers = [
		{
			protocol,
			major: 1,
			consumer: {
				assignment: assignment("opus", "coordinator"),
				binding: "skills.orchestrator",
				revisionDigest: records.get("orchestrator").recordDigest,
			},
			provider: {
				assignment: assignment("local-llm"),
				binding: "skills.invoke",
				revisionDigest: dependency.recordDigest,
			},
		},
	];
	assert.deepEqual(result.workflow.peers, peers);
	assert.equal(
		result.loaded.some((part) =>
			[native.sha256, dependency.sha256].includes(part.backing?.sha256),
		),
		false,
	);
	const nativeBytes = cRecord(f, nativeRecord.recordDigest),
		dependencyBytes = cRecord(f, dependency.recordDigest);
	const captured = createStamp({
		...f.input,
		...assignment("opus", "coordinator"),
	});
	assert.deepEqual(captured.snapshot.workflowPeers, peers);
	const rebuilt = reconstructStamp({
		storeRoot: f.storeRoot,
		digest: captured.digest,
	});
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
	cForgetMutable(f);
	assert.deepEqual(
		cReadOnly(f, () =>
			reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
		),
		rebuilt,
	);
	const destination = materialize(f, captured.digest, "native-peer");
	cExportRecords(destination, [nativeBytes, dependencyBytes]);
	assert.deepEqual(
		fs.readFileSync(
			path.join(
				destination,
				"content/packages/sha256",
				native.sha256,
				"SKILL.md",
			),
		),
		Buffer.from(entry),
	);
	try {
		put(nativeBytes.file, Buffer.concat([nativeBytes.bytes, Buffer.from(" ")]));
		assert.deepEqual(
			fs.readFileSync(dependencyBytes.file),
			dependencyBytes.bytes,
		);
		cMetadataRefuses(f, captured.digest);
	} finally {
		put(nativeBytes.file, nativeBytes.bytes);
	}
	assert.equal(
		verifyStamp({ storeRoot: f.storeRoot, digest: captured.digest })
			.managedReproducible,
		true,
	);
});

test("C legacy available and adopted peer pins share one tree without global metadata opt-in", (t) => {
	const f = fixture(t),
		records = adopt(f),
		value = config3(f, records);
	delete value.skills.reviewer.revision;
	value.roles.coordinator.skills.available = ["reviewer"];
	value.workflow_links.checkin.providers = [
		{ assignment: assignment("local-llm"), binding: "skills.reviewer" },
	];
	activate(f, value);
	const result = resolve(f, "opus", "coordinator"),
		available = result.available.find((item) => item.id === "reviewer");
	assert.equal(available.package.revisionDigest, null);
	const worker = resolve(f),
		direct = worker.required.find((item) => item.id === "reviewer");
	assert.equal(
		direct.package.revisionDigest,
		records.get("reviewer-1.2.3").recordDigest,
	);
	assert.equal(available.package.sha256, direct.package.sha256);
	assert.equal(
		result.loaded.some(
			(part) => part.backing?.sha256 === direct.package.sha256,
		),
		false,
		"available and peer task stay uninjected",
	);
	assert.deepEqual(result.workflow.peers, peerRows(records).slice(0, 1));
	const metadata = cRecord(f, direct.package.revisionDigest);
	const captured = createStamp({
		...f.input,
		...assignment("opus", "coordinator"),
	});
	const rebuilt = reconstructStamp({
		storeRoot: f.storeRoot,
		digest: captured.digest,
	});
	assert.equal(
		rebuilt.available.find((item) => item.id === "reviewer").package
			.revisionDigest,
		null,
	);
	assert.deepEqual(captured.snapshot.workflowPeers, result.workflow.peers);
	cForgetMutable(f);
	assert.deepEqual(
		cReadOnly(f, () =>
			reconstructStamp({ storeRoot: f.storeRoot, digest: captured.digest }),
		),
		rebuilt,
	);
	const destination = materialize(f, captured.digest, "mixed-pins");
	cExportRecords(destination, [metadata]);
	const exported = JSON.parse(
		fs.readFileSync(path.join(destination, "content/snapshot.json"), "utf8"),
	);
	assert.equal(
		exported.available.find((item) => item.id === "reviewer").package
			.revisionDigest,
		null,
	);
	assert.deepEqual(exported.workflowPeers, result.workflow.peers);
	const plan = planMaterialization({
		stampDigest: captured.digest,
		storeRoot: f.storeRoot,
		adapterId: "filesystem-v1",
		adapterContractVersion: 1,
	});
	const tree = rebuilt.packages.find(
		(pkg) => pkg.sha256 === direct.package.sha256,
	);
	assert.equal(
		plan.files.filter((file) =>
			file.path.startsWith(`content/packages/sha256/${tree.sha256}/`),
		).length,
		tree.files.length,
	);
	assert.equal(
		new Set(plan.files.map((file) => file.path)).size,
		plan.files.length,
	);
	assert.ok(
		plan.mappings.some(
			(row) =>
				row.binding === "skills.reviewer" &&
				row.sourceDigest === tree.sha256 &&
				row.sourcePath === "SKILL.md",
		),
	);
});
