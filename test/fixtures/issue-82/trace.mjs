#!/usr/bin/env node
// Summarize the retained Claude Code transcript of one #82 parent session.
//
//   node test/fixtures/issue-82/trace.mjs <session.jsonl> [--json]
//
// Claude Code (CLI, and Claude sessions in T3 Code) writes each session to
// ~/.claude/projects/<project>/<session-id>.jsonl and each native subagent to
// <session-id>/subagents/agent-<id>.jsonl with an agent-<id>.meta.json beside it.
// This reads those files only. It reports what the transcript records: tool order,
// requested and host-reported model IDs, resolve arguments, the resolved role, and
// the fixture markers inside the resolve tool result. It cannot see what the host
// placed in model context beyond that, and it reports a missing field as unknown.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FINALS = [
	"FIXTURE-FINAL review-depth:",
	"FIXTURE-FINAL shared-language:",
];
const END = "End of Agent Profiles context:";
const SETUP_TOOLS = new Set(["ToolSearch"]);

function records(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) => (part?.type === "text" ? part.text : ""))
			.join("");
	return "";
}

function shellCommand(input) {
	return typeof input?.command === "string" ? input.command : undefined;
}

// A resolve call: the MCP tool, or the shell fallback the bootstrap names.
export function resolveCall(name, input) {
	if (/(^|__)resolve$/.test(name) && name.includes("agent-profiles"))
		return {
			channel: "mcp",
			role: input?.role ?? null,
			model: input?.model ?? null,
		};
	const command = shellCommand(input);
	if (command && /agent-profiles(\.js)?["']?\s+resolve\b/.test(command)) {
		const flag = (key) =>
			command.match(new RegExp(`--${key}[= ]['"]?([^'"\\s]+)`))?.[1] ?? null;
		return { channel: "shell", role: flag("role"), model: flag("model") };
	}
	return undefined;
}

export function markers(text) {
	const lines = text.split(/\r?\n/);
	return {
		resolvedRole: text.match(/\bRole: ([\w-]+)\./)?.[1] ?? null,
		finals: FINALS.map((final) => lines.some((line) => line.startsWith(final))),
		endLine: lines.findLast((line) => line.startsWith(END)) ?? null,
		roleMarker: text.includes("FIXTURE-ROLE coordinator"),
	};
}

// One transcript (parent or child): ordered tool calls with their results.
export function summarize(list) {
	const calls = [];
	const byId = new Map();
	const models = new Set();
	const requested = new Set();
	let finalText = "";
	for (const record of list) {
		const message = record.message;
		if (record.type === "assistant" && message) {
			if (message.model && message.model !== "<synthetic>")
				models.add(message.model);
			if (record.requestedModel) requested.add(record.requestedModel);
			for (const part of message.content ?? []) {
				if (part.type === "tool_use") {
					const call = { id: part.id, name: part.name, input: part.input };
					const resolve = resolveCall(part.name, part.input);
					if (resolve) call.resolve = resolve;
					calls.push(call);
					byId.set(part.id, call);
				} else if (part.type === "text" && part.text.trim())
					finalText = part.text;
			}
		}
		if (record.type === "user" && Array.isArray(message?.content))
			for (const part of message.content)
				if (part.type === "tool_result" && byId.has(part.tool_use_id)) {
					const call = byId.get(part.tool_use_id);
					call.isError = part.is_error === true;
					call.result = textOf(part.content);
				}
	}
	const firstResolve = calls.findIndex((call) => call.resolve);
	const firstWork = calls.findIndex(
		(call) => !call.resolve && !SETUP_TOOLS.has(call.name),
	);
	const resolves = calls
		.filter((call) => call.resolve)
		.map((call) => ({
			...call.resolve,
			isError: call.isError ?? null,
			...(call.result === undefined
				? { result: "unknown" }
				: markers(call.result)),
		}));
	return {
		hostReportedModels: [...models],
		requestedModels: [...requested],
		toolOrder: calls.map((call) =>
			call.resolve
				? `resolve(${call.resolve.channel}, role=${call.resolve.role ?? "none"})`
				: call.name,
		),
		resolves,
		retrievalBeforeOtherTools:
			firstResolve < 0 ? false : firstWork < 0 || firstResolve < firstWork,
		finalTextStart: finalText.slice(0, 400),
		calls,
	};
}

export function traceSession(sessionFile) {
	const parentList = records(sessionFile);
	const parent = summarize(parentList);
	const launches = new Map(
		parent.calls
			.filter((call) => call.name === "Agent" || call.name === "Task")
			.map((call) => [call.id, call.input]),
	);
	const dir = path.join(
		path.dirname(sessionFile),
		path.basename(sessionFile, ".jsonl"),
		"subagents",
	);
	const children = [];
	if (existsSync(dir))
		for (const name of readdirSync(dir).sort())
			if (name.endsWith(".jsonl")) {
				const file = path.join(dir, name);
				const metaFile = file.replace(/\.jsonl$/, ".meta.json");
				const meta = existsSync(metaFile)
					? JSON.parse(readFileSync(metaFile, "utf8"))
					: {};
				const list = records(file);
				const launch = launches.get(meta.toolUseId) ?? null;
				const first = list.find((record) => record.type === "user");
				children.push({
					file: name,
					agentType: meta.agentType ?? "unknown",
					isBuiltIn: meta.isBuiltIn ?? "unknown",
					launchModel: launch?.model ?? null,
					launchPrompt:
						launch?.prompt ?? textOf(first?.message?.content) ?? null,
					...summarize(list),
				});
			}
	return {
		session: path.basename(sessionFile),
		entrypoints: [
			...new Set(parentList.map((r) => r.entrypoint).filter(Boolean)),
		],
		parent,
		children,
	};
}

function strip(summary) {
	const { calls, ...rest } = summary;
	return rest;
}

// `node --test` loads every .mjs under test/ as a test file; only a direct run is a CLI.
if (
	!process.env.NODE_TEST_CONTEXT &&
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const file = args.find((arg) => arg !== "--json");
	if (!file) {
		console.error(
			"Usage: node test/fixtures/issue-82/trace.mjs <session.jsonl> [--json]",
		);
		process.exit(2);
	}
	const trace = traceSession(file);
	const out = {
		...trace,
		parent: strip(trace.parent),
		children: trace.children.map(strip),
	};
	console.log(
		json ? JSON.stringify(out, null, 2) : JSON.stringify(out, null, 1),
	);
}
