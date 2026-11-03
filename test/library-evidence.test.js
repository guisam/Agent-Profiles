import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
	formatLibraryEvidence,
	formatLibraryInfo,
	libraryEvidence,
	libraryInfo,
	listLibrary,
} from "../src/library.ts";
import * as migrations from "../src/migrations.ts";
import {
	decision,
	fixture,
	put,
	release,
	scope,
	versions,
	writeDecision,
} from "./helpers/promotion-fixture.js";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const NAME = release.name;

const promote = (f, changes = {}) => {
	writeDecision(f, decision(f, changes));
	return migrations.applyMigrationPromotion({
		root: f.root,
		storeRoot: f.storeRoot,
		decisionFile: f.decisionFile,
	});
};

// A second project sharing the store: no migration records of its own, and a
// family prefix covering the evaluated model, so the family column is exercised.
function elsewhere(f) {
	const root = path.join(f.dir, "other-project");
	put(path.join(root, ".agent-profiles/roles/worker.md"), "# Worker\n");
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "worker",
			models: {},
			families: {
				local: { profile: "base", match: { prefixes: ["local-"] } },
			},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				worker: {
					file: "roles/worker.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	return root;
}

function tree(directory) {
	const out = {};
	if (!fs.existsSync(directory)) return out;
	const walk = (current) => {
		for (const name of fs.readdirSync(current).sort()) {
			const file = path.join(current, name);
			if (fs.lstatSync(file).isDirectory()) walk(file);
			else
				out[path.relative(directory, file)] = createHash("sha256")
					.update(fs.readFileSync(file))
					.digest("hex");
		}
	};
	walk(directory);
	return out;
}

test("an eligible result without a promotion is evidence for the candidate's planned label", (t) => {
	const f = fixture(t);
	const { rows, problems } = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
		root: f.root,
	});
	assert.deepEqual(problems, []);
	assert.equal(rows.length, 1);
	const [row] = rows;
	assert.equal(row.version, release.version);
	assert.equal(row.inLibrary, false);
	assert.deepEqual(row.assignment, scope);
	assert.equal(row.outcome, "eligible, not promoted");
	assert.equal(row.origin, "evaluated here");
	// Four cases × two trials; the base side fails "fix" in both trials.
	assert.deepEqual(row.correctness, {
		base: { passed: 6, trials: 8 },
		candidate: { passed: 8, trials: 8 },
	});
	assert.deepEqual(row.regressions, []);
	assert.deepEqual(row.deltas, {
		costUsd: -8,
		tokens: -160,
		turns: -8,
		toolCalls: -8,
		latencyMs: -16,
	});
	assert.deepEqual(row.conditions, {
		harness: { id: "fictional-harness", version: "offline-1" },
		judge: { id: "fictional-judge", version: "claim-1" },
		rubric: { id: "literal-checks", version: "1" },
	});
	assert.equal(row.resultId, f.results.id);
	assert.equal(row.resultDigest, f.imported.resultDigest);
	assert.equal(row.decisionId, null);
	assert.equal(row.migrationId, f.migration.id);
	assert.deepEqual(row.labels, {
		correctness: "external-claim",
		runtime: "unverified",
	});
	assert.match(
		formatLibraryEvidence(
			libraryEvidence({ storeRoot: f.storeRoot, name: NAME, root: f.root }),
		),
		/3\.0\.0 {2}\(not in the library: unpublished candidate label\)[\s\S]*worker × local-llm × claude: eligible, not promoted; evaluated here/,
	);
});

test("a promoted release joins the library with its evidence attached", (t) => {
	const f = fixture(t);
	promote(f);
	const listed = listLibrary({ storeRoot: f.storeRoot }).packages.find(
		(item) => item.name === NAME,
	);
	assert.deepEqual(listed.versions, [
		release.version,
		...[...versions].reverse(),
	]);
	const info = libraryInfo({
		storeRoot: f.storeRoot,
		name: NAME,
		version: release.version,
		root: f.root,
	});
	const [version] = info.versions;
	assert.equal(version.source, "promoted");
	assert.ok(!("error" in version), JSON.stringify(version));
	assert.equal(info.evidence.length, 1);
	const [row] = info.evidence;
	assert.equal(row.outcome, "promoted");
	assert.equal(row.inLibrary, true);
	assert.equal(row.decisionId, "promote-reviewer");
	assert.match(row.decisionDigest, /^[0-9a-f]{64}$/);
	assert.match(
		formatLibraryInfo(info),
		/3\.0\.0 {2}sha256 [0-9a-f]{64} {2}\(promoted release\)[\s\S]*Evidence:\n {4}worker × local-llm × claude: promoted; evaluated here/,
	);
	// Versions without evidence say so rather than staying silent.
	assert.match(
		formatLibraryInfo(
			libraryInfo({ storeRoot: f.storeRoot, name: NAME, version: versions[0] }),
		),
		/Evidence: none retained/,
	);
});

test("a blocked result names its regressions; an override names the waived cases", (t) => {
	const f = fixture(t, { blocked: true });
	const [blocked] = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
	}).rows;
	assert.equal(blocked.outcome, "blocked");
	assert.deepEqual(blocked.regressions, [
		{ caseId: "retain", basePassed: 2, candidatePassed: 1 },
	]);
	assert.deepEqual(blocked.overriddenCases, []);
	promote(f);
	const [overridden] = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
	}).rows;
	assert.equal(overridden.outcome, "promoted with override");
	assert.deepEqual(overridden.overriddenCases, ["retain"]);
	assert.match(
		formatLibraryEvidence(
			libraryEvidence({ storeRoot: f.storeRoot, name: NAME }),
		),
		/Regressions: retain 2→1; overridden: retain/,
	);
});

