import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { readConfiguration } from "./configure.ts";
import {
	applyChanges,
	errorCode,
	errorMessage,
	type FileChange,
	readLocal,
	safePath,
} from "./files.ts";
import { detectAgents } from "./install.ts";
import { integrations } from "./integrations.ts";
import {
	identifier,
	localFile,
	mapping,
	parseYaml,
	resolveInstructions,
	skillMetadata,
	type YamlMap,
} from "./resolve.ts";

const configFile = ".agent-profiles/agents.yaml";
const originFile = ".agent-profiles/preset-origins.yaml";

function text(value: unknown, entry: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${entry}: expected nonempty text`);
	return value;
}

function ids(value: unknown, entry: string): string[] {
	if (!Array.isArray(value))
		throw new Error(`${entry}: expected a list of IDs`);
	value.forEach((id) => {
		identifier(id, entry);
	});
	if (new Set(value).size !== value.length)
		throw new Error(`${entry}: duplicate IDs`);
	return value;
}

function strings(value: unknown, entry: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !item.trim())
	)
		throw new Error(`${entry}: expected a list of nonempty strings`);
	return value;
}

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a, (_, value) =>
		value instanceof Map ? Object.fromEntries(value) : value,
	) ===
	JSON.stringify(b, (_, value) =>
		value instanceof Map ? Object.fromEntries(value) : value,
	);

function selected(
	requested: unknown,
	choices: Set<string>,
	entry: string,
): string[] {
	const result = requested === undefined ? [...choices] : ids(requested, entry);
	for (const id of result)
		if (!choices.has(id)) throw new Error(`${entry}: unknown selection ${id}`);
	return result;
}

// Strictly data-only: unknown fields (including hooks/scripts) are rejected.
function parsePreset(
	manifest: Buffer,
	read: (file: string) => Buffer | null | undefined,
) {
	const data = mapping(
		parseYaml(manifest.toString("utf8")),
		"preset.yaml",
		["schema_version", "preset", "roles"],
		["profiles", "models", "families", "skills", "defaults"],
	);
	if (data.get("schema_version") !== 1)
		throw new Error("preset.yaml.schema_version: only version 1 is supported");
	const metadata = mapping(
		data.get("preset"),
		"preset",
		["name", "display_name", "description", "author", "version", "license"],
		["homepage", "repository"],
	);
	for (const [key, value] of metadata) text(value, `preset.${key}`);
	identifier(metadata.get("name"), "preset.name");
	const roles = mapping(data.get("roles"), "roles");
	if (!roles.size) throw new Error("roles: include at least one role");
	const profiles = mapping(data.get("profiles") ?? new Map(), "profiles");
	const skills = mapping(
		data.get("skills") ??
			new Map().set("requires", []).set("includes", new Map()),
		"skills",
		["requires", "includes"],
		["host"],
	);
	const requires = ids(skills.get("requires"), "skills.requires");
	const includes = mapping(skills.get("includes"), "skills.includes");
	for (const id of includes.keys()) {
		identifier(id, "skills.includes");
		if (requires.includes(id))
			throw new Error(
				`skills.${id}: cannot be both included and required locally`,
			);
	}
	// Host-native references travel as references; their implementation stays with the host.
	const hostSkills = mapping(skills.get("host") ?? new Map(), "skills.host");
	for (const [id, value] of hostSkills) {
		identifier(id, "skills.host");
		if (requires.includes(id) || includes.has(id))
			throw new Error(
				`skills.host.${id}: declare a skill in only one of requires, includes, or host`,
			);
		mapping(value, `skills.host.${id}`, ["host", "scope"], ["id"]);
		const adapter = integrations.find(
			(item) => item.id === value.get("host") && item.skills,
		);
		if (!adapter?.skills)
			throw new Error(
				`skills.host.${id}.host: expected a host with native skills`,
			);
		const scopes: Partial<Record<string, { id: RegExp }>> = adapter.skills;
		const scope = Object.hasOwn(scopes, value.get("scope"))
			? scopes[value.get("scope")]
			: undefined;
		if (!scope)
			throw new Error(
				`skills.host.${id}.scope: expected one of ${Object.keys(scopes).join(", ")}`,
			);
		if (!scope.id.test(value.get("id") ?? id))
			throw new Error(
				`skills.host.${id}.id: expected a ${adapter.name} ${value.get("scope")} skill identifier`,
			);
	}
	const payload = new Map<string, Buffer>();
	// ponytail: payloads are Markdown-only; supporting assets need an explicit resource manifest later.
	const add = (file: string, entry: string): Buffer => {
		text(file, entry);
		if (
			!file.endsWith(".md") ||
			/[:\\\x00-\x1f]/.test(file) ||
			path.posix.isAbsolute(file) ||
			file.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error(
				`${entry}: expected a local Markdown path without traversal`,
			);
		}
		const content = payload.get(file) ?? read(file);
		if (!content) throw new Error(`${entry}: missing file ${file}`);
		payload.set(file, content);
		return content;
	};
	for (const [id, value] of profiles) {
		identifier(id, "profiles");
		mapping(value, `profiles.${id}`, ["file"]);
		add(value.get("file"), `profiles.${id}.file`);
	}
	for (const [id, value] of includes) {
		mapping(value, `skills.includes.${id}`, ["file"]);
		skillMetadata(
			value.get("file"),
			`skills.includes.${id}`,
			add(value.get("file"), `skills.includes.${id}.file`),
		);
	}
	for (const [id, value] of roles) {
		identifier(id, "roles");
		mapping(value, `roles.${id}`, ["file", "skills"], ["description"]);
		if (value.has("description"))
			text(value.get("description"), `roles.${id}.description`);
		add(value.get("file"), `roles.${id}.file`);
		const lists = mapping(value.get("skills"), `roles.${id}.skills`, [
			"required",
			"available",
		]);
		const required = ids(lists.get("required"), `roles.${id}.skills.required`);
		const available = ids(
			lists.get("available"),
			`roles.${id}.skills.available`,
		);
		for (const skill of [...required, ...available]) {
			if (
				!requires.includes(skill) &&
				!includes.has(skill) &&
				!hostSkills.has(skill)
			)
				throw new Error(
					`roles.${id}: declare skill ${skill} in skills.requires, skills.includes, or skills.host`,
				);
		}
		if (available.some((skill) => required.includes(skill)))
			throw new Error(`roles.${id}: a skill is both required and available`);
	}
	for (const section of ["models", "families"]) {
		const entries = mapping(data.get(section) ?? new Map(), section);
		for (const [key, value] of entries) {
			// Same shape as agents.yaml; collisions are checked by the resolver against the target at import.
			const entry = `${section}.${key}`;
			mapping(
				value,
				entry,
				["profile"],
				[section === "models" ? "aliases" : "match"],
			);
			identifier(value.get("profile"), `${entry}.profile`);
			if (value.has("aliases"))
				strings(value.get("aliases"), `${entry}.aliases`);
			if (value.has("match"))
				strings(
					mapping(value.get("match"), `${entry}.match`, ["prefixes"]).get(
						"prefixes",
					),
					`${entry}.match.prefixes`,
				);
		}
	}
	const defaults = mapping(
		data.get("defaults") ?? new Map(),
		"defaults",
		[],
		["profile", "role"],
	);
	for (const [key, value] of defaults) identifier(value, `defaults.${key}`);
	if (defaults.has("role") && !roles.has(defaults.get("role")))
		throw new Error("defaults.role: must name a preset role");
	return {
		data,
		metadata,
		roles,
		profiles,
		requires,
		includes,
		hostSkills,
		payload,
	};
}

export function readPreset(source: string) {
	if (typeof source !== "string" || !source.trim() || source.includes("://"))
		throw new Error("Preset source must be a local directory");
	source = realpathSync(source);
	const manifest = readLocal(source, "preset.yaml");
	if (manifest === null) throw new Error(`${source}: missing preset.yaml`);
	const parsed = parsePreset(manifest, (file) => {
		localFile(source, file, "preset file", "preset");
		return readLocal(source, file);
	});
	return { source, manifest, ...parsed };
}

export type PresetImportOptions = {
	root: string;
	source: string;
	roles?: string[];
	decisions?: Map<string, string>;
	useDefaults?: boolean;
	storeRoot?: string;
};

/**
 * Inspect without writing. Decisions use keys such as roles.reviewer and values
 * keep, replace, or rename:new-id. Defaults are opt-in, independently of mappings.
 */
export function planPresetImport({
	root,
	source,
	roles,
	decisions = new Map(),
	useDefaults = false,
	storeRoot,
}: PresetImportOptions) {
	if (typeof useDefaults !== "boolean")
		throw new Error("useDefaults must be a boolean");
	const state = readConfiguration(root, { storeRoot });
	root = state.root;
	const preset = readPreset(source);
	const { document, configuration, before } = state;
	if (configuration.get("version") === 3)
		throw new Error(
			"preset-config3-unsupported: preset schema 1 cannot preserve revision bindings and workflow links; use an explicit configuration change. Nothing was imported.",
		);
	const snapshots = new Map<string, Buffer | null>([[configFile, before]]);
	const observe = (file: string): Buffer | null => {
		if (!snapshots.has(file)) snapshots.set(file, readLocal(root, file));
		return snapshots.get(file) ?? null;
	};
	const changes: FileChange[] = [];
	const conflicts = [];
	const missing = [];
	const notices = [];
	const actions = [];
	const names = new Map();
	const originsBefore = observe(originFile);
	const origins =
		originsBefore === null
			? new Map()
			: mapping(parseYaml(originsBefore.toString("utf8")), originFile);
	const origin = (kind: string, id: string, original: string) =>
		origins.set(
			`${kind}.${id}`,
			new Map([
				["preset", preset.metadata.get("name")],
				["version", preset.metadata.get("version")],
				["author", preset.metadata.get("author")],
				["source", preset.metadata.get("repository") ?? preset.source],
				["original_id", original],
			]),
		);
	const fileFor = (kind: string, id: string) =>
		kind === "skills"
			? `.agent-profiles/skills/${id}/SKILL.md`
			: `.agent-profiles/${kind}/${id}.md`;
	const exists = (kind: string, id: string) => {
		const bytes = observe(fileFor(kind, id));
		return bytes !== null || configuration.get(kind)?.has(id);
	};
	const reserve = (kind: string, id: string) => {
		const key = `${kind}.${id}`;
		const conflict = exists(kind, id);
		const decision = decisions.get(key);
		if (
			decision !== undefined &&
			!["keep", "replace"].includes(decision) &&
			!decision.startsWith("rename:")
		)
			throw new Error(`${key}: choose keep, replace, or rename:new-id`);
		if (conflict && decision === undefined) {
			conflicts.push({ key, file: fileFor(kind, id), rename: true });
			return { id, skip: true, pending: true };
		}
		if (decision === "keep") {
			if (
				!conflict ||
				(kind === "roles" && !configuration.get("roles").has(id))
			)
				throw new Error(
					`${key}: no local definition to keep; rename or replace instead`,
				);
			actions.push(`Keep ${key}`);
			return { id, skip: true };
		}
		const target = decision?.startsWith("rename:")
			? identifier(decision.slice(7), key)
			: id;
		if (conflict && target === id && decision === "replace") {
			const current = configuration.get(kind)?.get(id);
			if (current?.get("resources")?.length)
				throw new Error(
					`${key}: replacement would discard declared resources; keep or rename instead`,
				);
			if (
				kind === "profiles" &&
				current?.has("file") &&
				current.get("file") !== `profiles/${id}.md`
			) {
				throw new Error(
					`${key}: mapped profile replacement would not update its effective file; keep or rename instead`,
				);
			}
		}
		if (target !== id && exists(kind, target))
			throw new Error(`${kind}.${target}: rename destination already exists`);
		if (names.has(`${kind}.${target}`))
			throw new Error(
				`${kind}.${target}: multiple preset items target the same ID`,
			);
		names.set(`${kind}.${target}`, id);
		actions.push(
			`${conflict && target === id ? "Replace" : "Add"} ${kind}.${target}${target === id ? "" : ` (from ${id})`}`,
		);
		return { id: target, skip: false };
	};
	const write = (file: string, content: Buffer | undefined) => {
		if (!content) throw new Error(`${file}: missing preset payload`);
		const previous = observe(file);
		if (!previous?.equals(content))
			changes.push({ file, before: previous, after: content });
	};
	const selectedRoles = selected(roles, new Set(preset.roles.keys()), "roles");
	if (!selectedRoles.length) throw new Error("Select at least one preset role");
	const roleNames = new Map(
		selectedRoles.map((id) => [id, reserve("roles", id)]),
	);
	const needed = new Set<string>();
	for (const [id, target] of roleNames) {
		if (!target.skip || target.pending)
			for (const list of preset.roles.get(id).get("skills").values())
				list.forEach((skill: string) => {
					needed.add(skill);
				});
	}
	const skillNames = new Map<string, string>();
	for (const id of needed) {
		if (preset.includes.has(id)) {
			const target = reserve("skills", id);
			skillNames.set(id, target.id);
			if (!target.skip) {
				const file = fileFor("skills", target.id);
				write(file, preset.payload.get(preset.includes.get(id).get("file")));
				document.setIn(["skills", target.id], document.createNode({ file }));
				origin("skills", target.id, id);
			}
		} else if (preset.hostSkills.has(id)) {
			const reference = preset.hostSkills.get(id);
			const host = integrations.find(
				(item) => item.id === reference.get("host"),
			);
			if (!host) throw new Error(`skills.host.${id}.host: unknown host`);
			const hostId = reference.get("id") ?? id;
			const current = configuration.get("skills")?.get(id);
			if (
				current?.get("host") !== host.id ||
				current.get("scope") !== reference.get("scope") ||
				(current.get("id") ?? id) !== hostId
			) {
				if (current || observe(fileFor("skills", id)) !== null) {
					missing.push(
						`Skill ${id}: the preset references ${host.name} skill ${hostId}, but ${id} already names another local skill. Rename one before importing; host skills are never renamed automatically.`,
					);
				} else {
					document.setIn(
						["skills", id],
						document.createNode(Object.fromEntries(reference)),
					);
					actions.push(`Add skills.${id} -> ${host.name} skill ${hostId}`);
					origin("skills", id, id);
				}
			}
			let installed: boolean | undefined;
			try {
				installed = detectAgents(root).find(
					(agent) => agent.id === host.id,
				)?.installed;
			} catch (error) {
				notices.push(
					`Could not check the ${host.name} integration (${errorMessage(error)}); run doctor.`,
				);
			}
			if (installed === false) {
				notices.push(
					`Preset skill ${id} is ${host.name} skill ${hostId}; the ${host.name} integration is not installed in this repository. The reference is kept as is.`,
				);
			}
			skillNames.set(id, id);
		} else if (
			configuration.get("skills")?.get(id)?.has("host") ||
			configuration.get("skills")?.get(id)?.has("package")
		) {
			skillNames.set(id, id); // Satisfied by an existing host-native reference or verified package binding, kept as is.
		} else {
			const file =
				configuration.get("skills")?.get(id)?.get("file") ??
				fileFor("skills", id);
			try {
				const content = observe(file);
				if (content === null) throw new Error("missing file");
				localFile(root, file, `skill ${id}`, "repository");
				skillMetadata(file, id, content);
			} catch (error) {
				missing.push(
					`Skill ${id} (${file}): ${errorMessage(error)}. Install it locally or add an explicit skills mapping; no download was attempted.`,
				);
			}
			skillNames.set(id, id);
		}
	}
	const profileNames = new Map();
	for (const [id, value] of preset.profiles) {
		const target = reserve("profiles", id);
		profileNames.set(id, target.id);
		if (!target.skip) {
			write(
				fileFor("profiles", target.id),
				preset.payload.get(value.get("file")),
			);
			origin("profiles", target.id, id);
		}
	}
	for (const [id, target] of roleNames) {
		if (target.skip) continue;
		const value: YamlMap = new Map(preset.roles.get(id));
		const file = fileFor("roles", target.id);
		write(file, preset.payload.get(value.get("file")));
		value.set("file", `roles/${target.id}.md`);
		value.set(
			"skills",
			new Map(
				[...value.get("skills")].map(([key, list]) => [
					key,
					list.map((skill: string) => skillNames.get(skill)),
				]),
			),
		);
		document.setIn(["roles", target.id], document.createNode(value));
		origin("roles", target.id, id);
	}
	for (const section of ["models", "families"]) {
		for (const [id, value] of preset.data.get(section) ?? []) {
			const key = `${section}.${id}`;
			const profile =
				profileNames.get(value.get("profile")) ?? value.get("profile");
			// The whole entry travels, including aliases and family prefixes, not just the profile.
			const incoming = new Map(value).set("profile", profile);
			const current = configuration.get(section).get(id);
			if (current && same(current, incoming)) continue;
			const previous = current?.get("profile");
			const decision = decisions.get(key);
			if (decision !== undefined && !["keep", "replace"].includes(decision))
				throw new Error(`${key}: choose keep or replace`);
			if (previous !== undefined && decision === undefined) {
				conflicts.push({ key, file: configFile, rename: false });
				continue;
			}
			if (decision === "keep") {
				actions.push(`Keep ${key}`);
				continue;
			}
			document.setIn([section, id], document.createNode(incoming));
			actions.push(
				`${previous === undefined ? "Add" : "Replace"} ${key} -> ${profile}`,
			);
			origin(section, id, id);
		}
	}
	if (useDefaults) {
		for (const [kind, id] of preset.data.get("defaults") ?? []) {
			const target =
				kind === "role" ? roleNames.get(id)?.id : (profileNames.get(id) ?? id);
			if (!target)
				throw new Error(
					`defaults.${kind}: select ${id} before applying defaults`,
				);
			document.set(`default_${kind}`, target);
			actions.push(`Set default_${kind}: ${target}`);
		}
	}
	let serialized = document.toString({ lineWidth: 0 });
	if (before.includes(Buffer.from("\r\n")))
		serialized = serialized.replace(/\n/g, "\r\n");
	if (before.toString("utf8").startsWith("\uFEFF"))
		serialized = `\uFEFF${serialized}`;
	if (!before.toString("utf8").endsWith("\n"))
		serialized = serialized.replace(/\r?\n$/, "");
	// Keep an exact no-op when all definitions and mappings were kept.
	if (actions.some((action) => !action.startsWith("Keep "))) {
		write(configFile, Buffer.from(serialized));
		write(originFile, Buffer.from(stringify(origins)));
	}
	const proposed = parseYaml(serialized);
	// Markdown changes always carry new bytes; write() refuses a missing payload.
	const preview = new Map(
		changes
			.filter((change) => change.file.endsWith(".md"))
			.map((change) => [path.join(root, change.file), change.after as Buffer]),
	);
	const errors = [...missing];
	let resolution: ReturnType<typeof resolveInstructions> | undefined;
	if (!conflicts.length && !missing.length) {
		// A replaced package binding still named by an assignment fails here, naming the rule.
		try {
			resolution = resolveInstructions({
				root,
				configuration: proposed,
				preview,
				storeRoot,
				lockMode: "validation",
			});
		} catch (error) {
			errors.push(errorMessage(error));
		}
	}
	return {
		root,
		preset,
		changes,
		snapshots,
		proposed,
		preview,
		conflicts,
		errors,
		notices,
		actions,
		storeRoot,
		resolution,
		ready: !conflicts.length && !errors.length,
	};
}

export type PresetImportPlan = ReturnType<typeof planPresetImport>;

export function applyPresetImport(plan: PresetImportPlan, confirmed = false) {
	if (confirmed !== true)
		throw new Error("Preset import requires explicit confirmation");
	if (!plan.ready)
		throw new Error(
			"Resolve preset conflicts and missing dependencies before importing",
		);
	for (const [file, before] of plan.snapshots) {
		const actual = readLocal(plan.root, file);
		if (
			actual === null
				? before !== null
				: before === null || !actual.equals(before)
		)
			throw new Error(`${file}: changed after preview; inspect again`);
	}
	for (const [file, before] of new Map([
		["preset.yaml", plan.preset.manifest],
		...plan.preset.payload,
	])) {
		if (!readLocal(plan.preset.source, file)?.equals(before))
			throw new Error(`${file}: preset changed after preview; inspect again`);
	}
	const { storeRoot } = plan,
		lockMode = "validation";
	resolveInstructions({
		root: plan.root,
		configuration: plan.proposed,
		preview: plan.preview,
		storeRoot,
		lockMode,
	});
	const modified = applyChanges(plan.root, plan.changes, () =>
		resolveInstructions({ root: plan.root, storeRoot, lockMode }),
	);
	return {
		modified,
		resolution: resolveInstructions({ root: plan.root, storeRoot, lockMode }),
	};
}

export function exportChoices(
	root: string,
	{ storeRoot }: { storeRoot?: string } = {},
) {
	const state = readConfiguration(root, { storeRoot });
	let files: string[];
	try {
		files = readdirSync(safePath(state.root, ".agent-profiles/profiles"));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		files = [];
	}
	const profiles = files
		.filter((file) => file.endsWith(".md"))
		.map((file) => file.slice(0, -3));
	profiles.forEach((id) => {
		identifier(id, "profiles");
	});
	// Package profiles are listed so that selecting one is refused honestly, not reported missing.
	return {
		...state,
		profiles: [
			...profiles,
			...(state.configuration.get("profiles")?.keys() ?? []),
		],
	};
}

// Schema 1 presets cannot carry package identities or their assignments; refuse rather than flatten.
function unsupported(binding: string, source: Map<string, unknown>): never {
	throw new Error(
		`${binding}: preset-package-unsupported ${source.get("package")}@${source.get("version")}: preset schema 1 cannot keep package bindings or their version assignments; select only local roles, profiles and skills. Nothing was exported.`,
	);
}

function unsupportedResources(
	binding: string,
	source: Map<string, unknown> | undefined,
) {
	const resources = source?.get("resources");
	if (Array.isArray(resources) && resources.length)
		throw new Error(
			`${binding}: preset-resources-unsupported: preset schema 1 cannot retain declared resources; nothing was exported`,
		);
}

export type PresetExportOptions = {
	root: string;
	destination: string;
	metadata: object;
	roles?: string[];
	profiles?: string[];
	includeSkills?: string[];
	storeRoot?: string;
};

export function planPresetExport({
	root,
	destination,
	metadata,
	roles,
	profiles,
	includeSkills = [],
	storeRoot,
}: PresetExportOptions) {
	const state = exportChoices(root, { storeRoot });
	root = state.root;
	const config = state.configuration;
	if (config.get("version") === 3)
		throw new Error(
			"preset-config3-unsupported: preset schema 1 cannot preserve revision bindings and workflow links; use an explicit configuration change. Nothing was exported.",
		);
	const chosenRoles = selected(
		roles,
		new Set(config.get("roles").keys()),
		"roles",
	);
	if (!chosenRoles.length)
		throw new Error("Select at least one role to export");
	const chosenProfiles = selected(
		profiles,
		new Set(state.profiles),
		"profiles",
	);
	for (const [section, ids] of [
		["roles", chosenRoles],
		["profiles", chosenProfiles],
	])
		for (const id of ids) {
			const source = config.get(section)?.get(id),
				binding = `${section}.${id}`;
			if (source?.has("package")) unsupported(binding, source);
			unsupportedResources(binding, source);
		}
	const sourceSnapshots = new Map<string, Buffer | null>([
		[configFile, state.before],
	]);
	const payload = new Map<string, Buffer | null>();
	const copy = (source: string, destination: string) => {
		localFile(root, source, source, "repository");
		const content = readLocal(root, source);
		sourceSnapshots.set(source, content);
		payload.set(destination, content);
	};
	const outputRoles = new Map();
	const needed = new Map();
	for (const id of chosenRoles) {
		const value = new Map(config.get("roles").get(id));
		value.delete("resources");
		copy(`.agent-profiles/${value.get("file")}`, `roles/${id}.md`);
		value.set("file", `roles/${id}.md`);
		outputRoles.set(id, value);
		const resolved = resolveInstructions({
			root,
			role: id,
			storeRoot,
			lockMode: "validation",
		});
		for (const skill of [...resolved.required, ...resolved.available]) {
			if (skill.package)
				unsupported(skill.package.binding, config.get("skills").get(skill.id));
			unsupportedResources(
				`skills.${skill.id}`,
				config.get("skills")?.get(skill.id),
			);
			needed.set(skill.id, skill);
		}
	}
	// Host skills export as references; only instruction skills can be copied into a preset.
	const hostSkills = new Map(
		[...needed.values()]
			.filter((skill) => skill.type === "host")
			.map((skill) => [
				skill.id,
				new Map(
					Object.entries({
						host: skill.host,
						scope: skill.scope,
						...(skill.hostId === skill.id ? {} : { id: skill.hostId }),
					}),
				),
			]),
	);
	selected(
		includeSkills,
		new Set([...needed.keys()].filter((id) => !hostSkills.has(id))),
		"includeSkills",
	);
	const includes = new Map();
	for (const id of includeSkills) {
		const file = `skills/${id}/SKILL.md`;
		copy(needed.get(id).path, file);
		includes.set(id, new Map([["file", file]]));
	}
	const outputProfiles = new Map();
	for (const id of chosenProfiles) {
		const file = `profiles/${id}.md`;
		copy(
			`.agent-profiles/${config.get("profiles")?.get(id)?.get("file") ?? file}`,
			file,
		);
		outputProfiles.set(id, new Map([["file", file]]));
	}
	const data = new Map<string, unknown>([
		["schema_version", 1],
		["preset", metadata],
		["roles", outputRoles],
		["profiles", outputProfiles],
		[
			"skills",
			new Map()
				.set(
					"requires",
					[...needed.keys()].filter(
						(id) => !includes.has(id) && !hostSkills.has(id),
					),
				)
				.set("includes", includes)
				.set("host", hostSkills),
		],
	]);
	for (const section of ["models", "families"])
		data.set(
			section,
			new Map(
				[...config.get(section)].filter(([, value]) =>
					chosenProfiles.includes(value.get("profile")),
				),
			),
		);
	const defaults = new Map();
	if (chosenProfiles.includes(config.get("default_profile")))
		defaults.set("profile", config.get("default_profile"));
	if (chosenRoles.includes(config.get("default_role")))
		defaults.set("role", config.get("default_role"));
	if (defaults.size) data.set("defaults", defaults);
	const manifest = Buffer.from(stringify(data));
	const preset = parsePreset(manifest, (file) => payload.get(file));
	payload.set("preset.yaml", manifest);
	text(destination, "destination");
	destination = path.resolve(destination);
	const parent = realpathSync(path.dirname(destination));
	const directory = path.basename(destination);
	const target = safePath(parent, directory);
	if (existsSync(target))
		throw new Error(
			`${target}: export requires a new directory; nothing overwritten`,
		);
	const changes = [...payload].map(([file, after]) => ({
		file: `${directory}/${file}`,
		before: null,
		after,
	}));
	return { root, parent, target, changes, sourceSnapshots, preset };
}

export type PresetExportPlan = ReturnType<typeof planPresetExport>;

export function applyPresetExport(plan: PresetExportPlan, confirmed = false) {
	if (confirmed !== true)
		throw new Error("Preset export requires explicit confirmation");
	if (existsSync(plan.target))
		throw new Error(
			"Export destination appeared after preview; choose a new directory",
		);
	for (const [file, before] of plan.sourceSnapshots) {
		if (before === null || !readLocal(plan.root, file)?.equals(before))
			throw new Error(`${file}: changed after preview; export again`);
	}
	return applyChanges(plan.parent, plan.changes, () => readPreset(plan.target));
}
