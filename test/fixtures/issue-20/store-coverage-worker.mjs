// Isolated native-fs overrides; default node --test discovery has no request.
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

if (process.argv[2] !== undefined) {
	const request = JSON.parse(process.argv[2]);
	const counts = {
		deviceReads: 0,
		renames: 0,
		remoteAccess: 0,
		network: 0,
		mutations: 0,
	};
	const phases = [];
	let objectStage;
	const originalStat = fs.lstatSync;
	const originalRename = fs.renameSync;
	if (request.mode === "device") {
		const descriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync");
		Object.defineProperty(fs, "lstatSync", {
			...descriptor,
			value(target, options) {
				const stat = originalStat(target, options);
				if (objectStage && path.resolve(String(target)) === objectStage) {
					counts.deviceReads++;
					// Change only the device at publish's staging-object comparison.
					return new Proxy(stat, {
						get(value, key) {
							if (key === "dev" && request.mismatch) return value.dev + 1n;
							return Reflect.get(value, key);
						},
					});
				}
				return stat;
			},
		});
		fs.renameSync = (...args) => {
			counts.renames++;
			return originalRename(...args);
		};
	} else if (request.mode === "nonlocal") {
		const nonlocal = (value) =>
			typeof value === "string" &&
			(/^[\\/]{2}/.test(value) ||
				(/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)));
		for (const key of [
			"lstatSync",
			"realpathSync",
			"openSync",
			"readdirSync",
			"readFileSync",
			"mkdirSync",
			"writeFileSync",
			"renameSync",
			"rmSync",
		]) {
			const original = fs[key];
			fs[key] = (...args) => {
				if (args.some(nonlocal)) {
					counts.remoteAccess++;
					throw new Error(`forbidden remote filesystem access: ${key}`);
				}
				if (
					["mkdirSync", "writeFileSync", "renameSync", "rmSync"].includes(key)
				)
					counts.mutations++;
				return original(...args);
			};
		}
		for (const [object, keys] of [
			[net, ["connect", "createConnection"]],
			[http, ["get", "request"]],
			[https, ["get", "request"]],
			[globalThis, ["fetch"]],
		]) {
			for (const key of keys)
				object[key] = () => {
					counts.network++;
					throw new Error("forbidden network dispatch");
				};
		}
	}
	syncBuiltinESMExports();
	const sut = await import("../../../src/package-store.js");
	let output;
	try {
		const result = sut[request.op ?? "importPackage"]({
			...request.args,
			onPhase(phase, detail) {
				phases.push(phase);
				if (phase === "copied")
					objectStage = path.resolve(detail.staging, "object");
			},
		});
		output = { ok: true, result };
	} catch (error) {
		output = { ok: false, message: error.message, code: error.code ?? null };
	}
	process.stdout.write(`${JSON.stringify({ ...output, counts, phases })}\n`);
}
