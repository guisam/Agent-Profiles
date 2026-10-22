import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { stringify } from "yaml";
import {
	formatContext,
	formatProof,
	resolutionOutput,
} from "../src/diagnostics.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { retainRevisionManifest } from "../src/revisions.ts";

const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const none = () => ({ file: "WORKFLOW.md", provides: [], requires: [] });
const declaration = (protocol, major = 1) => ({ protocol, major });

function snapshot(root) {
	const rows = [];
	function visit(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name,
				target = path.join(root, member),
				stat = fs.lstatSync(target);
			if (stat.isSymbolicLink())
				rows.push([member, "link", fs.readlinkSync(target)]);
			else if (stat.isDirectory()) {
				rows.push([member, "directory"]);
				visit(member);
			} else
				rows.push([
					member,
					stat.nlink,
					fs.readFileSync(target).toString("hex"),
				]);
		}
	}
	visit();
	return rows;
}
function readOnly(f, operation) {
	const project = snapshot(f.root),
		store = snapshot(f.storeRoot);
	try {
		return operation();
	} finally {
		assert.deepEqual(
			snapshot(f.root),
			project,
			"read/refusal preserves project membership and bytes",
		);
		assert.deepEqual(
			snapshot(f.storeRoot),
			store,
			"read/refusal preserves store membership and bytes",
		);
	}
}
function add(f, id, { version = "1.0.0", native = false } = {}) {
	const name = `@example/${id}`,
		directory = path.join(f.dir, "sources", id);
	const entry = `---\r\nname: ${id}\r\ndescription: Fictional ${id} task\r\n---\r\n# TASK-${id} café  \r\nRead WORKFLOW.md.\r\n`;
	const workflow = `# WORKFLOW-${id}\r\nKeep ${id} check-in evidence.  \r\n`;
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name, version, type: "skill" },
			entrypoint: "SKILL.md",
			behavior: {
				delivery: native ? "native" : "instruction",
				hosts: native ? ["claude"] : [],
				effects: [],
			},
		}),
	);
	put(path.join(directory, "SKILL.md"), entry);
	put(path.join(directory, "WORKFLOW.md"), workflow);
	const imported = importPackage({
		sourceDirectory: directory,
		storeRoot: f.storeRoot,
	});
	const pkg = { ...imported, name, version, entry, workflow };
	f.packages.set(id, pkg);
	return pkg;
}
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-workflow-review-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const f = {
		dir,
		root: path.join(dir, "project"),
		storeRoot: path.join(dir, "store"),
		packages: new Map(),
		profile: "\uFEFF# Local profile\r\n",
		role: "# Local worker\r\n",
		note: "---\ndescription: Unloaded note\n---\nNOTE-ONLY\n",
	};
	add(f, "reviewer", { version: "1.2.3" });
	add(f, "extra");
	put(path.join(f.root, ".agent-profiles/profiles/base.md"), f.profile);
	put(path.join(f.root, ".agent-profiles/roles/worker.md"), f.role);
	put(path.join(f.root, "instructions/note.md"), f.note);
	put(
		path.join(f.root, "AGENTS.md"),
		"# Repository rules remain independent\r\n",
	);
	f.configFile = path.join(f.root, ".agent-profiles/agents.yaml");
	f.config = {
		version: 2,
		default_profile: "base",
		default_role: "worker",
		models: { beta: { profile: "base" } },
		families: {},
		roles: {
			worker: {
				file: "roles/worker.md",
				skills: { required: ["reviewer"], available: ["extra", "note"] },
			},
		},
		skills: {
			reviewer: { package: "@example/reviewer", version: "1.2.3" },
			extra: { package: "@example/extra", version: "1.0.0" },
			note: { file: "instructions/note.md" },
		},
	};
	activate(f, f.config);
	return f;
}
function activate(f, config) {
	put(f.configFile, stringify(config));
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
}
function resolve(f, selectors = {}) {
	return readOnly(f, () =>
		resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			model: "beta",
			role: "worker",
			host: "claude",
			...selectors,
		}),
	);
}
function record(f, id, workflow = none(), dependencies = []) {
	const pkg = f.packages.get(id),
		manifestFile = path.join(f.dir, `${id}-revision.json`);
	put(
		manifestFile,
		JSON.stringify({
			revisionVersion: 1,
			identity: pkg.identity,
			kind: "release",
			content: { identity: pkg.identity, sha256: pkg.sha256 },
			parent: null,
			candidate: null,
			dependencies,
			workflow,
			provenance: {
				kind: "legacy-adoption",
				workflowChange: {
					kind: "initial",
					reason:
						"Declare fictional existing content without an evaluation claim.",
				},
			},
		}),
	);
	return retainRevisionManifest({ storeRoot: f.storeRoot, manifestFile });
}
function reference(pkg, retained) {
	return {
		package: pkg.name,
		version: pkg.version,
		...(retained ? { revision: retained.recordDigest } : {}),
	};
}
function reuse(t, requested = false) {
	const f = fixture(t),
		reviewer = f.packages.get("reviewer"),
		reviewerRecord = record(f, "reviewer");
	const extraRecord = record(f, "extra", none(), [
		{
			name: reviewer.name,
			version: reviewer.version,
			sha256: reviewer.sha256,
			revisionDigest: reviewerRecord.recordDigest,
		},
	]);
	const config = structuredClone(f.config);
	config.version = 3;
	config.skills.reviewer = reference(reviewer, reviewerRecord);
	config.skills.extra = reference(f.packages.get("extra"), extraRecord);
	config.roles.worker.skills = requested
		? { required: ["extra"], available: ["reviewer", "note"] }
		: { required: ["extra", "reviewer"], available: ["note"] };
	activate(f, config);
	return { f, config, reviewer, reviewerRecord };
}
function taskParts(result, pkg) {
	return result.loaded.filter(
		(part) =>
			part.backing?.sha256 === pkg.sha256 && part.backing.path === "SKILL.md",
	);
}
function physicalReuse(result, f) {
	const reviewer = f.packages.get("reviewer"),
		extra = f.packages.get("extra");
	for (const pkg of [reviewer, extra]) {
		assert.equal(
			taskParts(result, pkg).length,
			1,
			`${pkg.name} task injected once`,
		);
		assert.equal(
			result.loaded.filter(
				(part) =>
					part.backing?.sha256 === pkg.sha256 &&
					part.backing.path === "WORKFLOW.md",
			).length,
			1,
			`${pkg.name} workflow injected once`,
		);
	}
	assert.ok(
		result.loaded.indexOf(taskParts(result, reviewer)[0]) <
			result.loaded.indexOf(taskParts(result, extra)[0]),
		"dependency precedes dependent",
	);
	const bodies = [
		f.profile,
		f.role,
		reviewer.entry,
		reviewer.workflow,
		extra.entry,
		extra.workflow,
	];
	assert.deepEqual(result.diagnostics.managed.total, {
		files: bodies.length,
		bytes: bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
		characters: bodies.reduce((sum, body) => sum + [...body].length, 0),
	});
	assert.equal(
		result.loaded.reduce((sum, part) => sum + part.bytes, 0),
		result.diagnostics.managed.total.bytes,
	);
}
function directPin(item, pkg, retained) {
	assert.deepEqual(item.package, {
		binding: "skills.reviewer",
		name: pkg.name,
		version: pkg.version,
		sha256: pkg.sha256,
		revisionDigest: retained.recordDigest,
		selectedBy: "binding-default",
		selectors: {},
	});
}

