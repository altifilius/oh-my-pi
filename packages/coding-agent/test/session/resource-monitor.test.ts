import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { daemonRuntimeDir } from "../../src/launch/paths";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import {
	parseResourceClockTicks,
	parseResourceMemory,
	parseResourceNvidiaMemory,
	parseResourceNvidiaPmon,
	parseResourceProcessStat,
	ResourceCpuTracker,
	SessionResourceMonitor,
	resourceServiceOwner,
	resourceSessionFamily,
	selectResourceProcesses,
	type ResourceProcess,
	type SessionResourceSnapshot,
} from "../../src/session/resource-monitor";

function session(sessionId: string, cwd = "/project"): AgentSession {
	return { sessionManager: { getSessionId: () => sessionId, getCwd: () => cwd } } as AgentSession;
}

function proc(pid: number, ppid: number, startTicks = pid, cpuTicks = 0): ResourceProcess {
	return { pid, ppid, startTicks, cpuTicks };
}

function stat(state = "S"): string {
	const fields = Array.from({ length: 22 }, () => "0");
	fields[0] = state;
	fields[1] = "41";
	fields[11] = "120";
	fields[12] = "23";
	fields[19] = "4567";
	return `42 (worker ) name with (parens)) ${fields.join(" ")}`;
}

describe("session resource procfs parsing", () => {
	it("parses parent, CPU and birth ticks despite arbitrary comm parentheses", () => {
		expect(parseResourceProcessStat(stat())).toEqual(proc(42, 41, 4567, 143));
		expect(parseResourceProcessStat(stat("Z"))).toBeUndefined();
		expect(parseResourceProcessStat("42 (missing fields) S 1")).toBeUndefined();
		expect(parseResourceProcessStat(stat().replace("4567", "NaN"))).toBeUndefined();
	});

	it("uses PSS and SwapPss without substituting double-counted RSS or unsupported zero", () => {
		expect(parseResourceMemory("Rss: 900 kB\nPss: 123 kB\nSwap: 80 kB\nSwapPss: 30 kB\n")).toEqual({
			memoryBytes: 123 * 1024,
			swapBytes: 30 * 1024,
		});
		expect(parseResourceMemory("Rss: 900 kB\nSwap: 0 kB\n")).toEqual({ memoryBytes: null, swapBytes: null });
		expect(parseResourceMemory("Pss: 0 kB\nSwapPss: 0 kB\n")).toEqual({ memoryBytes: 0, swapBytes: 0 });
	});

	it("reads kernel clock frequency from 32/64 bit auxv with either byte order", () => {
		for (const width of [4, 8]) {
			for (const little of [true, false]) {
				const auxv = Buffer.alloc(width * 6);
				const put = (offset: number, value: number) => {
					if (width === 8) {
						if (little) auxv.writeBigUInt64LE(BigInt(value), offset);
						else auxv.writeBigUInt64BE(BigInt(value), offset);
					} else if (little) auxv.writeUInt32LE(value, offset);
					else auxv.writeUInt32BE(value, offset);
				};
				put(0, 6);
				put(width, 4096);
				put(width * 2, 17);
				put(width * 3, 250);
				expect(parseResourceClockTicks(auxv, width, little)).toBe(250);
			}
		}
		expect(parseResourceClockTicks(Buffer.alloc(8), 8, true)).toBeUndefined();
	});
});

