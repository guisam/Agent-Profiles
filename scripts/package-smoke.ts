// Exercise the packed artifact in isolation, including its npm-generated executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
// Type-only (erased at runtime): the smoke test exercises the installed package, never src/.
import type { Untyped } from "../src/packages.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(
	path.join(os.tmpdir(), "agent-profiles-package-"),
);
const npm = process.env.npm_execpath;
assert.ok(npm, "Run with npm run test:package");
// Code ships as the dist/ build of src/ and bin/; npm run test:package builds it first.
const built = (file: Untyped) => file.replace(/^(bin|src)\//, "dist/$1/");
const environment = { ...process.env };
for (const key of Object.keys(environment))
	if (/^npm_config_/i.test(key)) delete environment[key];
delete environment.NODE_OPTIONS;
delete environment.AGENT_PROFILES_SKILL_SOURCES;

function run(command: Untyped, args: Untyped, cwd: Untyped, env = environment) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 120000,
	});
	assert.equal(
		result.status,
		0,
		`${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
	);
	return result.stdout;
}

function snapshot(root: string) {
	return fs
		.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const file = path.join(entry.parentPath, entry.name);
			return [
				path.relative(root, file),
				fs.readFileSync(file).toString("base64"),
			];
		})
		.sort(([a], [b]) => a.localeCompare(b));
}

try {
	const home = path.join(temporary, "home");
	fs.mkdirSync(home);
	const userconfig = path.join(temporary, "npm-user.npmrc"),
		globalconfig = path.join(temporary, "npm-global.npmrc");
	fs.writeFileSync(userconfig, "");
	fs.writeFileSync(globalconfig, "");
	Object.assign(environment, {
		HOME: home,
		USERPROFILE: home,
		CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
		CODEX_HOME: path.join(home, ".codex"),
		AGENT_PROFILES_STORE: path.join(home, "unused-store"),
		TMP: temporary,
		TEMP: temporary,
		TMPDIR: temporary,
		npm_config_cache: path.join(temporary, "npm-cache"),
		npm_config_userconfig: userconfig,
		npm_config_globalconfig: globalconfig,
		npm_config_offline: "true",
		npm_config_ignore_scripts: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
	});
	const [artifact] = JSON.parse(
		run(
			process.execPath,
			[
				npm,
				"pack",
				"--offline",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporary,
			],
			project,
		),
	);
	const yamlRoot = path.join(project, "node_modules/yaml");
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(yamlRoot, "package.json"), "utf8"))
			.version,
		"2.9.1",
	);
	const [yamlArtifact] = JSON.parse(
		run(
			process.execPath,
			[
				npm,
				"pack",
				"--offline",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporary,
			],
			yamlRoot,
		),
	);
	assert.equal(yamlArtifact.name, "yaml");
	assert.equal(yamlArtifact.version, "2.9.1");
	const tarballs = [artifact, yamlArtifact].map((packed) =>
		path.join(temporary, packed.filename),
	);
	const manifest = JSON.parse(
		fs.readFileSync(path.join(project, "package.json"), "utf8"),
	);
	assert.equal(artifact.name, "agent-profiles");
	assert.equal(artifact.version, manifest.version);
	const files = new Set<string>(
		artifact.files.map((file: Untyped) => file.path),
	);
	const versionedFiles = [
		"src/resolve.js",
		"bin/agent-profiles.js",
		"README.md",
		"CHANGELOG.md",
		"src/packages.js",
		"src/package-store.js",
		"src/package-lock.js",
		"src/stamps.js",
		"src/materialize.js",
		"src/migrations.js",
		"docs/skill-migrations.md",
		"src/revisions.js",
		"docs/revisions.md",
		"docs/versioned-packages.md",
		"docs/migrations/README.md",
		"docs/migrations/config-v1-to-v2.md",
		"docs/migrations/prompts/config-v1-to-v2.md",
		"docs/migrations/config-v2-to-v3.md",
		"docs/migrations/prompts/config-v2-to-v3.md",
	].map(built);
	for (const file of [
		"LICENSE",
		"README.md",
		"CHANGELOG.md",
		"package.json",
		"bin/agent-profiles.js",
		"src/configure.js",
		"src/files.js",
		"src/integrations.js",
		"src/install.js",
		"src/resolve.js",
		"src/skills.js",
		"src/discovery-diagnostics.js",
		"src/wizard.js",
		"src/inspect.js",
		"docs/setup.md",
		"src/external-skills.js",
		"docs/hosts/external-skill-sources.md",
		".agent-profiles/agents.yaml",
		".agent-profiles/BOOTSTRAP.md",
		"docs/configure.md",
		"src/presets.js",
		"src/preset-wizard.js",
		"src/diagnostics.js",
		"docs/proof.md",
		"src/visualize.js",
		"src/visualizer/index.html",
		"src/visualizer/app.js",
		"src/visualizer/style.css",
		"docs/visualize.md",
		"docs/hosts/hermes.md",
		"examples/presets/release-review/preset.yaml",
		...versionedFiles,
	].map(built))
		assert.ok(files.has(file), `Missing package file: ${file}`);
	for (const file of files) {
		assert.ok(
			/^(dist\/|docs\/|examples\/presets\/|\.agent-profiles\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|CONTRIBUTING\.md$)/.test(
				file,
			),
			`Unexpected package file: ${file}`,
		);
	}
	const consumer = path.join(temporary, "consumer with spaces");
	fs.mkdirSync(consumer);
	fs.writeFileSync(
		path.join(consumer, "package.json"),
		'{"name":"smoke-consumer","private":true}',
	);
	run(
		process.execPath,
		[
			npm,
			"install",
			"--offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--omit=dev",
			"--package-lock=false",
			...tarballs,
		],
		consumer,
	);
	const installed = path.join(consumer, "node_modules/agent-profiles");
	const installedManifest = JSON.parse(
		fs.readFileSync(path.join(installed, "package.json"), "utf8"),
	);
	assert.equal(installedManifest.license, "Apache-2.0");
	assert.equal(installedManifest.version, manifest.version);
	assert.deepEqual(Object.keys(installedManifest.dependencies), ["yaml"]);
	assert.equal(
		JSON.parse(
			fs.readFileSync(
				path.join(consumer, "node_modules/yaml/package.json"),
				"utf8",
			),
		).version,
		"2.9.1",
	);
	for (const file of versionedFiles) {
		let expected = fs.readFileSync(path.join(project, file));
		const firstLF = expected.indexOf(0x0a);
		// npm bin-links removes only the CR ending a CRLF hashbang line.
		if (
			file === "dist/bin/agent-profiles.js" &&
			expected[0] === 0x23 &&
			expected[1] === 0x21 &&
			firstLF > 1 &&
			expected[firstLF - 1] === 0x0d
		) {
			expected = Buffer.concat([
				expected.subarray(0, firstLF - 1),
				expected.subarray(firstLF),
			]);
		}
		assert.deepEqual(
			fs.readFileSync(path.join(installed, file)),
			expected,
			`Installed bytes: ${file}`,
		);
	}
	assert.equal(
		fs.existsSync(path.join(consumer, "node_modules/typescript")),
		false,
	);
	const cli = (...args: string[]) =>
		run(
			process.execPath,
			[npm, "exec", "--offline", "--", "agent-profiles", ...args],
			consumer,
		);
	for (const command of [
		"inspect",
		"init",
		"resolve",
		"configure",
		"skills",
		"doctor",
		"uninstall",
		"visualize",
		"add",
		"install",
		"stamp",
		"verify",
		"diff",
		"materialize",
		"migrate",
		"revision",
	])
		assert.match(cli(command, "--help"), new RegExp(command));
	const { configureRoles } = await import(
		pathToFileURL(path.join(installed, "dist/src/wizard.js")).href
	);
	const { resolveInstructions } = await import(
		pathToFileURL(path.join(installed, "dist/src/resolve.js")).href
	);
	const { planRoleChange, applyRoleChange } = await import(
		pathToFileURL(path.join(installed, "dist/src/configure.js")).href
	);
	const { startVisualizer } = await import(
		pathToFileURL(path.join(installed, "dist/src/visualize.js")).href
	);
	const {
		planPresetExport,
		applyPresetExport,
		planPresetImport,
		applyPresetImport,
	} = await import(
		pathToFileURL(path.join(installed, "dist/src/presets.js")).href
	);
	assert.match(
		cli(
			"preset",
			"inspect",
			path.join(installed, "examples/presets/release-review"),
		),
		/Release Review/,
	);

	for (const scenario of [
		"empty",
		"existing instructions",
		"alternate targets",
	]) {
		const root = path.join(temporary, scenario);
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
		// Like a user, install the package into the target so its bootstrap command can run there.
		run(
			process.execPath,
			[
				npm,
				"install",
				"--save-dev",
				"--offline",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				...tarballs,
			],
			root,
		);
		const originals: Record<string, Buffer> = {
			"package.json": fs.readFileSync(path.join(root, "package.json")),
		};
		if (scenario !== "empty") {
			originals["AGENTS.md"] = Buffer.from(
				"\uFEFF# Repository invariants\r\nPreserve these rules.",
			);
			originals[
				scenario === "alternate targets" ? ".claude/CLAUDE.md" : "CLAUDE.md"
			] = Buffer.from("# Claude rules\nKeep these too.\n");
			originals[scenario === "alternate targets" ? "HERMES.md" : ".hermes.md"] =
				Buffer.from(
					"\uFEFF# Hermes project rules\r\nKeep runtime profiles separate.",
				);
			if (scenario === "alternate targets")
				originals["AGENTS.override.md"] = Buffer.from(
					"# Override\nRespect repository invariants.",
				);
		}
		for (const [file, content] of Object.entries(originals)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), content);
		}
		for (const file of [
			"orchestrator.toml",
			"adr-orchestrator.toml",
			"t3.json",
		])
			fs.writeFileSync(
				path.join(root, file),
				"PRIVATE-WORKFLOW-CONTENT { malformed",
			);
		const broken = path.join(root, ".claude/skills/broken/SKILL.md");
		fs.mkdirSync(path.dirname(broken), { recursive: true });
		fs.writeFileSync(
			broken,
			"---\nname: broken\ndescription: Review\nprivate_token: [PRIVATE-FRONTMATTER-CONTENT\n---\nPRIVATE-BODY",
		);
		const beforeApproval = snapshot(root);
		const inspected = JSON.parse(cli("inspect", "--root", root, "--json"));
		assert.equal(inspected.skills.status, "partial");
		assert.ok(inspected.skills.warnings.length);
		assert.doesNotMatch(
			JSON.stringify(inspected),
			/private_token|PRIVATE-|at line|column/,
		);
		for (const file of [
			"orchestrator.toml",
			"adr-orchestrator.toml",
			"t3.json",
		])
			assert.ok(
				inspected.repository.workflows.some(
					(record: Untyped) =>
						record.path === file && record.availability === "available",
				),
			);
		assert.doesNotMatch(
			cli("inspect", "--root", root),
			/private_token|PRIVATE-|at line|column/,
		);
		assert.equal(inspected.schemaVersion, 1);
		assert.equal(inspected.repository.installation.status, "not-installed");
		assert.equal(inspected.environment.scope, "machine");
		assert.deepEqual(snapshot(root), beforeApproval);
		cli(
			"init",
			"--root",
			root,
			"--agent",
			"claude",
			"--agent",
			"codex",
			"--agent",
			"opencode",
			"--agent",
			"hermes",
		);
		const afterApproval = snapshot(root);
		assert.equal(
			fs
				.readFileSync(path.join(root, "AGENTS.md"), "utf8")
				.split("<!-- agent-profiles:opencode:start -->").length,
			2,
		);
		const configuredInventory = JSON.parse(
			cli("inspect", "--root", root, "--json"),
		);
		assert.equal(configuredInventory.repository.configuration.status, "valid");
		assert.ok(
			configuredInventory.hosts.every(
				(host: Untyped) =>
					host.configured && host.currentInvocation === "unverified",
			),
		);
		assert.deepEqual(snapshot(root), afterApproval);
		const targets =
			scenario === "alternate targets"
				? [".claude/CLAUDE.md", "AGENTS.override.md", "HERMES.md"]
				: ["CLAUDE.md", "AGENTS.md", ".hermes.md"];
		for (const file of targets) {
			const text = fs.readFileSync(path.join(root, file), "utf8");
			assert.equal(text.split("<!-- agent-profiles:start -->").length, 2);
			const host = file.includes("CLAUDE")
				? "claude"
				: /hermes/i.test(file)
					? "hermes"
					: "codex";
			assert.ok(
				text.includes(
					`npx --no agent-profiles resolve --host ${host} --identity-source host-stated --model`,
				),
			);
		}
		// The exact bootstrap command must work from the installed package without downloading anything.
		const context = run(
			process.execPath,
			[
				npm,
				"exec",
				"--no",
				"--offline",
				"--",
				"agent-profiles",
				"resolve",
				"--root",
				root,
				"--host",
				"claude",
				"--model",
				"example-model",
				"--role",
				"reviewer",
			],
			consumer,
		);
		assert.ok(
			context.startsWith("# Agent Profiles context") &&
				context.includes("## Required skill: code-review"),
		);
		const hermesContext = run(
			process.execPath,
			[
				npm,
				"exec",
				"--no",
				"--offline",
				"--",
				"agent-profiles",
				"resolve",
				"--root",
				root,
				"--host",
				"hermes",
				"--model",
				"example-model",
				"--role",
				"reviewer",
				"--json",
				"--contents",
			],
			consumer,
		);
		const hermes = JSON.parse(hermesContext);
		assert.equal(hermes.host, "hermes");
		assert.equal(hermes.profile, "autonomous");
		assert.deepEqual(
			hermes.required.map((skill: Untyped) => skill.id),
			["code-review"],
		);
		assert.ok(
			hermes.loaded.some(
				(entry: Untyped) => entry.kind === "required-skill" && entry.content,
			),
		);
		const initial = snapshot(root);
		cli(
			"init",
			"--root",
			root,
			"--agent",
			"codex",
			"--agent",
			"claude",
			"--agent",
			"opencode",
			"--agent",
			"hermes",
		);
		assert.deepEqual(snapshot(root), initial);
		for (const { model, family, profile, matchedBy } of [
			{
				model: "example-model",
				family: "example-family",
				profile: "autonomous",
				matchedBy: "model",
			},
			{
				model: "unknown",
				family: "example-family",
				profile: "scaffolded",
				matchedBy: "family",
			},
			{ model: "unknown", profile: "constrained", matchedBy: "default" },
		]) {
			const resolved = resolveInstructions({
				root,
				role: "reviewer",
				model,
				family,
			});
			assert.equal(resolved.profile, profile);
			assert.equal(resolved.matchedBy, matchedBy);
			assert.equal(resolved.role, "reviewer");
			assert.ok(
				resolved.loaded.some((item: Untyped) =>
					item.path.endsWith("code-review/SKILL.md"),
				),
			);
			assert.ok(
				!resolved.loaded.some((item: Untyped) =>
					item.path.endsWith("testing/SKILL.md"),
				),
			);
			assert.ok(
				resolved.available.some((item: Untyped) => item.id === "testing"),
			);
		}
		assert.ok(
			resolveInstructions({
				root,
				role: "reviewer",
				skills: ["testing"],
			}).loaded.some((item: Untyped) => item.path.endsWith("testing/SKILL.md")),
		);
		const answers = [
			"c",
			"release-reviewer",
			"Review releases.",
			"",
			"1",
			"",
			"1",
			"",
			"y",
			"q",
		];
		await configureRoles({
			root,
			ask: async () => {
				assert.ok(answers.length);
				return answers.shift();
			},
			write: () => {},
		});
		assert.equal(answers.length, 0);
		const configured = resolveInstructions({ root, role: "release-reviewer" });
		assert.deepEqual(
			configured.required.map((skill: Untyped) => skill.id),
			["code-review"],
		);
		assert.deepEqual(
			configured.available.map((skill: Untyped) => skill.id),
			["testing"],
		);
		for (const file of ["profiles/constrained.md", "roles/release-reviewer.md"])
			fs.appendFileSync(
				path.join(root, ".agent-profiles", file),
				"\nUser customization.\n",
			);
		const customized = snapshot(path.join(root, ".agent-profiles"));
		cli(
			"init",
			"--root",
			root,
			"--agent",
			"claude",
			"--agent",
			"codex",
			"--agent",
			"opencode",
			"--agent",
			"hermes",
		);
		cli("doctor", "--root", root);
		assert.deepEqual(snapshot(path.join(root, ".agent-profiles")), customized);
		cli("uninstall", "--root", root);
		assert.deepEqual(
			snapshot(path.join(root, ".agent-profiles")),
			customized.filter(([file]) => file !== "permissions.json"),
		);
		for (const [file, content] of Object.entries(originals))
			assert.deepEqual(fs.readFileSync(path.join(root, file)), content);
		for (const file of targets)
			assert.ok(
				!fs
					.readFileSync(path.join(root, file), "utf8")
					.includes("<!-- agent-profiles:start -->"),
			);
		const destination = path.join(temporary, `preset ${scenario}`);
		applyPresetExport(
			planPresetExport({
				root,
				destination,
				roles: ["release-reviewer"],
				profiles: [],
				includeSkills: ["code-review", "testing"],
				metadata: {
					name: "smoke",
					display_name: "Smoke",
					description: "Package test",
					author: "Test",
					version: "1",
					license: "Apache-2.0",
				},
			}),
			true,
		);
		assert.match(
			cli("preset", "inspect", destination, "--root", root),
			/Conflict: roles.release-reviewer/,
		);
		const decisions = new Map([
			["roles.release-reviewer", "rename:preset-reviewer"],
			["skills.code-review", "keep"],
			["skills.testing", "keep"],
		]);
		applyPresetImport(
			planPresetImport({ root, source: destination, decisions }),
			true,
		);
		assert.deepEqual(
			resolveInstructions({ root, role: "preset-reviewer" }).required.map(
				(skill: Untyped) => skill.id,
			),
			["code-review"],
		);
		const proof = JSON.parse(
			cli("proof", "--root", root, "--role", "preset-reviewer", "--json"),
		);
		const requested = JSON.parse(
			cli(
				"proof",
				"--root",
				root,
				"--role",
				"preset-reviewer",
				"--skill",
				"testing",
				"--json",
				"--contents",
			),
		);
		assert.equal(
			requested.diagnostics.managed.total.bytes -
				proof.diagnostics.managed.total.bytes,
			proof.diagnostics.availableNotLoaded.bytes,
		);
		assert.equal(requested.diagnostics.availableNotLoaded.files, 0);
		assert.ok(
			proof.loaded.every(
				(entry: Untyped) =>
					!Object.hasOwn(entry, "content") &&
					typeof entry.characters === "number",
			),
		);
		assert.match(
			cli("proof", "--root", root, "--role", "preset-reviewer"),
			/Host context:.*unobserved/,
		);
		const visualizer = await startVisualizer({ root, role: "preset-reviewer" });
		try {
			for (const asset of ["", "app.js", "style.css"])
				assert.equal((await fetch(visualizer.url + asset)).status, 200);
			const visual = await (
				await fetch(
					`${visualizer.url}api/resolve?role=preset-reviewer&skill=testing`,
				)
			).json();
			assert.deepEqual(visual, requested);
		} finally {
			await new Promise((resolve) => {
				visualizer.server.close(resolve);
				visualizer.server.closeAllConnections();
			});
		}
		const externalHome = path.join(temporary, `skill home ${scenario}`);
		const externalFile = path.join(
			externalHome,
			".agents/skills/packaged-audit/SKILL.md",
		);
		fs.mkdirSync(path.dirname(externalFile), { recursive: true });
		fs.writeFileSync(
			externalFile,
			"---\nname: packaged-audit\ndescription: Packed native audit.\n---\nEXTERNAL-BODY-NOT-INJECTED\n",
		);
		const sourcesFile = path.join(externalHome, "sources.json");
		fs.writeFileSync(sourcesFile, JSON.stringify({ version: 1, roots: [] }));
		const externalEnv = {
			...environment,
			USERPROFILE: externalHome,
			HOME: externalHome,
			CLAUDE_CONFIG_DIR: path.join(externalHome, ".claude"),
			CODEX_HOME: path.join(externalHome, ".codex"),
			AGENT_PROFILES_SKILL_SOURCES: sourcesFile,
		};
		const beforeInventory = snapshot(root);
		const inventory = JSON.parse(
			run(
				process.execPath,
				[
					npm,
					"exec",
					"--offline",
					"--",
					"agent-profiles",
					"skills",
					"--root",
					root,
					"--external",
					"--sources",
					sourcesFile,
					"--json",
				],
				consumer,
				externalEnv,
			),
		);
		const setupInventory = JSON.parse(
			run(
				process.execPath,
				[
					npm,
					"exec",
					"--offline",
					"--",
					"agent-profiles",
					"inspect",
					"--root",
					root,
					"--sources",
					sourcesFile,
					"--json",
				],
				consumer,
				externalEnv,
			),
		);
		assert.ok(
			setupInventory.skills.skills.some(
				(skill: Untyped) =>
					skill.host === "codex" && skill.hostId === "packaged-audit",
			),
		);
		assert.ok(
			!JSON.stringify(setupInventory).includes("EXTERNAL-BODY-NOT-INJECTED"),
		);
		const native = inventory.skills.find(
			(skill: Untyped) =>
				skill.host === "codex" && skill.hostId === "packaged-audit",
		);
		assert.ok(
			native,
			"Packed executable must discover native external metadata",
		);
		assert.ok(
			!JSON.stringify(inventory).includes("EXTERNAL-BODY-NOT-INJECTED"),
		);
		assert.deepEqual(snapshot(root), beforeInventory);
		const sourceOptions = { home: externalHome, env: externalEnv, sourcesFile };
		applyRoleChange(
			planRoleChange({
				root,
				action: "create",
				id: "external-qa",
				available: [native],
				sourceOptions,
			}),
		);
		const nativeResolution = resolveInstructions({
			root,
			role: "external-qa",
			host: "codex",
		});
		assert.equal(nativeResolution.available[0].hostId, "packaged-audit");
		assert.equal(nativeResolution.available[0].bytes, null);
		assert.ok(
			!fs
				.readFileSync(path.join(root, ".agent-profiles/agents.yaml"), "utf8")
				.includes(externalHome),
		);
		assert.ok(
			!JSON.stringify(nativeResolution).includes("EXTERNAL-BODY-NOT-INJECTED"),
		);
		const portablePath = ".agents/skills/portable-check/SKILL.md";
		const portableBody =
			"---\nname: portable-check\ndescription: Portable evidence review.\n---\nPreserve the supplied evidence.\n";
		fs.mkdirSync(path.dirname(path.join(root, portablePath)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, portablePath), portableBody);
		const configPath = path.join(root, ".agent-profiles/agents.yaml");
		const portableConfig = parse(fs.readFileSync(configPath, "utf8"));
		portableConfig.skills ??= {};
		portableConfig.skills["portable-check"] = { file: portablePath };
		portableConfig.roles["portable-check"] = {
			file: "roles/portable-check.md",
			skills: { required: ["portable-check"], available: [] },
		};
		fs.writeFileSync(
			path.join(root, ".agent-profiles/roles/portable-check.md"),
			"# Portable check\nReview evidence without changing authority.\n",
		);
		fs.writeFileSync(configPath, stringify(portableConfig));
		const portableConfiguration = fs.readFileSync(configPath);
		cli(
			"init",
			"--root",
			root,
			"--agent",
			"claude",
			"--agent",
			"codex",
			"--agent",
			"opencode",
			"--agent",
			"hermes",
		);
		const portableInstalled = snapshot(root);
		cli("doctor", "--root", root);
		for (const host of ["claude", "codex", "opencode", "hermes"]) {
			const routed = JSON.parse(
				cli(
					"resolve",
					"--root",
					root,
					"--host",
					host,
					"--role",
					"portable-check",
					"--json",
					"--contents",
				),
			);
			assert.deepEqual(
				routed.required.map((skill: Untyped) => skill.id),
				["portable-check"],
			);
			assert.equal(
				routed.loaded.find((entry: Untyped) => entry.kind === "required-skill")
					.content,
				portableBody,
			);
		}
		cli(
			"init",
			"--root",
			root,
			"--agent",
			"claude",
			"--agent",
			"codex",
			"--agent",
			"opencode",
			"--agent",
			"hermes",
		);
		assert.deepEqual(snapshot(root), portableInstalled);
		assert.deepEqual(fs.readFileSync(configPath), portableConfiguration);
		console.log(
			`Packed workflow passed: ${scenario} (including pre/post-approval inspect, presets, proof, visualizer, external inventory, and portable instruction mappings)`,
		);
	}
	// One package workflow, separate from the three unchanged legacy scenarios.
	{
		const root = path.join(temporary, "versioned project"),
			store = path.join(temporary, "package store");
		const sources = path.join(temporary, "package sources"),
			outputs = path.join(temporary, "package exports");
		const put = (file: Untyped, bytes: Untyped) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, bytes);
		};
		fs.mkdirSync(root);
		fs.mkdirSync(outputs);
		const name = "@example/smoke-profile",
			role = Buffer.from("# Reviewer\r\nKeep exact evidence.\r\n");
		const revisions = ["1.0.0", "2.0.0"].map((version, i) => {
			const directory = path.join(sources, version);
			const members = {
				"entry.md": Buffer.from(
					`\uFEFF# Profile ${version}\r\nRevision ${i + 1}.\r\n\r\n `,
				),
				"package.yaml": Buffer.from(
					stringify({
						schema_version: 1,
						package: { name, version, type: "instruction" },
						entrypoint: "entry.md",
						behavior: { delivery: "instruction", hosts: [], effects: [] },
					}),
				),
				"support/data.bin": Buffer.from([0, 255, i + 1, 13, 10]),
			};
			for (const [file, bytes] of Object.entries(members))
				put(path.join(directory, file), bytes);
			const added = JSON.parse(
				cli(
					"add",
					`${name}@${version}`,
					"--root",
					root,
					"--source",
					directory,
					"--store",
					store,
					"--json",
				),
			);
			assert.deepEqual(added.identity, { name, version });
			assert.equal(added.status, "published");
			assert.match(added.sha256, /^[a-f0-9]{64}$/);
			const original = snapshot(directory);
			assert.deepEqual(
				snapshot(path.join(store, "objects/sha256", added.sha256, "tree")),
				original,
			);
			return {
				version,
				directory,
				members,
				original,
				digest: added.sha256,
				stamp: "",
			};
		});
		assert.notEqual(revisions[0].digest, revisions[1].digest);
		const configFile = path.join(root, ".agent-profiles/agents.yaml");
		const config = {
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: {},
			families: {},
			profiles: { base: { package: name, version: "1.0.0" } },
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
			skills: {},
		};
		put(path.join(root, ".agent-profiles/roles/reviewer.md"), role);
		for (const revision of revisions) {
			config.profiles.base.version = revision.version;
			put(configFile, stringify(config));
			assert.deepEqual(
				JSON.parse(
					cli(
						"install",
						"--root",
						root,
						"--store",
						store,
						"--offline",
						"--json",
					),
				),
				{ lockState: "valid", installRequired: false },
			);
			const selected = JSON.parse(
				cli(
					"resolve",
					"--root",
					root,
					"--store",
					store,
					"--host",
					"codex",
					"--json",
					"--contents",
				),
			);
			assert.equal(selected.lockState, "valid");
			assert.equal(selected.profile, "base");
			assert.equal(selected.role, "reviewer");
			assert.deepEqual(
				selected.loaded.map((e: Untyped) => e.kind),
				["profile", "role"],
			);
			assert.deepEqual(selected.loaded[0].package, {
				binding: "profiles.base",
				name,
				version: revision.version,
				sha256: revision.digest,
				selectedBy: "binding-default",
				selectors: {},
			});
			assert.equal(
				selected.loaded[0].content,
				revision.members["entry.md"].toString("utf8"),
			);
			revision.stamp = JSON.parse(
				cli(
					"stamp",
					"--root",
					root,
					"--store",
					store,
					"--host",
					"codex",
					"--json",
				),
			).digest;
			assert.match(revision.stamp, /^[a-f0-9]{64}$/);
			const verified = JSON.parse(
				cli("verify", revision.stamp, "--store", store, "--json"),
			);
			assert.equal(verified.managedReproducible, true);
			assert.equal(verified.completeRuntimeReproducible, false);
		}
		assert.notEqual(revisions[0].stamp, revisions[1].stamp);
		const legacySelection = JSON.parse(
			cli(
				"resolve",
				"--root",
				root,
				"--store",
				store,
				"--host",
				"codex",
				"--json",
				"--contents",
			),
		);
		const projectBeforeAdoption = snapshot(root),
			sourcesBeforeAdoption = snapshot(sources);
		const adoptionFile = path.join(temporary, "legacy-release-metadata.json");
		const adoptedIdentity = { name, version: revisions[1].version };
		const adoption = {
			revisionVersion: 1,
			identity: adoptedIdentity,
			kind: "release",
			content: { identity: adoptedIdentity, sha256: revisions[1].digest },
			parent: null,
			candidate: null,
			dependencies: [],
			workflow: null,
			provenance: {
				kind: "legacy-adoption",
				workflowChange: {
					kind: "initial",
					reason: "Record unknown workflow; no new evaluation is claimed.",
				},
			},
		};
		put(adoptionFile, JSON.stringify(adoption));
		const adopted = JSON.parse(
			cli(
				"revision",
				"record",
				adoptionFile,
				"--root",
				root,
				"--store",
				store,
				"--json",
			),
		);
		const { hashRecord, canonicalJSON, readPackage } = await import(
			pathToFileURL(path.join(installed, "dist/src/packages.js")).href
		);
		const { lookupRevisionManifest } = await import(
			pathToFileURL(path.join(installed, "dist/src/revisions.js")).href
		);
		assert.deepEqual(adopted, {
			identity: adoptedIdentity,
			sha256: revisions[1].digest,
			recordDigest: hashRecord("agent-profiles/revision/v1", adoption),
			status: "published",
		});
		assert.deepEqual(
			lookupRevisionManifest({
				storeRoot: store,
				recordDigest: adopted.recordDigest,
			}),
			adoption,
		);
		const adoptedStore = snapshot(store);
		assert.deepEqual(
			JSON.parse(
				cli(
					"revision",
					"record",
					adoptionFile,
					"--root",
					root,
					"--store",
					store,
					"--json",
				),
			),
			{ ...adopted, status: "reused" },
		);
		const adoptionText = cli(
			"revision",
			"record",
			adoptionFile,
			"--root",
			root,
			"--store",
			store,
		);
		assert.match(adoptionText, /Revision metadata recorded/);
		assert.ok(adoptionText.includes(adopted.recordDigest));
		assert.deepEqual(
			snapshot(store),
			adoptedStore,
			"metadata replay verifies without writes",
		);
		assert.deepEqual(
			snapshot(root),
			projectBeforeAdoption,
			"metadata adoption preserves active configuration and lock",
		);
		assert.deepEqual(snapshot(sources), sourcesBeforeAdoption);
		for (const revision of revisions)
			assert.deepEqual(
				snapshot(path.join(store, "objects/sha256", revision.digest, "tree")),
				revision.original,
			);
		assert.deepEqual(
			JSON.parse(
				cli(
					"resolve",
					"--root",
					root,
					"--store",
					store,
					"--host",
					"codex",
					"--json",
					"--contents",
				),
			),
			legacySelection,
		);
		const diff = JSON.parse(
			cli(
				"diff",
				revisions[0].stamp,
				revisions[1].stamp,
				"--store",
				store,
				"--json",
			),
		);
		assert.equal(diff.complete, true);
		assert.ok(diff.changes.length > 0);
		assert.deepEqual(
			diff.changes.find(
				(change: Untyped) => change.path === "/packages/0/version",
			),
			{
				path: "/packages/0/version",
				kind: "changed",
				before: "1.0.0",
				after: "2.0.0",
			},
		);
		assert.deepEqual(
			diff.changes.find(
				(change: Untyped) => change.path === "/packages/0/sha256",
			),
			{
				path: "/packages/0/sha256",
				kind: "changed",
				before: revisions[0].digest,
				after: revisions[1].digest,
			},
		);

		const workflowRoot = path.join(temporary, "workflow project"),
			workflowSource = path.join(sources, "workflow");
		const workerName = "@example/smoke-worker",
			workerVersion = "1.0.0";
		const taskBytes = Buffer.from(
			"---\nname: smoke-worker\ndescription: Review evidence\n---\n# Worker\r\n",
		);
		const workflowBytes = Buffer.from(
			"# Check in\r\nRetain exact evidence.  \r\n",
		);
		put(
			path.join(workflowSource, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: workerName, version: workerVersion, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects: [] },
			}),
		);
		put(path.join(workflowSource, "SKILL.md"), taskBytes);
		put(path.join(workflowSource, "WORKFLOW.md"), workflowBytes);
		fs.mkdirSync(workflowRoot);
		const worker = JSON.parse(
			cli(
				"add",
				`${workerName}@${workerVersion}`,
				"--root",
				workflowRoot,
				"--source",
				workflowSource,
				"--store",
				store,
				"--json",
			),
		);
		const workerRecord = {
			...adoption,
			identity: worker.identity,
			content: { identity: worker.identity, sha256: worker.sha256 },
			workflow: {
				file: "WORKFLOW.md",
				provides: [{ protocol: "@example/agent-checkin", major: 1 }],
				requires: [],
			},
		};
		put(adoptionFile, JSON.stringify(workerRecord));
		const workerRevision = JSON.parse(
			cli(
				"revision",
				"record",
				adoptionFile,
				"--root",
				workflowRoot,
				"--store",
				store,
				"--json",
			),
		);
		put(
			path.join(workflowRoot, ".agent-profiles/profiles/base.md"),
			"# Base\n",
		);
		put(path.join(workflowRoot, ".agent-profiles/roles/reviewer.md"), role);
		const workflowConfig = {
			version: 3,
			default_profile: "base",
			default_role: "reviewer",
			models: { opus: { profile: "base" } },
			families: {},
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: ["worker"], available: [] },
				},
			},
			skills: {
				worker: {
					package: workerName,
					version: workerVersion,
					revision: workerRevision.recordDigest,
				},
			},
		};
		put(
			path.join(workflowRoot, ".agent-profiles/agents.yaml"),
			stringify(workflowConfig),
		);
		const workflowBefore = snapshot(workflowRoot),
			workflowStoreBefore = snapshot(store);
		cli(
			"install",
			"--root",
			workflowRoot,
			"--store",
			store,
			"--offline",
			"--json",
		);
		const workflowLock = JSON.parse(
			fs.readFileSync(
				path.join(workflowRoot, ".agent-profiles/agent-profiles.lock"),
				"utf8",
			),
		);
		assert.equal(workflowLock.lockVersion, 2);
		assert.equal(workflowLock.configurationVersion, 3);
		assert.equal(
			workflowLock.pins[0].revisionDigest,
			workerRevision.recordDigest,
		);
		const workflowArgs = [
			"--root",
			workflowRoot,
			"--store",
			store,
			"--host",
			"codex",
			"--model",
			"opus",
			"--role",
			"reviewer",
		];
		const workflowSelected = JSON.parse(
			cli("resolve", ...workflowArgs, "--json", "--contents"),
		);
		assert.deepEqual(
			workflowSelected.loaded.map((part: Untyped) => part.kind),
			["profile", "role", "required-skill", "workflow"],
		);
		assert.equal(
			workflowSelected.loaded[2].content,
			taskBytes.toString("utf8"),
		);
		assert.equal(
			workflowSelected.loaded[2].package.revisionDigest,
			workerRevision.recordDigest,
		);
		assert.deepEqual(workflowSelected.loaded[3].backing, {
			type: "package",
			sha256: worker.sha256,
			path: "WORKFLOW.md",
		});
		assert.equal(
			workflowSelected.loaded[3].content,
			workflowBytes.toString("utf8"),
		);
		assert.ok(
			cli("resolve", ...workflowArgs).includes(workflowBytes.toString("utf8")),
		);
		assert.ok(cli("proof", ...workflowArgs).includes("WORKFLOW.md"));
		assert.equal(
			JSON.parse(cli("proof", ...workflowArgs, "--json")).diagnostics.managed
				.total.files,
			4,
		);
		assert.deepEqual(
			snapshot(workflowRoot).filter(
				([file]) =>
					file.split(path.sep).join("/") !==
					".agent-profiles/agent-profiles.lock",
			),
			workflowBefore,
		);
		assert.deepEqual(snapshot(store), workflowStoreBefore);
		const workflowStamp = JSON.parse(cli("stamp", ...workflowArgs, "--json"));
		assert.equal(workflowStamp.snapshot.stampVersion, 2);
		assert.equal(workflowStamp.snapshot.configurationVersion, 3);
		assert.deepEqual(workflowStamp.snapshot.capture, {
			kind: "active",
			migration: null,
			candidate: null,
		});
		assert.equal(
			workflowStamp.snapshot.selectionBindings[0].root.revisionDigest,
			workerRevision.recordDigest,
		);
		assert.equal(
			workflowStamp.snapshot.revisions[0].recordDigest,
			workerRevision.recordDigest,
		);
		assert.deepEqual(workflowStamp.snapshot.workflowPeers, []);
		const workflowVerification = JSON.parse(
			cli("verify", workflowStamp.digest, "--store", store, "--json"),
		);
		assert.equal(workflowVerification.managedReproducible, true);
		assert.equal(workflowVerification.completeRuntimeReproducible, false);
		const workflowDestination = path.join(outputs, "workflow-snapshot");
		const workflowReceipt = JSON.parse(
			cli(
				"materialize",
				workflowStamp.digest,
				"--root",
				workflowRoot,
				"--store",
				store,
				"--adapter",
				"filesystem-v1",
				"--output-root",
				outputs,
				"--destination",
				workflowDestination,
				"--json",
			),
		);
		assert.equal(workflowReceipt.status, "committed");
		const workflowMaterializer = await import(
			pathToFileURL(path.join(installed, "dist/src/materialize.js")).href
		);
		const workflowPlan = workflowMaterializer.planMaterialization({
			stampDigest: workflowStamp.digest,
			storeRoot: store,
			adapterId: "filesystem-v1",
			adapterContractVersion: 1,
		});
		const workflowMapping = workflowPlan.mappings.find(
			(row: Untyped) =>
				row.sourcePath === "WORKFLOW.md" &&
				row.outputPath.startsWith("content/instructions/"),
		);
		assert.ok(workflowMapping);
		assert.deepEqual(
			fs.readFileSync(
				path.join(workflowDestination, workflowMapping.outputPath),
			),
			workflowBytes,
		);
		assert.deepEqual(
			fs.readFileSync(
				path.join(
					workflowDestination,
					"content/revisions/sha256",
					`${workerRevision.recordDigest}.json`,
				),
			),
			canonicalJSON(workerRecord),
		);
		assert.ok(
			workflowPlan.mappings.some(
				(row: Untyped) =>
					row.sourceKind === "revision" &&
					row.sourceDigest === workerRevision.recordDigest &&
					row.sourcePath === "record.json" &&
					row.packageDigest === null,
			),
		);
		assert.deepEqual(
			workflowMaterializer.verifyMaterialization({
				destination: workflowDestination,
				expectedStampDigest: workflowStamp.digest,
				storeRoot: store,
			}),
			{ verified: true, findings: [] },
		);
		assert.deepEqual(
			fs.readFileSync(
				path.join(store, "objects/sha256", worker.sha256, "tree/SKILL.md"),
			),
			taskBytes,
		);
		assert.deepEqual(
			fs.readFileSync(path.join(workflowRoot, ".agent-profiles/agents.yaml")),
			Buffer.from(stringify(workflowConfig)),
		);

		// Native config3 authoring: start directly from the valid config3 project and lock2; nothing is converted.
		const candidateRoot = path.join(temporary, "candidate project");
		fs.cpSync(workflowRoot, candidateRoot, { recursive: true });
		const candidateArgs = ["--root", candidateRoot, "--store", store];
		const candidateScope = [
			...candidateArgs,
			"--role",
			"reviewer",
			"--model",
			"opus",
			"--host",
			"codex",
		];
		const nativeProject = snapshot(candidateRoot),
			nativeStore = snapshot(store),
			nativeSelection = cli(
				"resolve",
				...candidateScope,
				"--json",
				"--contents",
			);
		const candidateMigration = JSON.parse(
			cli("migrate", "start", ...candidateScope, "--sharing", "fork", "--json"),
		);
		const candidateTree = path.join(
			candidateRoot,
			candidateMigration.workspace,
			"packages",
			worker.sha256,
		);
		const owned = `.agent-profiles/migrations/${candidateMigration.id}/`;
		assert.equal(candidateMigration.workspace, `${owned}workspace`);
		assert.ok(
			snapshot(candidateRoot).some(
				([file]) => file.split(path.sep).join("/") === `${owned}record.json`,
			),
		);
		assert.deepEqual(
			snapshot(candidateRoot).filter(
				([file]) => !file.split(path.sep).join("/").startsWith(owned),
			),
			nativeProject,
			"native start keeps active config, lock and project files",
		);
		assert.equal(
			cli("resolve", ...candidateScope, "--json", "--contents"),
			nativeSelection,
		);
		const nativeStoreAfter = new Map(),
			nativeStoreBefore = new Map();
		for (const [file, bytes] of snapshot(store))
			nativeStoreAfter.set(file, bytes);
		for (const [file, bytes] of nativeStore) nativeStoreBefore.set(file, bytes);
		for (const [file, bytes] of nativeStoreBefore)
			assert.equal(
				nativeStoreAfter.get(file),
				bytes,
				`native start preserves store file ${file}`,
			);
		for (const file of nativeStoreAfter.keys())
			assert.ok(
				nativeStoreBefore.has(file) ||
					/^(stamps|blobs)(\/|$)/.test(file.split(path.sep).join("/")),
				`native start adds only immutable backing: ${file}`,
			);
		const nativeBase = JSON.parse(
			fs.readFileSync(
				path.join(
					store,
					"stamps/sha256",
					candidateMigration.bases[0].stamp,
					"snapshot.json",
				),
				"utf8",
			),
		);
		assert.equal(nativeBase.stampVersion, 2);
		assert.equal(nativeBase.configurationVersion, 3);
		assert.deepEqual(
			nativeBase.capture,
			{ kind: "active", migration: null, candidate: null },
			"config3 authoring base is an active stamp2",
		);
		assert.equal(
			nativeBase.selectionBindings[0].root.revisionDigest,
			workerRevision.recordDigest,
		);
		assert.equal(
			JSON.parse(
				cli(
					"verify",
					candidateMigration.bases[0].stamp,
					"--store",
					store,
					"--json",
				),
			).managedReproducible,
			true,
		);
		assert.deepEqual(
			fs.readFileSync(path.join(candidateTree, "SKILL.md")),
			taskBytes,
		);
		assert.deepEqual(
			fs.readFileSync(path.join(candidateTree, "WORKFLOW.md")),
			workflowBytes,
		);
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"status",
					candidateMigration.id,
					"--root",
					candidateRoot,
					"--json",
				),
			),
			{
				...candidateMigration,
				dirty: true,
				workspaceChanged: false,
				changes: [],
			},
		);
		const candidateAfter = `${taskBytes.toString("utf8")}Check stale evidence before reporting.\r\n`;
		const candidateProposalFile = path.join(
			temporary,
			"candidate-proposal.json",
		);
		put(
			candidateProposalFile,
			JSON.stringify({
				proposalVersion: 1,
				classification: "package",
				target: { path: `packages/${worker.sha256}/SKILL.md` },
				change: { before: taskBytes.toString("utf8"), after: candidateAfter },
				evidence: [
					{
						sessionId: "caller-claimed-candidate-smoke",
						excerpt: "A stale-evidence check was omitted.",
						baseStamp: candidateMigration.bases[0].stamp,
					},
				],
			}),
		);
		const candidateProposal = JSON.parse(
			cli(
				"migrate",
				"propose",
				candidateMigration.id,
				candidateProposalFile,
				...candidateArgs,
				"--json",
			),
		);
		const candidateAccepted = JSON.parse(
			cli(
				"migrate",
				"accept",
				candidateMigration.id,
				candidateProposal.id,
				...candidateArgs,
				"--json",
			),
		);
		const candidateBase = JSON.parse(cli("stamp", ...candidateScope, "--json"));
		assert.equal(
			candidateBase.digest,
			candidateMigration.bases[0].stamp,
			"unchanged active inputs give the same active evaluation base",
		);
		const candidateLock = JSON.parse(
			fs.readFileSync(
				path.join(candidateRoot, ".agent-profiles/agent-profiles.lock"),
				"utf8",
			),
		);
		const candidateManifestFile = path.join(temporary, "candidate.json");
		put(
			candidateManifestFile,
			JSON.stringify({
				candidateVersion: 1,
				id: "smoke-candidate",
				binding: "skills.worker",
				release: { name: workerName, version: "2.0.0" },
				migrationBase: candidateMigration.bases[0].stamp,
				evaluationBase: candidateBase.digest,
				configSha256: candidateLock.configSha256,
				expectedTreeSha256: readPackage({ root: candidateTree }).sha256,
				proposalIds: [candidateAccepted.id],
				workflowChange: {
					kind: "task-only",
					reason:
						"Retain the accepted task check without changing the workflow.",
				},
			}),
		);
		const candidateBefore = snapshot(candidateRoot),
			candidateActive = cli(
				"resolve",
				...candidateScope,
				"--json",
				"--contents",
			);
		const candidateResult = JSON.parse(
			cli(
				"migrate",
				"candidate",
				candidateMigration.id,
				candidateManifestFile,
				...candidateArgs,
				"--json",
			),
		);
		assert.equal(candidateResult.status, "published");
		assert.equal(candidateResult.content.identity.version, workerVersion);
		assert.equal(candidateResult.release.version, "2.0.0");
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"candidate",
					candidateMigration.id,
					candidateManifestFile,
					...candidateArgs,
					"--json",
				),
			),
			{ ...candidateResult, status: "reused" },
		);
		assert.ok(
			cli(
				"migrate",
				"candidate",
				candidateMigration.id,
				candidateManifestFile,
				...candidateArgs,
			).includes("smoke-candidate"),
		);
		assert.equal(
			JSON.parse(
				cli("verify", candidateResult.stampDigest, "--store", store, "--json"),
			).managedReproducible,
			true,
		);
		const { migrationCandidate } = await import(
			pathToFileURL(path.join(installed, "dist/src/migrations.js")).href
		);
		const { readRevisionRecord } = await import(
			pathToFileURL(path.join(installed, "dist/src/revisions.js")).href
		);
		const { reconstructStamp: reconstructCandidate } = await import(
			pathToFileURL(path.join(installed, "dist/src/stamps.js")).href
		);
		const { lookupPackage } = await import(
			pathToFileURL(path.join(installed, "dist/src/package-store.js")).href
		);
		const { status: candidateStatus, ...candidateIndex } = candidateResult;
		assert.equal(candidateStatus, "published");
		assert.deepEqual(
			migrationCandidate({ storeRoot: store, id: candidateResult.id }),
			candidateIndex,
		);
		const candidateMetadata = readRevisionRecord({
			storeRoot: store,
			recordDigest: candidateResult.revisionDigest,
		});
		assert.deepEqual(candidateMetadata.provenance.proposals, [
			candidateAccepted,
		]);
		assert.deepEqual(candidateMetadata.workflow, workerRecord.workflow);
		assert.deepEqual(
			fs.readFileSync(
				path.join(
					store,
					"revisions/sha256",
					`${candidateResult.revisionDigest}.json`,
				),
			),
			canonicalJSON(candidateMetadata),
		);
		const candidateRebuilt = reconstructCandidate({
			storeRoot: store,
			digest: candidateResult.stampDigest,
		});
		assert.deepEqual(candidateRebuilt.capture, {
			kind: "candidate",
			migration: candidateMigration.id,
			candidate: candidateResult.revisionDigest,
		});
		assert.deepEqual(
			candidateRebuilt.composition.find(
				(part: Untyped) => part.kind === "required-skill",
			).bytes,
			Buffer.from(candidateAfter),
		);
		assert.deepEqual(
			candidateRebuilt.composition.find(
				(part: Untyped) => part.kind === "workflow",
			).bytes,
			workflowBytes,
		);
		assert.equal(
			lookupPackage({ storeRoot: store, name: workerName, version: "2.0.0" }),
			null,
		);
		assert.equal(
			cli("resolve", ...candidateScope, "--json", "--contents"),
			candidateActive,
		);
		assert.deepEqual(snapshot(candidateRoot), candidateBefore);
		assert.deepEqual(
			fs.readFileSync(
				path.join(store, "objects/sha256", worker.sha256, "tree/SKILL.md"),
			),
			taskBytes,
		);
		// Retain caller-supplied paired claims through the installed CLI; no evaluator runs.
		const { canonicalEvaluationJSON, hashEvaluationRecord } = await import(
			pathToFileURL(path.join(installed, "dist/src/packages.js")).href
		);
		const { migrationEvaluationPlan, migrationEvaluationReport } = await import(
			pathToFileURL(path.join(installed, "dist/src/migrations.js")).href
		);
		const evaluationSelection = candidateBase.snapshot.selection;
		const evaluationAssignment = {
			role: evaluationSelection.role,
			model: evaluationSelection.identity.canonical,
			host: evaluationSelection.host,
		};
		const evaluationPlan = {
			planVersion: 1,
			id: "smoke-paired-plan",
			candidateId: candidateResult.id,
			candidateRevisionDigest: candidateResult.revisionDigest,
			baseStamp: candidateBase.digest,
			candidateStamp: candidateResult.stampDigest,
			context: {
				assignment: evaluationAssignment,
				requestedSkills: candidateBase.snapshot.requested,
				workflowPeers: {
					base: candidateBase.snapshot.workflowPeers,
					candidate: candidateRebuilt.workflowPeers,
				},
			},
			cases: ["motivating", "regression"].map((kind) => ({
				id: kind,
				kind,
				input: `Fictional ${kind} input`,
				expected: "Preserve exact evidence",
				target: {
					assignment: evaluationAssignment,
					binding: "skills.worker",
					member: workerName,
					protocol: null,
				},
			})),
			trials: 1,
			conditions: {
				harness: {
					id: "offline-fixture",
					version: "1",
					settings: { temperature: 0.5 },
				},
				judge: { id: "caller-claim", version: "1", settings: {} },
				rubric: {
					id: "literal-fixture",
					version: "1",
					settings: { offset: -0.125 },
				},
			},
		};
		const evaluationPlanFile = path.join(temporary, "paired-plan.json"),
			evaluationResultFile = path.join(temporary, "paired-results.json");
		put(evaluationPlanFile, JSON.stringify(evaluationPlan));
		const planned = JSON.parse(
			cli(
				"migrate",
				"plan",
				candidateResult.id,
				evaluationPlanFile,
				...candidateArgs,
				"--json",
			),
		);
		assert.deepEqual(planned, {
			id: evaluationPlan.id,
			planDigest: hashEvaluationRecord(
				"agent-profiles/evaluation-plan/v1",
				evaluationPlan,
			),
			status: "published",
		});
		assert.deepEqual(
			migrationEvaluationPlan({ storeRoot: store, id: evaluationPlan.id }),
			{ planDigest: planned.planDigest, plan: evaluationPlan },
		);
		const evaluationResults = {
			resultVersion: 1,
			id: "smoke-paired-results",
			planDigest: planned.planDigest,
			candidateRevisionDigest: candidateResult.revisionDigest,
			conditions: {
				base: evaluationPlan.conditions,
				candidate: evaluationPlan.conditions,
			},
			outcomes: evaluationPlan.cases.flatMap((item) =>
				["base", "candidate"].map((side) => ({
					caseId: item.id,
					trial: 1,
					side,
					stampDigest:
						side === "base"
							? candidateBase.digest
							: candidateResult.stampDigest,
					assignment: evaluationAssignment,
					correct: true,
					metrics:
						side === "base"
							? {
									costUsd: 2.25,
									tokens: 100,
									turns: 4,
									toolCalls: 3,
									latencyMs: 10,
								}
							: {
									costUsd: 1.25,
									tokens: 80,
									turns: 3,
									toolCalls: 2,
									latencyMs: 8,
								},
					evidenceRef: `opaque:fictional-caller/${item.id}/${side}`,
				})),
			),
		};
		put(evaluationResultFile, JSON.stringify(evaluationResults));
		const importedResults = JSON.parse(
			cli(
				"migrate",
				"results",
				evaluationPlan.id,
				evaluationResultFile,
				...candidateArgs,
				"--json",
			),
		);
		assert.deepEqual(importedResults, {
			id: evaluationResults.id,
			planDigest: planned.planDigest,
			resultDigest: hashEvaluationRecord(
				"agent-profiles/evaluation-result/v1",
				evaluationResults,
			),
			status: "published",
		});
		assert.deepEqual(
			fs.readFileSync(
				path.join(
					store,
					"evaluations/results/sha256",
					`${importedResults.resultDigest}.json`,
				),
			),
			canonicalEvaluationJSON(evaluationResults),
		);
		const pairedReport = JSON.parse(
			cli(
				"migrate",
				"report",
				evaluationResults.id,
				"--store",
				store,
				"--json",
			),
		);
		assert.deepEqual(
			pairedReport,
			migrationEvaluationReport({ storeRoot: store, id: evaluationResults.id }),
		);
		assert.deepEqual(pairedReport.context, evaluationPlan.context);
		assert.deepEqual(pairedReport.evidence, {
			integrity: "verified",
			workflow: "declared-compatible",
			correctness: "external-claim",
			runtime: "unverified",
			promotion: "not-authorized",
		});
		assert.deepEqual(pairedReport.eligibility, {
			status: "eligible",
			regressions: [],
		});
		assert.equal(pairedReport.metrics.costUsd.delta, -2);
		assert.equal(pairedReport.metrics.tokens.delta, -40);
		assert.ok(
			cli("migrate", "report", evaluationResults.id, "--store", store).includes(
				evaluationResults.id,
			),
		);
		const evidenceBeforeReuse = snapshot(store);
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"plan",
					candidateResult.id,
					evaluationPlanFile,
					...candidateArgs,
					"--json",
				),
			),
			{ ...planned, status: "reused" },
		);
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"results",
					evaluationPlan.id,
					evaluationResultFile,
					...candidateArgs,
					"--json",
				),
			),
			{ ...importedResults, status: "reused" },
		);
		assert.deepEqual(snapshot(store), evidenceBeforeReuse);
		assert.deepEqual(snapshot(candidateRoot), candidateBefore);
		assert.equal(
			cli("resolve", ...candidateScope, "--json", "--contents"),
			candidateActive,
		);
		// Explicit synthetic promotion of the exact evaluated tuple; preview and blocked correctness never write.
		const { migrationPromotion } = await import(
			pathToFileURL(path.join(installed, "dist/src/migrations.js")).href
		);
		const refusal = (...args: string[]) =>
			spawnSync(
				process.execPath,
				[npm, "exec", "--offline", "--", "agent-profiles", ...args],
				{ cwd: consumer, env: environment, encoding: "utf8", timeout: 120000 },
			);
		const blockedResults = {
			...structuredClone(evaluationResults),
			id: "smoke-blocked-results",
		};
		const regression = blockedResults.outcomes.find(
			(row: Untyped) => row.caseId === "regression" && row.side === "candidate",
		);
		assert.ok(regression, "fixture has a candidate regression outcome");
		regression.correct = false;
		const blockedResultFile = path.join(temporary, "blocked-results.json");
		put(blockedResultFile, JSON.stringify(blockedResults));
		const blockedImported = JSON.parse(
			cli(
				"migrate",
				"results",
				evaluationPlan.id,
				blockedResultFile,
				...candidateArgs,
				"--json",
			),
		);
		const blockedReport = JSON.parse(
			cli("migrate", "report", blockedResults.id, "--store", store, "--json"),
		);
		assert.deepEqual(
			blockedReport.eligibility.regressions.map((row: Untyped) => row.caseId),
			["regression"],
		);
		const decision = {
			decisionVersion: 1,
			id: "smoke-promotion",
			resultId: evaluationResults.id,
			candidateId: candidateResult.id,
			candidateRevisionDigest: candidateResult.revisionDigest,
			planDigest: planned.planDigest,
			resultDigest: importedResults.resultDigest,
			assignment: evaluationAssignment,
			release: candidateResult.release,
			regressions: [],
			correctnessOverride: null,
		};
		const decisionFile = path.join(temporary, "promotion-decision.json"),
			blockedDecisionFile = path.join(temporary, "blocked-decision.json");
		put(decisionFile, JSON.stringify(decision));
		put(
			blockedDecisionFile,
			JSON.stringify({
				...decision,
				id: "smoke-blocked-promotion",
				resultId: blockedResults.id,
				resultDigest: blockedImported.resultDigest,
				regressions: blockedReport.eligibility.regressions,
			}),
		);
		const otherScope = [
			...candidateArgs,
			"--role",
			"reviewer",
			"--model",
			"opus",
			"--host",
			"claude",
		];
		const otherLoaded = JSON.parse(
			cli("resolve", ...otherScope, "--json", "--contents"),
		).loaded;
		const promotionProject = snapshot(candidateRoot),
			promotionStore = snapshot(store);
		const previewed = JSON.parse(
			cli("migrate", "preview", decisionFile, ...candidateArgs, "--json"),
		);
		assert.equal(previewed.status, "preview");
		assert.deepEqual(previewed.gate, {
			status: "eligible",
			regressions: [],
			override: null,
		});
		assert.equal(previewed.target.rule.action, "add");
		assert.deepEqual(previewed.target.rule.when, evaluationAssignment);
		assert.deepEqual(previewed.release.content, candidateResult.content);
		assert.equal(previewed.release.state, "new");
		const refused = refusal(
			"migrate",
			"promote",
			blockedDecisionFile,
			...candidateArgs,
			"--json",
		);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /per-case correctness drop in regression/);
		assert.deepEqual(
			snapshot(candidateRoot),
			promotionProject,
			"preview and refused promotion leave the project unchanged",
		);
		assert.deepEqual(
			snapshot(store),
			promotionStore,
			"preview and refused promotion leave the store unchanged",
		);
		const promoted = JSON.parse(
			cli("migrate", "promote", decisionFile, ...candidateArgs, "--json"),
		);
		const decisionDigest = hashRecord(
				"agent-profiles/promotion-decision/v1",
				decision,
			),
			releaseDigest = promoted.release.releaseDigest;
		assert.equal(promoted.status, "promoted");
		assert.deepEqual(promoted.target, previewed.target);
		assert.equal(promoted.decision.decisionDigest, decisionDigest);
		const releaseWrapper = {
			revisionVersion: 2,
			kind: "release",
			identity: candidateResult.release,
			content: candidateResult.content,
			parent: workerRevision.recordDigest,
			candidate: candidateResult.revisionDigest,
			dependencies: candidateMetadata.dependencies,
			workflow: candidateMetadata.workflow,
			provenance: { kind: "promotion", decisionDigest },
		};
		assert.equal(
			hashRecord("agent-profiles/revision/v2", releaseWrapper),
			releaseDigest,
		);
		assert.equal(previewed.release.releaseDigest, releaseDigest);
		assert.deepEqual(
			fs.readFileSync(
				path.join(store, "promotions/decisions/ids/smoke-promotion.json"),
			),
			canonicalJSON({
				promotionIndexVersion: 1,
				id: decision.id,
				decisionDigest,
				releaseDigest,
			}),
		);
		assert.deepEqual(
			fs.readFileSync(
				path.join(
					store,
					"promotions/decisions/sha256",
					`${decisionDigest}.json`,
				),
			),
			canonicalJSON(decision),
		);
		assert.deepEqual(
			lookupRevisionManifest({ storeRoot: store, recordDigest: releaseDigest }),
			releaseWrapper,
		);
		assert.equal(
			lookupPackage({ storeRoot: store, name: workerName, version: "2.0.0" }),
			null,
			"no legacy identity mapping for the external label",
		);
		assert.deepEqual(
			snapshot(
				path.join(
					store,
					"objects/sha256",
					candidateResult.content.sha256,
					"tree",
				),
			),
			snapshot(candidateTree),
			"exact evaluated candidate tree, companion and resources",
		);
		const promotedSelection = JSON.parse(
			cli("resolve", ...candidateScope, "--json", "--contents"),
		);
		const promotedSkill = promotedSelection.loaded.find(
			(part: Untyped) => part.kind === "required-skill",
		);
		assert.equal(promotedSkill.content, candidateAfter);
		assert.equal(promotedSkill.package.version, "2.0.0");
		assert.equal(promotedSkill.package.revisionDigest, releaseDigest);
		assert.equal(
			promotedSelection.loaded.find((part: Untyped) => part.kind === "workflow")
				.content,
			workflowBytes.toString("utf8"),
		);
		assert.deepEqual(
			JSON.parse(cli("resolve", ...otherScope, "--json", "--contents")).loaded,
			otherLoaded,
			"other tuples keep the exact original release",
		);
		const promotedLock = JSON.parse(
			fs.readFileSync(
				path.join(candidateRoot, ".agent-profiles/agent-profiles.lock"),
				"utf8",
			),
		);
		assert.ok(
			promotedLock.packages.some(
				(row: Untyped) =>
					row.name === workerName &&
					row.version === "2.0.0" &&
					row.sha256 === candidateResult.content.sha256 &&
					row.revisionDigests.includes(releaseDigest),
			),
		);
		assert.ok(
			promotedLock.packages.some(
				(row: Untyped) =>
					row.name === workerName &&
					row.version === workerVersion &&
					row.sha256 === worker.sha256,
			),
		);
		cli(
			"install",
			...candidateArgs,
			"--offline",
			"--frozen-lockfile",
			"--json",
		);
		const promotedStamp = reconstructCandidate({
			storeRoot: store,
			digest: promoted.stampDigest,
		});
		assert.deepEqual(promotedStamp.capture, {
			kind: "active",
			migration: null,
			candidate: null,
		});
		assert.deepEqual(
			promotedStamp.composition.map((part: Untyped) => [part.kind, part.bytes]),
			candidateRebuilt.composition.map((part: Untyped) => [
				part.kind,
				part.bytes,
			]),
		);
		assert.equal(
			JSON.parse(
				cli("verify", promoted.stampDigest, "--store", store, "--json"),
			).managedReproducible,
			true,
		);
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"report",
					evaluationResults.id,
					"--store",
					store,
					"--json",
				),
			),
			pairedReport,
		);
		assert.deepEqual(
			JSON.parse(
				cli("migrate", "report", blockedResults.id, "--store", store, "--json"),
			),
			blockedReport,
			"historical regression evidence is unchanged",
		);
		const promotedProject = snapshot(candidateRoot),
			promotedStore = snapshot(store);
		assert.equal(
			JSON.parse(
				cli("migrate", "promote", decisionFile, ...candidateArgs, "--json"),
			).status,
			"reused",
		);
		assert.deepEqual(snapshot(candidateRoot), promotedProject);
		assert.deepEqual(snapshot(store), promotedStore);
		put(path.join(candidateTree, "SKILL.md"), "# Later mutable edit\n");
		fs.rmSync(candidateRoot, { recursive: true });
		assert.deepEqual(
			migrationPromotion({ storeRoot: store, id: decision.id }),
			{
				id: decision.id,
				decisionDigest,
				releaseDigest,
				decision,
				release: releaseWrapper,
			},
		);
		assert.deepEqual(
			migrationCandidate({ storeRoot: store, id: candidateResult.id }),
			candidateIndex,
		);
		assert.deepEqual(
			reconstructCandidate({
				storeRoot: store,
				digest: candidateResult.stampDigest,
			}),
			candidateRebuilt,
		);
		fs.unlinkSync(evaluationPlanFile);
		fs.unlinkSync(evaluationResultFile);
		assert.deepEqual(
			JSON.parse(
				cli(
					"migrate",
					"report",
					evaluationResults.id,
					"--store",
					store,
					"--json",
				),
			),
			pairedReport,
		);
		assert.deepEqual(
			migrationEvaluationPlan({ storeRoot: store, id: evaluationPlan.id }),
			{ planDigest: planned.planDigest, plan: evaluationPlan },
		);
		console.log(
			"Packed paired external claims passed: decimal metadata, immutable plan/results reuse, metrics and historical rootless report; no activation or runtime attribution.",
		);
		console.log(
			"Packed advisory candidate passed: native config3 start/status/workspace readback with active stamp2 authoring base, immutable publication/replay/readback, exact task/workflow and no activation.",
		);
		console.log(
			"Packed scoped promotion passed: read-only preview, blocked-correctness refusal, exact-tuple binding/lock/stamp with evaluated bytes, immutable decision index/label, unaffected tuple and rootless readback; correctness remains an external claim, runtime unverified.",
		);

		const fresh = path.join(temporary, "fresh package project"),
			freshStore = path.join(temporary, "fresh package store");
		fs.cpSync(root, fresh, { recursive: true });
		const lockFile = path.join(fresh, ".agent-profiles/agent-profiles.lock"),
			lockBytes = fs.readFileSync(lockFile);
		assert.equal(
			fs.existsSync(freshStore),
			false,
			"fresh store has no cached objects",
		);
		assert.deepEqual(
			JSON.parse(
				cli(
					"install",
					"--root",
					fresh,
					"--store",
					freshStore,
					"--frozen-lockfile",
					"--offline",
					"--source",
					name,
					"2.0.0",
					revisions[1].directory,
					"--json",
				),
			),
			{ lockState: "valid", installRequired: false },
		);
		assert.deepEqual(fs.readFileSync(lockFile), lockBytes);
		const freshSelection = JSON.parse(
			cli(
				"resolve",
				"--root",
				fresh,
				"--store",
				freshStore,
				"--host",
				"codex",
				"--json",
				"--contents",
			),
		);
		assert.equal(freshSelection.lockState, "valid");
		assert.equal(freshSelection.loaded[0].package.sha256, revisions[1].digest);
		assert.equal(freshSelection.loaded[0].package.version, "2.0.0");
		assert.equal(
			freshSelection.loaded[0].content,
			revisions[1].members["entry.md"].toString("utf8"),
		);
		assert.deepEqual(
			snapshot(
				path.join(freshStore, "objects/sha256", revisions[1].digest, "tree"),
			),
			revisions[1].original,
		);
		const freshStamp = JSON.parse(
			cli(
				"stamp",
				"--root",
				fresh,
				"--store",
				freshStore,
				"--host",
				"codex",
				"--json",
			),
		).digest;
		assert.equal(
			freshStamp,
			revisions[1].stamp,
			"fresh exact bytes and selection reproduce the stamp",
		);
		for (const revision of revisions)
			assert.deepEqual(
				snapshot(revision.directory),
				revision.original,
				"imports preserve sources",
			);
		fs.rmSync(root, { recursive: true });
		fs.rmSync(sources, { recursive: true });
		assert.equal(fs.existsSync(configFile), false);
		assert.equal(fs.existsSync(sources), false);

		const { reconstructStamp } = await import(
			pathToFileURL(path.join(installed, "dist/src/stamps.js")).href
		);
		const { verifyMaterialization } = await import(
			pathToFileURL(path.join(installed, "dist/src/materialize.js")).href
		);
		const storeBefore = snapshot(store),
			freshBefore = snapshot(fresh),
			freshStoreBefore = snapshot(freshStore);
		for (const [index, revision] of revisions.entries()) {
			const rebuilt = reconstructStamp({
				digest: revision.stamp,
				storeRoot: store,
			});
			assert.deepEqual(
				rebuilt.composition.map((e: Untyped) => e.bytes),
				[revision.members["entry.md"], role],
			);
			assert.deepEqual(
				rebuilt.packages.map((p: Untyped) => [p.name, p.version, p.sha256]),
				[[name, revision.version, revision.digest]],
			);
			assert.deepEqual(
				rebuilt.packages[0].files.map((file: Untyped) => [
					file.path,
					file.bytes,
				]),
				Object.entries(revision.members),
			);
			const destination = path.join(outputs, `revision-${index + 1}`);
			const receipt = JSON.parse(
				cli(
					"materialize",
					revision.stamp,
					"--root",
					fresh,
					"--store",
					store,
					"--adapter",
					"filesystem-v1",
					"--output-root",
					outputs,
					"--destination",
					destination,
					"--json",
				),
			);
			assert.equal(receipt.status, "committed");
			assert.equal(receipt.stampDigest, revision.stamp);
			assert.deepEqual(
				verifyMaterialization({
					destination,
					expectedStampDigest: revision.stamp,
					storeRoot: store,
				}),
				{ verified: true, findings: [] },
			);
			assert.deepEqual(
				fs.readFileSync(path.join(destination, "content/instructions/0000.md")),
				revision.members["entry.md"],
			);
			assert.deepEqual(
				fs.readFileSync(path.join(destination, "content/instructions/0001.md")),
				role,
			);
			assert.deepEqual(
				snapshot(
					path.join(destination, "content/packages/sha256", revision.digest),
				),
				revision.original,
			);
		}
		const freshDestination = path.join(outputs, "fresh");
		cli(
			"materialize",
			freshStamp,
			"--root",
			fresh,
			"--store",
			freshStore,
			"--adapter",
			"filesystem-v1",
			"--output-root",
			outputs,
			"--destination",
			freshDestination,
			"--json",
		);
		assert.deepEqual(
			verifyMaterialization({
				destination: freshDestination,
				expectedStampDigest: freshStamp,
				storeRoot: freshStore,
			}),
			{ verified: true, findings: [] },
		);
		assert.deepEqual(
			fs.readFileSync(
				path.join(freshDestination, "content/instructions/0000.md"),
			),
			revisions[1].members["entry.md"],
		);
		assert.deepEqual(
			snapshot(
				path.join(
					freshDestination,
					"content/packages/sha256",
					revisions[1].digest,
				),
			),
			revisions[1].original,
		);
		assert.deepEqual(snapshot(store), storeBefore);
		assert.deepEqual(snapshot(freshStore), freshStoreBefore);
		assert.deepEqual(snapshot(fresh), freshBefore);
		assert.deepEqual(fs.readFileSync(lockFile), lockBytes);
		const migration = JSON.parse(
			cli(
				"migrate",
				"start",
				"--root",
				fresh,
				"--store",
				freshStore,
				"--role",
				"reviewer",
				"--model",
				"fictional-model",
				"--host",
				"codex",
				"--sharing",
				"fork",
				"--json",
			),
		);
		const workspace = path.join(fresh, migration.workspace);
		const edited = `packages/${revisions[1].digest}/entry.md`;
		assert.deepEqual(
			fs.readFileSync(path.join(workspace, edited)),
			revisions[1].members["entry.md"],
		);
		put(path.join(workspace, edited), "# Candidate only\n");
		const status = JSON.parse(
			cli("migrate", "status", migration.id, "--root", fresh, "--json"),
		);
		assert.equal(status.dirty, true);
		assert.equal(status.workspaceChanged, true);
		assert.deepEqual(status.changes, [{ path: edited, kind: "changed" }]);
		const active = JSON.parse(
			cli(
				"resolve",
				"--root",
				fresh,
				"--store",
				freshStore,
				"--host",
				"codex",
				"--json",
				"--contents",
			),
		);
		assert.equal(
			active.loaded[0].content,
			revisions[1].members["entry.md"].toString("utf8"),
		);
		const migrationStoreBefore = snapshot(freshStore);
		const migrationBase = reconstructStamp({
			digest: migration.bases[0].stamp,
			storeRoot: freshStore,
		});
		const roleTarget = "local/.agent-profiles/roles/reviewer.md",
			proposalFile = path.join(temporary, "migration-proposal.json");
		const proposal = {
			proposalVersion: 1,
			classification: "role",
			target: { path: roleTarget },
			change: {
				before: role.toString("utf8"),
				after: "# Reviewer\r\nCheck boundaries and retain evidence.\r\n",
			},
			evidence: [
				{
					sessionId: "caller-claimed-smoke-session",
					excerpt: "A boundary check was omitted.",
					baseStamp: migration.bases[0].stamp,
				},
			],
		};
		const workspaceBefore = snapshot(workspace);
		put(proposalFile, JSON.stringify(proposal));
		const offered = JSON.parse(
			cli(
				"migrate",
				"propose",
				migration.id,
				proposalFile,
				"--root",
				fresh,
				"--store",
				freshStore,
				"--json",
			),
		);
		assert.deepEqual(offered, {
			id: offered.id,
			proposal,
			status: "proposed",
			reason: null,
		});
		assert.ok(offered.id);
		assert.deepEqual(
			snapshot(workspace),
			workspaceBefore,
			"proposal import does not apply",
		);
		fs.unlinkSync(proposalFile);
		const listedBefore = snapshot(fresh);
		assert.deepEqual(
			JSON.parse(
				cli("migrate", "proposals", migration.id, "--root", fresh, "--json"),
			),
			[offered],
		);
		assert.deepEqual(
			snapshot(fresh),
			listedBefore,
			"proposal list is read-only and retains imported data",
		);
		const accepted = JSON.parse(
			cli(
				"migrate",
				"accept",
				migration.id,
				offered.id,
				"--root",
				fresh,
				"--store",
				freshStore,
				"--json",
			),
		);
		assert.deepEqual(accepted, { ...offered, status: "accepted" });
		assert.deepEqual(
			fs.readFileSync(path.join(workspace, roleTarget)),
			Buffer.from(proposal.change.after),
		);
		const otherWorkspace = (entries: Untyped) =>
			entries.filter(
				([file]: [string, unknown]) =>
					file.split(path.sep).join("/") !== roleTarget,
			);
		assert.deepEqual(
			otherWorkspace(snapshot(workspace)),
			otherWorkspace(workspaceBefore),
			"acceptance changes one instruction",
		);
		const alternative = {
			...proposal,
			change: {
				before: proposal.change.after,
				after: "# Alternative reviewer rule\n",
			},
			evidence: [
				{
					...proposal.evidence[0],
					sessionId: "caller-claimed-second-smoke-session",
					excerpt: "An alternative needs review.",
				},
			],
		};
		put(proposalFile, JSON.stringify(alternative));
		const pending = JSON.parse(
			cli(
				"migrate",
				"propose",
				migration.id,
				proposalFile,
				"--root",
				fresh,
				"--store",
				freshStore,
				"--json",
			),
		);
		assert.deepEqual(pending, {
			id: pending.id,
			proposal: alternative,
			status: "proposed",
			reason: null,
		});
		assert.notEqual(pending.id, offered.id);
		const acceptedWorkspace = snapshot(workspace);
		const rejected = JSON.parse(
			cli(
				"migrate",
				"reject",
				migration.id,
				pending.id,
				"--reason",
				"Keep the accepted narrower rule",
				"--root",
				fresh,
				"--store",
				freshStore,
				"--json",
			),
		);
		assert.deepEqual(rejected, {
			...pending,
			status: "rejected",
			reason: "Keep the accepted narrower rule",
		});
		assert.deepEqual(
			snapshot(workspace),
			acceptedWorkspace,
			"rejection does not apply",
		);
		assert.deepEqual(
			JSON.parse(
				cli("migrate", "proposals", migration.id, "--root", fresh, "--json"),
			),
			[accepted, rejected],
		);
		assert.deepEqual(
			snapshot(fresh).filter(
				([file]) =>
					!file
						.split(path.sep)
						.join("/")
						.startsWith(".agent-profiles/migrations/"),
			),
			freshBefore,
		);
		assert.deepEqual(
			snapshot(freshStore),
			migrationStoreBefore,
			"proposal workflow preserves store bytes",
		);
		assert.deepEqual(
			reconstructStamp({
				digest: migration.bases[0].stamp,
				storeRoot: freshStore,
			}),
			migrationBase,
		);
		assert.deepEqual(
			fs.readFileSync(path.join(fresh, ".agent-profiles/roles/reviewer.md")),
			role,
		);
		const abandoned = JSON.parse(
			cli(
				"migrate",
				"abandon",
				migration.id,
				"--reason",
				"Smoke test finished",
				"--root",
				fresh,
				"--json",
			),
		);
		assert.equal(abandoned.state, "abandoned");
		assert.equal(
			fs.readFileSync(path.join(workspace, edited), "utf8"),
			"# Candidate only\n",
		);
		assert.deepEqual(fs.readFileSync(lockFile), lockBytes);
		assert.deepEqual(
			snapshot(
				path.join(freshStore, "objects/sha256", revisions[1].digest, "tree"),
			),
			revisions[1].original,
		);
		assert.deepEqual(
			JSON.parse(
				cli("migrate", "proposals", migration.id, "--root", fresh, "--json"),
			),
			[accepted, rejected],
		);
		assert.deepEqual(snapshot(freshStore), migrationStoreBefore);
		console.log(
			"Packed package workflow passed: two pins, retained stamps/diff/exports, and fresh offline frozen installation.",
		);
		console.log(
			"Packed migration workspace passed: start, edit, read-only status, unchanged active content, and retained abandonment.",
		);
		console.log(
			"Packed migration proposals passed: advisory import/list, explicit acceptance, rejection reason/evidence retention, and unchanged active/store/base bytes.",
		);
	}
	console.log(
		`Verified ${artifact.name}@${artifact.version}: ${files.size} package files, ${artifact.size} bytes compressed.`,
	);
} finally {
	// Only remove the exact temporary directory created by this script.
	assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
	assert.ok(path.basename(temporary).startsWith("agent-profiles-package-"));
	fs.rmSync(temporary, { recursive: true, force: true });
}
