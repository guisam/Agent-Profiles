import assert from "node:assert/strict";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import {
	applyConfigEdit,
	configRevision,
	EditConflict,
} from "../src/config-edit.ts";
import { publishPackage } from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import { parseYaml, resolveInstructions } from "../src/resolve.ts";
import { startVisualizer } from "../src/visualize.ts";
import { browser, fixture, put } from "./helpers/skill-library-fixture.js";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const read = (root, file = CONFIG) =>
	fs.readFileSync(path.join(root, file), "utf8");
const config = (root) => parseYaml(read(root));
const lists = (root, role) => {
	const skills = config(root).get("roles").get(role).get("skills");
	return [skills.get("required"), skills.get("available")];
};
// The edited project must resolve with a current lock, as the visualizer requires.
const resolves = (f, role) =>
	resolveInstructions({ root: f.root, storeRoot: f.store, role });

function edit(f, change, revision = configRevision(f.root)) {
	return applyConfigEdit({
		root: f.root,
		storeRoot: f.store,
		revision,
		edit: change,
	});
}

test("role skills move, add and remove in the project file with locks refreshed", (t) => {
	const f = fixture(t);
	fs.writeFileSync(
		path.join(f.root, CONFIG),
		`# Keep this comment\n${read(f.root)}`,
	);
	installDependencies({ root: f.root, storeRoot: f.store });
	const lockBefore = read(f.root, LOCK);

	assert.deepEqual(
		edit(f, {
			action: "add-skill",
			role: "reviewer",
			skill: "testing",
			list: "required",
		}),
		{ layer: "project", file: CONFIG },
	);
	assert.deepEqual(lists(f.root, "reviewer"), [
		["security-review", "testing"],
		[],
	]);
	assert.match(read(f.root), /^# Keep this comment/);
	assert.notEqual(read(f.root, LOCK), lockBefore, "lock refreshed");
	assert.deepEqual(
		resolves(f, "reviewer").required.map((skill) => skill.id),
		["security-review", "testing"],
	);

	edit(f, {
		action: "remove-skill",
		role: "reviewer",
		skill: "security-review",
	});
	assert.deepEqual(lists(f.root, "reviewer"), [["testing"], []]);
	assert.deepEqual(
		resolves(f, "reviewer").required.map((skill) => skill.id),
		["testing"],
	);
	edit(f, {
		action: "add-skill",
		role: "reviewer",
		skill: "security-review",
		list: "available",
	});
	assert.deepEqual(lists(f.root, "reviewer"), [
		["testing"],
		["security-review"],
	]);
	resolves(f, "reviewer");
});

test("models, families and roles are added to the project", (t) => {
	const f = fixture(t);
	edit(f, { action: "add-model", id: "fictional-new.1", profile: "base" });
	edit(f, {
		action: "add-family",
		id: "fictional",
		profile: "base",
		prefixes: ["fictional-"],
	});
	edit(f, { action: "add-role", id: "auditor", description: "Audit changes" });
	const after = config(f.root);
	assert.equal(
		after.get("models").get("fictional-new.1").get("profile"),
		"base",
	);
	assert.deepEqual(
		after.get("families").get("fictional").get("match").get("prefixes"),
		["fictional-"],
	);
	assert.match(
		read(f.root, ".agent-profiles/roles/auditor.md"),
		/Audit changes/,
	);
	assert.equal(
		resolveInstructions({
			root: f.root,
			storeRoot: f.store,
			model: "fictional-new.1",
			role: "auditor",
		}).profile,
		"base",
	);
});

test("stale, invalid and duplicate edits write nothing", (t) => {
	const f = fixture(t);
	const before = read(f.root);
	const lock = read(f.root, LOCK);
	assert.throws(
		() =>
			edit(
				f,
				{ action: "add-model", id: "other", profile: "base" },
				"0".repeat(64),
			),
		(error) =>
			error instanceof EditConflict && /Refresh files/.test(error.message),
	);
	for (const [change, message] of [
		[
			{
				action: "add-skill",
				role: "reviewer",
				skill: "missing",
				list: "required",
			},
			/missing/,
		],
		[
			{
				action: "add-skill",
				role: "reviewer",
				skill: "testing",
				list: "available",
			},
			/already available/,
		],
		[{ action: "remove-skill", role: "reviewer", skill: "nope" }, /not listed/],
		[
			{ action: "add-model", id: "fictional-large", profile: "base" },
			/already exists/,
		],
		[
			{ action: "add-model", id: "has space", profile: "base" },
			/without spaces/,
		],
		[{ action: "add-model", id: "x", profile: "unknown" }, /not valid/],
		[{ action: "add-family", id: "Bad", profile: "base" }, /lowercase/],
		[{ action: "add-role", id: "reviewer" }, /already exists/],
		[{ action: "delete-everything" }, /Unknown edit action/],
	])
		assert.throws(() => edit(f, change), message);
	assert.equal(read(f.root), before);
	assert.equal(read(f.root, LOCK), lock);
});

function adapterFixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-config-edit-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	const adapter = path.join(dir, "adapter");
	const store = path.join(dir, "store");
	const source = path.join(dir, "tdd");
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: "@example/tdd", version: "1.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(path.join(source, "SKILL.md"), "---\ndescription: TDD\n---\nTDD\n");
	publishPackage({ sourceDirectory: source, storeRoot: store });
	put(
		path.join(root, CONFIG),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "implementer",
			models: {},
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	put(path.join(root, ".agent-profiles/profiles/base.md"), "Base\n");
	put(path.join(root, ".agent-profiles/roles/implementer.md"), "Implement\n");
	put(
		path.join(root, ".agent-profiles/agents.local.yaml"),
		"adapter: ../adapter\n",
	);
	put(
		path.join(adapter, CONFIG),
		stringify({
			version: 2,
			skills: {
				tdd: { package: "@example/tdd", version: "1.0.0" },
				optional: { package: "@example/tdd", version: "1.0.0" },
			},
			roles: {
				"sp-implementer": {
					file: "roles/sp-implementer.md",
					skills: { required: ["tdd"], available: ["optional"] },
				},
			},
		}),
	);
	put(path.join(adapter, ".agent-profiles/roles/sp-implementer.md"), "SP\n");
	installDependencies({ root, storeRoot: store });
	return { root, adapter, store };
}

test("with an adapter, each edit is written to the layer that owns it", (t) => {
	const f = adapterFixture(t);
	const project = read(f.root);
	// An adapter role is edited in the adapter.
	assert.equal(
		edit(f, {
			action: "add-skill",
			role: "sp-implementer",
			skill: "optional",
			list: "required",
		}).layer,
		"adapter",
	);
	assert.deepEqual(lists(f.adapter, "sp-implementer"), [
		["tdd", "optional"],
		[],
	]);
	// An adapter skill added to a project role is appended by the adapter.
	assert.equal(
		edit(f, {
			action: "add-skill",
			role: "implementer",
			skill: "tdd",
			list: "available",
		}).layer,
		"adapter",
	);
	assert.deepEqual(
		config(f.adapter)
			.get("roles")
			.get("implementer")
			.get("skills")
			.get("available"),
		["tdd"],
	);
	assert.equal(read(f.root), project, "project file untouched");
	assert.deepEqual(
		resolves(f, "implementer").available.map((skill) => skill.id),
		["tdd"],
	);
	edit(f, { action: "remove-skill", role: "implementer", skill: "tdd" });
	assert.deepEqual(resolves(f, "implementer").available, []);
	// Models are project policy, and the adapter lock is refreshed for the composition.
	assert.equal(
		edit(f, { action: "add-model", id: "new-model", profile: "base" }).layer,
		"project",
	);
	assert.equal(
		resolveInstructions({
			root: f.root,
			storeRoot: f.store,
			model: "new-model",
			role: "sp-implementer",
		}).profile,
		"base",
	);
});

function post(app, body, headers = {}) {
	const url = new URL(`${app.url}api/edit`);
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: "POST",
				headers: {
					Origin: url.origin,
					"Content-Type": "application/json",
					"X-Agent-Profiles-Edit": "1",
					...headers,
				},
			},
			(response) => {
				let text = "";
				response.on("data", (chunk) => {
					text += chunk;
				});
				response.on("end", () =>
					resolve({ status: response.statusCode, body: JSON.parse(text) }),
				);
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

test("the edit endpoint is off by default and guarded when enabled", async (t) => {
	const f = fixture(t);
	const before = read(f.root);
	const change = { action: "add-model", id: "served", profile: "base" };
	const readOnly = await startVisualizer({ root: f.root, storeRoot: f.store });
	t.after(() => new Promise((resolve) => readOnly.server.close(resolve)));
	const refused = await post(readOnly, {
		revision: configRevision(f.root),
		edit: change,
	});
	assert.equal(refused.status, 405);
	assert.equal(refused.body.error, "Read-only: GET required");

	const app = await startVisualizer({
		root: f.root,
		storeRoot: f.store,
		allowEdits: true,
	});
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const revision = configRevision(f.root);
	for (const headers of [
		{ Origin: "http://evil.example" },
		{ "Content-Type": "text/plain" },
		{ "X-Agent-Profiles-Edit": "" },
	])
		assert.equal(
			(await post(app, { revision, edit: change }, headers)).status,
			403,
		);
	assert.equal(
		(await post(app, { revision: "stale", edit: change })).status,
		409,
	);
	assert.equal(read(f.root), before, "refused requests wrote nothing");
	const saved = await post(app, { revision, edit: change });
	assert.equal(saved.status, 200);
	assert.deepEqual(saved.body, { layer: "project", file: CONFIG });
	assert.equal(
		(await post(app, { revision, edit: change })).status,
		409,
		"the old revision is stale after a write",
	);
});

test("the page adds and removes role skills when edits are enabled", async (t) => {
	const f = fixture(t);
	const app = await startVisualizer({
		root: f.root,
		storeRoot: f.store,
		allowEdits: true,
	});
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const page = await browser(app.url);
	assert.equal(page.node("mode-badge").textContent, "LOCAL · EDITS ON");
	assert.equal(page.node("edit-panel").hidden, false);
	await page.node("library-load").listeners.click();
	page.node("library-search").value = "Test carefully";
	page.node("library-search").listeners.input();
	const add = page.node("library-rows").children[0].children[6].children;
	assert.deepEqual(
		add.map((button) => button.textContent),
		["Add to reviewer as required", "Add to reviewer as available"],
	);
	await add[0].listeners.click();
	assert.match(page.text("notice"), /testing added to reviewer as required/);
	assert.deepEqual(lists(f.root, "reviewer"), [
		["security-review", "testing"],
		[],
	]);
	const button = (column, text) =>
		page
			.node(column)
			.children.flatMap((card) => card.children ?? [])
			.find((node) => node.textContent === text);

	// Move between the lists in both directions.
	const toOnDemand = page
		.node("required")
		.children.filter((card) => /testing/.test(page.texts(card)))
		.flatMap((card) => card.children)
		.find((node) => node.textContent === "Move to on demand");
	await toOnDemand.listeners.click();
	assert.deepEqual(lists(f.root, "reviewer"), [
		["security-review"],
		["testing"],
	]);
	assert.match(page.text("notice"), /testing moved to on demand for reviewer/);
	const toRequired = page
		.node("available")
		.children.filter((card) => /testing/.test(page.texts(card)))
		.flatMap((card) => card.children)
		.find((node) => node.textContent === "Move to required");
	await toRequired.listeners.click();
	assert.deepEqual(lists(f.root, "reviewer"), [
		["security-review", "testing"],
		[],
	]);

	// Removal asks first; cancelling changes nothing.
	const configBefore = read(f.root);
	page.dialogs.answer = false;
	button("required", "Remove testing from reviewer").listeners.click();
	assert.match(
		page.dialogs.messages.at(-1),
		/Remove testing from role reviewer\?/,
	);
	assert.match(page.dialogs.messages.at(-1), /edits your configuration now/);
	assert.equal(read(f.root), configBefore);
	assert.match(
		page.text("status"),
		/Kept testing in reviewer; nothing was changed/,
	);
	page.dialogs.answer = true;
	await button("required", "Remove testing from reviewer").listeners.click();
	assert.deepEqual(lists(f.root, "reviewer"), [["security-review"], []]);

	// The help explains the chosen kind and each of its fields.
	for (const [kind, pattern, absent] of [
		["family", /Prefixes[\s\S]*longest matching prefix wins/, /Description/],
		["role", /Description[\s\S]*roles\/<ID>\.md/, /Prefixes/],
		["model", /exact model ID[\s\S]*Profile/, /Prefixes/],
	]) {
		page.node("add-kind").value = kind;
		page.node("add-kind").listeners.change();
		assert.match(page.text("add-help"), pattern);
		assert.doesNotMatch(page.text("add-help"), absent);
	}
	page.node("add-kind").value = "model";
	page.node("add-id").value = "page-model";
	page.node("add-profile").value = "base";
	await page.node("add-run").listeners.click();
	await page.until(() => /^Resolved/.test(page.text("status")));
	assert.equal(
		config(f.root).get("models").get("page-model").get("profile"),
		"base",
	);
	assert.equal(page.node("model").value, "page-model");
});
