import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import {
	applyConfigEdit,
	configRevision,
	EditConflict,
	profileChoices,
} from "./config-edit.ts";
import { resolutionOutput } from "./diagnostics.ts";
import { errorMessage } from "./files.ts";
import { ownVersion } from "./install.ts";
import { integrations } from "./integrations.ts";
import { resolveInstructions, validateConfiguration } from "./resolve.ts";
import {
	compareSkills,
	parseSkillSelector,
	skillCatalog,
} from "./skill-catalog.ts";

// Only these package assets are served; repository paths never become HTTP paths.
const assets = new Map<string, [string, string]>([
	["", ["index.html", "text/html"]],
	["app.js", ["app.js", "text/javascript"]],
	["style.css", ["style.css", "text/css"]],
]);

const builtinPolicy =
	"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** The installed visualizer app, served from the project's node_modules. */
export const visualizerPackage = "@guisam/agent-profiles-visualizer";

// The app's build may contain only these file types; anything else is a 404.
const appTypes = new Map<string, string>([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml; charset=utf-8"],
	[".png", "image/png"],
	[".ico", "image/x-icon"],
	[".woff2", "font/woff2"],
	[".woff", "font/woff"],
	[".ttf", "font/ttf"],
	[".eot", "application/vnd.ms-fontobject"],
]);

