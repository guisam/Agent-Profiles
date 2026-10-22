import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { migrationProposals, proposeMigration } from "../src/migrations.ts";
import { installDependencies } from "../src/package-lock.ts";
import { createStamp, reconstructStamp } from "../src/stamps.ts";

const cli = fileURLToPath(new URL("../bin/agent-profiles.js", import.meta.url));
const instruction = "local/.agent-profiles/roles/reviewer.md";
const put = (file, bytes) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
};

function snapshot(root, excluded = []) {
	const entries = [];
	function scan(relative = "") {
		for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
			const member = relative ? `${relative}/${name}` : name;
			if (excluded.includes(member)) continue;
			if (fs.lstatSync(path.join(root, member)).isDirectory()) {
				entries.push([member, "directory"]);
				scan(member);
			} else
				entries.push([
					member,
					fs.readFileSync(path.join(root, member)).toString("hex"),
				]);
		}
	}
	scan();
	return entries;
}
function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-proposal-cli-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		ambient = path.join(dir, "empty-ambient-store");
	fs.mkdirSync(ambient);
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { small: { profile: "base" } },
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
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
	put(path.join(root, "AGENTS.md"), "# Repository rules\n");
	installDependencies({ root, storeRoot });
	const input = {
			root,
			storeRoot,
			role: "reviewer",
			model: "small",
			host: "codex",
		},
		base = createStamp(input);
	const active = snapshot(root),
		store = snapshot(storeRoot),
		rebuilt = reconstructStamp({ storeRoot, digest: base.digest });
	return {
		dir,
		root,
		storeRoot,
		ambient,
		input,
		base,
		unchanged() {
			assert.deepEqual(
				snapshot(root, [".agent-profiles/migrations"]),
				active,
				"active config, lock and source bytes",
			);
			assert.deepEqual(
				snapshot(storeRoot),
				store,
				"retained store bytes and membership",
			);
			assert.deepEqual(
				snapshot(ambient),
				[],
				"explicit store must override the empty ambient store",
			);
			assert.deepEqual(
				reconstructStamp({ storeRoot, digest: base.digest }),
				rebuilt,
				"retained base backing",
			);
		},
	};
}
function invoke(
	f,
	args,
	{ json = true, store = true, storeEnv = f.ambient } = {},
) {
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"migrate",
			...args,
			"--root",
			f.root,
			...(store ? ["--store", f.storeRoot] : []),
			...(json ? ["--json"] : []),
		],
		{
			cwd: f.root,
			encoding: "utf8",
			env: {
				...process.env,
				AGENT_PROFILES_STORE: storeEnv,
				TMP: f.dir,
				TEMP: f.dir,
				TMPDIR: f.dir,
			},
		},
	);
	assert.equal(
		result.error,
		undefined,
		"CLI subprocess must execute; a spawn denial is not behavioral RED",
	);
	return result;
}
function jsonResult(result) {
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout);
}
function start(f) {
	const record = jsonResult(
		invoke(f, [
			"start",
			"--role",
			"reviewer",
			"--model",
			"small",
			"--host",
			"codex",
			"--sharing",
			"fork",
		]),
	);
	assert.equal(record.bases[0].stamp, f.base.digest);
	assert.equal(record.state, "open");
	f.unchanged();
	return record;
}
function advisory(
	f,
	migration,
	excerpt = "A review omitted a boundary check.",
) {
	const value = {
		proposalVersion: 1,
		classification: "role",
		target: { path: instruction },
		change: {
			before: fs.readFileSync(
				path.join(f.root, migration.workspace, instruction),
				"utf8",
			),
			after: "# Check boundaries café  \r\n",
		},
		evidence: [
			{
				sessionId: "caller-claimed-cli-session",
				excerpt,
				baseStamp: migration.bases[0].stamp,
			},
		],
	};
	const proposalFile = path.join(f.dir, "proposal.json");
	put(proposalFile, JSON.stringify(value));
	return { value, proposalFile };
}
function seed(f, migration) {
	const offered = advisory(f, migration);
	return {
		...offered,
		entry: proposeMigration({
			root: f.root,
			storeRoot: f.storeRoot,
			id: migration.id,
			proposalFile: offered.proposalFile,
		}),
	};
}
function refusal(f, args, diagnostic, options) {
	const project = snapshot(f.root),
		store = snapshot(f.storeRoot),
		ambient = snapshot(f.ambient);
	const result = invoke(f, args, options);
	assert.notEqual(result.status, 0, args.join(" "));
	assert.equal(result.stdout, "", "refusal must not emit success data");
	assert.match(result.stderr, diagnostic);
	assert.deepEqual(
		snapshot(f.root),
		project,
		"refusal leaves all project bytes and membership unchanged",
	);
	assert.deepEqual(
		snapshot(f.storeRoot),
		store,
		"refusal leaves retained store unchanged",
	);
	assert.deepEqual(
		snapshot(f.ambient),
		ambient,
		"refusal leaves ambient store unchanged",
	);
	f.unchanged();
}

