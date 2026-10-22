import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse, stringify } from "yaml";
import { planRoleChange } from "../src/configure.js";
import { formatContext, resolutionOutput } from "../src/diagnostics.js";
import { inspectRepository } from "../src/inspect.js";
import { installDependencies } from "../src/package-lock.js";
import { importPackage } from "../src/package-store.js";
import {
	applyPresetExport,
	applyPresetImport,
	exportChoices,
	planPresetExport,
	planPresetImport,
	readPreset,
} from "../src/presets.ts";
import { parseYaml, resolveInstructions } from "../src/resolve.js";
import { discoverSkills } from "../src/skills.js";
import { configureRoles } from "../src/wizard.js";

const WORK = os.tmpdir();
const put = (file, text) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
const fingerprint = (dir) =>
	fs
		.readdirSync(dir, { recursive: true })
		.map((file) => String(file).split(path.sep).join("/"))
		.sort()
		.map((file) => {
			const full = path.join(dir, file);
			return fs.statSync(full).isDirectory()
				? `${file}/`
				: `${file} ${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`;
		});
const metadata = {
	name: "review-preset",
	display_name: "Review",
	description: "Review fixture",
	author: "Example",
	version: "1.0.0",
	license: "MIT",
};

function setup(t, { packageProfile = false } = {}) {
	const dir = fs.mkdtempSync(path.join(WORK, "case-"));
	t.after(() => {
		assert.equal(path.dirname(dir), path.resolve(WORK));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const root = path.join(dir, "repo"),
		storeRoot = path.join(dir, "store"),
		ambient = path.join(dir, "empty");
	fs.mkdirSync(ambient);
	const old = process.env.AGENT_PROFILES_STORE;
	process.env.AGENT_PROFILES_STORE = ambient;
	t.after(() => {
		if (old === undefined) delete process.env.AGENT_PROFILES_STORE;
		else process.env.AGENT_PROFILES_STORE = old;
	});
	const digests = {};
	for (const [id, type, delivery] of [
		["check", "skill", "instruction"],
		["native", "skill", "native"],
		["profile", "instruction", "instruction"],
	]) {
		const source = path.join(dir, `source-${id}`);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: `@example/${id}`, version: "1.0.0", type },
				entrypoint: "entry.md",
				behavior: {
					delivery,
					hosts: delivery === "native" ? ["claude"] : [],
					effects: [],
				},
			}),
		);
		put(
			path.join(source, "entry.md"),
			type === "skill"
				? `---\ndescription: ${id} <img src=x onerror=bad> checks.\n---\n${id} body.\n`
				: "# Package profile\n",
		);
		digests[id] = importPackage({ sourceDirectory: source, storeRoot }).sha256;
	}
	const config = {
		version: 2,
		default_profile: "constrained",
		default_role: "reviewer",
		models: {},
		families: {},
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: ["native"], available: ["check", "local", "host"] },
			},
			writer: {
				file: "roles/writer.md",
				skills: { required: [], available: [] },
			},
		},
		skills: {
			check: { package: "@example/check", version: "1.0.0" },
			native: { package: "@example/native", version: "1.0.0" },
			local: { file: ".agent-profiles/local.md" },
			host: { host: "claude", scope: "user", id: "personal" },
		},
	};
	if (packageProfile)
		config.profiles = {
			constrained: { package: "@example/profile", version: "1.0.0" },
		};
	else
		put(
			path.join(root, ".agent-profiles/profiles/constrained.md"),
			"# Local profile\n",
		);
	for (const id of ["reviewer", "writer"])
		put(path.join(root, `.agent-profiles/roles/${id}.md`), `# ${id}\n`);
	put(
		path.join(root, ".agent-profiles/local.md"),
		"---\ndescription: Local checks.\n---\nLocal body.\n",
	);
	const file = path.join(root, ".agent-profiles/agents.yaml");
	const save = () => put(file, stringify(config));
	save();
	// Real dependency install: public required selections below use a current lock (relock after fixture config edits).
	installDependencies({ root, storeRoot });
	const resolve = (options) =>
		resolveInstructions({ root, storeRoot, ...options });
	// These are setup prerequisites, never accepted as the finding's RED evidence.
	const control = resolve({ host: "claude" });
	assert.equal(
		control.available.find((s) => s.id === "check").package.sha256,
		digests.check,
		"fixture explicit resolver digest",
	);
	assert.equal(
		control.required[0].package.sha256,
		digests.native,
		"fixture native resolver digest",
	);
	assert.throws(
		() => resolveInstructions({ root }),
		/missing-package/,
		"fixture ambient store is empty",
	);
	return {
		dir,
		root,
		storeRoot,
		ambient,
		config,
		file,
		save,
		resolve,
		digests,
		control,
	};
}

