// Read-only MCP service over the existing resolver, stamp, evaluation and library
// APIs (#39, #58). Read-only is an invariant (#55): no tool writes, ever.
// Only the `mcp` command imports this module, so other commands never load the SDK.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CLIENT_CAPABILITIES_META_KEY,
	type InputRequiredResult,
	inputRequired,
	McpServer,
	ResourceTemplate,
	type ServerContext,
} from "@modelcontextprotocol/server";
import {
	type StdioServerHandle,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { formatContext, resolutionOutput } from "./diagnostics.ts";
import { errorMessage } from "./files.ts";
import { ownVersion } from "./install.ts";
import { RESOLVE_INCOMPLETE } from "./integrations.ts";
import {
	formatLibrary,
	formatLibraryEvidence,
	formatLibraryFile,
	formatLibraryInfo,
	libraryEvidence,
	libraryInfo,
	listLibrary,
	readLibraryFile,
	searchLibrary,
} from "./library.ts";
import { migrationEvaluationReport } from "./migrations.ts";
import {
	formatOutdated,
	formatUpdate,
	outdatedPins,
	previewUpdate,
} from "./outdated.ts";
import { type ResolveOptions, resolveInstructions } from "./resolve.ts";
import { findRoot } from "./root.ts";
import { createSessionRecorder } from "./sessions.ts";
import { diffStamps, previewStamp, verifyStamp } from "./stamps.ts";

export type McpOptions = {
	/** Project root for every tool call; otherwise the server's working directory is searched. */
	root?: string;
	/** Package store; tools never choose a store. */
	storeRoot?: string;
	/** Session binding; a tool call may repeat a bound value but not replace it (#80). */
	host?: string;
	model?: string;
	family?: string;
	identitySource?: ResolveOptions["identitySource"];
	role?: string;
	/** Working directory used when no root is given (tests pass their own). */
	cwd?: string;
	/** #38 phase 7: write a machine-local session record of each resolution. */
	recordSessions?: boolean;
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
const failure = (error: unknown, after?: string): ToolResult => ({
	content: [
		{
			type: "text",
			text: [`Agent Profiles: ${errorMessage(error)}`, after]
				.filter(Boolean)
				.join("\n"),
		},
	],
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
): ResolveOptions & { root: string } {
	// A bound server's selectors are the operator's choice: an agent's own guess must not replace them (#80).
	for (const key of [
		"host",
		"model",
		"family",
		"identitySource",
		"role",
	] as const)
		if (
			options[key] !== undefined &&
			args[key] !== undefined &&
			args[key] !== options[key]
		)
			throw new Error(
				`this server is bound to ${key} ${JSON.stringify(options[key])}; omit ${key}, or ask the user to start a server bound to ${JSON.stringify(args[key])}`,
			);
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

const LIBRARY =
	"Library tools (`library_list`, `library_search`, `library_info`, `library_read`, `library_evidence`, `outdated`, `update_preview`) only read. Read package files with `library_read` or the `agent-profiles://library` resources, which verify the package first; don't open files in the store folder directly, since nothing verifies them there. To change a pin, show the user the `update_preview` result, including every entry in its `edits` list (not only the rule), and give them its `applyCommand` exactly as returned to run themselves.";

// Shared by bound and unbound sessions: the instructions never carry the profile itself (#80).
// Hosts truncate server instructions (Claude Code cut them inside the first skill), so only
// `resolve` output, which ends with a checkable final line, counts as delivery.
const RETRIEVE = [
	"These instructions do not contain your profile, role or skills. Call `resolve` before any role work, and again after `/clear`, context compaction, or a model or role change. Every tool is read-only.",
	`If \`resolve\` is unavailable or fails in any way, or its output lacks its final \`End of Agent Profiles context:\` line: ${RESOLVE_INCOMPLETE}`,
];

const UNBOUND = [
	"# Agent Profiles",
	"",
	"This server selects repository instructions and skills by model, role and host.",
	"Call the `resolve` tool with your exact model ID (and `role`, if you were assigned one), then follow its output.",
	...RETRIEVE,
	LIBRARY,
].join("\n");

/**
 * Server instructions: a short retrieval bootstrap. A bound session names its selection
 * and stamp but never embeds resolved text. Never throws; a failed resolution is reported.
 */
export function serverInstructions(options: McpOptions): string {
	if (options.model === undefined && options.role === undefined) return UNBOUND;
	try {
		const selected = selectors(options, {});
		resolveInstructions(selected); // validates the binding; the text is not embedded
		const bound = [
			selected.host && `host ${selected.host}`,
			selected.model && `model ${selected.model}`,
			selected.role && `role ${selected.role}`,
		].filter(Boolean);
		return [
			`# Agent Profiles (bound: ${bound.join(", ")})`,
			stampLine(selected),
			"",
			"This server is bound to the selection above. Call the `resolve` tool without repeating the bound values; add your exact model ID only when no model is bound. Values that conflict with the binding are refused.",
			...RETRIEVE,
			LIBRARY,
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
		const { digest, retained, snapshot } = previewStamp({
			root: selected.root,
			storeRoot: selected.storeRoot,
			host: selected.host,
			model: selected.model,
			family: selected.family,
			identitySource: selected.identitySource,
			role: selected.role,
		});
		// #98: a composed stamp names its adapter by label or reference digest, never a path.
		const composed = snapshot.configurationSources;
		const configuration = composed
			? ` Configuration: composed with adapter ${composed.adapter.label ?? `reference ${composed.adapter.referenceDigest.slice(0, 12)}`}; configuration sha256 ${composed.configuration.digest}.`
			: "";
		return retained
			? `Stamp: sha256 ${digest} (retained in the store; the \`verify\` tool reads it).${configuration}`
			: `Stamp: sha256 ${digest} (not retained; \`agent-profiles stamp\` with the same selectors records this digest).${configuration}`;
	} catch (error) {
		return `Stamp: unavailable (${errorMessage(error)}).`;
	}
}

export function createServer(options: McpOptions = {}): McpServer {
	const server = new McpServer(
		{ name: "agent-profiles", version: ownVersion },
		{ instructions: serverInstructions(options) },
	);
	// Session records (#38 phase 7) go only to the machine-local sessions folder.
	const recorder = options.recordSessions
		? createSessionRecorder({ source: "mcp", agentProfiles: ownVersion })
		: null;
	const client = () => {
		const info = server.server.getClientVersion();
		return info ? { name: info.name, version: info.version } : null;
	};
	const resolved = (
		via: "resolve" | "explain",
		selected: ResolveOptions & { root: string },
	) => {
		const result = resolveInstructions(selected);
		recorder?.record(via, selected, result, client());
		return result;
	};
	if (recorder && (options.model !== undefined || options.role !== undefined))
		try {
			const selected = selectors(options, {});
			recorder.record("bound", selected, resolveInstructions(selected));
		} catch {
			// The instructions already report a failed bound resolution.
		}

	// Tools that select a project ask the host for its workspace roots only when
	// neither a root argument nor --root names one and the client offers roots.
	// The SDK carries the request in-band (2026-07-28) or as roots/list (2025 eras).
	const withProject =
		<A extends { root?: string }>(
			run: (args: A, workspace?: string) => ToolResult,
			onFailure?: string,
		) =>
		async (
			args: A,
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
				return failure(error, onFailure);
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
		withProject(
			(args, workspace) =>
				text(
					formatContext(
						resolved("resolve", selectors(options, args, workspace)),
						{ invocation: "mcp" },
					),
				),
			RESOLVE_INCOMPLETE,
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
					resolved("explain", selectors(options, args, workspace)),
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

	// --- Librarian tools (#58): the library, evidence, outdated pins and update
	// previews, all read-only. The store is always the server's --store.

	// A project is optional for library_info/library_evidence (it adds pins and origin):
	// use one only when named or offered, never the working-directory fallback.
	const optionalRoot = (args: { root?: string }, workspace?: string) =>
		args.root !== undefined || options.root !== undefined
			? projectRoot(options, args.root)
			: workspace;
	const both = (value: unknown, rendered: string): ToolResult => ({
		content: [{ type: "text", text: rendered }],
		structuredContent: JSON.parse(JSON.stringify(value)) as Record<
			string,
			unknown
		>,
	});
	const rootArg = z
		.string()
		.optional()
		.describe(
			"Project directory. Defaults to the server's --root, the host's workspace root, or the repository containing its working directory.",
		);
	const packageName = z
		.string()
		.min(1)
		.describe("Package name, @namespace/name.");
	const version = z
		.string()
		.optional()
		.describe("One exact version; omit for all versions.");

	server.registerTool(
		"library_list",
		{
			title: "List the library",
			description:
				"Every package in the local library with its versions, newest first, and the latest version's type and description. Same as `agent-profiles library list --json`. Read-only.",
			inputSchema: z.object({
				type: z.enum(["skill", "instruction"]).optional(),
			}),
			annotations: READ_ONLY,
		},
		guarded(({ type }: { type?: "skill" | "instruction" }) => {
			const result = listLibrary({ storeRoot: options.storeRoot, type });
			return both(result, formatLibrary(result));
		}),
	);

	server.registerTool(
		"library_search",
		{
			title: "Search the library",
			description:
				"Packages whose name or description contains the text (case-insensitive). Same as `agent-profiles library search --json`. Read-only.",
			inputSchema: z.object({ text: z.string().min(1) }),
			annotations: READ_ONLY,
		},
		guarded(({ text: query }: { text: string }) => {
			const result = searchLibrary({
				storeRoot: options.storeRoot,
				text: query,
			});
			return both(result, formatLibrary(result));
		}),
	);

	server.registerTool(
		"library_info",
		{
			title: "Package details",
			description:
				"Verified details of every version of a package (or one version): digest, type, delivery, hosts, effects, files, and retained evaluation evidence. With a project, also which versions it pins. Same as `agent-profiles library info --json`. Read-only.",
			inputSchema: z.object({ name: packageName, version, root: rootArg }),
			annotations: READ_ONLY,
		},
		withProject(
			(args: { name: string; version?: string; root?: string }, workspace) => {
				const result = libraryInfo({
					storeRoot: options.storeRoot,
					name: args.name,
					version: args.version,
					root: optionalRoot(args, workspace),
				});
				return both(result, formatLibraryInfo(result));
			},
		),
	);

	server.registerTool(
		"library_read",
		{
			title: "Read a package file",
			description:
				"One file of a library version, such as its SKILL.md, read only after the version verifies against its digest. Use this (or the agent-profiles://library resources) to read package files; files opened directly in the store folder are not verified. Same as `agent-profiles library read --json`. Read-only.",
			inputSchema: z.object({
				name: packageName,
				version: z.string().min(1).describe("One exact version."),
				path: z
					.string()
					.min(1)
					.describe("File path within the package, such as SKILL.md."),
			}),
			annotations: READ_ONLY,
		},
		guarded(
			({
				name,
				version: exact,
				path: file,
			}: {
				name: string;
				version: string;
				path: string;
			}) => {
				const result = readLibraryFile({
					storeRoot: options.storeRoot,
					name,
					version: exact,
					path: file,
				});
				return both(result, formatLibraryFile(result));
			},
		),
	);

	server.registerTool(
		"library_evidence",
		{
			title: "Evaluation evidence",
			description:
				"Retained paired evaluations for a package, per exact role, model and host: outcome, correctness, metric deltas, and whether the evidence came from this project or another. With a filter, versions without matching evidence are listed as untested. Same as `agent-profiles library evidence --json`. Read-only.",
			inputSchema: z.object({
				name: packageName,
				version,
				model: z.string().optional(),
				role: z.string().optional(),
				host: z.string().optional(),
				root: rootArg,
			}),
			annotations: READ_ONLY,
		},
		withProject(
			(
				args: {
					name: string;
					version?: string;
					model?: string;
					role?: string;
					host?: string;
					root?: string;
				},
				workspace,
			) => {
				const result = libraryEvidence({
					storeRoot: options.storeRoot,
					name: args.name,
					version: args.version,
					root: optionalRoot(args, workspace),
					filter: { model: args.model, role: args.role, host: args.host },
				});
				return both(result, formatLibraryEvidence(result));
			},
		),
	);

	server.registerTool(
		"outdated",
		{
			title: "Outdated pins",
			description:
				"Every package pin in the project, the tuples it serves, newer library versions, and each newer version's evidence for those tuples. Same as `agent-profiles outdated --json`. Read-only.",
			inputSchema: z.object({
				model: z.string().optional(),
				role: z.string().optional(),
				host: z.string().optional(),
				root: rootArg,
			}),
			annotations: READ_ONLY,
		},
		withProject(
			(
				args: { model?: string; role?: string; host?: string; root?: string },
				workspace,
			) => {
				const result = outdatedPins({
					root: projectRoot(options, args.root, workspace),
					storeRoot: options.storeRoot,
					filter: { model: args.model, role: args.role, host: args.host },
				});
				return both(result, formatOutdated(result));
			},
		),
	);

	server.registerTool(
		"update_preview",
		{
			title: "Preview an update",
			description:
				"Preview moving one exact role × model × host pin to another library version: the rule that changes, the selections that change, the evidence, and a unified diff of the text it would inject. Never applies. When you summarize it, report every entry in `edits` (there can be more than the rule: a model declaration is also an edit) and give the user its `applyCommand` exactly as returned; only the user can run it, in a terminal. Read-only.",
			inputSchema: z.object({
				binding: z
					.string()
					.min(1)
					.describe("Binding ID, such as skills.review."),
				version: z.string().min(1),
				model: z.string().min(1),
				role: z.string().min(1),
				host: z.string().min(1),
				root: rootArg,
			}),
			annotations: READ_ONLY,
		},
		withProject(
			(
				args: {
					binding: string;
					version: string;
					model: string;
					role: string;
					host: string;
					root?: string;
				},
				workspace,
			) => {
				const result = previewUpdate({
					root: projectRoot(options, args.root, workspace),
					storeRoot: options.storeRoot,
					binding: args.binding,
					version: args.version,
					assignment: {
						role: args.role,
						model: args.model,
						host: args.host,
					},
				});
				return both(result, formatUpdate(result));
			},
		),
	);

	// Package files as resources (#58): any file of a verified library version.
	// The list offers each version's entrypoint; reads verify the object first.
	const LIBRARY_URI = "agent-profiles://library";
	const mimeType = (file: string) =>
		/\.md$/i.test(file)
			? "text/markdown"
			: /\.ya?ml$/i.test(file)
				? "application/yaml"
				: /\.json$/i.test(file)
					? "application/json"
					: "text/plain";
	server.registerResource(
		"library-file",
		new ResourceTemplate(`${LIBRARY_URI}/{scope}/{name}/{version}/{+path}`, {
			list: async () => {
				const { packages } = listLibrary({ storeRoot: options.storeRoot });
				const resources = [];
				for (const item of packages) {
					const info = libraryInfo({
						storeRoot: options.storeRoot,
						name: item.name,
					});
					for (const entry of info.versions)
						if (!("error" in entry))
							resources.push({
								uri: `${LIBRARY_URI}/${item.name}/${entry.version}/${entry.entrypoint}`,
								name: `${item.name}@${entry.version}`,
								title: `${item.name}@${entry.version} ${entry.entrypoint}`,
								description: entry.description ?? undefined,
								mimeType: mimeType(entry.entrypoint),
							});
				}
				return { resources };
			},
		}),
		{
			title: "Library package file",
			description:
				"A file of a verified package version in the local library, such as a skill's SKILL.md. Read-only.",
		},
		async (uri, variables) => {
			const one = (value: string | string[] | undefined) =>
				Array.isArray(value) ? value.join("/") : (value ?? "");
			const name = `${one(variables.scope)}/${one(variables.name)}`;
			const version = one(variables.version);
			const file = decodeURIComponent(one(variables.path));
			const read = readLibraryFile({
				storeRoot: options.storeRoot,
				name,
				version,
				path: file,
			});
			return {
				contents: [
					read.encoding === "base64"
						? {
								uri: uri.href,
								mimeType: "application/octet-stream",
								blob: read.base64,
							}
						: { uri: uri.href, mimeType: mimeType(file), text: read.text },
				],
			};
		},
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
