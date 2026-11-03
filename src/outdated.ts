// Outdated and update (#48, phase 4 of #38): which pinned versions have newer
// versions in the library, with evidence for the tuples each pin serves; and an
// explicit, previewed move of one exact tuple's pin. Reads never write; apply edits
// only agents.yaml (guarded, comments kept), then refreshes the lock and stamps.
import { createHash } from "node:crypto";
import { exactRule } from "./binding-target.ts";
import { applyChanges, errorMessage, readLocal } from "./files.ts";
import { libraryEvidence, libraryInfo } from "./library.ts";
import { installDependencies, readLockState } from "./package-lock.ts";
import { inStoreSession } from "./package-store.ts";
import {
	packageReferences,
	parseYaml,
	parseYamlDocument,
	resolveInstructions,
	validateConfiguration,
} from "./resolve.ts";
import { createStamp } from "./stamps.ts";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";

export type Tuple = { role: string; model: string; host: string | null };
export type OutdatedFilter = { model?: string; role?: string; host?: string };

const versionKey = (version: string) => version.split(".").map(Number);
function compareVersions(a: string, b: string) {
	const [x, y] = [versionKey(a), versionKey(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}
const tupleKey = (tuple: Tuple) =>
	JSON.stringify([tuple.role, tuple.model, tuple.host]);

type Selection = {
	binding: string;
	name: string;
	version: string;
	revisionDigest: string | null;
	selectedBy: string;
	selectors: Record<string, unknown>;
};

/** Every package binding one tuple's resolution selects, by binding. */
function selections(
	root: string,
	storeRoot: string | undefined,
	tuple: Tuple,
	configuration?: unknown,
): Map<string, Selection> {
	const result = resolveInstructions({
		root,
		storeRoot,
		model: tuple.model,
		role: tuple.role,
		...(tuple.host === null ? {} : { host: tuple.host }),
		...(configuration === undefined
			? {}
			: { configuration: configuration as never }),
		lockMode: "validation",
	}) as unknown as Record<string, unknown>;
	const found = new Map<string, Selection>();
	for (const key of ["loaded", "required", "available"])
		for (const entry of (result[key] as { package?: Selection }[]) ?? [])
			if (entry?.package?.binding)
				found.set(entry.package.binding, {
					binding: entry.package.binding,
					name: entry.package.name,
					version: entry.package.version,
					revisionDigest: entry.package.revisionDigest ?? null,
					selectedBy: entry.package.selectedBy,
					selectors: { ...entry.package.selectors },
				});
	return found;
}

/**
 * The tuples to sweep: every configured canonical model × role, once without a host
 * and once per host any assignment rule names (a rule naming a host can only be
 * selected when that host is supplied).
 */
function tuples(validated: ReturnType<typeof validateConfiguration>): Tuple[] {
	const hosts = new Set<string>();
	for (const [, value] of validated.bindings)
		for (const rule of value.rules) {
			const host = rule.when.get("host");
			if (typeof host === "string") hosts.add(host);
		}
	const out: Tuple[] = [];
	for (const model of [...validated.models.keys()].sort())
		for (const role of [...validated.roles.keys()].sort())
			for (const host of [null, ...[...hosts].sort()])
				out.push({ role, model, host });
	return out;
}

/** For each tuple, its selections; tuples whose resolution fails are skipped and reported. */
function sweep(
	root: string,
	storeRoot: string | undefined,
	all: Tuple[],
	problems: string[],
	configuration?: unknown,
) {
	const swept = new Map<
		string,
		{ tuple: Tuple; selected: Map<string, Selection> }
	>();
	for (const tuple of all)
		try {
			swept.set(tupleKey(tuple), {
				tuple,
				selected: selections(root, storeRoot, tuple, configuration),
			});
		} catch (error) {
			problems.push(
				`${tuple.role} × ${tuple.model}${tuple.host ? ` × ${tuple.host}` : ""}: ${errorMessage(error)}`,
			);
		}
	return swept;
}

const matchesFilter = (tuple: Tuple, filter: OutdatedFilter) =>
	(filter.model === undefined || tuple.model === filter.model) &&
	(filter.role === undefined || tuple.role === filter.role) &&
	(filter.host === undefined ||
		tuple.host === null ||
		tuple.host === filter.host);

function outdatedPinsOperation({
	root,
	storeRoot,
	filter = {},
}: {
	root: string;
	storeRoot?: string;
	filter?: OutdatedFilter;
}) {
	const validated = validateConfiguration({ root });
	const repository = validated.repository;
	const v3 = validated.config.get("version") === 3;
	const problems: string[] = [];
	const lock = validated.bindings.size
		? readLockState(repository, validated, storeRoot)
		: { state: "not-required" };
	// No package pins: nothing to compare, and no reason to resolve every tuple.
	const swept = validated.bindings.size
		? sweep(repository, storeRoot, tuples(validated), problems)
		: new Map();
	const pins = [];
	for (const [binding, value] of validated.bindings) {
		// Hosts some rule of this binding names: a host-less tuple stands for every OTHER
		// host, so evidence recorded on a named host never counts for it.
		const namedHosts = new Set(
			value.rules
				.map((rule) => rule.when.get("host"))
				.filter((host): host is string => typeof host === "string"),
		);
		for (const { reference, rule, entry } of packageReferences(
			binding,
			value,
		)) {
			const name = reference.get("package") as string;
			const version = reference.get("version") as string;
			const selectedBy = rule ?? "binding-default";
			// A tuple is served by this pin when its resolution selects this binding from this rule (or the default).
			const serves = [...swept.values()]
				.filter(
					({ selected }) => selected.get(binding)?.selectedBy === selectedBy,
				)
				.map(({ tuple }) => tuple);
			if (
				(filter.model !== undefined ||
					filter.role !== undefined ||
					filter.host !== undefined) &&
				!serves.some((tuple) => matchesFilter(tuple, filter))
			)
				continue;
			let newer: {
				version: string;
				major: boolean;
				source: string;
				pinnable: boolean;
				reason: string | null;
				evidence: {
					tuple: Tuple;
					rows: { host: string; outcome: string; origin: string }[];
				}[];
			}[] = [];
			try {
				const info = libraryInfo({ storeRoot, name, root: repository });
				const rows = libraryEvidence({
					storeRoot,
					name,
					root: repository,
				}).rows;
				newer = info.versions
					.filter(
						(candidate) => compareVersions(candidate.version, version) > 0,
					)
					.map((candidate) => {
						const verified = !("error" in candidate);
						const pinnable =
							verified && (!v3 || candidate.revisionDigest !== null);
						return {
							version: candidate.version,
							major:
								versionKey(candidate.version)[0] !== versionKey(version)[0],
							source: candidate.source,
							pinnable,
							reason: !verified
								? `not verified: ${(candidate as { error: string }).error}`
								: pinnable
									? null
									: "needs revision record",
							evidence: serves
								.filter((tuple) => matchesFilter(tuple, filter))
								.map((tuple) => ({
									tuple,
									rows: rows
										.filter(
											(row) =>
												row.version === candidate.version &&
												row.assignment.role === tuple.role &&
												row.assignment.model === tuple.model &&
												(tuple.host === null
													? !namedHosts.has(row.assignment.host)
													: row.assignment.host === tuple.host),
										)
										.map((row) => ({
											host: row.assignment.host,
											outcome: row.outcome,
											origin: row.origin,
										})),
								})),
						};
					});
			} catch (error) {
				problems.push(`${name}: ${errorMessage(error)}`);
			}
			pins.push({
				binding,
				rule,
				entry,
				package: name,
				version,
				revision: (reference.get("revision") as string | undefined) ?? null,
				serves,
				newer,
			});
		}
	}
	return {
		root: repository,
		configurationVersion: validated.config.get("version") as number,
		lockState: lock.state,
		filter,
		pins,
		outdated: pins.filter((pin) => pin.newer.length > 0).length,
		problems,
	};
}

// --- update

type UpdateInput = {
	root: string;
	storeRoot?: string;
	binding: string;
	version: string;
	assignment: { role: string; model: string; host: string };
	requireEvidence?: boolean;
	/** For apply: the previewDigest the preview printed; any change since then refuses. */
	expect?: string;
};

// What a preview saw: configuration and lock bytes, the target and the version. Apply with
// the same digest proves nothing moved between the two commands.
const previewDigest = (
	configBytes: Buffer,
	lockBytes: Buffer | null,
	input: UpdateInput,
) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				createHash("sha256").update(configBytes).digest("hex"),
				lockBytes ? createHash("sha256").update(lockBytes).digest("hex") : null,
				input.binding,
				input.version,
				input.assignment,
			]),
		)
		.digest("hex");

