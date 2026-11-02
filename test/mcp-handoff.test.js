import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { doctor, install, uninstall } from "../src/install.ts";
import {
	blockVariant,
	bootstrapBlock,
	managedSpan,
	PROTOCOL,
} from "../src/integrations.ts";
import { mcpConfigured, mcpSetup, mcpSetupLines } from "../src/mcp-setup.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "bin/agent-profiles.ts");
const HOSTS = ["claude", "codex", "opencode", "hermes"];

function repository(t) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-handoff-")),
	);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, ".git"));
	return root;
}

const read = (root, file) => fs.readFileSync(path.join(root, file));
function blockIn(root, file, host) {
	const content = read(root, file);
	const span = managedSpan(content, file, host);
	return content.subarray(span.start, span.end);
}

test("the MCP block adds only the handoff paragraph and keeps the shell command and protocol", () => {
	for (const host of HOSTS) {
		const shell = bootstrapBlock(host).toString("utf8");
		const mcp = bootstrapBlock(host, "\n", true).toString("utf8");
		assert.notEqual(mcp, shell, host);
		assert.match(mcp, new RegExp(`agent-profiles:protocol ${PROTOCOL} `));
		// Every shell line survives, in order: the command is the fallback.
		const shellLines = shell.split("\n");
		const mcpLines = mcp.split("\n");
		let cursor = 0;
		for (const line of mcpLines) if (line === shellLines[cursor]) cursor++;
		assert.equal(cursor, shellLines.length, host);
		assert.match(mcp, /`agent-profiles` MCP server is connected/);
		assert.match(mcp, new RegExp(`host: "${host}"`));
		assert.match(mcp, /npx --no agent-profiles resolve --host/);
		assert.equal(
			bootstrapBlock(host, "\r\n", true).toString("utf8"),
			mcp.replaceAll("\n", "\r\n"),
		);
	}
});

test("blockVariant recognizes both current variants and nothing else", () => {
	const before = Buffer.from("# Rules\n");
	assert.equal(
		blockVariant("claude", before, bootstrapBlock("claude")),
		"shell",
	);
	assert.equal(
		blockVariant("claude", before, bootstrapBlock("claude", "\n", true)),
		"mcp",
	);
	assert.equal(
		blockVariant(
			"claude",
			before,
			Buffer.from(
				bootstrapBlock("claude").toString().replace("exact", "precise"),
			),
		),
		null,
	);
	assert.equal(blockVariant("claude", before, bootstrapBlock("codex")), null);
});

test("init --mcp writes the handoff, plain init keeps it, --no-mcp removes it", (t) => {
	const root = repository(t);
	install({ root, agents: ["claude"], mcp: true });
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(
			bootstrapBlock("claude", "\n", true),
		),
	);

	let report = doctor(root);
	const claude = report.agents.find((agent) => agent.id === "claude");
	assert.equal(claude.mcp, true);
	assert.equal(claude.current, true);
	assert.ok(
		!report.bootstrap.some((problem) => /managed block/.test(problem)),
		report.bootstrap.join("\n"),
	);

	// No flag: the installed variant is kept; nothing changes.
	assert.deepEqual(install({ root, agents: ["claude"] }).modified, []);
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(
			bootstrapBlock("claude", "\n", true),
		),
	);

	const removed = install({ root, agents: ["claude"], mcp: false });
	assert.deepEqual(removed.modified, ["CLAUDE.md"]);
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(bootstrapBlock("claude")),
	);
	report = doctor(root);
	assert.equal(report.agents.find((agent) => agent.id === "claude").mcp, false);
});

test("--mcp applies to the selected agents; other installed blocks keep their variant", (t) => {
	const root = repository(t);
	install({ root, agents: ["claude", "codex"] });
	install({ root, agents: ["codex"], mcp: true });
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(bootstrapBlock("claude")),
	);
	assert.ok(
		blockIn(root, "AGENTS.md", "codex").equals(
			bootstrapBlock("codex", "\n", true),
		),
	);
	install({ root, agents: ["claude"] });
	assert.ok(
		blockIn(root, "AGENTS.md", "codex").equals(
			bootstrapBlock("codex", "\n", true),
		),
	);
});

test("a CRLF surface gets a CRLF MCP block, and doctor accepts it", (t) => {
	const root = repository(t);
	fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Rules\r\n\r\n");
	install({ root, agents: ["claude"], mcp: true });
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(
			bootstrapBlock("claude", "\r\n", true),
		),
	);
	assert.equal(
		doctor(root).agents.find((agent) => agent.id === "claude").mcp,
		true,
	);
});

test("a modified block is still reported stale, and init replaces it with the requested variant", (t) => {
	const root = repository(t);
	install({ root, agents: ["claude"], mcp: true });
	const file = path.join(root, "CLAUDE.md");
	fs.writeFileSync(
		file,
		fs
			.readFileSync(file, "utf8")
			.replace("needs no shell permission", "needs nothing"),
	);
	assert.ok(
		doctor(root).bootstrap.some((problem) =>
			/managed block in CLAUDE.md is modified/.test(problem),
		),
	);
	install({ root, agents: ["claude"], mcp: true });
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(
			bootstrapBlock("claude", "\n", true),
		),
	);
});

