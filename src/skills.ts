import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { discoveryError } from "./discovery-diagnostics.ts";
import {
	discoverExternalSkills,
	externalMetadata,
	validateExternalSelection,
} from "./external-skills.js";
import { errorMessage, safePath } from "./files.ts";
import { integrations } from "./integrations.ts";
import {
	identifier,
	localDeclaration,
	localFile,
	mapping,
	skillMetadata,
	type YamlMap,
} from "./resolve.ts";

/** An inventory entry: a discovered local/external skill, a configured reference, or a resolved skill. */
export type DiscoveredSkill = {
	id: string;
	path?: string | null;
	host?: string | null;
	hostId?: string | null;
	scope?: string;
	name?: string;
	nameSource?: string;
	description?: string | null;
	type?: string;
	source?: string;
	availability?: string;
	runtime?: string;
	selectable?: boolean;
	verification?: string;
	canonicalPath?: string;
	external?: boolean;
	resources?: string[];
	package?: {
		binding: string;
		name: string;
		version: string;
		// Declared package skills have no verified digest yet.
		sha256?: string;
		revisionDigest?: string | null;
	};
};

type NativeReference = {
	id: string;
	host: string;
	hostId: string;
	scope: string;
};

// Repository instruction files continue to use the original containment rules.
function directorySkills(
	root: string,
	directory: string,
	host?: string,
): DiscoveredSkill[] {
	const target = safePath(root, directory);
	if (!existsSync(target)) return [];
	return readdirSync(target, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => ({
			id: entry.name,
			path: `${directory}/${entry.name}/SKILL.md`,
			...(host && { host, hostId: entry.name, scope: "project" }),
		}))
		.filter((skill) => existsSync(path.join(root, skill.path)));
}

export const skillSources = [
	{
		id: "agent-profiles",
		enumerate: (root: string) =>
			directorySkills(root, ".agent-profiles/skills"),
	},
	{
		id: "claude",
		enumerate: (root: string) =>
			directorySkills(root, ".claude/skills", "claude"),
	},
];
const nativeKey = (skill: Pick<DiscoveredSkill, "host" | "scope" | "hostId">) =>
	`${skill.host}\0${skill.scope}\0${skill.hostId}`;