function planUpdate(input: UpdateInput) {
	const { storeRoot, binding, version, assignment } = input;
	for (const key of ["role", "model", "host"] as const)
		if (typeof assignment[key] !== "string" || !assignment[key])
			throw new Error(
				`update: --${key} is required (update targets one exact tuple)`,
			);
	const validated = validateConfiguration({ root: input.root });
	const root = validated.repository;
	const v3 = validated.config.get("version") === 3;
	const configBytes = readLocal(root, CONFIG);
	const lockBytes = readLocal(root, LOCK);
	if (!configBytes) throw new Error(`${CONFIG}: missing`);
	const target: Tuple = { ...assignment };
	const current = selections(root, storeRoot, target).get(binding);
	if (!current)
		throw new Error(
			`update: ${binding} is not selected for ${assignment.role} × ${assignment.model} × ${assignment.host}`,
		);
	const name = current.name;
	const [found] = libraryInfo({ storeRoot, name, version }).versions;
	if ("error" in found)
		throw new Error(
			`update: ${name}@${version} is not verified: ${found.error}`,
		);
	if (v3 && found.revisionDigest === null)
		throw new Error(
			`update: ${name}@${version} has no release label; configuration v3 pins a revision. Adopt it with agent-profiles revision record first`,
		);
	const evidence = libraryEvidence({
		storeRoot,
		name,
		version,
		root,
		filter: { ...assignment },
	}).rows.map((row) => ({
		outcome: row.outcome,
		origin: row.origin,
		resultId: row.resultId,
	}));
	const base = {
		root,
		previewDigest: previewDigest(configBytes, lockBytes, input),
		configurationVersion: validated.config.get("version") as number,
		binding,
		package: name,
		assignment,
		before: {
			version: current.version,
			revision: current.revisionDigest,
			selectedBy: current.selectedBy,
		},
		after: { version, revision: v3 ? found.revisionDigest : null },
		evidence,
	};
	if (
		current.version === version &&
		(!v3 || current.revisionDigest === found.revisionDigest)
	)
		return {
			...base,
			status: "already-pinned" as const,
			rule: null,
			changed: [],
			configBytes,
			lockBytes,
			nextConfig: configBytes,
		};
	if (
		input.requireEvidence &&
		!evidence.some((row) => row.outcome.startsWith("promoted"))
	)
		throw new Error(
			`update: --require-evidence: ${name}@${version} has no promoted evidence for ${assignment.role} × ${assignment.model} × ${assignment.host}`,
		);
	const rule = exactRule(current, assignment, "update");
	const assignments = validated.config.get("assignments") as
		| Map<string, Map<string, unknown>>
		| undefined;
	if (rule.action === "add" && assignments?.has(rule.id))
		throw new Error(
			`update: assignments.${rule.id} already exists for another selector; nothing was written`,
		);
	const document = parseYamlDocument(configBytes.toString("utf8"));
	// v2 rules move a version within the binding's package; v3 rules pin package, version and revision.
	const source = v3
		? { package: name, version, revision: found.revisionDigest }
		: null;
	const existing = rule.action === "replace" ? assignments?.get(rule.id) : null;
	const style =
		v3 ||
		(existing?.get("bindings") as Map<string, unknown> | undefined)?.has(
			binding,
		)
			? "bindings"
			: "versions";
	if (rule.action === "replace")
		document.setIn(
			["assignments", rule.id, style, binding],
			style === "bindings"
				? document.createNode(source ?? { package: name, version })
				: version,
		);
	else
		document.setIn(
			["assignments", rule.id],
			document.createNode({
				when: rule.when,
				[style]: { [binding]: style === "bindings" ? source : version },
			}),
		);
	const nextConfig = Buffer.from(document.toString());
	const parsed = parseYaml(nextConfig.toString("utf8"));
	try {
		validateConfiguration({ root, configuration: parsed });
	} catch (error) {
		throw new Error(
			`update: the edited configuration is not valid and unambiguous; nothing was written; ${errorMessage(error)}`,
			{ cause: error },
		);
	}
	// Prove the edit's blast radius: every swept tuple (plus the target) keeps its selections, except the target's binding.
	const problems: string[] = [];
	const all = [...tuples(validated), target].filter(
		(tuple, index, list) =>
			list.findIndex((other) => tupleKey(other) === tupleKey(tuple)) === index,
	);
	const before = sweep(root, storeRoot, all, problems);
	const after = sweep(root, storeRoot, all, problems, parsed);
	const changed: { tuple: Tuple; binding: string; from: string; to: string }[] =
		[];
	for (const [key, { tuple, selected }] of before) {
		const next = after.get(key)?.selected;
		if (!next) continue;
		for (const id of new Set([...selected.keys(), ...next.keys()])) {
			const a = selected.get(id);
			const b = next.get(id);
			if (
				a?.version !== b?.version ||
				a?.revisionDigest !== b?.revisionDigest ||
				a?.name !== b?.name
			)
				changed.push({
					tuple,
					binding: id,
					from: a ? `${a.name}@${a.version}` : "none",
					to: b ? `${b.name}@${b.version}` : "none",
				});
		}
	}
	const unintended = changed.filter(
		(row) =>
			tupleKey(row.tuple) !== tupleKey(target) || row.binding !== binding,
	);
	if (unintended.length)
		throw new Error(
			`update: the edit would change other selections (${unintended.map((row) => `${row.tuple.role} × ${row.tuple.model}${row.tuple.host ? ` × ${row.tuple.host}` : ""} ${row.binding}`).join("; ")}); nothing was written`,
		);
	if (!changed.length)
		throw new Error(
			"update: the edit does not change the target selection; nothing was written",
		);
	return {
		...base,
		status: "preview" as const,
		rule,
		changed,
		configBytes,
		lockBytes,
		nextConfig,
		problems,
	};
}

