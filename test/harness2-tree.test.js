import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
	materialize,
	materializeStamp,
	planMaterialization,
	recoverMaterialization,
	verifyMaterialization,
} from "../src/materialize.ts";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage } from "../src/package-store.ts";
import { canonicalJSON } from "../src/packages.ts";
import { retainRevisionManifest } from "../src/revisions.ts";
import { createStamp } from "../src/stamps.ts";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const put = (file, content) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const skill = "---\ndescription: reviewing changes\n---\nCheck inputs.\n";

function fixture(
	t,
	{
		packaged = false,
		native = false,
		version = 2,
		profile = "Profile instructions.",
		role = "Role instructions.",
		skillText = skill,
		companions = {},
		resources = {},
		configure,
	} = {},
) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "harness2-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project"),
		storeRoot = path.join(dir, "store"),
		outputRoot = path.join(dir, "out");
	for (const directory of [root, storeRoot, outputRoot]) mkdirSync(directory);
	const config = {
		version,
		default_profile: "base",
		default_role: "worker",
		models: {},
		families: {},
		profiles: {
			base: { file: "profiles/base.md" },
		},
		roles: {
			worker: {
				file: "roles/worker.md",
				resources: Object.keys(resources),
				skills: { required: ["review"], available: [] },
			},
		},
		skills: { review: { file: "skills/review/SKILL.md" } },
	};
	const packages = new Map();
	if (!packaged)
		put(path.join(root, ".agent-profiles/profiles/base.md"), profile);
	put(path.join(root, ".agent-profiles/roles/worker.md"), role);
	if (!packaged) put(path.join(root, "skills/review/SKILL.md"), skillText);
	put(path.join(root, "AGENTS.md"), "PRIVATE REPOSITORY RULES");
	for (const [file, bytes] of Object.entries(resources))
		put(path.join(root, file), bytes);
	if (packaged) {
		for (const [id, type, entrypoint, body, extra] of [
			["base", "instruction", "profile.md", profile, companions],
			[
				"review",
				"skill",
				"SKILL.md",
				skillText,
				{ "scripts/helper.py": "raise RuntimeError('must stay inert')\n" },
			],
		]) {
			const sourceDirectory = path.join(dir, "packages", id);
			const manifest = {
				schema_version: 1,
				package: { name: `@fixture/${id}`, version: "1.0.0", type },
				entrypoint,
				behavior: {
					delivery: native && type === "skill" ? "native" : "instruction",
					hosts: native && type === "skill" ? ["codex"] : [],
					effects: ["commands", "host-configuration"],
				},
			};
			for (const [file, bytes] of Object.entries({
				"package.yaml": stringify(manifest),
				[entrypoint]: body,
				...extra,
			}))
				put(path.join(sourceDirectory, file), bytes);
			packages.set(id, importPackage({ storeRoot, sourceDirectory }));
		}
		config.profiles.base = { package: "@fixture/base", version: "1.0.0" };
		config.skills.review = { package: "@fixture/review", version: "1.0.0" };
	}
	configure?.(config);
	put(path.join(root, ".agent-profiles/agents.yaml"), stringify(config));
	if (packaged) installDependencies({ root, storeRoot });
	const stamp = createStamp({ root, storeRoot, host: "codex" });
	const select = (surface) => ({
		stampDigest: stamp.digest,
		storeRoot,
		adapterId: "harness2-tree",
		adapterContractVersion: 1,
		options: { surface },
	});
	const args = (surface, name = surface) => ({
		...select(surface),
		outputRoot,
		destination: path.join(outputRoot, name),
		deniedRoots: [root, storeRoot],
	});
	const verify = (surface) =>
		verifyMaterialization({
			destination: args(surface).destination,
			expectedStampDigest: stamp.digest,
			storeRoot,
		});
	return {
		dir,
		root,
		storeRoot,
		outputRoot,
		stamp,
		select,
		args,
		verify,
		packages,
		config,
	};
}

