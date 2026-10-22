import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import * as migrations from "../src/migrations.js";
import { installDependencies } from "../src/package-lock.js";
import { importPackage, readStoreFile } from "../src/package-store.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { createStamp, reconstructStamp } from "../src/stamps.js";

const exports = [
	"proposeMigration",
	"acceptMigrationProposal",
	"rejectMigrationProposal",
	"migrationProposals",
];
const missing = exports.filter(
	(name) => typeof migrations[name] !== "function",
);
const proposalTest = (name, body) =>
	test(
		name,
		{
			skip: missing.length
				? `missing proposal API: ${missing.join(", ")}; behavioral body not executed`
				: false,
		},
		body,
	);
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};
const clone = (value) => structuredClone(value);
const rolePath = "local/.agent-profiles/roles/reviewer.md";
const profilePath = "local/.agent-profiles/profiles/base.md";

function tree(root, excluded = []) {
	const result = [];
	function scan(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name;
			if (excluded.includes(member)) continue;
			const absolute = path.join(root, member),
				stat = fs.lstatSync(absolute);
			if (stat.isSymbolicLink())
				result.push([member, "link", fs.readlinkSync(absolute)]);
			else if (stat.isDirectory()) {
				result.push([member, "directory"]);
				scan(member);
			} else result.push([member, fs.readFileSync(absolute).toString("hex")]);
		}
	}
	scan();
	return result;
}

function fixture(t, sharing = "fork") {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-proposals-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		source = path.join(dir, "package");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { small: { profile: "base" }, large: { profile: "base" } },
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: ["review"], available: ["extra"] },
				},
				writer: {
					file: "roles/writer.md",
					skills: { required: [], available: [] },
				},
			},
			skills: {
				review: { package: "@example/review", version: "1.0.0" },
				extra: { file: "instructions/extra.md" },
			},
		}),
	);
	put(
		path.join(root, ".agent-profiles/profiles/base.md"),
		"\uFEFF# Profile\r\n",
	);
	put(
		path.join(root, ".agent-profiles/roles/reviewer.md"),
		"# Review café\r\n",
	);
	put(path.join(root, ".agent-profiles/roles/writer.md"), "# Writer\n");
	put(
		path.join(root, "instructions/extra.md"),
		"---\ndescription: Extra\n---\nExtra\n",
	);
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: "@example/review", version: "1.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(source, "SKILL.md"),
		"---\r\ndescription: Review\r\n---\r\nReview\r\n",
	);
	put(path.join(source, "support.bin"), Buffer.from([0, 255, 13, 10]));
	const pkg = importPackage({ sourceDirectory: source, storeRoot });
	installDependencies({ root, storeRoot });
	const input = {
		root,
		storeRoot,
		role: "reviewer",
		model: "small",
		host: "codex",
	};
	const active = tree(root),
		sources = tree(source),
		resolved = resolveInstructions(input);
	const migration = migrations.startMigration({ ...input, sharing });
	const store = tree(storeRoot),
		base = reconstructStamp({ storeRoot, digest: migration.bases[0].stamp });
	const workspace = path.join(root, migration.workspace);
	const f = {
		dir,
		root,
		storeRoot,
		source,
		pkg,
		input,
		migration,
		workspace,
		args: { root, storeRoot, id: migration.id },
		listArgs: { root, id: migration.id },
	};
	f.unchanged = () => {
		assert.deepEqual(
			tree(root, [".agent-profiles/migrations"]),
			active,
			"active project inputs",
		);
		assert.deepEqual(tree(source), sources, "package source");
		assert.deepEqual(
			tree(storeRoot),
			store,
			"immutable store bytes and membership",
		);
		assert.deepEqual(
			resolveInstructions(input),
			resolved,
			"active assignment resolution",
		);
		assert.deepEqual(
			reconstructStamp({ storeRoot, digest: migration.bases[0].stamp }),
			base,
			"retained base",
		);
	};
	return f;
}

