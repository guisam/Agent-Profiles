import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { isNode, visit } from "yaml";
import { applyChanges, type FileChange, readLocal, safePath } from "./files.ts";
import {
	identifier,
	localFile,
	parseYaml,
	parseYamlDocument,
	resolveInstructions,
	skillMetadata,
	type YamlMap,
} from "./resolve.ts";
import { validateSkillSelection } from "./skills.ts";

const configFile = ".agent-profiles/agents.yaml";

export type ReadOptions = {
	metadataOnly?: boolean;
	content?: Buffer;
	storeRoot?: string;
	lockMode?: "required" | "validation";
};

/**
 * A bounded inspection may supply already-read bytes; mutation callers always read disk.
 * Mutation workflows validate a possibly stale-locked project; public readers pass lockMode 'required'.
 */
export function readConfiguration(
	root: string,
	{
		metadataOnly = false,
		content,
		storeRoot,
		lockMode = "validation",
	}: ReadOptions = {},
) {
	root = realpathSync(root);
	const before =
		metadataOnly && content !== undefined
			? content
			: readLocal(root, configFile);
	if (before === null)
		throw new Error(`${configFile} is missing; run init first`);
	const document = parseYamlDocument(before.toString("utf8"));
	const configuration = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
	resolveInstructions({
		root,
		configuration,
		metadataOnly,
		storeRoot,
		lockMode,
	});
	return { root, before, document, configuration };
}

export type PackageSelection = {
	name: string;
	version: string;
	// Absent for declared package skills; planRoleChange then reports the binding as changed.
	sha256?: string;
	revisionDigest?: string | null;
	binding: string;
};

/** A skill ID, or a discovered skill: a local path, a host-native skill, or a package binding. */
export type SkillSelection =
	| string
	| {
			id?: string;
			path?: string | null;
			host?: string | null;
			scope?: string;
			hostId?: string | null;
			package?: PackageSelection;
	  };

export type RoleChangeOptions = {
	root: string;
	action: string;
	id: string;
	file?: string;
	description?: string;
	required?: SkillSelection[];
	available?: SkillSelection[];
	defaultRole?: string;
	expectedConfiguration?: Buffer;
	sourceOptions?: object;
	storeRoot?: string;
};

