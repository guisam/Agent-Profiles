// Configuration edits from the visualizer (#119): add or remove role skills, and add
// models, families and roles. Each edit is written to the layer that owns the
// definition (project agents.yaml or the referenced adapter's), validated alone and
// composed before anything is written, rolled back on failure, and followed by a
// lock refresh. Nothing here signs, approves or downloads packages.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { LOCAL_REFERENCE, readAdapter } from "./adapter.ts";
import { refuseUntrusted, trustBlockers } from "./approvals.ts";
import { planRoleChange, type RoleChangePlan, yamlText } from "./configure.ts";
import { applyChanges, readLocal } from "./files.ts";
import { libraryInfo } from "./library.ts";
import { applyUpdate, previewUpdate } from "./outdated.ts";
import { installDependencies } from "./package-lock.ts";
import {
	identifier,
	parseYaml,
	parseYamlDocument,
	resolveInstructions,
	validateConfiguration,
	type YamlMap,
} from "./resolve.ts";
import { packageSkillName } from "./skill-catalog.ts";

const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";

export type SkillList = "required" | "available";
export type ConfigEdit =
	| { action: "add-skill"; role: string; skill: string; list: SkillList }
	| { action: "remove-skill"; role: string; skill: string }
	| { action: "add-model"; id: string; profile: string }
	| {
			action: "add-family";
			id: string;
			profile: string;
			prefixes?: string[];
	  }
	| { action: "add-role"; id: string; description?: string }
	| {
			/** Bind a library package version as a new skill and list it in a role. */
			action: "bind-skill";
			role: string;
			list: SkillList;
			package: string;
			version: string;
			/** Optional: the skill ID to use; defaults to the SKILL.md name. */
			id?: string;
			/** Optional: a same-name skill in the role that the new binding replaces. */
			replace?: string;
	  }
	| {
			/** Choose another package version for one binding, for one host × model × role (as update does). */
			action: "preview-replace" | "apply-replace";
			binding: string;
			/** `@namespace/name@version` */
			target: string;
			assignment: { role: string; model: string; host: string };
			/** apply-replace: the previewDigest the preview returned. */
			expect?: string;
	  };

/** The page's view is older than the files on disk; the caller should reload. */
export class EditConflict extends Error {}

/** A digest of every configuration file an edit can touch, so a stale page cannot overwrite newer edits. */
export function configRevision(root: string) {
	const repository = realpathSync(root);
	const adapter = readAdapter(repository);
	const hash = createHash("sha256");
	const files: [string, string][] = [
		[repository, CONFIG],
		[repository, LOCAL_REFERENCE],
		...(adapter ? ([[adapter.root, CONFIG]] as [string, string][]) : []),
	];
	for (const [index, [base, file]] of files.entries()) {
		const bytes = readLocal(base, file);
		hash.update(`${index}:${bytes === null ? "absent" : bytes.length}\0`);
		if (bytes) hash.update(bytes);
	}
	return hash.digest("hex");
}

/** Profile IDs a new model or family can use: configured profiles and profile files. */
export function profileChoices(root: string) {
	const validated = validateConfiguration({ root });
	const directory = path.join(validated.repository, ".agent-profiles/profiles");
	const files = existsSync(directory)
		? readdirSync(directory)
				.filter((file) => file.endsWith(".md"))
				.map((file) => file.slice(0, -3))
		: [];
	return [...new Set([...validated.profiles.keys(), ...files])].sort();
}

const listOf = (config: YamlMap | undefined, role: string, list: SkillList) => {
	const items = config?.get("roles")?.get(role)?.get("skills")?.get(list);
	return Array.isArray(items) ? (items as string[]) : [];
};

// Refresh every lock the edited layer can make stale. With an adapter, the adapter
// lock covers the composed configuration the visualizer shows; a project edit also
// refreshes the committed project lock so the project still works alone.
// shortcut: a failed second install leaves the first lock refreshed for a config
// that was rolled back; rerun `agent-profiles install` if that ever happens.
function refreshLocks(
	repository: string,
	storeRoot: string | undefined,
	layer: "project" | "adapter",
) {
	const adapter = readAdapter(repository);
	const bindings = validateConfiguration({ root: repository }).bindings.size;
	if (adapter) {
		if (layer === "project" && existsSync(path.join(repository, LOCK)))
			installDependencies({ root: repository, storeRoot, committed: true });
		if (bindings || existsSync(path.join(adapter.root, LOCK)))
			installDependencies({ root: repository, storeRoot });
	} else if (bindings || existsSync(path.join(repository, LOCK)))
		installDependencies({ root: repository, storeRoot });
}

