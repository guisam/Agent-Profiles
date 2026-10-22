// Build dist/ for publishing. Development and tests run the sources directly.
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
rmSync(dist, { recursive: true, force: true });
const tsc = spawnSync(
	process.execPath,
	[
		fileURLToPath(
			new URL("../node_modules/typescript/bin/tsc", import.meta.url),
		),
		"-p",
		"tsconfig.build.json",
	],
	{ cwd: project, stdio: "inherit" },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
// tsc emits the visualizer's app.js; the page and stylesheet are copied as-is.
for (const file of ["index.html", "style.css"])
	cpSync(
		new URL(`../src/visualizer/${file}`, import.meta.url),
		new URL(`../dist/src/visualizer/${file}`, import.meta.url),
	);
