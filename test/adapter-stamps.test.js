// #98: stamps, verify/diff, session evidence and inspect with a project adapter.
// Committed-only stamps keep their 0.20.0 bytes; adapter stamps record the
// composed configuration and each contributing input by layer, without machine paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { LOCAL_REFERENCE, readAdapter } from "../src/adapter.ts";
import { inspectRepository } from "../src/inspect.ts";
import { publishPackage } from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { createSessionRecorder } from "../src/sessions.ts";
import { createStamp, diffStamps, verifyStamp } from "../src/stamps.ts";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
// A directory name that must never appear in exported stamps or evidence.
const SENTINEL = "SENTINEL-machine-path-98";

const put = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function publish(dir, store, name, version) {
	const source = path.join(dir, "sources", name.replace("/", "_"), version);
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name, version, type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(source, "SKILL.md"),
		`---\ndescription: "${name}"\n---\n# ${name} ${version}\n`,
	);
	publishPackage({ storeRoot: store, sourceDirectory: source });
}

/** A committed v2 project pinning one package skill. */
function project(root) {
	for (const id of ["constrained", "autonomous"])
		put(path.join(root, `.agent-profiles/profiles/${id}.md`), `# ${id}\n`);
	for (const id of ["implementer", "reviewer"])
		put(path.join(root, `.agent-profiles/roles/${id}.md`), `# ${id}\n`);
	put(path.join(root, "AGENTS.md"), "# Project rules\n");
	put(
		path.join(root, CONFIG),
		stringify({
			version: 2,
			default_profile: "constrained",
			default_role: "implementer",
			models: { "example-model": { profile: "autonomous" } },
			families: {},
			skills: { testing: { package: "@example/testing", version: "1.0.0" } },
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: ["testing"], available: [] },
				},
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	return fs.realpathSync(root);
}

const overlay = (version = "1.0.0") => ({
	version: 2,
	skills: { "shared-review": { package: "@example/review", version } },
	roles: {
		implementer: { skills: { required: ["shared-review"] } },
		auditor: {
			file: "roles/auditor.md",
			skills: { required: ["shared-review"], available: [] },
		},
	},
});

function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-adapter-stamps-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = path.join(dir, "store");
	publish(dir, store, "@example/testing", "1.0.0");
	for (const version of ["1.0.0", "1.1.0"])
		publish(dir, store, "@example/review", version);
	const root = project(path.join(dir, "project"));
	installDependencies({ root, storeRoot: store });
	const config = path.join(dir, SENTINEL, "workshop");
	put(path.join(config, CONFIG), stringify(overlay()));
	put(
		path.join(config, ".agent-profiles/roles/auditor.md"),
		"# auditor from the adapter\n",
	);
	const link = (extra = {}) =>
		put(
			path.join(root, LOCAL_REFERENCE),
			stringify({ adapter: `../${SENTINEL}/workshop`, ...extra }),
		);
	return { dir, store, root, config, link };
}

const stampBytes = (store, digest) =>
	fs.readFileSync(path.join(store, `stamps/sha256/${digest}/snapshot.json`));

test("committed-only stamps keep their 0.20.0 digests and bytes", (t) => {
	const f = fixture(t);
	const implementer = createStamp({ root: f.root, storeRoot: f.store });
	const reviewer = createStamp({
		root: f.root,
		storeRoot: f.store,
		role: "reviewer",
		model: "example-model",
		identitySource: "user",
	});
	// Goldens recorded with the unmodified 0.21.0 stamp code (unchanged since 0.20.0).
	assert.deepEqual(
		{
			implementer: implementer.digest,
			implementerBytes: sha(stampBytes(f.store, implementer.digest)),
			reviewer: reviewer.digest,
			reviewerBytes: sha(stampBytes(f.store, reviewer.digest)),
		},
		{
			implementer:
				"c88937d3e885fbf04902ac66f1ec7e1c7206fce63f8dd7b8ab9a8a00bb59e0b3",
			implementerBytes:
				"4f31112036ace2abcb439a2db0305c5784bf86ec81469b835afedb3492cddc2f",
			reviewer:
				"d2ee49210f4d7a879261f05a9922531def1a3ffaa4f1425aaf82ef4f3a3529f3",
			reviewerBytes:
				"df6c4aaa233cfc3b19bab00a0a02e5db9bc393bef0d1e741c08f8a53267dbb43",
		},
	);
	assert.equal("configurationSources" in implementer.snapshot, false);
	const report = verifyStamp({
		digest: implementer.digest,
		storeRoot: f.store,
	});
	assert.equal(report.managedReproducible, true);
	assert.equal("configuration" in report, false);
});

