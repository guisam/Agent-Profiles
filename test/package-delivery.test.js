import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyChanges, readLocal } from "../src/files.ts";
import { installDependencies } from "../src/package-lock.ts";
import { parseManifest, readPackage } from "../src/packages.ts";
import {
	parseYaml,
	parseYamlDocument,
	resolveInstructions,
} from "../src/resolve.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const GUIDE = "docs/migrations/config-v1-to-v2.md";
const PROMPT = "docs/migrations/prompts/config-v1-to-v2.md";
const PACKAGES = "docs/versioned-packages.md";
const read = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const put = (root, file, bytes) => {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), bytes);
};
function examples() {
	const section = read(GUIDE)
		.split("## 5. Same-semantic example")[1]
		?.split("## 6.")[0];
	assert.ok(section, "complete same-semantic example section");
	const blocks = [...section.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map(
		(m) => m[1],
	);
	assert.equal(blocks.length, 2, "complete source and target YAML fences");
	return blocks;
}
function fixture(t, yaml = examples()[0]) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p9-delivery-")),
	);
	t.after(() => {
		assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
		assert.ok(path.basename(dir).startsWith("p9-delivery-"));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const root = path.join(dir, "project"),
		evidence = path.join(dir, "evidence"),
		storeRoot = path.join(dir, "store");
	for (const p of [root, evidence, storeRoot]) fs.mkdirSync(p);
	const files = new Map([
		...["constrained", "autonomous", "scaffolded"].map((id) => [
			`.agent-profiles/profiles/${id}.md`,
			Buffer.from(`\uFEFF# ${id}\r\nProfile instructions.\r\n\r\n `),
		]),
		[
			".agent-profiles/roles/reviewer.md",
			Buffer.from("\uFEFF# Reviewer\r\nReview instructions.\r\n\r\n "),
		],
		[
			".agent-profiles/skills/testing/SKILL.md",
			Buffer.from(
				"\uFEFF---\r\ndescription: Test the change.\r\n---\r\nTesting instructions.\r\n\r\n ",
			),
		],
		[
			".agent-profiles/instructions/review/SKILL.md",
			Buffer.from(
				"---\r\ndescription: Review the change.\r\n---\r\nReview instructions.\r\n\r\n ",
			),
		],
	]);
	for (const [file, bytes] of files) put(root, file, bytes);
	put(root, CONFIG, yaml);
	return { dir, root, evidence, storeRoot, files };
}
function snapshot(root, exclude = []) {
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort()
		.filter((p) => !exclude.includes(p))
		.map((p) => [
			p,
			fs.lstatSync(path.join(root, p)).isDirectory()
				? null
				: fs.readFileSync(path.join(root, p)),
		]);
}
function scalarCandidate(before) {
	const text = before.toString("utf8"),
		document = parseYamlDocument(text);
	assert.equal(
		document.get("version"),
		1,
		"only validated v1 gets a scalar candidate",
	);
	const [start, end] = document.get("version", true).range;
	return Buffer.from(`${text.slice(0, start)}2${text.slice(end)}`);
}
function links(file) {
	// Only ordinary inline local links and ATX headings on this finite doc surface.
	for (const match of read(file).matchAll(/\[[^\]\r\n]*\]\(([^\s)]+)\)/g)) {
		const href = match[1];
		if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
		const [relative, anchor] = href.split("#");
		const target = path.resolve(
			REPO,
			path.dirname(file),
			decodeURIComponent(relative),
		);
		assert.ok(fs.existsSync(target), `${file}: missing local link ${href}`);
		if (anchor && target.endsWith(".md")) {
			const headings = [
				...fs.readFileSync(target, "utf8").matchAll(/^#{1,6} (.+)\r?$/gm),
			].map((m) =>
				m[1]
					.trim()
					.toLowerCase()
					.replace(/[`*_]/g, "")
					.replace(/[^\p{L}\p{N}\s-]/gu, "")
					.replace(/\s/g, "-"),
			);
			assert.ok(
				headings.includes(decodeURIComponent(anchor)),
				`${file}: missing anchor ${href}`,
			);
		}
	}
}

test("P9b-01 complete guide examples preserve real v1/v2 routing, native metadata and raw bytes", (t) => {
	const [source, target] = examples(),
		a = parseYaml(source),
		b = parseYaml(target);
	assert.equal(a.get("version"), 1);
	assert.equal(b.get("version"), 2);
	const withoutVersion = (config) =>
		new Map([...config].filter(([key]) => key !== "version"));
	assert.deepEqual(withoutVersion(a), withoutVersion(b));
	assert.deepEqual(
		scalarCandidate(Buffer.from(source)),
		Buffer.from(target),
		"literal example diff is scalar-only",
	);
	const f = fixture(t),
		protectedBefore = snapshot(f.root);
	const routes = [
		[{}, "constrained", "default", null, null],
		[
			{ model: "example-large", family: "example-family" },
			"autonomous",
			"model",
			"example-family",
			"supplied",
		],
		[{ model: "example-large-alias" }, "autonomous", "alias", null, null],
		[
			{ model: "unknown", family: "example-family" },
			"scaffolded",
			"family",
			"example-family",
			"supplied",
		],
		[
			{ model: "example-small-dated" },
			"scaffolded",
			"family-prefix",
			"example-family",
			"configured-prefix",
		],
		[{ model: "UNKNOWN" }, "constrained", "default", null, null],
	];
	for (const [selectors, profile, matchedBy, family, familySource] of routes) {
		for (const host of [undefined, "claude", "codex"]) {
			const results = [a, b].map((configuration) =>
				resolveInstructions({
					root: f.root,
					storeRoot: f.storeRoot,
					configuration,
					...selectors,
					host,
					skills: ["native-review", "local-review", "local-review", "testing"],
				}),
			);
			for (const r of results) {
				assert.deepEqual(
					[
						r.profile,
						r.matchedBy,
						r.family,
						r.familySource,
						r.role,
						r.roleSource,
					],
					[profile, matchedBy, family, familySource, "reviewer", "default"],
				);
				assert.equal(
					r.identity.canonical,
					matchedBy === "model" || matchedBy === "alias"
						? "example-large"
						: null,
				);
				assert.deepEqual(
					r.required.map((s) => s.id),
					["testing"],
				);
				assert.deepEqual(
					r.available.map((s) => s.id),
					["local-review", "native-review"],
				);
				assert.deepEqual(
					r.loaded.map((e) => [e.kind, e.id]),
					[
						["profile", profile],
						["role", "reviewer"],
						["required-skill", "testing"],
						["requested-skill", "local-review"],
					],
				);
				const native = r.available[1];
				assert.deepEqual(
					[
						native.type,
						native.delivery,
						native.host,
						native.scope,
						native.hostId,
						native.path,
						native.verification,
						native.usable,
					],
					[
						"host",
						"invoke",
						"claude",
						"user",
						"review-helper",
						null,
						"host-provided",
						host === undefined ? null : host === "claude",
					],
				);
				assert.deepEqual(r.unsatisfied, []);
				assert.deepEqual(
					[r.lockMode, r.lockState, r.installRequired],
					["required", "not-required", false],
				);
				for (const entry of r.loaded) {
					assert.deepEqual(
						readLocal(f.root, entry.path),
						f.files.get(entry.path),
						"raw API Buffer retains BOM/CRLF/trailing bytes",
					);
					assert.equal(entry.content, f.files.get(entry.path).toString("utf8"));
				}
			}
			// Compare the intended selection fields, not schema/operational record shape.
			for (const field of [
				"identity",
				"loaded",
				"required",
				"available",
				"diagnostics",
			])
				assert.deepEqual(results[0][field], results[1][field]);
		}
	}
	// Explicit extension, separate from the literal examples: overlap plus independent role.
	for (const configuration of [a, b]) {
		configuration.get("families").set(
			"specific",
			new Map([
				["profile", "autonomous"],
				["match", new Map([["prefixes", ["example-small-special-"]]])],
			]),
		);
		configuration.get("roles").set(
			"observer",
			new Map([
				["file", "roles/reviewer.md"],
				[
					"skills",
					new Map([
						["required", []],
						["available", []],
					]),
				],
			]),
		);
		const r = resolveInstructions({
			root: f.root,
			storeRoot: f.storeRoot,
			configuration,
			model: "example-small-special-dated",
			role: "observer",
		});
		assert.deepEqual(
			[r.profile, r.family, r.matchedBy, r.role, r.roleSource],
			["autonomous", "specific", "family-prefix", "observer", "assigned"],
		);
		assert.deepEqual(
			r.loaded.map((e) => e.kind),
			["profile", "role"],
		);
	}
	assert.deepEqual(snapshot(f.root), protectedBefore);
	assert.deepEqual(snapshot(f.storeRoot), []);
});

test("P9b-02 documented manual scalar edit validates then repeats as a byte-identical no-op", (t) => {
	const f = fixture(t, `\uFEFF${examples()[0].replace(/\r?\n/g, "\r\n")}`);
	put(f.root, LOCK, Buffer.from("unrelated leftover lock\r\n\uFEFF"));
	const before = readLocal(f.root, CONFIG),
		protectedBefore = snapshot(f.root, [CONFIG]);
	resolveInstructions({ root: f.root, storeRoot: f.storeRoot });
	const candidate = scalarCandidate(before);
	resolveInstructions({
		root: f.root,
		storeRoot: f.storeRoot,
		configuration: parseYaml(candidate.toString("utf8")),
	});
	const approvedCandidate = Buffer.from(
		examples()[1].replace(/\r?\n/g, "\r\n").replace(/^/, "\uFEFF"),
	);
	assert.deepEqual(
		candidate,
		approvedCandidate,
		"fixture approval binds exact preview bytes",
	);
	fs.writeFileSync(path.join(f.evidence, "agents.yaml.before"), before, {
		flag: "wx",
	});
	assert.deepEqual(
		fs.readFileSync(path.join(f.evidence, "agents.yaml.before")),
		before,
	);
	assert.deepEqual(readLocal(f.root, CONFIG), before);
	assert.deepEqual(snapshot(f.root, [CONFIG]), protectedBefore);
	assert.deepEqual(
		applyChanges(f.root, [{ file: CONFIG, before, after: candidate }], () => {
			assert.equal(
				parseYaml(readLocal(f.root, CONFIG).toString("utf8")).get("version"),
				2,
			);
			assert.equal(
				resolveInstructions({ root: f.root, storeRoot: f.storeRoot }).lockState,
				"not-required",
			);
		}),
		[CONFIG],
	);
	assert.deepEqual(readLocal(f.root, CONFIG), candidate);
	assert.deepEqual(snapshot(f.root, [CONFIG]), protectedBefore);
	const complete = snapshot(f.dir);
	assert.equal(
		parseYaml(readLocal(f.root, CONFIG).toString("utf8")).get("version"),
		2,
	);
	assert.equal(
		resolveInstructions({ root: f.root, storeRoot: f.storeRoot })
			.installRequired,
		false,
	);
	assert.deepEqual(
		snapshot(f.dir),
		complete,
		"already-target validation creates no backup or other writes",
	);
});

test("P9b-03 invalid sources refuse before a scalar candidate while valid v1 install gives migration guidance", (t) => {
	const f = fixture(t),
		source = examples()[0];
	assert.equal(
		resolveInstructions({ root: f.root, storeRoot: f.storeRoot }).profile,
		"constrained",
	);
	const validBefore = snapshot(f.dir);
	assert.throws(
		() => installDependencies({ root: f.root, storeRoot: f.storeRoot }),
		/version 1: migrate to version 2 using docs\/migrations\/config-v1-to-v2\.md/,
	);
	assert.deepEqual(
		snapshot(f.dir),
		validBefore,
		"legacy validation does not promise dependency installation",
	);
	for (const [yaml, diagnostic] of [
		[source.replace(/version: 1\r?\n/, ""), /version: required field/],
		...['"1"', "1.5", "0", "4", "null"].map((token) => [
			source.replace("version: 1", `version: ${token}`),
			/version: only versions 1, 2 and 3 are supported/,
		]),
		[
			source.replace("version: 1", "version: [1"),
			/YAML|flow|Flow|sequence|Sequence|end/i,
		],
		[
			source.replace("roles/reviewer.md", "roles/absent.md"),
			/roles\.reviewer\.file.*(?:exist|missing|ENOENT)/,
		],
	]) {
		put(f.root, CONFIG, yaml);
		const before = snapshot(f.dir);
		let candidate;
		assert.throws(() => {
			resolveInstructions({ root: f.root, storeRoot: f.storeRoot });
			candidate = scalarCandidate(readLocal(f.root, CONFIG));
		}, diagnostic);
		assert.equal(
			candidate,
			undefined,
			"refusal happened before candidate construction",
		);
		assert.deepEqual(
			snapshot(f.dir),
			before,
			"invalid source and evidence untouched",
		);
	}
});

test("P9b-04 manual approval, drift and guarded rollback preserve other actor bytes", (t) => {
	const f = fixture(t),
		before = readLocal(f.root, CONFIG),
		candidate = scalarCandidate(before);
	const protectedBefore = snapshot(f.root, [CONFIG]);
	const change = { file: CONFIG, before, after: candidate };
	fs.writeFileSync(path.join(f.evidence, "agents.yaml.before"), before, {
		flag: "wx",
	});
	const evidenceBefore = snapshot(f.evidence),
		initial = snapshot(f.root);
	const approved = false;
	assert.throws(() => {
		assert.equal(approved, true, "exact preview approval required");
		applyChanges(f.root, [change]);
	}, /exact preview approval required/);
	assert.deepEqual(snapshot(f.root), initial);
	const otherActor = Buffer.from(
		`${before.toString("utf8")}# another actor\r\n`,
	);
	put(f.root, CONFIG, otherActor);
	assert.throws(
		() => applyChanges(f.root, [change]),
		/changed during the operation/,
	);
	assert.deepEqual(readLocal(f.root, CONFIG), otherActor);
	put(f.root, CONFIG, before);
	assert.throws(
		() =>
			applyChanges(f.root, [change], () => {
				assert.deepEqual(readLocal(f.root, CONFIG), candidate);
				resolveInstructions({ root: f.root, storeRoot: f.storeRoot });
				throw new Error("fixture post-edit check failed");
			}),
		/fixture post-edit check failed[\s\S]*completed writes were rolled back/,
	);
	assert.deepEqual(readLocal(f.root, CONFIG), before);
	assert.throws(
		() =>
			applyChanges(f.root, [change], () => {
				assert.deepEqual(readLocal(f.root, CONFIG), candidate);
				put(f.root, CONFIG, otherActor);
				throw new Error("fixture later edit");
			}),
		/fixture later edit[\s\S]*Rollback incomplete:[\s\S]*changed during the operation/,
	);
	assert.deepEqual(
		readLocal(f.root, CONFIG),
		otherActor,
		"rollback never overwrites later actor bytes",
	);
	assert.deepEqual(snapshot(f.root, [CONFIG]), protectedBefore);
	assert.deepEqual(snapshot(f.evidence), evidenceBefore);
	// Qualify the small preservation helper itself on owned fixture files.
	put(f.root, CONFIG, candidate);
	assert.deepEqual(snapshot(f.root, [CONFIG]), protectedBefore);
	put(f.root, ".agent-profiles/roles/reviewer.md", "protected mutation");
	assert.notDeepEqual(snapshot(f.root, [CONFIG]), protectedBefore);
});

test("P9b-05 migration index does not falsely say current v2 is unimplemented", () => {
	assert.doesNotMatch(
		read("docs/migrations/README.md"),
		/v2 is not implemented in the current checkout/i,
	);
});

test("P9b-06 migration guide does not falsely block the implemented v2 validator", () => {
	assert.doesNotMatch(
		read(GUIDE),
		/Planned, not currently executable|currently\s+accepts only version 1|planned schema, not currently accepted by the v1 resolver|real v2 execution is pending|pending\s+v2 release validation/i,
	);
});

test("P9b-07 migration prompt does not falsely declare current v2 validation unavailable", () => {
	assert.doesNotMatch(
		read(PROMPT),
		/current v2 implementation\s+and its validation are unavailable|current guide says v2\s+is not implemented/i,
	);
});

test("P9b-08 versioned package user guide exists", () => {
	assert.ok(
		fs.existsSync(path.join(REPO, PACKAGES)),
		"missing docs/versioned-packages.md delivery guide",
	);
});

test("P9b-09 package guide manifest, public command examples and local links match current interfaces", {
	skip: fs.existsSync(path.join(REPO, PACKAGES))
		? false
		: "docs/versioned-packages.md absent: manifest/command/link assertions unexecuted",
}, (t) => {
	const text = read(PACKAGES),
		blocks = [...text.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
	const manifestText = blocks.find(
		(block) =>
			parseYaml(block) instanceof Map &&
			parseYaml(block).has("schema_version") &&
			parseYaml(block).has("package"),
	);
	assert.ok(manifestText, "complete strict package manifest example");
	const manifest = parseManifest(Buffer.from(manifestText)),
		f = fixture(t);
	const source = path.join(f.dir, "documented-package");
	put(source, "package.yaml", Buffer.from(manifestText));
	put(
		source,
		manifest.entrypoint,
		Buffer.from(
			"---\ndescription: Fictional documentation fixture.\n---\nInert instruction bytes.\r\n",
		),
	);
	assert.deepEqual(readPackage({ root: source }).manifest, manifest);
	for (const [command, flags] of [
		["add", ["--source", "--store"]],
		["install", ["--source", "--store", "--frozen-lockfile", "--offline"]],
		["stamp", ["--root", "--store"]],
		["verify", ["--store"]],
		["diff", ["--store"]],
		[
			"materialize",
			[
				"--adapter",
				"filesystem-v1",
				"--output-root",
				"--destination",
				"--store",
			],
		],
	]) {
		const snippets = [...text.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)]
			.map((m) => m[1])
			.filter((block) =>
				new RegExp(
					"(?:agent-profiles|bin/agent-profiles\\.js) " +
						command +
						"(?: |\\r?\\n)",
				).test(block),
			);
		assert.ok(snippets.length, `documented actual ${command} command`);
		for (const flag of flags)
			assert.ok(
				snippets.some((block) => block.includes(flag)),
				`${command} example includes ${flag}`,
			);
	}
	assert.doesNotMatch(
		text,
		/agent-profiles (?:migrate|recover|validate)\s/,
		"no invented public commands; confirmed recovery is an API",
	);
	links(PACKAGES);
});

test("P9b-10 existing proposed documentation surface has valid local links and anchors", () => {
	for (const file of [
		"README.md",
		"CHANGELOG.md",
		...[
			"architecture",
			"configure",
			"installer",
			"setup",
			"release",
			"proof",
			"visualize",
			"presets",
		].map((name) => `docs/${name}.md`),
		"docs/migrations/README.md",
		GUIDE,
		PROMPT,
		"docs/development/issue-20-contract.md",
		"docs/development/issue-20-test-map.md",
	])
		links(file);
});

test("P9b-11 migration format retains approval, conditional rollback, no-op and adjacent-step safeguards", () => {
	const guide = read(GUIDE),
		prompt = read(PROMPT),
		pattern = read("docs/migrations/README.md");
	assert.deepEqual(
		[...guide.matchAll(/^## ([1-8])\. /gm)].map((m) => Number(m[1])),
		[1, 2, 3, 4, 5, 6, 7, 8],
	);
	assert.deepEqual(
		[
			...prompt.matchAll(
				/^([1-7])\. (READ|PLAN|PREVIEW|APPROVAL|EDIT|VALIDATE|REPORT):/gm,
			),
		].map((m) => m[2]),
		["READ", "PLAN", "PREVIEW", "APPROVAL", "EDIT", "VALIDATE", "REPORT"],
	);
	assert.match(prompt, /Begin with READ and PLAN only/);
	assert.match(prompt, /Wait for my explicit approval of\s+this exact preview/);
	assert.match(
		guide,
		/only if current bytes still equal this attempt's recorded result/,
	);
	assert.match(
		prompt,
		/only if current bytes equal this attempt's recorded result/,
	);
	assert.match(
		guide,
		/no-op, byte-identical config and no new backups\/writes/,
	);
	assert.match(
		prompt,
		/no-op with byte-identical configuration and no backup\/new writes/,
	);
	assert.match(pattern, /Every future adjacent-step guide/);
	assert.match(pattern, /\[v2 → v3\]\(config-v2-to-v3\.md\)/);
	assert.doesNotMatch(pattern, /There is no v2 → v3 guide/);
	assert.match(pattern, /no arbitrary-version leap rule/);
	assert.match(guide, /Package adoption is separate, optional work/);
	assert.match(prompt, /No package adoption/);
});
