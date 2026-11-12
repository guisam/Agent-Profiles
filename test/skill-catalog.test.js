import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { sideBySide } from "../src/content-diff.ts";
import {
	compareSkills,
	parseSkillSelector,
	skillCatalog,
} from "../src/skill-catalog.ts";
import { startVisualizer } from "../src/visualize.ts";

import {
	ALT,
	browser,
	digestTree,
	fixture,
	REVIEW,
} from "./helpers/skill-library-fixture.js";

const LOCAL = "local:.agent-profiles/skills/testing/SKILL.md";
const pick = (value) => parseSkillSelector(value);

test("catalog lists package versions and local skills with their role usage", (t) => {
	const f = fixture(t);
	const before = digestTree(f.dir);
	const catalog = skillCatalog({ root: f.root, storeRoot: f.store });
	assert.deepEqual(catalog.problems, []);
	assert.equal("store" in catalog, false, "no local store path in the API");
	const review = catalog.packages.find((item) => item.name === REVIEW);
	assert.deepEqual(
		review.versions.map((version) => [
			version.version,
			version.usage.bindings,
			version.usage.roles,
			version.evidence,
		]),
		[
			["2.0.0", [], [], 0],
			[
				"1.0.0",
				["skills.security-review"],
				[{ skill: "security-review", role: "reviewer", list: "required" }],
				0,
			],
		],
	);
	assert.match(review.versions[0].sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(
		catalog.local.map((skill) => [skill.id, skill.version, skill.usage.roles]),
		[["testing", null, [{ role: "reviewer", list: "available" }]]],
	);
	// Browsing never writes the store, configuration, lock, or skills.
	assert.deepEqual(digestTree(f.dir), before);
});

test("comparing two versions shows supporting and binary file changes", (t) => {
	const f = fixture(t);
	const result = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${REVIEW}@2.0.0`),
	});
	assert.equal(result.identical, false);
	assert.deepEqual(
		result.files.map((file) => [file.path, file.status, file.diff === null]),
		[
			["SKILL.md", "changed", false],
			["package.yaml", "changed", false],
			["support/icon.bin", "added", true],
			["support/note.txt", "changed", false],
		],
	);
	assert.match(
		result.files[0].diff,
		new RegExp(`--- ${REVIEW}@1\\.0\\.0/SKILL\\.md`),
	);
	assert.deepEqual(
		result.right.files.find((file) => file.path === "support/icon.bin"),
		{
			path: "support/icon.bin",
			bytes: 4,
			sha256: createHash("sha256")
				.update(Buffer.from([0, 1, 2, 255]))
				.digest("hex"),
			binary: true,
		},
	);
	assert.notEqual(result.left.sha256, result.right.sha256);
	for (const side of [result.left, result.right])
		assert.deepEqual(side.evidence, { status: "untested", rows: [] });
	assert.deepEqual(result.left.usage.roles, [
		{ skill: "security-review", role: "reviewer", list: "required" },
	]);
	assert.deepEqual(result.right.usage.bindings, []);
});

test("differently named packages and local skills compare with explicit unknowns", (t) => {
	const f = fixture(t);
	const named = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${ALT}@1.0.0`),
	});
	assert.equal(named.left.name, REVIEW);
	assert.equal(named.right.name, ALT);
	assert.deepEqual(
		named.files.map((file) => file.path),
		["SKILL.md", "package.yaml"],
	);

	const local = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(LOCAL),
		right: pick(`package:${REVIEW}@1.0.0`),
	});
	assert.deepEqual(
		[local.left.kind, local.left.name, local.left.version, local.left.sha256],
		["local", "testing", null, null],
	);
	assert.deepEqual(local.left.usage.roles, [
		{ role: "reviewer", list: "available" },
	]);
	assert.deepEqual(local.left.evidence, { status: "untested", rows: [] });
	assert.deepEqual(
		local.files.map((file) => [file.path, file.status]),
		[
			["SKILL.md", "changed"],
			["package.yaml", "added"],
			["support/note.txt", "added"],
		],
	);

	const same = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(LOCAL),
		right: pick(LOCAL),
	});
	assert.equal(same.identical, true);
});

