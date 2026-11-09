// #85: an ignored local reference composes one external adapter over the
// committed configuration without changing it, its lock, or its trust.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { LOCAL_REFERENCE, readAdapter } from "../src/adapter.ts";
import { approvalStatus, approvePackage } from "../src/approvals.ts";
import { doctor } from "../src/install.ts";
import { publishPackage } from "../src/library.ts";
import { previewUpdate } from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { keygen, noKeygen } from "./helpers/trust-fixture.js";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";

const put = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

/** Bytes of every file under a directory, for unchanged-ness checks. */
function tree(root) {
	const out = {};
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out[path.relative(root, full)] = fs.readFileSync(full, "utf8");
		}
	};
	walk(root);
	return out;
}

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

/** A committed v1 project shaped like Agent-Profiles' own defaults. */
function project(dir, name = "project") {
	const root = path.join(dir, name);
	for (const id of ["constrained", "autonomous"])
		put(path.join(root, `.agent-profiles/profiles/${id}.md`), `# ${id}\n`);
	for (const id of ["implementer", "reviewer"])
		put(path.join(root, `.agent-profiles/roles/${id}.md`), `# ${id}\n`);
	put(
		path.join(root, CONFIG),
		stringify({
			version: 1,
			default_profile: "constrained",
			default_role: "implementer",
			models: { "example-model": { profile: "autonomous" } },
			families: {},
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: [], available: [] },
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

function adapter(dir, name, config, files = {}) {
	const root = path.join(dir, name);
	put(path.join(root, CONFIG), stringify(config));
	for (const [file, text] of Object.entries(files))
		put(path.join(root, ".agent-profiles", file), text);
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
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-adapter-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = path.join(dir, "store");
	for (const version of ["1.0.0", "1.1.0"])
		publish(dir, store, "@example/review", version);
	const root = project(dir);
	const config = adapter(dir, "project-config", overlay(), {
		"roles/auditor.md": "# auditor from the adapter\n",
	});
	const link = (target = "../project-config") =>
		put(path.join(root, LOCAL_REFERENCE), stringify({ adapter: target }));
	return { dir, store, root, config, link };
}

const skillIds = (resolution) => resolution.required.map((skill) => skill.id);

test("without a local reference, resolution is the committed configuration", (t) => {
	const f = fixture(t);
	assert.equal(readAdapter(f.root), null);
	const resolved = resolveInstructions({ root: f.root, storeRoot: f.store });
	assert.equal(resolved.role, "implementer");
	assert.deepEqual(skillIds(resolved), []);
	assert.equal("adapter" in resolved, false);
	assert.throws(
		() =>
			resolveInstructions({
				root: f.root,
				role: "auditor",
				storeRoot: f.store,
			}),
		/auditor/,
	);
});

test("an adapter composes over a v1 project and writes only its own lock", (t) => {
	const f = fixture(t);
	f.link();
	const before = tree(f.root);
	installDependencies({ root: f.root, storeRoot: f.store });
	assert.ok(fs.existsSync(path.join(f.config, LOCK)), "adapter lock written");
	assert.equal(fs.existsSync(path.join(f.root, LOCK)), false);
	assert.deepEqual(tree(f.root), before, "project files unchanged");

	const implementer = resolveInstructions({ root: f.root, storeRoot: f.store });
	assert.deepEqual(skillIds(implementer), ["shared-review"]);
	assert.deepEqual(implementer.adapter.entries, [
		"roles.auditor",
		"roles.implementer.skills.required.shared-review",
		"skills.shared-review",
	]);
	assert.equal(implementer.adapter.root, f.config);
	assert.equal(implementer.lockState, "valid");

	const auditor = resolveInstructions({
		root: f.root,
		role: "auditor",
		storeRoot: f.store,
	});
	assert.deepEqual(skillIds(auditor), ["shared-review"]);
	const roleBody = auditor.loaded.find((entry) => entry.kind === "role");
	assert.match(roleBody.content, /auditor from the adapter/);

	// Model routing stays the project's.
	const routed = resolveInstructions({
		root: f.root,
		model: "example-model",
		storeRoot: f.store,
	});
	assert.equal(routed.profile, "autonomous");

	const report = doctor(f.root, { storeRoot: f.store });
	const notes = JSON.stringify(report);
	assert.match(notes, /composed with adapter \.\.\/project-config/);
});

test("adapter or reference changes make the lock stale", (t) => {
	const f = fixture(t);
	f.link();
	installDependencies({ root: f.root, storeRoot: f.store });
	put(path.join(f.config, CONFIG), stringify(overlay("1.1.0")));
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/project-config\/\.agent-profiles\/agent-profiles\.lock: stale-lock/,
	);
	assert.throws(
		() =>
			installDependencies({ root: f.root, storeRoot: f.store, frozen: true }),
		/stale-lock/,
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	assert.equal(
		resolveInstructions({ root: f.root, storeRoot: f.store }).required[0]
			.package.version,
		"1.1.0",
	);
});

test("a missing or invalid adapter is an error, never a fallback", (t) => {
	const f = fixture(t);
	f.link("../nowhere");
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/agents\.local\.yaml\.adapter: \.\.\/nowhere is not accessible.*delete \.agent-profiles\/agents\.local\.yaml/,
	);
	fs.mkdirSync(path.join(f.dir, "empty"));
	f.link("../empty");
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/has no \.agent-profiles\/agents\.yaml/,
	);
	f.link(".agent-profiles");
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/separate directory/,
	);
	put(
		path.join(f.root, LOCAL_REFERENCE),
		"adapter: ../project-config\nextra: 1\n",
	);
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/extra: unknown field/,
	);
	for (const file of ["trust.yaml", "agents.local.yaml"]) {
		f.link();
		put(path.join(f.config, ".agent-profiles", file), "version: 1\n");
		assert.throws(
			() => resolveInstructions({ root: f.root, storeRoot: f.store }),
			/cannot chain to another adapter or change trust policy/,
		);
		fs.rmSync(path.join(f.config, ".agent-profiles", file));
	}
});