/** Composed mode: the fixture's adapter linked, labeled, and its lock installed. */
function composed(t, label = "workshop") {
	const f = fixture(t);
	f.link(label ? { label } : {});
	installDependencies({ root: f.root, storeRoot: f.store });
	return f;
}

const sources = (stamp) => stamp.snapshot.configurationSources;
const layerPaths = (stamp) =>
	sources(stamp).inputs.map((row) => `${row.layer} ${row.kind} ${row.path}`);

test("an adapter stamp captures the composed configuration and every input by layer", (t) => {
	const f = composed(t);
	const stamp = createStamp({
		root: f.root,
		storeRoot: f.store,
		role: "auditor",
	});
	const c = sources(stamp);
	assert.equal(c.mode, "composed");
	assert.deepEqual(c.adapter, {
		label: "workshop",
		referenceDigest: c.inputs[1].sha256,
	});
	assert.deepEqual(layerPaths(stamp), [
		"project configuration .agent-profiles/agents.yaml",
		"local reference .agent-profiles/agents.local.yaml",
		"adapter configuration .agent-profiles/agents.yaml",
		"adapter role .agent-profiles/roles/auditor.md",
		"adapter lock .agent-profiles/agent-profiles.lock",
	]);
	assert.equal(c.inputs[1].backing, null, "the reference is digest-only");
	assert.deepEqual(c.adapterEntries, [
		"roles.auditor",
		"roles.implementer.skills.required.shared-review",
		"skills.shared-review",
	]);
	// The configuration digest is the one the adapter lock covers.
	const lock = JSON.parse(fs.readFileSync(path.join(f.config, LOCK), "utf8"));
	assert.equal(c.configuration.digest, lock.configSha256);
	// The adapter role body is captured from the adapter, at its project path.
	const role = stamp.snapshot.composition.find((e) => e.kind === "role");
	assert.equal(role.backing.path, ".agent-profiles/roles/auditor.md");
	assert.equal(
		fs.readFileSync(
			path.join(f.store, "blobs/sha256", role.backing.sha256),
			"utf8",
		),
		"# auditor from the adapter\n",
	);
	assert.deepEqual(
		stamp.snapshot.required.map((e) => e.id),
		["shared-review"],
	);
	// Capture is deterministic: the same inputs give the same digest.
	assert.equal(
		createStamp({ root: f.root, storeRoot: f.store, role: "auditor" }).digest,
		stamp.digest,
	);
});