for (const surface of ["codex", "opencode"])
	for (const version of [2, 3])
		test(`${surface}: stamp${version - 1} deterministic package layout, provenance and recovery`, (t) => {
			const companions = {
				"scripts/summarize.py": "print('archived, never executed')\n",
				"guardrails.md": "Guardrails.\n",
				"LongTermMEMORY.md": "Pinned memory for this run.\n",
				"tool_descriptions/tool_guidance.md": "Tool guidance.\n",
				"sub_agents/checker/AGENT.md":
					"---\nmode: subagent\ndescription: check output\n---\nCheck output.\n",
				"plugin/example.ts": "export default async () => ({});\n",
				".codex/hooks.json":
					'{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"echo archived"}]}]}}',
				"assets/unmapped.bin": Buffer.from([0, 255]),
			};
			const f = fixture(t, { packaged: true, version, companions });
			const plan = planMaterialization(f.select(surface));
			assert.deepEqual(planMaterialization(f.select(surface)), plan);
			const receipt = materializeStamp(f.args(surface));
			assert.deepEqual(f.verify(surface), { verified: true, findings: [] });
			const root = path.join(f.args(surface).destination, "content");
			const prompt = surface === "codex" ? "AGENTS.md" : "systemprompt.md";
			const skillDir = surface === "codex" ? ".agents/skills" : "skills";
			const body = readFileSync(path.join(root, prompt), "utf8");
			assert.equal(
				body,
				`Profile instructions.\n\nRole instructions.\n\n${skill}\n\n${surface === "codex" ? "- When reviewing changes, read .agents/skills/review/SKILL.md and follow it." : "- When reviewing changes, load the `review` skill."}`,
			);
			assert.ok(!body.includes("PRIVATE REPOSITORY RULES"));
			const outputSkill = readFileSync(
				path.join(root, skillDir, "review/SKILL.md"),
				"utf8",
			);
			assert.equal(
				outputSkill,
				surface === "codex"
					? skill
					: skill.replace("---\n", "---\nname: review\n"),
			);
			assert.equal(
				readFileSync(
					path.join(root, skillDir, "review/scripts/helper.py"),
					"utf8",
				),
				"raise RuntimeError('must stay inert')\n",
			);
			assert.equal(
				readFileSync(path.join(root, "scripts/summarize.py"), "utf8"),
				companions["scripts/summarize.py"],
			);
			assert.equal(
				existsSync(path.join(root, "LongTermMEMORY.md")),
				surface === "opencode",
			);
			assert.equal(
				existsSync(path.join(root, ".codex/hooks.json")),
				surface === "codex",
			);
			assert.equal(
				existsSync(path.join(root, "plugin/example.ts")),
				surface === "opencode",
			);
			assert.equal(
				plan.files.find((file) => file.path === `content/${prompt}`).backing
					.type,
				"generated",
			);
			assert.deepEqual(
				receipt.mappings
					.filter((row) => row.operation === "compose")
					.map((row) => row.binding)
					.sort(),
				["profiles.base", "roles.worker", "skills.review"],
			);
			assert.ok(
				receipt.mappings.some(
					(row) =>
						row.operation === "unmapped" &&
						row.source?.path === "assets/unmapped.bin" &&
						row.reason,
				),
			);
			assert.ok(
				receipt.mappings.some(
					(row) =>
						row.operation === "unmapped" && row.source?.path === "AGENTS.md",
				),
			);
			assert.deepEqual(
				recoverMaterialization({
					destination: f.args(surface).destination,
					outputRoot: f.outputRoot,
					storeRoot: f.storeRoot,
					deniedRoots: [f.root, f.storeRoot],
					expectedStampDigest: f.stamp.digest,
					confirmNoActiveWriter: true,
				}),
				{ removed: [], verification: { verified: true, findings: [] } },
			);
		});

test("surface options are strict before backing is read", () => {
	for (const options of [
		{},
		{ surface: "other" },
		{ surface: "codex", extra: true },
		null,
	])
		assert.throws(
			() =>
				planMaterialization({
					stampDigest: "0".repeat(64),
					adapterId: "harness2-tree",
					adapterContractVersion: 1,
					options,
				}),
			/harness2-tree|options/,
		);
});

