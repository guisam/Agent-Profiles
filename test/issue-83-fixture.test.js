// #83: deterministic checks behind the live failure-case matrix. They do not
// observe a host; they prove each prepared case produces the fault it names
// (a tool error, a missing end line, a late server, a failing shell command)
// and that the shim leaves everything else unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { RESOLVE_INCOMPLETE } from "../src/integrations.ts";
import {
	CASES,
	DELAY_MS,
	finish,
	initCommand,
	MISSING_SKILL,
	prepare,
} from "./fixtures/issue-83/prepare.mjs";
import { cutMessage, parseArgs } from "./fixtures/issue-83/shim.mjs";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const END =
	"End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.";
const SELECT = ["--host", "claude", "--model", "claude-opus-5-5"];
const textOf = (result) => result.content.map((part) => part.text).join("");

function fixture(t, kase) {
	const base = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-83-"));
	const clients = [];
	t.after(async () => {
		for (const client of clients) await client.close();
		rmSync(base, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const home = path.join(base, "home");
	mkdirSync(home);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_PROFILES_STORE: path.join(home, "store"),
	};
	// The runner's marker would make the spawned shim skip its CLI entry point.
	delete env.NODE_TEST_CONTEXT;
	// No Git: os.tmpdir() may sit inside a user's repository on some machines.
	const root = prepare(path.join(base, "project"), kase, { git: false });
	// The documented order: prepare, init, then --finish applies the fault. init
	// exits 1 in the copy only because the package is not installed there.
	const mcp = initCommand(kase).endsWith(" --mcp") ? ["--mcp"] : [];
	const init = node({ root, env }, [
		cli,
		"init",
		"--root",
		root,
		"--agent",
		"claude",
		...mcp,
	]);
	assert.match(init.stdout, /Updated CLAUDE\.md/, init.stderr);
	finish(root, kase);
	return { root, env, clients };
}

const node = (f, args) =>
	spawnSync(process.execPath, args, {
		cwd: f.root,
		env: f.env,
		encoding: "utf8",
	});
const resolve = (f) => node(f, [cli, "resolve", "--root", f.root, ...SELECT]);

async function connect(f, command, args) {
	const client = new Client({ name: "agent-profiles-83", version: "1" });
	await client.connect(
		new StdioClientTransport({
			command,
			args,
			cwd: f.root,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
	return client;
}
const server = (f) => [cli, "mcp", "--root", f.root, "--host", "claude"];
const callResolve = (client) =>
	client.callTool({
		name: "resolve",
		arguments: { model: "claude-opus-5-5", role: "reviewer" },
	});

test("#83 prepare: each case gets only its own fault; bad requests are refused", (t) => {
	for (const kase of CASES) {
		const f = fixture(t, kase);
		assert.ok(existsSync(path.join(f.root, "ap-shim.mjs")), kase);
		const mcp = path.join(f.root, ".mcp.json");
		const missing = !existsSync(path.join(f.root, MISSING_SKILL));
		assert.equal(missing, ["tool-error", "cli-enoent"].includes(kase), kase);
		const block = readFileSync(path.join(f.root, "CLAUDE.md"), "utf8");
		assert.equal(
			block.includes("ap-shim.mjs --run --"),
			kase === "shell-cut",
			kase,
		);
		if (kase === "cli-enoent" || kase === "shell-cut") {
			assert.equal(existsSync(mcp), false, kase);
			continue;
		}
		const { command, args } = JSON.parse(readFileSync(mcp, "utf8")).mcpServers[
			"agent-profiles"
		];
		const line = [command, ...args].join(" ");
		assert.ok(line.endsWith("npx --no agent-profiles mcp --host claude"), line);
		assert.equal(line.includes("--cut"), kase === "mcp-cut", line);
		assert.equal(
			line.includes(`--delay ${DELAY_MS}`),
			kase === "delayed",
			line,
		);
	}
	assert.throws(() => prepare("unused", "nope"), /--case expects/);
	assert.throws(
		() => finish(t.name, "tool-error"),
		/no CLAUDE\.md; run npx --no agent-profiles init --agent claude --mcp first/,
	);
});

test("#83 tool-error and cli-enoent: resolve fails with the stop rule and no end line", async (t) => {
	const mcp = fixture(t, "tool-error");
	const failed = await callResolve(
		await connect(mcp, process.execPath, server(mcp)),
	);
	assert.ok(failed.isError);
	assert.ok(textOf(failed).endsWith(RESOLVE_INCOMPLETE), textOf(failed));
	assert.ok(!textOf(failed).includes(END));

	const shell = resolve(fixture(t, "cli-enoent"));
	assert.notEqual(shell.status, 0);
	assert.match(shell.stderr, /ENOENT/);
	assert.ok(shell.stderr.includes(RESOLVE_INCOMPLETE), shell.stderr);
	assert.ok(!shell.stdout.includes(END));
});

test("#83 mcp-cut: the shim halves resolve output and relays everything else", async (t) => {
	const f = fixture(t, "mcp-cut");
	const full = textOf(
		await callResolve(await connect(f, process.execPath, server(f))),
	);
	assert.ok(full.trimEnd().endsWith(END));
	const shim = path.join(f.root, "ap-shim.mjs");
	const client = await connect(f, process.execPath, [
		shim,
		"--cut",
		"--",
		process.execPath,
		...server(f),
	]);
	assert.ok(
		(await client.listTools()).tools.some((tool) => tool.name === "resolve"),
	);
	const cut = await callResolve(client);
	assert.ok(!cut.isError);
	assert.equal(textOf(cut), full.slice(0, Math.floor(full.length / 2)));
	assert.ok(!textOf(cut).includes(END));
	// Messages without tool-result text pass through byte for byte.
	assert.equal(
		cutMessage('{"jsonrpc":"2.0","id":1,"result":{}}'),
		'{"jsonrpc":"2.0","id":1,"result":{}}',
	);
	assert.equal(cutMessage("not json"), "not json");
});

test("#83 delayed: the server answers only after the delay", async (t) => {
	const f = fixture(t, "delayed"),
		shim = path.join(f.root, "ap-shim.mjs"),
		started = Date.now();
	const client = await connect(f, process.execPath, [
		shim,
		"--delay",
		"400",
		"--",
		process.execPath,
		...server(f),
	]);
	assert.ok(Date.now() - started >= 400);
	assert.ok(
		textOf(await callResolve(client))
			.trimEnd()
			.endsWith(END),
	);
});

test("#83 shell-cut: the block's command is routed through the shim, which drops the end line", (t) => {
	const f = fixture(t, "shell-cut");
	assert.match(
		readFileSync(path.join(f.root, "CLAUDE.md"), "utf8"),
		/node ap-shim\.mjs --run -- npx --no agent-profiles resolve/,
	);
	const full = resolve(f).stdout;
	assert.ok(full.trimEnd().endsWith(END));
	const cut = node(f, [
		path.join(f.root, "ap-shim.mjs"),
		"--run",
		"--",
		process.execPath,
		cli,
		"resolve",
		"--root",
		f.root,
		...SELECT,
	]);
	assert.equal(cut.status, 0);
	assert.equal(cut.stdout, full.slice(0, Math.floor(full.length / 2)));
	assert.throws(
		() => parseArgs(["--run", "--delay", "5", "--", "x"]),
		/no MCP flags/,
	);
	assert.throws(() => parseArgs(["--cut"]), /usage/);
});
