// Opt-in native check: node scripts/opencode-smoke.ts [--live]. Requires OpenCode v2.1.3.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install } from "../src/install.ts";

assert(
	process.argv.slice(2).every((arg) => arg === "--live"),
	"Expected only --live",
);
const project = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-opencode-"));
const executable = process.env.OPENCODE_BIN ?? "opencode";
const live = process.argv.includes("--live");

function run(args: string[], timeout = 30_000) {
	const result = spawnSync(executable, args, {
		cwd: project,
		encoding: "utf8",
		timeout,
		maxBuffer: 8 * 1024 * 1024,
		windowsHide: true,
	});
	assert.ifError(result.error);
	assert.equal(
		result.status,
		0,
		`OpenCode ${args[0]} failed: ${result.stderr}`,
	);
	return result.stdout;
}

function put(file: string, text: string) {
	const target = path.join(project, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, text);
}

try {
	const version = run(["--version"]).trim();
	assert.equal(
		version,
		"opencode v2.1.3",
		"Requalify native checks for a different version",
	);
	const rules = randomUUID();
	const context = randomUUID();
	const skill = randomUUID();
	const profile = randomUUID();
	const role = randomUUID();
	put("AGENTS.md", `Project rules verification code: ${rules}\n`);
	put(
		".agent-profiles/context.md",
		`Configured context verification code: ${context}\n`,
	);
	put(
		"opencode.json",
		JSON.stringify({ instructions: [".agent-profiles/context.md"] }),
	);
	put(
		".opencode/skills/issue30-smoke/SKILL.md",
		`---\nname: issue30-smoke\ndescription: Return the native loading verification code when explicitly asked.\n---\nNative skill verification code: ${skill}\n`,
	);
	put(
		".agent-profiles/agents.yaml",
		JSON.stringify({
			version: 1,
			default_profile: "selected",
			default_role: "unassigned",
			models: {},
			families: {},
			skills: {},
			roles: {
				unassigned: {
					file: "roles/unassigned.md",
					skills: { required: [], available: [] },
				},
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: [] },
				},
			},
		}),
	);
	put(
		".agent-profiles/roles/unassigned.md",
		"No explicit role was selected.\n",
	);
	put(
		".agent-profiles/profiles/selected.md",
		`Selected profile verification code: ${profile}\n`,
	);
	put(
		".agent-profiles/roles/reviewer.md",
		`Assigned role verification code: ${role}\n`,
	);
	const repository = fileURLToPath(new URL("../", import.meta.url));
	const metadata = JSON.parse(
		readFileSync(path.join(repository, "package.json"), "utf8"),
	);
	put("package.json", '{"private":true}\n');
	put(
		"node_modules/agent-profiles/package.json",
		JSON.stringify({
			name: "agent-profiles",
			version: metadata.version,
			type: "module",
			bin: { "agent-profiles": "bin/agent-profiles.js" },
		}),
	);
	put(
		"node_modules/agent-profiles/bin/agent-profiles.js",
		`#!/usr/bin/env node\nimport ${JSON.stringify(new URL("../bin/agent-profiles.ts", import.meta.url).href)};\n`,
	);
	if (process.platform === "win32") {
		put("node_modules/.bin/agent-profiles", "#!/bin/sh\n");
		put(
			"node_modules/.bin/agent-profiles.cmd",
			'@echo off\r\nnode "%~dp0..\\agent-profiles\\bin\\agent-profiles.js" %*\r\n',
		);
	} else {
		chmodSync(
			path.join(project, "node_modules/agent-profiles/bin/agent-profiles.js"),
			0o755,
		);
		mkdirSync(path.join(project, "node_modules/.bin"), { recursive: true });
		symlinkSync(
			"../agent-profiles/bin/agent-profiles.js",
			path.join(project, "node_modules/.bin/agent-profiles"),
		);
	}
	assert(install({ root: project, agents: ["opencode"] }).valid);
	const query = `location%5Bdirectory%5D=${encodeURIComponent(project)}`;
	let inventory: unknown;
	// The v2 skill endpoint can return before location plugins finish activating.
	for (let attempt = 0; attempt < 10; attempt++) {
		inventory = JSON.parse(run(["api", "GET", `/api/skill?${query}`]));
		if (
			inventory &&
			typeof inventory === "object" &&
			"data" in inventory &&
			Array.isArray(inventory.data) &&
			inventory.data.some(
				(entry: unknown) =>
					entry &&
					typeof entry === "object" &&
					"name" in entry &&
					entry.name === "issue30-smoke",
			)
		)
			break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	assert(inventory && typeof inventory === "object" && "data" in inventory);
	assert(Array.isArray(inventory.data));
	assert(
		inventory.data.some(
			(entry: unknown) =>
				entry &&
				typeof entry === "object" &&
				"name" in entry &&
				entry.name === "issue30-smoke",
		),
		`Native skill inventory did not discover project skill: ${JSON.stringify("location" in inventory ? inventory.location : null)} (${inventory.data.length} skills)`,
	);
	console.log(`${version}: native project skill discovery passed.`);
	if (live) {
		const output = run(
			[
				"run",
				"--standalone",
				"--format",
				"json",
				"The operator explicitly assigns Agent Profiles role reviewer. You must include --role reviewer in the bootstrap resolver invocation. Follow the OpenCode Agent Profiles bootstrap using your actual provider/model ID, with identity-source host-stated only if the host states it. Execute only the bootstrap resolver command; do not read files or route by hand. Return the project rules code, configured context code, selected profile code and assigned role code. Invoke the native issue30-smoke skill and return its code too. Reply with all five codes.",
			],
			120_000,
		);
		const events: unknown[] = output
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const texts: string[] = [];
		let invoked = false;
		let resolved = false;
		const resolverInputs: string[] = [];
		let sessionID: string | undefined;
		for (const event of events) {
			assert(event && typeof event === "object" && "type" in event);
			assert.notEqual(event.type, "error", "OpenCode emitted an error event");
			if ("sessionID" in event && typeof event.sessionID === "string")
				sessionID = event.sessionID;
			if (!("part" in event) || !event.part || typeof event.part !== "object")
				continue;
			const part = event.part;
			if (
				event.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			)
				texts.push(part.text);
			if (event.type === "tool_use" && "tool" in part) {
				if (part.tool === "skill") invoked = true;
				else {
					assert(
						["bash", "shell", "powershell", "execute"].includes(
							String(part.tool),
						),
						"Unexpected tool used to obtain instruction markers",
					);
					assert(
						"state" in part &&
							part.state &&
							typeof part.state === "object" &&
							"input" in part.state,
					);
					const descriptor: unknown = part.state.input;
					assert(descriptor && typeof descriptor === "object");
					if (part.tool === "execute") {
						assert(
							"code" in descriptor &&
								typeof descriptor.code === "string" &&
								descriptor.code.includes("agent-profiles resolve"),
							"Unexpected codemode operation",
						);
						continue;
					}
					assert(
						"command" in descriptor && typeof descriptor.command === "string",
					);
					const input = descriptor.command;
					assert(
						/^npx\s+--no\s+agent-profiles\s+resolve\b/.test(input) &&
							/--host\s+['"]?opencode['"]?(?=\s|$)/.test(input) &&
							/--role\s+['"]?reviewer['"]?(?=\s|$)/.test(input) &&
							!/[;&|`\r\n]/.test(input),
						"Expected the real OpenCode resolver command",
					);
					if (part.tool !== "execute") {
						resolved = true;
						resolverInputs.push(input);
					}
				}
			}
		}
		const answer = texts.join("\n");
		for (const code of [rules, context, skill, profile, role])
			assert(
				answer.includes(code),
				"Model response omitted a native loading verification code",
			);
		assert(invoked, "No native skill invocation was observed");
		assert(resolved, "No bootstrap resolver invocation was observed");
		assert(sessionID, "No session identity was observed");
		const retained: unknown = JSON.parse(
			run([
				"api",
				"GET",
				`/api/session/${encodeURIComponent(sessionID)}/context`,
			]),
		);
		assert(retained && typeof retained === "object" && "data" in retained);
		assert(Array.isArray(retained.data));
		const identities = new Set<string>();
		for (const message of retained.data) {
			if (!message || typeof message !== "object" || !("model" in message))
				continue;
			assert("agent" in message && typeof message.agent === "string");
			const model: unknown = message.model;
			assert(
				model &&
					typeof model === "object" &&
					"id" in model &&
					"providerID" in model,
			);
			assert(
				typeof model.id === "string" && typeof model.providerID === "string",
			);
			assert(
				resolverInputs.every((input) =>
					input.includes(`${model.providerID}/${model.id}`),
				),
				"Resolver model identity differs from the actual native request",
			);
			identities.add(
				JSON.stringify({
					agent: message.agent,
					model: `${model.providerID}/${model.id}`,
				}),
			);
		}
		assert.equal(
			identities.size,
			1,
			"Expected one observed model/agent in the fresh session",
		);
		console.log(`Session ${sessionID}: ${[...identities][0]}`);
		console.log(
			"Default-model fresh-session bootstrap, selected profile/role consumption and native skill invocation passed.",
		);
	} else {
		console.log(
			"Live model consumption skipped; add --live to exercise the current default model.",
		);
	}
} finally {
	rmSync(project, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
}