function proposal(f, classification = "role", targetPath = rolePath) {
	return {
		proposalVersion: 1,
		classification,
		target: { path: targetPath },
		change: {
			before: fs.readFileSync(path.join(f.workspace, targetPath), "utf8"),
			after: "# Proposed café  \r\n\r\n",
		},
		evidence: [
			{
				sessionId: "caller-claimed-session-21",
				excerpt: "The review missed a boundary check.",
				baseStamp: f.migration.bases[0].stamp,
			},
		],
	};
}
function offer(f, value, raw = false) {
	const proposalFile = path.join(f.dir, "advisory.json");
	put(proposalFile, raw ? value : JSON.stringify(value));
	return migrations.proposeMigration({ ...f.args, proposalFile });
}
const list = (f) => migrations.migrationProposals(f.listArgs);
const accept = (f, p) =>
	migrations.acceptMigrationProposal({ ...f.args, proposalId: p.id });
const reject = (f, p, reason) =>
	migrations.rejectMigrationProposal({ ...f.args, proposalId: p.id, reason });
function retained(f, p, value, status, reason = null) {
	assert.deepEqual(p, { id: p.id, proposal: value, status, reason });
	assert.equal(typeof p.id, "string");
	assert.ok(p.id.trim());
	assert.deepEqual(
		list(f).find((item) => item.id === p.id),
		p,
	);
}
function refuses(f, operation, diagnostic) {
	const project = tree(f.root),
		store = tree(f.storeRoot);
	assert.throws(operation, diagnostic);
	assert.deepEqual(tree(f.root), project, "refusal leaves project unchanged");
	assert.deepEqual(tree(f.storeRoot), store, "refusal leaves store unchanged");
	f.unchanged();
}

test("proposal import/accept/reject/list public API exists", () => {
	assert.deepEqual(
		missing,
		[],
		"implement the four proposal exports in src/migrations.js",
	);
});

test("proposal fixture has selected raw UTF-8 instructions, a locked package and retained bases", (t) => {
	const f = fixture(t),
		value = proposal(f),
		base = reconstructStamp({
			storeRoot: f.storeRoot,
			digest: f.migration.bases[0].stamp,
		});
	assert.equal(value.change.before, "# Review café\r\n");
	assert.equal(
		base.composition.find((e) => e.kind === "role").backing.path,
		".agent-profiles/roles/reviewer.md",
	);
	assert.equal(base.packages[0].sha256, f.pkg.sha256);
	assert.deepEqual(
		fs.readFileSync(
			path.join(f.workspace, `packages/${f.pkg.sha256}/support.bin`),
		),
		Buffer.from([0, 255, 13, 10]),
	);
	assert.equal(createStamp(f.input).digest, value.evidence[0].baseStamp);
	f.unchanged();
});

test("preservation oracle excludes only migration records and detects active edits", (t) => {
	const f = fixture(t),
		snapshot = tree(f.root, [".agent-profiles/migrations"]);
	put(path.join(f.workspace, rolePath), "# Workspace only\n");
	assert.deepEqual(tree(f.root, [".agent-profiles/migrations"]), snapshot);
	put(path.join(f.root, "AGENTS.md"), "# Changed active input\n");
	assert.notDeepEqual(tree(f.root, [".agent-profiles/migrations"]), snapshot);
});

test("existing safe reader rejects owned hard links and junctions", (t) => {
	const f = fixture(t),
		outside = path.join(f.dir, "outside");
	fs.mkdirSync(outside);
	put(path.join(outside, "instruction.md"), "# Outside\n");
	fs.linkSync(
		path.join(outside, "instruction.md"),
		path.join(f.workspace, "hard.md"),
	);
	assert.throws(
		() => readStoreFile(f.workspace, "hard.md"),
		/unsafe store member/,
	);
	fs.symlinkSync(
		outside,
		path.join(f.workspace, "escape"),
		process.platform === "win32" ? "junction" : "dir",
	);
	assert.throws(
		() => readStoreFile(f.workspace, "escape/instruction.md"),
		/link|junction/,
	);
	assert.equal(
		fs.readFileSync(path.join(outside, "instruction.md"), "utf8"),
		"# Outside\n",
	);
});

