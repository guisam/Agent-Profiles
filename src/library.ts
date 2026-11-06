// The local skill library (#44, #46; phases 2 and 3 of #38): browse, search, inspect
// and publish packages in the existing content-addressed store, and show the
// evaluation evidence retained for each version. The library is the store; the
// index is derived from its identity records and release labels on every call,
// so it cannot drift.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describeApproval, versionApproval } from "./approvals.ts";
import { errorMessage } from "./files.ts";
import { lintPackage } from "./lint.ts";
import {
	migrationCandidate,
	migrationEvaluationPlan,
	migrationEvaluationReport,
	migrationPromotion,
} from "./migrations.ts";
import { readLockState } from "./package-lock.ts";
import {
	importPackage,
	inStoreSession,
	listIdentities,
	lookupPackage,
	safePath,
	statOrNull,
} from "./package-store.ts";
import { parseManifest, readPackage, type Untyped } from "./packages.ts";
import {
	packageReferences,
	resolveConfigured,
	validateConfiguration,
} from "./resolve.ts";
import { listReleaseLabels, releasedPackage } from "./revisions.ts";
import { loadTrustPolicy } from "./trust.ts";

const MANIFEST = "package.yaml";
const DOCS = "docs/versioned-packages.md";

/**
 * How a version entered the library: `package` (imported with add or publish),
 * `adopted` (an imported package that also has a release label, from revision
 * record), or `promoted` (a release created by promotion; it has a label only).
 */
export type LibrarySource = "package" | "adopted" | "promoted";

/** One verified version, or the reason it could not be verified. */
export type LibraryVersion =
	| {
			version: string;
			source: LibrarySource;
			revisionDigest: string | null;
			sha256: string;
			type: "skill" | "instruction";
			description: string | null;
			license: string | null;
			entrypoint: string;
			delivery: "instruction" | "native";
			hosts: string[];
			effects: string[];
			files: number;
			bytes: number;
	  }
	| {
			version: string;
			source: LibrarySource;
			revisionDigest: string | null;
			sha256: string;
			error: string;
	  };

export type LibraryPackage = { name: string; versions: LibraryVersion[] };

