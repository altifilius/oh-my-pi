import { sleepLong, withTimeout } from "@oh-my-pi/pi-utils";
import { applyProcessCommandPolicy } from "./process-command";
import { type ProcessPressure, sampleProcessPressure } from "./process-pressure";
import {
	ProjectResourceGate,
	projectResourceDirectory,
	projectTempDirectory,
	readProcessStart,
	type ResourceFileRuntime,
} from "./process-resource-files";

export type ProcessResourceMode = "auto" | "conservative" | "off";

export interface ProcessResourceOptions {
	mode: ProcessResourceMode;
	projectTemp: boolean;
	minAvailableMemoryBytes: number;
	minAvailableMemoryRatio: number;
	memoryStallPercent: number;
	admissionTimeoutMs: number;
	maxHeavyJobs: number;
}

export const DEFAULT_PROCESS_RESOURCE_OPTIONS: ProcessResourceOptions = {
	mode: "auto",
	projectTemp: true,
	minAvailableMemoryBytes: 512 * 1024 * 1024,
	minAvailableMemoryRatio: 0.2,
	memoryStallPercent: 5,
	admissionTimeoutMs: 30_000,
	maxHeavyJobs: 2,
};

export interface ProcessResourceLease {
	command: string;
	env: Record<string, string>;
	notices: string[];
	/** The caller must hold this until the actual command, not its foreground wait, ends. */
	release(): Promise<void>;
}

export interface ProcessResourceInput {
	cwd: string;
	owner: string;
	command: string;
	signal?: AbortSignal;
	options?: Partial<ProcessResourceOptions>;
	env?: Record<string, string>;
}

/** Dependency injection is per invocation, never a mutable process-global test hook. */
export interface ProcessResourceRuntime extends ResourceFileRuntime {
	samplePressure?: (options: ProcessResourceOptions) => Promise<ProcessPressure>;
}

export const PROCESS_RESOURCE_PARALLEL_ENV_KEYS = [
	"MAKEFLAGS",
	"CMAKE_BUILD_PARALLEL_LEVEL",
	"CARGO_BUILD_JOBS",
	"CTEST_PARALLEL_LEVEL",
	"GOMAXPROCS",
	"GOFLAGS",
	"OMP_NUM_THREADS",
	"OPENBLAS_NUM_THREADS",
	"MKL_NUM_THREADS",
	"NUMEXPR_NUM_THREADS",
	"UV_THREADPOOL_SIZE",
	"RUST_TEST_THREADS",
] as const;

interface ReleasedResource {
	cleanup: () => Promise<void>;
	running?: Promise<void>;
}
const releasedResources = new Map<string, Map<object, ReleasedResource>>();

/** Register only resources whose lifecycle owner has already released them. Never accepts PIDs. */
export function registerReleasedProcessResource(owner: string, key: object, cleanup: () => Promise<void>): () => void {
	const resources = releasedResources.get(owner) ?? new Map<object, ReleasedResource>();
	if (!releasedResources.has(owner)) releasedResources.set(owner, resources);
	const resource: ReleasedResource = { cleanup };
	resources.set(key, resource);
	return () => {
		if (resources.get(key) === resource) resources.delete(key);
		if (resources.size === 0 && releasedResources.get(owner) === resources) releasedResources.delete(owner);
	};
}

export async function reapReleasedProcessResources(owner: string): Promise<number> {
	const resources = releasedResources.get(owner);
	if (!resources) return 0;
	let reaped = 0;
	for (const [key, resource] of resources) {
		resource.running ??= Promise.resolve().then(resource.cleanup);
		try {
			await resource.running;
		} catch (error) {
			resource.running = undefined;
			throw error;
		}
		if (resources.get(key) === resource) {
			resources.delete(key);
			reaped++;
		}
	}
	if (resources.size === 0 && releasedResources.get(owner) === resources) releasedResources.delete(owner);
	return reaped;
}

function resolvedOptions(options?: Partial<ProcessResourceOptions>): ProcessResourceOptions {
	const result = { ...DEFAULT_PROCESS_RESOURCE_OPTIONS, ...options };
	if (!["auto", "conservative", "off"].includes(result.mode)) throw new Error("Invalid process resource mode");
	if (typeof result.projectTemp !== "boolean") throw new Error("Invalid projectTemp setting");
	for (const key of [
		"minAvailableMemoryBytes",
		"minAvailableMemoryRatio",
		"memoryStallPercent",
		"admissionTimeoutMs",
		"maxHeavyJobs",
	] as const) {
		if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error(`Invalid process resource setting ${key}`);
	}
	if (
		result.minAvailableMemoryRatio > 1 ||
		result.memoryStallPercent > 100 ||
		result.maxHeavyJobs < 1 ||
		!Number.isInteger(result.maxHeavyJobs)
	)
		throw new Error("Invalid process resource thresholds or job count");
	return result;
}