test("precedence: the adapter adds but never overrides project policy", (t) => {
	const f = fixture(t);
	f.link();
	const attempt = (config, files) => {
		fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
		adapter(f.dir, "project-config", config, files);
		return () => resolveInstructions({ root: f.root, storeRoot: f.store });
	};
	assert.throws(
		attempt(
			{ ...overlay(), default_role: "auditor" },
			{ "roles/auditor.md": "x\n" },
		),
		/default_role: project policy/,
	);
	assert.throws(
		attempt(
			{ ...overlay(), models: { "example-model": { profile: "constrained" } } },
			{ "roles/auditor.md": "x\n" },
		),
		/models: project policy/,
	);
	assert.throws(
		attempt({
			version: 2,
			roles: { reviewer: { file: "roles/mine.md", skills: { required: [] } } },
		}),
		/roles\.reviewer\.file: unknown field/,
	);
	assert.throws(
		attempt({
			version: 2,
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
		/unknown field/,
	);
	assert.throws(
		attempt(
			{
				version: 2,
				roles: {
					auditor: {
						file: "roles/implementer.md",
						skills: { required: [], available: [] },
					},
				},
			},
			{ "roles/implementer.md": "x\n" },
		),
		/may not shadow project files/,
	);
	assert.throws(
		attempt({
			version: 2,
			skills: { local: { file: "skills/local/SKILL.md" } },
		}),
		/must bind a package/,
	);
	assert.throws(
		attempt({ ...overlay(), version: 3 }),
		/version 3 cannot compose with project version 1/,
	);
});

test("precedence: assignments come from the layer that owns the binding", (t) => {
	const f = fixture(t);
	// The project declares a binding; the adapter may not reassign it.
	const config = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	put(
		path.join(f.root, CONFIG),
		config
			.replace("version: 1", "version: 2")
			.concat(
				'skills:\n  team-review:\n    package: "@example/review"\n    version: 1.0.0\n',
			),
	);
	f.link();
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(f.dir, "project-config", {
		version: 2,
		assignments: {
			mine: {
				when: { role: "reviewer" },
				versions: { "skills.team-review": "1.1.0" },
			},
		},
	});
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/assignments\.mine\.versions\.skills\.team-review: an adapter assignment may select only bindings the adapter declares/,
	);
	// Its own binding: a role-specific version, chosen by the usual superset rule.
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(
		f.dir,
		"project-config",
		{
			...overlay(),
			roles: {
				...overlay().roles,
				reviewer: { skills: { required: ["shared-review"] } },
			},
			assignments: {
				"reviewer-newer": {
					when: { role: "reviewer" },
					versions: { "skills.shared-review": "1.1.0" },
				},
			},
		},
		{ "roles/auditor.md": "# auditor\n" },
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	const version = (role) =>
		resolveInstructions({
			root: f.root,
			role,
			storeRoot: f.store,
		}).required.find((skill) => skill.id === "shared-review").package.version;
	assert.equal(version("implementer"), "1.0.0");
	assert.equal(version("reviewer"), "1.1.0");
});

test("two projects keep independent adapters and pins", (t) => {
	const f = fixture(t);
	f.link();
	const other = project(f.dir, "other");
	adapter(f.dir, "other-config", overlay("1.1.0"), {
		"roles/auditor.md": "# auditor\n",
	});
	put(
		path.join(other, LOCAL_REFERENCE),
		stringify({ adapter: "../other-config" }),
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	installDependencies({ root: other, storeRoot: f.store });
	const pinned = (root) =>
		resolveInstructions({ root, storeRoot: f.store }).required[0].package
			.version;
	assert.equal(pinned(f.root), "1.0.0");
	assert.equal(pinned(other), "1.1.0");
});

test("update refuses while an adapter is configured", (t) => {
	const f = fixture(t);
	f.link();
	installDependencies({ root: f.root, storeRoot: f.store });
	assert.throws(
		() =>
			previewUpdate({
				root: f.root,
				storeRoot: f.store,
				binding: "skills.shared-review",
				version: "1.1.0",
				assignment: {
					role: "implementer",
					model: "example-model",
					host: "claude",
				},
			}),
		/update: not supported while \.agent-profiles\/agents\.local\.yaml references an adapter/,
	);
});

test("signing stays explicit: approve writes to the adapter, both locations verify", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
	f.link();
	installDependencies({ root: f.root, storeRoot: f.store });
	const key = path.join(f.dir, "keys", "approver");
	fs.mkdirSync(path.dirname(key));
	const pub = keygen(key, "approver");
	put(path.join(f.dir, "allowed_signers"), `samson@example.com ${pub}\n`);
	const trust = path.join(f.dir, "trust.yaml");
	put(
		trust,
		stringify({
			version: 1,
			allowed_signers: "allowed_signers",
			signing_key: key,
			require_approval: true,
		}),
	);
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = trust;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
	});
	// Install never signs: unapproved packages are withheld, not approved.
	const unsigned = resolveInstructions({ root: f.root, storeRoot: f.store });
	assert.deepEqual(skillIds(unsigned), []);
	assert.equal(unsigned.withheld.length, 1);

	const status = (version) =>
		approvalStatus({
			root: f.root,
			storeRoot: f.store,
			name: "@example/review",
			version,
		}).status;
	approvePackage({
		root: f.root,
		storeRoot: f.store,
		name: "@example/review",
		version: "1.0.0",
		now: new Date("2026-11-09T12:00:00Z"),
	});
	const written = path.join(
		f.config,
		".agent-profiles/approvals/@example/review/1.0.0",
	);
	assert.ok(fs.existsSync(path.join(written, "samson@example.com.json")));
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/approvals")),
		false,
	);
	assert.equal(status("1.0.0"), "approved");
	assert.deepEqual(
		skillIds(resolveInstructions({ root: f.root, storeRoot: f.store })),
		["shared-review"],
	);

	// A committed project approval counts too, and moved approval bytes still verify.
	const committed = path.join(
		f.root,
		".agent-profiles/approvals/@example/review/1.0.0",
	);
	fs.mkdirSync(path.dirname(committed), { recursive: true });
	fs.renameSync(written, committed);
	assert.equal(status("1.0.0"), "approved");
	fs.rmSync(path.join(f.root, LOCAL_REFERENCE));
	assert.equal(status("1.0.0"), "approved");
});