/** Build a validated, reviewable plan; this function never writes files. */
export function planRoleChange({
	root,
	action,
	id,
	file,
	description,
	required,
	available,
	defaultRole,
	expectedConfiguration,
	sourceOptions,
	storeRoot,
}: RoleChangeOptions) {
	const state = readConfiguration(root, { storeRoot });
	({ root } = state);
	const { document, configuration, before } = state;
	if (expectedConfiguration && !before.equals(expectedConfiguration))
		throw new Error(
			"Configuration changed while editing; reload the role before retrying",
		);
	identifier(id, "role");
	if (!["create", "edit", "delete"].includes(action))
		throw new Error("Choose create, edit, or delete");
	const roles = configuration.get("roles");
	if (action === "create" && roles.has(id))
		throw new Error(`Role ${id} already exists; edit it instead`);
	if (action !== "create" && !roles.has(id))
		throw new Error(`Role ${id} does not exist`);
	if (action === "edit" && roles.get(id).has("package")) {
		throw new Error(
			`roles.${id} is backed by package ${roles.get(id).get("package")}@${roles.get(id).get("version")}; edit it manually in ${configFile}`,
		);
	}
	const node = document.getIn(["roles", id], true);
	let shared = false;
	if (isNode(node))
		visit(node, {
			Value(_, item) {
				if (item.anchor)
					throw new Error(
						`Role ${id} defines a YAML anchor; edit shared anchors manually`,
					);
			},
			Alias() {
				shared = true;
			},
		});
	const aliases: { id: string; originalId: string; path: string }[] = [];
	const selectionChecks: Exclude<SkillSelection, string>[] = [];
	const packageSelections: { id: string; package: PackageSelection }[] = [];
	const changes: FileChange[] = [];
	let newRoleFile: { path: string; content: string } | undefined;

	if (action === "delete") {
		if (configuration.get("default_role") === id) {
			if (!defaultRole || defaultRole === id || !roles.has(defaultRole)) {
				throw new Error(
					`Choose another existing default role before deleting ${id}`,
				);
			}
			document.set("default_role", defaultRole);
		} else if (defaultRole !== undefined) {
			throw new Error(
				"A replacement default is only needed when deleting the default role",
			);
		}
		document.deleteIn(["roles", id]);
	} else {
		const previous = roles.get(id);
		if (required === undefined)
			required = previous?.get("skills").get("required") ?? [];
		if (available === undefined)
			available = previous?.get("skills").get("available") ?? [];
		if (!Array.isArray(required) || !Array.isArray(available))
			throw new Error("Required and available skills must be lists");
		if (description !== undefined && typeof description !== "string")
			throw new Error("Role description must be text");
		file ??= (previous?.get("file") as string | undefined) ?? `roles/${id}.md`;
		localFile(
			path.join(root, ".agent-profiles"),
			file,
			`roles.${id}.file`,
			".agent-profiles",
			true,
		);
		const roleFile = `.agent-profiles/${file}`;
		if (!existsSync(path.join(root, roleFile))) {
			const title = id
				.split("-")
				.map((word: string) => word[0].toUpperCase() + word.slice(1))
				.join(" ");
			const content = `# ${title}\n\n${description?.trim() || `Describe the responsibilities of ${id} here.`}\n`;
			newRoleFile = { path: file, content };
			changes.push({
				file: roleFile,
				before: null,
				after: Buffer.from(content),
			});
		}
		const sources = new Map<string, YamlMap>(configuration.get("skills") ?? []);
		const binding = (skillId: string) =>
			sources.has(skillId)
				? (sources.get(skillId)?.get("file") ?? null)
				: `.agent-profiles/skills/${skillId}/SKILL.md`;
		const targetOf = (skillId: string) => {
			const candidate = binding(skillId);
			return candidate && existsSync(path.join(root, candidate))
				? localFile(root, candidate, skillId, "repository")
				: null;
		};
		const bind = (selection: SkillSelection, entry: string) => {
			if (typeof selection !== "string") {
				validateSkillSelection(root, selection, sourceOptions);
				if (selection.host && selection.path)
					selectionChecks.push({ ...selection });
			}
			const skillId = identifier(
				typeof selection === "string" ? selection : selection?.id,
				entry,
			);
			if (
				typeof selection === "string" &&
				(sources.get(skillId)?.has("host") ||
					sources.get(skillId)?.has("package"))
			)
				return skillId;
			if (typeof selection !== "string" && selection.package) {
				// Reuse only the current binding; its version and digest are checked against the preview resolution below.
				if (
					selection.package.binding !== `skills.${skillId}` ||
					!sources.get(skillId)?.has("package")
				) {
					throw new Error(
						`${entry}: ${skillId} is not the current package binding ${selection.package.name}; reload the role`,
					);
				}
				packageSelections.push({ id: skillId, package: selection.package });
				return skillId;
			}
			if (typeof selection !== "string" && selection.host) {
				// Host skills keep the host's own identity: a conflict is reported, never renamed to an alias.
				const current = sources.get(skillId);
				if (
					current?.get("host") === selection.host &&
					current.get("scope") === selection.scope &&
					(current.get("id") ?? skillId) === selection.hostId
				)
					return skillId;
				if (
					current ||
					existsSync(
						path.join(root, `.agent-profiles/skills/${skillId}/SKILL.md`),
					)
				) {
					throw new Error(
						`${entry}: ${skillId} already names another skill, so the ${selection.host} skill ${selection.hostId} cannot use it; rename one of them first`,
					);
				}
				const reference = new Map(
					Object.entries({
						host: selection.host,
						scope: selection.scope,
						...(selection.hostId === skillId ? {} : { id: selection.hostId }),
					}),
				);
				sources.set(skillId, reference);
				document.setIn(
					["skills", skillId],
					document.createNode(Object.fromEntries(reference)),
				);
				return skillId;
			}
			const requested =
				typeof selection === "string" ? binding(skillId) : selection.path;
			const target = localFile(root, requested, entry, "repository");
			const selectedPath = requested as string; // localFile rejected anything else
			skillMetadata(target, entry, undefined, selectedPath);
			if (targetOf(skillId) === target) return skillId;
			for (const existingId of sources.keys()) {
				if (targetOf(existingId) === target) return existingId;
			}
			let reference = skillId;
			for (
				let suffix = 2;
				targetOf(reference) !== null || sources.has(reference);
				suffix++
			)
				reference = `${skillId}-${suffix}`;
			sources.set(reference, new Map([["file", selectedPath]]));
			document.setIn(["skills", reference, "file"], selectedPath);
			if (reference !== skillId)
				aliases.push({
					id: reference,
					originalId: skillId,
					path: selectedPath,
				});
			return reference;
		};
		const next = {
			file,
			skills: {
				required: required.map((skill, index) =>
					bind(skill, `roles.${id}.skills.required[${index}]`),
				),
				available: available.map((skill, index) =>
					bind(skill, `roles.${id}.skills.available[${index}]`),
				),
			},
		};
		if (!previous || shared)
			document.setIn(["roles", id], document.createNode(previous ?? new Map()));
		document.setIn(["roles", id, "file"], next.file);
		document.setIn(["roles", id, "skills", "required"], next.skills.required);
		document.setIn(["roles", id, "skills", "available"], next.skills.available);
		if (description !== undefined) {
			if (description.trim())
				document.setIn(["roles", id, "description"], description.trim());
			else document.deleteIn(["roles", id, "description"]);
		}
	}

	// Keep comments and unrelated YAML nodes; retain the original newline style and BOM.
	let text = document.toString({ lineWidth: 0 });
	if (before.includes(Buffer.from("\r\n"))) text = text.replace(/\n/g, "\r\n");
	if (before.toString("utf8").startsWith("\uFEFF")) text = `\uFEFF${text}`;
	if (!before.toString("utf8").endsWith("\n"))
		text = text.replace(/\r?\n$/, "");
	const proposed = parseYaml(text);
	const role = action === "delete" ? undefined : id;
	const resolution = resolveInstructions({
		root,
		role,
		configuration: proposed,
		newRoleFile,
		storeRoot,
		lockMode: "validation",
	});
	for (const selection of packageSelections) {
		const current = [...resolution.required, ...resolution.available].find(
			(skill) => skill.id === selection.id,
		)?.package;
		if (
			current?.name !== selection.package.name ||
			current?.version !== selection.package.version ||
			current.sha256 !== selection.package.sha256 ||
			current.revisionDigest !== selection.package.revisionDigest
		) {
			throw new Error(
				`${selection.id}: package binding changed since it was selected; reload the role`,
			);
		}
	}
	// Avoid rewriting even formatting when the effective configuration is unchanged.
	const unchanged =
		JSON.stringify([...configuration], (_, value) =>
			value instanceof Map ? Object.fromEntries(value) : value,
		) ===
		JSON.stringify([...proposed], (_, value) =>
			value instanceof Map ? Object.fromEntries(value) : value,
		);
	const after = unchanged ? before : Buffer.from(text);
	if (!after.equals(before)) changes.push({ file: configFile, before, after });
	for (const change of changes) safePath(root, change.file);
	return {
		root,
		action,
		id,
		before,
		after,
		changes,
		newRoleFile,
		resolution,
		aliases,
		selectionChecks,
		sourceOptions,
		storeRoot,
		instructionFile:
			action === "delete"
				? roles.get(id).get("file")
				: proposed.get("roles").get(id).get("file"),
	};
}

export type RoleChangePlan = ReturnType<typeof planRoleChange>;

export function applyRoleChange(plan: RoleChangePlan) {
	if (!readLocal(plan.root, configFile)?.equals(plan.before))
		throw new Error(
			"Configuration changed after preview; reload before saving",
		);
	for (const selection of plan.selectionChecks)
		validateSkillSelection(plan.root, selection, plan.sourceOptions);
	const role = plan.action === "delete" ? undefined : plan.id;
	const { storeRoot } = plan,
		lockMode = "validation";
	resolveInstructions({
		root: plan.root,
		role,
		configuration: parseYaml(plan.after.toString("utf8")),
		newRoleFile: plan.newRoleFile,
		storeRoot,
		lockMode,
	});
	const modified = applyChanges(plan.root, plan.changes, () =>
		resolveInstructions({ root: plan.root, role, storeRoot, lockMode }),
	);
	return {
		modified,
		resolution: resolveInstructions({
			root: plan.root,
			role,
			storeRoot,
			lockMode,
		}),
	};
}