const publicPlan = ({
	configBytes: _c,
	lockBytes: _l,
	nextConfig: _n,
	...plan
}: ReturnType<typeof planUpdate>) => plan;

function previewUpdateOperation(input: UpdateInput) {
	return publicPlan(planUpdate(input));
}

function applyUpdateOperation(input: UpdateInput) {
	const plan = planUpdate(input);
	if (input.expect !== undefined && input.expect !== plan.previewDigest)
		throw new Error(
			"update: the configuration, lock or target changed since the preview (previewDigest differs); preview again; nothing was written",
		);
	if (plan.status === "already-pinned") return publicPlan(plan);
	const { root, configBytes, lockBytes, nextConfig } = plan;
	if (
		!(readLocal(root, LOCK) ?? Buffer.alloc(0)).equals(
			lockBytes ?? Buffer.alloc(0),
		)
	)
		throw new Error(`${LOCK}: changed during the operation; retry`);
	applyChanges(root, [
		{ file: CONFIG, before: configBytes, after: nextConfig },
	]);
	installDependencies({ root, storeRoot: input.storeRoot });
	const stamp = createStamp({
		root,
		storeRoot: input.storeRoot,
		...input.assignment,
		identitySource: "user",
	});
	return {
		...publicPlan(plan),
		status: "updated" as const,
		stampDigest: stamp.digest,
	};
}

