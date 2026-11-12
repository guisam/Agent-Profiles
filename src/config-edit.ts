// Configuration edits from the visualizer (#119): add or remove role skills, and add
// models, families and roles. Each edit is written to the layer that owns the
// definition (project agents.yaml or the referenced adapter's), validated alone and
// composed before anything is written, rolled back on failure, and followed by a
// lock refresh. Nothing here signs, approves or downloads packages.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { LOCAL_REFERENCE, readAdapter } from "./adapter.ts";
import { planRoleChange, type RoleChangePlan, yamlText } from "./configure.ts";
import { applyChanges, readLocal } from "./files.ts";
import { installDependencies } from "./package-lock.ts";
import {
	identifier,
	parseYaml,
	parseYamlDocument,
	resolveInstructions,
	validateConfiguration,
	type YamlMap,
} from "./resolve.ts";

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
	| { action: "add-role"; id: string; description?: string };

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
	edit: Extract<ConfigEdit, { role: string }>,
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