test("stamp -> verify round trip in adapter mode, through the CLI", (t) => {
	const f = composed(t);
	const home = path.join(f.dir, "home");
	const run = (...args) =>
		spawnSync(process.execPath, [cli, ...args, "--root", f.root], {
			encoding: "utf8",
			cwd: f.root,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				AGENT_PROFILES_STORE: f.store,
				AGENT_PROFILES_SESSIONS: path.join(home, "sessions"),
				AGENT_PROFILES_TRUST: path.join(home, "no-trust.yaml"),
			},
		});
	const stamped = run("stamp", "--json", "--store", f.store);
	assert.equal(stamped.status, 0, stamped.stderr);
	const { digest, snapshot } = JSON.parse(stamped.stdout);
	assert.equal(snapshot.configurationSources.mode, "composed");
	const verified = run("verify", digest, "--json", "--store", f.store);
	assert.equal(verified.status, 0, verified.stderr);
	const report = JSON.parse(verified.stdout);
	assert.equal(report.managedReproducible, true);
	assert.equal(report.configuration.configurationReproducible, true);
	assert.equal(report.configuration.composed, "reproducible");
	assert.equal(report.configuration.lockCoversConfiguration, true);
	assert.deepEqual(
		report.configuration.inputs.map((row) => `${row.layer}:${row.status}`),
		[
			"project:reproducible",
			"local:digest-only",
			"adapter:reproducible",
			"adapter:reproducible",
			"adapter:reproducible",
		],
	);
	// A lost adapter blob is reported per input, and verify fails.
	const role = snapshot.configurationSources.inputs.find(
		(row) => row.kind === "role",
	);
	fs.rmSync(path.join(f.store, "blobs/sha256", role.sha256));
	const broken = run("verify", digest, "--json", "--store", f.store);
	assert.equal(broken.status, 1);
	const failed = JSON.parse(broken.stdout);
	assert.equal(failed.configuration.configurationReproducible, false);
	assert.equal(
		failed.configuration.inputs.find((row) => row.kind === "role").status,
		"missing",
	);
	assert.match(failed.findings.join("\n"), /adapter .*auditor\.md missing/);

	// inspect and sessions now run with an adapter; record-session names the configuration.
	const inspected = run("inspect", "--json");
	assert.equal(inspected.status, 0, inspected.stderr);
	assert.equal(JSON.parse(inspected.stdout).repository.adapter.status, "valid");
	const recorded = run("resolve", "--record-session", "--store", f.store);
	assert.equal(recorded.status, 0, recorded.stderr);
	const sessions = run("sessions", "--json");
	assert.equal(sessions.status, 0, sessions.stderr);
	const entry = JSON.parse(sessions.stdout).sessions[0].resolutions[0];
	assert.equal(entry.configuration.mode, "composed");
	assert.equal(
		entry.configuration.digest,
		snapshot.configurationSources.configuration.digest,
	);
	assert.match(
		run("sessions").stdout,
		/configuration: composed with adapter workshop/,
	);
});

