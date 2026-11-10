// Session attribution (#38 phase 7). With `mcp --record-sessions` (or
// `resolve --record-session`), each resolution a session makes is written to a
// machine-local record: which stamp digest it ran, for which model, role, host and
// project, which package versions it selected and which the trust policy withheld.
// Records live only under ~/.agent-profiles/sessions/ (or AGENT_PROFILES_SESSIONS),
// never in the project or the store, so the MCP server stays read-only for
// everything else (#55). Recording never fails a resolution.
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAdapter, referenceDigest } from "./adapter.ts";
import { errorMessage } from "./files.ts";
import { previewStamp } from "./stamps.ts";

export const sessionsDirectory = () =>
	process.env.AGENT_PROFILES_SESSIONS ||
	path.join(os.homedir(), ".agent-profiles", "sessions");

type Package = {
	binding: string | null;
	skill: string;
	name: string;
	version: string;
	sha256: string;
	revisionDigest: string | null;
};

export type SessionResolution = {
	at: string;
	/** What produced it: the bound server instructions, a resolve/explain call, or the CLI. */
	via: "bound" | "resolve" | "explain" | "cli";
	root: string;
	host: string | null;
	model: string | null;
	role: string;
	profile: string;
	/** The stamp digest of the configured selection (`verify` reads it if retained). */
	stamp: string | null;
	stampError?: string;
	/**
	 * #98: whether an adapter composed, and which composed configuration ran. Results
	 * from different modes or configuration digests are different configurations.
	 * Absent from records written before 0.22.0.
	 */
	configuration?: SessionConfiguration;
	packages: Package[];
	withheld: { id: string; name: string; version: string; reason: string }[];
	/** Requested skills (`--skill` / `skills`) loaded in this call. */
	requested: string[];
};

export type SessionConfiguration =
	| { mode: "committed" }
	| {
			mode: "composed";
			/** The composed configuration digest (the adapter lock's configSha256); null without a stamp. */
			digest: string | null;
			/** The adapter by label and reference digest, never its machine path. */
			adapter: { label: string | null; referenceDigest: string } | null;
	  };

export type SessionRecord = {
	schema: 1;
	id: string;
	startedAt: string;
	source: "mcp" | "cli";
	agentProfiles: string;
	client: { name: string; version: string } | null;
	resolutions: SessionResolution[];
};

type ResolveSelectors = {
	root?: string;
	storeRoot?: string;
	host?: string;
	model?: string;
	family?: string;
	identitySource?: "host" | "host-stated" | "user";
	role?: string;
	skills?: string[];
};

type Entry = {
	id: string;
	kind?: string;
	package?: {
		binding?: string;
		name: string;
		version: string;
		sha256: string;
		revisionDigest?: string | null;
	};
};

// The parts of a resolution a record keeps.
type Resolution = {
	host: string | null;
	model: string | null;
	role: string;
	profile: string;
	required: Entry[];
	available: Entry[];
	loaded: Entry[];
	withheld?: {
		id: string;
		package: { name: string; version: string };
		reason: string;
	}[];
	/** Present when an adapter composed (#85). */
	adapter?: unknown;
};

