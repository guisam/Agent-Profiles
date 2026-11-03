// Read-only MCP service over the existing resolver, stamp and evaluation APIs (#39).
// Only the `mcp` command imports this module, so other commands never load the SDK.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CLIENT_CAPABILITIES_META_KEY,
	type InputRequiredResult,
	inputRequired,
	McpServer,
	type ServerContext,
} from "@modelcontextprotocol/server";
import {
	type StdioServerHandle,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { formatContext, resolutionOutput } from "./diagnostics.ts";
import { errorMessage } from "./files.ts";
import { findRoot, ownVersion } from "./install.ts";
import { migrationEvaluationReport } from "./migrations.ts";
import { type ResolveOptions, resolveInstructions } from "./resolve.ts";
import { diffStamps, previewStamp, verifyStamp } from "./stamps.ts";

export type McpOptions = {
	/** Project root for every tool call; otherwise the server's working directory is searched. */
	root?: string;
	/** Package store; tools never choose a store. */
	storeRoot?: string;
	/** Session defaults; a tool call may override each one. */
	host?: string;
	model?: string;
	family?: string;
	identitySource?: ResolveOptions["identitySource"];
	role?: string;
	/** Working directory used when no root is given (tests pass their own). */
	cwd?: string;
};

type ToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const selection = z.object({
	root: z
		.string()
		.optional()
		.describe(
			"Project directory. Defaults to the server's --root, or the repository containing its working directory.",
		),
	host: z
		.string()
		.optional()
		.describe("Integration ID, such as claude or codex."),
	model: z
		.string()
		.optional()
		.describe("Your exact model ID, as your host states it."),
	family: z.string().optional(),
	identitySource: z.enum(["host", "host-stated", "user"]).optional(),
	role: z.string().optional(),
	skills: z
		.array(z.string())
		.optional()
		.describe("Additional skill binding IDs to load."),
});
type Selection = z.infer<typeof selection>;

const digest = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "a full lowercase SHA-256 stamp digest");

const text = (value: string): ToolResult => ({
	content: [{ type: "text", text: value }],
});
const json = (value: unknown): ToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	structuredContent: JSON.parse(JSON.stringify(value)) as Record<
		string,
		unknown
	>,
});
const failure = (error: unknown): ToolResult => ({
	content: [{ type: "text", text: `Agent Profiles: ${errorMessage(error)}` }],
	isError: true,
});
const guarded =
	<A>(run: (args: A) => ToolResult) =>
	async (args: A) => {
		try {
			return run(args);
		} catch (error) {
			return failure(error);
		}
	};

/**
 * Resolve the project root: tool argument, then --root, then the host's
 * workspace root (when the client offers roots), then the repository around cwd.
 */
export function projectRoot(
	options: McpOptions,
	requested?: string,
	workspace?: string,
): string {
	const chosen = requested ?? options.root;
	if (chosen !== undefined) {
		if (!chosen.trim()) throw new Error("root must name a directory");
		if (!existsSync(chosen) || !statSync(chosen).isDirectory())
			throw new Error(`root is not a directory: ${chosen}`);
		return realpathSync(chosen);
	}
	return workspace ?? findRoot(options.cwd ?? process.cwd());
}

/**
 * Choose the project from the host's workspace roots: the one root holding
 * `.agent-profiles/agents.yaml`. None leaves the choice to the working directory;
 * several is ambiguous and refused, naming them.
 */
export function workspaceRoot(listing: unknown): string | undefined {
	const roots = (listing as { roots?: unknown } | undefined)?.roots;
	if (!Array.isArray(roots)) return undefined;
	const configured = new Set<string>();
	for (const entry of roots) {
		const uri = (entry as { uri?: unknown } | undefined)?.uri;
		if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
		let directory: string;
		try {
			directory = fileURLToPath(uri);
		} catch {
			continue;
		}
		if (existsSync(path.join(directory, ".agent-profiles", "agents.yaml")))
			configured.add(realpathSync(directory));
	}
	if (configured.size > 1)
		throw new Error(
			`several workspace roots have Agent Profiles configuration (${[...configured].join(", ")}); pass root to choose one`,
		);
	return [...configured][0];
}

// The client declares roots per request (2026-07-28) or at initialize (2025 eras).
function clientOffersRoots(server: McpServer, ctx: ServerContext): boolean {
	const envelope = ctx.mcpReq.envelope as
		| Record<string, { roots?: unknown } | undefined>
		| undefined;
	const declared =
		envelope?.[CLIENT_CAPABILITIES_META_KEY] ??
		server.server.getClientCapabilities();
	return Boolean(declared?.roots);
}

function selectors(
	options: McpOptions,
	args: Selection,
	workspace?: string,
): ResolveOptions {
	return {
		root: projectRoot(options, args.root, workspace),
		storeRoot: options.storeRoot,
		host: args.host ?? options.host,
		model: args.model ?? options.model,
		family: args.family ?? options.family,
		identitySource: args.identitySource ?? options.identitySource,
		role: args.role ?? options.role,
		skills: args.skills,
	};
}

const UNBOUND = [
	"# Agent Profiles",
	"",
	"This server selects repository instructions and skills by model, role and host.",
	"Before starting work, call the `resolve` tool with your exact model ID (and `role`, if you were assigned one), then follow its output.",
	"Call `resolve` again after context compaction or a model or role change. Every tool is read-only.",
].join("\n");

