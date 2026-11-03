// Update notice (#49): tell the user, not the agent, when a project's pins have newer
// library versions. Quiet by construction: a cheap fingerprint of the store's indexes
// and the project's lock gates the work, a machine-local record (never in the
// repository) suppresses repeats, and at most one notice per project per day.
import { createHash } from "node:crypto";
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
import { readLocal } from "./files.ts";
import { outdatedPins } from "./outdated.ts";
import { storeRoot as selectStore } from "./package-store.ts";
import { validateConfiguration } from "./resolve.ts";

const LOCK = ".agent-profiles/agent-profiles.lock";
const CONFIG = ".agent-profiles/agents.yaml";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The store directories whose membership decides whether anything new could be reported. */
const INDEXES = [
	"identities",
	"revisions/labels",
	"evaluations/results/ids",
	"promotions/decisions/ids",
];

export type NoticeLevel = "all" | "actionable" | "off";

/** AGENT_PROFILES_NOTICE: all (default), actionable (no informational count), or off. */
export function noticeLevel(
	value = process.env.AGENT_PROFILES_NOTICE,
): NoticeLevel {
	if (value === undefined || value === "" || value === "all") return "all";
	if (value === "actionable" || value === "off") return value;
	throw new Error(
		`AGENT_PROFILES_NOTICE: expected all, actionable or off, not ${JSON.stringify(value)}`,
	);
}

// Relative paths under each index directory (names only; no file is opened or hashed).
function listing(directory: string, prefix: string, out: string[]) {
	if (!existsSync(directory)) return;
	for (const name of readdirSync(directory, { withFileTypes: true })) {
		const relative = `${prefix}/${name.name}`;
		if (name.isDirectory())
			listing(path.join(directory, name.name), relative, out);
		else out.push(relative);
	}
}

/**
 * What the notice depends on: the store's identity, label, result and decision index
 * names, plus the project's configuration and lock bytes. Reading names only keeps a
 * session start cheap; nothing is verified here.
 */
export function noticeFingerprint(root: string, storeRoot?: string) {
	const store = selectStore(storeRoot);
	const names: string[] = [];
	for (const index of INDEXES) listing(path.join(store, index), index, names);
	names.sort();
	const hash = createHash("sha256");
	hash.update(JSON.stringify(names));
	for (const file of [CONFIG, LOCK])
		hash.update(
			createHash("sha256")
				.update(readLocal(root, file) ?? "")
				.digest("hex"),
		);
	return hash.digest("hex");
}

/** Machine-local notice state: never inside the repository. */
export function noticeStateRoot(home = os.homedir()) {
	return path.join(home, ".agent-profiles", "notices");
}
const stateFile = (stateRoot: string, root: string) =>
	path.join(
		stateRoot,
		`${createHash("sha256").update(root).digest("hex").slice(0, 32)}.json`,
	);

type NoticeState = {
	root: string;
	fingerprint: string;
	notifiedAt: string | null;
};

function readState(file: string): NoticeState | null {
	try {
		const state = JSON.parse(readFileSync(file, "utf8"));
		return typeof state?.fingerprint === "string" ? state : null;
	} catch {
		return null;
	}
}

function writeState(file: string, state: NoticeState) {
	mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temporary, file);
}

/** Actionable and informational lines from outdated, without state or rate limits. */
export function updateSummary({
	root,
	storeRoot,
	level = "all",
}: {
	root: string;
	storeRoot?: string;
	level?: NoticeLevel;
}) {
	const result = outdatedPins({ root, storeRoot });
	const actionable: string[] = [];
	let informational = 0;
	for (const pin of result.pins) {
		let promotedHere = false;
		for (const candidate of pin.newer) {
			if (!candidate.pinnable) continue;
			const promoted = candidate.evidence.filter(({ rows }) =>
				rows.some((row) => row.outcome.startsWith("promoted")),
			);
			for (const { tuple } of promoted)
				actionable.push(
					`${pin.binding} for ${tuple.role} × ${tuple.model}${tuple.host ? ` × ${tuple.host}` : ""}: ${pin.package}@${pin.version} → ${candidate.version} has promoted evidence`,
				);
			if (promoted.length) promotedHere = true;
		}
		if (!promotedHere && pin.newer.some((candidate) => candidate.pinnable))
			informational++;
	}
	return {
		actionable,
		informational: level === "all" ? informational : 0,
		lines: [
			...actionable,
			...(level === "all" && informational
				? [
						`${informational} pin${informational === 1 ? " has" : "s have"} newer versions without evidence for the tuples ${informational === 1 ? "it serves" : "they serve"}.`,
					]
				: []),
		],
	};
}

export type NoticeResult = {
	status: "silent" | "suppressed" | "notified";
	reason: string;
	lines: string[];
};

/**
 * The session-start notice for one project. Silent when nothing changed since the
 * last notice, suppressed within a day of the last one, and otherwise the summary.
 * State is written only when the notice is shown or found to be empty.
 */
export function updateNotice({
	root,
	storeRoot,
	stateRoot = noticeStateRoot(),
	now = new Date(),
	level = noticeLevel(),
}: {
	root: string;
	storeRoot?: string;
	stateRoot?: string;
	now?: Date;
	level?: NoticeLevel;
}): NoticeResult {
	if (level === "off") return { status: "silent", reason: "off", lines: [] };
	const validated = validateConfiguration({ root });
	const repository = validated.repository;
	if (!validated.bindings.size)
		return { status: "silent", reason: "no package pins", lines: [] };
	const file = stateFile(stateRoot, repository);
	const previous = readState(file);
	const fingerprint = noticeFingerprint(repository, storeRoot);
	if (previous?.fingerprint === fingerprint)
		return {
			status: "silent",
			reason: "unchanged since the last notice",
			lines: [],
		};
	if (
		previous?.notifiedAt &&
		now.getTime() - Date.parse(previous.notifiedAt) < DAY_MS
	)
		return {
			status: "suppressed",
			reason: "already notified today",
			lines: [],
		};
	const summary = updateSummary({ root: repository, storeRoot, level });
	if (!summary.lines.length) {
		writeState(file, {
			root: repository,
			fingerprint,
			notifiedAt: previous?.notifiedAt ?? null,
		});
		return { status: "silent", reason: "nothing to report", lines: [] };
	}
	writeState(file, {
		root: repository,
		fingerprint,
		notifiedAt: now.toISOString(),
	});
	return {
		status: "notified",
		reason: "changed",
		lines: [
			"Agent Profiles: library updates for this project",
			...summary.lines.map((line) => `- ${line}`),
			"Run agent-profiles outdated for details; nothing was changed.",
		],
	};
}

/**
 * Claude Code SessionStart hook output: a user-facing systemMessage only, never
 * additionalContext, so the notice stays out of the model's context. Any failure
 * is silent: a notice must never block a session.
 */
export function claudeHookOutput(
	input: string,
	run: () => NoticeResult,
): string {
	try {
		const payload = input.trim() ? JSON.parse(input) : {};
		// The settings matcher limits the hook to startup; this is a second guard.
		if (payload.source !== undefined && payload.source !== "startup") return "";
		const result = run();
		if (result.status !== "notified") return "";
		return JSON.stringify({
			systemMessage: result.lines.join("\n"),
			suppressOutput: true,
		});
	} catch {
		return "";
	}
}
