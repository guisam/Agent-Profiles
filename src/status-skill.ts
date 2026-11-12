import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type FileChange, readLocal } from "./files.ts";

const ownershipFile = ".agent-profiles/status-skill.json";
// Installation surfaces only; this does not add resolver-native binding scopes.
const directories: Record<string, string> = {
	claude: ".claude/skills/ap-status",
	codex: ".agents/skills/ap-status",
};
const members = ["SKILL.md", "agents/openai.yaml"];
const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/** Plan with the installer's transaction so collisions fail before any writes. */
export function statusSkillChanges(
	root: string,
	packageRoot: string,
	hosts: string[] | null,
): FileChange[] {
	const beforeOwnership = readLocal(root, ownershipFile);
	const owned: Record<string, string> = beforeOwnership
		? JSON.parse(beforeOwnership.toString("utf8"))
		: {};
	const allowed = new Set(
		Object.values(directories).flatMap((dir) =>
			members.map((member) => `${dir}/${member}`),
		),
	);
	if (!owned || typeof owned !== "object" || Array.isArray(owned))
		throw new Error(`${ownershipFile}: expected an ownership map`);
	for (const [file, hash] of Object.entries(owned))
		if (
			!allowed.has(file) ||
			typeof hash !== "string" ||
			!/^[a-f0-9]{64}$/.test(hash)
		)
			throw new Error(`${ownershipFile}: invalid managed skill entry ${file}`);
	const changes: FileChange[] = [];
	if (hosts === null) {
		for (const [file, hash] of Object.entries(owned)) {
			const before = readLocal(root, file);
			// Edited files belong to the user; retain them when uninstalling.
			if (before && digest(before) === hash)
				changes.push({ file, before, after: null });
		}
		if (beforeOwnership)
			changes.push({
				file: ownershipFile,
				before: beforeOwnership,
				after: null,
			});
		return changes;
	}
	for (const host of new Set(hosts)) {
		const directory = directories[host];
		if (!directory) continue;
		for (const member of members) {
			const file = `${directory}/${member}`;
			const before = readLocal(root, file);
			const after = readFileSync(
				path.join(packageRoot, "skills/ap-status", member),
			);
			if (before && (!owned[file] || digest(before) !== owned[file]))
				throw new Error(
					`${file}: ap-status already exists or was edited; move it aside before init (nothing overwritten)`,
				);
			if (!before?.equals(after)) changes.push({ file, before, after });
			owned[file] = digest(after);
		}
	}
	if (Object.keys(owned).length) {
		const after = Buffer.from(`${JSON.stringify(owned, null, 2)}\n`);
		if (!beforeOwnership?.equals(after))
			changes.push({ file: ownershipFile, before: beforeOwnership, after });
	}
	return changes;
}
