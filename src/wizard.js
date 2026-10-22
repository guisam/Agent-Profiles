import { stripVTControlCharacters } from "node:util";
import {
	applyRoleChange,
	planRoleChange,
	readConfiguration,
} from "./configure.js";
import { resolveInstructions } from "./resolve.js";
import { discoverSkills } from "./skills.js";

export const display = (text) =>
	stripVTControlCharacters(String(text)).replace(/[\x00-\x1f\x7f]/g, " ");
const where = (skill) =>
	skill.package
		? `package ${skill.package.name}@${skill.package.version} (${skill.verification === "not-checked" ? "declared; verification not checked" : `sha256 ${skill.package.sha256}`})`
		: skill.host
			? `${skill.host} ${skill.scope} skill ${skill.hostId}${skill.path ? ` at ${skill.path}` : " (host-provided)"}` +
				`${skill.availability ? ` [${skill.availability}; invocation unverified]` : ""}`
			: skill.path;
const resourceOf = (skill) =>
	skill.package
		? `package\0${skill.package.binding}\0${skill.package.name}\0${skill.package.version}\0${skill.package.sha256}${Object.hasOwn(skill.package, "revisionDigest") ? `\0${skill.package.revisionDigest}` : ""}`
		: skill.host
			? `host\0${skill.host}\0${skill.scope}\0${skill.hostId}`
			: `file\0${skill.path}`;
const keyOf = (skill) => `${skill.id}\0${resourceOf(skill)}`;

export async function selectSkills({
	choices,
	initial = [],
	label,
	ask,
	write,
}) {
	if (!choices.length) {
		write("No selectable local skills. This list will be empty.");
		return [];
	}
	const selected = new Map(
		initial.map((skill) => {
			const current =
				choices.find((choice) => keyOf(choice) === keyOf(skill)) ?? skill;
			return [keyOf(current), current];
		}),
	);
	let filter = "";
	let page = 0;
	const pageSize = 8;
	for (;;) {
		const matches = choices.filter((skill) =>
			[
				skill.id,
				skill.name,
				skill.description,
				skill.source,
				skill.path,
				skill.host,
				skill.scope,
				skill.hostId,
				skill.availability,
			].some((value) => display(value).toLowerCase().includes(filter)),
		);
		const pages = Math.max(1, Math.ceil(matches.length / pageSize));
		page = Math.min(page, pages - 1);
		const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
		write(`${label} — page ${page + 1}/${pages}; ${selected.size} selected`);
		visible.forEach((skill, index) => {
			write(
				`${index + 1}. [${selected.has(keyOf(skill)) ? "x" : " "}] ${display(skill.id)} — ${display(skill.name)}\n` +
					`   ${display(skill.description ?? "(no description)")}\n   ${display(skill.source)}: ${display(where(skill))}` +
					`${skill.resources?.length ? `\n   Resources: ${skill.resources.map(display).join(", ")}` : ""}`,
			);
		});
		const answer = (
			await ask(
				"Toggle numbers; n/p pages; /text filter; clear; Enter to accept; q to cancel: ",
			)
		).trim();
		if (!answer || answer === "done") return [...selected.values()];
		if (answer === "q") throw new Error("Cancelled; no changes saved");
		if (answer === "n") {
			page = (page + 1) % pages;
			continue;
		}
		if (answer === "p") {
			page = (page + pages - 1) % pages;
			continue;
		}
		if (answer.startsWith("/")) {
			filter = answer.slice(1).toLowerCase();
			page = 0;
			continue;
		}
		if (answer === "clear") {
			selected.clear();
			continue;
		}
		const tokens = answer.split(/[\s,]+/);
		if (
			tokens.some(
				(token) =>
					!/^\d+$/.test(token) ||
					Number(token) < 1 ||
					Number(token) > visible.length,
			)
		) {
			write("Choose the numbers shown on this page, or a navigation command.");
			continue;
		}
		for (const number of new Set(tokens.map(Number))) {
			const skill = visible[number - 1];
			const key = keyOf(skill);
			if (selected.has(key)) selected.delete(key);
			else {
				if (skill.selectable === false) {
					write(
						`Cannot select ${display(skill.id)}: ${display(skill.availability ?? "blocked source")}`,
					);
					continue;
				}
				for (const [otherKey, other] of selected) {
					if (other.id === skill.id || resourceOf(other) === resourceOf(skill))
						selected.delete(otherKey);
				}
				selected.set(key, skill);
			}
		}
	}
}

function summary(plan, write) {
	if (plan.action === "delete") {
		write(
			`Remove role ${plan.id} from agents.yaml. Preserve ${plan.instructionFile ? display(plan.instructionFile) : "its stored package"} and all skill files.`,
		);
		write(`Default role after deletion: ${plan.resolution.role}`);
	} else {
		write(`Role: ${plan.id}\nInstructions: ${display(plan.instructionFile)}`);
		const role = plan.resolution.loaded.find((entry) => entry.kind === "role");
		if (role?.resources?.length)
			write(`Resources: ${role.resources.map(display).join(", ")}`);
		for (const group of ["required", "available"]) {
			write(
				`${group}: ${plan.resolution[group].map((skill) => `${skill.id} (${display(where(skill))}${skill.resources?.length ? `; resources: ${skill.resources.map(display).join(", ")}` : ""})`).join(", ") || "(none)"}`,
			);
		}
		for (const alias of plan.aliases)
			write(
				`Source alias: ${alias.originalId} -> ${alias.id} (${display(alias.path)})`,
			);
		if (plan.newRoleFile)
			write(
				`Create minimal instruction file: ${display(plan.instructionFile)}`,
			);
	}
	write("Proposed configuration is valid.");
}

