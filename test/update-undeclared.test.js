// update for models that agents.yaml does not declare (found live on Claude Code:
// the example configuration routes most real models through default_profile).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { publishPackage } from "../src/library.ts";
import { applyUpdate, formatUpdate, previewUpdate } from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import { resolveInstructions } from "../src/resolve.ts";

const NAME = "@ap-live/security-review";
const BINDING = "skills.security-review";

function put(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

// Like ap-live: only example-model is declared, default_profile routes the rest, and a
// family prefix routes local-* models to another profile.
function project(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-undeclared-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	const store = path.join(dir, "store");
	for (const version of ["1.0.0", "1.1.0"]) {
		const source = path.join(dir, "sources", version);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: NAME, version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(
			path.join(source, "SKILL.md"),
			`---\ndescription: x\n---\n# Security review ${version}\n`,
		);
		publishPackage({ storeRoot: store, sourceDirectory: source });
	}
	for (const profile of ["constrained", "autonomous", "scaffolded"])
		put(
			path.join(root, `.agent-profiles/profiles/${profile}.md`),
			`# ${profile}\n`,
		);
	put(
		path.join(root, ".agent-profiles/roles/implementer.md"),
		"# Implementer\n",
	);
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		`# Kept across updates.\n${stringify({
			version: 2,
			default_profile: "constrained",
			default_role: "implementer",
			models: {
				"example-model": { profile: "autonomous", aliases: ["example-alias"] },
			},
			families: {
				local: { profile: "scaffolded", match: { prefixes: ["local-"] } },
			},
			profiles: {
				constrained: { file: "profiles/constrained.md" },
				autonomous: { file: "profiles/autonomous.md" },
				scaffolded: { file: "profiles/scaffolded.md" },
			},
			roles: {
				implementer: {
					file: "roles/implementer.md",
					skills: { required: [], available: ["security-review"] },
				},
			},
			skills: { "security-review": { package: NAME, version: "1.0.0" } },
		})}`,
	);
	installDependencies({ root, storeRoot: store });
	return { dir, root, store };
}

const resolved = (f, model, host = "claude") => {
	const result = resolveInstructions({
		root: f.root,
		storeRoot: f.store,
		model,
		role: "implementer",
		host,
	});
	return {
		profile: result.profile,
		version: result.available.find((skill) => skill.package)?.package.version,
	};
};

const input = (f, model, version = "1.1.0") => ({
	root: f.root,
	storeRoot: f.store,
	binding: BINDING,
	version,
	assignment: { role: "implementer", model, host: "claude" },
});

test("an undeclared model is declared with its current profile, and only its pin moves", (t) => {
	const f = project(t);
	const preview = previewUpdate(input(f, "claude-opus-5-5"));
	assert.equal(preview.status, "preview");
	assert.deepEqual(preview.declaredModel, {
		model: "claude-opus-5-5",
		profile: "constrained",
	});
	assert.deepEqual(preview.rule.when, {
		role: "implementer",
		model: "claude-opus-5-5",
		host: "claude",
	});
	assert.deepEqual(
		preview.changed.map((row) => [row.binding, row.from, row.to]),
		[[BINDING, `${NAME}@1.0.0`, `${NAME}@1.1.0`]],
	);
	assert.match(
		formatUpdate(preview),
		/Edits to agents\.yaml \(2\):\n {4}- add rule assignments\.update-[0-9a-f]+\n {4}- declare models\.claude-opus-5-5 with profile constrained, the profile it resolves to now \(routing unchanged\)/,
	);

	const before = resolved(f, "claude-opus-5-5");
	assert.deepEqual(before, { profile: "constrained", version: "1.0.0" });
	applyUpdate(input(f, "claude-opus-5-5"));
	const text = fs.readFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
		"utf8",
	);
	assert.ok(text.startsWith("# Kept across updates.\n"));
	assert.deepEqual(parse(text).models["claude-opus-5-5"], {
		profile: "constrained",
	});
	assert.deepEqual(resolved(f, "claude-opus-5-5"), {
		profile: "constrained",
		version: "1.1.0",
	});
	// Other hosts, other undeclared models and declared models keep their pins and profiles.
	assert.deepEqual(resolved(f, "claude-opus-5-5", "codex"), {
		profile: "constrained",
		version: "1.0.0",
	});
	assert.deepEqual(resolved(f, "claude-sonnet-5"), {
		profile: "constrained",
		version: "1.0.0",
	});
	assert.deepEqual(resolved(f, "example-model"), {
		profile: "autonomous",
		version: "1.0.0",
	});
});