/** Write a role plan; a failed check or lock refresh rolls the files back. */
function applyRolePlan(plan: RoleChangePlan, storeRoot: string | undefined) {
	if (!readLocal(plan.root, CONFIG)?.equals(plan.before))
		throw new EditConflict(
			"The configuration changed while saving; select Refresh files and try again. Nothing was written.",
		);
	applyChanges(plan.root, plan.changes, () => {
		resolveInstructions({
			root: plan.root,
			role: plan.id,
			storeRoot,
			lockMode: "validation",
		});
		refreshLocks(plan.root, storeRoot, "project");
	});
}

/** Edit one layer's agents.yaml, validated alone (project) and composed, then write it. */
function writeLayer(
	repository: string,
	layer: "project" | "adapter",
	change: (document: ReturnType<typeof parseYamlDocument>) => void,
	storeRoot: string | undefined,
) {
	const adapter = readAdapter(repository);
	const base = layer === "adapter" ? adapter?.root : repository;
	if (!base) throw new Error("No adapter is referenced");
	const before = readLocal(base, CONFIG);
	if (!before) throw new Error(`${CONFIG} is missing`);
	const document = parseYamlDocument(before.toString("utf8"));
	change(document);
	const after = Buffer.from(yamlText(document, before));
	const parsed = parseYaml(after.toString("utf8"));
	const project = readLocal(repository, CONFIG) as Buffer;
	try {
		if (layer === "project")
			validateConfiguration({ root: repository, configuration: parsed });
		if (adapter)
			validateConfiguration(
				layer === "project"
					? {
							root: repository,
							configuration: parsed,
							adapterConfiguration: parseYaml(
								(readLocal(adapter.root, CONFIG) as Buffer).toString("utf8"),
							),
						}
					: {
							root: repository,
							configuration: parseYaml(project.toString("utf8")),
							adapterConfiguration: parsed,
						},
			);
	} catch (error) {
		throw new Error(
			`The edited configuration is not valid; nothing was written. ${(error as Error).message}`,
		);
	}
	applyChanges(base, [{ file: CONFIG, before, after }], () =>
		refreshLocks(repository, storeRoot, layer),
	);
	return {
		layer,
		file: layer === "adapter" ? `${adapter?.reference}/${CONFIG}` : CONFIG,
	};
}

function editRoleSkills(
	repository: string,
	storeRoot: string | undefined,
	edit: Extract<ConfigEdit, { action: "add-skill" | "remove-skill" }>,
) {
	const validated = validateConfiguration({ root: repository });
	const sources = validated.adapterSources;
	const lists = validated.roleSkills.get(edit.role);
	if (!lists) throw new Error(`Role ${edit.role} does not exist`);
	identifier(edit.skill, "skill");
	const listed = (["required", "available"] as const).find((list) =>
		lists[list].some((skill) => skill.id === edit.skill),
	);
	const roleLayer =
		sources[`roles.${edit.role}`] === "adapter" ? "adapter" : "project";
	// The layer that wrote this entry into the role's list.
	const entryLayer = (list: SkillList) =>
		roleLayer === "adapter" ||
		sources[`roles.${edit.role}.skills.${list}.${edit.skill}`] === "adapter"
			? "adapter"
			: "project";
	let from: { list: SkillList; layer: "project" | "adapter" } | null = null;
	let to: { list: SkillList; layer: "project" | "adapter" } | null = null;
	if (edit.action === "remove-skill") {
		if (!listed)
			throw new Error(`${edit.skill} is not listed by role ${edit.role}`);
		from = { list: listed, layer: entryLayer(listed) };
	} else {
		if (edit.list !== "required" && edit.list !== "available")
			throw new Error("Choose required or available");
		if (listed === edit.list)
			throw new Error(
				`${edit.skill} is already ${edit.list} for role ${edit.role}`,
			);
		// A project role cannot name an adapter binding alone, so the adapter appends it.
		to = {
			list: edit.list,
			layer:
				roleLayer === "adapter" || sources[`skills.${edit.skill}`] === "adapter"
					? "adapter"
					: "project",
		};
		if (listed) from = { list: listed, layer: entryLayer(listed) };
		if (from && from.layer !== to.layer)
			throw new Error(
				`${edit.skill} is ${from.list} through the ${from.layer} configuration; remove it there before adding it as ${to.list}`,
			);
	}
	const layer = (to ?? from)?.layer as "project" | "adapter";
	if (layer === "project") {
		// The project editor keeps YAML anchors, file checks and alias handling.
		const project = parseYaml(
			(readLocal(repository, CONFIG) as Buffer).toString("utf8"),
		);
		const next = {
			required: listOf(project, edit.role, "required"),
			available: listOf(project, edit.role, "available"),
		};
		if (from)
			next[from.list] = next[from.list].filter((id) => id !== edit.skill);
		if (to) next[to.list] = [...next[to.list], edit.skill];
		const plan = planRoleChange({
			root: repository,
			action: "edit",
			id: edit.role,
			...next,
			storeRoot,
		});
		applyRolePlan(plan, storeRoot);
		return { layer, file: CONFIG };
	}
	return writeLayer(
		repository,
		"adapter",
		(document) => {
			const overlay = document.toJS({ mapAsMap: true }) as YamlMap;
			for (const step of [from, to].filter((item) => item !== null)) {
				const current = listOf(overlay, edit.role, step.list);
				const next =
					step === from
						? current.filter((id) => id !== edit.skill)
						: [...current, edit.skill];
				// from and to are always different lists, so each reads the original overlay.
				document.setIn(["roles", edit.role, "skills", step.list], next);
			}
		},
		storeRoot,
	);
}

