import * as os from "node:os";
import * as path from "node:path";

export type ProcessPressureLevel = "healthy" | "constrained" | "critical";

export interface ProcessPressure {
	level: ProcessPressureLevel;
	availableBytes: number;
	totalBytes: number;
	reasons: string[];
}

export interface ProcessPressureThresholds {
	minAvailableMemoryBytes: number;
	minAvailableMemoryRatio: number;
	memoryStallPercent: number;
}

/** Injectable raw files keep Linux/cgroup fixtures independent of the test host. */
export interface ProcessPressureSource {
	platform: NodeJS.Platform;
	readText(path: string): Promise<string>;
	freeMemory(): number;
	totalMemory(): number;
}

const SYSTEM_SOURCE: ProcessPressureSource = {
	platform: process.platform,
	readText: file => Bun.file(file).text(),
	freeMemory: os.freemem,
	totalMemory: os.totalmem,
};

function finiteBytes(text: string | undefined): number | undefined {
	if (!text || !/^\d+\s*$/.test(text)) return undefined;
	const value = Number(text.trim());
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function optionalText(source: ProcessPressureSource, file: string): Promise<string | undefined> {
	try {
		return await source.readText(file);
	} catch {
		// Missing controllers/PSI are normal on older kernels and non-Linux hosts.
		return undefined;
	}
}

function psi(text: string | undefined, kind: "some" | "full"): number {
	const value = text?.match(new RegExp(`^${kind}\\s+avg10=([\\d.]+)`, "m"))?.[1];
	const result = Number(value ?? 0);
	return Number.isFinite(result) ? result : 0;
}

function mountPath(value: string): string {
	return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Samples only kernel files; never invokes ps, free, systemctl, or a shell. */
export async function sampleProcessPressure(
	thresholds: ProcessPressureThresholds,
	source: ProcessPressureSource = SYSTEM_SOURCE,
): Promise<ProcessPressure> {
	let availableBytes = source.freeMemory();
	let totalBytes = source.totalMemory();
	let lowestRatio = totalBytes > 0 ? availableBytes / totalBytes : 0;
	let someStall = 0;
	let fullStall = 0;
	let incomplete = false;
	const reasons: string[] = [];
	if (source.platform === "linux") {
		const meminfo = await optionalText(source, "/proc/meminfo");
		const available = meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1];
		const total = meminfo?.match(/^MemTotal:\s+(\d+)\s+kB$/m)?.[1];
		if (available && total) {
			availableBytes = Number(available) * 1024;
			totalBytes = Number(total) * 1024;
			lowestRatio = availableBytes / totalBytes;
		} else {
			incomplete = true;
			reasons.push("Linux MemAvailable is unavailable");
		}
		const pressure = await optionalText(source, "/proc/pressure/memory");
		someStall = psi(pressure, "some");
		fullStall = psi(pressure, "full");
		const membership = await optionalText(source, "/proc/self/cgroup");
		const mounts = await optionalText(source, "/proc/self/mountinfo");
		if (!membership || !mounts) {
			incomplete = true;
			reasons.push("cgroup ancestry is unavailable");
		}
		for (const mount of mounts?.split("\n") ?? []) {
			const [left, right] = mount.split(" - ");
			if (!right) continue;
			const fields = left.split(" ");
			const filesystem = right.split(" ");
			const v2 = filesystem[0] === "cgroup2";
			const v1 = filesystem[0] === "cgroup" && filesystem[2]?.split(",").includes("memory");
			if (!v2 && !v1) continue;
			const member = membership?.split("\n").find(line => {
				const parts = line.split(":");
				return v2 ? parts[0] === "0" && parts[1] === "" : parts[1]?.split(",").includes("memory");
			});
			if (!member) continue;
			const group = member.slice(member.indexOf(":", member.indexOf(":") + 1) + 1);
			const root = mountPath(fields[3] ?? "");
			const mountpoint = mountPath(fields[4] ?? "");
			if (!path.posix.isAbsolute(group) || !path.posix.isAbsolute(mountpoint) || !path.posix.isAbsolute(root))
				continue;
			// A cgroup namespace may expose its root as '/', although mountinfo has a host root.
			const relative =
				root === "/"
					? group.slice(1)
					: group === root
						? ""
						: group.startsWith(`${root}/`)
							? group.slice(root.length + 1)
							: group.slice(1);
			let directory = path.posix.resolve(mountpoint, relative);
			if (directory !== mountpoint && !directory.startsWith(`${mountpoint}/`)) continue;
			while (true) {
				const current = finiteBytes(
					await optionalText(source, path.posix.join(directory, v2 ? "memory.current" : "memory.usage_in_bytes")),
				);
				if (current !== undefined) {
					for (const filename of v2 ? ["memory.high", "memory.max"] : ["memory.limit_in_bytes"]) {
						const limit = finiteBytes(await optionalText(source, path.posix.join(directory, filename)));
						if (limit === undefined || limit <= 0 || limit > totalBytes * 1024) continue;
						const remaining = Math.max(0, limit - current);
						availableBytes = Math.min(availableBytes, remaining);
						totalBytes = Math.min(totalBytes, limit);
						lowestRatio = Math.min(lowestRatio, remaining / limit);
						if (
							remaining < thresholds.minAvailableMemoryBytes ||
							remaining / limit < thresholds.minAvailableMemoryRatio
						) {
							reasons.push(`cgroup ${filename} headroom is low`);
						}
					}
				}
				if (v2) {
					const localPressure = await optionalText(source, path.posix.join(directory, "memory.pressure"));
					someStall = Math.max(someStall, psi(localPressure, "some"));
					fullStall = Math.max(fullStall, psi(localPressure, "full"));
				}
				if (directory === mountpoint) break;
				directory = path.posix.dirname(directory);
			}
		}
	}
	const criticalBytes = Math.min(128 * 1024 * 1024, thresholds.minAvailableMemoryBytes / 4);
	const criticalRatio = Math.min(0.05, thresholds.minAvailableMemoryRatio / 4);
	const critical =
		availableBytes <= criticalBytes ||
		lowestRatio <= criticalRatio ||
		fullStall >= Math.max(10, thresholds.memoryStallPercent * 2);
	const constrained =
		incomplete ||
		availableBytes < thresholds.minAvailableMemoryBytes ||
		lowestRatio < thresholds.minAvailableMemoryRatio ||
		someStall >= thresholds.memoryStallPercent;
	if (critical || constrained)
		reasons.push(
			`available memory ${Math.floor(availableBytes / 1024 / 1024)} MiB; memory PSI some/full ${someStall}/${fullStall}%`,
		);
	return {
		level: critical ? "critical" : constrained ? "constrained" : "healthy",
		availableBytes,
		totalBytes,
		reasons,
	};
}