describe("session resource ownership", () => {
	it("includes only exact registry descendants, across nested agents and worktrees", () => {
		const registry = new AgentRegistry();
		const root = session("main-journal");
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: root });
		registry.register({
			id: "Child",
			parentId: "Main",
			displayName: "Child",
			kind: "sub",
			session: session("child-journal", "/worktree"),
		});
		registry.register({
			id: "Grandchild",
			parentId: "Child",
			displayName: "Grandchild",
			kind: "sub",
			session: session("grandchild-journal"),
		});
		registry.register({
			id: "Advisor",
			parentId: "Main",
			displayName: "Advisor",
			kind: "advisor",
			session: session("advisor-journal"),
		});
		registry.register({ id: "Parked", parentId: "Main", displayName: "Parked", kind: "sub", session: null });
		registry.register({ id: "Other", displayName: "Main", kind: "main", session: session("unrelated-journal") });
		expect(resourceSessionFamily(root, registry)).toEqual([
			{ sessionId: "main-journal", cwd: "/project", partial: true },
			{ sessionId: "child-journal", cwd: "/worktree" },
			{ sessionId: "advisor-journal", cwd: "/project" },
			{ sessionId: "grandchild-journal", cwd: "/project" },
		]);
		expect(resourceSessionFamily(session("not-registered"), registry)).toEqual([
			{ sessionId: "not-registered", cwd: "/project" },
		]);
	});

	it("terminates on an ancestor cycle without duplicating the root", () => {
		const registry = new AgentRegistry();
		const root = session("root");
		registry.register({ id: "Root", parentId: "Child", displayName: "Root", kind: "main", session: root });
		registry.register({
			id: "Child",
			parentId: "Root",
			displayName: "Child",
			kind: "sub",
			session: session("child"),
		});
		expect(resourceSessionFamily(root, registry).map(member => member.sessionId)).toEqual(["root", "child"]);
	});

	it("retains exact observed child identities after completion, parking and removal", () => {
		const registry = new AgentRegistry();
		const root = session("root");
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: root });
		const child = registry.register({
			id: "Child",
			parentId: "Main",
			displayName: "Child",
			kind: "sub",
			session: session("child", "/child-tree"),
		});
		resourceSessionFamily(root, registry);
		child.session = null;
		child.status = "parked";
		expect(resourceSessionFamily(root, registry)).toEqual([
			{ sessionId: "root", cwd: "/project" },
			{ sessionId: "child", cwd: "/child-tree" },
		]);
		registry.unregister("Child");
		expect(resourceSessionFamily(root, registry).map(member => member.sessionId)).toEqual(["root", "child"]);
	});

	it("does not inherit a previous conversation's cached family on the same root object", () => {
		const registry = new AgentRegistry();
		let id = "first";
		const root = { sessionManager: { getSessionId: () => id, getCwd: () => "/project" } } as AgentSession;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: root });
		registry.register({
			id: "Child",
			parentId: "Main",
			displayName: "Child",
			kind: "sub",
			session: session("child"),
		});
		resourceSessionFamily(root, registry);
		id = "second";
		expect(resourceSessionFamily(root, registry)).toEqual([{ sessionId: "second", cwd: "/project" }]);
		id = "first";
		expect(resourceSessionFamily(root, registry).map(member => member.sessionId)).toEqual(["first", "child"]);
	});

	it("cuts shared broker subtrees, but includes explicitly owned services beneath them once", () => {
		const processes = new Map(
			[
				proc(10, 1),
				proc(11, 10),
				proc(12, 11),
				proc(20, 10), // Shared broker that this OMP happened to launch.
				proc(21, 20),
				proc(22, 21), // Owned service and child.
				proc(23, 20), // Another session's service.
				proc(30, 1), // Unrelated global helper.
			].map(process => [process.pid, process]),
		);
		const selected = selectResourceProcesses(processes, new Set([10, 21]), new Set([20]));
		expect(selected.map(process => process.pid).sort((a, b) => a - b)).toEqual([10, 11, 12, 21, 22]);
		expect(new Set(selected.map(process => process.pid)).size).toBe(selected.length);
	});

	it("rejects ancestry from a reused parent PID and tolerates absent process roots", () => {
		const processes = new Map(
			[proc(10, 1, 100), proc(11, 10, 50), proc(12, 10, 101)].map(process => [process.pid, process]),
		);
		expect(selectResourceProcesses(processes, new Set([10, 999]), new Set()).map(process => process.pid)).toEqual([
			10, 12,
		]);
	});

	it("requires exact live service owner and kernel birth near the recorded generation", () => {
		const process = proc(42, 20, 2500);
		const daemon = { owner: "child-journal", pid: 42, state: "ready", startedAt: 125_500 };
		const owners = new Set(["main-journal", "child-journal"]);
		expect(resourceServiceOwner(daemon, process, owners, 100_000, 100)).toBe("child-journal");
		expect(
			resourceServiceOwner({ ...daemon, owner: "child-journal-other" }, process, owners, 100_000, 100),
		).toBeUndefined();
		expect(resourceServiceOwner({ ...daemon, state: "exited" }, process, owners, 100_000, 100)).toBeUndefined();
		expect(resourceServiceOwner({ ...daemon, pid: 43 }, process, owners, 100_000, 100)).toBeUndefined();
		expect(resourceServiceOwner(daemon, { ...process, startTicks: 90_000 }, owners, 100_000, 100)).toBeUndefined();
		expect(resourceServiceOwner({ ...daemon, startedAt: NaN }, process, owners, 100_000, 100)).toBeUndefined();
	});
});

