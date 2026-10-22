import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

// Catch variables are `unknown`; these read errno codes and messages without assuming an Error was thrown.
export function errorCode(error: unknown): string | undefined {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function safePath(root: string, file: string): string {
	const target = path.resolve(root, file);
	const relative = path.relative(root, target);
	if (
		!relative ||
		path.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`)
	) {
		throw new Error(`${file}: target must remain inside the repository`);
	}
	let current = root;
	for (const part of relative.split(path.sep)) {
		current = path.join(current, part);
		let stat: Stats;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
			throw new Error(
				`${file}: refusing to modify linked files or directories`,
			);
		}
		if (current !== target && !stat.isDirectory())
			throw new Error(`${current}: expected a directory`);
	}
	return target;
}

export function readLocal(root: string, file: string): Buffer | null {
	const target = safePath(root, file);
	try {
		return readFileSync(target);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw new Error(`${file}: ${errorMessage(error)}`);
	}
}

function snapshotMatches(actual: Buffer | null, expected: Buffer | null) {
	return actual === null
		? expected === null
		: expected !== null && actual.equals(expected);
}

/** A whole-file replacement; null means the file is absent. */
export type FileChange = {
	file: string;
	before: Buffer | null;
	after: Buffer | null;
};

function writeChange(root: string, { file, before, after }: FileChange) {
	const target = safePath(root, file);
	if (!snapshotMatches(readLocal(root, file), before))
		throw new Error(`${file}: changed during the operation; retry`);
	if (after === null) {
		unlinkSync(target);
		return;
	}
	const temporary = safePath(
		root,
		`${file}.agent-profiles-${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, after, {
			flag: "wx",
			mode: before === null ? 0o666 : lstatSync(target).mode,
		});
		if (!snapshotMatches(readLocal(root, file), before))
			throw new Error(`${file}: changed during the operation; retry`);
		renameSync(temporary, target);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

export function applyChanges(
	root: string,
	changes: FileChange[],
	validate: () => unknown = () => {},
): string[] {
	const written: FileChange[] = [];
	const directories: string[] = [];
	try {
		for (const change of changes) {
			const target = safePath(root, change.file);
			const missing: string[] = [];
			for (
				let dir = path.dirname(target);
				dir !== root && !existsSync(dir);
				dir = path.dirname(dir)
			)
				missing.push(dir);
			for (const dir of missing.reverse()) {
				mkdirSync(dir);
				directories.push(dir);
			}
			writeChange(root, change);
			written.push(change);
		}
		validate();
	} catch (error) {
		const failures: string[] = [];
		for (const change of written.reverse()) {
			try {
				writeChange(root, {
					file: change.file,
					before: change.after,
					after: change.before,
				});
			} catch (rollback) {
				failures.push(errorMessage(rollback));
			}
		}
		for (const dir of directories.reverse()) {
			try {
				rmdirSync(dir);
			} catch {
				/* Preserve directories that are no longer empty. */
			}
		}
		throw new Error(
			`${errorMessage(error)}\n${failures.length ? `Rollback incomplete: ${failures.join("; ")}. Run doctor.` : "No file changes retained; completed writes were rolled back."}`,
		);
	}
	return changes.map((change) => change.file);
}
