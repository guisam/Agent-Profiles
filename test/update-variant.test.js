// #89: update moves one exact role × model × host tuple to a differently named
// (variant) package, through the same guards as a version move. #91: the target is
// parsed before any lookup, and a malformed one is reported as written.
// Every fixture is disposable: its own store, trust path and projects.
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
import {
	applyUpdate,
	formatUpdate,
	parseUpdateTarget,
	previewUpdate,
} from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { retainRevisionManifest } from "../src/revisions.ts";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const BASE = "@demo/brainstorming";
const SONNET = "@demo/brainstorming-sonnet";
const ALT = "@demo/brainstorming-alt";
const BINDING = "skills.brainstorming";
const EXACT = "claude-sonnet-5-5";
const TARGET = { role: "brainstormer", model: "model-a", host: "claude" };
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
			else out[path.relative(root, full)] = fs.readFileSync(full, "hex");
		}
	};
	walk(root);
	return out;
}

/**
 * A store with a baseline skill, two labeled variants (one with two versions), an
 * unlabeled variant, a labeled instruction package and a labeled package from another
 * namespace. `project()` writes a configuration v3 consumer pinning the baseline.
 */
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-variant-")),
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
	const labels = new Map();
	function add(name, version, { label = true, type = "skill" } = {}) {
		const source = path.join(dir, "sources", name.slice(1), version);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name, version, type },
				entrypoint: type === "skill" ? "SKILL.md" : "INSTRUCTIONS.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(
			path.join(source, type === "skill" ? "SKILL.md" : "INSTRUCTIONS.md"),
			`---\nname: brainstorming\ndescription: brainstorm\n---\n# ${name} ${version}\nGenerate options before choosing.\n`,
		);
		const imported = importPackage({
			sourceDirectory: source,
			storeRoot: store,
		});
		if (!label) return;
		const manifestFile = path.join(dir, "adoption.json");
		put(
			manifestFile,
			JSON.stringify({
				revisionVersion: 1,
				kind: "release",
				identity: imported.identity,
				content: { identity: imported.identity, sha256: imported.sha256 },
				parent: null,
				candidate: null,
				dependencies: [],
				workflow: null,
				provenance: {
					kind: "legacy-adoption",
					workflowChange: { kind: "initial", reason: "Disposable fixture." },
				},
			}),
		);
		labels.set(
			`${name}@${version}`,
			retainRevisionManifest({ storeRoot: store, manifestFile }).recordDigest,
		);
	}
	add(BASE, "1.0.0");
	add(SONNET, "0.1.0");
	add(SONNET, "0.2.0");
	add(ALT, "1.0.0");
	add("@demo/brainstorming-unlabeled", "1.0.0", { label: false });
	add("@demo/brainstorming-notes", "1.0.0", { type: "instruction" });
	add("@other/brainstorming", "1.0.0");
	const pin = (name, version) => ({
		package: name,
		version,
		revision: labels.get(`${name}@${version}`),
	});
	function project(name, { version = 3, assignments = {} } = {}) {
		const root = path.join(dir, name);
		put(path.join(root, ".agent-profiles/profiles/base.md"), "# base\n");
		put(path.join(root, ".agent-profiles/profiles/wide.md"), "# wide\n");
		for (const role of ["brainstormer", "worker"])
			put(path.join(root, `.agent-profiles/roles/${role}.md`), `# ${role}\n`);
		put(
			path.join(root, CONFIG),
			`# consumer ${name}\n${stringify({
				version,
				default_profile: "base",
				default_role: "worker",
				models: {
					"model-a": { profile: "base" },
					"model-b": { profile: "base" },
				},
				families: {
					wide: { profile: "wide", match: { prefixes: ["wide-"] } },
				},
				roles: Object.fromEntries(
					["brainstormer", "worker"].map((role) => [
						role,
						{
							file: `roles/${role}.md`,
							skills: { required: ["brainstorming"], available: [] },
						},
					]),
				),
				skills: {
					brainstorming:
						version === 3
							? pin(BASE, "1.0.0")
							: { package: BASE, version: "1.0.0" },
				},
				assignments,
			})}`,
		);
		installDependencies({ root, storeRoot: store });
		return fs.realpathSync(root);
	}
	const home = path.join(dir, "home");
	fs.mkdirSync(home);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_PROFILES_STORE: path.join(home, "ambient-store"),
		AGENT_PROFILES_TRUST: path.join(dir, "absent-trust.yaml"),
	};
	return { dir, store, labels, pin, project, env, clients };
}