/**
 * Server instructions: the rendered profile when the session is bound to a model,
 * otherwise a pointer to the `resolve` tool. Never throws; a failed resolution is reported.
 */
export function serverInstructions(options: McpOptions): string {
	if (options.model === undefined && options.role === undefined) return UNBOUND;
	try {
		const selected = selectors(options, {});
		const result = resolveInstructions(selected);
		return [
			"Agent Profiles resolved this session's profile when the server started. Follow it as if you had called `resolve`; do not call it again unless the context was compacted or your model or role changed.",
			stampLine(selected),
			"",
			formatContext(result, { invocation: "mcp" }),
		].join("\n");
	} catch (error) {
		return `${UNBOUND}\n\nResolution at server start failed: ${errorMessage(error)}`;
	}
}

/**
 * The stamp digest of this session's resolution, computed without writing to the
 * store. Quote it to identify the exact profile state; `agent-profiles stamp` with
 * the same selectors records the same digest.
 */
function stampLine(selected: ResolveOptions): string {
	try {
		const { digest, retained } = previewStamp({
			root: selected.root,
			storeRoot: selected.storeRoot,
			host: selected.host,
			model: selected.model,
			family: selected.family,
			identitySource: selected.identitySource,
			role: selected.role,
		});
		return retained
			? `Stamp: sha256 ${digest} (retained in the store; the \`verify\` tool reads it).`
			: `Stamp: sha256 ${digest} (not retained; \`agent-profiles stamp\` with the same selectors records this digest).`;
	} catch (error) {
		return `Stamp: unavailable (${errorMessage(error)}).`;
	}
}

export function createServer(options: McpOptions = {}): McpServer {
	const server = new McpServer(
		{ name: "agent-profiles", version: ownVersion },
		{ instructions: serverInstructions(options) },
	);

	// Tools that select a project ask the host for its workspace roots only when
	// neither a root argument nor --root names one and the client offers roots.
	// The SDK carries the request in-band (2026-07-28) or as roots/list (2025 eras).
	const withProject =
		(run: (args: Selection, workspace?: string) => ToolResult) =>
		async (
			args: Selection,
			ctx: ServerContext,
		): Promise<ToolResult | InputRequiredResult> => {
			try {
				if (
					args.root !== undefined ||
					options.root !== undefined ||
					!clientOffersRoots(server, ctx)
				)
					return run(args);
				const listing = ctx.mcpReq.inputResponses?.roots;
				if (listing === undefined)
					return inputRequired({
						inputRequests: { roots: inputRequired.listRoots() },
					});
				return run(args, workspaceRoot(listing));
			} catch (error) {
				return failure(error);
			}
		};

	server.registerTool(
		"resolve",
		{
			title: "Resolve instructions",
			description:
				"Resolve the profile, role and skills for a model, role and host, and return the instructions to follow. Read-only.",
			inputSchema: selection,
			annotations: READ_ONLY,
		},
		withProject((args, workspace) =>
			text(
				formatContext(
					resolveInstructions(selectors(options, args, workspace)),
					{ invocation: "mcp" },
				),
			),
		),
	);

	server.registerTool(
		"explain",
		{
			title: "Explain selection",
			description:
				"Return the structured resolution: how the model was matched, which profile, role and skills were selected, what is available or unsatisfied, and package identities. Same as `agent-profiles resolve --json`. Read-only.",
			inputSchema: selection,
			annotations: READ_ONLY,
		},
		withProject((args, workspace) =>
			json(
				resolutionOutput(
					resolveInstructions(selectors(options, args, workspace)),
				),
			),
		),
	);

	server.registerTool(
		"verify",
		{
			title: "Verify a stamp",
			description:
				"Verify a stamp's integrity and report which parts are reproducible. Same as `agent-profiles verify --json`. Read-only.",
			inputSchema: z.object({ digest }),
			annotations: READ_ONLY,
		},
		guarded(({ digest }: { digest: string }) =>
			json(verifyStamp({ digest, storeRoot: options.storeRoot })),
		),
	);

	server.registerTool(
		"diff",
		{
			title: "Compare two stamps",
			description:
				"Structural differences between two stamps (before, after). Same as `agent-profiles diff --json`. Read-only.",
			inputSchema: z.object({ before: digest, after: digest }),
			annotations: READ_ONLY,
		},
		guarded(({ before, after }: { before: string; after: string }) =>
			json(diffStamps({ before, after, storeRoot: options.storeRoot })),
		),
	);

	server.registerTool(
		"report",
		{
			title: "Evaluation report",
			description:
				"Read a retained paired-evaluation report by result ID: per-case outcomes, regressions and metric coverage. Same as `agent-profiles migrate report --json`. Read-only.",
			inputSchema: z.object({ resultId: z.string().min(1) }),
			annotations: READ_ONLY,
		},
		guarded(({ resultId }: { resultId: string }) =>
			json(
				migrationEvaluationReport({
					storeRoot: options.storeRoot,
					id: resultId,
				}),
			),
		),
	);

	return server;
}

/** Serve over stdio. stdout carries the protocol: never print to it. */
export function startMcpServer(options: McpOptions = {}): StdioServerHandle {
	return serveStdio(() => createServer(options), {
		onerror: (error) =>
			process.stderr.write(`Agent Profiles MCP: ${errorMessage(error)}\n`),
	});
}
