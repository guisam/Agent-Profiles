import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatContext } from "../src/diagnostics.ts";
import { discoverExternalSkills } from "../src/external-skills.ts";
import { inspectRepository } from "../src/inspect.ts";
import { detectAgents, doctor, install, uninstall } from "../src/install.ts";
import { bootstrapBlock, managedSpan } from "../src/integrations.ts";
import { parseYaml, resolveInstructions } from "../src/resolve.ts";
import { discoverSkills, validateSkillSelection } from "../src/skills.ts";
import { createStamp, reconstructStamp, verifyStamp } from "../src/stamps.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
function put(root, file, bytes) {
	const target = path.join(root, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, bytes);
}
function repository(t) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ap-opencode-")),
	);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, ".git"));
	const { version } = JSON.parse(
		fs.readFileSync(path.join(project, "package.json")),
	);
	put(root, "package.json", '{"private":true}\n');
	put(
		root,
		"node_modules/@guisam/agent-profiles/package.json",
		JSON.stringify({
			name: "@guisam/agent-profiles",
			version,
			bin: { "agent-profiles": "bin/agent-profiles.js" },
		}),
	);
	put(
		root,
		"node_modules/@guisam/agent-profiles/bin/agent-profiles.js",
		"#!/usr/bin/env node\n",
	);
	if (process.platform === "win32") {
		put(root, "node_modules/.bin/agent-profiles", "#!/bin/sh\n");
		put(
			root,
			"node_modules/.bin/agent-profiles.cmd",
			'@echo off\r\nnode "%~dp0..\\@guisam\\agent-profiles\\bin\\agent-profiles.js" %*\r\n',
		);
	} else {
		fs.chmodSync(
			path.join(
				root,
				"node_modules/@guisam/agent-profiles/bin/agent-profiles.js",
			),
			0o755,
		);
		fs.mkdirSync(path.join(root, "node_modules/.bin"));
		fs.symlinkSync(
			"../@guisam/agent-profiles/bin/agent-profiles.js",
			path.join(root, "node_modules/.bin/agent-profiles"),
		);
	}
	return root;
}

for (const agents of [
	["codex", "opencode"],
	["opencode", "codex"],
]) {
	test(`OpenCode and Codex coexist with independent ownership (${agents.join(", ")})`, (t) => {
		const root = repository(t);
		const rules = Buffer.from("\uFEFF# Rules\r\nKeep user content.");
		put(root, "AGENTS.md", rules);
		const config = '// User comments\r\n{"theme":"custom",}\r\n';
		put(root, "opencode.jsonc", config);
		assert.equal(install({ root, agents }).valid, true);
		const combined = fs.readFileSync(path.join(root, "AGENTS.md"));
		assert.deepEqual(combined.subarray(0, rules.length), rules);
		for (const host of agents) {
			const span = managedSpan(combined, "AGENTS.md", host);
			assert.deepEqual(
				combined.subarray(span.start, span.end),
				bootstrapBlock(host, "\r\n"),
			);
		}
		assert.deepEqual(
			install({ root, agents: agents.toReversed() }).modified,
			[],
		);
		assert.equal(doctor(root).valid, true);
		const inspected = inspectRepository({ root });
		for (const host of agents)
			assert.equal(
				inspected.hosts.find((entry) => entry.id === host).configured,
				true,
			);
		fs.appendFileSync(path.join(root, "AGENTS.md"), "\r\nLater user text.");
		uninstall({ root });
		assert.deepEqual(
			fs.readFileSync(path.join(root, "AGENTS.md")),
			Buffer.concat([rules, Buffer.from("\r\nLater user text.")]),
		);
		assert.equal(
			fs.readFileSync(path.join(root, "opencode.jsonc"), "utf8"),
			config,
		);
	});
}

test("a Codex block alone never claims an installed OpenCode integration", (t) => {
	const root = repository(t);
	install({ root, agents: ["codex"] });
	assert.equal(
		detectAgents(root).find((entry) => entry.id === "opencode").installed,
		false,
	);
	assert.equal(
		inspectRepository({ root }).hosts.find((entry) => entry.id === "opencode")
			.configured,
		false,
	);
	install({ root, agents: ["opencode"] });
	assert(
		detectAgents(root)
			.filter((entry) => entry.installed)
			.every((entry) => ["codex", "opencode"].includes(entry.id)),
	);
});

test("OpenCode malformed markers refuse before setup changes any file", (t) => {
	const root = repository(t);
	const bad = "# User rules\n<!-- agent-profiles:opencode:start -->";
	put(root, "AGENTS.md", bad);
	assert.throws(() => install({ root, agents: ["opencode"] }), /malformed/);
	assert.equal(fs.existsSync(path.join(root, ".agent-profiles")), false);
	assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), bad);
});

