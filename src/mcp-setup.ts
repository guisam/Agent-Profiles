// Per-host MCP server setup: the snippet init prints and the project file doctor checks.
// Read-only: Agent Profiles never writes host MCP configuration. No SDK import.
import { readLocal } from "./files.ts";
import { adapterFor } from "./integrations.ts";

/** The server name the managed block's MCP handoff refers to. */
export const MCP_SERVER = "agent-profiles";

export type McpSetup = {
	host: string;
	/** Project file doctor can check, or null when the host keeps MCP servers only in user configuration. */
	file: string | null;
	/** What to run or add; printed verbatim. */
	snippet: string;
	/** Host conditions that apply even when the file is present. */
	caveat?: string;
};

const args = (host: string) => [
	"--no",
	"agent-profiles",
	"mcp",
	"--host",
	host,
];

export function mcpSetup(host: string): McpSetup {
	adapterFor(host); // Unknown hosts are an error, as everywhere else.
	switch (host) {
		case "claude":
			return {
				host,
				file: ".mcp.json",
				snippet: `claude mcp add --scope project ${MCP_SERVER} -- npx ${args(host).join(" ")}`,
				caveat:
					"Claude Code asks each user to approve project-scope servers from .mcp.json",
			};
		case "codex":
			return {
				host,
				file: ".codex/config.toml",
				snippet: [
					`[mcp_servers.${MCP_SERVER}]`,
					'command = "npx"',
					`args = [${args(host)
						.map((value) => JSON.stringify(value))
						.join(", ")}]`,
				].join("\n"),
				caveat:
					"Codex reads a project's .codex/config.toml only when the project is trusted; ~/.codex/config.toml also works",
			};
		case "opencode":
			return {
				host,
				file: "opencode.json",
				snippet: JSON.stringify(
					{
						mcp: {
							[MCP_SERVER]: {
								type: "local",
								command: ["npx", ...args(host)],
							},
						},
					},
					null,
					2,
				),
			};
		case "hermes":
			return {
				host,
				file: null,
				snippet: [
					"mcp_servers:",
					`  ${MCP_SERVER}:`,
					'    command: "npx"',
					`    args: [${args(host)
						.map((value) => JSON.stringify(value))
						.join(", ")}]`,
				].join("\n"),
				caveat:
					"Hermes reads MCP servers from ~/.hermes/config.yaml only; if it starts the server outside this repository, add --root <repository> to args",
			};
		default:
			throw new Error(`No MCP setup is defined for ${host}`);
	}
}

/**
 * Whether the project file names the agent-profiles server: true or false for a
 * checkable file, null when the host keeps servers in user configuration.
 * A server configured at user scope is not seen, so false is "not found here".
 */
export function mcpConfigured(root: string, host: string): boolean | null {
	const { file } = mcpSetup(host);
	if (file === null) return null;
	const content = readLocal(root, file)?.toString("utf8");
	if (content === undefined) return false;
	if (file.endsWith(".toml"))
		return new RegExp(
			`^\\s*\\[mcp_servers\\.(?:${MCP_SERVER}|"${MCP_SERVER}")\\]`,
			"m",
		).test(content);
	try {
		const parsed = JSON.parse(content);
		const servers = host === "opencode" ? parsed?.mcp : parsed?.mcpServers;
		return Boolean(
			servers &&
				typeof servers === "object" &&
				Object.hasOwn(servers, MCP_SERVER),
		);
	} catch {
		return false;
	}
}

/** Lines init and doctor print for a host whose block hands off to MCP. */
export function mcpSetupLines(root: string, host: string): string[] {
	const { name } = adapterFor(host);
	const setup = mcpSetup(host);
	const configured = mcpConfigured(root, host);
	if (configured === true)
		return [
			`${name}: MCP handoff enabled; ${setup.file} names the ${MCP_SERVER} server${setup.caveat ? ` (${setup.caveat})` : ""}`,
		];
	const where =
		configured === null
			? `${name} keeps MCP servers in user configuration, which Agent Profiles does not read`
			: `${setup.file} does not name the ${MCP_SERVER} server (user-scope configuration is not checked)`;
	return [
		`${name}: MCP handoff enabled; ${where}. Until a server is connected the block falls back to the shell command. To add it:`,
		...setup.snippet.split("\n").map((line) => `    ${line}`),
		...(setup.caveat ? [`  ${setup.caveat}.`] : []),
	];
}