for (const placement of ["required", "requested"])
	for (const host of ["claude", "codex", undefined]) {
		test(`F1 native ${placement} root preserves invoke-only base conversion for ${host ?? "omitted host"}`, (t) => {
			const f = fixture(t),
				invoke = add(f, "invoke", { native: true });
			const config = structuredClone(f.config);
			config.skills.invoke = reference(invoke);
			config.roles.worker.skills =
				placement === "required"
					? { required: ["invoke"], available: [] }
					: { required: [], available: ["invoke"] };
			activate(f, config);
			const selectors = {
					host,
					skills: placement === "requested" ? ["invoke"] : [],
				},
				before = resolve(f, selectors);
			const descriptor =
				placement === "required" ? before.required[0] : before.available[0];
			assert.equal(descriptor.type, "host");
			assert.equal(descriptor.delivery, "invoke");
			assert.deepEqual(descriptor.supportedHosts, ["claude"]);
			assert.equal(descriptor.verification, "verified-package");
			assert.equal(
				descriptor.usable,
				host === undefined ? null : host === "claude",
			);
			assert.equal(descriptor.bytes, null);
			assert.equal(descriptor.characters, null);
			assert.equal(
				before.unsatisfied.length,
				placement === "required" && host === "codex" ? 1 : 0,
			);
			assert.deepEqual(
				before.loaded.map((part) => part.kind),
				["profile", "role"],
			);
			config.version = 3;
			activate(f, config);
			const after = resolve(f, selectors),
				actual =
					placement === "required" ? after.required[0] : after.available[0];
			const { revisionDigest, ...legacyPackage } = actual.package;
			assert.equal(revisionDigest, null);
			assert.deepEqual({ ...actual, package: legacyPackage }, descriptor);
			assert.deepEqual(after.unsatisfied, before.unsatisfied);
			assert.deepEqual(after.diagnostics, before.diagnostics);
			assert.deepEqual(after.loaded, before.loaded);
			assert.equal(after.workflow.runtime, "unverified");
			assert.equal(
				after.loaded.some(
					(part) =>
						part.backing?.sha256 === invoke.sha256 ||
						part.content === invoke.entry,
				),
				false,
			);
			assert.equal(formatContext(after, f).includes(invoke.entry), false);
			if (placement === "requested")
				assert.deepEqual(after.requestedSkills, ["invoke"]);
		});
	}