/** The app may add styles only with the per-response nonce, never inline. */
function appPolicy(nonce?: string) {
	const styles = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
	return `default-src 'none'; script-src 'self'; style-src ${styles}; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
}

export type VisualizerUi =
	| { kind: "builtin"; note?: string }
	| {
			kind: "app";
			name: string;
			version: string;
			directory: string;
			warning?: string;
	  };

/**
 * Whether `version` (x.y.z) satisfies a peer range: `||` alternatives of
 * comparators `>=`, `>`, `<=`, `<`, `=`, `^` and `~`. Null when the range uses
 * any other syntax.
 */
export function satisfiesRange(version: string, range: string) {
	const parse = (text: string) => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text);
		return match ? match.slice(1).map(Number) : null;
	};
	const compare = (a: number[], b: number[]) =>
		a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	const current = parse(version);
	if (!current) return null;
	let parsedAll = true;
	const result = range.split("||").some((alternative) =>
		alternative
			.trim()
			.split(/\s+/)
			.every((comparator) => {
				const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
				const bound = match && parse(match[2]);
				if (!match || !bound) {
					parsedAll = false;
					return false;
				}
				const order = compare(current, bound);
				switch (match[1]) {
					case ">=":
						return order >= 0;
					case ">":
						return order > 0;
					case "<=":
						return order <= 0;
					case "<":
						return order < 0;
					case "^": {
						// ^0.y.z stays within 0.y; ^x.y.z within x.
						const upper =
							bound[0] > 0 ? [bound[0] + 1, 0, 0] : [0, bound[1] + 1, 0];
						return order >= 0 && compare(current, upper) < 0;
					}
					case "~":
						return (
							order >= 0 && compare(current, [bound[0], bound[1] + 1, 0]) < 0
						);
					default:
						return order === 0;
				}
			}),
	);
	return parsedAll ? result : null;
}

/**
 * Find the visualizer app installed in the project: its package.json resolved
 * from `root`, and a `dist/index.html` beside it. Without one, the built-in
 * page is served.
 */
export function findVisualizerApp(
	root: string,
	agentProfilesVersion: string,
): VisualizerUi {
	let manifestPath: string;
	try {
		manifestPath = createRequire(path.join(root, "package.json")).resolve(
			`${visualizerPackage}/package.json`,
		);
	} catch {
		return { kind: "builtin" };
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const dist = path.join(path.dirname(manifestPath), "dist");
	if (!existsSync(path.join(dist, "index.html")))
		return {
			kind: "builtin",
			note: `${visualizerPackage} ${manifest.version} has no dist/index.html`,
		};
	const range = manifest.peerDependencies?.["@guisam/agent-profiles"];
	const supported =
		typeof range === "string"
			? satisfiesRange(agentProfilesVersion, range)
			: null;
	return {
		kind: "app",
		name: visualizerPackage,
		version: String(manifest.version),
		directory: realpathSync(dist),
		...(supported === false
			? {
					warning: `${visualizerPackage} ${manifest.version} supports @guisam/agent-profiles ${range}; this is ${agentProfilesVersion}`,
				}
			: {}),
	};
}

/**
 * The app file for a route, or null. Paths are decoded and checked segment by
 * segment: no empty, dot or dotfile segments, no backslashes or colons, a known
 * extension, and a regular file that stays inside `directory` after symlinks.
 */
function appFile(directory: string, route: string) {
	let decoded: string;
	try {
		decoded = decodeURIComponent(route || "index.html");
	} catch {
		return null;
	}
	const segments = decoded.split("/");
	if (
		segments.some(
			(segment) =>
				!segment || segment.startsWith(".") || /[\\:\0]/.test(segment),
		)
	)
		return null;
	const type = appTypes.get(path.extname(decoded).toLowerCase());
	if (!type) return null;
	try {
		const file = realpathSync(path.join(directory, ...segments));
		if (!file.startsWith(directory + path.sep) || !statSync(file).isFile())
			return null;
		return { file, type, index: decoded === "index.html" };
	} catch {
		return null;
	}
}

export type VisualizerOptions = {
	root?: string;
	port?: number;
	host?: string;
	model?: string;
	family?: string;
	role?: string;
	skills?: string[];
	storeRoot?: string;
	/** Accept POST api/edit configuration edits; off unless explicitly enabled. */
	allowEdits?: boolean;
	/** "auto" serves the installed visualizer app if any; "builtin" never does. */
	ui?: "auto" | "builtin";
};

export async function startVisualizer({
	root = process.cwd(),
	port = 0,
	host,
	model,
	family,
	role,
	skills = [],
	storeRoot,
	allowEdits = false,
	ui: uiChoice = "auto",
}: VisualizerOptions = {}) {
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("port must be an integer from 0 to 65535");
	if (uiChoice !== "auto" && uiChoice !== "builtin")
		throw new Error('ui must be "auto" or "builtin"');
	const initial = resolveInstructions({
		root,
		host,
		model,
		family,
		role,
		skills,
		storeRoot,
	});
	const ui: VisualizerUi =
		uiChoice === "builtin"
			? { kind: "builtin" }
			: findVisualizerApp(root, ownVersion);
	const token = randomBytes(24).toString("hex");
	const prefix = `/${token}/`;
	let origin = "";
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader(
			"Content-Security-Policy",
			ui.kind === "app" ? appPolicy() : builtinPolicy,
		);
		const send = (status: number, data: unknown) => {
			response.writeHead(status, {
				"Content-Type": "application/json; charset=utf-8",
			});
			response.end(JSON.stringify(data));
		};
		if (
			request.headers.host !== new URL(origin).host ||
			(request.headers.origin && request.headers.origin !== origin) ||
			request.headers["sec-fetch-site"] === "cross-site"
		)
			return send(403, { error: "Local same-origin access only" });
		const url = new URL(request.url ?? "", origin);
		const route = url.pathname.startsWith(prefix)
			? url.pathname.slice(prefix.length)
			: null;
		if (route === "api/edit" && request.method === "POST" && allowEdits) {
			// Writes need the session token, an explicit same-origin Origin, a JSON body
			// (cross-origin pages cannot send it without a CORS preflight we never answer)
			// and a custom header.
			if (
				request.headers.origin !== origin ||
				!request.headers["content-type"]?.startsWith("application/json") ||
				request.headers["x-agent-profiles-edit"] !== "1"
			)
				return send(403, { error: "Edits require a same-origin page request" });
			const chunks: Buffer[] = [];
			let size = 0;
			request.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 65536) request.destroy();
				else chunks.push(chunk);
			});
			request.on("end", () => {
				try {
					const { revision, edit } = JSON.parse(
						Buffer.concat(chunks).toString("utf8"),
					);
					send(200, applyConfigEdit({ root, storeRoot, revision, edit }));
				} catch (error) {
					send(error instanceof EditConflict ? 409 : 400, {
						error: errorMessage(error),
					});
				}
			});
			return;
		}
		if (request.method !== "GET")
			return send(405, {
				error: allowEdits
					? "GET required, or POST to api/edit"
					: "Read-only: GET required",
			});
		try {
			if (route === null) return send(404, { error: "Not found" });
			const asset = ui.kind === "builtin" ? assets.get(route) : undefined;
			const appAsset =
				ui.kind === "app" && !route.startsWith("api/")
					? appFile(ui.directory, route)
					: null;
			if (ui.kind === "app" && !route.startsWith("api/") && !appAsset)
				return send(404, { error: "Not found" });
			if (appAsset) {
				let body: Buffer | string = readFileSync(appAsset.file);
				if (appAsset.index) {
					// A fresh nonce per page: Vuetify reads it from the meta element
					// and adds it to the one <style> element it creates.
					const nonce = randomBytes(16).toString("base64");
					response.setHeader("Content-Security-Policy", appPolicy(nonce));
					const meta = `<meta name="csp-nonce" content="${nonce}">`;
					const html = body.toString("utf8");
					const head = /<head(\s[^>]*)?>/i.exec(html);
					body = head
						? html.slice(0, head.index + head[0].length) +
							meta +
							html.slice(head.index + head[0].length)
						: meta + html;
				}
				response.writeHead(200, { "Content-Type": appAsset.type });
				response.end(body);
			} else if (asset) {
				const [file, type] = asset;
				const body = readFileSync(
					new URL(`./visualizer/${file}`, import.meta.url),
				);
				response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
				response.end(body);
			} else if (route === "api/config") {
				// Read from disk in both APIs: explicit configuration bypasses composition.
				// The resolver preflight enforces the composed lock and trust policy.
				// The revision is read first: a write after it is then a conflict, never missed.
				const revision = allowEdits ? configRevision(root) : null;
				resolveInstructions({ root, storeRoot });
				const configuration = validateConfiguration({ root });
				send(200, {
					editing: allowEdits
						? { revision, profiles: profileChoices(root) }
						: null,
					hosts: integrations.map((integration) => integration.id),
					models: [
						...new Set([
							...configuration.models.keys(),
							...configuration.aliases.keys(),
							...configuration.adapterModels,
						]),
					],
					families: [...configuration.families.keys()],
					roles: [...configuration.roles.keys()],
					optionalSkills: Object.fromEntries(
						[...configuration.roleSkills].map(([id, lists]) => [
							id,
							lists.available
								.filter((skill) => skill.type !== "host")
								.map((skill) => skill.id),
						]),
					),
					defaultRole: configuration.defaultRole,
					initial: {
						...(host ? { host } : {}),
						model: initial.model,
						family: family ?? null,
						role: initial.role,
						skills,
					},
				});
			} else if (route === "api/resolve") {
				for (const key of url.searchParams.keys()) {
					if (!["host", "model", "family", "role", "skill"].includes(key))
						throw new Error(`Unknown parameter: ${key}`);
					if (key !== "skill" && url.searchParams.getAll(key).length > 1)
						throw new Error(`Only one ${key} is supported`);
				}
				// The store is fixed by the server; no query parameter can select another.
				send(
					200,
					resolutionOutput(
						resolveInstructions({
							root,
							storeRoot,
							host: url.searchParams.get("host") ?? undefined,
							model: url.searchParams.get("model") ?? undefined,
							family: url.searchParams.get("family") ?? undefined,
							role: url.searchParams.get("role") ?? undefined,
							skills: url.searchParams.getAll("skill"),
						}),
						true,
					),
				);
			} else if (route === "api/skills") {
				if ([...url.searchParams.keys()].length)
					throw new Error("api/skills takes no parameters");
				resolveInstructions({ root, storeRoot });
				send(200, skillCatalog({ root, storeRoot }));
			} else if (route === "api/compare") {
				for (const key of url.searchParams.keys())
					if (!["left", "right"].includes(key))
						throw new Error(`Unknown parameter: ${key}`);
				const [left, right] = ["left", "right"].map((key) => {
					const values = url.searchParams.getAll(key);
					if (values.length !== 1)
						throw new Error(`Expected exactly one ${key} skill`);
					return parseSkillSelector(values[0]);
				});
				resolveInstructions({ root, storeRoot });
				send(200, compareSkills({ root, storeRoot, left, right }));
			} else send(404, { error: "Not found" });
		} catch (error) {
			send(400, { error: errorMessage(error) });
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve(undefined);
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected a TCP listener");
	origin = `http://127.0.0.1:${address.port}`;
	return { server, url: `${origin}${prefix}`, ui };
}
