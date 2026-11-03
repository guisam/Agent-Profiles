import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
	formatLibrary,
	formatLibraryInfo,
	libraryInfo,
	listLibrary,
	publishPackage,
	searchLibrary,
} from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "bin/agent-profiles.ts");
const REVIEW = "@example/security-review";
const DOCS = "@example/api-docs";

function put(file, bytes) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}

function source(dir, name, version, { type = "skill", description } = {}) {
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
			package: {
				name,
				version,
				type,
				...(description ? { description } : {}),
				license: "Apache-2.0",
			},
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "SKILL.md"),
		`---\ndescription: ${description ?? "A fictional skill."}\n---\n${name} ${version}\n`,
	);
	put(path.join(directory, "support/note.txt"), `note ${version}\n`);
	return directory;
}

function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-library-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = path.join(dir, "store");
	const sources = {
		review1: source(dir, REVIEW, "1.0.0", {
			description: "Review fictional changes for security defects.",
		}),
		review2: source(dir, REVIEW, "2.0.0", {
			description: "Review fictional changes for security defects.",
		}),
		review10: source(dir, REVIEW, "10.0.0", {
			description: "Review fictional changes for security defects.",
		}),
		docs: source(dir, DOCS, "1.2.0", {
			type: "instruction",
			description: "Write API reference pages.",
		}),
	};
	return { dir, store, sources };
}

function seed(f) {
	for (const directory of Object.values(f.sources))
		publishPackage({ storeRoot: f.store, sourceDirectory: directory });
}