test("F1 instruction root control keeps actual managed bytes across base conversion", (t) => {
	const f = fixture(t),
		before = resolve(f),
		config = structuredClone(f.config);
	assert.equal(before.loaded.at(-1).content, f.packages.get("reviewer").entry);
	config.version = 3;
	activate(f, config);
	const after = resolve(f);
	assert.deepEqual(
		after.loaded.map((part) => part.content),
		before.loaded.map((part) => part.content),
	);
	assert.deepEqual(
		after.diagnostics.managed.total,
		before.diagnostics.managed.total,
	);
	assert.equal(after.loaded.at(-1).package.revisionDigest, null);
});

test("F1 native dependency remains an explicit refusal rather than injected or discarded", (t) => {
	const f = fixture(t),
		native = add(f, "invoke", { native: true });
	assert.equal(
		resolve(f).loaded.at(-1).content,
		f.packages.get("reviewer").entry,
		"real instruction-root control",
	);
	const retained = record(f, "reviewer", none(), [
		{
			name: native.name,
			version: native.version,
			sha256: native.sha256,
			revisionDigest: null,
		},
	]);
	const config = structuredClone(f.config);
	config.version = 3;
	config.skills.reviewer = reference(f.packages.get("reviewer"), retained);
	activate(f, config);
	assert.throws(
		() => resolve(f),
		/native prerequisite cannot be injected; invocation unverified/,
	);
});

test("F2 dependency-first reuse retains direct required measurement and exact binding provenance", (t) => {
	const { f, reviewer, reviewerRecord } = reuse(t),
		result = resolve(f);
	physicalReuse(result, f);
	const direct = result.required.find((item) => item.id === "reviewer");
	directPin(direct, reviewer, reviewerRecord);
	assert.equal(direct.bytes, Buffer.byteLength(reviewer.entry));
	assert.equal(direct.characters, [...reviewer.entry].length);
	assert.equal(result.diagnostics.managed.requiredSkills.files, 2);
	assert.equal(
		result.diagnostics.managed.requiredSkills.bytes,
		Buffer.byteLength(reviewer.entry) +
			Buffer.byteLength(f.packages.get("extra").entry),
	);
});

test("F2 requested reused reviewer retains re-entry state and is not reported unloaded", (t) => {
	const { f, reviewer, reviewerRecord } = reuse(t, true),
		result = resolve(f, { skills: ["reviewer"] });
	physicalReuse(result, f);
	assert.deepEqual(result.requestedSkills, ["reviewer"]);
	const direct = result.available.find((item) => item.id === "reviewer");
	directPin(direct, reviewer, reviewerRecord);
	assert.equal(direct.bytes, Buffer.byteLength(reviewer.entry));
	assert.equal(
		result.diagnostics.availableNotLoaded.files,
		1,
		"only note remains unloaded",
	);
	assert.equal(
		result.diagnostics.availableNotLoaded.bytes,
		Buffer.byteLength(f.note),
	);
	assert.equal(result.diagnostics.managed.requestedSkills.files, 1);
	assert.equal(
		result.diagnostics.managed.requestedSkills.bytes,
		Buffer.byteLength(reviewer.entry),
	);
	const availableProof = formatProof(result)
		.split("Available, not injected")[1]
		.split("Host-native skills")[0];
	assert.doesNotMatch(availableProof, /reviewer/);
	assert.match(availableProof, /note/);
	const context = formatContext(result, {
		root: f.root,
		storeRoot: f.storeRoot,
	});
	const availableContext = context
		.split("## Available skills")[1]
		.split("## Run again")[0];
	assert.doesNotMatch(availableContext, /reviewer/);
	assert.match(availableContext, /note/);
	assert.match(context.split("## Run again")[1], /--skill 'reviewer'/);
	assert.ok(context.includes(f.storeRoot));
});