/** Bind a library package version as a skill in the role's layer and list it in the role. */
function bindSkill(
	repository: string,
	storeRoot: string | undefined,
	edit: Extract<ConfigEdit, { action: "bind-skill" }>,
) {
	if (edit.list !== "required" && edit.list !== "available")
		throw new Error("Choose required or available");
	const validated = validateConfiguration({ root: repository });
	if (!validated.roleSkills.has(edit.role))
		throw new Error(`Role ${edit.role} does not exist`);
	const info = libraryInfo({
		storeRoot,
		name: edit.package,
		version: edit.version,
		root: repository,
	});
	const entry = info.versions[0];
	if ("error" in entry)
		throw new Error(
			`${edit.package}@${edit.version}: unverified: ${entry.error}`,
		);
	if (entry.type !== "skill")
		throw new Error(`${edit.package}@${edit.version} is not a skill package`);
	const v3 = validated.config.get("version") === 3;
	if (v3 && !entry.revisionDigest)
		throw new Error(
			`${edit.package}@${edit.version} has no release label; configuration v3 pins a revision. Adopt it with agent-profiles revision record first`,
		);
	// Apply never signs or approves: an untrusted package is refused, as update does.
	refuseUntrusted(
		trustBlockers({
			root: repository,
			storeRoot,
			packages: [{ name: edit.package, version: edit.version }],
		}),
		"bind",
	);
	const sources = validated.adapterSources;
	const layer =
		sources[`roles.${edit.role}`] === "adapter" ? "adapter" : "project";
	const taken = (id: string) =>
		validated.bindings.has(`skills.${id}`) ||
		validated.config.get("skills")?.has(id) ||
		existsSync(
			path.join(validated.repository, `.agent-profiles/skills/${id}/SKILL.md`),
		);
	let id = edit.id;
	if (id !== undefined) {
		identifier(id, "skill");
		if (taken(id)) throw new Error(`Skill ID ${id} is already used`);
	} else {
		// Default to the SKILL.md name, so variants of one skill share a recognizable ID.
		const name = packageSkillName(
			storeRoot,
			{
				name: edit.package,
				version: edit.version,
				revisionDigest: entry.revisionDigest,
			},
			entry.entrypoint,
		);
		const base =
			name && /^[a-z0-9][a-z0-9-]*$/.test(name)
				? name
				: (edit.package.split("/").pop() as string);
		id = base;
		for (let suffix = 2; taken(id); suffix++) id = `${base}-${suffix}`;
	}
	const lists = validated.roleSkills.get(edit.role) as {
		required: { id: string }[];
		available: { id: string }[];
	};
	let replaced: SkillList | null = null;
	if (edit.replace !== undefined) {
		replaced =
			(["required", "available"] as const).find((list) =>
				lists[list].some((skill) => skill.id === edit.replace),
			) ?? null;
		if (!replaced)
			throw new Error(`${edit.replace} is not listed by role ${edit.role}`);
		const owner =
			layer === "adapter" ||
			sources[`roles.${edit.role}.skills.${replaced}.${edit.replace}`] ===
				"adapter"
				? "adapter"
				: "project";
		if (owner !== layer)
			throw new Error(
				`${edit.replace} is listed through the ${owner} configuration; remove it there first`,
			);
	}
	const written = writeLayer(
		repository,
		layer,
		(document) => {
			const current = document.toJS({ mapAsMap: true }) as YamlMap;
			document.setIn(
				["skills", id],
				document.createNode({
					package: edit.package,
					version: edit.version,
					...(v3 ? { revision: entry.revisionDigest } : {}),
				}),
			);
			for (const list of ["required", "available"] as const) {
				let items = listOf(current, edit.role, list);
				if (list === replaced)
					items = items.filter((skill) => skill !== edit.replace);
				if (list === edit.list) items = [...items, id];
				if (list === replaced || list === edit.list)
					document.setIn(["roles", edit.role, "skills", list], items);
			}
		},
		storeRoot,
	);
	return { ...written, id };
}