const update = (f, root, version, assignment = TARGET, extra = {}) => ({
	root,
	storeRoot: f.store,
	binding: BINDING,
	version,
	assignment,
	...extra,
});

/** The package identity the binding resolves to for one tuple, with the profile. */
function picked(f, root, { role, model, host }) {
	const resolved = resolveInstructions({
		root,
		storeRoot: f.store,
		role,
		model,
		...(host ? { host } : {}),
	});
	const skill = resolved.required.find((s) => s.id === "brainstorming");
	return `${resolved.profile} ${skill.package.name}@${skill.package.version}`;
}

/** Every tuple other than the target, each with and without a host. */
const others = [
	{ role: "worker", model: "model-a", host: "claude" },
	{ role: "brainstormer", model: "model-a", host: "codex" },
	{ role: "brainstormer", model: "model-a", host: null },
	{ role: "brainstormer", model: "model-b", host: "claude" },
	{ role: "brainstormer", model: "wide-anything", host: "claude" },
	{ role: "brainstormer", model: "unknown-model", host: "claude" },
	{ role: "brainstormer", model: EXACT, host: "claude" },
];
const snapshot = (f, root) =>
	Object.fromEntries(
		others.map((tuple) => [JSON.stringify(tuple), picked(f, root, tuple)]),
	);