proposalTest(
	"import retains advisory data without applying it and listing is read-only",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			workspace = tree(f.workspace),
			p = offer(f, value);
		retained(f, p, value, "proposed");
		assert.deepEqual(tree(f.workspace), workspace);
		const snapshot = tree(f.root);
		assert.deepEqual(list(f), [p]);
		assert.deepEqual(tree(f.root), snapshot);
		fs.unlinkSync(path.join(f.dir, "advisory.json"));
		assert.deepEqual(
			list(f),
			[p],
			"import retains the proposal rather than a file reference",
		);
		f.unchanged();
	},
);

proposalTest(
	"explicit acceptance changes exactly one workspace file and retains original evidence",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value),
			other = tree(f.workspace, [rolePath]);
		const result = accept(f, p);
		retained(f, result, value, "accepted");
		assert.equal(result.id, p.id);
		assert.deepEqual(
			fs.readFileSync(path.join(f.workspace, rolePath)),
			Buffer.from(value.change.after, "utf8"),
		);
		assert.deepEqual(tree(f.workspace, [rolePath]), other);
		assert.equal(migrations.migrationStatus(f.listArgs).state, "open");
		f.unchanged();
	},
);

proposalTest(
	"duplicate imports and repeated acceptance cannot reapply a proposal",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value);
		refuses(f, () => offer(f, value), /duplicate|already/);
		accept(f, p);
		refuses(f, () => accept(f, p), /accepted|already|status/);
		refuses(f, () => offer(f, value), /duplicate|already/);
		assert.equal(list(f).length, 1);
	},
);

proposalTest(
	"acceptance refuses stale before bytes and preserves the user edit",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value);
		put(
			path.join(f.workspace, rolePath),
			value.change.before.replace(/\r\n/g, "\n"),
		);
		refuses(f, () => accept(f, p), /stale|before/);
		retained(f, list(f)[0], value, "proposed");
	},
);

proposalTest(
	"rejection requires a reason and retains history; new evidence permits a new proposal",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value),
			workspace = tree(f.workspace);
		for (const reason of [undefined, null, "", " ", 42])
			refuses(f, () => reject(f, p, reason), /reason/);
		retained(
			f,
			reject(f, p, "Use a narrower rule"),
			value,
			"rejected",
			"Use a narrower rule",
		);
		assert.deepEqual(tree(f.workspace), workspace);
		refuses(f, () => accept(f, p), /rejected|status/);
		refuses(f, () => reject(f, p, "Again"), /rejected|already|status/);
		refuses(f, () => offer(f, value), /rejected|duplicate|evidence|already/);
		const again = clone(value);
		again.evidence.push({
			...again.evidence[0],
			sessionId: "new-session",
			excerpt: "A second boundary failure.",
		});
		const next = offer(f, again);
		assert.notEqual(next.id, p.id);
		assert.deepEqual(
			list(f).find((item) => item.id === p.id),
			{ ...p, status: "rejected", reason: "Use a narrower rule" },
		);
		retained(f, next, again, "proposed");
		f.unchanged();
	},
);

proposalTest(
	"strict versioned JSON and nested record shapes refuse before writes",
	(t) => {
		const f = fixture(t),
			good = proposal(f);
		for (const raw of ["{", "null", "[]", "1", '"text"'])
			refuses(f, () => offer(f, raw, true), /JSON|json|proposal|object|record/);
		const bad = [
			{ ...good, proposalVersion: 2 },
			{ ...good, surprise: true },
			{ ...good, classification: "automatic" },
			{ ...good, target: null },
			{ ...good, target: { ...good.target, extra: true } },
			{ ...good, change: [] },
			{ ...good, change: { before: good.change.before } },
			{ ...good, change: { before: 42, after: "text" } },
			{ ...good, change: { ...good.change, patch: "diff" } },
			{ ...good, change: { before: good.change.before, after: "\0binary" } },
			{ ...good, change: { before: good.change.before, after: "\uD800" } },
			{ ...good, evidence: null },
			{ ...good, evidence: {} },
			{ ...good, evidence: [] },
		];
		for (const field of [
			"proposalVersion",
			"classification",
			"target",
			"change",
			"evidence",
		]) {
			const value = clone(good);
			delete value[field];
			bad.push(value);
		}
		for (const value of bad)
			refuses(
				f,
				() => offer(f, value),
				/proposal|version|field|classification|target|change|before|after|evidence|text|surrogate|Unicode|NUL/i,
			);
	},
);