function chain(t, major = 1) {
	const f = fixture(t),
		p = "@example/p",
		q = "@example/q";
	add(f, "orchestrator");
	const aRecord = record(f, "orchestrator", {
		...none(),
		requires: [declaration(p)],
	});
	const bRecord = record(f, "reviewer", {
		...none(),
		provides: [declaration(p)],
		requires: [declaration(q)],
	});
	const cRecord = record(f, "extra", {
		...none(),
		provides: [declaration(q, major)],
	});
	const actors = {
		a: { role: "a", model: "a", host: "claude" },
		b: { role: "b", model: "b", host: "claude" },
		c: { role: "c", model: "c", host: "claude" },
	};
	const peer = (actor, binding) => ({ assignment: actors[actor], binding });
	const config = {
		version: 3,
		default_profile: "base",
		default_role: "a",
		models: {
			a: { profile: "base" },
			b: { profile: "base" },
			c: { profile: "base" },
		},
		families: {},
		roles: Object.fromEntries(
			[
				["a", "orchestrator"],
				["b", "reviewer"],
				["c", "extra"],
			].map(([role, skill]) => [
				role,
				{
					file: "roles/worker.md",
					skills: { required: [skill], available: [] },
				},
			]),
		),
		skills: {
			orchestrator: reference(f.packages.get("orchestrator"), aRecord),
			reviewer: reference(f.packages.get("reviewer"), bRecord),
			extra: reference(f.packages.get("extra"), cRecord),
		},
		workflow_links: {
			q: {
				protocol: q,
				consumer: peer("b", "skills.reviewer"),
				providers: [peer("c", "skills.extra")],
			},
			p: {
				protocol: p,
				consumer: peer("a", "skills.orchestrator"),
				providers: [peer("b", "skills.reviewer")],
			},
		},
	};
	activate(f, config);
	const row = (
		protocol,
		consumer,
		binding,
		consumerRecord,
		provider,
		providerBinding,
		providerRecord,
	) => ({
		protocol,
		major: 1,
		consumer: {
			assignment: actors[consumer],
			binding,
			revisionDigest: consumerRecord.recordDigest,
		},
		provider: {
			assignment: actors[provider],
			binding: providerBinding,
			revisionDigest: providerRecord.recordDigest,
		},
	});
	return {
		f,
		config,
		actors,
		expected: [
			row(
				p,
				"a",
				"skills.orchestrator",
				aRecord,
				"b",
				"skills.reviewer",
				bRecord,
			),
			row(q, "b", "skills.reviewer", bRecord, "c", "skills.extra", cRecord),
		],
	};
}
for (const actor of ["b", "a"])
	test(`F3 complete p-q chain resolves from ${actor === "b" ? "middle actor control" : "consumer endpoint"}`, (t) => {
		const { f, actors, expected } = chain(t),
			result = resolve(f, actors[actor]);
		assert.equal(result.workflow.status, "declared-compatible");
		assert.equal(result.workflow.runtime, "unverified");
		assert.deepEqual(
			[...result.workflow.peers].sort((a, b) =>
				a.protocol.localeCompare(b.protocol),
			),
			expected,
		);
		const own = f.packages.get(actor === "a" ? "orchestrator" : "reviewer");
		assert.deepEqual(
			result.loaded
				.filter((part) => part.package)
				.map((part) => part.package.name),
			[own.name, own.name],
		);
		assert.equal(result.loaded[2].content, own.entry);
		assert.equal(result.loaded[3].content, own.workflow);
	});