test("#91: targets are parsed before lookup and never combined with another identity", () => {
	assert.deepEqual(parseUpdateTarget("1.2.0"), {
		name: null,
		version: "1.2.0",
	});
	assert.deepEqual(parseUpdateTarget(`${SONNET}@0.1.0`), {
		name: SONNET,
		version: "0.1.0",
	});
	for (const [target, problem] of [
		["", /empty/],
		["latest", /not an exact safe release version/],
		["1.0", /not an exact safe release version/],
		["v1.0.0", /not an exact safe release version/],
		["01.0.0", /not an exact safe release version/],
		["9007199254740993.0.0", /not an exact safe release version/],
		["demo/tool@1.0.0", /must start with @namespace\//],
		[
			SONNET,
			/needs an exact version \(@demo\/brainstorming-sonnet@<version>\)/,
		],
		[`${SONNET}@`, /the version is not an exact safe release version/],
		["@Demo/Tool@1.0.0", /@Demo\/Tool is not a package name/],
		["@demo@1.0.0", /@demo is not a package name/],
		[
			"@demo/tool@@demo/tool-variant@1.0.0",
			/"@demo\/tool-variant@1\.0\.0" is not an exact safe release version/,
		],
	]) {
		assert.throws(
			() => parseUpdateTarget(target),
			(error) => {
				assert.match(error.message, problem, target);
				assert.match(
					error.message,
					/expected an exact version .* or a package-qualified @namespace\/name@version; nothing was written$/,
				);
				// The message names the target as given, never a synthesized identity.
				assert.doesNotMatch(error.message, /@demo\/brainstorming@@/);
				return true;
			},
		);
	}
});

test("preview moves one tuple to a variant package with diff, evidence and digest; writes nothing", (t) => {
	const f = fixture(t);
	const root = f.project("consumer");
	const second = f.project("second");
	const before = [tree(root), tree(second), tree(f.store)];
	const preview = previewUpdate(update(f, root, `${SONNET}@0.1.0`));
	assert.deepEqual([tree(root), tree(second), tree(f.store)], before);
	assert.equal(preview.status, "preview");
	assert.equal(preview.configurationVersion, 3);
	assert.equal(preview.package, SONNET);
	assert.deepEqual(preview.before, {
		package: BASE,
		version: "1.0.0",
		revision: f.labels.get(`${BASE}@1.0.0`),
		selectedBy: "binding-default",
	});
	assert.deepEqual(preview.after, {
		package: SONNET,
		version: "0.1.0",
		revision: f.labels.get(`${SONNET}@0.1.0`),
	});
	assert.equal(preview.rule.action, "add");
	assert.deepEqual(preview.rule.when, TARGET);
	assert.deepEqual(
		preview.changed.map(({ tuple, binding, from, to }) => [
			tuple,
			binding,
			from,
			to,
		]),
		[[TARGET, BINDING, `${BASE}@1.0.0`, `${SONNET}@0.1.0`]],
	);
	assert.deepEqual(preview.evidence, []);
	const skill = preview.contentDiff.find((file) => file.path === "SKILL.md");
	assert.match(skill.diff, /^--- @demo\/brainstorming@1\.0\.0/m);
	assert.match(skill.diff, /^\+\+\+ @demo\/brainstorming-sonnet@0\.1\.0/m);
	assert.match(preview.previewDigest, /^[0-9a-f]{64}$/);
	assert.match(
		preview.applyCommand,
		/^npx --no agent-profiles update skills\.brainstorming @demo\/brainstorming-sonnet@0\.1\.0 --role brainstormer --model model-a --host claude --root .* --apply --expect [0-9a-f]{64}$/,
	);
	const text = formatUpdate(preview);
	assert.match(
		text,
		/@demo\/brainstorming@1\.0\.0 → @demo\/brainstorming-sonnet@0\.1\.0 \(revision [0-9a-f]{64}\)/,
	);
	assert.match(text, /Evidence for this tuple: untested/);
	assert.match(text, /Content changes \(\d+ files?\)/);
	// A different target is a different preview.
	assert.notEqual(
		previewUpdate(update(f, root, `${ALT}@1.0.0`)).previewDigest,
		preview.previewDigest,
	);
});

test("apply pins the variant for exactly one tuple; other tuples and a second consumer are unchanged", (t) => {
	const f = fixture(t);
	const root = f.project("consumer");
	const second = f.project("second");
	const othersBefore = snapshot(f, root);
	const secondBefore = [tree(second), snapshot(f, second)];
	const preview = previewUpdate(update(f, root, `${SONNET}@0.1.0`));
	const applied = applyUpdate(
		update(f, root, `${SONNET}@0.1.0`, TARGET, {
			expect: preview.previewDigest,
		}),
	);
	assert.equal(applied.status, "updated");
	assert.match(applied.stampDigest, /^[0-9a-f]{64}$/);
	const config = parse(fs.readFileSync(path.join(root, CONFIG), "utf8"));
	assert.deepEqual(config.skills.brainstorming, f.pin(BASE, "1.0.0"));
	assert.deepEqual(config.assignments[applied.rule.id], {
		when: TARGET,
		bindings: { [BINDING]: f.pin(SONNET, "0.1.0") },
	});
	assert.match(
		fs.readFileSync(path.join(root, CONFIG), "utf8"),
		/^# consumer consumer/,
		"comments are kept",
	);
	assert.match(
		fs.readFileSync(path.join(root, LOCK), "utf8"),
		/brainstorming-sonnet/,
	);
	assert.equal(picked(f, root, TARGET), `base ${SONNET}@0.1.0`);
	assert.deepEqual(snapshot(f, root), othersBefore, "other tuples unchanged");
	assert.deepEqual([tree(second), snapshot(f, second)], secondBefore);
	// The applied tuple now reports itself as already pinned.
	assert.equal(
		previewUpdate(update(f, root, `${SONNET}@0.1.0`)).status,
		"already-pinned",
	);
});

test("a selected variant is replaced in place; a bare version stays within the selected variant", (t) => {
	const f = fixture(t);
	const root = f.project("consumer", {
		assignments: {
			"sonnet-a": {
				when: TARGET,
				bindings: { [BINDING]: f.pin(SONNET, "0.1.0") },
			},
		},
	});
	const othersBefore = snapshot(f, root);
	// Bare version: a version of the package the tuple selects now (the variant).
	const bare = previewUpdate(update(f, root, "0.2.0"));
	assert.equal(bare.package, SONNET);
	assert.deepEqual(bare.rule, {
		id: "sonnet-a",
		when: TARGET,
		action: "replace",
	});
	assert.match(
		formatUpdate(bare),
		/@demo\/brainstorming-sonnet@0\.1\.0 → 0\.2\.0/,
	);
	// A bare version absent from the variant is reported against the variant.
	assert.throws(
		() => previewUpdate(update(f, root, "1.0.0")),
		/@demo\/brainstorming-sonnet@1\.0\.0: not in the library/,
	);
	// The same-package qualified form is the same move.
	assert.equal(
		previewUpdate(update(f, root, `${SONNET}@0.2.0`)).rule.id,
		"sonnet-a",
	);
	// Another variant replaces the rule's binding; nothing is added.
	const alt = applyUpdate(update(f, root, `${ALT}@1.0.0`));
	assert.deepEqual(alt.rule, {
		id: "sonnet-a",
		when: TARGET,
		action: "replace",
	});
	const config = parse(fs.readFileSync(path.join(root, CONFIG), "utf8"));
	assert.deepEqual(Object.keys(config.assignments), ["sonnet-a"]);
	assert.deepEqual(
		config.assignments["sonnet-a"].bindings[BINDING],
		f.pin(ALT, "1.0.0"),
	);
	assert.equal(picked(f, root, TARGET), `base ${ALT}@1.0.0`);
	assert.deepEqual(snapshot(f, root), othersBefore);
});

test("updating a variant selected by a broader rule adds an exact rule and does not broaden it", (t) => {
	const f = fixture(t);
	// The variant serves every role and host of model-a.
	const root = f.project("consumer", {
		assignments: {
			"sonnet-model-a": {
				when: { model: "model-a" },
				bindings: { [BINDING]: f.pin(SONNET, "0.1.0") },
			},
		},
	});
	const othersBefore = snapshot(f, root);
	const applied = applyUpdate(update(f, root, `${ALT}@1.0.0`));
	assert.equal(applied.rule.action, "add");
	assert.deepEqual(applied.rule.when, TARGET);
	const config = parse(fs.readFileSync(path.join(root, CONFIG), "utf8"));
	assert.deepEqual(
		config.assignments["sonnet-model-a"].bindings[BINDING],
		f.pin(SONNET, "0.1.0"),
		"the broader rule is unchanged",
	);
	assert.equal(picked(f, root, TARGET), `base ${ALT}@1.0.0`);
	assert.deepEqual(snapshot(f, root), othersBefore);
	assert.equal(
		picked(f, root, { role: "worker", model: "model-a", host: "claude" }),
		`base ${SONNET}@0.1.0`,
	);
});

test("refusals: stale preview, missing label, missing or untrusted target, wrong type, malformed target; no writes", (t) => {
	const f = fixture(t);
	const root = f.project("consumer");
	const state = () => [tree(root), tree(f.store)];
	const target = `${SONNET}@0.1.0`;
	const { previewDigest } = previewUpdate(update(f, root, target));
	const before = state();
	for (const [version, message] of [
		[
			"@demo/brainstorming-unlabeled@1.0.0",
			/@demo\/brainstorming-unlabeled@1\.0\.0 has no release label; configuration v3 pins a revision. Adopt it with agent-profiles revision record first/,
		],
		[
			"@demo/brainstorming-absent@1.0.0",
			/@demo\/brainstorming-absent: not in the library/,
		],
		[
			`${SONNET}@9.9.9`,
			/@demo\/brainstorming-sonnet@9\.9\.9: not in the library; versions: 0\.2\.0, 0\.1\.0/,
		],
		[
			"@demo/brainstorming-notes@1.0.0",
			/edited configuration does not resolve; nothing was written; .*@demo\/brainstorming-notes@1\.0\.0: expected skill package/,
		],
		[
			"@demo/tool@@demo/tool-variant@1.0.0",
			/is not an exact safe release version/,
		],
		[SONNET, /needs an exact version/],
	])
		for (const run of [previewUpdate, applyUpdate])
			assert.throws(() => run(update(f, root, version)), message, version);
	assert.throws(
		() =>
			applyUpdate(update(f, root, target, TARGET, { expect: "0".repeat(64) })),
		/changed since the preview/,
	);
	assert.deepEqual(state(), before);

	// Untrusted: the machine policy allows only the @demo namespace.
	const trust = path.join(f.dir, "trust.yaml");
	put(trust, stringify({ version: 1, namespaces: ["@demo"] }));
	process.env.AGENT_PROFILES_TRUST = trust; // restored by the fixture
	const foreign = previewUpdate(update(f, root, "@other/brainstorming@1.0.0"));
	assert.ok(foreign.trustBlockers.length);
	assert.match(
		formatUpdate(foreign),
		/Apply will be refused by the trust policy/,
	);
	assert.throws(
		() =>
			applyUpdate(
				update(f, root, "@other/brainstorming@1.0.0", TARGET, {
					expect: foreign.previewDigest,
				}),
			),
		/update: the trust policy refuses .*nothing was written/,
	);
	assert.deepEqual(state(), before, "nothing written, nothing signed");
	process.env.AGENT_PROFILES_TRUST = path.join(f.dir, "absent-trust.yaml");

	// Any contributing input changed after the preview refuses: here, the lock.
	fs.appendFileSync(path.join(root, LOCK), "\n");
	const stale = state();
	assert.throws(
		() =>
			applyUpdate(update(f, root, target, TARGET, { expect: previewDigest })),
		/changed since the preview \(previewDigest differs\); preview again; nothing was written/,
	);
	assert.deepEqual(state(), stale);
});

test("configuration v2 refuses a cross-package target with upgrade guidance; same-package targets still work", (t) => {
	const f = fixture(t);
	const root = f.project("consumer", { version: 2 });
	const before = [tree(root), tree(f.store)];
	for (const run of [previewUpdate, applyUpdate])
		assert.throws(
			() => run(update(f, root, `${SONNET}@0.1.0`)),
			/skills\.brainstorming for brainstormer × model-a × claude selects @demo\/brainstorming; moving it to @demo\/brainstorming-sonnet needs configuration v3.*config-v2-to-v3\.md\); update does not rewrite the schema; nothing was written/,
		);
	assert.deepEqual([tree(root), tree(f.store)], before);
	// A package-qualified target naming the selected package is a version move.
	const same = previewUpdate(update(f, root, `${BASE}@1.0.0`));
	assert.equal(same.status, "already-pinned");
	assert.equal(same.configurationVersion, 2);
});