test("origin: evaluated here, approved elsewhere, evaluated elsewhere; family is a column", (t) => {
	const f = fixture(t);
	const other = elsewhere(f);
	const origin = (root) =>
		libraryEvidence({ storeRoot: f.storeRoot, name: NAME, root }).rows[0];
	assert.equal(origin(f.root).origin, "evaluated here");
	assert.equal(origin(other).origin, "evaluated elsewhere");
	assert.equal(origin(undefined).origin, "evaluated elsewhere");
	promote(f);
	assert.equal(origin(f.root).origin, "evaluated here");
	assert.equal(origin(other).origin, "approved elsewhere");
	// The evaluating project configures local-llm exactly (no family); the other
	// reaches it through its local- prefix. The row's model stays the exact ID.
	assert.equal(origin(f.root).family, null);
	const viaFamily = origin(other);
	assert.equal(viaFamily.family, "local");
	assert.equal(viaFamily.assignment.model, scope.model);
	assert.equal(origin(undefined).family, null);
});

test("filters match exact model, role and host; untested versions are listed", (t) => {
	const f = fixture(t);
	promote(f);
	const evaluated = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
		filter: { model: scope.model, role: scope.role, host: scope.host },
	});
	assert.equal(evaluated.rows.length, 1);
	assert.deepEqual(evaluated.untested, [...versions].reverse());

	// Another model, even one the project routes to the same versions, has no evidence.
	const other = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
		filter: { model: "opus" },
	});
	assert.deepEqual(other.rows, []);
	assert.deepEqual(other.untested, [
		release.version,
		...[...versions].reverse(),
	]);
	assert.match(formatLibraryEvidence(other), /No retained evidence matches\./);
	assert.match(
		formatLibraryEvidence(other),
		/3\.0\.0 {2}untested for this filter/,
	);

	const oneVersion = libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
		version: versions[0],
		filter: { host: "claude" },
	});
	assert.deepEqual(oneVersion.rows, []);
	assert.deepEqual(oneVersion.untested, [versions[0]]);
	// Without a filter, nothing is labeled untested.
	assert.deepEqual(
		libraryEvidence({ storeRoot: f.storeRoot, name: NAME }).untested,
		[],
	);
});

test("a record that fails revalidation is a problem, never evidence", (t) => {
	const f = fixture(t);
	const index = path.join(
		f.storeRoot,
		"evaluations/results/ids",
		`${f.results.id}.json`,
	);
	fs.chmodSync(index, 0o644);
	fs.writeFileSync(index, "{}");
	const result = libraryEvidence({ storeRoot: f.storeRoot, name: NAME });
	assert.deepEqual(result.rows, []);
	assert.equal(result.problems.length, 1);
	assert.match(
		result.problems[0],
		new RegExp(`evaluation result ${f.results.id}:`),
	);
	assert.match(
		formatLibraryEvidence(result),
		/Store problem: evaluation result/,
	);
});

test("evidence reads never write to the store or either project", (t) => {
	const f = fixture(t);
	promote(f);
	const other = elsewhere(f);
	const before = [f.storeRoot, f.root, other].map(tree);
	libraryEvidence({ storeRoot: f.storeRoot, name: NAME, root: f.root });
	libraryEvidence({
		storeRoot: f.storeRoot,
		name: NAME,
		root: other,
		filter: { model: "opus" },
	});
	libraryInfo({ storeRoot: f.storeRoot, name: NAME, root: f.root });
	listLibrary({ storeRoot: f.storeRoot });
	for (const args of [
		["evidence", NAME, "--root", f.root],
		["info", `${NAME}@${release.version}`, "--root", other],
	])
		assert.equal(
			spawnSync(
				process.execPath,
				[cli, "library", ...args, "--store", f.storeRoot],
				{ encoding: "utf8" },
			).status,
			0,
		);
	assert.deepEqual([f.storeRoot, f.root, other].map(tree), before);
});

test("CLI: library evidence filters, prints JSON, and validates options", (t) => {
	const f = fixture(t);
	const run = (...args) =>
		spawnSync(process.execPath, [cli, "library", ...args], {
			encoding: "utf8",
		});
	const json = run(
		"evidence",
		NAME,
		"--store",
		f.storeRoot,
		"--model",
		scope.model,
		"--role",
		scope.role,
		"--json",
	);
	assert.equal(json.status, 0, json.stderr);
	const parsed = JSON.parse(json.stdout);
	assert.equal(parsed.rows.length, 1);
	assert.deepEqual(parsed.filter, {
		model: scope.model,
		role: scope.role,
	});
	const text = run("evidence", NAME, "--store", f.storeRoot, "--host", "codex");
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /Filter: host codex/);
	for (const [args, message] of [
		[
			["evidence", NAME, "--type", "skill"],
			/--type is not supported by library evidence/,
		],
		[["evidence", NAME, "--role", "a", "--role", "b"], /one --role/],
		[
			["evidence", "@example/absent", "--store", f.storeRoot],
			/not in the library .* and has no evidence/,
		],
		[
			["info", NAME, "--model", "x"],
			/--model is not supported by library info/,
		],
	]) {
		const result = run(...args);
		assert.equal(result.status, 1, args.join(" "));
		assert.match(result.stderr, message, args.join(" "));
	}
});