/** Apply one edit if the configuration still matches `revision`; returns the written layer. */
export function applyConfigEdit({
	root,
	storeRoot,
	revision,
	edit,
}: {
	root: string;
	storeRoot?: string;
	revision: string;
	edit: ConfigEdit;
}) {
	const repository = realpathSync(root);
	if (revision !== configRevision(repository))
		throw new EditConflict(
			"The configuration changed since this page loaded; select Refresh files and try again. Nothing was written.",
		);
	switch (edit?.action) {
		case "preview-replace":
		case "apply-replace": {
			const input = {
				root: repository,
				storeRoot,
				binding: edit.binding,
				version: edit.target,
				assignment: edit.assignment,
			};
			if (edit.action === "preview-replace") return previewUpdate(input);
			if (typeof edit.expect !== "string")
				throw new Error("Preview the replacement before applying it");
			const result = applyUpdate({ ...input, expect: edit.expect });
			// update refreshes only the edited layer's lock; the composed view needs the adapter lock too.
			if (readAdapter(repository) && result.layer === "project")
				installDependencies({ root: repository, storeRoot });
			return result;
		}
		case "bind-skill":
			return bindSkill(repository, storeRoot, edit);
		case "add-skill":
		case "remove-skill":
			return editRoleSkills(repository, storeRoot, edit);
		case "add-role": {
			identifier(edit.id, "role");
			const plan = planRoleChange({
				root: repository,
				action: "create",
				id: edit.id,
				...(edit.description ? { description: edit.description } : {}),
				required: [],
				available: [],
				storeRoot,
			});
			applyRolePlan(plan, storeRoot);
			return { layer: "project" as const, file: CONFIG };
		}
		case "add-model":
		case "add-family": {
			// Models and families are project policy; an adapter may not declare them.
			const validated = validateConfiguration({ root: repository });
			const id =
				edit.action === "add-family"
					? identifier(edit.id, "family")
					: typeof edit.id === "string" && /^\S+$/.test(edit.id)
						? edit.id
						: (() => {
								throw new Error("Model ID: expected text without spaces");
							})();
			if (
				edit.action === "add-model"
					? validated.models.has(id) || validated.aliases.has(id)
					: validated.families.has(id)
			)
				throw new Error(`${id} already exists`);
			identifier(edit.profile, "profile");
			const prefixes =
				edit.action === "add-family" ? (edit.prefixes ?? []) : [];
			if (
				!Array.isArray(prefixes) ||
				prefixes.some((prefix) => typeof prefix !== "string" || !prefix)
			)
				throw new Error("Family prefixes: expected a list of text");
			return writeLayer(
				repository,
				"project",
				(document) =>
					document.setIn(
						[edit.action === "add-model" ? "models" : "families", id],
						document.createNode({
							profile: edit.profile,
							...(prefixes.length ? { match: { prefixes } } : {}),
						}),
					),
				storeRoot,
			);
		}
		default:
			throw new Error("Unknown edit action");
	}
}