proposalTest(
	"evidence requires nonempty caller claims and a stamp on every entry",
	(t) => {
		const f = fixture(t),
			good = proposal(f);
		for (const field of ["sessionId", "excerpt", "baseStamp"])
			for (const invalid of [undefined, null, "", " ", 7]) {
				const value = clone(good);
				value.evidence[0][field] = invalid;
				refuses(
					f,
					() => offer(f, value),
					/evidence|session|excerpt|stamp|base/i,
				);
			}
		for (const entry of [
			null,
			[],
			{ ...good.evidence[0], authenticatedHost: "codex" },
		]) {
			const value = clone(good);
			value.evidence.push(entry);
			refuses(f, () => offer(f, value), /evidence|field|object/i);
		}
	},
);

proposalTest(
	"valid but foreign assignment and nonretained same-assignment stamps refuse",
	(t) => {
		const f = fixture(t),
			good = proposal(f);
		const foreign = createStamp({ ...f.input, role: "writer" });
		put(
			path.join(f.root, ".agent-profiles/roles/reviewer.md"),
			"# Later active role\n",
		);
		const later = createStamp(f.input);
		put(
			path.join(f.root, ".agent-profiles/roles/reviewer.md"),
			good.change.before,
		);
		// These legitimate captures extend the store before the zero-write refusal snapshots.
		for (const digest of [foreign.digest, later.digest, "f".repeat(64)]) {
			const value = clone(good);
			value.evidence[0].baseStamp = digest;
			const project = tree(f.root),
				store = tree(f.storeRoot);
			assert.throws(() => offer(f, value), /base|stamp|evidence|assignment/i);
			assert.deepEqual(tree(f.root), project);
			assert.deepEqual(tree(f.storeRoot), store);
		}
		assert.deepEqual(list(f), []);
		assert.ok(
			reconstructStamp({
				storeRoot: f.storeRoot,
				digest: good.evidence[0].baseStamp,
			}),
		);
	},
);

for (const [classification, target] of [
	["role", rolePath],
	["package", "package"],
	["model-specific", profilePath],
	["model-specific", "package"],
]) {
	proposalTest(
		`${classification} acceptance permits its selected instruction under fork intent (${target})`,
		(t) => {
			const f = fixture(t),
				targetPath =
					target === "package" ? `packages/${f.pkg.sha256}/SKILL.md` : target;
			const value = proposal(f, classification, targetPath),
				other = tree(f.workspace, [targetPath]);
			const p = offer(f, value);
			retained(f, accept(f, p), value, "accepted");
			assert.equal(
				fs.readFileSync(path.join(f.workspace, targetPath), "utf8"),
				value.change.after,
			);
			assert.deepEqual(tree(f.workspace, [targetPath]), other);
			f.unchanged();
		},
	);
}

proposalTest(
	"classification refuses unrelated instructions, resources and package metadata",
	(t) => {
		const f = fixture(t);
		const cases = [
			["role", profilePath],
			["role", `packages/${f.pkg.sha256}/SKILL.md`],
			["role", "local/instructions/extra.md"],
			["package", rolePath],
			["package", `packages/${f.pkg.sha256}/package.yaml`],
			["package", `packages/${f.pkg.sha256}/support.bin`],
			["model-specific", rolePath],
			["model-specific", "local/instructions/extra.md"],
		];
		put(
			path.join(f.workspace, "local/.agent-profiles/roles/writer.md"),
			"# Unselected role\n",
		);
		cases.push(["role", "local/.agent-profiles/roles/writer.md"]);
		for (const [classification, target] of cases) {
			const value = proposal(f, classification, target);
			if (target === `packages/${f.pkg.sha256}/support.bin`)
				value.change.before = "# Valid instruction text\n";
			refuses(
				f,
				() => offer(f, value),
				/target|instruction|classification|selected|metadata|package/i,
			);
		}
	},
);

