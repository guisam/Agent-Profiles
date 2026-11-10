// #97: guarded update preview/apply with a project adapter. Each binding updates in
// the layer that owns it; neither layer writes the other; a preview is stale when any
// contributing input changes; apply never signs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse, stringify } from "yaml";
import { LOCAL_REFERENCE } from "../src/adapter.ts";
import { approvePackage } from "../src/approvals.ts";
import { publishPackage } from "../src/library.ts";
import {
	applyUpdate,
	formatUpdate,
	outdatedPins,
	previewUpdate,
} from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { keygen, noKeygen } from "./helpers/trust-fixture.js";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const ADAPTER_CONFIG = `../project-config/${CONFIG}`;
const ADAPTER_LOCK = `../project-config/${LOCK}`;
const NAME = "@example/review";
const EXACT = "claude-opus-5-5";
const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));

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

/**
 * A v2 project owning skills.team-review, composed with an adapter owning
 * skills.shared-review (both @example/review 1.0.0; 1.1.0 is in the library).
 * Both locks are current; the trust policy is isolated (none unless a test sets one).
 */
function fixture(t, adapterRules = {}) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-adapter-update-")),
	);
	const clients = [];
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = path.join(dir, "absent-trust.yaml");
	t.after(async () => {
		for (const client of clients) await client.close();
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const store = path.join(dir, "store");
	for (const version of ["1.0.0", "1.1.0"]) {
		const source = path.join(dir, "sources", version);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: NAME, version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(
			path.join(source, "SKILL.md"),
			`---\ndescription: review\n---\n# review ${version}\n`,
		);
		publishPackage({ storeRoot: store, sourceDirectory: source });
	}
	const root = path.join(dir, "project");
	for (const id of ["constrained", "autonomous"])
		put(path.join(root, `.agent-profiles/profiles/${id}.md`), `# ${id}\n`);
	put(path.join(root, ".agent-profiles/roles/implementer.md"), "# impl\n");
	put(
		path.join(root, CONFIG),
		`# committed project configuration\n${stringify({
			version: 2,
			default_profile: "constrained",
			default_role: "implementer",
			models: { "example-model": { profile: "autonomous" } },
			families: {},
			profiles: {
				constrained: { file: "profiles/constrained.md" },
				autonomous: { file: "profiles/autonomous.md" },
			},
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: ["team-review"], available: [] },
				},
			},
			skills: { "team-review": { package: NAME, version: "1.0.0" } },
		})}`,
	);
	installDependencies({ root, storeRoot: store }); // the committed lock
	const config = path.join(dir, "project-config");
	put(
		path.join(config, CONFIG),
		`# adapter configuration\n${stringify({
			version: 2,
			skills: { "shared-review": { package: NAME, version: "1.0.0" } },
			roles: { implementer: { skills: { required: ["shared-review"] } } },
			...(Object.keys(adapterRules).length
				? { assignments: adapterRules }
				: {}),
		})}`,
	);
	put(
		path.join(root, LOCAL_REFERENCE),
		stringify({ adapter: "../project-config" }),
	);
	installDependencies({ root, storeRoot: store }); // the adapter lock
	const home = path.join(dir, "home");
	fs.mkdirSync(home);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_PROFILES_STORE: path.join(home, "ambient-store"),
		AGENT_PROFILES_TRUST: path.join(dir, "absent-trust.yaml"),
	};
	return {
		dir,
		store,
		root: fs.realpathSync(root),
		config: fs.realpathSync(config),
		env,
		clients,
	};
}

const input = (
	f,
	binding,
	version,
	model = "example-model",
	host = "claude",
) => ({
	root: f.root,
	storeRoot: f.store,
	binding,
	version,
	assignment: { role: "implementer", model, host },
});

/** The version each binding resolves to, with profile, for one tuple. */
function picked(f, model, host = "claude") {
	const resolved = resolveInstructions({
		root: f.root,
		storeRoot: f.store,
		role: "implementer",
		model,
		host,
	});
	return {
		profile: resolved.profile,
		...Object.fromEntries(
			resolved.required.map((skill) => [skill.id, skill.package.version]),
		),
	};
}

const both = (f) => [tree(f.root), tree(f.config)];