// Codex project names are inspected only to detect conflicts with user references.
// This does not add project bindings, copy bodies, or scan arbitrary repository files.
function codexProjectNames(
	root: string,
	warnings: string[],
	metadataOnly: boolean,
) {
	const names = new Set<string>();
	const visited = new Set<string>();
	let count = 0;
	const walk = (directory: string, depth = 0) => {
		if (depth > 4 || ++count > 1000) {
			warnings.push(
				"Codex project conflict scan limit reached; additional names are unobserved",
			);
			return;
		}
		const target = localFileDirectory(directory);
		if (visited.has(target)) return;
		visited.add(target);
		const file = `${directory}/SKILL.md`;
		if (existsSync(path.join(root, file))) {
			try {
				const metadata = externalMetadata(
					localFile(root, file, file, "repository"),
					"codex",
				);
				names.add(metadata.name);
			} catch (error) {
				warnings.push(
					`Codex project conflict scan${metadataOnly ? ` (${file})` : ""}: ${discoveryError(error, metadataOnly)}`,
				);
			}
			return;
		}
		for (const entry of readdirSync(target, { withFileTypes: true })) {
			if (
				!entry.name.startsWith(".") &&
				(entry.isDirectory() || entry.isSymbolicLink())
			) {
				try {
					walk(`${directory}/${entry.name}`, depth + 1);
				} catch (error) {
					warnings.push(
						`Codex project conflict scan${metadataOnly ? ` (${directory}/${entry.name})` : ""}: ${discoveryError(error, metadataOnly)}`,
					);
				}
			}
		}
	};
	const localFileDirectory = (directory: string) => {
		const lexical = safePath(root, directory);
		const target = realpathSync(lexical);
		const relative = path.relative(root, target);
		if (
			path.isAbsolute(relative) ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`)
		)
			throw new Error(`${directory} resolves outside repository`);
		return target;
	};
	if (existsSync(path.join(root, ".agents/skills"))) {
		try {
			walk(".agents/skills");
		} catch (error) {
			warnings.push(
				`Codex project conflict scan${metadataOnly ? " (.agents/skills)" : ""}: ${discoveryError(error, metadataOnly)}`,
			);
		}
	}
	return names;
}

export function discoverSkills(
	root: string,
	configuration: YamlMap,
	{
		external = false,
		sourceOptions = {},
		metadataOnly = false,
	}: {
		external?: boolean;
		sourceOptions?: object;
		metadataOnly?: boolean;
	} = {},
) {
	root = realpathSync(root);
	const skills: DiscoveredSkill[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	const add = (skill: DiscoveredSkill, source: string) => {
		try {
			identifier(skill.id, String(skill.path));
			const location = localFile(root, skill.path, skill.id, "repository");
			const key = `${skill.id}\0${location}`;
			if (seen.has(key)) return;
			seen.add(key);
			skills.push({
				...skill,
				...skillMetadata(
					location,
					skill.id,
					undefined,
					String(skill.path), // validated by localFile above
					!skill.host,
				),
				...(skill.host &&
					skill.scope === "project" && { canonicalPath: location }),
				source,
			});
		} catch (error) {
			warnings.push(
				metadataOnly
					? `${source}: ${skill.id} (${skill.path}): ${discoveryError(error, true)}`
					: errorMessage(error),
			);
		}
	};
	const references: NativeReference[] = [];
	for (const [id, value] of configuration.get("skills") ?? []) {
		try {
			identifier(id, "skills");
			mapping(value, `skills.${id}`);
			// Declarations have no verified delivery type, digest, or repository path.
			if (value.has("package")) {
				mapping(
					value,
					`skills.${id}`,
					["package", "version"],
					configuration.get("version") === 3 ? ["revision"] : [],
				);
				if (
					typeof value.get("package") !== "string" ||
					typeof value.get("version") !== "string"
				)
					throw new Error(`${id}: expected package name and version strings`);
				if (
					value.has("revision") &&
					(typeof value.get("revision") !== "string" ||
						!/^[0-9a-f]{64}$/.test(value.get("revision")))
				)
					throw new Error(`${id}: expected revision digest`);
				skills.push({
					id,
					source: "configured",
					path: null,
					package: {
						binding: `skills.${id}`,
						name: value.get("package"),
						version: value.get("version"),
						...(configuration.get("version") === 3
							? { revisionDigest: value.get("revision") ?? null }
							: {}),
					},
					verification: "not-checked",
					availability: "declared",
				});
				continue;
			}
			if (!value.has("host")) {
				let metadata: { resources?: string[] } = {};
				if (configuration.get("version") >= 2)
					metadata = localDeclaration(
						root,
						value,
						`skills.${id}`,
						value.get("file"),
					);
				else mapping(value, `skills.${id}`, ["file"]);
				add({ id, path: value.get("file"), ...metadata }, "configured");
				continue;
			}
			mapping(value, `skills.${id}`, ["host", "scope"], ["id"]);
			const adapter = integrations.find(
				(adapter) => adapter.id === value.get("host") && adapter.skills,
			);
			const scope = value.get("scope");
			const hostId = value.has("id") ? value.get("id") : id;
			if (
				!adapter?.skills ||
				!Object.hasOwn(adapter.skills, scope) ||
				typeof hostId !== "string" ||
				!adapter.skills[scope]?.id.test(hostId)
			)
				throw new Error(`${id}: invalid host, scope, or skill identifier`);
			if (value.get("scope") !== "project") {
				references.push({
					id,
					host: value.get("host"),
					hostId,
					scope: value.get("scope"),
				});
				continue;
			}
			const file = adapter.skills.project?.path?.(hostId);
			if (file && existsSync(path.join(root, file)))
				add(
					{ id, path: file, host: value.get("host"), hostId, scope: "project" },
					"configured",
				);
		} catch (error) {
			warnings.push(
				`configured: ${String(id)}: ${discoveryError(error, metadataOnly)}`,
			);
		}
	}
	for (const source of skillSources) {
		try {
			for (const skill of source.enumerate(root)) add(skill, source.id);
		} catch (error) {
			warnings.push(`${source.id}: ${discoveryError(error, metadataOnly)}`);
		}
	}
	const inventory = external
		? discoverExternalSkills(sourceOptions, { metadataOnly })
		: { skills: [], warnings: [], roots: [] };
	warnings.push(...inventory.warnings);
	for (const skill of inventory.skills) {
		const aliases = references.filter(
			(reference) => nativeKey(reference) === nativeKey(skill),
		);
		if (aliases.length)
			for (const alias of aliases) skills.push({ ...skill, id: alias.id });
		else skills.push(skill);
	}
	for (const reference of references) {
		if (
			skills.some(
				(skill) =>
					skill.id === reference.id &&
					nativeKey(skill) === nativeKey(reference),
			)
		)
			continue;
		const availability =
			external && reference.scope === "user"
				? "not-found"
				: "host-provided-unverified";
		skills.push({
			...reference,
			type: "host",
			source: "configured",
			name: reference.hostId,
			description: null,
			path: null,
			availability,
			runtime: "unverified",
			selectable: true,
		});
		if (availability === "not-found")
			warnings.push(
				`${reference.id}: not found in inventoried roots; keep the native reference and check host setup (invocation unverified)`,
			);
	}
	if (external) {
		const personalClaudeNames = new Set(
			skills
				.filter(
					(skill) =>
						skill.host === "claude" && skill.scope === "user" && skill.path,
				)
				.map((skill) => skill.hostId),
		);
		for (const skill of skills) {
			if (
				skill.host === "claude" &&
				skill.scope === "project" &&
				personalClaudeNames.has(skill.hostId)
			) {
				skill.selectable = false;
				skill.availability = "shadowed";
				warnings.push(
					`${skill.id}: Claude personal skill ${skill.hostId} shadows this project skill; the project origin is not independently addressable`,
				);
			}
		}
		const projectNames = codexProjectNames(root, warnings, metadataOnly);
		for (const skill of skills) {
			if (
				skill.host === "codex" &&
				skill.scope === "user" &&
				skill.hostId != null &&
				projectNames.has(skill.hostId)
			) {
				skill.selectable = false;
				skill.availability = "ambiguous";
				warnings.push(
					`${skill.id}: Codex project/user name conflict for ${skill.hostId}; this portable reference cannot address the exact origin`,
				);
			}
		}
	}
	skills.sort(
		(a, b) =>
			a.id.localeCompare(b.id) || String(a.path).localeCompare(String(b.path)),
	);
	const duplicates = [...new Set(skills.map((skill) => skill.id))].filter(
		(id) => skills.filter((skill) => skill.id === id).length > 1,
	);
	return { skills, warnings, duplicates, roots: inventory.roots };
}

// A source selected from disk is checked both before preview and immediately before save.
// Opaque native references have no path and remain portable, never installation-verified.
export function validateSkillSelection(
	root: string,
	selection: Partial<DiscoveredSkill>,
	sourceOptions?: object,
) {
	if (selection.selectable === false)
		throw new Error(
			`${selection.id}: source is not selectable (${selection.availability ?? "ambiguous"})`,
		);
	if (!selection.host || !selection.path) return;
	if (selection.scope === "project") {
		// Derive permission from the repository and adapter, never a descriptor's origin.
		const file = integrations
			.find((adapter) => adapter.id === selection.host)
			?.skills?.project?.path?.(String(selection.hostId));
		if (!file || file !== selection.path)
			throw new Error(
				`${selection.id}: project source changed; reload the inventory`,
			);
		const canonicalPath = localFile(
			realpathSync(root),
			file,
			String(selection.id),
			"repository",
		);
		const metadata = skillMetadata(
			canonicalPath,
			String(selection.id),
			undefined,
			file,
			false,
		);
		if (
			canonicalPath !== selection.canonicalPath ||
			(["name", "nameSource", "description"] as const).some(
				(key) => metadata[key] !== selection[key],
			)
		) {
			throw new Error(
				`${selection.id}: project skill changed or repointed; refresh the inventory and select again`,
			);
		}
	}
	if (selection.external || path.isAbsolute(selection.path))
		validateExternalSelection(selection, sourceOptions);
	if (
		selection.external ||
		path.isAbsolute(selection.path) ||
		sourceOptions !== undefined
	) {
		const found = discoverSkills(root, new Map(), {
			external: true,
			sourceOptions,
		});
		const candidate = found.skills.find(
			(skill) =>
				nativeKey(skill) === nativeKey(selection) &&
				skill.path === selection.path,
		);
		if (!candidate || candidate.selectable === false)
			throw new Error(
				`${selection.id}: external/project source missing, shadowed, or ambiguous; reload the inventory`,
			);
	}
}