describe("session resource CPU intervals", () => {
	it("uses one-core percent over real elapsed time and sums owned processes", () => {
		const tracker = new ResourceCpuTracker();
		expect(tracker.sample("a", [proc(1, 0, 1, 100), proc(2, 1, 2, 50)], 1000, 100)).toBeNull();
		expect(tracker.sample("a", [proc(1, 0, 1, 250), proc(2, 1, 2, 100)], 2000, 100)).toBe(200);
		expect(tracker.sample("a", [proc(1, 0, 1, 300), proc(2, 1, 2, 100)], 4000, 100)).toBe(25);
	});

	it("does not charge lifetime CPU for new/reused PIDs, exits, or counter regressions", () => {
		const tracker = new ResourceCpuTracker();
		tracker.sample("a", [proc(1, 0, 1, 100), proc(2, 1, 2, 500)], 0, 100);
		expect(tracker.sample("a", [proc(1, 0, 1, 110), proc(2, 1, 200, 900), proc(3, 1, 3, 800)], 1000, 100)).toBe(10);
		expect(tracker.sample("a", [proc(1, 0, 1, 90)], 2000, 100)).toBeNull();
		expect(tracker.sample("a", [], 3000, 100)).toBeNull();
	});

	it("resets baselines on conversation switches, including resume back to an earlier id", () => {
		const tracker = new ResourceCpuTracker();
		tracker.sample("a", [proc(1, 0, 1, 100)], 0, 100);
		expect(tracker.sample("b", [proc(1, 0, 1, 900)], 1000, 100)).toBeNull();
		expect(tracker.sample("b", [proc(1, 0, 1, 910)], 2000, 100)).toBe(10);
		expect(tracker.sample("a", [proc(1, 0, 1, 920)], 3000, 100)).toBeNull();
	});

	it("charges first-observed CPU only for births provably within the interval", () => {
		const tracker = new ResourceCpuTracker();
		tracker.sample("a", [proc(1, 0, 1, 100)], 0, 100, 10_000);
		expect(
			tracker.sample(
				"a",
				[
					proc(1, 0, 1, 110),
					proc(2, 1, 1050, 40), // Born halfway through this interval.
					proc(3, 1, 900, 800), // Older unseen work must not become lifetime CPU.
					proc(4, 1, 1001, 50), // Tick quantization makes the lower boundary ambiguous.
					proc(5, 1, 1200, 50), // Impossible future birth is not trustworthy.
				],
				1000,
				100,
				11_000,
			),
		).toBe(50);
	});
});