const versionKey = (version: string) => version.split(".").map(Number);
/** Newest first, comparing the exact three numeric components. */
function newestFirst(a: string, b: string) {
	const [x, y] = [versionKey(a), versionKey(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
	return 0;
}

type Origin = {
	source: LibrarySource;
	revisionDigest: string | null;
	sha256: string;
};

// Every reported version is verified (its object is hashed, as resolve does); a
// corrupt object is reported with its error rather than shown as a valid version.
function describe(
	storeRoot: string | undefined,
	identity: { name: string; version: string },
	origin: Origin,
): LibraryVersion {
	const { source, revisionDigest, sha256 } = origin;
	try {
		const found =
			source === "promoted"
				? releasedPackage({ storeRoot, ...identity, revisionDigest })
				: lookupPackage({ storeRoot, ...identity });
		if (!found) throw new Error("record disappeared during listing");
		const manifestFile = found.files.find((file) => file.path === MANIFEST);
		if (!manifestFile) throw new Error(`${MANIFEST} missing from object`);
		const manifest = parseManifest(manifestFile.bytes);
		return {
			version: identity.version,
			source,
			revisionDigest,
			sha256: found.sha256,
			type: manifest.package.type,
			description: manifest.package.description ?? null,
			license: manifest.package.license ?? null,
			entrypoint: manifest.entrypoint,
			delivery: manifest.behavior.delivery,
			hosts: [...manifest.behavior.hosts],
			effects: [...manifest.behavior.effects],
			files: found.files.length,
			bytes: found.files.reduce((sum, file) => sum + file.bytes.length, 0),
		};
	} catch (error) {
		return {
			version: identity.version,
			source,
			revisionDigest,
			sha256,
			error: errorMessage(error),
		};
	}
}

function library(storeRoot?: string) {
	const identities = listIdentities({ storeRoot });
	const labels = listReleaseLabels({ storeRoot });
	const store = identities.store;
	const problems = [...identities.problems, ...labels.problems];
	// One entry per name@version: an imported package, optionally adopted by a label,
	// or a promoted release that exists only as a label.
	const origins = new Map<string, { name: string; version: string } & Origin>();
	for (const { identity, sha256 } of identities.records)
		origins.set(`${identity.name}@${identity.version}`, {
			...identity,
			source: "package",
			revisionDigest: null,
			sha256,
		});
	for (const { identity, recordDigest, manifest } of labels.records) {
		const key = `${identity.name}@${identity.version}`;
		const imported = origins.get(key);
		if (imported) {
			if (imported.sha256 !== manifest.content.sha256)
				problems.push(
					`${key}: release label content ${manifest.content.sha256} differs from the imported package ${imported.sha256}`,
				);
			origins.set(key, {
				...imported,
				source: "adopted",
				revisionDigest: recordDigest,
			});
		} else
			origins.set(key, {
				...identity,
				source: "promoted",
				revisionDigest: recordDigest,
				sha256: manifest.content.sha256,
			});
	}
	const byName = new Map<string, LibraryVersion[]>();
	for (const { name, version, ...origin } of origins.values()) {
		const versions = byName.get(name) ?? [];
		versions.push(describe(storeRoot, { name, version }, origin));
		byName.set(name, versions);
	}
	const packages: LibraryPackage[] = [...byName.keys()]
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map((name) => ({
			name,
			versions: (byName.get(name) ?? []).sort((a, b) =>
				newestFirst(a.version, b.version),
			),
		}));
	return { store, packages, problems };
}

/** The newest version that verified, for list and search summaries. */
const latest = (item: LibraryPackage) =>
	item.versions.find((version) => !("error" in version)) as
		| Exclude<LibraryVersion, { error: string }>
		| undefined;

function summary(item: LibraryPackage) {
	const newest = latest(item);
	return {
		name: item.name,
		versions: item.versions.map((version) => version.version),
		latest: newest?.version ?? null,
		type: newest?.type ?? null,
		description: newest?.description ?? null,
		unverified: item.versions
			.filter((version) => "error" in version)
			.map((version) => version.version),
	};
}

function listLibraryOperation({
	storeRoot,
	type,
}: {
	storeRoot?: string;
	type?: "skill" | "instruction";
} = {}) {
	if (type !== undefined && type !== "skill" && type !== "instruction")
		throw new Error("type: expected skill or instruction");
	const { store, packages, problems } = library(storeRoot);
	return {
		store,
		packages: packages
			.map(summary)
			.filter((item) => type === undefined || item.type === type),
		problems,
	};
}

function searchLibraryOperation({
	storeRoot,
	text,
}: {
	storeRoot?: string;
	text: string;
}) {
	if (typeof text !== "string" || !text.trim())
		throw new Error("search: expected nonempty text");
	const needle = text.trim().toLowerCase();
	const { store, packages, problems } = library(storeRoot);
	const matches = packages.filter(
		(item) =>
			item.name.toLowerCase().includes(needle) ||
			item.versions.some(
				(version) =>
					!("error" in version) &&
					version.description?.toLowerCase().includes(needle),
			),
	);
	return { store, text: text.trim(), packages: matches.map(summary), problems };
}

/** Which versions of a package one project pins, per binding, and whether its lock covers them. */
function projectPins(
	root: string,
	storeRoot: string | undefined,
	name: string,
) {
	const validated = validateConfiguration({ root });
	const pins = new Map<string, string[]>();
	for (const [binding, value] of validated.bindings)
		for (const { reference, entry } of packageReferences(binding, value))
			if (reference.get("package") === name) {
				const version = reference.get("version");
				pins.set(version, [...(pins.get(version) ?? []), entry]);
			}
	const lock = validated.bindings.size
		? readLockState(validated.repository, validated, storeRoot)
		: { state: "not-required" as const };
	return {
		root: validated.repository,
		lockState: lock.state,
		pins: [...pins].map(([version, bindings]) => ({
			version,
			bindings: bindings.sort(),
			locked:
				"locked" in lock && lock.locked
					? (lock.locked.get(`${name}@${version}`)?.sha256 ?? null)
					: null,
		})),
	};
}

// Pins of the requested version only (all when none), each marked with whether the library holds it.
function pinsFor(
	project: ReturnType<typeof projectPins>,
	item: LibraryPackage,
	version: string | undefined,
) {
	return {
		...project,
		pins: project.pins
			.filter((pin) => version === undefined || pin.version === version)
			.map((pin) => ({
				...pin,
				inLibrary: item.versions.some(
					(candidate) => candidate.version === pin.version,
				),
			})),
	};
}

function libraryInfoOperation({
	storeRoot,
	name,
	version,
	root,
}: {
	storeRoot?: string;
	name: string;
	version?: string;
	root?: string;
}) {
	const { store, packages, problems } = library(storeRoot);
	const item = packages.find((candidate) => candidate.name === name);
	if (!item) throw new Error(`${name}: not in the library at ${store}`);
	const versions =
		version === undefined
			? item.versions
			: item.versions.filter((candidate) => candidate.version === version);
	if (!versions.length)
		throw new Error(
			`${name}@${version}: not in the library; versions: ${item.versions.map((v) => v.version).join(", ")}`,
		);
	const found = evidence(store, storeRoot, root);
	const wanted = new Set(versions.map((candidate) => candidate.version));
	// #71: with a project and a trust policy, each version's approval status.
	const policy = root === undefined ? null : loadTrustPolicy({ root });
	const approvals =
		root === undefined || !policy
			? null
			: versions.map((entry) => ({
					version: entry.version,
					...versionApproval({
						root,
						policy,
						name,
						version: entry.version,
						entry,
					}),
				}));
	return {
		store,
		name,
		versions,
		evidence: found.rows.filter(
			(row) => row.name === name && wanted.has(row.version),
		),
		...(root === undefined
			? {}
			: {
					project: pinsFor(projectPins(root, storeRoot, name), item, version),
					approvals,
				}),
		problems: [...problems, ...found.problems],
	};
}

// --- Evidence (#46): retained paired evaluations and promotion decisions, per version.

export type EvidenceOutcome =
	| "promoted"
	| "promoted with override"
	| "eligible, not promoted"
	| "blocked";

/** Where the evidence came from, relative to the project given with --root. */
export type EvidenceOrigin =
	| "evaluated here"
	| "approved elsewhere"
	| "evaluated elsewhere";

export type EvidenceRow = {
	name: string;
	version: string;
	/** Whether that version is in the library (an unpromoted candidate's label is not). */
	inLibrary: boolean;
	assignment: { role: string; model: string; host: string };
	/** The family the project configures for this model, with --root; never used to merge rows. */
	family: string | null;
	outcome: EvidenceOutcome;
	origin: EvidenceOrigin;
	correctness: {
		base: { passed: number; trials: number };
		candidate: { passed: number; trials: number };
	};
	regressions: {
		caseId: string;
		basePassed: number;
		candidatePassed: number;
	}[];
	overriddenCases: string[];
	/** candidate - base, only when both sides are completely measured; otherwise null. */
	deltas: Record<
		"costUsd" | "tokens" | "turns" | "toolCalls" | "latencyMs",
		number | null
	>;
	conditions: {
		harness: { id: string; version: string };
		judge: { id: string; version: string };
		rubric: { id: string; version: string };
	} | null;
	candidateId: string;
	migrationId: string;
	resultId: string;
	resultDigest: string;
	planDigest: string;
	decisionId: string | null;
	decisionDigest: string | null;
	/** Always external claims about correctness; runtime is never verified here. */
	labels: { correctness: "external-claim"; runtime: "unverified" };
};

const METRICS = [
	"costUsd",
	"tokens",
	"turns",
	"toolCalls",
	"latencyMs",
] as const;

// Retained ids under one store directory (`<dir>/ids/<id>.json`), in byte order.
function storeIds(store: string, directory: string, problems: string[]) {
	const ids = safePath(store, `${directory}/ids`);
	if (!statOrNull(ids)) return [];
	try {
		return readdirSync(ids)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.slice(0, -".json".length))
			.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	} catch (error) {
		problems.push(`${directory}/ids: ${errorMessage(error)}`);
		return [];
	}
}

// "Here" means the candidate's migration is recorded in this project (#46 decision 2).
const migrationHere = (root: string | undefined, migrationId: string) =>
	root !== undefined &&
	existsSync(
		path.join(
			root,
			".agent-profiles",
			"migrations",
			migrationId,
			"record.json",
		),
	);

function familyFor(
	root: string | undefined,
	storeRoot: string | undefined,
	assignment: EvidenceRow["assignment"],
) {
	if (root === undefined) return null;
	try {
		const resolved = resolveConfigured({
			root,
			storeRoot,
			model: assignment.model,
			role: assignment.role,
			host: assignment.host,
		}) as { family?: string | null };
		return resolved.family ?? null;
	} catch {
		return null;
	}
}

/**
 * Every retained result in the store, each revalidated through the existing
 * readbacks (report, candidate, plan, promotion). A record that fails
 * revalidation is reported as a problem and never becomes evidence.
 */
function evidence(store: string, storeRoot: string | undefined, root?: string) {
	const problems: string[] = [];
	const conditions = new Map<string, EvidenceRow["conditions"]>();
	for (const id of storeIds(store, "evaluations/plans", problems))
		try {
			const { planDigest, plan } = migrationEvaluationPlan({ storeRoot, id });
			const pick = (claim: { id: string; version: string }) => ({
				id: claim.id,
				version: claim.version,
			});
			conditions.set(planDigest, {
				harness: pick(plan.conditions.harness),
				judge: pick(plan.conditions.judge),
				rubric: pick(plan.conditions.rubric),
			});
		} catch (error) {
			problems.push(`evaluation plan ${id}: ${errorMessage(error)}`);
		}
	const decisions = new Map<
		string,
		// migrationPromotion has already revalidated the decision's shape.
		{ id: string; digest: string; decision: Untyped }
	>();
	for (const id of storeIds(store, "promotions/decisions", problems))
		try {
			const read = migrationPromotion({ storeRoot, id });
			decisions.set(read.decision.resultId, {
				id,
				digest: read.decisionDigest,
				decision: read.decision,
			});
		} catch (error) {
			problems.push(`promotion decision ${id}: ${errorMessage(error)}`);
		}
	const library = new Set(
		listIdentities({ storeRoot }).records.map(
			(record) => `${record.identity.name}@${record.identity.version}`,
		),
	);
	for (const record of listReleaseLabels({ storeRoot }).records)
		library.add(`${record.identity.name}@${record.identity.version}`);
	const rows: EvidenceRow[] = [];
	for (const id of storeIds(store, "evaluations/results", problems))
		try {
			const report = migrationEvaluationReport({ storeRoot, id });
			const candidate = migrationCandidate({
				storeRoot,
				id: report.candidate.id,
			});
			const promoted = decisions.get(id);
			const release = (promoted?.decision.release ?? candidate.release) as {
				name: string;
				version: string;
			};
			const assignment = report.context.assignment;
			const tally = (side: "base" | "candidate") =>
				report.cases.reduce(
					(
						sum: { passed: number; trials: number },
						item: Record<string, { passed: number; trials: number }>,
					) => ({
						passed: sum.passed + item[side].passed,
						trials: sum.trials + item[side].trials,
					}),
					{ passed: 0, trials: 0 },
				);
			const override = promoted?.decision.correctnessOverride ?? null;
			const outcome: EvidenceOutcome = promoted
				? override
					? "promoted with override"
					: "promoted"
				: report.eligibility.status === "eligible"
					? "eligible, not promoted"
					: "blocked";
			const here = migrationHere(root, candidate.migrationId);
			rows.push({
				name: release.name,
				version: release.version,
				inLibrary: library.has(`${release.name}@${release.version}`),
				assignment: {
					role: assignment.role,
					model: assignment.model,
					host: assignment.host,
				},
				family: familyFor(root, storeRoot, assignment),
				outcome,
				origin: here
					? "evaluated here"
					: promoted
						? "approved elsewhere"
						: "evaluated elsewhere",
				correctness: { base: tally("base"), candidate: tally("candidate") },
				regressions: report.eligibility.regressions.map(
					(row: {
						caseId: string;
						basePassed: number;
						candidatePassed: number;
					}) => ({
						caseId: row.caseId,
						basePassed: row.basePassed,
						candidatePassed: row.candidatePassed,
					}),
				),
				overriddenCases: override ? [...override.cases] : [],
				deltas: Object.fromEntries(
					METRICS.map((metric) => [
						metric,
						report.metrics[metric]?.delta ?? null,
					]),
				) as EvidenceRow["deltas"],
				conditions: conditions.get(report.planDigest) ?? null,
				candidateId: report.candidate.id,
				migrationId: candidate.migrationId,
				resultId: id,
				resultDigest: report.resultDigest,
				planDigest: report.planDigest,
				decisionId: promoted?.id ?? null,
				decisionDigest: promoted?.digest ?? null,
				labels: { correctness: "external-claim", runtime: "unverified" },
			});
		} catch (error) {
			problems.push(`evaluation result ${id}: ${errorMessage(error)}`);
		}
	rows.sort(
		(a, b) =>
			Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) ||
			newestFirst(a.version, b.version) ||
			Buffer.compare(
				Buffer.from(JSON.stringify(a.assignment)),
				Buffer.from(JSON.stringify(b.assignment)),
			) ||
			Buffer.compare(Buffer.from(a.resultId), Buffer.from(b.resultId)),
	);
	return { rows, problems };
}

