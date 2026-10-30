import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { daemonRuntimeDir } from "../launch/paths";
import {
	BLOB_BROKER_WORKER_ARG,
	DAEMON_BROKER_WORKER_ARG,
	LSP_MUX_WORKER_ARG,
	MNEMOPI_EMBED_SERVER_WORKER_ARG,
	TEXT_PREDICT_WORKER_ARG,
} from "../cli/worker-selectors";
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "./agent-session";

export interface ResourceMemory {
	memoryBytes: number | null;
	swapBytes: number | null;
}

export interface ResourceGpu {
	gpuPercent: number | null;
	vramBytes: number | null;
}

interface ObservedResourceFamily {
	members: Map<string, string>;
	refs: WeakSet<object>;
	unknown: Set<object>;
}

const observedFamilies = new WeakMap<
	AgentSession,
	{ sessions: Map<string, ObservedResourceFamily>; generations: WeakMap<object, string> }
>();

/** Exact observed descendants survive parking/removal; labels and transcript filenames are not ownership. */
export function resourceSessionFamily(
	root: AgentSession,
	registry: AgentRegistry,
): readonly { sessionId: string; cwd: string; partial?: boolean }[] {
	const sessionId = root.sessionManager.getSessionId();
	let cache = observedFamilies.get(root);
	if (!cache) {
		cache = { sessions: new Map(), generations: new WeakMap() };
		observedFamilies.set(root, cache);
	}
	let observed = cache.sessions.get(sessionId);
	if (!observed) {
		observed = { members: new Map(), refs: new WeakSet(), unknown: new Set() };
		cache.sessions.set(sessionId, observed);
	}
	observed.members.set(sessionId, root.sessionManager.getCwd());
	const refs = registry.list();
	const rootRef = refs.find(ref => ref.session === root);
	if (!rootRef)
		return [...observed.members].map(([sessionId, cwd], index) => ({
			sessionId,
			cwd,
			...(observed.unknown.size > 0 && index === 0 ? { partial: true } : {}),
		}));
	const visited = new Set([rootRef.id]);
	const pending = [rootRef.id];
	while (pending.length > 0) {
		const parent = pending.pop()!;
		for (const ref of refs) {
			if (ref.parentId !== parent || visited.has(ref.id)) continue;
			const generation = cache.generations.get(ref);
			if (generation !== undefined && generation !== sessionId) continue;
			cache.generations.set(ref, sessionId);
			visited.add(ref.id);
			pending.push(ref.id);
			if (ref.session) {
				observed.members.set(ref.session.sessionManager.getSessionId(), ref.session.sessionManager.getCwd());
				observed.refs.add(ref);
				observed.unknown.delete(ref);
			} else if (!observed.refs.has(ref)) {
				observed.unknown.add(ref);
			}
		}
	}
	return [...observed.members].map(([sessionId, cwd], index) => ({
		sessionId,
		cwd,
		...(observed.unknown.size > 0 && index === 0 ? { partial: true } : {}),
	}));
}

export interface SessionResourceSnapshot {
	/** 100% is one logical CPU, not the whole machine. */
	cpuPercent: number | null;
	memoryBytes: number | null;
	swapBytes: number | null;
	gpuPercent: number | null;
	vramBytes: number | null;
	processCount: number;
	partial: boolean;
}

export interface SessionResourceMonitorOptions {
	getSessionId: () => string;
	getCwd: () => string;
	/** Exact observed registry descendants, including parked agents; never infer ownership from labels. */
	getSessionFamily?: () => ReadonlyArray<{ sessionId: string; cwd: string; partial?: boolean }>;
	onUpdate: (snapshot: SessionResourceSnapshot) => void;
}

/** @internal Linux stat fields; identity is PID + kernel start ticks, not PID alone. */
export interface ResourceProcess {
	pid: number;
	ppid: number;
	startTicks: number;
	cpuTicks: number;
}