test("P4B01 local and native references retain their existing instructions", (t) => {
	const f = setup(t);
	const text = formatContext(f.control);
	assert.match(text, /Read `\.agent-profiles\/local.md`/);
	assert.match(text, /Invoke the claude skill `personal`/);
});

test("P4B01 available package has an executable binding-ID load command preserving context", (t) => {
	const f = setup(t);
	const options = {
		host: "claude",
		model: "unlisted' model",
		family: "family' name",
		identitySource: "host-stated",
		role: "reviewer",
	};
	const text = formatContext(f.resolve(options));
	const lines = text.split("\n").filter((line) => line.includes("--skill"));
	assert.equal(lines.length, 2, "one supported load command for each shell");
	for (const line of lines) {
		for (const flag of [
			"--host",
			"--model",
			"--family",
			"--identity-source",
			"--role",
			"--skill",
		])
			assert.ok(line.includes(flag), line);
		assert.match(line, /--skill ['"]check['"]/);
	}
	assert.ok(text.includes("@example/check@1.0.0"));
	assert.ok(text.includes(f.digests.check));
	assert.doesNotMatch(text, /Read `null`|objects\/sha256/);
	assert.ok(!text.includes(f.storeRoot));
	const loaded = f
		.resolve({ ...options, skills: ["check"] })
		.loaded.find((e) => e.kind === "requested-skill");
	assert.equal(loaded.package.sha256, f.digests.check);
	assert.match(loaded.content, /check body/);
});

for (const host of [undefined, "claude"])
	test(`P4B01 native package host ${host ?? "omitted"} has no invented invocation address`, (t) => {
		const f = setup(t);
		const text = formatContext(f.resolve({ host }));
		assert.ok(text.includes("@example/native@1.0.0"), "native identity");
		assert.ok(text.includes(f.digests.native));
		assert.match(text, /invocation (?:is )?(?:not verified|unverified)/i);
		assert.match(text, /claude/);
		assert.doesNotMatch(
			text,
			/Invoke the (?:claude|null) skill `null`|Read `null`/,
		);
	});

// Only the DOM operations used by the actual app; innerHTML use fails the test.
function render(result) {
	class Node {
		children = [];
		textContent = "";
		listeners = {};
		append(...nodes) {
			this.children.push(...nodes);
		}
		replaceChildren(...nodes) {
			this.children = nodes;
		}
		addEventListener(name, fn) {
			this.listeners[name] = fn;
		}
		setAttribute() {}
		removeAttribute() {}
		set innerHTML(_) {
			throw new Error("HTML is forbidden: use text nodes");
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
	// Startup fetch stays pending; render is executed directly with actual resolver JSON, without HTTP/children.
	const context = vm.createContext({
		document,
		result,
		URLSearchParams,
		fetch: () => new Promise(() => {}),
	});
	vm.runInContext(
		`${fs.readFileSync(
			new URL("../src/visualizer/app.js", import.meta.url),
			"utf8",
		)}\nrender(result);`,
		context,
	);
	const texts = (node) =>
		[node.textContent, ...node.children.flatMap(texts)].join("\n");
	return Object.fromEntries([...nodes].map(([id, node]) => [id, texts(node)]));
}

test("P4B02 actual render shows package identity digest provenance and unverified native invocation safely", (t) => {
	const f = setup(t, { packageProfile: true });
	const result = resolutionOutput(f.resolve({ skills: ["check"] }), true);
	const nodes = render(result);
	assert.match(
		nodes.layers,
		/\.agent-profiles\/roles\/reviewer.md/,
		"local path control",
	);
	assert.match(
		nodes.available,
		/\.agent-profiles\/local.md/,
		"local skill control",
	);
	for (const [id, group] of [
		["profile", "layers"],
		["check", "available"],
		["native", "required"],
	]) {
		assert.ok(nodes[group].includes(`@example/${id}@1.0.0`), `${id} identity`);
		assert.ok(nodes[group].includes(f.digests[id]), `${id} full digest`);
		assert.ok(
			nodes[group].includes("binding-default"),
			`${id} selection provenance`,
		);
	}
	assert.match(
		nodes.required,
		/invocation (?:is )?(?:not verified|unverified)/i,
	);
	assert.doesNotMatch(
		nodes.required,
		/invoked through the host|null skill null/,
	);
	const all = Object.values(nodes).join("\n");
	assert.doesNotMatch(all, /undefined: undefined|null: null|objects\/sha256/);
	assert.ok(
		all.includes("<img src=x onerror=bad>"),
		"unsafe-looking metadata remains literal text",
	);
	assert.ok(!all.includes(f.storeRoot));
});

function inspect(f) {
	return inspectRepository({ root: f.root, environmentOptions: { env: {} } });
}

test("P4B03 valid package declarations remain partial and inspection never touches either store", (t) => {
	const f = setup(t, { packageProfile: true });
	const before = [
		fingerprint(f.root),
		fingerprint(f.storeRoot),
		fingerprint(f.ambient),
	];
	const calls = [];
	observe(t, [f.storeRoot, f.ambient], calls, () => {
		const result = inspect(f);
		assert.equal(result.repository.configuration.status, "partial");
		assert.equal(
			result.repository.configuration.profiles[0].verification,
			"not-checked",
		);
	});
	assert.deepEqual(calls, []);
	assert.deepEqual(
		[fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(f.ambient)],
		before,
	);
});

function observe(t, forbidden, calls, run) {
	for (const key of [
		"existsSync",
		"statSync",
		"realpathSync",
		"openSync",
		"readFileSync",
		"readdirSync",
	]) {
		const original = fs[key];
		t.mock.method(fs, key, (...args) => {
			const target = typeof args[0] === "string" ? path.resolve(args[0]) : "";
			if (
				forbidden.some(
					(dir) => target === dir || target.startsWith(dir + path.sep),
				)
			)
				calls.push([key, target]);
			return original(...args);
		});
	}
	syncBuiltinESMExports();
	try {
		return run();
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
}

test("P4B03 numeric skill keys do not escape bounded inspect as a TypeError", (t) => {
	const f = setup(t);
	assert.equal(inspect(f).repository.configuration.status, "partial");
	// Raw YAML preserves numeric keys rather than stringify quoting them.
	const config = parseYaml(fs.readFileSync(f.file, "utf8"));
	config.get("skills").set(
		1,
		new Map([
			["host", "claude"],
			["scope", "user"],
		]),
	);
	config.get("skills").set(
		2,
		new Map([
			["host", "claude"],
			["scope", "user"],
		]),
	);
	put(f.file, stringify(config));
	let result;
	assert.doesNotThrow(() => {
		result = inspect(f);
	});
	assert.ok(
		["invalid", "partial"].includes(result.repository.configuration.status),
	);
	assert.ok(
		result.repository.configuration.problem || result.skills.warnings.length,
	);
	assert.ok(
		result.skills.skills.every((skill) => typeof skill.id === "string"),
	);
});

for (const [label, mutation] of [
	[
		"traversal host ID",
		(c) => {
			c.skills.bad = {
				host: "claude",
				scope: "project",
				id: "../../../outside",
			};
		},
	],
	[
		"unknown host",
		(c) => {
			c.skills.bad = { host: "unknown", scope: "project", id: "ok" };
		},
	],
	[
		"invalid scope",
		(c) => {
			c.skills.bad = { host: "claude", scope: "bogus", id: "ok" };
		},
	],
	[
		"missing role file",
		(c) => {
			delete c.roles.writer.file;
		},
	],
	[
		"missing profile ID",
		(c) => {
			delete c.default_profile;
		},
	],
	...["profiles", "roles", "skills"].flatMap((field) =>
		[null, [], false].map((value) => [
			`${field} ${JSON.stringify(value)}`,
			(c) => {
				c[field] = value;
			},
		]),
	),
])
	test(`P4B03 malformed ${label} is diagnosed without unsafe or undefined IO`, (t) => {
		const f = setup(t);
		assert.equal(inspect(f).repository.configuration.status, "partial");
		const sentinel = path.join(f.dir, "outside");
		put(path.join(sentinel, "SKILL.md"), "SENTINEL-DO-NOT-READ");
		mutation(f.config);
		f.save();
		const calls = [];
		const forbidden = [
			sentinel,
			path.join(f.root, ".agent-profiles/undefined"),
			path.join(f.root, ".agent-profiles/profiles/undefined.md"),
			f.storeRoot,
			f.ambient,
		];
		let result;
		observe(t, forbidden, calls, () => {
			assert.doesNotThrow(() => {
				result = inspect(f);
			});
		});
		assert.deepEqual(
			calls,
			[],
			"reject malformed declarations before probing paths",
		);
		assert.ok(
			["invalid", "partial"].includes(result.repository.configuration.status),
		);
		assert.ok(
			result.repository.configuration.problem || result.skills.warnings.length,
		);
		assert.ok(
			!result.skills.skills.some((skill) => skill.id === "bad"),
			"malformed host declaration is not inventoried",
		);
		assert.ok(!JSON.stringify(result).includes("SENTINEL-DO-NOT-READ"));
		assert.equal(
			fs.readFileSync(path.join(sentinel, "SKILL.md"), "utf8"),
			"SENTINEL-DO-NOT-READ",
		);
	});

for (const field of ["profiles", "roles", "skills"])
	test(`P4B03 implicit null ${field} remains invalid with package declarations`, (t) => {
		const f = setup(t, { packageProfile: true });
		assert.equal(inspect(f).repository.configuration.status, "partial");
		const document = fs.readFileSync(f.file, "utf8");
		// YAML parse/stringify emits an explicit null; remove only that null scalar.
		f.config[field] = null;
		f.save();
		put(
			f.file,
			fs.readFileSync(f.file, "utf8").replace(`${field}: null`, `${field}:`),
		);
		assert.notEqual(document, fs.readFileSync(f.file, "utf8"));
		assert.equal(inspect(f).repository.configuration.status, "invalid");
	});

test("P4B04 discovery and inspect include declarations without verified type digest or cache path", (t) => {
	const f = setup(t);
	const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
	const found = discoverSkills(
		f.root,
		parseYaml(fs.readFileSync(f.file, "utf8")),
	);
	assert.ok(
		found.skills.some(
			(s) => s.id === "local" && s.path === ".agent-profiles/local.md",
		),
	);
	for (const list of [found.skills, inspect(f).skills.skills])
		for (const id of ["check", "native"]) {
			const entry = list.find((s) => s.id === id);
			assert.ok(entry, `${id} declared inventory`);
			assert.equal(entry.path, null);
			assert.equal(entry.verification, "not-checked");
			assert.deepEqual(entry.package, {
				binding: `skills.${id}`,
				name: `@example/${id}`,
				version: "1.0.0",
			});
			assert.equal(entry.package.sha256, undefined);
			assert.notEqual(entry.type, "instruction");
			assert.notEqual(entry.type, "host");
		}
	assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

for (const action of ["create", "edit"])
	test(`P4B04 scripted wizard ${action} selects declared package and preserves preview refusal then apply`, async (t) => {
		const f = setup(t);
		const id = action === "create" ? "new-role" : "writer";
		const before = fingerprint(f.root),
			storeBefore = fingerprint(f.storeRoot);
		let round = 0,
			toggles = 0,
			listed = false;
		const output = [];
		const ask = async (prompt) => {
			if (prompt.startsWith("Roles:"))
				return round++ < 2 ? (action === "create" ? "c" : "e") : "q";
			if (prompt.startsWith("Role identifier")) return id;
			if (prompt.startsWith("Toggle numbers")) {
				const step = toggles++ % 3;
				if (step === 0) {
					const choice = output
						.slice()
						.reverse()
						.find((line) => /^\d+\. \[ \] check —/.test(line));
					assert.ok(
						choice,
						"wizard offers the declared package to an unassigned role",
					);
					listed = true;
					return choice.match(/^\d+/)[0];
				}
				return "";
			}
			if (prompt.startsWith("Save role")) {
				assert.deepEqual(
					fingerprint(f.root),
					before,
					"preview and refused save have no writes",
				);
				assert.ok(
					output.some((line) => line.includes(f.digests.check)),
					"preview verified the selection with the real resolver",
				);
				return round === 1 ? "n" : "y";
			}
			return "";
		};
		await configureRoles({
			root: f.root,
			storeRoot: f.storeRoot,
			ask,
			write: (line) => output.push(String(line)),
		});
		assert.equal(listed, true);
		assert.deepEqual(
			output.filter((line) => line.startsWith("Error:")),
			[],
		);
		const after = parse(fs.readFileSync(f.file, "utf8"));
		assert.deepEqual(after.roles[id].skills.required, ["check"]);
		assert.deepEqual(after.skills, f.config.skills);
		// The wizard edit leaves the lock stale; validation checks the applied package selection.
		assert.equal(
			f.resolve({ role: id, lockMode: "validation" }).required[0].package
				.sha256,
			f.digests.check,
		);
		assert.deepEqual(fingerprint(f.storeRoot), storeBefore);
		assert.deepEqual(
			fingerprint(f.root).filter(
				(line) =>
					!line.startsWith(".agent-profiles/agents.yaml ") &&
					!line.startsWith(".agent-profiles/roles/new-role.md "),
			),
			before.filter((line) => !line.startsWith(".agent-profiles/agents.yaml ")),
		);
	});

test("P4B04 forged and stale verified selections still refuse before mutation", (t) => {
	const f = setup(t);
	const selected = f.control.available.find((s) => s.id === "check");
	const before = fingerprint(f.root);
	for (const delta of [
		{ binding: "skills.other" },
		{ name: "@example/other" },
		{ version: "9.0.0" },
		{ sha256: "0".repeat(64) },
	]) {
		assert.throws(
			() =>
				planRoleChange({
					root: f.root,
					storeRoot: f.storeRoot,
					action: "edit",
					id: "writer",
					required: [
						{ ...selected, package: { ...selected.package, ...delta } },
					],
				}),
			/current package binding|changed since/,
		);
	}
	assert.deepEqual(fingerprint(f.root), before);
});

function preset(f) {
	const source = path.join(f.dir, "preset");
	put(
		path.join(source, "preset.yaml"),
		stringify({
			schema_version: 1,
			preset: metadata,
			roles: {
				tester: {
					file: "roles/tester.md",
					skills: { required: [], available: [] },
				},
			},
			profiles: { constrained: { file: "profiles/constrained.md" } },
		}),
	);
	put(path.join(source, "roles/tester.md"), "# Tester\n");
	put(path.join(source, "profiles/constrained.md"), "# Incoming profile\n");
	assert.equal(readPreset(source).profiles.size, 1, "valid schema-1 fixture");
	return source;
}

test("P4B05 local preset import control is ready and applies", (t) => {
	const f = setup(t);
	const source = preset(f);
	const plan = planPresetImport({
		root: f.root,
		storeRoot: f.storeRoot,
		source,
		decisions: new Map([["profiles.constrained", "rename:incoming"]]),
	});
	assert.equal(plan.ready, true, plan.errors.join("\n"));
	applyPresetImport(plan, true);
	assert.match(
		fs.readFileSync(
			path.join(f.root, ".agent-profiles/profiles/incoming.md"),
			"utf8",
		),
		/Incoming/,
	);
});

test("P4B05 package profile collision offers conflict keep rename and refuses referenced replace without writes", (t) => {
	const f = setup(t, { packageProfile: true });
	f.config.assignments = {
		"profile-pin": { when: {}, versions: { "profiles.constrained": "1.0.0" } },
	};
	f.save();
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	assert.equal(
		f.resolve({}).loaded[0].package.selectedBy,
		"profile-pin",
		"assignment fixture",
	);
	const source = preset(f),
		before = fingerprint(f.root);
	const plan = (decisions) =>
		planPresetImport({
			root: f.root,
			storeRoot: f.storeRoot,
			source,
			decisions: new Map(decisions),
		});
	const conflict = plan([]);
	assert.deepEqual(
		conflict.conflicts.map((c) => c.key),
		["profiles.constrained"],
	);
	assert.equal(conflict.ready, false);
	assert.throws(() => applyPresetImport(conflict, true), /conflicts/);
	const kept = plan([["profiles.constrained", "keep"]]);
	assert.equal(kept.ready, true, kept.errors.join("\n"));
	assert.ok(kept.actions.includes("Keep profiles.constrained"));
	assert.equal(
		kept.proposed.get("profiles").get("constrained").get("package"),
		"@example/profile",
	);
	const renamed = plan([["profiles.constrained", "rename:incoming"]]);
	assert.equal(renamed.ready, true, renamed.errors.join("\n"));
	const replaced = plan([["profiles.constrained", "replace"]]);
	assert.equal(replaced.ready, false);
	assert.match(replaced.errors.join("\n"), /profiles\.constrained/);
	assert.throws(() => applyPresetImport(replaced, true));
	assert.deepEqual(fingerprint(f.root), before);
	applyPresetImport(kept, true);
	const secondBefore = fingerprint(f.root);
	const keepAll = plan([
		["roles.tester", "keep"],
		["profiles.constrained", "keep"],
	]);
	assert.deepEqual(applyPresetImport(keepAll, true).modified, []);
	assert.deepEqual(fingerprint(f.root), secondBefore, "keep is an exact no-op");
	// The kept import left the lock stale; validation checks the package profile survived.
	assert.equal(
		f.resolve({ lockMode: "validation" }).loaded[0].package.sha256,
		f.digests.profile,
	);
});

test("P4B06 missing local profiles directory permits local-role export and preserves package refusal", (t) => {
	const f = setup(t, { packageProfile: true });
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/profiles")),
		false,
	);
	const before = fingerprint(f.root);
	assert.deepEqual(exportChoices(f.root, { storeRoot: f.storeRoot }).profiles, [
		"constrained",
	]);
	const destination = path.join(f.dir, "export");
	const options = {
		root: f.root,
		storeRoot: f.storeRoot,
		destination,
		metadata,
		roles: ["writer"],
		profiles: [],
	};
	const plan = planPresetExport(options);
	assert.equal(fs.existsSync(destination), false);
	applyPresetExport(plan, true);
	assert.equal(readPreset(destination).roles.size, 1);
	assert.throws(
		() =>
			planPresetExport({
				...options,
				destination: path.join(f.dir, "refused"),
				profiles: ["constrained"],
			}),
		/profiles\.constrained: preset-package-unsupported/,
	);
	assert.equal(fs.existsSync(path.join(f.dir, "refused")), false);
	assert.deepEqual(fingerprint(f.root), before);
});

test("P4B06 non-ENOENT directory errors remain errors", (t) => {
	const f = setup(t, { packageProfile: true });
	put(path.join(f.root, ".agent-profiles/profiles"), "not a directory");
	assert.throws(
		() => exportChoices(f.root, { storeRoot: f.storeRoot }),
		(error) => error.code === "ENOTDIR",
	);
});

// Decode only the emitted literal flag/value grammar; never execute payloads.
function contextCommandArgs(section, shell) {
	const command = section.match(
		new RegExp(`Command \\(${shell}\\): \`([\\s\\S]*?)\`(?:\\n|$)`),
	)?.[1];
	assert.ok(command, `${shell} command exists`);
	const prefix = "npx --no agent-profiles resolve";
	assert.ok(command.startsWith(prefix));
	const tail = command.slice(prefix.length),
		args = [];
	const pair =
		shell === "Bash"
			? / (--[\w-]+) ('[^']*'(?:"'"'[^']*')*)/gy
			: / (--[\w-]+) ('(?:[^']|'')*')/gy;
	let offset = 0;
	while (offset < tail.length) {
		pair.lastIndex = offset;
		const match = pair.exec(tail);
		assert.ok(
			match,
			`${shell} accepts only literal flag/value pairs at ${offset}`,
		);
		args.push(
			match[1],
			match[2]
				.slice(1, -1)
				.replaceAll(shell === "Bash" ? "'\"'\"'" : "''", "'"),
		);
		offset = pair.lastIndex;
	}
	return args;
}

for (const shell of ["Bash", "PowerShell"])
	for (const action of ["load second package", "Run again"]) {
		test(
			"P4B01 retention " +
				shell +
				" " +
				action +
				" preserves ordered explicit instructions and is idempotent",
			(t) => {
				const f = setup(t);
				const source = path.join(f.dir, "source-second");
				put(
					path.join(source, "package.yaml"),
					stringify({
						schema_version: 1,
						package: {
							name: "@example/second",
							version: "1.0.0",
							type: "skill",
						},
						entrypoint: "entry.md",
						behavior: { delivery: "instruction", hosts: [], effects: [] },
					}),
				);
				put(
					path.join(source, "entry.md"),
					"---\ndescription: Second package.\n---\nSecond body.\n",
				);
				const secondDigest = importPackage({
					sourceDirectory: source,
					storeRoot: f.storeRoot,
				}).sha256;
				f.config.skills.second = {
					package: "@example/second",
					version: "1.0.0",
				};
				f.config.skills.required = { file: ".agent-profiles/required.md" };
				put(
					path.join(f.root, ".agent-profiles/required.md"),
					"---\ndescription: Required checks.\n---\nRequired body.\n",
				);
				f.config.roles.reviewer.skills.required.push("required");
				f.config.roles.reviewer.skills.available.push("second");
				f.save();
				installDependencies({ root: f.root, storeRoot: f.storeRoot });
				const options = {
					host: "claude",
					model: "unlisted' \"$HOME $(payload) `payload`; & | < >\nmodel",
					family: "family' \"$HOME $(payload) `payload`; & | < >\nname",
					identitySource: "host-stated",
					role: "reviewer",
				};
				const baseArgs = [
					"--host",
					"claude",
					"--identity-source",
					"host-stated",
					"--model",
					options.model,
					"--family",
					options.family,
					"--role",
					"reviewer",
				];
				const first = f.resolve({
					...options,
					skills: ["local", "check", "local"],
				});
				assert.deepEqual(
					first.available
						.filter((e) => e.package && e.type === "instruction")
						.map((e) => e.id),
					["check", "second"],
					"two actual available instruction packages",
				);
				assert.deepEqual(
					first.loaded
						.filter((e) => e.kind === "requested-skill")
						.map((e) => e.id),
					["local", "check"],
					"fixture requested order differs from available order",
				);
				assert.equal(
					first.available.find((e) => e.id === "second").package.sha256,
					secondDigest,
				);
				const initialText = formatContext(first);
				const section =
					action === "Run again"
						? initialText.split("## Run again\n")[1]
						: initialText.split("- second")[1].split("## Run again")[0];
				const expected =
					action === "Run again"
						? ["local", "check"]
						: ["local", "check", "second"];
				const follow = (text, ids) => {
					const args = contextCommandArgs(text, shell);
					assert.deepEqual(
						args.slice(0, baseArgs.length),
						baseArgs,
						"all identity, host, supplied family and assigned role values survive literal quoting",
					);
					assert.deepEqual(
						args.slice(baseArgs.length),
						ids.flatMap((id) => ["--skill", id]),
						"retain original explicit IDs in order; append new binding once; exclude required skills",
					);
					const decoded = { skills: [] };
					const fields = {
						"--host": "host",
						"--identity-source": "identitySource",
						"--model": "model",
						"--family": "family",
						"--role": "role",
					};
					for (let i = 0; i < args.length; i += 2) {
						if (args[i] === "--skill") decoded.skills.push(args[i + 1]);
						else {
							assert.ok(fields[args[i]], "known context flag");
							decoded[fields[args[i]]] = args[i + 1];
						}
					}
					const result = f.resolve(decoded);
					assert.deepEqual(
						result.loaded
							.filter((e) => e.kind === "requested-skill")
							.map((e) => e.id),
						ids,
						"real resolver retains actual ordered instructions",
					);
					assert.deepEqual(
						result.loaded
							.filter((e) => e.kind === "required-skill")
							.map((e) => e.id),
						["required"],
					);
					assert.equal(
						result.loaded.find((e) => e.id === "check").package.sha256,
						f.digests.check,
					);
					assert.match(
						result.loaded.find((e) => e.id === "check").content,
						/check body/,
					);
					assert.match(
						result.loaded.find((e) => e.id === "local").content,
						/Local body/,
					);
					assert.match(
						result.loaded.find((e) => e.id === "required").content,
						/Required body/,
					);
					if (ids.includes("second")) {
						assert.equal(
							result.loaded.find((e) => e.id === "second").package.sha256,
							secondDigest,
						);
						assert.match(
							result.loaded.find((e) => e.id === "second").content,
							/Second body/,
						);
						assert.ok(
							result.loaded.findIndex((e) => e.id === "check") <
								result.loaded.findIndex((e) => e.id === "second"),
							"actual package A precedes B",
						);
					}
					return result;
				};
				let result = follow(section, expected);
				for (let repeat = 0; repeat < 2; repeat++) {
					const next = follow(
						formatContext(result).split("## Run again\n")[1],
						expected,
					);
					assert.deepEqual(
						next.loaded,
						result.loaded,
						"repeated command keeps exact bodies, identities, order and accounting without duplicates",
					);
					result = next;
				}
				if (action === "Run again")
					follow(
						formatContext(result).split("- second")[1].split("## Run again")[0],
						["local", "check", "second"],
					);
			},
		);
	}
