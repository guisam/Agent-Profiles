import { createHash } from "node:crypto";
import { canonicalJSON, parseManifest, type Untyped } from "./packages.ts";
import { skillMetadata } from "./resolve.ts";

const compare = (a: Untyped, b: Untyped) =>
	Buffer.compare(canonicalJSON(a), canonicalJSON(b));
const text = (bytes: Buffer) =>
	new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
		.decode(bytes)
		.replace(/\r\n/g, "\n");
const namePattern = /^[a-z0-9][a-z0-9_-]*$/;
const bindingPattern = /^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/;
const alwaysOn = [
	"systemprompt.md",
	"guardrails.md",
	"LongTermMEMORY.md",
	"tool_descriptions/tool_guidance.md",
];
const hookEvents = [
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"SubagentStart",
	"SubagentStop",
	"UserPromptSubmit",
	"Stop",
];

function fail(message: string): never {
	throw new Error(`harness2-tree: ${message}`);
}

function fields(value: Untyped, names: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== names.length ||
		names.some((name) => !Object.hasOwn(value, name))
	)
		fail(`expected fields ${names.join(", ")}`);
}

function allowed(path: string, surface: string) {
	const skillDir = surface === "codex" ? "\\.agents/skills" : "skills";
	return (
		(surface === "codex"
			? ["AGENTS.md", ".codex/hooks.json"]
			: alwaysOn
		).includes(path) ||
		new RegExp(
			`^${skillDir}/[a-z0-9][a-z0-9_-]*/(?:SKILL\\.md|scripts/[A-Za-z0-9_.-]+)$`,
		).test(path) ||
		/^sub_agents\/[a-z0-9][a-z0-9_-]*\/AGENT\.md$/.test(path) ||
		/^scripts\/[a-z0-9_]+\.py$/.test(path) ||
		(surface === "opencode" && /^plugin\/[a-z0-9][a-z0-9_-]*\.ts$/.test(path))
	);
}

function validateMappings(rows: Untyped) {
	if (!Array.isArray(rows)) fail("mappings must be an array");
	for (const row of rows) {
		fields(row, ["operation", "binding", "source", "outputPath", "reason"]);
		if (
			row.binding !== null &&
			(typeof row.binding !== "string" || !bindingPattern.test(row.binding))
		)
			fail("invalid mapping binding");
		if (
			!["copy", "compose", "trigger", "skill-name", "unmapped"].includes(
				row.operation,
			)
		)
			fail("invalid mapping operation");
		if (row.operation === "unmapped") {
			if (
				row.outputPath !== null ||
				typeof row.reason !== "string" ||
				!row.reason
			)
				fail("unmapped source needs a reason and no output path");
		} else if (
			typeof row.outputPath !== "string" ||
			!row.outputPath.startsWith("content/") ||
			row.reason !== null
		)
			fail("invalid mapping output");
		if (row.source === null) {
			if (row.operation !== "unmapped") fail("mapped output needs a source");
		} else {
			fields(
				row.source,
				row.source.type === "blob"
					? ["type", "path", "sha256", "bytes"]
					: ["type", "path", "sha256"],
			);
			if (
				!["blob", "package"].includes(row.source.type) ||
				!/^[0-9a-f]{64}$/.test(row.source.sha256) ||
				typeof row.source.path !== "string" ||
				(row.source.type === "blob" &&
					(!Number.isSafeInteger(row.source.bytes) || row.source.bytes < 0))
			)
				fail("invalid mapping backing");
		}
	}
	for (let i = 1; i < rows.length; i++)
		if (compare(rows[i - 1], rows[i]) >= 0)
			fail("mappings must be sorted and unique");
}

