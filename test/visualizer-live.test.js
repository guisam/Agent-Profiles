import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { stringify } from "yaml";
import { approvePackage } from "../src/approvals.ts";
import { publishPackage } from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { startVisualizer } from "../src/visualize.ts";
import { keygen, noKeygen } from "./helpers/trust-fixture.js";

const CONFIG = ".agent-profiles/agents.yaml";
function put(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-visualizer-live-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		adapter = path.join(dir, "adapter"),
		storeRoot = path.join(dir, "store");
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = path.join(dir, "trust.yaml");
	put(process.env.AGENT_PROFILES_TRUST, "version: 1\n");
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
	});
	for (const version of ["1.0.0", "1.1.0"]) {
		const source = path.join(dir, version);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: "@example/tdd", version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(
			path.join(source, "SKILL.md"),
			`---\ndescription: Test driven development\n---\nTDD ${version} λ\n`,
		);
		publishPackage({ sourceDirectory: source, storeRoot });
	}
	put(
		path.join(root, CONFIG),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "implementer",
			models: { declared: { profile: "base" } },
			families: { example: { profile: "base" } },
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	put(
		path.join(root, ".agent-profiles/profiles/base.md"),
		"Base instructions\n",
	);
	put(
		path.join(root, ".agent-profiles/roles/implementer.md"),
		"Project implementer\n",
	);
	put(
		path.join(root, ".agent-profiles/agents.local.yaml"),
		"adapter: ../adapter\n",
	);
	const config = {
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
		assignments: {
			sol: {
				when: { host: "codex", model: "adapter-exact", role: "sp-implementer" },
				versions: { "skills.tdd": "1.1.0" },
			},
		},
	};
	const save = () => put(path.join(adapter, CONFIG), stringify(config));
	save();
	put(
		path.join(adapter, ".agent-profiles/roles/sp-implementer.md"),
		"Adapter implementer\n",
	);
	const install = () => installDependencies({ root, storeRoot });
	install();
	return { dir, root, adapter, storeRoot, config, save, install };
}
async function serve(t, f, extra = {}) {
	const app = await startVisualizer({
		root: f.root,
		storeRoot: f.storeRoot,
		...extra,
	});
	t.after(
		() =>
			new Promise((resolve) => {
				app.server.close(resolve);
				app.server.closeAllConnections();
			}),
	);
	return app;
}

test("composed pickers include adapter roles and exact models without changing routing, and host selects packages", async (t) => {
	const f = fixture(t),
		{ url } = await serve(t, f);
	const config = await (await fetch(`${url}api/config`)).json();
	assert.ok(config.roles.includes("sp-implementer"));
	assert.ok(config.models.includes("adapter-exact"));
	assert.ok(config.hosts.includes("codex") && config.hosts.includes("claude"));
	for (const [host, version] of [
		["codex", "1.1.0"],
		["claude", "1.0.0"],
	]) {
		const input = {
			root: f.root,
			storeRoot: f.storeRoot,
			host,
			model: "adapter-exact",
			role: "sp-implementer",
		};
		const response = await fetch(
			`${url}api/resolve?${new URLSearchParams({ host, model: input.model, role: input.role })}`,
		);
		assert.equal(response.status, 200);
		const result = await response.json();
		assert.deepEqual(result, resolveInstructions(input));
		assert.equal(result.matchedBy, "default");
		assert.equal(result.required[0].package.version, version);
		assert.match(
			result.loaded.find((e) => e.id === "sp-implementer").content,
			/Adapter implementer/,
		);
	}
});

test("composed configuration endpoint refuses stale adapter locks and recovers after explicit repair", async (t) => {
	const f = fixture(t),
		{ url } = await serve(t, f);
	f.config.assignments.sol.versions["skills.tdd"] = "1.0.0";
	f.save();
	const response = await fetch(`${url}api/config`);
	assert.equal(response.status, 400);
	assert.match((await response.json()).error, /stale-lock/);
	f.install();
	assert.equal((await fetch(`${url}api/config`)).status, 200);
});

