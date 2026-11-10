// Outdated and update (#48, phase 4 of #38): which pinned versions have newer
// versions in the library, with evidence for the tuples each pin serves; and an
// explicit, previewed move of one exact tuple's pin. Reads never write; apply edits
// only the owning layer's agents.yaml (guarded, comments kept), then refreshes that
// layer's lock and, without an adapter, stamps. #97: an adapter's bindings update in
// the adapter; the project's in the project; neither writes the other.
import { createHash } from "node:crypto";
import { LOCAL_REFERENCE, type Sources } from "./adapter.ts";
import {
	type ApprovalStatus,
	approvalStatus,
	describeApproval,
	refuseUntrusted,
	trustBlockers,
} from "./approvals.ts";
import { exactRule } from "./binding-target.ts";
import { type FileDiff, packageDiff } from "./content-diff.ts";
import { applyChanges, errorMessage, readLocal } from "./files.ts";
import { libraryEvidence, libraryInfo } from "./library.ts";
import { formatLint, lintPackage, newFindings } from "./lint.ts";
import { installDependencies, readLockState } from "./package-lock.ts";
import { inStoreSession, lookupPackage } from "./package-store.ts";
import { parseManifest } from "./packages.ts";
import {
	packageReferences,
	parseYaml,
	parseYamlDocument,
	resolveConfigured,
	validateConfiguration,
} from "./resolve.ts";
import { releasedPackage } from "./revisions.ts";
import { createStamp } from "./stamps.ts";

// The verified files of one version: a promoted release (label only) or an imported package.
function versionFiles(
	storeRoot: string | undefined,
	name: string,
	version: string,
	revisionDigest: string | null,
) {
	const released =
		revisionDigest === null
			? null
			: releasedPackage({ storeRoot, name, version, revisionDigest });
	const found = released ?? lookupPackage({ storeRoot, name, version });
	if (!found) throw new Error(`update: ${name}@${version} is not in the store`);
	return found.files;
}

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

const PROFILE_KEY = "(profile)";

type Selection = {
	binding: string;
	name: string;
	version: string;
	revisionDigest: string | null;
	sha256: string | null;
	selectedBy: string;
	selectors: Record<string, unknown>;
};

/** #97: an explicit configuration and, with an adapter, its overlay, composed by validation. */
type Composition = { configuration: unknown; adapterConfiguration?: unknown };

export type Layer = "project" | "adapter";
/** The layer that declares a pin: its rule's, or the binding's for the default. */
const layerOf = (sources: Sources, binding: string, rule?: string | null) =>
	sources[rule ? `assignments.${rule}` : binding] === "adapter"
		? ("adapter" as const)
		: ("project" as const);

/** Every package binding one tuple's resolution selects, by binding. */
function selections(
	root: string,
	storeRoot: string | undefined,
	tuple: Tuple,
	composition?: Composition,
): Map<string, Selection> {
	const result = resolveConfigured({
		root,
		storeRoot,
		model: tuple.model,
		role: tuple.role,
		...(tuple.host === null ? {} : { host: tuple.host }),
		...((composition ?? {}) as object),
		lockMode: "validation",
	}) as unknown as Record<string, unknown>;
	const found = new Map<string, Selection>();
	// The resolved profile rides along under a key no binding can have, so the update
	// blast-radius check also proves an edit leaves every tuple's profile unchanged.
	found.set(PROFILE_KEY, {
		binding: PROFILE_KEY,
		name: `profile ${String(result.profile)}`,
		version: "",
		revisionDigest: null,
		sha256: null,
		selectedBy: "",
		selectors: {},
	});
	for (const key of ["loaded", "required", "available"])
		for (const entry of (result[key] as { package?: Selection }[]) ?? [])
			if (entry?.package?.binding)
				found.set(entry.package.binding, {
					binding: entry.package.binding,
					name: entry.package.name,
					version: entry.package.version,
					revisionDigest: entry.package.revisionDigest ?? null,
					sha256: entry.package.sha256 ?? null,
					selectedBy: entry.package.selectedBy,
					selectors: { ...entry.package.selectors },
				});
	return found;
}