test("diff shows an adapter-only change apart from project changes", (t) => {
	const f = composed(t);
	const stamp = () =>
		createStamp({ root: f.root, storeRoot: f.store, role: "auditor" });
	const before = stamp();
	// Adapter-only change: a new pin and role text, then the separate install.
	put(path.join(f.config, CONFIG), stringify(overlay("1.1.0")));
	put(
		path.join(f.config, ".agent-profiles/roles/auditor.md"),
		"# auditor, revised in the adapter\n",
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	const after = stamp();
	assert.notEqual(after.digest, before.digest);
	const result = diffStamps({
		before: before.digest,
		after: after.digest,
		storeRoot: f.store,
	});
	assert.equal(result.complete, true);
	assert.equal(result.configuration.sameMode, true);
	assert.notEqual(
		result.configuration.before.configurationDigest,
		result.configuration.after.configurationDigest,
	);
	assert.equal(
		result.layers.project,
		0,
		JSON.stringify(result.changes, null, 1),
	);
	assert.equal(result.layers.local, 0);
	assert.ok(result.layers.adapter > 0);
	const adapterPaths = result.changes
		.filter((change) => change.layer === "adapter")
		.map((change) => change.path);
	assert.ok(
		adapterPaths.some((p) => p.startsWith("/configurationSources/inputs/2")),
	);
	assert.ok(
		adapterPaths.some((p) => p.startsWith("/composition/")),
		"role body",
	);
	assert.ok(
		adapterPaths.some((p) => p.startsWith("/required/")),
		"adapter skill",
	);

	// A project-only change is labeled project, with no adapter changes.
	const reviewer = () =>
		createStamp({ root: f.root, storeRoot: f.store, role: "reviewer" });
	const a = reviewer();
	put(
		path.join(f.root, ".agent-profiles/roles/reviewer.md"),
		"# reviewer, revised\n",
	);
	const b = reviewer();
	const project = diffStamps({
		before: a.digest,
		after: b.digest,
		storeRoot: f.store,
	});
	assert.ok(project.changes.length > 0);
	assert.deepEqual(
		[...new Set(project.changes.map((change) => change.layer))],
		["project"],
	);
	assert.equal(project.layers.adapter, 0);
});

test("evidence distinguishes composed and committed-only runs", (t) => {
	const f = composed(t);
	const sessions = path.join(f.dir, "sessions");
	const saved = process.env.AGENT_PROFILES_SESSIONS;
	process.env.AGENT_PROFILES_SESSIONS = sessions;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_SESSIONS;
		else process.env.AGENT_PROFILES_SESSIONS = saved;
	});
	const recorder = createSessionRecorder({
		source: "cli",
		agentProfiles: "test",
	});
	const record = () => {
		const selected = { root: f.root, storeRoot: f.store };
		recorder.record("cli", selected, resolveInstructions(selected));
	};
	record();
	const withAdapter = createStamp({ root: f.root, storeRoot: f.store });
	fs.renameSync(
		path.join(f.root, LOCAL_REFERENCE),
		path.join(f.dir, "aside.yaml"),
	);
	record();
	const committed = createStamp({ root: f.root, storeRoot: f.store });

	const [file] = fs
		.readdirSync(sessions, { recursive: true })
		.filter((p) => p.endsWith(".json"));
	const [composedRun, committedRun] = JSON.parse(
		fs.readFileSync(path.join(sessions, file), "utf8"),
	).resolutions;
	assert.deepEqual(composedRun.configuration, {
		mode: "composed",
		digest: sources(withAdapter).configuration.digest,
		adapter: sources(withAdapter).adapter,
	});
	assert.equal(composedRun.stamp, withAdapter.digest);
	assert.deepEqual(committedRun.configuration, { mode: "committed" });
	assert.equal(committedRun.stamp, committed.digest);
	assert.notEqual(composedRun.stamp, committedRun.stamp);

	// diff never reports a committed-only and a composed stamp as the same configuration.
	const result = diffStamps({
		before: committed.digest,
		after: withAdapter.digest,
		storeRoot: f.store,
	});
	assert.equal(result.configuration.sameMode, false);
	assert.equal(result.configuration.before.mode, "committed");
	assert.equal(result.configuration.after.mode, "composed");
	assert.ok(
		result.changes.some(
			(change) =>
				change.path === "/configurationSources" && change.layer === "adapter",
		),
	);
});