export const outdatedPins = inStoreSession(outdatedPinsOperation);
export const previewUpdate = inStoreSession(previewUpdateOperation);
export const applyUpdate = inStoreSession(applyUpdateOperation);

// --- text

const describeTuple = (tuple: Tuple) =>
	`${tuple.role} × ${tuple.model}${tuple.host ? ` × ${tuple.host}` : ""}`;

export function formatOutdated(
	result: ReturnType<typeof outdatedPinsOperation>,
) {
	const lines = [
		`Pins in ${result.root} (configuration v${result.configurationVersion}, lock ${result.lockState})`,
	];
	for (const pin of result.pins) {
		lines.push(
			"",
			`${pin.binding} at ${pin.rule ? `assignments.${pin.rule}` : "the default"}: ${pin.package}@${pin.version}`,
			`  Serves: ${pin.serves.map(describeTuple).join(", ") || "no configured tuple"}`,
		);
		if (!pin.newer.length) lines.push("  Up to date with the library");
		for (const candidate of [...pin.newer].sort((a, b) =>
			compareVersions(b.version, a.version),
		)) {
			lines.push(
				`  Newer: ${candidate.version}${candidate.major ? " (major)" : ""}${candidate.source === "package" ? "" : `, ${candidate.source}`}${candidate.reason ? `; ${candidate.reason}` : ""}`,
			);
			for (const { tuple, rows } of candidate.evidence)
				lines.push(
					`    ${describeTuple(tuple)}: ${rows.length ? rows.map((row) => `${row.outcome}, ${row.origin}${tuple.host ? "" : ` (${row.host})`}`).join("; ") : "untested"}`,
				);
		}
	}
	lines.push(
		"",
		result.outdated
			? `${result.outdated} pin${result.outdated === 1 ? "" : "s"} with newer versions. Preview a move with agent-profiles update <binding> <version> --model <id> --role <id> --host <id>.`
			: "All pins are up to date with the library.",
	);
	for (const problem of result.problems) lines.push(`Not swept: ${problem}`);
	return lines.join("\n");
}