/**
 * The tuples to sweep: every configured canonical model × role, once without a host
 * and once per host any assignment rule names (a rule naming a host can only be
 * selected when that host is supplied). #97: exact model IDs that adapter rules name
 * are swept too; only those stated IDs select their rules.
 */
function tuples(validated: ReturnType<typeof validateConfiguration>): Tuple[] {
	const hosts = new Set<string>();
	for (const [, value] of validated.bindings)
		for (const rule of value.rules) {
			const host = rule.when.get("host");
			if (typeof host === "string") hosts.add(host);
		}
	const out: Tuple[] = [];
	for (const model of [
		...new Set([...validated.models.keys(), ...validated.adapterModels]),
	].sort())
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
	composition?: Composition,
) {
	const swept = new Map<
		string,
		{ tuple: Tuple; selected: Map<string, Selection> }
	>();
	for (const tuple of all)
		try {
			swept.set(tupleKey(tuple), {
				tuple,
				selected: selections(root, storeRoot, tuple, composition),
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
				/** #71: approval status under the project's trust policy; null without one. */
				approval: ApprovalStatus | null;
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
							approval: (() => {
								const row = info.approvals?.find(
									(item) => item.version === candidate.version,
								);
								if (!row) return null;
								const { version: _version, ...status } = row;
								return status;
							})(),
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
				/** #97: the layer whose agents.yaml declares this pin. */
				layer: layerOf(validated.adapterSources, binding, rule),
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

// An argument as a terminal would need it: bare when safe, otherwise quoted. Double
// quotes work in PowerShell, cmd and POSIX shells and keep Windows backslashes as they
// are; a value that those would expand ($, `, ") gets single quotes instead.
const shellArg = (value: string) => {
	if (/^[A-Za-z0-9@%+=:,./\\_-]+$/.test(value)) return value;
	if (!/["$`]/.test(value)) return `"${value}"`;
	return `'${value.replaceAll("'", "''")}'`;
};

/**
 * The complete command a person runs to apply this preview. Agents can't run it (the
 * deny rules refuse `update`) and MCP callers have no "same command" to repeat, so the
 * preview spells out every argument, including the project root.
 */
function applyCommand(input: UpdateInput, root: string, digest: string) {
	const { role, model, host } = input.assignment;
	return [
		// The invocation init writes for hooks and the bootstrap: works from a dev dependency.
		"npx --no agent-profiles update",
		shellArg(input.binding),
		shellArg(input.version),
		`--role ${shellArg(role)}`,
		`--model ${shellArg(model)}`,
		`--host ${shellArg(host)}`,
		`--root ${shellArg(root)}`,
		...(input.storeRoot ? [`--store ${shellArg(input.storeRoot)}`] : []),
		...(input.requireEvidence ? ["--require-evidence"] : []),
		`--apply --expect ${digest}`,
	].join(" ");
}

const sha256 = (bytes: Buffer | null) =>
	bytes ? createHash("sha256").update(bytes).digest("hex") : null;

// What a preview saw: every contributing input (#97: project configuration and lock, the
// local reference, the adapter's configuration and lock) and the store identities of the
// current and target versions. Apply with the same digest proves nothing moved between them.
const previewDigest = (
	inputs: (Buffer | null)[],
	adapterRoot: string | null,
	store: unknown,
	input: UpdateInput,
) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				...inputs.map(sha256),
				adapterRoot,
				store,
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
	const adapter = validated.adapter;
	// Every contributing input, in digest order; the adapter's are null without one.
	const configBytes = readLocal(root, CONFIG);
	const lockBytes = readLocal(root, LOCK);
	const localBytes = adapter ? readLocal(root, LOCAL_REFERENCE) : null;
	const adapterConfigBytes = adapter ? readLocal(adapter.root, CONFIG) : null;
	const adapterLockBytes = adapter ? readLocal(adapter.root, LOCK) : null;
	if (!configBytes) throw new Error(`${CONFIG}: missing`);
	if (adapter && !adapterConfigBytes)
		throw new Error(`${adapter.reference}/${CONFIG}: missing`);
	const target: Tuple = { ...assignment };
	const targetSelections = selections(root, storeRoot, target);
	const current = targetSelections.get(binding);
	if (!current || binding === PROFILE_KEY) {
		// A bare skill ID is a common slip: suggest the binding ID it names.
		const suggestion = [...targetSelections.keys()].find(
			(id) =>
				id !== PROFILE_KEY && id.split(".").slice(1).join(".") === binding,
		);
		throw new Error(
			`update: ${binding} is not selected for ${assignment.role} × ${assignment.model} × ${assignment.host}${suggestion ? `; did you mean ${suggestion}?` : ""}`,
		);
	}
	// #97: the binding's layer owns the edit; the other layer's files are never written.
	const layer = layerOf(validated.adapterSources, binding);
	const layerFile = (file: string) =>
		layer === "adapter" ? `${adapter?.reference}/${file}` : file;
	// Rules name canonical models. An alias is written as its model; an undeclared
	// model (reached through a family prefix or default_profile) is declared with the
	// profile it resolves to now, so its routing is unchanged (checked below). An
	// adapter rule names an undeclared model as an exact ID instead: models are project
	// policy, and routing stays the project's.
	const aliases = validated.aliases as Map<string, string>;
	const canonicalModel = validated.models.has(assignment.model)
		? assignment.model
		: (aliases.get(assignment.model) ?? null);
	const currentProfile = (
		targetSelections.get(PROFILE_KEY)?.name ?? ""
	).replace(/^profile /, "");
	const declaredModel =
		canonicalModel === null && layer === "project"
			? { model: assignment.model, profile: currentProfile }
			: null;
	const ruleAssignment = {
		...assignment,
		model: canonicalModel ?? assignment.model,
	};
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
	// What the move would inject (#55): every file that differs, as a unified diff.
	const contentDiff: FileDiff[] =
		current.version === version
			? []
			: packageDiff(
					versionFiles(
						storeRoot,
						name,
						current.version,
						current.revisionDigest,
					),
					versionFiles(storeRoot, name, version, found.revisionDigest),
					{ fromLabel: current.version, toLabel: version },
				);
	// #55 step 3: heuristic warnings on the target's text, marked new or carried over.
	const lint = (() => {
		const targetFiles = versionFiles(
			storeRoot,
			name,
			version,
			found.revisionDigest,
		);
		const effects = parseManifest(
			targetFiles.find((file) => file.path === "package.yaml")?.bytes ??
				Buffer.from(""),
		).behavior.effects;
		const after = lintPackage(targetFiles, effects);
		if (current.version === version)
			return after.map((f) => ({ ...f, new: false }));
		const currentFiles = versionFiles(
			storeRoot,
			name,
			current.version,
			current.revisionDigest,
		);
		const before = lintPackage(
			currentFiles,
			parseManifest(
				currentFiles.find((file) => file.path === "package.yaml")?.bytes ??
					Buffer.from(""),
			).behavior.effects,
		);
		const fresh = new Set(newFindings(before, after));
		return after.map((f) => ({ ...f, new: fresh.has(f) }));
	})();
	const digest = previewDigest(
		[configBytes, lockBytes, localBytes, adapterConfigBytes, adapterLockBytes],
		adapter?.root ?? null,
		{
			store: storeRoot ?? null,
			current: [name, current.version, current.revisionDigest, current.sha256],
			target: [version, found.revisionDigest, found.sha256],
		},
		input,
	);
	// The locks the apply refreshes, and (#97) the one it leaves stale rather than write
	// across layers: the adapter's lock covers the composed configuration.
	const locks = [
		{ layer, file: layerFile(LOCK), action: "refresh" as const },
		...(adapter && layer === "project"
			? [
					{
						layer: "adapter" as const,
						file: `${adapter.reference}/${LOCK}`,
						action: "stale" as const,
					},
				]
			: []),
	];
	const base = {
		root,
		/** #97: the layer that owns the binding and receives every edit. */
		layer,
		/** #97: the adapter composed with the project; null without one. */
		adapter: adapter
			? { reference: adapter.reference, root: adapter.root }
			: null,
		locks,
		previewDigest: digest,
		/** The full apply command for a person to run; every argument filled in. */
		applyCommand: applyCommand(input, root, digest),
		contentDiff,
		/** Heuristic warnings on the target version's text (#55 step 3); never blocks. */
		lint,
		/** Set when the target model was undeclared: the models entry the edit adds. */
		declaredModel,
		/** #71: the target version's approval status; null without a trust policy. */
		approval: approvalStatus({ root, storeRoot, name, version }),
		/** What the trust policy refuses about the target; `--apply` refuses when nonempty. */
		trustBlockers: trustBlockers({
			root,
			storeRoot,
			packages: [{ name, version }],
		}),
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
			edits: [],
			changed: [],
			inputs: [] as Snapshot[],
			nextConfig: null,
		};
	if (
		input.requireEvidence &&
		!evidence.some((row) => row.outcome.startsWith("promoted"))
	)
		throw new Error(
			`update: --require-evidence: ${name}@${version} has no promoted evidence for ${assignment.role} × ${assignment.model} × ${assignment.host}`,
		);
	const rule = exactRule(current, ruleAssignment, "update");
	const assignments = validated.config.get("assignments") as
		| Map<string, Map<string, unknown>>
		| undefined;
	if (rule.action === "add" && assignments?.has(rule.id))
		throw new Error(
			`update: assignments.${rule.id} already exists for another selector; nothing was written`,
		);
	// Composition keeps assignments with their binding's layer; refuse anything else.
	const ruleLayer = layerOf(validated.adapterSources, binding, rule.id);
	if (rule.action === "replace" && ruleLayer !== layer)
		throw new Error(
			`update: ${binding} belongs to the ${layer} but assignments.${rule.id} belongs to the ${ruleLayer}; an update edits one layer only; nothing was written`,
		);
	const editBytes = (
		layer === "adapter" ? adapterConfigBytes : configBytes
	) as Buffer;
	const document = parseYamlDocument(editBytes.toString("utf8"));
	if (declaredModel)
		document.setIn(
			["models", declaredModel.model],
			document.createNode({ profile: declaredModel.profile }),
		);
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
	// With an adapter, the edited layer composes with the other layer's current file.
	const composition: Composition = !adapter
		? { configuration: parsed }
		: layer === "adapter"
			? {
					configuration: parseYaml(configBytes.toString("utf8")),
					adapterConfiguration: parsed,
				}
			: {
					configuration: parsed,
					adapterConfiguration: parseYaml(
						(adapterConfigBytes as Buffer).toString("utf8"),
					),
				};
	try {
		// A project edit must also stand alone: the committed configuration works without the adapter.
		if (adapter && layer === "project")
			validateConfiguration({ root, configuration: parsed });
		validateConfiguration({ root, ...(composition as object) });
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
	const after = sweep(root, storeRoot, all, problems, composition);
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
	// Every agents.yaml edit in one list, in the JSON as in the text, so a reader of
	// either can't report the rule and miss the model declaration. #97: each names its
	// layer and file (relative to the project root).
	const file = layerFile(CONFIG);
	const edits = [
		{
			layer,
			file,
			path: `assignments.${rule.id}`,
			action:
				rule.action === "replace"
					? ("replace-binding" as const)
					: ("add-rule" as const),
			description: `${rule.action === "replace" ? "replace the binding in" : "add rule"} assignments.${rule.id}`,
		},
		...(declaredModel
			? [
					{
						layer,
						file,
						path: `models.${declaredModel.model}`,
						action: "declare-model" as const,
						description: `declare models.${declaredModel.model} with profile ${declaredModel.profile}, the profile it resolves to now (routing unchanged)`,
					},
				]
			: []),
	];
	return {
		...base,
		status: "preview" as const,
		rule,
		edits,
		changed,
		inputs: [
			[root, CONFIG, configBytes],
			[root, LOCK, lockBytes],
			...(adapter
				? ([
						[root, LOCAL_REFERENCE, localBytes],
						[adapter.root, CONFIG, adapterConfigBytes],
						[adapter.root, LOCK, adapterLockBytes],
					] as Snapshot[])
				: []),
		] as Snapshot[],
		nextConfig: {
			root: layer === "adapter" ? (adapter?.root as string) : root,
			before: editBytes,
			after: nextConfig,
		},
		problems,
	};
}

/** A contributing file as the preview read it: base directory, relative path, bytes. */
type Snapshot = [string, string, Buffer | null];

const publicPlan = ({
	inputs: _i,
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
			"update: the configuration, lock, adapter, store or target changed since the preview (previewDigest differs); preview again; nothing was written",
		);
	if (plan.status === "already-pinned") return publicPlan(plan);
	// Apply never signs or approves: an untrusted target is refused (#71, #97).
	refuseUntrusted(plan.trustBlockers, "update");
	const { root, inputs, nextConfig } = plan;
	for (const [base, file, before] of inputs)
		if (
			!(readLocal(base, file) ?? Buffer.alloc(0)).equals(
				before ?? Buffer.alloc(0),
			)
		)
			throw new Error(`${file}: changed during the operation; retry`);
	if (!nextConfig) throw new Error("update: nothing to write");
	applyChanges(nextConfig.root, [
		{ file: CONFIG, before: nextConfig.before, after: nextConfig.after },
	]);
	// With an adapter, install writes only the adapter's lock (#85); a project edit
	// refreshes the committed lock alone and leaves the adapter's stale (see `locks`).
	installDependencies({
		root,
		storeRoot: input.storeRoot,
		...(plan.adapter && plan.layer === "project" ? { committed: true } : {}),
	});
	// shortcut: stamps do not compose an adapter yet, so adapter mode records none; revisit with #98.
	const stamp = plan.adapter
		? null
		: createStamp({
				root,
				storeRoot: input.storeRoot,
				...input.assignment,
				identitySource: "user",
			});
	return {
		...publicPlan(plan),
		status: "updated" as const,
		stampDigest: stamp?.digest ?? null,
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
			const approval = describeApproval(candidate.approval);
			if (approval) lines.push(`    Approval: ${approval}`);
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
		// #97: with an adapter, name the layer and the file every edit goes to.
		`  ${result.status === "updated" ? "Edited" : "Edits to"} ${result.adapter ? `the ${result.layer} layer, ${result.edits[0]?.file}` : "agents.yaml"} (${result.edits.length}):`,
		...result.edits.map((edit) => `    - ${edit.description}`),
		`  Selections changed: ${result.changed.map((row) => `${describeTuple(row.tuple)} ${row.binding} ${row.from} → ${row.to}`).join("; ")}`,
		...(result.approval
			? [
					`  Approval of ${result.after.version}: ${describeApproval(result.approval)}`,
				]
			: []),
		...(result.trustBlockers.length && result.status === "preview"
			? [
					`  Apply will be refused by the trust policy: ${result.trustBlockers.join("; ")}`,
				]
			: []),
		`  Evidence for this tuple: ${result.evidence.length ? result.evidence.map((row) => `${row.outcome}, ${row.origin}`).join("; ") : "untested"}`,
	];
	// The words that would reach the agent's context, before anything is applied (#55).
	if (result.status === "preview") {
		lines.push(
			result.contentDiff.length
				? `  Content changes (${result.contentDiff.length} file${result.contentDiff.length === 1 ? "" : "s"}); read them before applying:`
				: "  Content changes: none (identical files)",
		);
		for (const file of result.contentDiff) {
			lines.push(
				`    ${file.status}: ${file.path}${file.diff === null ? " (binary)" : ""}`,
			);
			if (file.diff)
				lines.push(...file.diff.split("\n").map((line) => `      ${line}`));
		}
		lines.push(...formatLint(result.lint));
	}
	if (result.adapter)
		for (const lock of result.locks)
			lines.push(
				lock.action === "refresh"
					? `  ${result.status === "updated" ? "Refreshed" : "Apply refreshes"} the ${lock.layer} lock ${lock.file}`
					: `  ${result.status === "updated" ? "Left" : "Apply leaves"} the ${lock.layer} lock ${lock.file} stale: it covers the composed configuration, and update never writes another layer. Refresh it with agent-profiles install as a separate step`,
			);
	if (result.status === "updated")
		lines.push(
			result.stampDigest
				? `  Lock refreshed; stamp sha256 ${result.stampDigest}`
				: "  No stamp recorded: stamps do not compose an adapter yet (#98)",
		);
	else
		lines.push(
			"  To apply, a person runs this in a terminal (agents can't):",
			`    ${result.applyCommand}`,
		);
	return lines.join("\n");
}