function render({ retained, options }: Untyped) {
	const surface = options.surface;
	const skillDir = surface === "codex" ? ".agents/skills" : "skills";
	const promptPath = surface === "codex" ? "AGENTS.md" : "systemprompt.md";
	const outputs = new Map<string, { bytes: Buffer; backing: Untyped }>();
	const rows: Untyped[] = [];
	const map = (
		operation: string,
		binding: Untyped,
		source: Untyped,
		outputPath: string | null,
		reason: string | null = null,
	) =>
		rows.push({
			operation,
			binding,
			source,
			outputPath: outputPath === null ? null : `content/${outputPath}`,
			reason,
		});
	const generated = (bytes: Buffer) => ({
		type: "generated",
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	const add = (path: string, bytes: Buffer, backing: Untyped) => {
		const prior = outputs.get(path);
		if (prior && !prior.bytes.equals(bytes))
			fail(`conflicting sources for ${path}`);
		outputs.set(path, { bytes, backing: prior?.backing ?? backing });
	};
	const copy = (
		path: string,
		bytes: Buffer,
		source: Untyped,
		binding: Untyped,
	) => {
		if (path.endsWith("/SKILL.md")) {
			map(
				"unmapped",
				binding,
				source,
				null,
				`companion skills require their own skill binding: ${path}`,
			);
			return;
		}
		if (!allowed(path, surface)) {
			map(
				"unmapped",
				binding,
				source,
				null,
				`path is outside the ${surface} surface: ${path}`,
			);
			return;
		}
		text(bytes);
		add(path, bytes, source);
		map("copy", binding, source, path);
	};
	const owners = new Map<string, Set<string>>();
	const consumed = new Set<string>();
	const skillRoots = new Map<string, Set<string>>();
	const own = (entry: Untyped, binding: string) => {
		if (entry.package) {
			const set = owners.get(entry.package.sha256) ?? new Set<string>();
			set.add(binding);
			owners.set(entry.package.sha256, set);
		}
	};
	const consume = (source: Untyped) => {
		if (source?.type === "package")
			consumed.add(`${source.sha256}:${source.path}`);
	};
	const parts: string[] = [];
	for (const entry of retained.composition) {
		const binding =
			entry.owner ??
			entry.package?.binding ??
			`${entry.kind === "profile" ? "profiles" : entry.kind === "role" ? "roles" : "skills"}.${entry.id}`;
		own(entry, binding);
		parts.push(text(entry.bytes));
		consume(entry.backing);
		map("compose", binding, entry.backing, promptPath);
	}
	const triggers: string[] = [];
	const skills = new Map<string, Untyped>(
		[...retained.required, ...retained.available].map((entry: Untyped) => [
			entry.id,
			entry,
		]),
	);
	for (const entry of skills.values()) {
		const binding = `skills.${entry.id}`;
		own(entry, binding);
		const source = entry.backing;
		const bytes =
			entry.bytes ??
			[...retained.composition, ...retained.hostReferences].find(
				(part: Untyped) =>
					source &&
					part.backing &&
					canonicalJSON(part.backing).equals(canonicalJSON(source)),
			)?.bytes ??
			retained.packages
				.find((pkg: Untyped) => pkg.sha256 === source?.sha256)
				?.files.find((file: Untyped) => file.path === source?.path)?.bytes;
		if (!bytes) {
			map(
				"unmapped",
				binding,
				source,
				null,
				"host skill has no captured entrypoint bytes",
			);
			continue;
		}
		const metadata = skillMetadata("unused", binding, bytes, entry.id);
		const name =
			metadata.nameSource === "frontmatter" ? metadata.name : entry.id;
		if (!namePattern.test(name))
			fail(`${binding}: invalid surface skill name ${name}`);
		let body = text(bytes);
		let outputBytes = bytes;
		let operation = "copy";
		if (surface === "opencode" && metadata.nameSource !== "frontmatter") {
			body = body.replace(/^(\uFEFF?---\n)/, `$1name: ${name}\n`);
			outputBytes = Buffer.from(body);
			operation = "skill-name";
		}
		const front = Array.from(body).slice(0, 600).join("");
		const declared = /^name:\s*(\S+)\s*$/m.exec(front)?.[1];
		if (
			!/^description:\s*\S/m.test(front) ||
			(surface === "opencode"
				? declared !== name
				: declared !== undefined && declared !== name)
		)
			fail(
				`${binding}: description and unquoted matching name must be visible within the first 600 characters`,
			);
		const path = `${skillDir}/${name}/SKILL.md`;
		add(
			path,
			outputBytes,
			operation === "copy" ? source : generated(outputBytes),
		);
		map(operation, binding, source, path);
		map("trigger", binding, source, promptPath);
		consume(source);
		if (entry.package) {
			const roots = skillRoots.get(entry.package.sha256) ?? new Set<string>();
			roots.add(`${skillDir}/${name}`);
			skillRoots.set(entry.package.sha256, roots);
		}
		const description = metadata.description
			?.replace(/\s+/g, " ")
			.replace(/\.+$/, "");
		triggers.push(
			surface === "codex"
				? `- When ${description}, read ${path} and follow it.`
				: `- When ${description}, load the \`${name}\` skill.`,
		);
	}
	const prompt = Buffer.from([...parts, ...triggers].join("\n\n"));
	add(promptPath, prompt, generated(prompt));
	for (const pkg of retained.packages) {
		const manifest = parseManifest(
			pkg.files.find((file: Untyped) => file.path === "package.yaml").bytes,
		);
		for (const file of pkg.files) {
			if (
				file.path === "package.yaml" ||
				consumed.has(`${pkg.sha256}:${file.path}`)
			)
				continue;
			const source = { type: "package", sha256: pkg.sha256, path: file.path };
			const bindings = [...(owners.get(pkg.sha256) ?? [])];
			if (!bindings.length || file.path === manifest.entrypoint) {
				map(
					"unmapped",
					bindings[0] ?? null,
					source,
					null,
					"entrypoint is outside the selected composition or skill set",
				);
				continue;
			}
			const roots = skillRoots.get(pkg.sha256);
			const paths =
				roots && /^scripts\/[^/]+$/.test(file.path)
					? [...roots].map((root) => `${root}/${file.path}`)
					: [file.path];
			for (const path of paths)
				for (const binding of bindings) copy(path, file.bytes, source, binding);
		}
	}
	for (const resource of retained.resources)
		copy(
			resource.backing.path,
			resource.bytes,
			resource.backing,
			resource.binding,
		);
	for (const entry of retained.shared)
		map(
			"unmapped",
			null,
			entry.backing ?? null,
			null,
			`repository rules are not harness instructions: ${entry.path}`,
		);
	const paths = surface === "codex" ? ["AGENTS.md"] : alwaysOn;
	const body = paths
		.map((path) => {
			const file = outputs.get(path);
			return file ? text(file.bytes) : "";
		})
		.join("\n\n");
	const cap = surface === "codex" ? 8000 : 24000;
	if (Array.from(body).length > cap)
		fail(
			`always-on content exceeds the ${cap} character cap (including triggers)`,
		);
	if (surface === "codex" && !body.trim()) fail("AGENTS.md must not be empty");
	for (const [path, file] of outputs) {
		const content = text(file.bytes);
		if (/^sub_agents\//.test(path)) {
			const front = Array.from(content).slice(0, 600).join("");
			if (
				!/^description:\s*\S/m.test(front) ||
				(surface === "opencode" && !/^mode:\s*subagent\s*$/m.test(front))
			)
				fail(
					`${path}: subagent description and mode are required within the first 600 characters`,
				);
		}
		if (path === ".codex/hooks.json") {
			const hooks = JSON.parse(content).hooks;
			if (
				!hooks ||
				typeof hooks !== "object" ||
				Array.isArray(hooks) ||
				!Object.keys(hooks).length
			)
				fail(`${path}: expected a nonempty hooks object`);
			for (const [event, entries] of Object.entries(hooks)) {
				if (
					!hookEvents.includes(event) ||
					!Array.isArray(entries) ||
					entries.some(
						(entry) =>
							!entry ||
							!Array.isArray(entry.hooks) ||
							entry.hooks.some(
								(hook: Untyped) =>
									hook?.type !== "command" ||
									typeof hook.command !== "string" ||
									!hook.command.trim(),
							),
					)
				)
					fail(`${path}: unsupported event or malformed command hook`);
			}
		}
		if (paths.includes(path) || path.endsWith("/SKILL.md")) {
			const prefix = skillDir.replaceAll(".", "\\.");
			const references = new RegExp(
				`(?:python3?\\s+)((?:${prefix}/[\\w-]+/)?scripts/[\\w.-]+\\.py)`,
				"g",
			);
			for (const match of content.matchAll(references)) {
				if (
					!["read_doc.py", "pack.py", "unpack.py"].includes(
						match[1].split("/").at(-1) ?? "",
					) &&
					!outputs.has(match[1])
				)
					fail(`${path}: missing script ${match[1]}`);
			}
		}
	}
	const content = [...outputs]
		.map(([path, file]) => ({ path, bytes: file.bytes }))
		.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	return {
		files: content.map((file) => ({
			path: `content/${file.path}`,
			backing: outputs.get(file.path)?.backing,
		})),
		content,
		rows: [
			...new Map(
				rows.map((row) => [canonicalJSON(row).toString("hex"), row]),
			).values(),
		].sort(compare),
	};
}

export const harness2Materializer = {
	identity: { id: "harness2-tree", contractVersion: 1 },
	capabilities: {
		bytePreservation: "unverified",
		filesystemIsolation: "verified",
		nativeLayout: "unverified",
		nativeInvocation: "unsupported",
		hostVisibilityIsolation: "unverified",
		runtimeRendering: "unverified",
	},
	validateOptions(options: Untyped) {
		fields(options, ["surface"]);
		if (!["codex", "opencode"].includes(options.surface))
			fail("surface must be codex or opencode");
	},
	validateMappings,
	render,
};