export function formatUpdate(
	result:
		| ReturnType<typeof previewUpdateOperation>
		| ReturnType<typeof applyUpdateOperation>,
) {
	const who = `${result.assignment.role} × ${result.assignment.model} × ${result.assignment.host}`;
	if (result.status === "already-pinned")
		return `${result.binding} for ${who} already selects ${result.package}@${result.after.version}; nothing to do.`;
	const lines = [
		`${result.status === "updated" ? "Updated" : "Preview (nothing written)"}: ${result.binding} for ${who}`,
		`  ${result.package}@${result.before.version} → ${result.after.version}${result.after.revision ? ` (revision ${result.after.revision})` : ""}`,
		`  Rule: ${result.rule?.action === "replace" ? "replace the binding in" : "add"} assignments.${result.rule?.id}`,
		`  Selections changed: ${result.changed.map((row) => `${describeTuple(row.tuple)} ${row.binding} ${row.from} → ${row.to}`).join("; ")}`,
		`  Evidence for this tuple: ${result.evidence.length ? result.evidence.map((row) => `${row.outcome}, ${row.origin}`).join("; ") : "untested"}`,
	];
	if (result.status === "updated")
		lines.push(`  Lock refreshed; stamp sha256 ${result.stampDigest}`);
	else
		lines.push(
			`  Apply with the same command and --apply --expect ${result.previewDigest}`,
		);
	return lines.join("\n");
}