function tree(directory) {
	const out = {};
	if (!fs.existsSync(directory)) return out;
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

function run(...args) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("an absent or empty store is an empty library", (t) => {
	const f = fixture(t);
	const result = listLibrary({ storeRoot: f.store });
	assert.deepEqual(result.packages, []);
	assert.deepEqual(result.problems, []);
	assert.match(formatLibrary(result), /The library is empty\./);
	assert.equal(fs.existsSync(f.store), false);
});

test("list sorts packages by name and versions newest first, numerically", (t) => {
	const f = fixture(t);
	seed(f);
	const { packages } = listLibrary({ storeRoot: f.store });
	assert.deepEqual(
		packages.map((item) => [item.name, item.versions, item.latest, item.type]),
		[
			[DOCS, ["1.2.0"], "1.2.0", "instruction"],
			[REVIEW, ["10.0.0", "2.0.0", "1.0.0"], "10.0.0", "skill"],
		],
	);
	assert.deepEqual(
		listLibrary({ storeRoot: f.store, type: "instruction" }).packages.map(
			(item) => item.name,
		),
		[DOCS],
	);
	assert.throws(
		() => listLibrary({ storeRoot: f.store, type: "plugin" }),
		/type: expected skill or instruction/,
	);
});

test("search matches name or description, case-insensitively", (t) => {
	const f = fixture(t);
	seed(f);
	const names = (text) =>
		searchLibrary({ storeRoot: f.store, text }).packages.map(
			(item) => item.name,
		);
	assert.deepEqual(names("SECURITY"), [REVIEW]);
	assert.deepEqual(names("api-docs"), [DOCS]);
	assert.deepEqual(names("@example"), [DOCS, REVIEW]);
	assert.deepEqual(names("nothing like this"), []);
	assert.match(
		formatLibrary(searchLibrary({ storeRoot: f.store, text: "zzz" })),
		/No packages match "zzz"\./,
	);
	assert.throws(
		() => searchLibrary({ storeRoot: f.store, text: "  " }),
		/nonempty/,
	);
});

test("info reports every verified field for all versions or one", (t) => {
	const f = fixture(t);
	seed(f);
	const all = libraryInfo({ storeRoot: f.store, name: REVIEW });
	assert.deepEqual(
		all.versions.map((version) => version.version),
		["10.0.0", "2.0.0", "1.0.0"],
	);
	const [one] = libraryInfo({
		storeRoot: f.store,
		name: REVIEW,
		version: "2.0.0",
	}).versions;
	assert.deepEqual(
		{ ...one, sha256: undefined },
		{
			version: "2.0.0",
			source: "package",
			revisionDigest: null,
			sha256: undefined,
			type: "skill",
			description: "Review fictional changes for security defects.",
			license: "Apache-2.0",
			entrypoint: "SKILL.md",
			delivery: "instruction",
			hosts: [],
			effects: [],
			files: 3,
			bytes: one.bytes,
		},
	);
	assert.match(one.sha256, /^[0-9a-f]{64}$/);
	assert.throws(
		() => libraryInfo({ storeRoot: f.store, name: "@example/absent" }),
		/@example\/absent: not in the library/,
	);
	assert.throws(
		() => libraryInfo({ storeRoot: f.store, name: REVIEW, version: "3.0.0" }),
		/versions: 10\.0\.0, 2\.0\.0, 1\.0\.0/,
	);
});

test("list, search and info never write to the store", (t) => {
	const f = fixture(t);
	seed(f);
	const before = tree(f.store);
	listLibrary({ storeRoot: f.store });
	searchLibrary({ storeRoot: f.store, text: "security" });
	libraryInfo({ storeRoot: f.store, name: REVIEW });
	for (const args of [
		["list"],
		["search", "security"],
		["info", `${REVIEW}@1.0.0`],
	])
		assert.equal(run("library", ...args, "--store", f.store).status, 0);
	assert.deepEqual(tree(f.store), before);
});

test("a corrupted object is reported, not shown as a valid version", (t) => {
	const f = fixture(t);
	seed(f);
	const [target] = libraryInfo({
		storeRoot: f.store,
		name: REVIEW,
		version: "2.0.0",
	}).versions;
	const note = path.join(
		f.store,
		"objects/sha256",
		target.sha256,
		"tree/support/note.txt",
	);
	fs.chmodSync(note, 0o644);
	fs.writeFileSync(note, "tampered\n");

	const [corrupt] = libraryInfo({
		storeRoot: f.store,
		name: REVIEW,
		version: "2.0.0",
	}).versions;
	assert.ok("error" in corrupt, JSON.stringify(corrupt));
	assert.equal(corrupt.sha256, target.sha256);
	assert.match(
		formatLibraryInfo(libraryInfo({ storeRoot: f.store, name: REVIEW })),
		/Not verified:/,
	);

	const listed = listLibrary({ storeRoot: f.store }).packages.find(
		(item) => item.name === REVIEW,
	);
	assert.deepEqual(listed.unverified, ["2.0.0"]);
	assert.equal(listed.latest, "10.0.0");
});

test("stray entries in the identities tree are problems, not failures", (t) => {
	const f = fixture(t);
	seed(f);
	put(path.join(f.store, "identities/stray.txt"), "not a namespace\n");
	put(path.join(f.store, "identities/not-hex/name/1.0.0.json"), "{}");
	const result = listLibrary({ storeRoot: f.store });
	assert.equal(result.packages.length, 2);
	assert.equal(result.problems.length, 2, result.problems.join("\n"));
	assert.match(formatLibrary(result), /Store problem: identities\/stray\.txt/);
});

test("publish and add write identical store bytes; republish is reused", (t) => {
	const f = fixture(t);
	const viaAdd = path.join(f.dir, "store-add");
	const published = publishPackage({
		storeRoot: f.store,
		sourceDirectory: f.sources.review1,
	});
	assert.equal(published.status, "published");
	importPackage({ sourceDirectory: f.sources.review1, storeRoot: viaAdd });
	const strip = (store) =>
		Object.fromEntries(
			Object.entries(tree(store)).filter(([file]) => !file.startsWith(".")),
		);
	assert.deepEqual(strip(f.store), strip(viaAdd));
	assert.equal(
		publishPackage({ storeRoot: f.store, sourceDirectory: f.sources.review1 })
			.status,
		"reused",
	);
});

test("publish without a manifest points to the manifest documentation", (t) => {
	const f = fixture(t);
	const bare = path.join(f.dir, "bare-skill");
	put(path.join(bare, "SKILL.md"), "---\ndescription: x\n---\nx\n");
	assert.throws(
		() => publishPackage({ storeRoot: f.store, sourceDirectory: bare }),
		/package\.yaml.*docs\/versioned-packages\.md/,
	);
	assert.equal(fs.existsSync(path.join(f.store, "identities")), false);
});

test("info --root marks the versions one project pins and locks", (t) => {
	const f = fixture(t);
	seed(f);
	const root = path.join(f.dir, "project");
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
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
					skills: { required: ["security-review"], available: [] },
				},
			},
			skills: { "security-review": { package: REVIEW, version: "1.0.0" } },
			assignments: {
				"large-review": {
					when: { model: "fictional-large", role: "reviewer" },
					versions: { "skills.security-review": "2.0.0" },
				},
			},
		}),
	);
	const unlocked = libraryInfo({ storeRoot: f.store, name: REVIEW, root });
	assert.equal(unlocked.project.lockState, "missing");
	installDependencies({ root, storeRoot: f.store });

	const info = libraryInfo({ storeRoot: f.store, name: REVIEW, root });
	assert.equal(info.project.lockState, "valid");
	const byVersion = Object.fromEntries(
		info.project.pins.map((pin) => [pin.version, pin]),
	);
	assert.deepEqual(Object.keys(byVersion).sort(), ["1.0.0", "2.0.0"]);
	assert.deepEqual(byVersion["1.0.0"].bindings, ["skills.security-review"]);
	assert.deepEqual(byVersion["2.0.0"].bindings, [
		"assignments.large-review.versions.skills.security-review",
	]);
	for (const version of ["1.0.0", "2.0.0"])
		assert.equal(
			byVersion[version].locked,
			info.versions.find((v) => v.version === version).sha256,
		);
	const text = formatLibraryInfo(info);
	assert.match(text, /Pinned by .*skills\.security-review; locked/);

	const other = libraryInfo({ storeRoot: f.store, name: DOCS, root });
	assert.deepEqual(other.project.pins, []);
	assert.match(formatLibraryInfo(other), /Not pinned by/);
});

