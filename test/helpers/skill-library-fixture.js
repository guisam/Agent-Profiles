// Shared fixture for skill library tests: a store with three skill package versions,
// a project that pins one and lists a local skill, and a fake DOM for app.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stringify } from "yaml";
import { publishPackage } from "../../src/library.ts";
import { installDependencies } from "../../src/package-lock.ts";

export const REVIEW = "@example/security-review";
export const ALT = "@example/careful-review";

export function put(file, bytes) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}

export function source(dir, name, version, extra = {}) {
	const directory = path.join(
		dir,
		"sources",
		name.replace(/[@/]/g, "_"),
		version,
	);
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name, version, type: "skill", description: `${name} skill` },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "SKILL.md"),
		`---\ndescription: "${name} skill"\n---\nReview ${version}\n`,
	);
	put(path.join(directory, "support/note.txt"), `note ${version}\n`);
	for (const [file, bytes] of Object.entries(extra))
		put(path.join(directory, file), bytes);
	return directory;
}

export function digestTree(directory) {
	const out = {};
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const file = path.join(current, name);
			if (fs.statSync(file).isDirectory()) walk(file);
			else
				out[path.relative(directory, file)] = createHash("sha256")
					.update(fs.readFileSync(file))
					.digest("hex");
		}
	};
	walk(directory);
	return out;
}

export function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-skill-catalog-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = path.join(dir, "store");
	for (const directory of [
		source(dir, REVIEW, "1.0.0"),
		source(dir, REVIEW, "2.0.0", {
			"support/icon.bin": Buffer.from([0, 1, 2, 255]),
		}),
		source(dir, ALT, "1.0.0"),
	])
		publishPackage({ storeRoot: store, sourceDirectory: directory });
	const root = path.join(dir, "project");
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	put(
		path.join(root, ".agent-profiles/skills/testing/SKILL.md"),
		"---\ndescription: Test carefully\n---\nReview 1.0.0\n",
	);
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { "fictional-large": { profile: "base" } },
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: ["security-review"], available: ["testing"] },
				},
			},
			skills: { "security-review": { package: REVIEW, version: "1.0.0" } },
		}),
	);
	installDependencies({ root, storeRoot: store });
	return { dir, store, root };
}

// Only the DOM operations app.js uses; text is always set through textContent.
export async function browser(url) {
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
		set innerHTML(_) {
			throw new Error("innerHTML is not allowed");
		}
	}
	class Option extends Node {
		constructor(text, value) {
			super();
			this.textContent = text;
			this.value = value;
		}
	}
	const nodes = new Map();
	const document = {
		getElementById(id) {
			if (!nodes.has(id)) nodes.set(id, new Node());
			return nodes.get(id);
		},
		createElement: () => new Node(),
		createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
	};
	const dialogs = { messages: [], answer: true };
	vm.runInContext(
		fs.readFileSync(
			new URL("../../src/visualizer/app.js", import.meta.url),
			"utf8",
		),
		vm.createContext({
			document,
			Option,
			URLSearchParams,
			// Records each confirmation message and answers with dialogs.answer.
			confirm: (message) => {
				dialogs.messages.push(message);
				return dialogs.answer;
			},
			// Browsers send Origin on POST; Node's fetch does not, so add it here.
			fetch: (endpoint, init) =>
				fetch(
					new URL(endpoint, url),
					init?.method === "POST"
						? {
								...init,
								headers: { ...init.headers, Origin: new URL(url).origin },
							}
						: init,
				),
		}),
	);
	const texts = (node) =>
		[node.textContent, ...node.children.flatMap(texts)].join("\n");
	const text = (id) => texts(document.getElementById(id));
	const until = async (check) => {
		for (let i = 0; i < 300 && !check(); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(check(), "timed out waiting for the page");
	};
	await until(() => /^(Resolved|Unable)/.test(text("status")));
	return {
		node: (id) => document.getElementById(id),
		text,
		texts,
		until,
		dialogs,
	};
}