test("F3 missing downstream q link refuses from the otherwise-valid middle actor without writes", (t) => {
	const { f, config, actors } = chain(t);
	assert.equal(resolve(f, actors.b).workflow.status, "declared-compatible");
	delete config.workflow_links.q;
	activate(f, config);
	assert.throws(
		() => resolve(f, actors.b),
		/workflow required: missing explicit workflow link/,
	);
});
test("F3 incompatible q major refuses at the actual reached protocol without writes", (t) => {
	const { f, actors } = chain(t, 2);
	assert.throws(
		() => resolve(f, actors.b),
		/workflow protocol: incompatible major/,
	);
});

function render(result) {
	class Node {
		constructor(tag = "") {
			this.tag = tag;
			this.children = [];
			this.textContent = "";
			this.listeners = {};
		}
		append(...nodes) {
			this.children.push(...nodes);
		}
		replaceChildren(...nodes) {
			this.children = nodes;
		}
		addEventListener(name, listener) {
			this.listeners[name] = listener;
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
		createElement: (tag) => new Node(tag),
		createTextNode: (text) => Object.assign(new Node(), { textContent: text }),
	};
	// Pending startup fetch; execute the real renderer with real resolver JSON, no server/browser or test-source extraction.
	const context = vm.createContext({
		document,
		result: resolutionOutput(result, true),
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
	const descend = (node) => [node, ...node.children.flatMap(descend)];
	const entries = ["layers", "required", "available"].flatMap((id) =>
		descend(nodes.get(id)),
	);
	return { nodes, entries };
}
function bodyCount(view, content) {
	return view.entries.filter(
		(node) => node.tag === "pre" && node.textContent === content,
	).length;
}
function sourceLabel(view, pkg, file) {
	return view.entries.some(
		(node) =>
			node.tag === "code" &&
			node.textContent.includes(`${pkg.name}@${pkg.version}`) &&
			node.textContent.includes(file),
	);
}
function renderTotals(view, result) {
	assert.equal(
		view.nodes.get("total").textContent,
		`${result.diagnostics.managed.total.bytes.toLocaleString("en-US")} B`,
	);
	assert.ok(
		view.nodes
			.get("total-chars")
			.textContent.includes(
				`${result.diagnostics.managed.total.files} instruction entries`,
			),
	);
}
test("F4 DOM actual renderer exposes the counted workflow body and its source label once", (t) => {
	const f = fixture(t),
		retained = record(f, "reviewer"),
		config = structuredClone(f.config);
	config.version = 3;
	config.skills.reviewer = reference(f.packages.get("reviewer"), retained);
	activate(f, config);
	const result = resolve(f),
		pkg = f.packages.get("reviewer"),
		view = render(result);
	assert.equal(
		result.loaded.filter((part) => part.kind === "workflow").length,
		1,
	);
	assert.equal(result.diagnostics.managed.total.files, 4);
	assert.equal(
		result.diagnostics.managed.total.bytes,
		[f.profile, f.role, pkg.entry, pkg.workflow].reduce(
			(sum, body) => sum + Buffer.byteLength(body),
			0,
		),
	);
	assert.equal(
		bodyCount(view, pkg.entry),
		1,
		"actual direct task rendering control",
	);
	renderTotals(view, result);
	assert.equal(
		bodyCount(view, pkg.workflow),
		1,
		"counted workflow body inspectable once",
	);
	assert.equal(
		sourceLabel(view, pkg, "WORKFLOW.md"),
		true,
		"backing path must appear in code/source label, not just task prose",
	);
});
test("F4 DOM actual renderer exposes dependency task and workflow identities and backing once", (t) => {
	const { f } = reuse(t, true),
		result = resolve(f),
		view = render(result),
		reviewer = f.packages.get("reviewer");
	physicalReuse(result, f);
	assert.ok(
		result.loaded.some(
			(part) =>
				part.kind === "dependency" && part.package.name === reviewer.name,
		),
	);
	assert.equal(
		bodyCount(view, f.packages.get("extra").entry),
		1,
		"actual root task rendering control",
	);
	renderTotals(view, result);
	assert.equal(
		bodyCount(view, reviewer.entry),
		1,
		"dependency task inspectable once",
	);
	assert.equal(bodyCount(view, reviewer.workflow), 1);
	assert.equal(sourceLabel(view, reviewer, "SKILL.md"), true);
	assert.equal(sourceLabel(view, reviewer, "WORKFLOW.md"), true);
});
test("F4 DOM requested reused reviewer is selected and inspectable rather than labeled uninjected", (t) => {
	const { f, reviewer } = reuse(t, true),
		result = resolve(f, { skills: ["reviewer"] }),
		view = render(result);
	physicalReuse(result, f);
	assert.deepEqual(result.requestedSkills, ["reviewer"]);
	renderTotals(view, result);
	const checkbox = view.entries.find(
		(node) => node.tag === "input" && node.id === "skill-reviewer",
	);
	assert.ok(checkbox, "reviewer remains an explicit on-demand choice");
	assert.equal(checkbox.checked, true);
	const label = view.entries.find(
		(node) => node.tag === "label" && node.children.includes(checkbox),
	);
	assert.ok(
		label.children.some((node) =>
			node.textContent.includes("reviewer · Requested, injected"),
		),
	);
	assert.equal(
		view.nodes.get("available-total").textContent,
		`${Buffer.byteLength(f.note).toLocaleString("en-US")} B`,
	);
	assert.equal(bodyCount(view, reviewer.entry), 1);
	assert.equal(bodyCount(view, reviewer.workflow), 1);
});

function nativeRootReadiness(t, known, peer = false) {
	const f = fixture(t),
		native = add(f, "invoke", { native: true }),
		reviewer = f.packages.get("reviewer");
	const protocol = "@example/p";
	const dependency = record(
		f,
		"reviewer",
		peer ? { ...none(), provides: [declaration(protocol)] } : none(),
	);
	const nativeRecord = record(
		f,
		"invoke",
		known ? { file: null, provides: [], requires: [] } : null,
		[
			{
				name: reviewer.name,
				version: reviewer.version,
				sha256: reviewer.sha256,
				revisionDigest: dependency.recordDigest,
			},
		],
	);
	const config = structuredClone(f.config);
	config.version = 3;
	config.skills.reviewer = reference(reviewer, dependency);
	config.skills.invoke = reference(native, nativeRecord);
	config.roles.worker.skills = { required: ["invoke"], available: [] };
	const consumer = { role: "coordinator", model: "beta", host: "claude" },
		provider = { role: "worker", model: "beta", host: "claude" };
	let consumerRecord;
	if (peer) {
		const orchestrator = add(f, "orchestrator");
		consumerRecord = record(f, "orchestrator", {
			...none(),
			requires: [declaration(protocol)],
		});
		config.skills.orchestrator = reference(orchestrator, consumerRecord);
		config.roles.coordinator = {
			file: "roles/worker.md",
			skills: { required: ["orchestrator"], available: [] },
		};
		config.workflow_links = {
			p: {
				protocol,
				consumer: { assignment: consumer, binding: "skills.orchestrator" },
				providers: [{ assignment: provider, binding: "skills.invoke" }],
			},
		};
	}
	activate(f, config);
	return {
		f,
		native,
		reviewer,
		dependency,
		nativeRecord,
		consumerRecord,
		consumer,
		provider,
		protocol,
	};
}
function nativeRootParts(result, state) {
	const { native, reviewer, nativeRecord, f } = state,
		root = result.required.find((item) => item.id === "invoke");
	assert.equal(root.type, "host");
	assert.equal(root.delivery, "invoke");
	assert.equal(root.usable, true);
	assert.deepEqual(root.supportedHosts, ["claude"]);
	assert.equal(root.verification, "verified-package");
	assert.equal(root.bytes, null);
	assert.equal(root.characters, null);
	assert.deepEqual(result.unsatisfied, []);
	assert.equal(root.package.binding, "skills.invoke");
	assert.equal(root.package.name, native.name);
	assert.equal(root.package.sha256, native.sha256);
	assert.equal(root.package.revisionDigest, nativeRecord.recordDigest);
	assert.equal(
		result.loaded.some((part) => part.backing?.sha256 === native.sha256),
		false,
	);
	assert.equal(
		result.loaded.some(
			(part) =>
				part.content === native.entry || part.content === native.workflow,
		),
		false,
	);
	assert.equal(taskParts(result, reviewer).length, 1);
	assert.equal(
		result.loaded.filter(
			(part) =>
				part.backing?.sha256 === reviewer.sha256 &&
				part.backing.path === "WORKFLOW.md",
		).length,
		1,
	);
	assert.equal(taskParts(result, reviewer)[0].content, reviewer.entry);
	assert.equal(
		result.loaded.find(
			(part) =>
				part.backing?.sha256 === reviewer.sha256 &&
				part.backing.path === "WORKFLOW.md",
		).content,
		reviewer.workflow,
	);
	assert.equal(result.diagnostics.managed.total.files, 4);
	assert.equal(
		result.diagnostics.managed.total.bytes,
		[f.profile, f.role, reviewer.entry, reviewer.workflow].reduce(
			(sum, body) => sum + Buffer.byteLength(body),
			0,
		),
	);
	assert.equal(result.workflow.runtime, "unverified");
}
for (const known of [true, false])
	test(
		"R1 native root with managed dependency preserves " +
			(known
				? "explicit empty declaration control"
				: "unknown declaration status"),
		(t) => {
			const state = nativeRootReadiness(t, known),
				result = resolve(state.f);
			nativeRootParts(result, state);
			assert.equal(
				result.workflow.status,
				known ? "declared-compatible" : "unverified",
			);
		},
	);
for (const known of [true, false])
	test(
		"R1 native peer provider closure " +
			(known
				? "accepts explicit empty root control"
				: "refuses unknown root declaration"),
		(t) => {
			const state = nativeRootReadiness(t, known, true),
				{ f, consumer, provider } = state;
			if (known) {
				const worker = resolve(f, provider);
				nativeRootParts(worker, state);
				assert.equal(worker.workflow.status, "declared-compatible");
				const result = resolve(f, consumer);
				assert.deepEqual(result.workflow, {
					status: "declared-compatible",
					runtime: "unverified",
					peers: [
						{
							protocol: state.protocol,
							major: 1,
							consumer: {
								assignment: consumer,
								binding: "skills.orchestrator",
								revisionDigest: state.consumerRecord.recordDigest,
							},
							provider: {
								assignment: provider,
								binding: "skills.invoke",
								revisionDigest: state.dependency.recordDigest,
							},
						},
					],
				});
				const orchestrator = f.packages.get("orchestrator");
				assert.deepEqual(
					result.loaded
						.filter((part) => part.package)
						.map((part) => part.package.name),
					[orchestrator.name, orchestrator.name],
				);
				assert.equal(
					result.loaded.some(
						(part) => part.backing?.sha256 === state.native.sha256,
					),
					false,
				);
				assert.equal(
					result.loaded.some(
						(part) => part.backing?.sha256 === state.reviewer.sha256,
					),
					false,
					"peer dependency is verified, not injected into consumer",
				);
			} else {
				assert.throws(
					() => resolve(f, consumer),
					/workflow.*(?:unknown|declaration)|provider.*(?:unknown|metadata)/i,
				);
				assert.throws(
					() => resolve(f, provider),
					/workflow.*(?:unknown|declaration)|provider.*(?:unknown|metadata)/i,
				);
			}
		},
	);

function secondReviewerUse(t, requested) {
	const state = reuse(t),
		{ f, config, reviewer, reviewerRecord } = state;
	const baseline = resolve(f);
	physicalReuse(baseline, f);
	directPin(
		baseline.required.find((item) => item.id === "reviewer"),
		reviewer,
		reviewerRecord,
	);
	assert.equal(
		baseline.required.find((item) => item.id === "reviewer").bytes,
		Buffer.byteLength(reviewer.entry),
		"original direct use control",
	);
	config.skills["reviewer-copy"] = structuredClone(config.skills.reviewer);
	config.roles.worker.skills = requested
		? { required: ["extra", "reviewer"], available: ["reviewer-copy", "note"] }
		: { required: ["extra", "reviewer", "reviewer-copy"], available: ["note"] };
	activate(f, config);
	return {
		...state,
		result: resolve(f, { skills: requested ? ["reviewer-copy"] : [] }),
	};
}
function reviewerUse(item, id, state) {
	assert.ok(item, `actual direct descriptor for ${id}`);
	assert.equal(item.id, id);
	assert.deepEqual(item.package, {
		binding: `skills.${id}`,
		name: state.reviewer.name,
		version: state.reviewer.version,
		sha256: state.reviewer.sha256,
		revisionDigest: state.reviewerRecord.recordDigest,
		selectedBy: "binding-default",
		selectors: {},
	});
	assert.equal(item.bytes, Buffer.byteLength(state.reviewer.entry));
	assert.equal(item.characters, [...state.reviewer.entry].length);
}
test("R2 both required reviewer aliases retain direct measurements while physical categories stay unique", (t) => {
	const state = secondReviewerUse(t, false),
		{ f, result } = state;
	physicalReuse(result, f);
	reviewerUse(
		result.required.find((item) => item.id === "reviewer"),
		"reviewer",
		state,
	);
	reviewerUse(
		result.required.find((item) => item.id === "reviewer-copy"),
		"reviewer-copy",
		state,
	);
	assert.equal(
		result.diagnostics.managed.requiredSkills.files,
		2,
		"extra and one physical reviewer task",
	);
	assert.equal(
		result.diagnostics.managed.requiredSkills.bytes,
		Buffer.byteLength(state.reviewer.entry) +
			Buffer.byteLength(f.packages.get("extra").entry),
	);
	assert.equal(result.diagnostics.managed.requestedSkills.files, 0);
	assert.equal(result.diagnostics.availableNotLoaded.files, 1);
	assert.equal(
		result.diagnostics.availableNotLoaded.bytes,
		Buffer.byteLength(f.note),
	);
});
test("R2 requested second reviewer alias preserves both pins and re-entry without an unloaded claim", (t) => {
	const state = secondReviewerUse(t, true),
		{ f, result } = state;
	physicalReuse(result, f);
	reviewerUse(
		result.required.find((item) => item.id === "reviewer"),
		"reviewer",
		state,
	);
	reviewerUse(
		result.available.find((item) => item.id === "reviewer-copy"),
		"reviewer-copy",
		state,
	);
	assert.deepEqual(result.requestedSkills, ["reviewer-copy"]);
	assert.equal(
		result.diagnostics.availableNotLoaded.files,
		1,
		"only note is unloaded",
	);
	assert.equal(
		result.diagnostics.availableNotLoaded.bytes,
		Buffer.byteLength(f.note),
	);
	assert.equal(result.diagnostics.managed.requiredSkills.files, 2);
	assert.equal(
		result.diagnostics.managed.requestedSkills.files,
		0,
		"already-required backing adds no physical requested task",
	);
	assert.equal(result.diagnostics.managed.requestedSkills.bytes, 0);
	const unloadedProof = formatProof(result)
		.split("Available, not injected")[1]
		.split("Host-native skills")[0];
	assert.doesNotMatch(unloadedProof, /reviewer-copy/);
	assert.match(unloadedProof, /note/);
	const context = formatContext(result, {
		root: f.root,
		storeRoot: f.storeRoot,
	});
	const unloadedContext = context
		.split("## Available skills")[1]
		.split("## Run again")[0];
	assert.doesNotMatch(unloadedContext, /reviewer-copy/);
	assert.match(unloadedContext, /note/);
	assert.match(context.split("## Run again")[1], /--skill 'reviewer-copy'/);
	assert.ok(context.includes(f.storeRoot));
});
test("R2 DOM second requested reviewer alias is checked without repeating required backing", (t) => {
	const state = secondReviewerUse(t, true),
		{ f, result, reviewer } = state;
	physicalReuse(result, f);
	reviewerUse(
		result.required.find((item) => item.id === "reviewer"),
		"reviewer",
		state,
	);
	reviewerUse(
		result.available.find((item) => item.id === "reviewer-copy"),
		"reviewer-copy",
		state,
	);
	assert.deepEqual(result.requestedSkills, ["reviewer-copy"]);
	const view = render(result);
	renderTotals(view, result);
	const checkbox = view.entries.find(
		(node) => node.tag === "input" && node.id === "skill-reviewer-copy",
	);
	assert.ok(checkbox, "distinct configured copy remains discoverable");
	assert.equal(checkbox.checked, true);
	const label = view.entries.find(
		(node) => node.tag === "label" && node.children.includes(checkbox),
	);
	assert.ok(
		label.children.some((node) =>
			node.textContent.includes("reviewer-copy · Requested, injected"),
		),
	);
	assert.equal(bodyCount(view, reviewer.entry), 1);
	assert.equal(bodyCount(view, reviewer.workflow), 1);
	assert.equal(sourceLabel(view, reviewer, "SKILL.md"), true);
	assert.equal(sourceLabel(view, reviewer, "WORKFLOW.md"), true);
	assert.equal(
		view.nodes.get("available-total").textContent,
		`${Buffer.byteLength(f.note).toLocaleString("en-US")} B`,
	);
});