test("an adapter-owned update edits only the adapter's configuration and lock", (t) => {
	const f = fixture(t);
	const projectBefore = tree(f.root);
	const preview = previewUpdate(input(f, "skills.shared-review", "1.1.0"));
	assert.equal(preview.layer, "adapter");
	assert.equal(preview.adapter.root, f.config);
	assert.deepEqual(
		preview.edits.map(({ layer, file, action }) => [layer, file, action]),
		[["adapter", ADAPTER_CONFIG, "add-rule"]],
	);
	assert.deepEqual(preview.locks, [
		{ layer: "adapter", file: ADAPTER_LOCK, action: "refresh" },
	]);
	assert.match(
		formatUpdate(preview),
		/Edits to the adapter layer, \.\.\/project-config\/\.agent-profiles\/agents\.yaml \(1\):/,
	);
	assert.deepEqual(
		both(f),
		[projectBefore, tree(f.config)],
		"preview writes nothing",
	);

	const applied = applyUpdate({
		...input(f, "skills.shared-review", "1.1.0"),
		expect: preview.previewDigest,
	});
	assert.equal(applied.status, "updated");
	assert.equal(applied.stampDigest, null, "stamps stay guarded (#98)");
	assert.match(formatUpdate(applied), /No stamp recorded/);
	assert.deepEqual(tree(f.root), projectBefore, "project files unchanged");
	const adapterConfig = fs.readFileSync(path.join(f.config, CONFIG), "utf8");
	assert.match(adapterConfig, /^# adapter configuration/, "comments kept");
	assert.deepEqual(picked(f, "example-model"), {
		profile: "autonomous",
		"team-review": "1.0.0",
		"shared-review": "1.1.0",
	});
	assert.equal(picked(f, "example-model", "codex")["shared-review"], "1.0.0");
});

test("exact-model tuples: listed, and updated in the adapter without a model declaration", (t) => {
	const f = fixture(t, {
		"opus-exact": {
			when: { model: EXACT },
			versions: { "skills.shared-review": "1.0.0" },
		},
	});
	const listing = outdatedPins({ root: f.root, storeRoot: f.store });
	const pin = listing.pins.find((item) => item.rule === "opus-exact");
	assert.equal(pin.layer, "adapter");
	assert.ok(
		pin.serves.some((tuple) => tuple.model === EXACT),
		JSON.stringify(pin.serves),
	);
	assert.equal(
		listing.pins.find((item) => item.binding === "skills.team-review").layer,
		"project",
	);
	const filtered = outdatedPins({
		root: f.root,
		storeRoot: f.store,
		filter: { model: EXACT },
	});
	assert.ok(filtered.pins.some((item) => item.rule === "opus-exact"));

	const projectBefore = tree(f.root);
	const preview = previewUpdate(
		input(f, "skills.shared-review", "1.1.0", EXACT),
	);
	assert.equal(preview.declaredModel, null);
	assert.deepEqual(
		preview.edits.map(({ layer, file, action }) => [layer, file, action]),
		[["adapter", ADAPTER_CONFIG, "add-rule"]],
	);
	assert.deepEqual(preview.rule.when, {
		model: EXACT,
		role: "implementer",
		host: "claude",
	});
	applyUpdate({
		...input(f, "skills.shared-review", "1.1.0", EXACT),
		expect: preview.previewDigest,
	});
	assert.deepEqual(tree(f.root), projectBefore, "no project model declaration");
	assert.equal(
		parse(fs.readFileSync(path.join(f.config, CONFIG), "utf8")).models,
		undefined,
	);
	// Routing stays the project's; only the exact stated tuple moves.
	assert.deepEqual(picked(f, EXACT), {
		profile: "constrained",
		"team-review": "1.0.0",
		"shared-review": "1.1.0",
	});
	assert.equal(picked(f, EXACT, "codex")["shared-review"], "1.0.0");
	assert.equal(picked(f, `${EXACT}-20261101`)["shared-review"], "1.0.0");
	assert.equal(picked(f, "example-model").profile, "autonomous");

	// The same role/model/host tuple again replaces its adapter rule in place.
	const back = previewUpdate(input(f, "skills.shared-review", "1.0.0", EXACT));
	assert.deepEqual(
		back.edits.map(({ layer, action }) => [layer, action]),
		[["adapter", "replace-binding"]],
	);
	applyUpdate({
		...input(f, "skills.shared-review", "1.0.0", EXACT),
		expect: back.previewDigest,
	});
	assert.equal(picked(f, EXACT)["shared-review"], "1.0.0");
	assert.deepEqual(tree(f.root), projectBefore);
});

test("a project-owned update edits only project files and leaves the adapter lock stale", (t) => {
	const f = fixture(t);
	const adapterBefore = tree(f.config);
	const projectLockBefore = fs.readFileSync(path.join(f.root, LOCK), "utf8");
	const preview = previewUpdate(input(f, "skills.team-review", "1.1.0"));
	assert.equal(preview.layer, "project");
	assert.deepEqual(
		preview.edits.map(({ layer, file }) => [layer, file]),
		[["project", CONFIG]],
	);
	assert.deepEqual(preview.locks, [
		{ layer: "project", file: LOCK, action: "refresh" },
		{ layer: "adapter", file: ADAPTER_LOCK, action: "stale" },
	]);
	assert.match(
		formatUpdate(preview),
		/Apply leaves the adapter lock \.\.\/project-config\/\.agent-profiles\/agent-profiles\.lock stale.*agent-profiles install as a separate step/,
	);
	applyUpdate({
		...input(f, "skills.team-review", "1.1.0"),
		expect: preview.previewDigest,
	});
	assert.deepEqual(tree(f.config), adapterBefore, "adapter files unchanged");
	assert.notEqual(
		fs.readFileSync(path.join(f.root, LOCK), "utf8"),
		projectLockBefore,
		"the committed lock is refreshed",
	);
	// The composed configuration changed: its lock is stale until a separate install.
	assert.throws(() => picked(f, "example-model"), /project-config.*stale-lock/);
	installDependencies({ root: f.root, storeRoot: f.store });
	assert.deepEqual(picked(f, "example-model"), {
		profile: "autonomous",
		"team-review": "1.1.0",
		"shared-review": "1.0.0",
	});
	// Committed-only use still works with the refreshed project lock.
	fs.renameSync(
		path.join(f.root, LOCAL_REFERENCE),
		path.join(f.dir, "aside.yaml"),
	);
	const committed = resolveInstructions({
		root: f.root,
		storeRoot: f.store,
		model: "example-model",
		host: "claude",
	});
	assert.equal(committed.lockState, "valid");
	assert.deepEqual(
		committed.required.map((skill) => [skill.id, skill.package.version]),
		[["team-review", "1.1.0"]],
	);
});

test("without an adapter, edits name the project layer and the text is unchanged", (t) => {
	const f = fixture(t);
	fs.rmSync(path.join(f.root, LOCAL_REFERENCE));
	const preview = previewUpdate(input(f, "skills.team-review", "1.1.0"));
	assert.equal(preview.adapter, null);
	assert.deepEqual(
		preview.edits.map(({ layer, file }) => [layer, file]),
		[["project", CONFIG]],
	);
	assert.deepEqual(preview.locks, [
		{ layer: "project", file: LOCK, action: "refresh" },
	]);
	assert.match(formatUpdate(preview), /Edits to agents\.yaml \(1\):/);
	assert.doesNotMatch(formatUpdate(preview), /layer|Apply refreshes/);
	const applied = applyUpdate({
		...input(f, "skills.team-review", "1.1.0"),
		expect: preview.previewDigest,
	});
	assert.match(applied.stampDigest, /^[0-9a-f]{64}$/);
});

test("an edit across layers is refused with nothing written", (t) => {
	const f = fixture(t);
	// A project rule selecting the adapter's binding for the exact tuple: replacing it
	// would edit the project for an adapter binding.
	const text = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	put(
		path.join(f.root, CONFIG),
		`${text}assignments:\n  mine:\n    when:\n      role: implementer\n      model: example-model\n      host: claude\n    versions:\n      skills.shared-review: 1.0.0\n`,
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	const before = both(f);
	assert.throws(
		() => previewUpdate(input(f, "skills.shared-review", "1.1.0")),
		/skills\.shared-review belongs to the adapter but assignments\.mine belongs to the project; an update edits one layer only; nothing was written/,
	);
	assert.throws(
		() => applyUpdate(input(f, "skills.shared-review", "1.1.0")),
		/belongs to the adapter but assignments\.mine belongs to the project/,
	);
	assert.deepEqual(both(f), before);
});

test("a change to any contributing input makes the preview stale; apply writes nothing", (t) => {
	const f = fixture(t);
	const update = input(f, "skills.shared-review", "1.1.0");
	const { previewDigest } = previewUpdate(update);
	const storeCopy = path.join(f.dir, "store-copy");
	fs.cpSync(f.store, storeCopy, { recursive: true });
	const changes = [
		["project agents.yaml", path.join(f.root, CONFIG), (s) => `${s}# edited\n`],
		["project lock", path.join(f.root, LOCK), (s) => `${s}\n`],
		[
			"local reference",
			path.join(f.root, LOCAL_REFERENCE),
			() => stringify({ adapter: "../project-config/" }),
		],
		[
			"adapter agents.yaml",
			path.join(f.config, CONFIG),
			(s) => `${s}# edited\n`,
		],
		["adapter lock", path.join(f.config, LOCK), (s) => `${s}\n`],
	];
	for (const [label, file, change] of changes) {
		const original = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, change(original));
		const before = both(f);
		assert.throws(
			() => applyUpdate({ ...update, expect: previewDigest }),
			/previewDigest differs\); preview again; nothing was written/,
			label,
		);
		assert.deepEqual(both(f), before, `${label}: nothing written`);
		fs.writeFileSync(file, original);
	}
	// The selected store versions: the same versions from another store.
	const before = both(f);
	assert.throws(
		() =>
			applyUpdate({ ...update, storeRoot: storeCopy, expect: previewDigest }),
		/previewDigest differs/,
	);
	assert.deepEqual(both(f), before);
	// Restored inputs: the original preview applies.
	assert.equal(
		applyUpdate({ ...update, expect: previewDigest }).status,
		"updated",
	);
});