export type EvidenceFilter = { model?: string; role?: string; host?: string };

/**
 * Evidence for one package, optionally one version, filtered by exact model, role
 * and host. With a filter, versions in the library with no matching row are
 * listed as `untested`, so the absence of evidence is visible.
 */
function libraryEvidenceOperation({
	storeRoot,
	name,
	version,
	root,
	filter = {},
}: {
	storeRoot?: string;
	name: string;
	version?: string;
	root?: string;
	filter?: EvidenceFilter;
}) {
	const { store, packages, problems } = library(storeRoot);
	const item = packages.find((candidate) => candidate.name === name);
	const found = evidence(store, storeRoot, root);
	const matches = (row: EvidenceRow) =>
		row.name === name &&
		(version === undefined || row.version === version) &&
		(filter.model === undefined || row.assignment.model === filter.model) &&
		(filter.role === undefined || row.assignment.role === filter.role) &&
		(filter.host === undefined || row.assignment.host === filter.host);
	const rows = found.rows.filter(matches);
	if (!item && !rows.length)
		throw new Error(
			`${name}: not in the library at ${store} and has no evidence`,
		);
	const filtered =
		filter.model !== undefined ||
		filter.role !== undefined ||
		filter.host !== undefined;
	const untested = filtered
		? (item?.versions ?? [])
				.map((candidate) => candidate.version)
				.filter(
					(candidate) =>
						(version === undefined || candidate === version) &&
						!rows.some((row) => row.version === candidate),
				)
		: [];
	return {
		store,
		name,
		...(version === undefined ? {} : { version }),
		filter,
		rows,
		untested,
		problems: [...problems, ...found.problems],
	};
}