test("CLI proposal fixture starts a real local migration with an explicit retained base store", (t) => {
	const f = fixture(t),
		migration = start(f);
	assert.deepEqual(jsonResult(invoke(f, ["status", migration.id])), {
		...migration,
		dirty: true,
		workspaceChanged: false,
		changes: [],
	});
	assert.equal(
		fs.readFileSync(
			path.join(f.root, migration.workspace, instruction),
			"utf8",
		),
		"# Review café\r\n",
	);
	f.unchanged();
});

test("CLI JSON proposal import lists advisory data and explicit acceptance changes only the workspace instruction", (t) => {
	const f = fixture(t),
		migration = start(f),
		{ value, proposalFile } = advisory(f, migration);
	const workspace = path.join(f.root, migration.workspace),
		before = snapshot(workspace);
	const entry = jsonResult(invoke(f, ["propose", migration.id, proposalFile]));
	assert.deepEqual(entry, {
		id: entry.id,
		proposal: value,
		status: "proposed",
		reason: null,
	});
	assert.equal(typeof entry.id, "string");
	assert.ok(entry.id.trim());
	assert.deepEqual(snapshot(workspace), before, "import is advisory");
	fs.unlinkSync(proposalFile);
	const project = snapshot(f.root);
	assert.deepEqual(
		jsonResult(invoke(f, ["proposals", migration.id], { store: false })),
		[entry],
	);
	assert.deepEqual(
		snapshot(f.root),
		project,
		"listing is read-only and does not need the original import file",
	);
	const other = snapshot(workspace, [instruction]);
	const accepted = jsonResult(invoke(f, ["accept", migration.id, entry.id]));
	assert.deepEqual(accepted, { ...entry, status: "accepted" });
	assert.deepEqual(
		fs.readFileSync(path.join(workspace, instruction)),
		Buffer.from(value.change.after),
	);
	assert.deepEqual(snapshot(workspace, [instruction]), other);
	assert.deepEqual(
		jsonResult(invoke(f, ["proposals", migration.id], { store: false })),
		[accepted],
	);
	assert.equal(jsonResult(invoke(f, ["status", migration.id])).state, "open");
	f.unchanged();
});

test("CLI reject retains the proposal and reason without applying workspace changes", (t) => {
	const f = fixture(t),
		migration = start(f),
		{ entry } = seed(f, migration);
	const workspace = path.join(f.root, migration.workspace),
		before = snapshot(workspace);
	const rejected = jsonResult(
		invoke(f, [
			"reject",
			migration.id,
			entry.id,
			"--reason",
			"Keep this rule narrower",
		]),
	);
	assert.deepEqual(rejected, {
		...entry,
		status: "rejected",
		reason: "Keep this rule narrower",
	});
	assert.deepEqual(
		jsonResult(invoke(f, ["proposals", migration.id], { store: false })),
		[rejected],
	);
	assert.deepEqual(snapshot(workspace), before);
	f.unchanged();
});