test("exact-model selection for adapter-owned skills, with baseline fallback", (t) => {
	const f = fixture(t);
	// The project routes; a supplied family selects another profile.
	const committed = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	put(
		path.join(f.root, CONFIG),
		committed.replace(
			"families: {}",
			"families:\n  example-family:\n    profile: autonomous",
		),
	);
	const rules = {
		"opus-exact": {
			when: { model: "claude-opus-5-5" },
			versions: { "skills.shared-review": "1.1.0" },
		},
	};
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(
		f.dir,
		"project-config",
		{ ...overlay(), assignments: rules },
		{ "roles/auditor.md": "# auditor\n" },
	);
	f.link();
	installDependencies({ root: f.root, storeRoot: f.store });
	const pick = (input) => {
		const r = resolveInstructions({
			root: f.root,
			storeRoot: f.store,
			...input,
		});
		return [
			r.required.find((skill) => skill.id === "shared-review").package.version,
			r.profile,
			r.matchedBy,
		];
	};
	// Only the exact stated ID selects the variant; routing is unchanged.
	assert.deepEqual(pick({ model: "claude-opus-5-5" }), [
		"1.1.0",
		"constrained",
		"default",
	]);
	assert.deepEqual(pick({ model: "claude-opus-5-5", role: "auditor" }), [
		"1.1.0",
		"constrained",
		"default",
	]);
	assert.deepEqual(
		pick({ model: "claude-opus-5-5", family: "example-family" }),
		["1.1.0", "autonomous", "family"],
	);
	// Fallback: no model, other models, near matches and prefixes keep the baseline.
	for (const model of [
		undefined,
		"claude-sonnet-5-5",
		"claude-opus-5-5-20261101",
		"claude-opus-5",
		"CLAUDE-OPUS-5-5",
		"example-model",
	])
		assert.equal(pick({ model })[0], "1.0.0", String(model));
	assert.equal(pick({ model: "example-model" })[1], "autonomous");

	// Within the adapter, a strict superset selector wins as usual.
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(
		f.dir,
		"project-config",
		{
			...overlay(),
			skills: {
				"shared-review": { package: "@example/review", version: "1.1.0" },
			},
			assignments: {
				"opus-baseline": {
					when: { model: "claude-opus-5-5" },
					versions: { "skills.shared-review": "1.0.0" },
				},
				"opus-auditor": {
					when: { model: "claude-opus-5-5", role: "auditor" },
					versions: { "skills.shared-review": "1.1.0" },
				},
			},
		},
		{ "roles/auditor.md": "# auditor\n" },
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	assert.equal(pick({ model: "claude-opus-5-5" })[0], "1.0.0");
	assert.equal(pick({ model: "claude-opus-5-5", role: "auditor" })[0], "1.1.0");
	assert.equal(
		pick({ model: "claude-sonnet-5-5", role: "auditor" })[0],
		"1.1.0",
	);

	// Incomparable adapter rules for an undeclared model are refused at validation.
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(
		f.dir,
		"project-config",
		{
			...overlay(),
			assignments: {
				"by-model": {
					when: { model: "claude-opus-5-5" },
					versions: { "skills.shared-review": "1.1.0" },
				},
				"by-role": {
					when: { role: "auditor" },
					versions: { "skills.shared-review": "1.1.0" },
				},
			},
		},
		{ "roles/auditor.md": "# auditor\n" },
	);
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/ambiguous assignments by-model, by-role/,
	);

	// A project alias is not an exact ID: the adapter must name the canonical model.
	put(
		path.join(f.root, CONFIG),
		committed.replace(
			"profile: autonomous",
			"profile: autonomous\n    aliases:\n      - claude-opus-5-5",
		),
	);
	fs.rmSync(path.join(f.config, ".agent-profiles"), { recursive: true });
	adapter(
		f.dir,
		"project-config",
		{ ...overlay(), assignments: rules },
		{ "roles/auditor.md": "# auditor\n" },
	);
	assert.throws(
		() => resolveInstructions({ root: f.root, storeRoot: f.store }),
		/claude-opus-5-5 is an alias of models\.example-model; use the canonical ID/,
	);
});