/** Exercise the public timer/callback API against deterministic procfs, not source text. */
function monitorFixture() {
	let id = "main";
	let family: Array<{ sessionId: string; cwd: string; partial?: boolean }> = [];
	let processes = [proc(process.pid, 1, 100, 100)];
	let daemon: Record<string, unknown> | undefined;
	const inaccessible = new Set<number>();
	const environments = new Map<number, string>();
	const commands = new Map<number, string>();
	const scope = daemonRuntimeDir("/project");
	const auxv = Buffer.alloc(32);
	const width = process.arch === "ia32" || process.arch === "arm" ? 4 : 8;
	const put = (offset: number, value: number) => {
		if (width === 8) {
			if (os.endianness() === "LE") auxv.writeBigUInt64LE(BigInt(value), offset);
			else auxv.writeBigUInt64BE(BigInt(value), offset);
		} else if (os.endianness() === "LE") auxv.writeUInt32LE(value, offset);
		else auxv.writeUInt32BE(value, offset);
	};
	put(0, 17);
	put(width, 100);
	const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
	const readFile = spyOn(fs, "readFile").mockImplementation((async (file: unknown) => {
		const name = String(file);
		if (name === "/proc/self/auxv") return auxv;
		if (name === "/proc/stat") return "btime 100\n";
		if (name === "/proc/uptime") return "1000.00 0.00\n";
		if (name === `${scope}/daemons/service/meta.json` && daemon) return JSON.stringify({ daemon });
		const match = /^\/proc\/(\d+)\/(stat|cmdline|environ|smaps_rollup)$/.exec(name);
		if (!match) throw missing();
		const pid = Number(match[1]);
		const candidate = processes.find(candidate => candidate.pid === pid);
		if (!candidate) throw missing();
		if (match[2] === "stat") {
			const fields = Array.from({ length: 22 }, () => "0");
			fields[0] = "S";
			fields[1] = String(candidate.ppid);
			fields[11] = String(candidate.cpuTicks);
			fields[19] = String(candidate.startTicks);
			return `${pid} (fixture) ${fields.join(" ")}`;
		}
		if (inaccessible.has(pid) && (match[2] === "cmdline" || match[2] === "environ")) {
			throw Object.assign(new Error("protected"), { code: "EACCES" });
		}
		if (match[2] === "cmdline") return commands.get(pid) ?? "worker\0";
		if (match[2] === "environ") return environments.get(pid) ?? "";
		return "Pss: 10 kB\nSwapPss: 0 kB\n";
	}) as never);
	const readdir = spyOn(fs, "readdir").mockImplementation((async (directory: unknown) => {
		if (String(directory) === "/proc") return processes.map(candidate => String(candidate.pid));
		if (String(directory) === `${scope}/daemons`) return daemon ? ["service"] : [];
		throw missing();
	}) as never);
	const realpath = spyOn(fs, "realpath").mockImplementation((async (directory: unknown) =>
		String(directory)) as never);
	const which = spyOn(Bun, "which").mockReturnValue(null);
	let scheduled: (() => void) | undefined;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
		scheduled = callback;
		return { unref() {} };
	}) as never);
	const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
	let pending:
		| { promise: Promise<SessionResourceSnapshot>; resolve: (snapshot: SessionResourceSnapshot) => void }
		| undefined;
	const snapshots: SessionResourceSnapshot[] = [];
	const monitor = new SessionResourceMonitor({
		getSessionId: () => id,
		getCwd: () => "/project",
		getSessionFamily: () => family,
		// The fixture captures the actual callback used by the editor.
		onUpdate(snapshot) {
			snapshots.push(snapshot);
			pending?.resolve(snapshot);
		},
	});
	return {
		inaccessible,
		environments,
		commands,
		snapshots,
		monitor,
		setSession(value: string) {
			id = value;
		},
		setFamily(value: typeof family) {
			family = value;
		},
		setProcesses(value: ResourceProcess[]) {
			processes = value;
		},
		setDaemon(value: typeof daemon) {
			daemon = value;
		},
		async sample() {
			pending = Promise.withResolvers<SessionResourceSnapshot>();
			if (scheduled) {
				const callback = scheduled;
				scheduled = undefined;
				callback();
			} else monitor.start();
			return await pending.promise;
		},
		dispose() {
			monitor.dispose();
			readFile.mockRestore();
			readdir.mockRestore();
			realpath.mockRestore();
			which.mockRestore();
			timer.mockRestore();
			clearTimer.mockRestore();
		},
	};
}