proposalTest(
	"model-specific package edits refuse shared intent while ordinary package edits remain possible",
	(t) => {
		const f = fixture(t, "shared"),
			target = `packages/${f.pkg.sha256}/SKILL.md`;
		assert.ok(f.migration.collateral.length > 0);
		refuses(
			f,
			() => offer(f, proposal(f, "model-specific", target)),
			/model-specific|shared|fork/,
		);
		const value = proposal(f, "package", target),
			p = offer(f, value);
		retained(f, accept(f, p), value, "accepted");
		f.unchanged();
	},
);

proposalTest(
	"repo proposals remain recommendations and cannot apply even to an editable instruction",
	(t) => {
		const f = fixture(t),
			value = proposal(f, "repo"),
			workspace = tree(f.workspace),
			p = offer(f, value);
		retained(f, p, value, "proposed");
		refuses(f, () => accept(f, p), /repo|recommendation/);
		assert.deepEqual(tree(f.workspace), workspace);
		retained(
			f,
			reject(f, p, "Track separately"),
			value,
			"rejected",
			"Track separately",
		);
		f.unchanged();
	},
);

proposalTest(
	"targets refuse traversal, absolute paths, root rules, migration records and missing files",
	(t) => {
		const f = fixture(t),
			good = proposal(f);
		for (const target of [
			"../record.json",
			"../../agents.yaml",
			"/absolute.md",
			"C:/outside.md",
			"..\\outside.md",
			"local/../record.json",
			"record.json",
			"AGENTS.md",
			"local/AGENTS.md",
			"local/.agent-profiles/agents.yaml",
			"local/.agent-profiles/agent-profiles.lock",
			"local/new.md",
			`packages/${"e".repeat(64)}/SKILL.md`,
		]) {
			const value = clone(good);
			value.target.path = target;
			refuses(
				f,
				() => offer(f, value),
				/path|target|member|instruction|selected|exist|portable|record|outside|relative/i,
			);
		}
	},
);

proposalTest(
	"acceptance rechecks hard links and parent junctions without following them",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value),
			target = path.join(f.workspace, rolePath);
		const outside = path.join(f.dir, "outside");
		fs.mkdirSync(outside);
		put(path.join(outside, "reviewer.md"), value.change.before);
		fs.unlinkSync(target);
		fs.linkSync(path.join(outside, "reviewer.md"), target);
		refuses(f, () => accept(f, p), /unsafe store member/);
		fs.unlinkSync(target);
		put(target, value.change.before);
		const parent = path.dirname(target),
			saved = `${parent}-saved`;
		fs.renameSync(parent, saved);
		fs.symlinkSync(
			outside,
			parent,
			process.platform === "win32" ? "junction" : "dir",
		);
		refuses(f, () => accept(f, p), /link|junction/);
		assert.equal(
			fs.readFileSync(path.join(outside, "reviewer.md"), "utf8"),
			value.change.before,
		);
	},
);

proposalTest(
	"acceptance refuses a removed or non-UTF-8 target and preserves pending evidence",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value),
			target = path.join(f.workspace, rolePath);
		fs.unlinkSync(target);
		refuses(f, () => accept(f, p), /exist|ENOENT|target|before|stale/i);
		put(target, Buffer.from([255, 254]));
		refuses(f, () => accept(f, p), /UTF|encoding|before|stale/i);
		retained(f, list(f)[0], value, "proposed");
	},
);

