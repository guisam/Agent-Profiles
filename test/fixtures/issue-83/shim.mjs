#!/usr/bin/env node
// #83: controlled faults in front of an unchanged Agent Profiles command.
//
//   node shim.mjs [--delay <ms>] [--cut] -- <mcp server command...>
//   node shim.mjs --cut-output -- <resolve command...>
//
// MCP mode relays newline-delimited JSON-RPC between the host and the server.
// --delay waits before starting the server, so the host sees a slow connection.
// --cut halves the text of every tool result, which drops the final
// `End of Agent Profiles context:` line the way a truncating host would.
// --cut-output runs a shell command and prints the first half of its stdout.
// Nothing else is changed: requests, other responses and exit codes pass through.
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const cutText = (text) => text.slice(0, Math.floor(text.length / 2));

// Cut every text part of a tool result; leave every other message unchanged.
export function cutMessage(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return line;
	}
	const content = message?.result?.content;
	if (!Array.isArray(content)) return line;
	for (const part of content)
		if (part.type === "text" && typeof part.text === "string")
			part.text = cutText(part.text);
	return JSON.stringify(message);
}

export function parseArgs(argv) {
	const at = argv.indexOf("--");
	if (at < 0 || at === argv.length - 1)
		throw new Error(
			"usage: shim.mjs [--delay <ms>] [--cut | --cut-output] -- <command...>",
		);
	const flags = argv.slice(0, at),
		command = argv.slice(at + 1);
	const options = { delay: 0, cut: false, cutOutput: false, command };
	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === "--cut") options.cut = true;
		else if (flags[i] === "--cut-output") options.cutOutput = true;
		else if (flags[i] === "--delay") {
			options.delay = Number(flags[++i]);
			if (!Number.isSafeInteger(options.delay) || options.delay < 0)
				throw new Error("--delay expects whole milliseconds");
		} else throw new Error(`unknown flag ${flags[i]}`);
	}
	if (options.cutOutput && (options.cut || options.delay))
		throw new Error("--cut-output runs a command; it takes no MCP flags");
	return options;
}

// Windows starts a bare name such as npx through its .cmd shim, which needs a shell
// and one quoted line. An absolute path (which may contain spaces) needs neither.
function start([command, ...args], stdio) {
	return process.platform === "win32" && !path.isAbsolute(command)
		? spawn([command, ...args.map((arg) => JSON.stringify(arg))].join(" "), {
				shell: true,
				stdio,
			})
		: spawn(command, args, { stdio });
}

function relay(options) {
	const child = start(options.command, ["pipe", "pipe", "inherit"]);
	process.stdin.pipe(child.stdin);
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", (line) => {
		process.stdout.write(`${options.cut ? cutMessage(line) : line}\n`);
	});
	child.on("exit", (code) => process.exit(code ?? 1));
}

function cutOutput(options) {
	const child = start(options.command, ["inherit", "pipe", "inherit"]);
	const chunks = [];
	child.stdout.on("data", (chunk) => chunks.push(chunk));
	child.on("exit", (code) => {
		process.stdout.write(cutText(Buffer.concat(chunks).toString("utf8")));
		process.exit(code ?? 1);
	});
}

if (
	!process.env.NODE_TEST_CONTEXT &&
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const options = parseArgs(process.argv.slice(2));
	if (options.cutOutput) cutOutput(options);
	else setTimeout(() => relay(options), options.delay);
}