test("an adapter-owned binding moves to a variant for an undeclared exact model in the adapter only", (t) => {
	const f = fixture(t);
	const root = f.project("consumer");
	const adapter = path.join(f.dir, "adapter");
	put(
		path.join(adapter, CONFIG),
		`# adapter\n${stringify({
			version: 3,
			skills: { "shared-brainstorming": f.pin(BASE, "1.0.0") },
			roles: {
				brainstormer: { skills: { required: ["shared-brainstorming"] } },
			},
		})}`,
	);
	put(path.join(root, LOCAL_REFERENCE), stringify({ adapter: "../adapter" }));
	installDependencies({ root, storeRoot: f.store }); // the adapter lock
	const projectBefore = tree(root);
	const tuple = { role: "brainstormer", model: EXACT, host: "claude" };
	const input = {
		...update(f, root, `${SONNET}@0.1.0`, tuple),
		binding: "skills.shared-brainstorming",
	};
	const preview = previewUpdate(input);
	assert.equal(preview.layer, "adapter");
	assert.deepEqual(preview.declaredModel, null);
	assert.deepEqual(
		preview.edits.map(({ layer, action }) => [layer, action]),
		[["adapter", "add-rule"]],
	);
	const applied = applyUpdate({ ...input, expect: preview.previewDigest });
	assert.equal(applied.status, "updated");
	assert.match(applied.stampDigest, /^[0-9a-f]{64}$/);
	assert.deepEqual(
		tree(root),
		projectBefore,
		"the project layer is never written",
	);
	const config = parse(fs.readFileSync(path.join(adapter, CONFIG), "utf8"));
	assert.equal(config.models, undefined, "no model is declared");
	assert.deepEqual(config.assignments[applied.rule.id], {
		when: tuple,
		bindings: { "skills.shared-brainstorming": f.pin(SONNET, "0.1.0") },
	});
	const shared = (model, host = "claude") =>
		resolveInstructions({
			root,
			storeRoot: f.store,
			role: "brainstormer",
			model,
			host,
		}).required.find((s) => s.id === "shared-brainstorming").package.name;
	assert.equal(shared(EXACT), SONNET);
	assert.equal(shared(EXACT, "codex"), BASE);
	assert.equal(shared("claude-sonnet-5-5-other"), BASE);
	assert.equal(shared("model-a"), BASE);

	// A project-owned cross-package move with the adapter leaves the adapter lock stale.
	const project = previewUpdate(update(f, root, `${SONNET}@0.1.0`));
	assert.equal(project.layer, "project");
	assert.deepEqual(
		project.locks.map(({ layer, action }) => [layer, action]),
		[
			["project", "refresh"],
			["adapter", "stale"],
		],
	);
});

