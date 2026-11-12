// #119: bind library package versions to roles and replace same-name variants from
// the visualizer. Variants share a SKILL.md name; replacing one for a host × model ×
// role goes through update's preview and guarded apply.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { applyConfigEdit, configRevision } from "../src/config-edit.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { parseYaml, resolveInstructions } from "../src/resolve.ts";
import { retainRevisionManifest } from "../src/revisions.ts";
import { skillCatalog } from "../src/skill-catalog.ts";
import { startVisualizer } from "../src/visualize.ts";
import { browser, put } from "./helpers/skill-library-fixture.js";

const CONFIG = ".agent-profiles/agents.yaml";
const BASE = "@demo/brainstorming";
const SONNET = "@demo/brainstorming-sonnet";
const STRICT = "@demo/brainstorming-strict";
const TUPLE = { role: "brainstormer", model: "model-a", host: "claude" };

/** A v3 project pinning BASE for skill `brainstorming`; SONNET and STRICT are same-name variants. */
function fixture(t, { trust = "" } = {}) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-skill-variants-")),
	);
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = path.join(dir, "trust.yaml");
	if (trust) put(process.env.AGENT_PROFILES_TRUST, trust);
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const store = path.join(dir, "store");
	const labels = new Map();
	for (const [name, version] of [
		[BASE, "1.0.0"],
		[SONNET, "0.1.0"],
		[STRICT, "1.0.0"],
	]) {
		const source = path.join(dir, "sources", name.slice(1), version);
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
			`---\nname: brainstorming\ndescription: brainstorm\n---\n# ${name} ${version}\n`,
		);
		const imported = importPackage({
			sourceDirectory: source,
			storeRoot: store,
		});
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
	const root = path.join(dir, "project");
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# base\n");
	for (const role of ["brainstormer", "worker"])
		put(path.join(root, `.agent-profiles/roles/${role}.md`), `# ${role}\n`);
	put(
		path.join(root, CONFIG),
		stringify({
			version: 3,
			default_profile: "base",
			default_role: "brainstormer",
			models: { "model-a": { profile: "base" } },
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				brainstormer: {
					file: "roles/brainstormer.md",
					skills: { required: ["brainstorming"], available: [] },
				},
				worker: {
					file: "roles/worker.md",
					skills: { required: [], available: [] },
				},
			},
			skills: {
				brainstorming: {
					package: BASE,
					version: "1.0.0",
					revision: labels.get(`${BASE}@1.0.0`),
				},
			},
		}),
	);
	installDependencies({ root, storeRoot: store });
	return { dir, root, store, labels };
}

const config = (f) =>
	parseYaml(fs.readFileSync(path.join(f.root, CONFIG), "utf8"));
const edit = (f, change, revision = configRevision(f.root)) =>
	applyConfigEdit({ root: f.root, storeRoot: f.store, revision, edit: change });
const selected = (f, tuple, id = "brainstorming") => {
	const result = resolveInstructions({
		root: f.root,
		storeRoot: f.store,
		...tuple,
	});
	return [...result.required, ...result.available].find(
		(skill) => skill.id === id,
	)?.package.name;
};

test("the catalog links same-name variants and lists role skills", (t) => {
	const f = fixture(t);
	const catalog = skillCatalog({ root: f.root, storeRoot: f.store });
	const version = (name) =>
		catalog.packages.find((item) => item.name === name).versions[0];
	for (const name of [BASE, SONNET, STRICT]) {
		assert.equal(version(name).skillName, "brainstorming");
		assert.deepEqual(version(name).sameName, ["brainstorming"]);
	}
	assert.deepEqual(catalog.packageSkills, ["brainstorming"]);
	assert.deepEqual(catalog.roles.brainstormer, {
		required: ["brainstorming"],
		available: [],
	});
});

test("a variant replaces a binding for one host × model × role through update", (t) => {
	const f = fixture(t);
	const request = {
		binding: "skills.brainstorming",
		target: `${SONNET}@0.1.0`,
		assignment: TUPLE,
	};
	const before = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	const plan = edit(f, { action: "preview-replace", ...request });
	assert.equal(plan.status, "preview");
	assert.deepEqual([plan.before.package, plan.after.package], [BASE, SONNET]);
	assert.deepEqual(plan.trustBlockers, []);
	assert.equal(fs.readFileSync(path.join(f.root, CONFIG), "utf8"), before);

	assert.throws(
		() => edit(f, { action: "apply-replace", ...request }),
		/Preview the replacement/,
	);
	assert.throws(
		() =>
			edit(f, { action: "apply-replace", ...request, expect: "0".repeat(64) }),
		/changed since the preview/,
	);
	assert.equal(fs.readFileSync(path.join(f.root, CONFIG), "utf8"), before);

	const applied = edit(f, {
		action: "apply-replace",
		...request,
		expect: plan.previewDigest,
	});
	assert.equal(applied.status, "updated");
	assert.equal(selected(f, TUPLE), SONNET);
	// Every other selection keeps the default.
	assert.equal(selected(f, { ...TUPLE, host: "codex" }), BASE);
	assert.equal(selected(f, { role: "brainstormer" }), BASE);
});