async function browser(url) {
	class Node {
		children = [];
		textContent = "";
		value = "";
		hidden = false;
		disabled = false;
		listeners = {};
		append(...nodes) {
			this.children.push(...nodes);
		}
		replaceChildren(...nodes) {
			this.children = nodes;
		}
		add(node) {
			this.children.push(node);
		}
		addEventListener(name, fn) {
			this.listeners[name] = fn;
		}
		setAttribute() {}
		removeAttribute() {}
		focus() {}
	}
	class Option extends Node {
		constructor(text, value) {
			super();
			this.textContent = text;
			this.value = value;
		}
	}
	const nodes = new Map(),
		timers = new Map(),
		events = {};
	let next = 0;
	const window = {
		setTimeout(fn) {
			timers.set(++next, fn);
			return next;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		addEventListener(name, fn) {
			events[name] = fn;
		},
	};
	const document = {
		defaultView: window,
		getElementById(id) {
			if (!nodes.has(id)) nodes.set(id, new Node());
			return nodes.get(id);
		},
		createElement: () => new Node(),
		createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
	};
	const context = vm.createContext({
		document,
		window,
		Option,
		URLSearchParams,
		fetch: (endpoint, init) => fetch(new URL(endpoint, url), init),
	});
	vm.runInContext(
		fs.readFileSync(
			new URL("../src/visualizer/app.js", import.meta.url),
			"utf8",
		),
		context,
	);
	for (
		let i = 0;
		i < 300 &&
		!/^(Resolved|Unable)/.test(document.getElementById("status").textContent);
		i++
	)
		await new Promise((r) => setTimeout(r, 10));
	const texts = (node) =>
		[node.textContent, ...node.children.flatMap(texts)].join("\n");
	return {
		nodes,
		context,
		timers,
		events,
		text: (id) => texts(document.getElementById(id)),
		async refresh() {
			await nodes.get("refresh").listeners.click();
			assert.equal(
				timers.size,
				0,
				"manual refresh must not start background polling",
			);
		},
	};
}

test("Refresh files reads live sources, preserves selections, surfaces errors and recovers", async (t) => {
	const f = fixture(t),
		{ url } = await serve(t, f, {
			host: "codex",
			model: "adapter-exact",
			family: "example",
			role: "sp-implementer",
			skills: ["optional"],
		});
	const app = await browser(url);
	assert.match(app.text("status"), /^Resolved/);
	assert.ok(app.nodes.has("host"), "host selector is initialized");
	assert.equal(app.nodes.get("host").value, "codex");
	assert.match(app.text("available"), /Requested, injected/);
	// Atomic replacement, as used by Windows editors.
	const roleFile = path.join(
		f.adapter,
		".agent-profiles/roles/sp-implementer.md",
	);
	put(`${roleFile}.tmp`, "Edited adapter role\n");
	fs.renameSync(`${roleFile}.tmp`, roleFile);
	await app.refresh();
	assert.match(app.text("layers"), /Edited adapter role/);
	for (const [id, value] of Object.entries({
		host: "codex",
		model: "adapter-exact",
		family: "example",
		role: "sp-implementer",
	}))
		assert.equal(app.nodes.get(id).value, value);
	assert.match(app.text("available"), /Requested, injected/);
	app.nodes.get("host").value = "claude";
	await app.nodes.get("host").listeners.change();
	assert.match(app.text("required"), /@example\/tdd@1\.0\.0/);
	f.config.roles.auditor = {
		file: "roles/auditor.md",
		skills: { required: [], available: [] },
	};
	put(path.join(f.adapter, ".agent-profiles/roles/auditor.md"), "Auditor\n");
	f.save();
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, true);
	assert.match(app.text("error"), /stale-lock/);
	f.install();
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, false);
	assert.ok(app.nodes.get("role").children.some((n) => n.value === "auditor"));
	put(path.join(f.adapter, CONFIG), "version: [broken");
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, true);
	f.save();
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, false);
	put(
		path.join(f.root, ".agent-profiles/agents.local.yaml"),
		"adapter: ../missing\n",
	);
	await app.refresh();
	assert.match(app.text("error"), /adapter|missing/i);
	put(
		path.join(f.root, ".agent-profiles/agents.local.yaml"),
		"adapter: ../adapter\n",
	);
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, false);
	delete f.config.roles["sp-implementer"];
	delete f.config.assignments.sol;
	f.save();
	f.install();
	await app.refresh();
	assert.equal(app.nodes.get("role").value, "implementer");
	assert.equal(app.nodes.get("model").value, "");
	assert.match(app.text("notice"), /sp-implementer/);
	assert.match(app.text("notice"), /optional/);
	assert.equal(app.timers.size, 0);
});

