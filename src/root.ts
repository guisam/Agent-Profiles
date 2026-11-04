// Project root discovery, kept dependency-light (#53): the CLI's hot paths (resolve,
// the session hook) need it without loading the installer and its imports.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function findRoot(start = process.cwd()) {
	let current = realpathSync(start);
	while (
		!existsSync(path.join(current, ".git")) &&
		!existsSync(path.join(current, ".agent-profiles/agents.yaml"))
	) {
		const parent = path.dirname(current);
		if (parent === current)
			throw new Error(
				"No Git repository found and no Agent Profiles installation found; pass --root <directory> explicitly",
			);
		current = parent;
	}
	return current;
}
