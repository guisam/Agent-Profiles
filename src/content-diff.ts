// What an update would inject (#55): a unified line diff of every text file of a
// package, old version to new, plus binary and added/removed files. A human
// approving a pin move reads the exact words that will reach the agent's context.
import type { PackageFile } from "./packages.ts";

export type FileDiff = {
	path: string;
	status: "added" | "removed" | "changed";
	/** Unified diff for text files; null for binary content. */
	diff: string | null;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
function text(bytes: Buffer): string | null {
	if (bytes.includes(0)) return null;
	try {
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

const split = (value: string) =>
	value.length ? value.replace(/\r\n/g, "\n").split("\n") : [];

/** Longest-common-subsequence line diff, as unified hunks with `context` lines around changes. */
export function unifiedDiff(
	before: string,
	after: string,
	{ from = "a", to = "b", context = 3 } = {},
): string {
	const a = split(before);
	const b = split(after);
	// Trim the shared prefix and suffix so the LCS table covers only the changed middle.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const table = Array.from({ length: midA.length + 1 }, () =>
		new Array<number>(midB.length + 1).fill(0),
	);
	for (let i = midA.length - 1; i >= 0; i--)
		for (let j = midB.length - 1; j >= 0; j--)
			table[i][j] =
				midA[i] === midB[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
	type Op = { kind: " " | "-" | "+"; line: string; ai: number; bi: number };
	const ops: Op[] = [];
	for (let i = 0; i < start; i++)
		ops.push({ kind: " ", line: a[i], ai: i, bi: i });
	let i = 0;
	let j = 0;
	while (i < midA.length || j < midB.length) {
		if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
			ops.push({ kind: " ", line: midA[i], ai: start + i, bi: start + j });
			i++;
			j++;
		} else if (
			i < midA.length &&
			(j === midB.length || table[i + 1][j] >= table[i][j + 1])
		) {
			// Removals before additions at a change, as unified diffs conventionally show.
			ops.push({ kind: "-", line: midA[i], ai: start + i, bi: start + j });
			i++;
		} else {
			ops.push({ kind: "+", line: midB[j], ai: start + i, bi: start + j });
			j++;
		}
	}
	for (let k = 0; k < a.length - endA; k++)
		ops.push({
			kind: " ",
			line: a[endA + k],
			ai: endA + k,
			bi: endB + k,
		});
	const changed = ops
		.map((op, index) => (op.kind === " " ? -1 : index))
		.filter((index) => index >= 0);
	if (!changed.length) return "";
	const hunks: [number, number][] = [];
	for (const index of changed) {
		const lo = Math.max(0, index - context);
		const hi = Math.min(ops.length - 1, index + context);
		const last = hunks.at(-1);
		if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
		else hunks.push([lo, hi]);
	}
	const out = [`--- ${from}`, `+++ ${to}`];
	for (const [lo, hi] of hunks) {
		const slice = ops.slice(lo, hi + 1);
		const aCount = slice.filter((op) => op.kind !== "+").length;
		const bCount = slice.filter((op) => op.kind !== "-").length;
		const aStart = slice[0].ai + (aCount ? 1 : 0);
		const bStart = slice[0].bi + (bCount ? 1 : 0);
		out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
		for (const op of slice) out.push(`${op.kind}${op.line}`);
	}
	return out.join("\n");
}

/** Every file that differs between two package versions, in path order. */
export function packageDiff(
	before: PackageFile[],
	after: PackageFile[],
	{ fromLabel = "before", toLabel = "after" } = {},
): FileDiff[] {
	const old = new Map(before.map((file) => [file.path, file.bytes]));
	const next = new Map(after.map((file) => [file.path, file.bytes]));
	const paths = [...new Set([...old.keys(), ...next.keys()])].sort((x, y) =>
		Buffer.compare(Buffer.from(x), Buffer.from(y)),
	);
	const diffs: FileDiff[] = [];
	for (const path of paths) {
		const a = old.get(path);
		const b = next.get(path);
		if (a && b && a.equals(b)) continue;
		const status = !a ? "added" : !b ? "removed" : "changed";
		const aText = a ? text(a) : "";
		const bText = b ? text(b) : "";
		diffs.push({
			path,
			status,
			diff:
				aText === null || bText === null
					? null
					: unifiedDiff(aText, bText, {
							from: a ? `${fromLabel}/${path}` : "/dev/null",
							to: b ? `${toLabel}/${path}` : "/dev/null",
						}),
		});
	}
	return diffs;
}
