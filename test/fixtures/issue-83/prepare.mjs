#!/usr/bin/env node
// Prepare a disposable #83 failure-case project from the #80 portable fixture.
//
//   node test/fixtures/issue-83/prepare.mjs <new-directory> --case <case> [--package <agent-profiles.tgz>]
//   (run `init` in the new directory yourself; see README.md, step 2)
//   node test/fixtures/issue-83/prepare.mjs --finish <directory> --case <case>
//
// Cases (README.md in this directory has the pass criteria):
//   tool-error   MCP registered; --finish removes a required skill, so `resolve` returns isError.
//   mcp-cut      MCP registered through shim.mjs --cut: tool results lose their end line.
//   shell-cut    No MCP; --finish routes the block's shell command through shim.mjs --run.
//   delayed      MCP registered through shim.mjs --delay: the server starts late.
//   cli-enoent   No MCP; --finish removes a required skill, so the shell command fails.
//
// The fault is applied after `init`: init refuses a configuration with a missing
// skill, and the shell-cut patch needs the block init writes. This script never
// runs init. The destination must not exist and must not be inside a Git
// repository; nothing outside it is touched.
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
const MCP_CASES = ["tool-error", "mcp-cut", "delayed"];

function checkCase(kase) {
	if (!CASES.includes(kase))
		throw new Error(`--case expects one of ${CASES.join(", ")}`);
}

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

// The init command for a prepared case: MCP cases get the handoff block.
export const initCommand = (kase) =>
	`npx --no agent-profiles init --agent claude${MCP_CASES.includes(kase) ? " --mcp" : ""}`;

// Route the managed block's shell command through the shim. `doctor` then reports
// the block as modified, which is expected for this case.
export function patchShellCommand(dest) {
	const file = path.join(dest, "CLAUDE.md"),
		text = readFileSync(file, "utf8");
	if (!text.includes(RESOLVE))
		throw new Error(`${file} has no "${RESOLVE}" command; run init first`);
	writeFileSync(
		file,
		text.replaceAll(RESOLVE, `node ap-shim.mjs --run -- ${RESOLVE}`),
	);
}

export function prepare(destination, kase, { packagePath, git = true } = {}) {
	checkCase(kase);
	const dest = path.resolve(destination);
	if (existsSync(dest)) throw new Error(`${dest} already exists`);
	const repo = insideGit(path.dirname(dest));
	if (repo)
		throw new Error(`${dest} would be inside the Git repository ${repo}`);
	cpSync(SOURCE, dest, { recursive: true });
	cpSync(path.join(here, "shim.mjs"), path.join(dest, "ap-shim.mjs"));
	if (MCP_CASES.includes(kase))
		writeFileSync(
			path.join(dest, ".mcp.json"),
			`${JSON.stringify(mcpConfig(kase), null, 2)}\n`,
		);
	if (git) run(dest, "git", ["init", "-q"]);
	if (packagePath)
		run(dest, "npm", [
			"install",
			"--save-dev",
			"--no-audit",
			"--no-fund",
			path.resolve(packagePath),
		]);
	return dest;
}

// Apply the case's fault after init has written the block.
export function finish(directory, kase) {
	checkCase(kase);
	const dest = path.resolve(directory);
	if (!existsSync(path.join(dest, "CLAUDE.md")))
		throw new Error(`${dest} has no CLAUDE.md; run ${initCommand(kase)} first`);
	if (kase === "tool-error" || kase === "cli-enoent")
		renameSync(
			path.join(dest, MISSING_SKILL),
			path.join(dest, `${MISSING_SKILL}.disabled`),
		);
	if (kase === "shell-cut") patchShellCommand(dest);
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
	const finishing = take("--finish"),
		packagePath = take("--package"),
		kase = take("--case");
	if (!kase || (finishing ? args.length !== 0 : args.length !== 1)) {
		console.error(
			`Usage: node test/fixtures/issue-83/prepare.mjs <new-directory> --case <${CASES.join("|")}> [--package <agent-profiles.tgz>]\n       node test/fixtures/issue-83/prepare.mjs --finish <directory> --case <case>`,
		);
		process.exit(2);
	}
	if (finishing) {
		console.log(`Applied the ${kase} fault in ${finish(finishing, kase)}`);
	} else {
		const dest = prepare(args[0], kase, { packagePath });
		console.log(`Prepared ${dest} for case ${kase}.`);
		console.log(
			`Next, in that directory: ${initCommand(kase)}; then: node test/fixtures/issue-83/prepare.mjs --finish "${dest}" --case ${kase}`,
		);
	}
}
