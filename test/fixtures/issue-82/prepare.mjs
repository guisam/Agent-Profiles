#!/usr/bin/env node
// Prepare a disposable #82 subagent-delivery project from the #80 portable fixture.
//
//   node test/fixtures/issue-82/prepare.mjs <new-directory> [--package <agent-profiles.tgz>]
//
// The destination must not exist and must not be inside a Git repository. The
// script copies test/fixtures/issue-80/project unchanged, then adds only what the
// #82 matrix needs: a parent-only `coordinator` role, two custom Claude Code agents
// (one assigned `reviewer`, one with no role), an MCP configuration bound to the
// host only, and `git init`. It never touches host registrations, approvals or
// settings outside the destination. See README.md in this directory.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE = path.join(here, "..", "issue-80", "project");

// Parent-only role. It has no required skills, so its final line differs from the
// reviewer's and a child that inherited it is visible in the child's own trace.
export const COORDINATOR_ROLE = `# Coordinator

Delegate the task the user names to the agent the user names, and relay its
answer. Do not review the change yourself.

FIXTURE-ROLE coordinator: this role belongs to the parent session only.
`;

export const COORDINATOR_YAML = `
  # #82: parent-only role; children must not receive it without assignment.
  coordinator:
    file: roles/coordinator.md
    skills:
      required: []
      available: []
`;

// Custom agents carry an assignment (or none) and nothing else: no setup
// reminder, so the bootstrap block alone decides whether the child resolves.
export const AGENTS = {
	"fixture-reviewer.md": `---
name: fixture-reviewer
description: Fixture review agent for issue 82 tests. Use only when the user names it.
---

Your assigned Agent Profiles role is \`reviewer\`.

Review the change you are given and report your findings.
`,
	"fixture-unassigned.md": `---
name: fixture-unassigned
description: Second fixture review agent for issue 82 tests. Use only when the user names it.
---

Review the change you are given and report your findings.
`,
};

// Bound to the host only. Binding a role or model here would impose it on every
// caller of this server, including children with a different assignment or model.
export const MCP_CONFIG = {
	mcpServers: {
		"agent-profiles": {
			type: "stdio",
			command: "npx",
			args: ["--no", "agent-profiles", "mcp", "--host", "claude"],
		},
	},
};

export function insideGit(directory) {
	for (let dir = directory; ; dir = path.dirname(dir)) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		if (path.dirname(dir) === dir) return undefined;
	}
}

export function run(dest, command, args) {
	// Windows runs npm through its .cmd shim, which needs a shell; pass one
	// quoted command line rather than an argument array to the shell.
	const result =
		process.platform === "win32"
			? spawnSync(
					// The bare command name: a quoted one breaks npm.cmd's own path lookup.
					[command, ...args.map((arg) => JSON.stringify(arg))].join(" "),
					{ cwd: dest, stdio: "inherit", shell: true },
				)
			: spawnSync(command, args, { cwd: dest, stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed in ${dest}`);
}

export function prepare(destination, { packagePath, git = true } = {}) {
	const dest = path.resolve(destination);
	if (existsSync(dest)) throw new Error(`${dest} already exists`);
	const repo = insideGit(path.dirname(dest));
	if (repo)
		throw new Error(`${dest} would be inside the Git repository ${repo}`);
	cpSync(SOURCE, dest, { recursive: true });
	writeFileSync(
		path.join(dest, ".agent-profiles/roles/coordinator.md"),
		COORDINATOR_ROLE,
	);
	appendFileSync(
		path.join(dest, ".agent-profiles/agents.yaml"),
		COORDINATOR_YAML,
	);
	mkdirSync(path.join(dest, ".claude/agents"), { recursive: true });
	for (const [name, body] of Object.entries(AGENTS))
		writeFileSync(path.join(dest, ".claude/agents", name), body);
	writeFileSync(
		path.join(dest, ".mcp.json"),
		`${JSON.stringify(MCP_CONFIG, null, 2)}\n`,
	);
	const steps = [];
	if (git) steps.push(["git", ["init", "-q"]]);
	if (packagePath)
		steps.push([
			"npm",
			[
				"install",
				"--save-dev",
				"--no-audit",
				"--no-fund",
				path.resolve(packagePath),
			],
		]);
	for (const [command, args] of steps) run(dest, command, args);
	return dest;
}

// `node --test` loads every .mjs under test/ as a test file; only a direct run is a CLI.
if (
	!process.env.NODE_TEST_CONTEXT &&
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--package");
	const packagePath = at >= 0 ? args.splice(at, 2)[1] : undefined;
	if (args.length !== 1) {
		console.error(
			"Usage: node test/fixtures/issue-82/prepare.mjs <new-directory> [--package <agent-profiles.tgz>]",
		);
		process.exit(2);
	}
	const dest = prepare(args[0], { packagePath });
	console.log(`Prepared ${dest}`);
	console.log(
		"Next: npx --no agent-profiles init --agent claude --mcp, then npx --no agent-profiles doctor (README.md, step 2).",
	);
}
