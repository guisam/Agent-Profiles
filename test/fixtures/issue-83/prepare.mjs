#!/usr/bin/env node
// Prepare a disposable #83 failure-case project from the #80 portable fixture.
//
//   node test/fixtures/issue-83/prepare.mjs <new-directory> --case <case> [--package <agent-profiles.tgz>]
//
// Cases (README.md in this directory has the pass criteria):
//   tool-error   MCP registered; a required skill is missing, so `resolve` returns isError.
//   mcp-cut      MCP registered through shim.mjs --cut: tool results lose their end line.
//   shell-cut    No MCP; the block's shell command runs through shim.mjs --cut-output.
//                Needs --package, because the block exists only after `init`.
//   delayed      MCP registered through shim.mjs --delay: the server starts late.
//   cli-enoent   No MCP; a required skill is missing, so the shell command fails.
//
// The destination must not exist and must not be inside a Git repository. The
// script never touches host registrations, approvals or settings outside it.
import {
	cpSync,
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideGit, run, SOURCE } from "../issue-82/prepare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CASES = [
	"tool-error",
	"mcp-cut",
	"shell-cut",
	"delayed",
	"cli-enoent",
];
export const DELAY_MS = 15000;
export const MISSING_SKILL = ".agent-profiles/skills/review-depth/SKILL.md";
const SERVER = ["npx", "--no", "agent-profiles", "mcp", "--host", "claude"];
const RESOLVE = "npx --no agent-profiles resolve";

// Host-only binding, as in #82: a role or model here would be imposed on every caller.
export function mcpConfig(kase) {
	const shim = { "mcp-cut": ["--cut"], delayed: ["--delay", String(DELAY_MS)] }[
		kase
	];
	const [command, ...args] = shim
		? ["node", "ap-shim.mjs", ...shim, "--", ...SERVER]
		: SERVER;
	return { mcpServers: { "agent-profiles": { type: "stdio", command, args } } };
}

// Route the managed block's shell command through the shim. `doctor` then reports
// the block as modified, which is expected for this case.
export function patchShellCommand(dest) {
	const file = path.join(dest, "CLAUDE.md"),
		text = readFileSync(file, "utf8");
	if (!text.includes(RESOLVE))
		throw new Error(`${file} has no "${RESOLVE}" command; run init first`);
	writeFileSync(
		file,
		text.replaceAll(RESOLVE, `node ap-shim.mjs --cut-output -- ${RESOLVE}`),
	);
}

export function prepare(destination, kase, { packagePath, git = true } = {}) {
	if (!CASES.includes(kase))
		throw new Error(`--case expects one of ${CASES.join(", ")}`);
	if (kase === "shell-cut" && !packagePath)
		throw new Error(
			"shell-cut needs --package: the block exists only after init",
		);
	const dest = path.resolve(destination);
	if (existsSync(dest)) throw new Error(`${dest} already exists`);
	const repo = insideGit(path.dirname(dest));
	if (repo)
		throw new Error(`${dest} would be inside the Git repository ${repo}`);
	cpSync(SOURCE, dest, { recursive: true });
	cpSync(path.join(here, "shim.mjs"), path.join(dest, "ap-shim.mjs"));
	if (["tool-error", "mcp-cut", "delayed"].includes(kase))
		writeFileSync(
			path.join(dest, ".mcp.json"),
			`${JSON.stringify(mcpConfig(kase), null, 2)}\n`,
		);
	if (kase === "tool-error" || kase === "cli-enoent")
		renameSync(
			path.join(dest, MISSING_SKILL),
			path.join(dest, `${MISSING_SKILL}.disabled`),
		);
	if (git) run(dest, "git", ["init", "-q"]);
	if (packagePath) {
		run(dest, "npm", [
			"install",
			"--save-dev",
			"--no-audit",
			"--no-fund",
			path.resolve(packagePath),
		]);
		// The MCP cases keep init for the operator (README, step 2); shell-cut needs the block now.
		if (kase === "shell-cut") {
			run(dest, "npx", ["--no", "agent-profiles", "init", "--agent", "claude"]);
			patchShellCommand(dest);
		}
	}
	return dest;
}

// `node --test` loads every .mjs under test/ as a test file; only a direct run is a CLI.
if (
	!process.env.NODE_TEST_CONTEXT &&
	process.argv[1] &&
	// Real paths: argv[1] may go through a symlink that Node has resolved (macOS /var).
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
	const args = process.argv.slice(2),
		take = (flag) => {
			const at = args.indexOf(flag);
			return at >= 0 ? args.splice(at, 2)[1] : undefined;
		};
	const packagePath = take("--package"),
		kase = take("--case");
	if (args.length !== 1 || !kase) {
		console.error(
			`Usage: node test/fixtures/issue-83/prepare.mjs <new-directory> --case <${CASES.join("|")}> [--package <agent-profiles.tgz>]`,
		);
		process.exit(2);
	}
	const dest = prepare(args[0], kase, { packagePath });
	console.log(`Prepared ${dest} for case ${kase}`);
}