test("CLI update and MCP update_preview agree on a cross-package preview and its applyCommand", async (t) => {
	const f = fixture(t);
	const root = f.project("consumer");
	const client = new Client({ name: "agent-profiles-test", version: "1" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", "--root", root, "--store", f.store],
			cwd: root,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
	const before = tree(root);
	const result = await client.callTool({
		name: "update_preview",
		arguments: { binding: BINDING, version: `${SONNET}@0.1.0`, ...TARGET },
	});
	assert.ok(!result.isError, JSON.stringify(result.content));
	assert.deepEqual(tree(root), before, "the MCP preview writes nothing");
	const mcp = result.structuredContent;
	const run = (...args) =>
		spawnSync(process.execPath, [cli, ...args], {
			encoding: "utf8",
			env: f.env,
			cwd: f.dir,
		});
	const target = [
		"--role",
		TARGET.role,
		"--model",
		TARGET.model,
		"--host",
		TARGET.host,
	];
	const preview = run(
		"update",
		BINDING,
		`${SONNET}@0.1.0`,
		...target,
		"--root",
		root,
		"--store",
		f.store,
		"--json",
	);
	assert.equal(preview.status, 0, preview.stderr);
	assert.deepEqual(mcp, JSON.parse(preview.stdout));
	assert.equal(mcp.after.package, SONNET);

	// #91 through both entry points: the same message, nothing written.
	const bad = "@demo/tool@@demo/tool-variant@1.0.0";
	const cliBad = run(
		"update",
		BINDING,
		bad,
		...target,
		"--root",
		root,
		"--store",
		f.store,
	);
	assert.notEqual(cliBad.status, 0);
	assert.match(cliBad.stderr, /is not an exact safe release version/);
	assert.doesNotMatch(cliBad.stderr, /not in the library/);
	const mcpBad = await client.callTool({
		name: "update_preview",
		arguments: { binding: BINDING, version: bad, ...TARGET },
	});
	assert.ok(mcpBad.isError);
	assert.match(
		JSON.stringify(mcpBad.content),
		/is not an exact safe release version/,
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
	assert.equal(json.previewDigest, mcp.previewDigest);
	assert.equal(json.applyCommand, mcp.applyCommand);
	assert.equal(picked(f, root, TARGET), `base ${SONNET}@0.1.0`);
});
