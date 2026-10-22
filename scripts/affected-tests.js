// Runs only the test files a change can reach: node scripts/affected-tests.js [base] [--list]
// base defaults to HEAD (uncommitted changes); a..b checks a commit range. Unmapped changes run everything.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "HEAD";
const changes = [
	...git("diff", "--name-status", base),
	// A commit range (a..b) compares commits only, so skip untracked files.
	...(base.includes("..")
		? []
		: git("ls-files", "--others", "--exclude-standard").map((f) => `A\t${f}`)),
]
	.map((line) => line.split("\t"))
	// Trail tooling rewrites its own files; they never affect tests.
	.filter((parts) => !parts.at(-1).startsWith(".trail/"));
const changed = new Set(changes.map((parts) => parts.at(-1)));

const imports = new Map();
function closure(file, seen = new Set()) {
	if (seen.has(file)) return seen;
	seen.add(file);
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch {
		return seen;
	}
	imports.set(file, source);
	for (const [, spec] of source.matchAll(
		/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g,
	))
		closure(path.posix.join(path.posix.dirname(file), spec), seen);
	return seen;
}

const cli = closure("bin/agent-profiles.ts");
const tests = readdirSync("test")
	.filter((f) => f.endsWith(".test.js"))
	.map((f) => `test/${f}`);
const reach = new Map(
	tests.map((test) => {
		const deps = closure(test);
		// Tests that spawn the CLI depend on everything it imports.
		if (imports.get(test).includes("bin/agent-profiles"))
			for (const f of cli) deps.add(f);
		return [test, deps];
	}),
);

const selected = new Set();
let all = false;
for (const [status, ...paths] of changes) {
	const file = paths.at(-1);
	// Renames and deletions can break doc links; P9b-10 checks them.
	if (/^[RD]/.test(status) || file.endsWith(".md"))
		selected.add("test/package-delivery.test.js");
	const hits = tests.filter(
		(t) =>
			reach.get(t).has(file) ||
			paths.some((p) => reach.get(t).has(p)) ||
			imports.get(t).includes(file) ||
			imports.get(t).includes(path.basename(file)),
	);
	for (const t of hits) selected.add(t);
	if (!hits.length && !file.endsWith(".md")) {
		console.log(`No test maps to ${file}; running the full suite.`);
		all = true;
	}
}

if (!changed.size) {
	console.log(`No changes since ${base}.`);
	process.exit(0);
}
if (args.includes("--list")) {
	console.log(all ? "Would run all tests." : [...selected].sort().join("\n"));
	process.exit(0);
}
const run = all ? [] : [...selected].sort();
console.log(
	all
		? "Running all tests."
		: `Running ${run.length} of ${tests.length} test files:\n  ${run.join("\n  ")}`,
);
const result = spawnSync(process.execPath, ["--test", ...run], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