test("an unbound version is bound in the role's layer with its revision", (t) => {
	const f = fixture(t);
	const result = edit(f, {
		action: "bind-skill",
		role: "worker",
		list: "available",
		package: STRICT,
		version: "1.0.0",
	});
	// The SKILL.md name is taken by the existing binding, so the ID is numbered.
	assert.deepEqual(result, {
		layer: "project",
		file: CONFIG,
		id: "brainstorming-2",
	});
	const after = config(f);
	assert.deepEqual(
		Object.fromEntries(after.get("skills").get("brainstorming-2")),
		{
			package: STRICT,
			version: "1.0.0",
			revision: f.labels.get(`${STRICT}@1.0.0`),
		},
	);
	assert.deepEqual(
		after.get("roles").get("worker").get("skills").get("available"),
		["brainstorming-2"],
	);
	assert.equal(
		selected(
			f,
			{ role: "worker", skills: ["brainstorming-2"] },
			"brainstorming-2",
		),
		STRICT,
	);
});

test("binding can replace a same-name skill in the role in one write", (t) => {
	const f = fixture(t);
	edit(f, {
		action: "bind-skill",
		role: "brainstormer",
		list: "required",
		package: STRICT,
		version: "1.0.0",
		replace: "brainstorming",
	});
	assert.deepEqual(
		config(f).get("roles").get("brainstormer").get("skills").get("required"),
		["brainstorming-2"],
	);
	assert.equal(
		selected(f, { role: "brainstormer" }, "brainstorming-2"),
		STRICT,
	);
	assert.throws(
		() =>
			edit(f, {
				action: "bind-skill",
				role: "worker",
				list: "required",
				package: STRICT,
				version: "1.0.0",
				replace: "brainstorming",
			}),
		/not listed by role worker/,
	);
});

test("the trust policy refuses an unapproved package and nothing is written", (t) => {
	const f = fixture(t, { trust: "version: 1\nrequire_approval: true\n" });
	const before = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	assert.throws(
		() =>
			edit(f, {
				action: "bind-skill",
				role: "worker",
				list: "available",
				package: STRICT,
				version: "1.0.0",
			}),
		/trust policy refuses/,
	);
	assert.equal(fs.readFileSync(path.join(f.root, CONFIG), "utf8"), before);
});

test("the page offers a variant for the selected host × model × role and asks first", async (t) => {
	const f = fixture(t);
	const app = await startVisualizer({
		root: f.root,
		storeRoot: f.store,
		allowEdits: true,
		host: "claude",
		model: "model-a",
		role: "brainstormer",
	});
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const page = await browser(app.url);
	await page.node("library-load").listeners.click();
	page.node("library-search").value = "brainstorming-sonnet";
	page.node("library-search").listeners.input();
	const [use] = page.node("library-rows").children[0].children[6].children;
	assert.equal(
		use.textContent,
		"Use for brainstormer instead of brainstorming…",
	);
	const before = fs.readFileSync(path.join(f.root, CONFIG), "utf8");
	page.dialogs.answer = false;
	await use.listeners.click();
	const message = page.dialogs.messages.at(-1);
	assert.match(
		message,
		/Replace brainstorming for brainstormer × model-a × claude\?/,
	);
	assert.match(message, /Now: @demo\/brainstorming@1\.0\.0/);
	assert.match(message, /New: @demo\/brainstorming-sonnet@0\.1\.0/);
	assert.match(message, /Evidence: untested/);
	assert.equal(fs.readFileSync(path.join(f.root, CONFIG), "utf8"), before);

	page.dialogs.answer = true;
	await use.listeners.click();
	assert.match(
		page.text("notice"),
		/brainstorming now selects @demo\/brainstorming-sonnet@0\.1\.0/,
	);
	assert.equal(selected(f, TUPLE), SONNET);
	assert.equal(selected(f, { role: "brainstormer" }), BASE);

	// An unbound variant in a role without the skill is bound and added.
	page.node("role").value = "worker";
	await page.node("role").listeners.change();
	page.node("library-search").value = "brainstorming-strict";
	page.node("library-search").listeners.input();
	const add = page.node("library-rows").children[0].children[6].children;
	assert.deepEqual(
		add.map((button) => button.textContent),
		[
			"Bind and add to worker as required",
			"Bind and add to worker as available",
		],
	);
	await add[1].listeners.click();
	assert.deepEqual(
		config(f).get("roles").get("worker").get("skills").get("available"),
		["brainstorming-2"],
	);
});