test("selectors reject malformed values and files that are not discovered skills", (t) => {
	const f = fixture(t);
	for (const value of ["", "package:", `package:${REVIEW}`, "local:", "x:y"])
		assert.throws(() => pick(value), /expected package:<name>@<version>/);
	assert.deepEqual(pick(`package:${REVIEW}@1.0.0`), {
		kind: "package",
		name: REVIEW,
		version: "1.0.0",
	});
	const compare = (left, right = LOCAL) =>
		compareSkills({
			root: f.root,
			storeRoot: f.store,
			left: pick(left),
			right: pick(right),
		});
	assert.throws(
		() => compare("local:.agent-profiles/agents.yaml"),
		/not a discovered project-local skill/,
	);
	assert.throws(
		() => compare("local:../outside/SKILL.md"),
		/not a discovered project-local skill/,
	);
	assert.throws(() => compare(`package:${REVIEW}@9.9.9`), /not in the library/);
});

function get(url) {
	return new Promise((resolve, reject) => {
		request(url, (response) => {
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("end", () =>
				resolve({ status: response.statusCode, body: JSON.parse(body) }),
			);
		})
			.on("error", reject)
			.end();
	});
}

test("the visualizer serves the catalog and comparisons read-only", async (t) => {
	const f = fixture(t);
	const app = await startVisualizer({ root: f.root, storeRoot: f.store });
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const catalog = await get(`${app.url}api/skills`);
	assert.equal(catalog.status, 200);
	assert.deepEqual(
		catalog.body.packages.map((item) => item.name),
		[ALT, REVIEW],
	);
	const query = new URLSearchParams({
		left: `package:${REVIEW}@1.0.0`,
		right: LOCAL,
	});
	const compared = await get(`${app.url}api/compare?${query}`);
	assert.equal(compared.status, 200);
	assert.equal(compared.body.right.kind, "local");
	for (const [suffix, message] of [
		["api/skills?x=1", /takes no parameters/],
		[`api/compare?left=${encodeURIComponent(LOCAL)}`, /exactly one right/],
		[`api/compare?${query}&store=elsewhere`, /Unknown parameter: store/],
	]) {
		const response = await get(`${app.url}${suffix}`);
		assert.equal(response.status, 400);
		assert.match(response.body.error, message);
	}
});

test("the library panel browses, compares and previews without writing files", async (t) => {
	const f = fixture(t);
	const before = digestTree(f.dir);
	const app = await startVisualizer({ root: f.root, storeRoot: f.store });
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const page = await browser(app.url);
	// Nothing loads until the user asks for the library.
	assert.equal(page.text("library-rows"), "");
	await page.node("library-load").listeners.click();
	assert.equal(page.node("library-view").hidden, false);
	assert.match(page.text("library-status"), /Showing 4 of 4 skill entries/);
	const rows = page.text("library-rows");
	assert.match(rows, /unknown version \(local, unversioned\)/);
	assert.match(rows, /sha256:[0-9a-f]{12}…/);
	assert.match(rows, /Preview reviewer \(required\)/);
	assert.match(rows, /untested/);

	page.node("library-search").value = "careful-review";
	page.node("library-search").listeners.input();
	assert.match(page.text("library-status"), /Showing 1 of 4/);
	page.node("library-search").value = "";
	page.node("library-filter").value = "local";
	page.node("library-filter").listeners.change();
	assert.match(page.text("library-rows"), /testing/);
	assert.doesNotMatch(page.text("library-rows"), /security-review/);

	page.node("compare-left").value = `package:${REVIEW}@1.0.0`;
	page.node("compare-right").value = `package:${REVIEW}@2.0.0`;
	await page.node("compare-run").listeners.click();
	assert.equal(page.node("skill-diff").hidden, false);
	assert.match(page.text("side-left"), /Untested: no evaluation evidence/);
	assert.match(page.text("side-right"), /support\/icon\.bin · 4 B · binary/);
	assert.match(page.text("diff-files"), /added · support\/icon\.bin/);
	assert.match(page.text("diff-files"), /Binary file: contents not shown/);
	assert.match(page.text("diff-files"), /-note 1\.0\.0\n\+note 2\.0\.0/);

	// Preview an available skill: the resolution view requests it for that role.
	page.node("library-filter").value = "local";
	page.node("library-filter").listeners.change();
	const preview = page
		.node("library-rows")
		.children[0].children[3].children.find((node) =>
			/^Preview reviewer/.test(node.textContent),
		);
	preview.listeners.click();
	await page.until(() => /Requested, injected/.test(page.text("available")));
	assert.equal(page.node("role").value, "reviewer");
	assert.match(page.text("library-status"), /Pins and files are unchanged/);
	assert.deepEqual(digestTree(f.dir), before);
});