export async function configureRoles({
	root,
	ask,
	write = console.log,
	external = false,
	sourceOptions = undefined,
	storeRoot = undefined,
}) {
	for (;;) {
		const state = readConfiguration(root, { storeRoot });
		const actionInput = (
			await ask("Roles: [c]reate, [e]dit, [d]elete, [q]uit: ")
		)
			.trim()
			.toLowerCase();
		if (["q", "quit", "exit", ""].includes(actionInput)) return;
		const action = {
			c: "create",
			create: "create",
			e: "edit",
			edit: "edit",
			d: "delete",
			delete: "delete",
		}[actionInput];
		if (!action) {
			write("Choose create, edit, delete, or quit.");
			continue;
		}
		try {
			const roles = state.configuration.get("roles");
			if (action !== "create") {
				for (const [id, role] of roles)
					write(
						`${id}${id === state.configuration.get("default_role") ? " (default)" : ""} — ${display(role.get("description") ?? role.get("file") ?? `package ${role.get("package")}@${role.get("version")}`)}`,
					);
			}
			const id = (await ask("Role identifier: ")).trim();
			const previous = roles.get(id);
			if (action === "create" && previous)
				throw new Error(`Role ${id} already exists; choose edit`);
			if (action !== "create" && !previous)
				throw new Error(`Role ${id} does not exist`);
			const input = {
				root,
				action,
				id,
				expectedConfiguration: state.before,
				sourceOptions: external ? (sourceOptions ?? {}) : undefined,
				storeRoot,
			};
			if (action === "delete") {
				if (state.configuration.get("default_role") === id) {
					const replacements = [...roles.keys()].filter((name) => name !== id);
					if (!replacements.length)
						throw new Error(
							"Create another role before deleting the only/default role",
						);
					write(`Choose a replacement default: ${replacements.join(", ")}`);
					input.defaultRole = (await ask("New default role: ")).trim();
				}
			} else if (!previous?.has("package")) {
				// A package-backed role is refused by planRoleChange below, before any file prompt or write.
				const currentDescription = previous?.get("description") ?? "";
				const description = await ask(
					`Description [${display(currentDescription)}] (optional; - clears): `,
				);
				input.description =
					description === "-" ? "" : description || currentDescription;
				const currentFile = previous?.get("file") ?? `roles/${id}.md`;
				input.file =
					(await ask(`Instruction file [${display(currentFile)}]: `)).trim() ||
					currentFile;
				const found = discoverSkills(root, state.configuration, {
					external,
					sourceOptions,
				});
				for (const warning of found.warnings)
					write(`Inventory: ${display(warning)}`);
				if (!found.skills.length)
					write(
						"No local skills were discovered. Create the role now and add skills later.",
					);
				if (found.duplicates.length)
					write(
						`Duplicate IDs: ${found.duplicates.join(", ")}. Select the intended source; choosing another source replaces that selection.`,
					);
				const existing = previous
					? resolveInstructions({
							root,
							role: id,
							storeRoot,
							lockMode: "validation",
						})
					: { required: [], available: [] };
				// Retain opaque native and package bindings when their installed metadata cannot be inventoried.
				for (const skill of [...existing.required, ...existing.available]) {
					if (skill.package)
						found.skills = found.skills.filter(
							(choice) =>
								!(
									choice.verification === "not-checked" &&
									choice.package?.binding === skill.package.binding
								),
						);
					if (
						(skill.type === "host" || skill.package) &&
						!found.skills.some((choice) => keyOf(choice) === keyOf(skill))
					)
						found.skills.push({ ...skill, source: "configured" });
				}
				input.required = await selectSkills({
					choices: found.skills,
					initial: existing.required,
					label:
						"Required: injected or invoked for all work in this role; keep this list small",
					ask,
					write,
				});
				const choices = found.skills.filter(
					(skill) =>
						!input.required.some(
							(required) =>
								required.id === skill.id ||
								resourceOf(required) === resourceOf(skill),
						),
				);
				input.available = await selectSkills({
					choices,
					initial: existing.available.filter((skill) =>
						choices.some((choice) => keyOf(choice) === keyOf(skill)),
					),
					label:
						"Available: listed for the role; used only when a task falls within the skill description",
					ask,
					write,
				});
				// Bind declarations by ID; the planner's resolver supplies verified identity and digest.
				for (const group of ["required", "available"])
					input[group] = input[group].map((skill) =>
						skill.verification === "not-checked" && skill.package
							? skill.id
							: skill,
					);
			}
			const plan = planRoleChange(input);
			summary(plan, write);
			if (
				(
					await ask(
						`${action === "delete" ? "Delete" : "Save"} role ${id}? [y/N]: `,
					)
				)
					.trim()
					.toLowerCase() !== "y"
			) {
				write("Cancelled; no changes saved.");
				continue;
			}
			const result = applyRoleChange(plan);
			for (const file of result.modified) write(`Updated ${display(file)}`);
			write("Configuration validated.");
			if (action !== "delete")
				write(
					`Edit .agent-profiles/${display(plan.instructionFile)} to refine the role instructions.`,
				);
		} catch (error) {
			write(`Error: ${display(error.message)}`);
		}
	}
}