describe("session resource monitor consumers", () => {
	it("retains a reparented child, excludes it after /new, restores it on resume, and rejects PID reuse", async () => {
		const fixture = monitorFixture();
		const child = proc(42, process.pid, 200);
		try {
			fixture.setProcesses([proc(process.pid, 1, 100), child]);
			expect((await fixture.sample()).processCount).toBe(2);
			fixture.setProcesses([proc(process.pid, 1, 100), { ...child, ppid: 1 }]);
			expect((await fixture.sample()).processCount).toBe(2);
			fixture.setSession("other");
			expect((await fixture.sample()).processCount).toBe(1);
			fixture.setSession("main");
			expect((await fixture.sample()).processCount).toBe(2);
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, 1, 300)]);
			expect((await fixture.sample()).processCount).toBe(1);
		} finally {
			fixture.dispose();
		}
	});

	it("finds a completed child's still-running service in its observed scope, without leaking across sessions", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setFamily([{ sessionId: "child", cwd: "/project" }]);
			await fixture.sample();
			fixture.setFamily([]);
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, 20, 2500)]);
			fixture.setDaemon({ owner: "child", pid: 42, state: "ready", startedAt: 125_500 });
			expect((await fixture.sample()).processCount).toBe(2);
			fixture.setSession("other");
			expect((await fixture.sample()).processCount).toBe(1);
		} finally {
			fixture.dispose();
		}
	});

	it("honors explicit child ownership rather than the currently displayed conversation", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, process.pid, 200)]);
			fixture.environments.set(42, "PI_SESSION_ID=other\0");
			expect((await fixture.sample()).processCount).toBe(1);
			fixture.setSession("other");
			expect((await fixture.sample()).processCount).toBe(2);
		} finally {
			fixture.dispose();
		}
	});

	it("rejects an owned service metadata record when its PID has a different birth", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, 20, 90_000)]);
			fixture.setDaemon({ owner: "main", pid: 42, state: "ready", startedAt: 125_500 });
			expect(await fixture.sample()).toMatchObject({ processCount: 1, memoryBytes: null, partial: true });
		} finally {
			fixture.dispose();
		}
	});

	it("reports unavailable totals for protected identity and recovers after access returns", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, process.pid, 200)]);
			fixture.inaccessible.add(42);
			expect(await fixture.sample()).toMatchObject({
				memoryBytes: null,
				swapBytes: null,
				cpuPercent: null,
				partial: true,
			});
			fixture.inaccessible.clear();
			expect(await fixture.sample()).toMatchObject({ processCount: 2, memoryBytes: 20 * 1024, partial: false });
		} finally {
			fixture.dispose();
		}
	});

	it("does not mistake Object prototype names in cmdline for shared workers", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setProcesses([proc(process.pid, 1, 100), proc(42, process.pid, 200)]);
			fixture.commands.set(42, "constructor\0toString\0");
			expect((await fixture.sample()).processCount).toBe(2);
			fixture.monitor.dispose();
			expect(fixture.snapshots.at(-1)).toMatchObject({ memoryBytes: null, cpuPercent: null, partial: true });
		} finally {
			fixture.dispose();
		}
	});

	it("clears stale values when session callbacks fail instead of abandoning the polling loop", async () => {
		let calls = 0;
		const snapshots: SessionResourceSnapshot[] = [];
		const timer = spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref() {} })) as never);
		const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
		const monitor = new SessionResourceMonitor({
			getSessionId() {
				calls++;
				throw new Error("detached session");
			},
			getCwd: () => "/project",
			onUpdate: snapshot => snapshots.push(snapshot),
		});
		try {
			monitor.start();
			expect(calls).toBeGreaterThan(0);
			expect(snapshots).toEqual([
				{
					cpuPercent: null,
					memoryBytes: null,
					swapBytes: null,
					gpuPercent: null,
					vramBytes: null,
					processCount: 0,
					partial: true,
				},
			]);
			expect(timer).toHaveBeenCalledTimes(1);
		} finally {
			monitor.dispose();
			timer.mockRestore();
			clearTimer.mockRestore();
		}
	});

	it("does not publish fabricated totals when an unobserved parked family member is known", async () => {
		const fixture = monitorFixture();
		try {
			fixture.setFamily([{ sessionId: "main", cwd: "/project", partial: true }]);
			expect(await fixture.sample()).toMatchObject({ memoryBytes: null, swapBytes: null, partial: true });
		} finally {
			fixture.dispose();
		}
	});
});

describe("session resource NVIDIA parsers", () => {
	it("reads per-PID SM utilization and framebuffer MiB, excluding unrelated GPU clients", () => {
		const output =
			"# gpu pid type sm mem enc dec jpg ofa fb command\n# Idx # C/G % % % % % % MB name\n0 42 C 12 8 0 0 - - 32 worker\n0 99 G 80 10 0 0 - - 500 desktop\n1 42 C 5 0 0 0 - - 16 worker\n";
		expect(parseResourceNvidiaPmon(output, new Set([42]))).toEqual({ gpuPercent: 17, vramBytes: 48 * 1024 * 1024 });
	});

	it("keeps missing SM, FB, empty output and unsupported values unavailable", () => {
		expect(parseResourceNvidiaPmon("# gpu pid type sm mem command\n0 42 C - 40 worker\n", new Set([42]))).toEqual({
			gpuPercent: null,
			vramBytes: null,
		});
		expect(parseResourceNvidiaPmon("# gpu pid type sm fb command\n0 42 C 0 0 worker\n", new Set([42]))).toEqual({
			gpuPercent: 0,
			vramBytes: 0,
		});
		expect(parseResourceNvidiaPmon("", new Set([42]))).toEqual({ gpuPercent: null, vramBytes: null });
		expect(
			parseResourceNvidiaPmon("# gpu pid type sm fb command\n0 42 C 10 20 a\n0 43 C - - b\n", new Set([42, 43])),
		).toEqual({ gpuPercent: null, vramBytes: null });
	});

	it("accepts compute-app PID/MiB fallback without confusing memory bandwidth for bytes", () => {
		expect(parseResourceNvidiaMemory("42, 16\n99, 2048\n42, 32\n", new Set([42]))).toBe(48 * 1024 * 1024);
		expect(parseResourceNvidiaMemory("42, [N/A]\n", new Set([42]))).toBeNull();
		expect(parseResourceNvidiaMemory("99, 2048\n", new Set([42]))).toBeNull();
		expect(parseResourceNvidiaMemory("", new Set([42]))).toBeNull();
	});
});