function packagesOf(resolution: Resolution): Package[] {
	const out = new Map<string, Package>();
	for (const entry of [
		...resolution.required,
		...resolution.available,
		...resolution.loaded,
	]) {
		const pkg = entry.package;
		if (!pkg) continue;
		const key = `${pkg.binding ?? entry.id}:${pkg.name}@${pkg.version}`;
		if (!out.has(key))
			out.set(key, {
				binding: pkg.binding ?? null,
				skill: entry.id,
				name: pkg.name,
				version: pkg.version,
				sha256: pkg.sha256,
				revisionDigest: pkg.revisionDigest ?? null,
			});
	}
	return [...out.values()];
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export type SessionRecorder = {
	readonly id: string;
	/** Record one resolution; never throws (a failure is reported on stderr). */
	record(
		via: SessionResolution["via"],
		selected: ResolveSelectors & { root: string },
		resolution: Resolution,
		client?: { name: string; version: string } | null,
	): void;
};

/**
 * One record file per session (an MCP server's lifetime, or one CLI call),
 * created on the first resolution and rewritten atomically on each later one.
 */
export function createSessionRecorder({
	source,
	agentProfiles,
	now = () => new Date(),
	warn = (message: string) =>
		process.stderr.write(`Agent Profiles: ${message}\n`),
}: {
	source: SessionRecord["source"];
	agentProfiles: string;
	now?: () => Date;
	warn?: (message: string) => void;
}): SessionRecorder {
	const started = now();
	const id = `${timestamp(started).replace(/[-:]/g, "")}-${randomBytes(4).toString("hex")}`;
	const file = path.join(
		sessionsDirectory(),
		timestamp(started).slice(0, 10),
		`${id}.json`,
	);
	const record: SessionRecord = {
		schema: 1,
		id,
		startedAt: timestamp(started),
		source,
		agentProfiles,
		client: null,
		resolutions: [],
	};
	let warned = false;
	return {
		id,
		record(via, selected, resolution, client) {
			try {
				if (client) record.client = client;
				let stamp: string | null = null;
				let stampError: string | undefined;
				let configuration: SessionConfiguration = { mode: "committed" };
				try {
					const preview = previewStamp({
						root: selected.root,
						storeRoot: selected.storeRoot,
						host: selected.host,
						model: selected.model,
						family: selected.family,
						identitySource: selected.identitySource,
						role: selected.role,
					});
					stamp = preview.digest;
					const composed = preview.snapshot.configurationSources;
					if (composed)
						configuration = {
							mode: "composed",
							digest: composed.configuration.digest,
							adapter: { ...composed.adapter },
						};
				} catch (error) {
					stampError = errorMessage(error);
				}
				// Without a stamp, the resolution still says whether an adapter composed.
				if (stamp === null && resolution.adapter) {
					let adapter = null;
					try {
						const found = readAdapter(selected.root);
						if (found)
							adapter = {
								label: found.label,
								referenceDigest: referenceDigest(found.reference),
							};
					} catch {}
					configuration = { mode: "composed", digest: null, adapter };
				}
				record.resolutions.push({
					at: timestamp(now()),
					via,
					root: selected.root,
					host: resolution.host,
					model: resolution.model,
					role: resolution.role,
					profile: resolution.profile,
					stamp,
					...(stampError ? { stampError } : {}),
					configuration,
					packages: packagesOf(resolution),
					withheld: (resolution.withheld ?? []).map((entry) => ({
						id: entry.id,
						name: entry.package.name,
						version: entry.package.version,
						reason: entry.reason,
					})),
					requested: resolution.loaded
						.filter((entry) => entry.kind === "requested-skill")
						.map((entry) => entry.id),
				});
				mkdirSync(path.dirname(file), { recursive: true });
				const temporary = `${file}.${process.pid}.tmp`;
				writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
				renameSync(temporary, file);
			} catch (error) {
				if (!warned)
					warn(`session record not written (${errorMessage(error)})`);
				warned = true;
			}
		},
	};
}

/** Records for a project (or every project), newest first. Unreadable files are reported. */
export function listSessions({
	root,
	limit = 20,
}: {
	root?: string;
	limit?: number;
} = {}) {
	const directory = sessionsDirectory();
	const records: SessionRecord[] = [];
	const problems: string[] = [];
	if (existsSync(directory))
		for (const day of readdirSync(directory).sort().reverse()) {
			const dayDirectory = path.join(directory, day);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
			for (const name of readdirSync(dayDirectory).sort().reverse()) {
				if (!name.endsWith(".json")) continue;
				try {
					const record = JSON.parse(
						readFileSync(path.join(dayDirectory, name), "utf8"),
					) as SessionRecord;
					if (record.schema !== 1 || !Array.isArray(record.resolutions))
						throw new Error("not a session record");
					if (
						root !== undefined &&
						!record.resolutions.some((entry) => entry.root === root)
					)
						continue;
					records.push(record);
				} catch (error) {
					problems.push(`${day}/${name}: ${errorMessage(error)}`);
				}
			}
		}
	records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return {
		directory,
		root: root ?? null,
		sessions: records.slice(0, limit),
		total: records.length,
		problems,
	};
}

export function formatSessions(result: ReturnType<typeof listSessions>) {
	const lines = [
		`Session records in ${result.directory}${result.root ? ` for ${result.root}` : ""}`,
	];
	if (!result.sessions.length)
		lines.push(
			"",
			"None. Start the MCP server with --record-sessions, or run resolve --record-session.",
		);
	for (const session of result.sessions) {
		lines.push(
			"",
			`${session.startedAt}  ${session.id}  (${session.source}${session.client ? `, ${session.client.name} ${session.client.version}` : ""}; agent-profiles ${session.agentProfiles})`,
		);
		for (const entry of session.resolutions)
			lines.push(
				`  ${entry.at} ${entry.via}: ${entry.role} × ${entry.model ?? "no model"} × ${entry.host ?? "no host"} → ${entry.profile}; stamp ${entry.stamp ?? `unavailable (${entry.stampError})`}`,
				...(entry.configuration?.mode === "composed"
					? [
							`    configuration: composed with adapter ${entry.configuration.adapter?.label ?? (entry.configuration.adapter ? `reference ${entry.configuration.adapter.referenceDigest.slice(0, 12)}` : "unknown")}; sha256 ${entry.configuration.digest ?? "unavailable"}`,
						]
					: []),
				...entry.packages.map(
					(pkg) => `    ${pkg.skill}: ${pkg.name}@${pkg.version}`,
				),
				...entry.withheld.map(
					(item) =>
						`    ${item.id}: withheld (${item.name}@${item.version}: ${item.reason})`,
				),
			);
	}
	if (result.total > result.sessions.length)
		lines.push(
			"",
			`${result.total - result.sessions.length} older not shown; use --limit.`,
		);
	for (const problem of result.problems) lines.push(`Unreadable: ${problem}`);
	return lines.join("\n");
}