test("config3 profile dependencies stay dependency-first with source attribution", (t) => {
	const f = fixture(t, { packaged: true, version: 3 });
	const sourceDirectory = path.join(f.dir, "dependency");
	put(
		path.join(sourceDirectory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: {
				name: "@fixture/guardrails",
				version: "1.0.0",
				type: "instruction",
			},
			entrypoint: "guardrails.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(path.join(sourceDirectory, "guardrails.md"), "Dependency guardrails.\n");
	const dependency = importPackage({ sourceDirectory, storeRoot: f.storeRoot });
	const adopt = (pkg, dependencies) => {
		const manifestFile = path.join(
			f.dir,
			`${pkg.identity.name.split("/")[1]}-revision.json`,
		);
		put(
			manifestFile,
			JSON.stringify({
				revisionVersion: 1,
				kind: "release",
				identity: pkg.identity,
				content: { identity: pkg.identity, sha256: pkg.sha256 },
				parent: null,
				candidate: null,
				dependencies,
				workflow: { file: null, provides: [], requires: [] },
				provenance: {
					kind: "legacy-adoption",
					workflowChange: { kind: "initial", reason: "Fixture declaration" },
				},
			}),
		);
		return retainRevisionManifest({ storeRoot: f.storeRoot, manifestFile })
			.recordDigest;
	};
	const dependencyRevision = adopt(dependency, []);
	f.config.profiles.base.revision = adopt(f.packages.get("base"), [
		{
			...dependency.identity,
			sha256: dependency.sha256,
			revisionDigest: dependencyRevision,
		},
	]);
	put(path.join(f.root, ".agent-profiles/agents.yaml"), stringify(f.config));
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const stamp = createStamp({
		root: f.root,
		storeRoot: f.storeRoot,
		host: "codex",
	});
	const receipt = materializeStamp({
		...f.args("opencode"),
		stampDigest: stamp.digest,
	});
	const prompt = readFileSync(
		path.join(f.args("opencode").destination, "content/systemprompt.md"),
		"utf8",
	);
	assert.ok(
		prompt.startsWith("Dependency guardrails.\n\n\nProfile instructions."),
	);
	assert.ok(
		receipt.mappings.some(
			(row) =>
				row.operation === "compose" &&
				row.binding === "profiles.base" &&
				row.source.sha256 === dependency.sha256,
		),
	);
});

test("available skills are exported without injecting their body", (t) => {
	const f = fixture(t, {
		configure: (config) => {
			config.roles.worker.skills = { required: [], available: ["review"] };
		},
	});
	materializeStamp(f.args("codex"));
	const prompt = readFileSync(
		path.join(f.args("codex").destination, "content/AGENTS.md"),
		"utf8",
	);
	assert.ok(!prompt.includes("Check inputs."));
	assert.match(prompt, /read \.agents\/skills\/review\/SKILL.md/);
});

for (const surface of ["codex", "opencode"])
	test(`${surface}: captured native package skills remain archived bytes`, (t) => {
		const body = skill.replace("---\n", "---\nname: review\n");
		const f = fixture(t, { packaged: true, native: true, skillText: body });
		const receipt = materializeStamp(f.args(surface));
		const skillDir = surface === "codex" ? ".agents/skills" : "skills";
		assert.equal(
			readFileSync(
				path.join(
					f.args(surface).destination,
					"content",
					skillDir,
					"review/SKILL.md",
				),
				"utf8",
			),
			body,
		);
		assert.equal(receipt.capabilities.nativeInvocation, "unsupported");
		assert.equal(f.verify(surface).verified, true);
	});

for (const surface of ["codex", "opencode"])
	test(`${surface}: the exact always-on cap is accepted`, (t) => {
		const cap = surface === "codex" ? 8000 : 24000;
		const f = fixture(t, {
			profile: "x".repeat(cap - 2 - (surface === "opencode" ? 6 : 0)),
			role: "",
			configure: (config) => {
				config.roles.worker.skills.required = [];
			},
		});
		materializeStamp(f.args(surface));
		assert.equal(f.verify(surface).verified, true);
	});

test("Codex refuses an empty always-on prompt", (t) => {
	const f = fixture(t, {
		profile: "",
		role: "",
		configure: (config) => {
			config.roles.worker.skills.required = [];
		},
	});
	assert.throws(() => materializeStamp(f.args("codex")), /must not be empty/);
	assert.deepEqual(readdirSync(f.outputRoot), []);
});

test("OpenCode optional always-on resources participate in the cap", (t) => {
	const f = fixture(t, {
		resources: { "LongTermMEMORY.md": "m".repeat(24000) },
	});
	assert.throws(
		() => materializeStamp(f.args("opencode")),
		/24000 character cap/,
	);
});

for (const [file, bytes, pattern] of [
	[
		"sub_agents/checker/AGENT.md",
		"---\ndescription: checker\n---\nCheck.",
		/mode/,
	],
	[".codex/hooks.json", '{"hooks":{"Unknown":[]}}', /unsupported event/],
	["scripts/bad.py", Buffer.from([0xff]), /encoded data/],
])
	test(`refuses invalid captured ${file}`, (t) => {
		const f = fixture(t, { resources: { [file]: bytes } });
		assert.throws(
			() =>
				materializeStamp(
					f.args(file.startsWith("sub_agents") ? "opencode" : "codex"),
				),
			pattern,
		);
		assert.deepEqual(readdirSync(f.outputRoot), []);
	});

for (const surface of ["codex", "opencode"])
	test(`${surface}: cap includes triggers and all OpenCode always-on files`, (t) => {
		const cap = surface === "codex" ? 8000 : 24000;
		const f = fixture(t, { profile: "x".repeat(cap) });
		assert.throws(() => materializeStamp(f.args(surface)), /character cap/);
		assert.deepEqual(readdirSync(f.outputRoot), []);
	});

test("Unicode caps count code points rather than UTF-16 code units", (t) => {
	const f = fixture(t, { profile: "😀".repeat(4000) });
	materializeStamp(f.args("codex"));
	assert.equal(f.verify("codex").verified, true);
});

test("OpenCode optional files are absent when the stamp lacks them", (t) => {
	const f = fixture(t);
	materializeStamp(f.args("opencode"));
	assert.deepEqual(
		readdirSync(path.join(f.args("opencode").destination, "content")).sort(),
		["skills", "systemprompt.md"],
	);
});

for (const [label, body] of [
	[
		"late metadata",
		`---\n${"# padding\n".repeat(70)}description: review\n---\nbody`,
	],
	["quoted name", '---\nname: "review"\ndescription: review\n---\nbody'],
	[
		"missing script",
		"---\ndescription: review\n---\npython3 scripts/missing.py",
	],
])
	test(`refuses ${label} before publication`, (t) => {
		const f = fixture(t, { skillText: body });
		assert.throws(
			() => materializeStamp(f.args("opencode")),
			/600 characters|missing script/,
		);
		assert.deepEqual(readdirSync(f.outputRoot), []);
	});

test("conflicting package scripts refuse rather than choosing an owner", (t) => {
	const f = fixture(t, {
		packaged: true,
		companions: { "scripts/summarize.py": "print('package')" },
		resources: { "scripts/summarize.py": "print('resource')" },
	});
	assert.throws(() => materializeStamp(f.args("codex")), /conflicting sources/);
	assert.deepEqual(readdirSync(f.outputRoot), []);
});

test("verification reconstructs generated bytes and rejects altered provenance and destinations", (t) => {
	const f = fixture(t);
	const args = f.args("codex");
	const plan = planMaterialization(f.select("codex"));
	assert.throws(
		() =>
			materialize({
				destination: args.destination,
				outputRoot: f.outputRoot,
				storeRoot: f.storeRoot,
				deniedRoots: [f.root, f.storeRoot],
				plan: { ...plan, files: [] },
			}),
		/plan-mismatch/,
	);
	const receipt = materializeStamp(args);
	assert.throws(() => materializeStamp(args), /destination-exists/);
	put(
		path.join(args.destination, "receipt.json"),
		canonicalJSON({ ...receipt, mappings: receipt.mappings.slice(1) }),
	);
	assert.ok(
		f
			.verify("codex")
			.findings.some((finding) => finding.startsWith("plan-mismatch:")),
	);
	put(path.join(args.destination, "receipt.json"), canonicalJSON(receipt));
	put(path.join(args.destination, "content/AGENTS.md"), "changed");
	assert.equal(f.verify("codex").verified, false);
});

test("CLI exports both surfaces and reports unmapped sources in JSON", (t) => {
	const f = fixture(t);
	for (const surface of ["codex", "opencode"]) {
		const args = f.args(surface);
		const result = spawnSync(
			process.execPath,
			[
				cli,
				"materialize",
				f.stamp.digest,
				"--adapter",
				"harness2-tree",
				"--surface",
				surface,
				"--root",
				f.root,
				"--store",
				f.storeRoot,
				"--output-root",
				f.outputRoot,
				"--destination",
				args.destination,
				"--json",
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).options.surface, surface);
		assert.equal(f.verify(surface).verified, true);
	}
	const textResult = spawnSync(
		process.execPath,
		[
			cli,
			"materialize",
			f.stamp.digest,
			"--adapter",
			"harness2-tree",
			"--surface",
			"codex",
			"--root",
			f.root,
			"--store",
			f.storeRoot,
			"--output-root",
			f.outputRoot,
			"--destination",
			path.join(f.outputRoot, "text"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(textResult.status, 0, textResult.stderr);
	assert.match(textResult.stdout, /Unmapped AGENTS\.md: repository rules/);
	for (const args of [
		["inspect", "--surface", "codex"],
		["materialize", f.stamp.digest, "--adapter", "harness2-tree"],
		[
			"materialize",
			f.stamp.digest,
			"--adapter",
			"filesystem-v1",
			"--surface",
			"codex",
		],
	]) {
		const result = spawnSync(
			process.execPath,
			[cli, ...args, "--root", f.root],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /surface/);
	}
});

test("fixtures for the opt-in upstream validator", (t) => {
	const f = fixture(t, {
		packaged: true,
		companions: {
			"scripts/summarize.py": "raise RuntimeError('must stay inert')\n",
			"sub_agents/checker/AGENT.md":
				"---\nmode: subagent\ndescription: check output\n---\nCheck output.\n",
			"guardrails.md": "Guardrails.\n",
			"LongTermMEMORY.md": "Pinned memory.\n",
			"tool_descriptions/tool_guidance.md": "Tool guidance.\n",
			"plugin/example.ts": "export default async () => ({});\n",
			".codex/hooks.json":
				'{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"echo archived"}]}]}}',
		},
	});
	for (const surface of ["codex", "opencode"]) {
		materializeStamp(f.args(surface));
		if (process.env.HARNESS2_VALIDATION_DIR)
			cpSync(
				path.join(f.args(surface).destination, "content"),
				path.join(process.env.HARNESS2_VALIDATION_DIR, surface),
				{ recursive: true },
			);
	}
});