test("CLI: library commands print text and JSON and validate arguments", (t) => {
	const f = fixture(t);
	const published = run(
		"library",
		"publish",
		f.sources.review1,
		"--store",
		f.store,
	);
	assert.equal(published.status, 0, published.stderr);
	assert.match(
		published.stdout,
		/^Published: @example\/security-review@1\.0\.0 sha256 [0-9a-f]{64}/,
	);
	const again = run(
		"library",
		"publish",
		f.sources.review1,
		"--store",
		f.store,
	);
	assert.match(again.stdout, /^Already in the library:/);

	const listed = run("library", "list", "--store", f.store, "--json");
	assert.equal(listed.status, 0, listed.stderr);
	assert.deepEqual(
		JSON.parse(listed.stdout).packages.map((item) => item.name),
		[REVIEW],
	);
	const text = run("library", "list", "--store", f.store);
	assert.match(
		text.stdout,
		/@example\/security-review {2}1\.0\.0 {2}\(skill\)/,
	);

	const info = run("library", "info", `${REVIEW}@1.0.0`, "--store", f.store);
	assert.equal(info.status, 0, info.stderr);
	assert.match(info.stdout, /1\.0\.0 {2}sha256 [0-9a-f]{64}/);

	for (const [args, message] of [
		[["library"], /Usage: agent-profiles library/],
		[["library", "list", "extra"], /Usage: agent-profiles library/],
		[["library", "search"], /Usage: agent-profiles library/],
		[
			["library", "list", "--root", f.dir],
			/--root is not supported by library list/,
		],
		[
			["library", "publish", f.sources.review1, "--type", "skill"],
			/--type is not supported by library publish/,
		],
		[
			["library", "info", "@example/absent", "--store", f.store],
			/not in the library/,
		],
	]) {
		const result = run(...args);
		assert.equal(result.status, 1, args.join(" "));
		assert.match(result.stderr, message, args.join(" "));
	}
});