test("apply refuses an untrusted target and never signs; approvals from either layer count", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
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
	process.env.AGENT_PROFILES_TRUST = trust; // restored by the fixture
	const update = input(f, "skills.shared-review", "1.1.0");
	const preview = previewUpdate(update);
	assert.equal(preview.approval.status, "unapproved");
	assert.ok(preview.trustBlockers.length);
	assert.match(
		formatUpdate(preview),
		/Apply will be refused by the trust policy/,
	);
	const before = both(f);
	assert.throws(
		() => applyUpdate({ ...update, expect: preview.previewDigest }),
		/update: the trust policy refuses .*Approve a version with agent-profiles library approve .*nothing was written/,
	);
	assert.deepEqual(both(f), before, "nothing written, nothing signed");

	// Approval is its own operation; it writes to the adapter.
	approvePackage({
		root: f.root,
		storeRoot: f.store,
		name: NAME,
		version: "1.1.0",
		now: new Date("2026-11-09T12:00:00Z"),
	});
	const written = path.join(
		f.config,
		`.agent-profiles/approvals/${NAME}/1.1.0`,
	);
	assert.ok(fs.existsSync(written));
	// Moved to the committed project, the approval still verifies for an adapter binding.
	const committed = path.join(
		f.root,
		`.agent-profiles/approvals/${NAME}/1.1.0`,
	);
	fs.mkdirSync(path.dirname(committed), { recursive: true });
	fs.renameSync(written, committed);
	const approvalsBefore = [
		tree(path.join(f.root, ".agent-profiles/approvals")),
	];
	const approved = previewUpdate(update);
	assert.equal(approved.approval.status, "approved");
	assert.deepEqual(approved.trustBlockers, []);
	assert.equal(
		approved.previewDigest,
		preview.previewDigest,
		"trust is checked live, not hashed",
	);
	assert.equal(
		applyUpdate({ ...update, expect: approved.previewDigest }).status,
		"updated",
	);
	assert.deepEqual(
		[tree(path.join(f.root, ".agent-profiles/approvals"))],
		approvalsBefore,
		"apply wrote no approval",
	);
	assert.equal(
		fs.existsSync(
			path.join(f.config, `.agent-profiles/approvals/${NAME}/1.1.0`),
		),
		false,
	);
});