function applyParallelHints(env: Record<string, string>): void {
	for (const key of PROCESS_RESOURCE_PARALLEL_ENV_KEYS) {
		if (key === "MAKEFLAGS")
			env[key] =
				`${(env[key] ?? "").replace(/(?:^|\s)(?:-j\s*\d*|--jobs(?:[=\s]+\d+)?|--jobserver-(?:auth|fds)=\S+)(?=\s|$)/g, "").trim()} -j1`.trim();
		else if (key === "GOFLAGS")
			env[key] = `${(env[key] ?? "").replace(/(?:^|\s)-p(?:=|\s+)\S+/g, "").trim()} -p=1`.trim();
		else env[key] = "1";
	}
}

async function environment(
	input: Omit<ProcessResourceInput, "command" | "signal">,
	options: ProcessResourceOptions,
	runtime: ProcessResourceRuntime,
	constrained: boolean,
	base?: string,
): Promise<Record<string, string>> {
	const env = { ...input.env };
	if (options.projectTemp) {
		const directory = base ?? (await projectResourceDirectory(input.cwd));
		const temporary = await projectTempDirectory(directory, input.owner, runtime);
		env.TMPDIR = temporary;
		env.TMP = temporary;
		env.TEMP = temporary;
		env.OMP_WORK_DIR = temporary.slice(0, -4);
	}
	if (constrained) applyParallelHints(env);
	return env;
}

/** Project tmp and advisory parallel hints for persistent kernels and their descendants. */
export async function projectProcessEnv(
	input: Omit<ProcessResourceInput, "command" | "signal">,
	runtime: ProcessResourceRuntime = {},
): Promise<Record<string, string>> {
	const options = resolvedOptions(input.options);
	if (options.mode === "off" || /^[a-z][a-z\d+.-]*:\/\//i.test(input.cwd)) return { ...input.env };
	const pressure = await (runtime.samplePressure ?? sampleProcessPressure)(options);
	return environment(input, options, runtime, options.mode === "conservative" || pressure.level !== "healthy");
}

/**
 * Cooperative admission is scoped to one project and cooperating OMP processes.
 * It does not cap arbitrary descendants, detached children after owner death, or
 * opaque script worker pools. Existing host/cgroup guards remain authoritative.
 */
export async function prepareProcessResources(
	input: ProcessResourceInput,
	runtime: ProcessResourceRuntime = {},
): Promise<ProcessResourceLease> {
	input.signal?.throwIfAborted();
	const options = resolvedOptions(input.options);
	const inactive = options.mode === "off" || /^[a-z][a-z\d+.-]*:\/\//i.test(input.cwd);
	if (inactive) return { command: input.command, env: { ...input.env }, notices: [], release: async () => {} };
	const initial = applyProcessCommandPolicy(input.command, false);
	const notices: string[] = [];
	const deadline = performance.now() + options.admissionTimeoutMs;
	// Lifecycle owners registered only released resources. Cleanup before sampling
	// can recover pressure; a cleanup failure is reported but never kills live work.
	if (initial.heavy) {
		try {
			await withTimeout(
				reapReleasedProcessResources(input.owner),
				Math.max(1, deadline - performance.now()),
				"Released process cleanup exceeded the admission deadline",
				input.signal,
			);
		} catch (error) {
			notices.push(`Released process cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let pressure = await (runtime.samplePressure ?? sampleProcessPressure)(options);
	let constrained = options.mode === "conservative" || pressure.level !== "healthy";
	let release: (() => Promise<void>) | undefined;
	let base: string | undefined;
	if (initial.heavy) {
		base = await projectResourceDirectory(input.cwd);
		const start = await (runtime.readProcessStart ?? readProcessStart)(process.pid);
		if (!start) throw new Error("Cannot establish process identity for safe resource admission");
		const gate = new ProjectResourceGate(
			base,
			{ version: 1, owner: input.owner, nonce: crypto.randomUUID(), pid: process.pid, start },
			runtime,
		);
		await gate.initialize();
		while (!release) {
			input.signal?.throwIfAborted();
			if (performance.now() >= deadline)
				throw new Error(
					`Process resource admission timed out: ${pressure.level === "critical" ? "critical memory pressure" : "project heavy-job capacity is occupied"}`,
				);
			if (pressure.level !== "critical")
				release = await gate.tryAcquire(
					constrained ? 1 : Math.min(2, options.maxHeavyJobs),
					deadline,
					input.signal,
				);
			if (!release) {
				await sleepLong(Math.min(100, Math.max(1, deadline - performance.now())), input.signal);
				pressure = await (runtime.samplePressure ?? sampleProcessPressure)(options);
				constrained = options.mode === "conservative" || pressure.level !== "healthy";
			}
		}
	}
	try {
		input.signal?.throwIfAborted();
		const env = await environment(input, options, runtime, constrained, base);
		input.signal?.throwIfAborted();
		const policy = applyProcessCommandPolicy(input.command, constrained);
		if (policy.heavy) notices.push(...policy.notices);
		if (constrained && policy.heavy)
			notices.push(
				`Process resources: ${pressure.level === "healthy" ? "conservative mode" : pressure.reasons.join("; ") || pressure.level}; advisory parallel environment set to one worker.`,
			);
		return { command: policy.command, env, notices, release: release ?? (async () => {}) };
	} catch (error) {
		await release?.();
		throw error;
	}
}