test("CLI proposal commands provide useful text output and honor an omitted store flag via the selected environment", (t) => {
	const f = fixture(t),
		migration = start(f),
		{ entry } = seed(f, migration);
	const textOptions = { json: false, store: false, storeEnv: f.storeRoot };
	const before = snapshot(path.join(f.root, migration.workspace));
	const accepted = invoke(f, ["accept", migration.id, entry.id], textOptions);
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.equal(accepted.stderr, "");
	assert.match(accepted.stdout, /accept/i);
	assert.ok(accepted.stdout.includes(entry.id));
	assert.equal(
		migrationProposals({ root: f.root, id: migration.id })[0].status,
		"accepted",
	);
	assert.notDeepEqual(snapshot(path.join(f.root, migration.workspace)), before);
	const project = snapshot(f.root);
	const shown = invoke(f, ["proposals", migration.id], textOptions);
	assert.equal(shown.status, 0, shown.stderr);
	assert.equal(shown.stderr, "");
	assert.match(shown.stdout, /proposal/i);
	assert.ok(shown.stdout.includes(entry.id));
	assert.deepEqual(snapshot(f.root), project, "text listing is also read-only");
	const { value, proposalFile } = advisory(
		f,
		migration,
		"A separate claim for review.",
	);
	const unchanged = snapshot(path.join(f.root, migration.workspace));
	const offered = invoke(
		f,
		["propose", migration.id, proposalFile],
		textOptions,
	);
	assert.equal(offered.status, 0, offered.stderr);
	assert.equal(offered.stderr, "");
	assert.match(offered.stdout, /propos/i);
	const pending = migrationProposals({ root: f.root, id: migration.id }).find(
		(item) => item.status === "proposed",
	);
	assert.ok(pending);
	assert.deepEqual(pending.proposal, value);
	assert.ok(offered.stdout.includes(pending.id));
	assert.deepEqual(snapshot(path.join(f.root, migration.workspace)), unchanged);
	const rejected = invoke(
		f,
		["reject", migration.id, pending.id, "--reason", "Needs more evidence"],
		textOptions,
	);
	assert.equal(rejected.status, 0, rejected.stderr);
	assert.equal(rejected.stderr, "");
	assert.match(rejected.stdout, /reject/i);
	assert.ok(rejected.stdout.includes("Needs more evidence"));
	assert.deepEqual(snapshot(path.join(f.root, migration.workspace)), unchanged);
	assert.deepEqual(
		migrationProposals({ root: f.root, id: migration.id }).find(
			(item) => item.id === pending.id,
		),
		{ ...pending, status: "rejected", reason: "Needs more evidence" },
	);
	f.unchanged();
});

test("CLI proposal admission rejects bad operands options IDs and reasons without writes", (t) => {
	const f = fixture(t),
		migration = start(f),
		{ entry, proposalFile } = seed(f, migration),
		id = migration.id;
	assert.deepEqual(jsonResult(invoke(f, ["proposals", id], { store: false })), [
		entry,
	]);
	const usage = /usage|operand|argument|requires|expected/i;
	const cases = [
		[["propose", id], usage],
		[["propose", id, proposalFile, "extra"], usage],
		[["proposals"], usage],
		[["proposals", id, "extra"], usage],
		[["accept", id], usage],
		[["accept", id, entry.id, "extra"], usage],
		[["reject", id, "--reason", "No"], usage],
		[["reject", id, entry.id, "extra", "--reason", "No"], usage],
		[
			["propose", id, proposalFile, "--role", "reviewer"],
			/role.*not supported|role.*only supported/i,
		],
		[
			["accept", id, entry.id, "--sharing", "fork"],
			/sharing.*not supported|sharing.*only supported/i,
		],
		[
			["proposals", id, "--reason", "No"],
			/reason.*not supported|reason.*only supported/i,
		],
		[
			["proposals", id, "--store", f.storeRoot],
			/store.*not supported|store.*only supported/i,
		],
		[["propose", id, proposalFile, "--root", f.root], /root.*repeat/i],
		[
			["accept", id, entry.id, "--store", f.storeRoot, "--store", f.storeRoot],
			/store.*repeat/i,
		],
		[["proposals", id, "--json"], /json.*repeat/i],
		[
			["reject", id, entry.id, "--reason", "No", "--reason", "Again"],
			/reason.*repeat/i,
		],
		[["publish", id], /usage|not implemented|unsupported/i],
		[["propose", "../outside", proposalFile], /migration id/i],
		[["proposals", "../outside"], /migration id/i],
		[["accept", id, "../proposal"], /proposal id/i],
		[["reject", id, "../proposal", "--reason", "No"], /proposal id/i],
		[["reject", id, entry.id], /reason/i],
		[["reject", id, entry.id, "--reason", " "], /reason/i],
	];
	for (const [args, diagnostic] of cases)
		refusal(f, args, diagnostic, { store: false });
	assert.deepEqual(migrationProposals({ root: f.root, id }), [entry]);
});

test("CLI propose diagnoses malformed JSON and preserves the project and retained base", (t) => {
	const f = fixture(t),
		migration = start(f),
		proposalFile = path.join(f.dir, "broken.json");
	put(proposalFile, "{");
	refusal(f, ["propose", migration.id, proposalFile], /JSON|json|record/);
	assert.deepEqual(migrationProposals({ root: f.root, id: migration.id }), []);
});