test("a family-routed model is declared with its family's profile", (t) => {
	const f = project(t);
	assert.equal(resolved(f, "local-llm").profile, "scaffolded");
	const preview = previewUpdate(input(f, "local-llm"));
	assert.deepEqual(preview.declaredModel, {
		model: "local-llm",
		profile: "scaffolded",
	});
	applyUpdate(input(f, "local-llm"));
	assert.deepEqual(resolved(f, "local-llm"), {
		profile: "scaffolded",
		version: "1.1.0",
	});
	assert.deepEqual(resolved(f, "local-other"), {
		profile: "scaffolded",
		version: "1.0.0",
	});
});

test("an alias targets its canonical model and declares nothing", (t) => {
	const f = project(t);
	const preview = previewUpdate(input(f, "example-alias"));
	assert.equal(preview.declaredModel, null);
	assert.equal(preview.rule.when.model, "example-model");
	applyUpdate(input(f, "example-alias"));
	const config = parse(
		fs.readFileSync(path.join(f.root, ".agent-profiles/agents.yaml"), "utf8"),
	);
	assert.deepEqual(Object.keys(config.models), ["example-model"]);
	assert.equal(resolved(f, "example-model").version, "1.1.0");
	assert.equal(resolved(f, "example-alias").version, "1.1.0");
});

test("a bare skill ID gets a binding-ID suggestion", (t) => {
	const f = project(t);
	assert.throws(
		() =>
			previewUpdate({
				...input(f, "claude-opus-5-5"),
				binding: "security-review",
			}),
		/security-review is not selected .*; did you mean skills\.security-review\?/,
	);
	assert.throws(
		() =>
			previewUpdate({
				...input(f, "claude-opus-5-5"),
				binding: "skills.absent",
			}),
		(error) =>
			/is not selected/.test(error.message) &&
			!/did you mean/.test(error.message),
	);
	assert.throws(
		() =>
			previewUpdate({ ...input(f, "claude-opus-5-5"), binding: "(profile)" }),
		/is not selected/,
	);
});

test("a declared model's preview declares nothing", (t) => {
	const f = project(t);
	const preview = previewUpdate(input(f, "example-model"));
	assert.equal(preview.declaredModel, null);
	assert.match(formatUpdate(preview), /Edits to agents\.yaml \(1\):/);
	assert.doesNotMatch(formatUpdate(preview), /declare models/);
});

// The preview's applyCommand is what an agent hands the user; run it as printed.
test("the printed apply command applies the preview as is", (t) => {
	const f = project(t);
	const spaced = path.join(f.dir, "my project");
	fs.renameSync(f.root, spaced);
	const g = { ...f, root: spaced };
	const preview = previewUpdate(input(g, "claude-opus-5-5"));
	assert.match(
		formatUpdate(preview),
		/To apply, a person runs this in a terminal \(agents can't\):\n {4}agent-profiles update /,
	);
	assert.ok(formatUpdate(preview).includes(preview.applyCommand));
	assert.ok(
		preview.applyCommand.startsWith(
			`agent-profiles update ${BINDING} 1.1.0 --role implementer --model claude-opus-5-5 --host claude --root "${spaced}" --store ${f.store} --apply --expect ${preview.previewDigest}`,
		),
	);
	const cli = fileURLToPath(
		new URL("../bin/agent-profiles.ts", import.meta.url),
	);
	const args = preview.applyCommand
		.replace(/^agent-profiles /, "")
		.match(/"[^"]*"|\S+/g)
		.map((arg) => arg.replace(/^"(.*)"$/, "$1"));
	const run = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		cwd: f.dir,
	});
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /Edited agents\.yaml \(2\):/);
	assert.deepEqual(resolved(g, "claude-opus-5-5"), {
		profile: "constrained",
		version: "1.1.0",
	});
});
