// Issue #33 criterion 9: one connected replay of the guided journey through existing
// public interfaces. FIXTURE EVIDENCE ONLY: outcomes are fictional caller claims that
// exercise mechanics; they say nothing about real model effectiveness.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/install.ts";
import * as migrations from "../src/migrations.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { createStamp } from "../src/stamps.ts";
import {
	decision,
	fixture,
	models,
	put,
	release,
	scope,
	tuple,
	versions,
	writeDecision,
} from "./helpers/promotion-fixture.js";

const read = (file) => fs.readFileSync(file);
function selected(f, model) {
	const r = resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		...tuple(model),
	});
	return r.required.find((entry) => entry.id === "reviewer").package;
}
// The guide's guarded restoration (docs/guided-evaluation.md section 5), done by hand:
// refuse unless every file still holds its recorded post-change bytes.
function guardedRestore(saved) {
	for (const [file, { after }] of saved)
		if (!read(file).equals(after))
			throw new Error(
				`${file}: changed since adoption; reconcile before restoring`,
			);
	for (const [file, { before }] of saved) fs.writeFileSync(file, before);
}

test("guided replay: select, refuse, report, preview, decide, adopt, switch model and restore (fixture evidence)", (t) => {
	const f = fixture(t);
	const promotion = {
		root: f.root,
		storeRoot: f.storeRoot,
		decisionFile: f.decisionFile,
	};
	// Unrelated instructions and user configuration that adoption must not touch.
	const settings = path.join(f.root, ".claude/settings.json");
	put(settings, '{"permissions":{"allow":["Bash(npm test)"]}}\n');
	const unrelated = [
		settings,
		path.join(f.root, "AGENTS.md"),
		path.join(f.root, "instructions/note.md"),
	];
	const unrelatedBefore = unrelated.map(read);

	// 1. Selection: each exact model resolves its own pinned version.
	const baseline = Object.fromEntries(models.map((m) => [m, selected(f, m)]));
	assert.deepEqual(
		models.map((m) => baseline[m].version),
		versions,
	);

	// 2. Compatibility refusal stops before any work: an unknown host fails resolution.
	assert.throws(
		() =>
			resolveInstructions({
				root: f.root,
				storeRoot: f.storeRoot,
				...scope,
				host: "no-such-host",
			}),
		/host/,
	);

	// 3. Retained evidence and report read back from the store, labeled as caller claims.
	const report = migrations.migrationEvaluationReport({
		storeRoot: f.storeRoot,
		id: f.results.id,
	});
	assert.deepEqual(report, f.report);
	assert.equal(report.eligibility.status, "eligible");
	assert.ok(
		f.results.outcomes.every((o) =>
			o.evidenceRef.startsWith("opaque:caller-claim/"),
		),
	);

	// 4. An untested combination is refused, not treated as equivalent: the evaluation
	// covered models[0] only, so a decision for models[1] fails preview without writes.
	const configBefore = read(f.configFile),
		lockBefore = read(f.lockFile);
	writeDecision(f, decision(f, { assignment: tuple(models[1]) }));
	assert.throws(
		() => migrations.previewMigrationPromotion(promotion),
		/assignment|evaluated|primary/i,
	);

	// 5. Preview of the evaluated tuple is read-only.
	writeDecision(f, decision(f));
	const preview = migrations.previewMigrationPromotion(promotion);
	assert.equal(preview.status, "preview");
	assert.deepEqual(preview.target.assignment, scope);
	assert.ok(read(f.configFile).equals(configBefore));
	assert.ok(read(f.lockFile).equals(lockBefore));

	// 6. Explicit (fixture) decision, then application.
	const applied = migrations.applyMigrationPromotion(promotion);
	assert.equal(applied.status, "promoted");
	const saved = new Map([
		[f.configFile, { before: configBefore, after: read(f.configFile) }],
		[f.lockFile, { before: lockBefore, after: read(f.lockFile) }],
	]);
	assert.ok(!saved.get(f.configFile).after.equals(configBefore));
	assert.deepEqual(unrelated.map(read), unrelatedBefore);

	// 7. Exact-model switch: the adopted tuple gets the release; the others keep their pins.
	assert.deepEqual(
		{
			name: selected(f, models[0]).name,
			version: selected(f, models[0]).version,
		},
		release,
	);
	for (const m of models.slice(1))
		assert.deepEqual(selected(f, m), baseline[m]);

	// 8. Guarded restoration refuses an intervening edit and leaves it in place.
	const edited = Buffer.concat([
		saved.get(f.configFile).after,
		Buffer.from("# later work\n"),
	]);
	fs.writeFileSync(f.configFile, edited);
	assert.throws(() => guardedRestore(saved), /changed since adoption/);
	assert.ok(read(f.configFile).equals(edited));
	assert.ok(read(f.lockFile).equals(saved.get(f.lockFile).after));

	// 9. After reconciling, restoration returns the exact baseline; store history is kept.
	fs.writeFileSync(f.configFile, saved.get(f.configFile).after);
	const doctorAdopted = doctor(f.root, { storeRoot: f.storeRoot }).errors;
	guardedRestore(saved);
	assert.deepEqual(
		doctor(f.root, { storeRoot: f.storeRoot }).errors,
		doctorAdopted,
	);
	for (const m of models) assert.deepEqual(selected(f, m), baseline[m]);
	assert.equal(createStamp(f.input).digest, f.base.digest);
	assert.deepEqual(unrelated.map(read), unrelatedBefore);
	assert.equal(
		migrations.migrationPromotion({
			storeRoot: f.storeRoot,
			id: "promote-reviewer",
		}).releaseDigest,
		applied.release.releaseDigest,
	);
});