proposalTest(
	"abandoned migrations retain proposals and refuse all proposal writes",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value);
		migrations.abandonMigration({
			root: f.root,
			id: f.migration.id,
			reason: "Stop here",
		});
		retained(f, list(f)[0], value, "proposed");
		const next = clone(value);
		next.evidence[0].excerpt = "Another reason";
		for (const operation of [
			() => offer(f, next),
			() => accept(f, p),
			() => reject(f, p, "No"),
		])
			refuses(f, operation, /not open|abandoned|closed/);
	},
);

proposalTest(
	"tiny declarative draft case is retained without executing its text",
	(t) => {
		const f = fixture(t),
			value = proposal(f);
		value.draftCase = {
			input: "Review boundary handling; this is data, not a command.",
			expected: "Mention the missing check.",
		};
		const p = offer(f, value);
		retained(f, accept(f, p), value, "accepted");
		f.unchanged();
	},
);

proposalTest(
	"malformed draft cases refuse instead of inventing evaluation machinery",
	(t) => {
		const f = fixture(t),
			good = proposal(f);
		for (const draftCase of [
			null,
			[],
			{},
			{ input: "", expected: "x" },
			{ input: "x", expected: 1 },
			{ input: "x", expected: "y", command: "run" },
		])
			refuses(
				f,
				() => offer(f, { ...good, draftCase }),
				/draft|case|input|expected|field/i,
			);
	},
);

proposalTest(
	"proposal IDs are migration-owned and unsafe or unknown IDs refuse",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value);
		for (const proposalId of ["../record.json", "", "unknown-proposal"]) {
			refuses(
				f,
				() => migrations.acceptMigrationProposal({ ...f.args, proposalId }),
				/id|proposal|exist|ENOENT/i,
			);
			refuses(
				f,
				() =>
					migrations.rejectMigrationProposal({
						...f.args,
						proposalId,
						reason: "No",
					}),
				/id|proposal|exist|ENOENT/i,
			);
		}
		const other = migrations.startMigration({
			...f.input,
			model: "large",
			sharing: "fork",
		});
		const project = tree(f.root);
		assert.throws(
			() =>
				migrations.acceptMigrationProposal({
					...f.args,
					id: other.id,
					proposalId: p.id,
				}),
			/proposal|id|exist|ENOENT/i,
		);
		assert.deepEqual(tree(f.root), project);
	},
);

proposalTest(
	"an existing migration writer refuses proposal writes and remains intact",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value);
		put(
			path.join(f.root, ".agent-profiles/.migration-writer/owner.txt"),
			"another operation",
		);
		const project = tree(f.root),
			store = tree(f.storeRoot);
		const next = clone(value);
		next.evidence[0].excerpt = "New evidence";
		for (const operation of [
			() => offer(f, next),
			() => accept(f, p),
			() => reject(f, p, "No"),
		]) {
			assert.throws(operation, /migration-busy/);
			assert.deepEqual(tree(f.root), project);
			assert.deepEqual(tree(f.storeRoot), store);
		}
	},
);

proposalTest(
	"caught target publication failure leaves pending proposal and workspace consistent",
	(t) => {
		const f = fixture(t),
			value = proposal(f),
			p = offer(f, value),
			project = tree(f.root);
		const target = path.join(f.workspace, rolePath),
			original = fs.renameSync;
		let attempted = false;
		fs.renameSync = (from, to) => {
			if (path.resolve(String(to)) === target) {
				attempted = true;
				throw Object.assign(
					new Error("injected proposal target rename failure"),
					{ code: "EIO" },
				);
			}
			return original(from, to);
		};
		syncBuiltinESMExports();
		try {
			assert.throws(
				() => accept(f, p),
				/injected proposal target rename failure/,
			);
		} finally {
			fs.renameSync = original;
			syncBuiltinESMExports();
		}
		assert.equal(attempted, true, "exercise staged instruction publication");
		assert.deepEqual(
			tree(f.root),
			project,
			"no accepted record, partial target or writer remains",
		);
		retained(f, list(f)[0], value, "proposed");
		f.unchanged();
	},
);