/** @internal comm can contain spaces and closing parentheses. */
export function parseResourceProcessStat(text: string): ResourceProcess | undefined {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open < 1 || close <= open) return undefined;
	const pid = Number(text.slice(0, open).trim());
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	if (fields.length < 20 || fields[0] === "Z" || fields[0] === "X") return undefined;
	const ppid = Number(fields[1]);
	const user = Number(fields[11]);
	const system = Number(fields[12]);
	const startTicks = Number(fields[19]);
	if (![pid, ppid, user, system, startTicks].every(value => Number.isSafeInteger(value) && value >= 0) || pid === 0)
		return undefined;
	return { pid, ppid, startTicks, cpuTicks: user + system };
}

/** @internal PSS apportions shared resident pages; SwapPss does the same for swapped pages. */
export function parseResourceMemory(text: string): ResourceMemory {
	const read = (name: string): number | null => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB\\s*$`, "m").exec(text);
		if (!match) return null;
		const bytes = Number(match[1]) * 1024;
		return Number.isSafeInteger(bytes) ? bytes : null;
	};
	return { memoryBytes: read("Pss"), swapBytes: read("SwapPss") };
}

/** @internal AT_CLKTCK avoids both an assumed USER_HZ and a helper subprocess. */
export function parseResourceClockTicks(auxv: Buffer, wordBytes: number, littleEndian: boolean): number | undefined {
	if (wordBytes !== 4 && wordBytes !== 8) return undefined;
	const word = (offset: number): number =>
		wordBytes === 8
			? Number(littleEndian ? auxv.readBigUInt64LE(offset) : auxv.readBigUInt64BE(offset))
			: littleEndian
				? auxv.readUInt32LE(offset)
				: auxv.readUInt32BE(offset);
	for (let offset = 0; offset + wordBytes * 2 <= auxv.length; offset += wordBytes * 2) {
		const type = word(offset);
		if (type === 0) break;
		if (type !== 17) continue;
		const ticks = word(offset + wordBytes);
		return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : undefined;
	}
	return undefined;
}

function identity(process: ResourceProcess): string {
	return `${process.pid}:${process.startTicks}`;
}

/** @internal An excluded broker is a boundary: none of its unrelated children are inherited. */
export function selectResourceProcesses(
	processes: ReadonlyMap<number, ResourceProcess>,
	roots: ReadonlySet<number>,
	excluded: ReadonlySet<number>,
): ResourceProcess[] {
	const children = new Map<number, ResourceProcess[]>();
	for (const process of processes.values()) {
		const siblings = children.get(process.ppid);
		if (siblings) siblings.push(process);
		else children.set(process.ppid, [process]);
	}
	const selected: ResourceProcess[] = [];
	const visited = new Set<number>();
	const pending = [...roots];
	while (pending.length > 0) {
		const pid = pending.pop()!;
		if (visited.has(pid) || excluded.has(pid)) continue;
		visited.add(pid);
		const process = processes.get(pid);
		if (!process) continue;
		selected.push(process);
		for (const child of children.get(pid) ?? []) {
			// A child cannot predate its parent; reject ancestry observed across PID reuse.
			if (child.startTicks >= process.startTicks) pending.push(child.pid);
		}
	}
	return selected;
}

/** @internal CPU baselines are per birth identity, and reset on conversation changes. */
export class ResourceCpuTracker {
	#previous = new Map<string, number>();
	#time: number | undefined;
	#session: string | undefined;

	sample(
		session: string,
		processes: readonly ResourceProcess[],
		now: number,
		ticksPerSecond: number,
		uptimeMs?: number,
	): number | null {
		let delta = 0;
		let comparable = false;
		const elapsed = this.#time === undefined ? 0 : now - this.#time;
		if (this.#session === session && elapsed > 0) {
			for (const process of processes) {
				const previous = this.#previous.get(identity(process));
				if (previous === undefined) {
					// Only a birth provably inside this interval permits charging lifetime ticks.
					// One tick of uncertainty excludes processes on the boundary.
					const birth = (process.startTicks * 1_000) / ticksPerSecond;
					if (
						uptimeMs === undefined ||
						!Number.isFinite(uptimeMs) ||
						ticksPerSecond <= 0 ||
						birth <= uptimeMs - elapsed + 1_000 / ticksPerSecond ||
						birth > uptimeMs
					)
						continue;
					delta += process.cpuTicks;
				} else {
					if (process.cpuTicks < previous) continue;
					delta += process.cpuTicks - previous;
				}
				comparable = true;
			}
		}
		this.#previous = new Map(processes.map(process => [identity(process), process.cpuTicks]));
		this.#time = now;
		this.#session = session;
		return comparable && ticksPerSecond > 0 ? (delta * 100_000) / (ticksPerSecond * elapsed) : null;
	}
}

/** @internal pmon headers vary by driver. Only actual per-PID SM and FB columns are accepted. */
export function parseResourceNvidiaPmon(text: string, pids: ReadonlySet<number>): ResourceGpu {
	let columns: string[] = [];
	let sm = 0;
	let memory = 0;
	let hasSm = false;
	let hasMemory = false;
	let missingSm = false;
	let missingMemory = false;
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] === "#") {
			if (fields.includes("pid") && fields.includes("gpu")) columns = fields.slice(1);
			continue;
		}
		if (columns.length === 0) continue;
		const pid = Number(fields[columns.indexOf("pid")]);
		if (!Number.isSafeInteger(pid) || !pids.has(pid)) continue;
		const number = (name: string): number | undefined => {
			const index = columns.indexOf(name);
			const value = index < 0 ? undefined : fields[index];
			return value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
		};
		const utilization = number("sm");
		const fb = number("fb");
		if (utilization === undefined || utilization > 100) missingSm = true;
		else {
			hasSm = true;
			sm += utilization;
		}
		if (fb === undefined) missingMemory = true;
		else {
			hasMemory = true;
			memory += fb * 1024 * 1024;
		}
	}
	return {
		gpuPercent: hasSm && !missingSm ? sm : null,
		vramBytes: hasMemory && !missingMemory ? memory : null,
	};
}

/** @internal Query output has one PID/MiB pair per GPU; unsupported fields never become zero. */
export function parseResourceNvidiaMemory(text: string, pids: ReadonlySet<number>): number | null {
	let bytes = 0;
	let found = false;
	for (const line of text.trim().split("\n")) {
		const fields = line.split(",").map(field => field.trim());
		if (fields.length !== 2 || !/^\d+$/.test(fields[0]) || !pids.has(Number(fields[0]))) continue;
		if (!/^\d+(?:\.\d+)?$/.test(fields[1])) return null;
		bytes += Number(fields[1]) * 1024 * 1024;
		found = true;
	}
	return found && Number.isSafeInteger(bytes) ? bytes : null;
}

/** @internal Legacy broker metadata lacks start ticks; reject PIDs outside the launch birth window. */
export function resourceServiceOwner(
	daemon: unknown,
	process: ResourceProcess,
	owners: ReadonlySet<string>,
	bootTime: number,
	clockTicks: number,
): string | undefined {
	if (typeof daemon !== "object" || daemon === null) return undefined;
	const record = daemon as Record<string, unknown>;
	if (
		typeof record.owner !== "string" ||
		!owners.has(record.owner) ||
		record.pid !== process.pid ||
		typeof record.state !== "string" ||
		!["starting", "running", "ready", "stopping"].includes(record.state) ||
		typeof record.startedAt !== "number" ||
		!Number.isFinite(record.startedAt) ||
		!Number.isFinite(bootTime) ||
		!Number.isFinite(clockTicks) ||
		clockTicks <= 0
	)
		return undefined;
	const birth = bootTime + (process.startTicks * 1_000) / clockTicks;
	// btime has second precision; allow quantization plus bounded broker spawn latency.
	if (birth < record.startedAt - 1_000 || birth > record.startedAt + 5_000) return undefined;
	return record.owner;
}

const INTERVAL_MS = 2_000;
const GPU_INTERVAL_MS = 10_000;
const SHARED_WORKERS = new Set([
	DAEMON_BROKER_WORKER_ARG,
	BLOB_BROKER_WORKER_ARG,
	LSP_MUX_WORKER_ARG,
	MNEMOPI_EMBED_SERVER_WORKER_ARG,
	TEXT_PREDICT_WORKER_ARG,
]);

function unavailable(): SessionResourceSnapshot {
	return {
		cpuPercent: null,
		memoryBytes: null,
		swapBytes: null,
		gpuPercent: null,
		vramBytes: null,
		processCount: 0,
		partial: true,
	};
}

async function mapBounded<T>(values: readonly T[], action: (value: T) => Promise<void>): Promise<void> {
	let index = 0;
	await Promise.all(
		Array.from({ length: Math.min(8, values.length) }, async () => {
			while (index < values.length) await action(values[index++]);
		}),
	);
}

async function readProcess(pid: number): Promise<ResourceProcess | undefined> {
	try {
		const parsed = parseResourceProcessStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
		return parsed?.pid === pid ? parsed : undefined;
	} catch {
		return undefined; // Exits and permission races are normal while walking procfs.
	}
}

interface ProcessAttribution {
	owner: string;
	shared: boolean;
}

/**
 * Passive, Linux-only local accounting. No broker connections, model calls or tool jobs.
 * The main runtime (including in-process agents) cannot be split between conversations.
 * Its owned children are pinned to their first observed conversation/birth identity;
 * explicit session env and broker owner records take precedence over ancestry.
 * This is sampled visible accounting, not an all-resource total: unreadable ownership
 * makes totals unavailable, and processes that start and exit between polls are missed.
 */
export class SessionResourceMonitor {
	readonly #options: SessionResourceMonitorOptions;
	readonly #cpu = new ResourceCpuTracker();
	#timer: NodeJS.Timeout | undefined;
	#started = false;
	#disposed = false;
	#attribution = new Map<string, ProcessAttribution>();
	#clockTicks: number | undefined;
	#bootTime: number | undefined;
	#gpuAt = -Infinity;
	#gpu: ResourceGpu = { gpuPercent: null, vramBytes: null };
	#gpuSession = "";
	#gpuIdentities = "";
	readonly #families = new Map<string, Map<string, string>>();
	#gpuAbort: AbortController | undefined;
	#gpuPartial = false;

	constructor(options: SessionResourceMonitorOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#tick();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#gpuAbort?.abort();
		this.#attribution.clear();
		this.#families.clear();
		try {
			this.#options.onUpdate(unavailable());
		} catch {
			// Disposing a detached UI must not throw.
		}
	}

	async #tick(): Promise<void> {
		let session: string | undefined;
		let cwd: string | undefined;
		let snapshot: SessionResourceSnapshot;
		try {
			session = this.#options.getSessionId();
			cwd = this.#options.getCwd();
			snapshot = process.platform === "linux" ? await this.#sample(session, cwd) : unavailable();
		} catch {
			snapshot = unavailable();
		}
		if (this.#disposed) return;
		try {
			// Never repaint another conversation with an in-flight result.
			const unchanged = session === this.#options.getSessionId() && cwd === this.#options.getCwd();
			this.#options.onUpdate(unchanged ? snapshot : unavailable());
		} catch {
			try {
				this.#options.onUpdate(unavailable());
			} catch {
				// A detached callback must not create an unhandled timer rejection.
			}
		}
		if (this.#disposed) return;
		// Schedule after completion, never pile up asynchronous procfs/GPU samples.
		this.#timer = setTimeout(() => void this.#tick(), INTERVAL_MS);
		this.#timer.unref();
	}

	async #initializeLinux(): Promise<void> {
		if (this.#clockTicks !== undefined && this.#bootTime !== undefined) return;
		const [auxv, stat] = await Promise.all([fs.readFile("/proc/self/auxv"), fs.readFile("/proc/stat", "utf8")]);
		const wordBytes = process.arch === "ia32" || process.arch === "arm" ? 4 : 8;
		this.#clockTicks = parseResourceClockTicks(auxv, wordBytes, os.endianness() === "LE");
		const boot = /^btime (\d+)$/m.exec(stat);
		this.#bootTime = boot ? Number(boot[1]) * 1_000 : undefined;
	}

	async #serviceRoots(
		family: ReadonlyArray<{ sessionId: string; cwd: string }>,
		processes: ReadonlyMap<number, ResourceProcess>,
	): Promise<{ roots: Map<number, string>; partial: boolean }> {
		const scopes = new Map<string, Set<string>>();
		let partial = false;
		for (const member of family) {
			let cwd = path.resolve(member.cwd);
			try {
				cwd = await fs.realpath(cwd);
			} catch {
				// A protected/missing cwd can hide the broker's canonical scope.
				partial = true;
			}
			const scope = daemonRuntimeDir(cwd);
			let owners = scopes.get(scope);
			if (!owners) scopes.set(scope, (owners = new Set()));
			owners.add(member.sessionId);
			owners.add(`${member.sessionId}-advisor`);
		}
		const roots = new Map<number, string>();
		for (const [scope, owners] of scopes) {
			let names: string[];
			try {
				names = await fs.readdir(path.join(scope, "daemons"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial = true;
				continue;
			}
			await mapBounded(names, async name => {
				try {
					// Read only small lifecycle metadata, never spec.json with inherited secrets.
					const record = JSON.parse(await fs.readFile(path.join(scope, "daemons", name, "meta.json"), "utf8"));
					const daemon = record?.daemon;
					if (
						!daemon ||
						!owners.has(daemon.owner) ||
						!["starting", "running", "ready", "stopping"].includes(daemon.state)
					)
						return;
					const process = processes.get(daemon.pid);
					if (!process) {
						partial = true;
						return;
					}
					if (!Number.isFinite(daemon.startedAt) || !this.#clockTicks || this.#bootTime === undefined) {
						partial = true;
						return;
					}
					const owner = resourceServiceOwner(daemon, process, owners, this.#bootTime, this.#clockTicks);
					if (owner === undefined) {
						partial = true;
						return;
					}
					roots.set(process.pid, owner);
				} catch {
					partial = true;
				}
			});
		}
		return { roots, partial };
	}

	async #attribute(process: ResourceProcess, fallback: string): Promise<ProcessAttribution | undefined> {
		const key = identity(process);
		const cached = this.#attribution.get(key);
		if (cached) return cached;
		let owner = fallback;
		let shared = false;
		try {
			const args = (await fs.readFile(`/proc/${process.pid}/cmdline`, "utf8")).split("\0");
			shared = args.some(arg => SHARED_WORKERS.has(arg));
			const env = await fs.readFile(`/proc/${process.pid}/environ`, "utf8");
			const explicit = env.split("\0").find(value => value.startsWith("PI_SESSION_ID="));
			if (explicit && explicit.length > "PI_SESSION_ID=".length) owner = explicit.slice("PI_SESSION_ID=".length);
		} catch {
			// Inaccessible worker boundaries or explicit identity cannot establish ownership.
			return undefined;
		}
		const current = await readProcess(process.pid);
		if (!current || identity(current) !== key) return undefined;
		const attribution = { owner, shared };
		this.#attribution.set(key, attribution);
		return attribution;
	}

	async #sample(session: string, cwd: string): Promise<SessionResourceSnapshot> {
		await this.#initializeLinux();
		const observed = this.#options.getSessionFamily?.() ?? [];
		let familyById = this.#families.get(session);
		if (!familyById) this.#families.set(session, (familyById = new Map()));
		familyById.set(session, cwd);
		for (const member of observed) familyById.set(member.sessionId, member.cwd);
		const family = [...familyById].map(([sessionId, cwd]) => ({ sessionId, cwd }));
		const owners = new Set(family.flatMap(member => [member.sessionId, `${member.sessionId}-advisor`]));
		const processes = new Map<number, ResourceProcess>();
		const names = (await fs.readdir("/proc")).filter(name => /^\d+$/.test(name));
		let procPartial = false;
		await mapBounded(names, async name => {
			try {
				const candidate = parseResourceProcessStat(await fs.readFile(`/proc/${name}/stat`, "utf8"));
				if (candidate?.pid === Number(name)) processes.set(candidate.pid, candidate);
			} catch (error) {
				if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) procPartial = true;
			}
		});
		const services = await this.#serviceRoots(family, processes);
		const roots = new Set([process.pid, ...services.roots.keys()]);
		// Reparented children remain roots only while the same kernel birth identity is alive.
		for (const candidate of processes.values()) {
			const attribution = this.#attribution.get(identity(candidate));
			if (attribution && !attribution.shared && owners.has(attribution.owner)) roots.add(candidate.pid);
		}
		const candidates = selectResourceProcesses(processes, roots, new Set());
		const excluded = new Set<number>();
		let attributionPartial = procPartial || services.partial || observed.some(member => member.partial);
		// Attribute parents first even though procfs directory order is unspecified.
		candidates.sort((a, b) => a.startTicks - b.startTicks || a.pid - b.pid);
		const pending = new Map(candidates.map(candidate => [candidate.pid, candidate]));
		while (pending.size > 0) {
			let progressed = false;
			for (const [pid, candidate] of pending) {
				if (candidate.pid === process.pid) {
					pending.delete(pid);
					progressed = true;
					continue;
				}
				if (pending.has(candidate.ppid)) continue;
				pending.delete(pid);
				progressed = true;
				const serviceOwner = services.roots.get(candidate.pid);
				if (excluded.has(candidate.ppid) && !serviceOwner) {
					excluded.add(pid);
					continue;
				}
				const parent = processes.get(candidate.ppid);
				const inherited = parent ? this.#attribution.get(identity(parent))?.owner : undefined;
				const attribution = await this.#attribute(candidate, serviceOwner ?? inherited ?? session);
				if (!attribution) {
					attributionPartial = true;
					excluded.add(candidate.pid);
					continue;
				}
				if (serviceOwner) attribution.owner = serviceOwner;
				if (attribution.shared || !owners.has(attribution.owner)) excluded.add(candidate.pid);
			}
			if (!progressed) {
				for (const pid of pending.keys()) excluded.add(pid);
				attributionPartial = true;
				break;
			}
		}
		const selected = selectResourceProcesses(processes, roots, excluded);
		const liveIdentities = new Set([...processes.values()].map(identity));
		for (const key of this.#attribution.keys()) if (!liveIdentities.has(key)) this.#attribution.delete(key);
		let memoryBytes = 0;
		let swapBytes = 0;
		let memoryAvailable = true;
		let swapAvailable = true;
		let partial = services.partial || attributionPartial;
		const measured: ResourceProcess[] = [];
		await mapBounded(selected, async candidate => {
			let memory: ResourceMemory = { memoryBytes: null, swapBytes: null };
			try {
				memory = parseResourceMemory(await fs.readFile(`/proc/${candidate.pid}/smaps_rollup`, "utf8"));
			} catch {
				partial = true;
			}
			const current = await readProcess(candidate.pid);
			if (!current || identity(current) !== identity(candidate)) {
				partial = true;
				attributionPartial = true;
				return;
			}
			measured.push(current);
			if (memory.memoryBytes === null) memoryAvailable = false;
			else memoryBytes += memory.memoryBytes;
			if (memory.swapBytes === null) swapAvailable = false;
			else swapBytes += memory.swapBytes;
		});
		const [uptime] = (await fs.readFile("/proc/uptime", "utf8")).split(" ");
		const uptimeMs = Number(uptime) * 1_000;
		const sampledAt = performance.now();
		const gpu = await this.#sampleGpu(session, measured);
		if (attributionPartial) this.#cpu.sample("", [], sampledAt, this.#clockTicks ?? 1);
		return {
			cpuPercent:
				!attributionPartial && this.#clockTicks
					? this.#cpu.sample(
							session,
							measured,
							sampledAt,
							this.#clockTicks,
							Number.isFinite(uptimeMs) ? uptimeMs : undefined,
						)
					: null,
			memoryBytes: !attributionPartial && measured.length > 0 && memoryAvailable ? memoryBytes : null,
			swapBytes: !attributionPartial && measured.length > 0 && swapAvailable ? swapBytes : null,
			...(attributionPartial ? { gpuPercent: null, vramBytes: null } : gpu),
			processCount: measured.length,
			partial: partial || this.#gpuPartial || !memoryAvailable || !swapAvailable || this.#clockTicks === undefined,
		};
	}

	async #sampleGpu(session: string, processes: readonly ResourceProcess[]): Promise<ResourceGpu> {
		const now = performance.now();
		const identities = processes.map(identity).sort().join(",");
		if (session !== this.#gpuSession || identities !== this.#gpuIdentities) {
			this.#gpu = { gpuPercent: null, vramBytes: null };
			this.#gpuPartial = false;
			this.#gpuSession = session;
			this.#gpuIdentities = identities;
		}
		if (now - this.#gpuAt < GPU_INTERVAL_MS) return this.#gpu;
		this.#gpuAt = now;
		this.#gpuPartial = false;
		this.#gpu = { gpuPercent: null, vramBytes: null };
		const executable = Bun.which("nvidia-smi");
		if (!executable) return this.#gpu;
		let usingNvidia = false;
		// Reading existing FD symlinks does not open a device or wake a sleeping GPU.
		await mapBounded(processes, async process => {
			try {
				for (const fd of await fs.readdir(`/proc/${process.pid}/fd`)) {
					let target: string;
					try {
						target = await fs.readlink(`/proc/${process.pid}/fd/${fd}`);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#gpuPartial = true;
						continue;
					}
					if (/^\/dev\/nvidia\d+$/.test(target)) {
						usingNvidia = true;
						break;
					}
				}
			} catch {
				// Process exit or restricted FD visibility means GPU accounting is unavailable.
				this.#gpuPartial = true;
			}
		});
		if (!usingNvidia || this.#disposed) return this.#gpu;
		const controller = new AbortController();
		this.#gpuAbort = controller;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		execFile(
			executable,
			["pmon", "-c", "1", "-s", "um"],
			{ timeout: 2_000, maxBuffer: 256 * 1024, signal: controller.signal },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
		const text = await promise;
		let memoryText: string | undefined;
		const initialGpu = text
			? parseResourceNvidiaPmon(text, new Set(processes.map(process => process.pid)))
			: undefined;
		if (initialGpu?.vramBytes == null && !this.#disposed) {
			const memory = Promise.withResolvers<string | undefined>();
			execFile(
				executable,
				["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
				{ timeout: 1_000, maxBuffer: 256 * 1024, signal: controller.signal },
				(error, stdout) => memory.resolve(error ? undefined : stdout),
			);
			memoryText = await memory.promise;
		}
		this.#gpuAbort = undefined;
		if (this.#disposed) return this.#gpu;
		const valid = new Set<number>();
		for (const process of processes) {
			const current = await readProcess(process.pid);
			if (!current || identity(current) !== identity(process)) {
				this.#gpu = { gpuPercent: null, vramBytes: null };
				return this.#gpu;
			}
			valid.add(process.pid);
		}
		this.#gpu = text ? parseResourceNvidiaPmon(text, valid) : { gpuPercent: null, vramBytes: null };
		if (this.#gpu.vramBytes === null && memoryText)
			this.#gpu.vramBytes = parseResourceNvidiaMemory(memoryText, valid);
		return this.#gpu;
	}
}
