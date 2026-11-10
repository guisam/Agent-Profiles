// #82: deterministic checks behind the live subagent-delivery matrix. These do
// not observe a host; they prove the disposable fixture routes the parent, an
// assigned child and an unassigned child to distinguishable outputs, that a
// mid-session failure reaches a child's resolve call, and that the trace
// summarizer reads Claude Code transcripts as documented.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { RESOLVE_INCOMPLETE } from "../src/integrations.ts";
import { prepare } from "./fixtures/issue-82/prepare.mjs";
import { markers, traceSession } from "./fixtures/issue-82/trace.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "bin/agent-profiles.ts");
const REVIEWER_END =
	"End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.";
const COORDINATOR_END =
	"End of Agent Profiles context: 2 section(s): base, coordinator.";

function fixture(t) {
	const base = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-82-"));
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
	// No Git: os.tmpdir() may sit inside a user's repository on some machines.
	const root = prepare(path.join(base, "project"), { git: false });
	return { base, root, env, clients };
}

function resolve(f, ...args) {
	return spawnSync(
		process.execPath,
		[cli, "resolve", "--root", f.root, "--host", "claude", ...args],
		{ cwd: f.root, env: f.env, encoding: "utf8" },
	);
}

async function connect(f, args) {
	const client = new Client({ name: "agent-profiles-82", version: "1" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", "--root", f.root, ...args],
			cwd: f.root,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
	return client;
}

const textOf = (result) => result.content.map((part) => part.text).join("");

test("#82 fixture: parent, assigned child and unassigned child resolve distinguishably", (t) => {
	const f = fixture(t);
	const config = readFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
		"utf8",
	);
	assert.match(config, /default_role: reviewer/);
	const mcp = JSON.parse(readFileSync(path.join(f.root, ".mcp.json"), "utf8"));
	assert.deepEqual(mcp.mcpServers["agent-profiles"].args, [
		"--no",
		"agent-profiles",
		"mcp",
		"--host",
		"claude",
	]);
	const reviewer = readFileSync(
		path.join(f.root, ".claude/agents/fixture-reviewer.md"),
		"utf8",
	);
	assert.match(reviewer, /assigned Agent Profiles role is `reviewer`/);
	const unassigned = readFileSync(
		path.join(f.root, ".claude/agents/fixture-unassigned.md"),
		"utf8",
	);
	assert.doesNotMatch(unassigned, /role/i);
	assert.doesNotMatch(unassigned + reviewer, /resolve|Agent Profiles setup/);

	const model = [
		"--identity-source",
		"host-stated",
		"--model",
		"claude-opus-5-5",
	];
	const parent = resolve(f, ...model, "--role", "coordinator");
	assert.equal(parent.status, 0, parent.stderr);
	const p = markers(parent.stdout);
	assert.equal(p.resolvedRole, "coordinator");
	assert.equal(p.endLine, COORDINATOR_END);
	assert.ok(p.roleMarker);
	assert.deepEqual(p.finals, [false, false]);

	const assigned = resolve(f, ...model, "--role", "reviewer");
	const unset = resolve(f, ...model);
	for (const out of [assigned, unset]) {
		assert.equal(out.status, 0, out.stderr);
		const m = markers(out.stdout);
		assert.equal(m.resolvedRole, "reviewer");
		assert.deepEqual(m.finals, [true, true]);
		assert.equal(m.endLine, REVIEWER_END);
		assert.ok(!m.roleMarker);
	}
	// The configured default is reported as a default, not as an assignment.
	assert.match(unset.stdout, /Role: reviewer\./);
});

test("#82 fixture: a host-only server serves each caller's own role; a role-bound server imposes one", async (t) => {
	const f = fixture(t);
	const host = await connect(f, ["--host", "claude"]);
	const own = async (role) => {
		const result = await host.callTool({
			name: "resolve",
			arguments: { model: "claude-opus-5-5", ...(role ? { role } : {}) },
		});
		assert.ok(!result.isError, textOf(result));
		return markers(textOf(result));
	};
	assert.equal((await own("coordinator")).endLine, COORDINATOR_END);
	assert.equal((await own("reviewer")).endLine, REVIEWER_END);
	assert.equal((await own()).resolvedRole, "reviewer");

	// Bound to the parent's role, the server refuses a child's own assignment.
	const bound = await connect(f, ["--host", "claude", "--role", "coordinator"]);
	const refused = await bound.callTool({
		name: "resolve",
		arguments: { role: "reviewer" },
	});
	assert.ok(refused.isError);
	assert.match(textOf(refused), /bound to role "coordinator"/);
});

test("#82 fixture: a skill removed after a healthy start fails the next resolve call", async (t) => {
	const f = fixture(t);
	const client = await connect(f, ["--host", "claude"]);
	const call = () =>
		client.callTool({
			name: "resolve",
			arguments: { model: "claude-opus-5-5", role: "reviewer" },
		});
	const healthy = await call();
	assert.ok(!healthy.isError, textOf(healthy));

	const skill = path.join(
		f.root,
		".agent-profiles/skills/review-depth/SKILL.md",
	);
	renameSync(skill, `${skill}.disabled`);
	const failed = await call();
	assert.ok(failed.isError);
	assert.match(textOf(failed), /ENOENT/);
	assert.ok(textOf(failed).endsWith(RESOLVE_INCOMPLETE), textOf(failed));
	assert.doesNotMatch(textOf(failed), /End of Agent Profiles context/);

	renameSync(`${skill}.disabled`, skill);
	const recovered = await call();
	assert.equal(markers(textOf(recovered)).endLine, REVIEWER_END);
});

test("#82 trace summary reads a parent transcript and its subagent files", (t) => {
	const base = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-82-trace-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	// Synthetic records in the shape Claude Code 2.1 writes; not a real session.
	const assistant = (content, model = "claude-opus-5-5") => ({
		type: "assistant",
		entrypoint: "sdk-cli",
		requestedModel: model,
		message: { model, content },
	});
	const result = (id, text, isError = false) => ({
		type: "user",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					is_error: isError,
					content: [{ type: "text", text }],
				},
			],
		},
	});
	const jsonl = (list) => `${list.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const reviewerOut = `Role: reviewer.\nFIXTURE-FINAL review-depth: x\nFIXTURE-FINAL shared-language: y\n${REVIEWER_END}`;
	writeFileSync(
		path.join(base, "s1.jsonl"),
		jsonl([
			assistant([
				{
					type: "tool_use",
					id: "p1",
					name: "mcp__agent-profiles__resolve",
					input: { role: "coordinator" },
				},
			]),
			result(
				"p1",
				`Role: coordinator.\nFIXTURE-ROLE coordinator: x\n${COORDINATOR_END}`,
			),
			assistant([
				{
					type: "tool_use",
					id: "p2",
					name: "Agent",
					input: { subagent_type: "fixture-reviewer", prompt: "Review it." },
				},
			]),
			result("p2", "done"),
		]),
	);
	const sub = path.join(base, "s1", "subagents");
	mkdirSync(sub, { recursive: true });
	writeFileSync(
		path.join(sub, "agent-a.jsonl"),
		jsonl([
			{ type: "user", message: { content: "Review it." } },
			assistant(
				[{ type: "tool_use", id: "c1", name: "ToolSearch", input: {} }],
				"claude-sonnet-5-5",
			),
			result("c1", "loaded"),
			assistant(
				[
					{
						type: "tool_use",
						id: "c2",
						name: "mcp__agent-profiles__resolve",
						input: { role: "reviewer" },
					},
				],
				"claude-sonnet-5-5",
			),
			result("c2", reviewerOut),
			assistant(
				[{ type: "tool_use", id: "c3", name: "Read", input: {} }],
				"claude-sonnet-5-5",
			),
			result("c3", "file"),
			assistant([{ type: "text", text: "Verdict last." }], "claude-sonnet-5-5"),
		]),
	);
	writeFileSync(
		path.join(sub, "agent-a.meta.json"),
		JSON.stringify({
			agentType: "fixture-reviewer",
			isBuiltIn: false,
			toolUseId: "p2",
		}),
	);
	writeFileSync(
		path.join(sub, "agent-b.jsonl"),
		jsonl([
			assistant([{ type: "tool_use", id: "d1", name: "Grep", input: {} }]),
			result("d1", "match"),
			assistant([
				{
					type: "tool_use",
					id: "d2",
					name: "Bash",
					input: {
						command:
							"npx --no agent-profiles resolve --host claude --role reviewer",
					},
				},
			]),
			result("d2", `ENOENT\n${RESOLVE_INCOMPLETE}`, true),
		]),
	);
	writeFileSync(
		path.join(sub, "agent-b.meta.json"),
		JSON.stringify({ agentType: "Explore", isBuiltIn: true }),
	);

	const trace = traceSession(path.join(base, "s1.jsonl"));
	assert.deepEqual(trace.entrypoints, ["sdk-cli"]);
	assert.deepEqual(trace.parent.toolOrder, [
		"resolve(mcp, role=coordinator)",
		"Agent",
	]);
	const [a, b] = trace.children;
	assert.equal(a.agentType, "fixture-reviewer");
	assert.equal(a.launchPrompt, "Review it.");
	assert.deepEqual(a.hostReportedModels, ["claude-sonnet-5-5"]);
	assert.deepEqual(a.toolOrder, [
		"ToolSearch",
		"resolve(mcp, role=reviewer)",
		"Read",
	]);
	assert.equal(a.retrievalBeforeOtherTools, true);
	assert.deepEqual(a.resolves[0].finals, [true, true]);
	assert.equal(a.resolves[0].endLine, REVIEWER_END);
	assert.equal(a.finalTextStart, "Verdict last.");
	assert.equal(b.isBuiltIn, true);
	assert.equal(b.launchModel, null);
	assert.deepEqual(b.toolOrder, ["Grep", "resolve(shell, role=reviewer)"]);
	assert.equal(b.retrievalBeforeOtherTools, false);
	assert.equal(b.resolves[0].isError, true);
	assert.equal(b.resolves[0].endLine, null);
});