test("MCP update_preview and CLI update --apply agree in adapter mode", async (t) => {
	const f = fixture(t);
	const client = new Client({ name: "agent-profiles-test", version: "1" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", "--root", f.root, "--store", f.store],
			cwd: f.root,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
	const tuple = { role: "implementer", model: EXACT, host: "claude" };
	const before = both(f);
	const result = await client.callTool({
		name: "update_preview",
		arguments: { binding: "skills.shared-review", version: "1.1.0", ...tuple },
	});
	assert.ok(!result.isError, JSON.stringify(result.content));
	assert.deepEqual(both(f), before, "the MCP preview writes nothing");
	const mcp = result.structuredContent;
	const run = (...args) =>
		spawnSync(process.execPath, [cli, ...args], {
			encoding: "utf8",
			env: f.env,
			cwd: f.dir,
		});
	const preview = run(
		"update",
		"skills.shared-review",
		"1.1.0",
		"--role",
		tuple.role,
		"--model",
		tuple.model,
		"--host",
		tuple.host,
		"--root",
		f.root,
		"--store",
		f.store,
		"--json",
	);
	assert.equal(preview.status, 0, preview.stderr);
	assert.deepEqual(mcp, JSON.parse(preview.stdout));
	assert.equal(mcp.layer, "adapter");
	assert.deepEqual(
		mcp.edits.map(({ layer, file }) => [layer, file]),
		[["adapter", ADAPTER_CONFIG]],
	);
	// Run the applyCommand as printed (arguments are bare or double-quoted here).
	const args = mcp.applyCommand
		.replace(/^npx --no agent-profiles /, "")
		.match(/"[^"]*"|\S+/g)
		.map((arg) => arg.replace(/^"(.*)"$/, "$1"));
	const applied = run(...args, "--json");
	assert.equal(applied.status, 0, applied.stderr);
	const json = JSON.parse(applied.stdout);
	assert.equal(json.status, "updated");
	assert.deepEqual(json.edits, mcp.edits);
	assert.equal(json.previewDigest, mcp.previewDigest);
	assert.equal(json.applyCommand, mcp.applyCommand);
	assert.deepEqual(tree(f.root), before[0], "project unchanged");
	assert.equal(picked(f, EXACT)["shared-review"], "1.1.0");
});