/**
 * Publish a package directory: the same validation and import as
 * `add <name>@<version> --source <directory>`, reading the identity from its manifest.
 */
function publishPackageOperation({
	storeRoot,
	sourceDirectory,
}: {
	storeRoot?: string;
	sourceDirectory: string;
}) {
	let inspected: ReturnType<typeof readPackage>;
	try {
		inspected = readPackage({ root: sourceDirectory });
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(
			message.includes(MANIFEST)
				? `${message} (a package needs a ${MANIFEST} manifest; see ${DOCS})`
				: message,
		);
	}
	const imported = importPackage({
		sourceDirectory,
		storeRoot,
		expectedDigest: inspected.sha256,
	});
	// #55 step 3: warnings about text that looks like injection; never blocks.
	return {
		...imported,
		lint: lintPackage(inspected.files, inspected.manifest.behavior.effects),
	};
}

/** Lint one library version (#55 step 3): the same heuristics as publish. */
function lintLibraryVersionOperation({
	storeRoot,
	name,
	version,
}: {
	storeRoot?: string;
	name: string;
	version: string;
}) {
	const [entry] = libraryInfoOperation({ storeRoot, name, version }).versions;
	if (!entry) throw new Error(`${name}@${version} is not in the library`);
	if ("error" in entry)
		throw new Error(`${name}@${version} is not verified: ${entry.error}`);
	const found =
		entry.source === "promoted"
			? releasedPackage({
					storeRoot,
					name,
					version,
					revisionDigest: entry.revisionDigest,
				})
			: lookupPackage({ storeRoot, name, version });
	if (!found) throw new Error(`${name}@${version} is not in the store`);
	return {
		name,
		version,
		sha256: entry.sha256,
		findings: lintPackage(found.files, entry.effects),
	};
}