test("side-by-side rows align every line and pair changes", () => {
	assert.deepEqual(sideBySide("a\nb\nc", "a\nx\nc\nd"), [
		{ kind: "same", left: [1, "a"], right: [1, "a"] },
		{ kind: "changed", left: [2, "b"], right: [2, "x"] },
		{ kind: "same", left: [3, "c"], right: [3, "c"] },
		{ kind: "added", left: null, right: [4, "d"] },
	]);
	assert.deepEqual(sideBySide("a\nb\nc", "c"), [
		{ kind: "removed", left: [1, "a"], right: null },
		{ kind: "removed", left: [2, "b"], right: null },
		{ kind: "same", left: [3, "c"], right: [1, "c"] },
	]);
	assert.deepEqual(sideBySide("", ""), []);
});

test("comparison aligns every file in full, unchanged files included", (t) => {
	const f = fixture(t);
	const result = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${ALT}@1.0.0`),
	});
	assert.deepEqual(
		result.aligned.map((file) => [file.path, file.status, file.binary]),
		[
			["SKILL.md", "changed", false],
			["package.yaml", "changed", false],
			["support/note.txt", "same", false],
		],
	);
	const skill = result.aligned[0].rows;
	assert.deepEqual(skill.at(-2), {
		kind: "same",
		left: [4, "Review 1.0.0"],
		right: [4, "Review 1.0.0"],
	});
	assert.equal(skill[1].kind, "changed");
	assert.deepEqual(result.aligned[2].rows[0], {
		kind: "same",
		left: [1, "note 1.0.0"],
		right: [1, "note 1.0.0"],
	});
	const binary = compareSkills({
		root: f.root,
		storeRoot: f.store,
		left: pick(`package:${REVIEW}@1.0.0`),
		right: pick(`package:${REVIEW}@2.0.0`),
	}).aligned.find((file) => file.path === "support/icon.bin");
	assert.deepEqual(binary, {
		path: "support/icon.bin",
		status: "added",
		binary: true,
		rows: null,
	});
});

test("row buttons fill the compare sides and the side-by-side view shows whole files", async (t) => {
	const f = fixture(t);
	const app = await startVisualizer({ root: f.root, storeRoot: f.store });
	t.after(() => new Promise((resolve) => app.server.close(resolve)));
	const page = await browser(app.url);
	await page.node("library-load").listeners.click();
	page.node("library-search").value = "careful-review";
	page.node("library-search").listeners.input();
	const buttons = page.node("library-rows").children[0].children[5].children;
	assert.deepEqual(
		buttons.map((button) => button.textContent),
		["Set as left", "Set as right"],
	);
	buttons[1].listeners.click();
	assert.equal(page.node("compare-right").value, `package:${ALT}@1.0.0`);
	assert.match(
		page.text("library-status"),
		/Compare right: @example\/careful-review@1\.0\.0/,
	);
	page.node("library-search").value = "security-review";
	page.node("library-search").listeners.input();
	// Rows are newest first: 2.0.0, then 1.0.0.
	page
		.node("library-rows")
		.children[1].children[5].children[0].listeners.click();
	assert.equal(page.node("compare-left").value, `package:${REVIEW}@1.0.0`);

	await page.node("compare-run").listeners.click();
	// The unified view shows changes only; the unchanged file is not listed.
	assert.match(page.text("diff-files"), /changed · SKILL\.md/);
	assert.doesNotMatch(page.text("diff-files"), /support\/note\.txt/);
	page.node("compare-view").value = "side";
	page.node("compare-view").listeners.change();
	const side = page.text("diff-files");
	// Side by side lists every file, unchanged ones and unchanged lines included.
	assert.match(side, /same · support\/note\.txt/);
	assert.match(side, /1\nnote 1\.0\.0\n1\nnote 1\.0\.0/);
	assert.match(side, /4\nReview 1\.0\.0\n4\nReview 1\.0\.0/);
	assert.match(side, /security-review skill[\s\S]*careful-review skill/);
	// Switching back restores the unified view without another request.
	page.node("compare-view").value = "unified";
	page.node("compare-view").listeners.change();
	assert.doesNotMatch(page.text("diff-files"), /support\/note\.txt/);
});