test("overlapping host markers are rejected before managed content can be removed", () => {
	const content = Buffer.from(
		"<!-- agent-profiles:start --><!-- agent-profiles:opencode:start --><!-- agent-profiles:end --><!-- agent-profiles:opencode:end -->",
	);
	assert.throws(
		() => managedSpan(content, "AGENTS.md", "codex"),
		/overlapping/,
	);
	assert.throws(
		() => managedSpan(content, "AGENTS.md", "opencode"),
		/overlapping/,
	);
});

test("OpenCode retains provider/model, explicit role and provenance, including unknown-model fallback", (t) => {
	const root = repository(t);
	install({ root, agents: ["opencode"] });
	const input = {
		root,
		host: "opencode",
		model: "provider/unlisted-model",
		role: "reviewer",
		identitySource: "user",
	};
	const result = resolveInstructions(input);
	assert.equal(result.host, "opencode");
	assert.equal(result.model, input.model);
	assert.equal(result.identity.source, "user");
	assert.equal(result.role, "reviewer");
	assert.match(formatContext(result), /start a NEW OpenCode session/);
	assert.equal(
		result.profile,
		resolveInstructions({ root, model: input.model }).profile,
	);
	const storeRoot = path.join(root, "store");
	const stamp = createStamp({ ...input, storeRoot });
	assert.equal(
		verifyStamp({ digest: stamp.digest, storeRoot }).managedReproducible,
		true,
	);
	assert.equal(stamp.snapshot.selection.host, "opencode");
	assert(
		reconstructStamp({ digest: stamp.digest, storeRoot }).composition.length >
			0,
	);
	const other = createStamp({ ...input, storeRoot, host: "codex" });
	assert.notEqual(stamp.digest, other.digest);
	const block = bootstrapBlock("opencode").toString();
	assert.match(block, /NEW OpenCode session/);
	assert.match(block, /does not remove previous instructions/);
	assert.match(block, /Built-in build, plan and child agents do not imply/);
});

test("OpenCode native skills use directory identity, retain metadata and do not inject native bodies", (t) => {
	const root = repository(t);
	install({ root, agents: ["opencode"] });
	const body =
		"---\nname: Display name\ndescription: Native check\n---\nPRIVATE-NATIVE-BODY\n";
	put(root, ".opencode/skills/audit/SKILL.md", body);
	const configuration = parseYaml(
		fs.readFileSync(path.join(root, ".agent-profiles/agents.yaml"), "utf8"),
	);
	configuration.set(
		"skills",
		new Map([
			[
				"audit",
				new Map([
					["host", "opencode"],
					["scope", "project"],
				]),
			],
		]),
	);
	configuration
		.get("roles")
		.get("reviewer")
		.get("skills")
		.set("required", ["audit"]);
	const selected = resolveInstructions({
		root,
		configuration,
		host: "opencode",
		role: "reviewer",
	});
	assert.equal(selected.required[0].hostId, "audit");
	assert.equal(selected.required[0].name, "Display name");
	assert(
		!selected.loaded.some((entry) =>
			entry.content.includes("PRIVATE-NATIVE-BODY"),
		),
	);
	assert.equal(
		resolveInstructions({
			root,
			configuration,
			host: "codex",
			role: "reviewer",
		}).unsatisfied.length,
		1,
	);
	const inventory = discoverSkills(root, configuration);
	const skill = inventory.skills.find((entry) => entry.host === "opencode");
	validateSkillSelection(root, skill);
	put(
		root,
		".opencode/skills/audit/SKILL.md",
		body.replace("Native check", "Changed"),
	);
	assert.throws(() => validateSkillSelection(root, skill), /changed/);
});

test("OpenCode global metadata is bounded and duplicate directory IDs are not independently selectable", (t) => {
	const home = repository(t);
	const body =
		"---\nname: Display name\ndescription: Native check\n---\nPRIVATE-NATIVE-BODY\n";
	put(home, ".config/opencode/skills/audit/SKILL.md", body);
	const options = { home, env: {} };
	let inventory = discoverExternalSkills(options);
	assert.equal(inventory.skills[0].hostId, "audit");
	assert.equal(inventory.skills[0].host, "opencode");
	assert(!JSON.stringify(inventory).includes("PRIVATE-NATIVE-BODY"));
	put(home, ".opencode/skills/audit/SKILL.md", body);
	const combined = discoverSkills(home, new Map(), {
		external: true,
		sourceOptions: options,
	});
	assert(
		combined.skills
			.filter((entry) => entry.host === "opencode")
			.every((entry) => entry.selectable === false),
	);
	assert(
		combined.warnings.some((warning) =>
			warning.includes("multiple inventoried origins"),
		),
	);
	put(home, ".config/opencode/skill/audit/SKILL.md", body);
	inventory = discoverExternalSkills(options);
	assert(
		inventory.skills
			.filter((skill) => skill.host === "opencode")
			.every((skill) => !skill.selectable),
	);
	assert.throws(
		() =>
			discoverExternalSkills({
				home,
				env: { OPENCODE_CONFIG_DIR: "../escape" },
			}),
		/absolute/,
	);
});