export const lintLibraryVersion = inStoreSession(lintLibraryVersionOperation);

export type LibraryFile = {
	name: string;
	version: string;
	sha256: string;
	path: string;
	bytes: number;
} & (
	| { encoding: "utf8"; text: string }
	| { encoding: "base64"; base64: string }
);

/**
 * One file of a library version, read only after the version's object verifies
 * (#55 follow-up). This is the way agents should read package files: the store
 * folder itself holds the same bytes, but nothing checks them there.
 */
function readLibraryFileOperation({
	storeRoot,
	name,
	version,
	path: file,
}: {
	storeRoot?: string;
	name: string;
	version: string;
	path: string;
}): LibraryFile {
	const [entry] = libraryInfoOperation({ storeRoot, name, version }).versions;
	if (!entry) throw new Error(`${name}@${version} is not in the library`);
	if ("error" in entry)
		throw new Error(`${name}@${version} is not verified: ${entry.error}`);
	const found =
		entry.source === "promoted"
			? releasedPackage({
					storeRoot,
					name,
					version,
					revisionDigest: entry.revisionDigest,
				})
			: lookupPackage({ storeRoot, name, version });
	const member = found?.files.find((item) => item.path === file);
	if (!member) throw new Error(`${name}@${version} has no file ${file}`);
	const head = {
		name,
		version,
		sha256: entry.sha256,
		path: file,
		bytes: member.bytes.length,
	};
	if (!member.bytes.includes(0))
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(
				member.bytes,
			);
			return { ...head, encoding: "utf8", text };
		} catch {
			// Not UTF-8: base64 below.
		}
	return {
		...head,
		encoding: "base64",
		base64: member.bytes.toString("base64"),
	};
}