test("uninstall removes an MCP block exactly like a shell block", (t) => {
	const root = repository(t);
	fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Rules\n");
	install({ root, agents: ["claude"], mcp: true });
	uninstall({ root, agents: ["claude"] });
	assert.equal(read(root, "CLAUDE.md").toString(), "# Rules\n");
});

test("mcpConfigured reads only each host's project file", (t) => {
	const root = repository(t);
	for (const host of ["claude", "codex", "opencode"])
		assert.equal(mcpConfigured(root, host), false, host);
	assert.equal(mcpConfigured(root, "hermes"), null);

	fs.writeFileSync(
		path.join(root, ".mcp.json"),
		JSON.stringify({ mcpServers: { "agent-profiles": { command: "npx" } } }),
	);
	fs.mkdirSync(path.join(root, ".codex"));
	fs.writeFileSync(
		path.join(root, ".codex/config.toml"),
		`model = "x"\n\n${mcpSetup("codex").snippet}\n`,
	);
	fs.writeFileSync(
		path.join(root, "opencode.json"),
		`${mcpSetup("opencode").snippet}\n`,
	);
	for (const host of ["claude", "codex", "opencode"])
		assert.equal(mcpConfigured(root, host), true, host);

	// Another server, a lookalike key, or invalid JSON is not the agent-profiles server.
	fs.writeFileSync(
		path.join(root, ".mcp.json"),
		JSON.stringify({ mcpServers: { "agent-profiles-old": {} } }),
	);
	assert.equal(mcpConfigured(root, "claude"), false);
	fs.writeFileSync(path.join(root, ".mcp.json"), "{not json");
	assert.equal(mcpConfigured(root, "claude"), false);
	fs.writeFileSync(
		path.join(root, ".codex/config.toml"),
		"[mcp_servers.agent-profiles-old]\n",
	);
	assert.equal(mcpConfigured(root, "codex"), false);
});

test("setup lines name the snippet when unconfigured and confirm it when configured", (t) => {
	const root = repository(t);
	const missing = mcpSetupLines(root, "claude").join("\n");
	assert.match(missing, /\.mcp\.json does not name the agent-profiles server/);
	assert.match(
		missing,
		/claude mcp add --scope project agent-profiles -- npx --no agent-profiles mcp --host claude/,
	);
	assert.match(missing, /falls back to the shell command/);
	assert.match(
		mcpSetupLines(root, "hermes").join("\n"),
		/~\/\.hermes\/config\.yaml/,
	);

	fs.writeFileSync(
		path.join(root, ".mcp.json"),
		JSON.stringify({ mcpServers: { "agent-profiles": {} } }),
	);
	const present = mcpSetupLines(root, "claude");
	assert.equal(present.length, 1);
	assert.match(present[0], /\.mcp\.json names the agent-profiles server/);
});

test("doctor notes the MCP setup only for blocks with the handoff", (t) => {
	const root = repository(t);
	install({ root, agents: ["claude", "codex"] });
	assert.ok(!doctor(root).notes.some((note) => /MCP handoff/.test(note)));
	install({ root, agents: ["codex"], mcp: true });
	const notes = doctor(root).notes.filter((note) => /MCP handoff/.test(note));
	assert.equal(notes.length, 1);
	assert.match(notes[0], /^OpenAI Codex: MCP handoff enabled/);
});

function run(root, ...args) {
	return spawnSync(process.execPath, [cli, ...args, "--root", root], {
		encoding: "utf8",
	});
}

test("CLI: init --mcp prints the host setup; flags are validated", (t) => {
	const root = repository(t);
	const result = run(root, "init", "--agent", "claude", "--mcp");
	assert.match(result.stdout, /Claude Code: MCP handoff enabled/);
	assert.match(result.stdout, /claude mcp add --scope project agent-profiles/);
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(
			bootstrapBlock("claude", "\n", true),
		),
	);
	assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);

	const shown = run(root, "doctor");
	assert.match(
		shown.stdout,
		/Claude Code: bootstrap installed with MCP handoff \(CLAUDE\.md\)/,
	);

	const both = run(root, "init", "--agent", "claude", "--mcp", "--no-mcp");
	assert.equal(both.status, 1);
	assert.match(both.stderr, /Choose --mcp or --no-mcp, not both/);
	const wrong = run(root, "doctor", "--mcp");
	assert.equal(wrong.status, 1);
	assert.match(wrong.stderr, /--mcp and --no-mcp are only supported by init/);
	const server = spawnSync(process.execPath, [cli, "mcp", "--mcp"], {
		encoding: "utf8",
		cwd: root,
	});
	assert.equal(server.status, 1);
	assert.match(server.stderr, /--mcp is not supported by mcp/);

	const off = run(root, "init", "--agent", "claude", "--no-mcp");
	assert.doesNotMatch(off.stdout, /MCP handoff/);
	assert.ok(
		blockIn(root, "CLAUDE.md", "claude").equals(bootstrapBlock("claude")),
	);
});