test("Refresh files rechecks machine trust and adapter approval signatures without writing repairs", {
	skip: noKeygen,
}, async (t) => {
	const f = fixture(t),
		{ url } = await serve(t, f, {
			host: "claude",
			model: "adapter-exact",
			role: "sp-implementer",
		});
	const app = await browser(url);
	const key = path.join(f.dir, "approver");
	const pub = keygen(key, "visualizer-test");
	put(path.join(f.dir, "allowed_signers"), `tester@example.com ${pub}\n`);
	put(
		process.env.AGENT_PROFILES_TRUST,
		stringify({
			version: 1,
			allowed_signers: "allowed_signers",
			signing_key: key,
			require_approval: true,
		}),
	);
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, true);
	assert.match(app.text("error"), /trust|approv/i);
	approvePackage({
		root: f.root,
		storeRoot: f.storeRoot,
		name: "@example/tdd",
		version: "1.0.0",
	});
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, false);
	const approvals = path.join(
		f.adapter,
		".agent-profiles/approvals/@example/tdd/1.0.0",
	);
	const signature = path.join(
		approvals,
		fs.readdirSync(approvals).find((n) => n.endsWith(".sig")),
	);
	const original = fs.readFileSync(signature);
	put(signature, "broken signature");
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, true);
	assert.equal(fs.readFileSync(signature, "utf8"), "broken signature");
	put(signature, original);
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, false);
});

test("visualize CLI accepts adapter root and host", async (t) => {
	const f = fixture(t);
	const child = spawn(
		process.execPath,
		[
			"bin/agent-profiles.ts",
			"visualize",
			"--root",
			f.root,
			"--store",
			f.storeRoot,
			"--host",
			"codex",
			"--role",
			"sp-implementer",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => child.kill());
	const url = await new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`CLI timeout: ${output}`)),
			10000,
		);
		const consume = (data) => {
			output += data;
			const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`CLI exit ${code}: ${output}`));
		});
	});
	const config = await (await fetch(`${url}api/config`)).json();
	assert.equal(config.initial.host, "codex");
	assert.equal(config.initial.role, "sp-implementer");
});

test("projects without adapters retain explicit unknown model and family across manual refresh", async (t) => {
	const f = fixture(t);
	fs.unlinkSync(path.join(f.root, ".agent-profiles/agents.local.yaml"));
	const { url } = await serve(t, f, {
		model: "unknown-cli-model",
		family: "unknown-cli-family",
	});
	const app = await browser(url);
	await app.refresh();
	assert.equal(app.nodes.get("model").value, "unknown-cli-model");
	assert.equal(app.nodes.get("family").value, "unknown-cli-family");
	await app.nodes.get("refresh").listeners.click();
	assert.equal(app.nodes.get("model").value, "unknown-cli-model");
	put(
		path.join(f.root, ".agent-profiles/profiles/base.md"),
		"Changed project profile\n",
	);
	await app.refresh();
	assert.match(app.text("layers"), /Changed project profile/);
});

test("Refresh files reports connection loss and reconnects on demand", async (t) => {
	const f = fixture(t),
		{ url, server } = await serve(t, f);
	const app = await browser(url);
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
	await app.refresh();
	assert.equal(app.nodes.get("view").hidden, true);
	assert.equal(app.timers.size, 0, "closed server leaves no refresh timer");
	assert.match(app.text("status"), /Refresh files/);
	await new Promise((resolve) =>
		server.listen(Number(new URL(url).port), "127.0.0.1", resolve),
	);
	await app.nodes.get("refresh").listeners.click();
	assert.equal(app.nodes.get("view").hidden, false);
	assert.equal(app.timers.size, 0);
});

test("the idle visualizer does not schedule background refresh", async (t) => {
	const f = fixture(t),
		{ url } = await serve(t, f);
	const app = await browser(url);
	assert.equal(app.timers.size, 0, "no polling after initial resolution");
	await app.refresh();
});