export const readLibraryFile = inStoreSession(readLibraryFileOperation);
export const listLibrary = inStoreSession(listLibraryOperation);
export const searchLibrary = inStoreSession(searchLibraryOperation);
export const libraryInfo = inStoreSession(libraryInfoOperation);
export const publishPackage = inStoreSession(publishPackageOperation);
export const libraryEvidence = inStoreSession(libraryEvidenceOperation);

/** Text rendering for the CLI. */
export function formatLibrary(
	result:
		| ReturnType<typeof listLibraryOperation>
		| ReturnType<typeof searchLibraryOperation>,
): string {
	const lines = result.packages.length
		? result.packages.map((item) =>
				[
					`${item.name}  ${item.versions.join(", ")}${item.type ? `  (${item.type})` : ""}`,
					...(item.description ? [`  ${item.description}`] : []),
					...(item.unverified.length
						? [
								`  Not verified: ${item.unverified.join(", ")}; run library info for details`,
							]
						: []),
				].join("\n"),
			)
		: [
				"text" in result
					? `No packages match "${result.text}".`
					: "The library is empty.",
			];
	return [
		`Library: ${result.store}`,
		...lines,
		...result.problems.map((problem) => `Store problem: ${problem}`),
	].join("\n");
}

/** A text file prints as itself; a binary file as a one-line note. */
export function formatLibraryFile(result: LibraryFile) {
	if (result.encoding === "utf8") return result.text;
	return `${result.name}@${result.version} ${result.path}: binary, ${result.bytes} bytes (verified, sha256 ${result.sha256}); use --json for base64.`;
}

