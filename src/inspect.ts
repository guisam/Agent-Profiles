import {
	closeSync,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfiguration } from "./configure.ts";
import { errorCode, safePath } from "./files.ts";
import { integrations, managedSpan } from "./integrations.ts";
import type { Untyped } from "./packages.ts";
import {
	identifier,
	localDeclaration,
	localFile,
	mapping,
	parseYaml,
} from "./resolve.ts";
import { discoverSkills } from "./skills.ts";

const limit = 65536;
const compare = (a: Untyped, b: Untyped) => (a < b ? -1 : a > b ? 1 : 0);

function readBounded(root: string, file: Untyped) {
	const descriptor = openSync(safePath(root, file), "r");
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > limit)
			throw new Error("Expected regular metadata within 64 KiB");
		const bytes = Buffer.alloc(limit + 1);
		let size = 0,
			count: number;
		do {
			count = readSync(descriptor, bytes, size, bytes.length - size, null);
			size += count;
		} while (count && size < bytes.length);
		if (size > limit) throw new Error("Metadata grew beyond 64 KiB");
		return bytes.subarray(0, size);
	} finally {
		closeSync(descriptor);
	}
}

function recognizedChildren(
	root: string,
	directory: Untyped,
	pattern: Untyped,
	warnings: Untyped,
) {
	try {
		const entries = readdirSync(safePath(root, directory))
			.filter((file) => pattern.test(file))
			.sort(compare);
		if (entries.length > 128)
			warnings.push(`${directory}: inventory limited to 128 paths`);
		return entries.slice(0, 128).map((file) => `${directory}/${file}`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT")
			warnings.push(`${directory}: cannot safely inventory directory`);
		return [];
	}
}

/** A repository file's presence and size; bytes is null unless it is an available regular file. */
type FileMetadata = {
	path: string;
	source: string;
	host: string | null;
	scope: string;
	availability: string;
	bytes: number | null;
	problem?: string;
};

function fileMetadata(
	root: string,
	file: string,
	source: string,
	host: string | null = null,
): FileMetadata {
	const record: FileMetadata = {
		path: file,
		source,
		host,
		scope: "repository",
		availability: "missing",
		bytes: null,
	};
	try {
		const stat = statSync(safePath(root, file));
		if (!stat.isFile())
			return {
				...record,
				availability: "unavailable",
				problem: "Expected a regular file",
			};
		return { ...record, availability: "available", bytes: stat.size };
	} catch (error) {
		return errorCode(error) === "ENOENT"
			? record
			: {
					...record,
					availability: "unavailable",
					problem:
						"Cannot safely access file; check permissions, type, and links",
				};
	}
}

function workflowMetadata(root: string) {
	const files = [
		"orchestrator.toml",
		"adr-orchestrator.toml",
		"t3.json",
		"Makefile",
		"justfile",
		"Taskfile.yml",
		"Taskfile.yaml",
		"Jenkinsfile",
		".gitlab-ci.yml",
		"azure-pipelines.yml",
		".circleci/config.yml",
		".nvmrc",
		".node-version",
		".python-version",
		"pyproject.toml",
		"Cargo.toml",
		"go.mod",
		"Dockerfile",
		"compose.yml",
		"compose.yaml",
		"npm-shrinkwrap.json",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"bun.lockb",
	];
	const warnings: string[] = [];
	files.push(
		...recognizedChildren(root, ".github/workflows", /\.ya?ml$/, warnings),
	);
	return {
		files: files
			.sort(compare)
			.map((file) => fileMetadata(root, file, "recognized-workflow"))
			.filter((file) => file.availability !== "missing"),
		warnings,
	};
}

function packageMetadata(root: string) {
	const file = fileMetadata(root, "package.json", "package");
	if (file.availability !== "available")
		return { ...file, status: file.availability };
	if ((file.bytes ?? 0) > limit)
		return { ...file, status: "invalid", problem: "Metadata exceeds 64 KiB" };
	try {
		const value = JSON.parse(readBounded(root, file.path).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		for (const key of ["name", "version", "packageManager"])
			if (value[key] !== undefined && typeof value[key] !== "string")
				throw new Error();
		for (const key of ["engines", "scripts"])
			if (
				value[key] !== undefined &&
				(!value[key] ||
					typeof value[key] !== "object" ||
					Array.isArray(value[key]))
			)
				throw new Error();
		if (
			value.engines?.node !== undefined &&
			typeof value.engines.node !== "string"
		)
			throw new Error();
		if (
			value.scripts &&
			Object.values(value.scripts).some(
				(command) => typeof command !== "string",
			)
		)
			throw new Error();
		const text = (value: Untyped) => (typeof value === "string" ? value : null);
		return {
			...file,
			status: "valid",
			name: text(value.name),
			version: text(value.version),
			node: text(value.engines?.node),
			packageManager: text(value.packageManager),
			scriptNames:
				value.scripts &&
				typeof value.scripts === "object" &&
				!Array.isArray(value.scripts)
					? Object.keys(value.scripts).sort(compare)
					: [],
		};
	} catch (error) {
		return errorCode(error)
			? {
					...file,
					availability: "unavailable",
					status: "unavailable",
					problem: `Cannot read package metadata (${errorCode(error)})`,
				}
			: {
					...file,
					status: "invalid",
					problem: "Malformed package metadata; repair package.json",
				};
	}
}

function configurationMetadata(root: string) {
	const file = fileMetadata(
		root,
		".agent-profiles/agents.yaml",
		"configuration",
	);
	const empty = {
		...file,
		status: file.availability === "missing" ? "missing" : "invalid",
		profiles: [],
		roles: [],
		models: [],
		families: [],
		defaultProfile: null,
		defaultRole: null,
	};
	if (file.availability !== "available")
		return { metadata: empty, configuration: new Map() };
	if ((file.bytes ?? 0) > limit)
		return {
			metadata: { ...empty, problem: "Configuration exceeds 64 KiB" },
			configuration: new Map(),
		};
	try {
		const content = readBounded(root, file.path);
		const declared = parseYaml(content.toString("utf8"));
		// Package pins verify only against a store, which bounded inspection never reads. Such declarations are listed
		// unverified; malformed binding tables still go through full validation below and are reported invalid.
		let packaged = false;
		if (declared instanceof Map && [2, 3].includes(declared.get("version"))) {
			// Only an omitted table defaults; a present null/list/scalar falls through to strict validation.
			const tables = ["profiles", "roles", "skills"].map((key) =>
				declared.has(key) ? declared.get(key) : new Map(),
			);
			packaged =
				tables.every(
					(table) =>
						table instanceof Map &&
						[...table.values()].every((value) => value instanceof Map),
				) &&
				tables.some((table) =>
					[...table.values()].some((value) => value.has("package")),
				);
		}
		const configuration = packaged
			? declared
			: readConfiguration(root, { metadataOnly: true, content }).configuration;
		if (packaged) {
			// Validate only the shapes and local references used below; store-backed validity remains unchecked.
			mapping(
				configuration,
				"agents.yaml",
				[
					"version",
					"default_profile",
					"default_role",
					"models",
					"families",
					"roles",
				],
				[
					"skills",
					"profiles",
					"assignments",
					...(configuration.get("version") === 3 ? ["workflow_links"] : []),
				],
			);
			identifier(configuration.get("default_profile"), "default_profile");
			identifier(configuration.get("default_role"), "default_role");
			for (const section of ["models", "families"])
				for (const [id, value] of mapping(
					configuration.get(section),
					section,
				)) {
					mapping(
						value,
						`${section}.${id}`,
						["profile"],
						[section === "models" ? "aliases" : "match"],
					);
					identifier(value.get("profile"), `${section}.${id}.profile`);
					if (value.has("match"))
						mapping(value.get("match"), `${section}.${id}.match`, ["prefixes"]);
				}
			for (const section of ["profiles", "roles"])
				for (const [id, value] of configuration.get(section) ?? []) {
					identifier(id, section);
					const fields = value.has("package")
						? ["package", "version"]
						: ["file"];
					const required = section === "roles" ? [...fields, "skills"] : fields;
					const optional = [
						...(section === "roles" ? ["description"] : []),
						...(value.has("package") && configuration.get("version") === 3
							? ["revision"]
							: []),
					];
					if (value.has("package"))
						mapping(value, `${section}.${id}`, required, optional);
					else
						localDeclaration(
							root,
							value,
							`${section}.${id}`,
							`.agent-profiles/${value.get("file")}`,
							required,
							optional,
						);
					if (!value.has("package"))
						localFile(
							path.join(root, ".agent-profiles"),
							value.get("file"),
							`${section}.${id}.file`,
							".agent-profiles",
							true,
						);
					if (section === "roles") {
						const lists = mapping(value.get("skills"), `roles.${id}.skills`, [
							"required",
							"available",
						]);
						for (const list of lists.values()) {
							if (!Array.isArray(list)) throw new Error("Expected skill IDs");
							list.forEach((skill) => {
								identifier(skill, `roles.${id}.skills`);
							});
						}
					}
				}
		}
		const declaration = (value: Untyped, source: Untyped) => ({
			path: null,
			source,
			host: null,
			scope: "repository",
			availability: "declared",
			bytes: null,
			package: {
				name: value.get("package"),
				version: value.get("version"),
				...(configuration.get("version") === 3
					? { revisionDigest: value.get("revision") ?? null }
					: {}),
			},
			verification: "not-checked",
		});
		const packageProfiles = configuration.get("profiles") ?? new Map();
		const models = [...configuration.get("models")]
			.map(([id, value]) => ({
				id,
				profile: value.get("profile"),
				aliases: value.get("aliases") ?? [],
			}))
			.sort((a, b) => compare(a.id, b.id));
		const families = [...configuration.get("families")]
			.map(([id, value]) => ({
				id,
				profile: value.get("profile"),
				prefixes: value.get("match")?.get("prefixes") ?? [],
			}))
			.sort((a, b) => compare(a.id, b.id));
		const profiles = [
			...new Set([
				configuration.get("default_profile"),
				...models.map((model) => model.profile),
				...families.map((family) => family.profile),
			]),
		]
			.sort(compare)
			.map((id) => {
				const value = packageProfiles.get(id);
				return {
					id,
					...(value?.has("package")
						? declaration(value, "configured-profile")
						: {
								...fileMetadata(
									root,
									`.agent-profiles/${value?.get("file") ?? `profiles/${id}.md`}`,
									"configured-profile",
								),
								...(value
									? localDeclaration(
											root,
											value,
											`profiles.${id}`,
											`.agent-profiles/${value.get("file")}`,
										)
									: {}),
							}),
				};
			});
		const roles = [...configuration.get("roles")]
			.map(([id, value]) => ({
				id,
				...(value.has("package")
					? declaration(value, "configured-role")
					: {
							...fileMetadata(
								root,
								`.agent-profiles/${value.get("file")}`,
								"configured-role",
							),
							...localDeclaration(
								root,
								value,
								`roles.${id}`,
								`.agent-profiles/${value.get("file")}`,
								["file", "skills"],
								["description"],
							),
						}),
				description: value.get("description") ?? null,
				required: value.get("skills").get("required"),
				available: value.get("skills").get("available"),
			}))
			.sort((a, b) => compare(a.id, b.id));
		const partial = packaged && {
			problem:
				"Package bindings are declared; bounded inspection does not read the package store, so package verification and full configuration validation were not checked; run doctor",
		};
		return {
			configuration,
			metadata: {
				...file,
				status: packaged ? "partial" : "valid",
				...partial,
				defaultProfile: configuration.get("default_profile"),
				defaultRole: configuration.get("default_role"),
				profiles,
				roles,
				models,
				families,
			},
		};
	} catch (error) {
		// Parser excerpts can contain arbitrary source text. Do not echo them into an inventory.
		return {
			metadata: errorCode(error)
				? {
						...empty,
						availability: "unavailable",
						problem: `Cannot read configuration metadata (${errorCode(error)})`,
					}
				: {
						...empty,
						problem:
							"Invalid or incomplete configuration; review agents.yaml and its references, then run doctor",
					},
			configuration: new Map(),
		};
	}
}

const toolGroups: Record<string, string[]> = {
	host: ["claude", "codex", "hermes"],
	runtime: ["node", "python", "python3", "go", "rustc"],
	packageManager: [
		"npm",
		"npx",
		"pnpm",
		"yarn",
		"bun",
		"uv",
		"pip",
		"pip3",
		"cargo",
	],
	development: ["git", "gh", "docker"],
	inference: ["ollama", "llama-server", "lms", "vllm"],
};

function environmentMetadata({
	env = process.env,
	platform = process.platform,
	system = os,
} = {}) {
	const windows = platform === "win32";
	// Windows environment names are case-insensitive; take the first match in a stable order.
	const selected = (name: string) => {
		if (env[name] !== undefined || !windows) return env[name];
		const key = Object.keys(env)
			.sort(compare)
			.find((item) => item.toUpperCase() === name.toUpperCase());
		return key === undefined ? undefined : env[key];
	};
	const warnings: string[] = [];
	const rawPath = selected("PATH") ?? "";
	const entries =
		rawPath.length <= limit ? rawPath.split(windows ? ";" : ":") : [];
	if (rawPath.length > limit || entries.length > 128)
		warnings.push("PATH inventory limited to 64 KiB and 128 entries");
	const directories = [
		...new Set(
			entries
				.slice(0, 128)
				.map((entry: Untyped) => entry.replace(/^"(.*)"$/, "$1"))
				.filter(
					(entry: Untyped) => path.isAbsolute(entry) && !entry.includes("\0"),
				),
		),
	];
	const extensions = windows
		? [
				...new Set(
					(selected("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
						.slice(0, 1024)
						.split(";")
						.filter((ext: Untyped) => /^\.[a-z0-9]{1,8}$/i.test(ext))
						.slice(0, 16)
						.map((ext: Untyped) => ext.toLowerCase()),
				),
			]
		: [""];
	const tools = Object.entries(toolGroups)
		.flatMap(([category, names]) =>
			names.map((id) => {
				const record = {
					id,
					category,
					source: "PATH-filesystem",
					host: category === "host" ? id : null,
					scope: "machine",
					path: null,
					availability: "not-found",
					runtime: "unverified",
				};
				let inaccessible = false;
				for (const directory of directories)
					for (const extension of extensions) {
						const candidate = path.join(directory, id + extension);
						try {
							const stat = statSync(candidate);
							if (stat.isFile() && (windows || stat.mode & 0o111))
								return { ...record, path: candidate, availability: "found" };
						} catch (error) {
							if (!["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
								inaccessible = true;
						}
					}
				return {
					...record,
					availability: inaccessible ? "unavailable" : "not-found",
				};
			}),
		)
		.sort((a, b) => compare(a.id, b.id));
	const observe = (fn: Untyped) => {
		try {
			return fn();
		} catch {
			return null;
		}
	};
	const cpus = observe(() => system.cpus());
	const memory = observe(() => system.totalmem());
	const shellKey = selected("SHELL")
		? "SHELL"
		: windows && selected("COMSPEC")
			? "COMSPEC"
			: null;
	const shellPath = shellKey && selected(shellKey);
	const knownShell =
		typeof shellPath === "string" &&
		path.isAbsolute(shellPath) &&
		!shellPath.includes("\0") &&
		shellPath.length <= 4096;
	return {
		scope: "machine",
		persistent: false,
		os: {
			platform,
			type: observe(() => system.type()),
			release: observe(() => system.release()),
		},
		node: {
			version: process.version,
			path: process.execPath,
			compiledArchitecture: observe(() => system.arch()),
			source: "running-node-process",
		},
		shell: {
			status: knownShell ? "environment-reported" : "unknown",
			path: knownShell ? shellPath : null,
			evidence: knownShell ? shellKey : null,
			currentShell: "unverified",
		},
		cpu: {
			status: cpus?.length ? "observed" : "unknown",
			logicalCores: cpus?.length || null,
			models: cpus?.length
				? [
						...new Set(cpus.map((cpu: Untyped) => cpu.model).filter(Boolean)),
					].sort(compare)
				: null,
			source: "os.cpus",
		},
		memory: {
			status:
				Number.isSafeInteger(memory) && memory > 0 ? "observed" : "unknown",
			totalBytes: Number.isSafeInteger(memory) && memory > 0 ? memory : null,
			source: "os.totalmem",
		},
		gpu: { status: "unknown", reason: "No hardware commands are run" },
		localModels: {
			status: "unknown",
			reason: "No runtime queries or model directory scans are run",
		},
		tools,
		warnings,
	};
}

function hostMetadata(root: string, environment: Untyped) {
	return integrations
		.map((adapter) => {
			const files = adapter.files.map((file) =>
				fileMetadata(root, file, "integration", adapter.id),
			);
			let configured = false;
			const problems: string[] = [];
			for (const file of files) {
				if (file.availability === "missing") continue;
				if (file.availability !== "available" || (file.bytes ?? 0) > limit) {
					problems.push(
						`${file.path}: unavailable or exceeds 64 KiB; bootstrap unobserved`,
					);
					continue;
				}
				try {
					if (managedSpan(readBounded(root, file.path), file.path))
						configured = true;
				} catch (error) {
					problems.push(
						errorCode(error)
							? `${file.path}: unreadable (${errorCode(error)}); bootstrap unobserved`
							: `${file.path}: invalid managed markers or changed metadata; repair before init`,
					);
				}
			}
			return {
				id: adapter.id,
				name: adapter.name,
				source: "integration-adapter",
				scope: "repository",
				files,
				configured: configured ? true : problems.length ? null : false,
				executable: environment.tools.find(
					(tool: Untyped) => tool.id === adapter.id,
				),
				currentInvocation: "unverified",
				nativeInventory: adapter.skills
					? "supported-metadata-only"
					: "unsupported-unobserved",
				historicalAdapterObservations: adapter.capabilities,
				problems,
			};
		})
		.sort((a, b) => compare(a.id, b.id));
}

function sourceMetadata(source: Untyped) {
	let availability: string;
	try {
		availability = statSync(source.path).isDirectory()
			? "available"
			: "unavailable";
	} catch (error) {
		availability = errorCode(error) === "ENOENT" ? "missing" : "unavailable";
	}
	return {
		...source,
		source: "external-skill-root",
		availability,
		verification: "metadata-only",
		runtime: "unverified",
	};
}

/** Read-only metadata; no installation or execution permission is implied. */
export function inspectRepository({
	root,
	external = false,
	sourceOptions = {},
	environmentOptions = {},
}: {
	root: string;
	external?: boolean;
	sourceOptions?: object;
	environmentOptions?: Untyped;
}) {
	root = realpathSync(root);
	if (!statSync(root).isDirectory())
		throw new Error("Inspection root must be a directory");
	const { metadata: configuration, configuration: parsed } =
		configurationMetadata(root);
	const instructionWarnings: string[] = [];
	const cursorRules = recognizedChildren(
		root,
		".cursor/rules",
		/\.mdc$/,
		instructionWarnings,
	);
	const instructions = [
		...new Set([
			"AGENTS.md",
			"AGENTS.override.md",
			"agents.md",
			"CLAUDE.md",
			"claude.md",
			".hermes.md",
			"HERMES.md",
			".cursorrules",
			...cursorRules,
			...integrations.flatMap((adapter) => adapter.files),
		]),
	]
		.sort(compare)
		.map((file) =>
			fileMetadata(
				root,
				file,
				"instruction",
				integrations.find((adapter) => adapter.files.includes(file))?.id ??
					null,
			),
		);
	const workflows = workflowMetadata(root);
	const environment = environmentMetadata(environmentOptions);
	const found = discoverSkills(root, parsed, {
		external,
		sourceOptions,
		metadataOnly: true,
	});
	let installationStatus =
		configuration.status === "valid"
			? "installed"
			: configuration.status === "partial"
				? "unverified"
				: "incomplete";
	if (configuration.status === "missing") {
		try {
			statSync(safePath(root, ".agent-profiles"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") installationStatus = "not-installed";
		}
	}
	return {
		schemaVersion: 1,
		repository: {
			root,
			installation: {
				status: installationStatus,
				bootstrap: fileMetadata(
					root,
					".agent-profiles/BOOTSTRAP.md",
					"bootstrap-protocol",
				),
			},
			configuration,
			instructions,
			workflows: workflows.files,
			package: packageMetadata(root),
		},
		skills: {
			...found,
			skills: found.skills.map((skill) => ({
				...skill,
				host: skill.host ?? null,
				scope: skill.scope ?? "repository",
				availability: skill.availability ?? "metadata-found",
				verification: skill.package
					? skill.verification
					: skill.path
						? "metadata-only"
						: "unobserved",
				runtime: "unverified",
			})),
			roots: found.roots.map(sourceMetadata),
			status:
				["invalid", "partial"].includes(configuration.status) ||
				found.warnings.length
					? "partial"
					: "complete",
		},
		hosts: hostMetadata(root, environment),
		environment,
		warnings: [...instructionWarnings, ...workflows.warnings],
	};
}

export function formatInventory(result: Untyped) {
	return `Read-only inventory\nRepository: ${result.repository.root}\nInstallation: ${result.repository.installation.status}\nConfiguration: ${result.repository.configuration.status}\n${JSON.stringify(result, null, 2)}\nMetadata does not verify host invocation or grant execution/install permission.`;
}