test("exported stamps and evidence carry no machine path", (t) => {
	const f = composed(t, null);
	// An absolute reference, the worst case for leaking a machine path.
	f.link({ adapter: f.config });
	installDependencies({ root: f.root, storeRoot: f.store });
	// Adapter approvals are recorded (bytes only; trust is checked live).
	const approvals = path.join(
		f.config,
		".agent-profiles/approvals/@example/review/1.0.0",
	);
	put(path.join(approvals, "someone@example.com.json"), '{"schema":1}\n');
	put(path.join(approvals, "someone@example.com.json.sig"), "signature\n");
	put(path.join(approvals, "notes.txt"), "ignored\n");
	const stamp = createStamp({ root: f.root, storeRoot: f.store });
	const [approval, ...more] = sources(stamp).approvals;
	assert.deepEqual(more, []);
	assert.deepEqual(
		[approval.package, approval.version, approval.principal],
		["@example/review", "1.0.0", "someone@example.com"],
	);
	assert.equal(approval.payload.path, "approval.json");
	assert.equal(approval.signature.path, "approval.json.sig");
	const report = verifyStamp({ digest: stamp.digest, storeRoot: f.store });
	assert.deepEqual(
		report.configuration.approvals.map((row) => row.status),
		["reproducible"],
	);
	// A changed approval is an adapter change in diff.
	put(path.join(approvals, "someone@example.com.json.sig"), "re-signed\n");
	const resigned = createStamp({ root: f.root, storeRoot: f.store });
	const diff = diffStamps({
		before: stamp.digest,
		after: resigned.digest,
		storeRoot: f.store,
	});
	assert.deepEqual(
		[...new Set(diff.changes.map((change) => change.layer))],
		["adapter"],
	);
	assert.ok(
		diff.changes.every((change) =>
			change.path.startsWith("/configurationSources/approvals/0/signature"),
		),
	);
	assert.equal(sources(stamp).adapter.label, null);

	const exported = [
		stampBytes(f.store, stamp.digest),
		...[
			sources(stamp).configuration.backing,
			...sources(stamp).inputs.map((row) => row.backing),
			...stamp.snapshot.composition.map((e) => e.backing),
		]
			.filter((b) => b?.type === "blob")
			.map((b) =>
				fs.readFileSync(path.join(f.store, "blobs/sha256", b.sha256)),
			),
		Buffer.from(
			JSON.stringify(verifyStamp({ digest: stamp.digest, storeRoot: f.store })),
		),
		Buffer.from(
			JSON.stringify(
				diffStamps({
					before: stamp.digest,
					after: stamp.digest,
					storeRoot: f.store,
				}),
			),
		),
	];
	const forms = (p) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\")];
	for (const bytes of exported) {
		const text = bytes.toString("utf8");
		assert.equal(text.includes(SENTINEL), false, text.slice(0, 200));
		for (const form of [...forms(f.dir), ...forms(os.tmpdir())])
			assert.equal(
				text.includes(form),
				false,
				`${form} in ${text.slice(0, 200)}`,
			);
	}
	// A label is a name, never a path.
	for (const label of [f.config, "a/b", "C:x", "..", ""]) {
		f.link({ label });
		assert.throws(() => readAdapter(f.root), /label: expected a name/);
	}
});

test("inspect lists the adapter's files and never reads outside its root", (t) => {
	const f = composed(t);
	put(path.join(f.dir, "outside.md"), "# outside the adapter\n");
	put(
		path.join(f.config, CONFIG),
		stringify({
			...overlay(),
			roles: {
				...overlay().roles,
				escape: { file: "../../outside.md", skills: { required: [] } },
			},
		}),
	);
	const result = inspectRepository({ root: f.root });
	const adapter = result.repository.adapter;
	assert.equal(adapter.status, "valid");
	assert.equal(adapter.label, "workshop");
	assert.deepEqual(adapter.entries, {
		skills: ["shared-review"],
		roles: ["auditor", "escape", "implementer"],
		assignments: [],
	});
	const files = Object.fromEntries(
		adapter.files.map((file) => [`${file.source} ${file.path}`, file]),
	);
	assert.equal(
		files["adapter-reference .agent-profiles/agents.local.yaml"].availability,
		"available",
	);
	assert.equal(
		files["adapter-configuration .agent-profiles/agents.yaml"].scope,
		"adapter",
	);
	assert.equal(
		files["adapter-lock .agent-profiles/agent-profiles.lock"].availability,
		"available",
	);
	assert.equal(
		files["adapter-role .agent-profiles/roles/auditor.md"].availability,
		"available",
	);
	const escaping = files["adapter-role .agent-profiles/../../outside.md"];
	assert.equal(escaping.availability, "unavailable");
	assert.equal(escaping.bytes, null, "not read");

	// Committed-only inspection has no adapter field.
	fs.rmSync(path.join(f.root, LOCAL_REFERENCE));
	assert.equal(
		"adapter" in inspectRepository({ root: f.root }).repository,
		false,
	);
});

test("an adapter stamp refuses a stale adapter lock", (t) => {
	const f = composed(t);
	put(path.join(f.config, CONFIG), stringify(overlay("1.1.0")));
	assert.throws(
		() => createStamp({ root: f.root, storeRoot: f.store }),
		/stale-lock/,
	);
});