export function formatLibraryInfo(
	result: ReturnType<typeof libraryInfoOperation>,
): string {
	const pinned = new Map(
		(result.project?.pins ?? []).map((pin) => [pin.version, pin]),
	);
	const lines = [`${result.name}  (library: ${result.store})`];
	for (const version of result.versions) {
		lines.push(
			"",
			`${version.version}  sha256 ${version.sha256}${version.source === "package" ? "" : `  (${version.source} release)`}`,
		);
		if ("error" in version) lines.push(`  Not verified: ${version.error}`);
		else {
			lines.push(
				`  ${version.type}, ${version.delivery} delivery; entrypoint ${version.entrypoint}`,
				...(version.description ? [`  ${version.description}`] : []),
				`  Hosts: ${version.hosts.join(", ") || "any"}; effects: ${version.effects.join(", ") || "none"}; license: ${version.license ?? "not stated"}`,
				`  ${version.files} files, ${version.bytes} bytes`,
			);
		}
		const rows = result.evidence.filter(
			(row) => row.version === version.version,
		);
		if (rows.length) {
			lines.push("  Evidence:");
			for (const row of rows) lines.push(...evidenceLines(row, "    "));
		} else lines.push("  Evidence: none retained");
		const approval = result.approvals?.find(
			(row) => row.version === version.version,
		);
		if (approval) lines.push(`  Approval: ${describeApproval(approval)}`);
		const pin = pinned.get(version.version);
		if (pin)
			lines.push(
				`  Pinned by ${result.project?.root}: ${pin.bindings.join(", ")}; ${pin.locked === version.sha256 ? "locked" : pin.locked ? `locked to a different digest ${pin.locked}` : `not locked (lock ${result.project?.lockState})`}`,
			);
	}
	if (result.project) {
		for (const pin of result.project.pins)
			if (!pin.inLibrary)
				lines.push(
					"",
					`${pin.version}  pinned by ${result.project.root} (${pin.bindings.join(", ")}) but not in this library`,
				);
		if (!result.project.pins.length)
			lines.push("", `Not pinned by ${result.project.root}.`);
	}
	for (const problem of result.problems)
		lines.push(`Store problem: ${problem}`);
	return lines.join("\n");
}

const fraction = (side: { passed: number; trials: number }) =>
	`${side.passed}/${side.trials}`;
const signed = (value: number) => (value > 0 ? `+${value}` : `${value}`);

/** One evidence row as indented text lines. */
function evidenceLines(row: EvidenceRow, indent = "  "): string[] {
	const { role, model, host } = row.assignment;
	const deltas = Object.entries(row.deltas)
		.filter(([, value]) => value !== null)
		.map(([metric, value]) => `${metric} ${signed(value as number)}`);
	const conditions = row.conditions
		? `${row.conditions.harness.id} ${row.conditions.harness.version}, judge ${row.conditions.judge.id} ${row.conditions.judge.version}, rubric ${row.conditions.rubric.id} ${row.conditions.rubric.version}`
		: "conditions unavailable";
	return [
		`${indent}${role} × ${model}${row.family ? ` (family ${row.family})` : ""} × ${host}: ${row.outcome}; ${row.origin}`,
		`${indent}  Correct: base ${fraction(row.correctness.base)}, candidate ${fraction(row.correctness.candidate)} (external claim; runtime unverified)`,
		...(row.regressions.length
			? [
					`${indent}  Regressions: ${row.regressions.map((r) => `${r.caseId} ${r.basePassed}→${r.candidatePassed}`).join(", ")}${row.overriddenCases.length ? `; overridden: ${row.overriddenCases.join(", ")}` : ""}`,
				]
			: []),
		`${indent}  Deltas (candidate − base): ${deltas.join(", ") || "not completely measured"}`,
		`${indent}  ${conditions}; result ${row.resultId}${row.decisionId ? `, decision ${row.decisionId}` : ""}`,
	];
}

export function formatLibraryEvidence(
	result: ReturnType<typeof libraryEvidenceOperation>,
): string {
	const lines = [
		`${result.name}${result.version ? `@${result.version}` : ""} evidence  (library: ${result.store})`,
	];
	const filter = Object.entries(result.filter)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key} ${value}`);
	if (filter.length) lines.push(`Filter: ${filter.join(", ")}`);
	const versions = [...new Set(result.rows.map((row) => row.version))];
	for (const version of versions) {
		const rows = result.rows.filter((row) => row.version === version);
		lines.push(
			"",
			`${version}${rows[0]?.inLibrary ? "" : "  (not in the library: unpublished candidate label)"}`,
		);
		for (const row of rows) lines.push(...evidenceLines(row));
	}
	if (!result.rows.length) lines.push("", "No retained evidence matches.");
	for (const version of result.untested)
		lines.push("", `${version}  untested for this filter`);
	for (const problem of result.problems)
		lines.push(`Store problem: ${problem}`);
	return lines.join("\n");
}
