import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	sampleProcessPressure,
	type ProcessPressure,
	type ProcessPressureSource,
} from "../../src/exec/process-pressure";
import { readProcessStart, resourceOwnerHash } from "../../src/exec/process-resource-files";
import {
	DEFAULT_PROCESS_RESOURCE_OPTIONS,
	prepareProcessResources,
	projectProcessEnv,
	reapReleasedProcessResources,
	registerReleasedProcessResource,
	type ProcessResourceLease,
	type ProcessResourceRuntime,
} from "../../src/exec/process-resources";

const healthy: ProcessPressure = {
	level: "healthy",
	availableBytes: 4 * 1024 ** 3,
	totalBytes: 8 * 1024 ** 3,
	reasons: [],
};
const critical: ProcessPressure = {
	level: "critical",
	availableBytes: 0,
	totalBytes: 1024 ** 3,
	reasons: ["fixture pressure"],
};
const runtime: ProcessResourceRuntime = { samplePressure: async () => healthy, filesystemType: async () => 0xef53 };
let cwd: string;
const leases: ProcessResourceLease[] = [];

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(process.env.OMP_PROCESS_TEST_ROOT ?? os.tmpdir(), "omp-resources-"));
	await fs.mkdir(path.join(cwd, ".git"));
});

afterEach(async () => {
	for (const lease of leases.splice(0)) await lease.release();
	await fs.rm(cwd, { recursive: true, force: true });
});

function fixtureSource(files: Record<string, string>): ProcessPressureSource {
	return {
		platform: "linux",
		freeMemory: () => healthy.availableBytes,
		totalMemory: () => healthy.totalBytes,
		readText: async filename => {
			if (!(filename in files)) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
			return files[filename];
		},
	};
}

const hostFiles = {
	"/proc/meminfo": "MemTotal:       8388608 kB\nMemAvailable:   4194304 kB\n",
	"/proc/pressure/memory":
		"some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
	"/proc/self/cgroup": "0::/user/session/child\n",
	"/proc/self/mountinfo": "1 2 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
};

it("samples parent cgroup high/max, not only the unlimited leaf", async () => {
	const sample = await sampleProcessPressure(
		DEFAULT_PROCESS_RESOURCE_OPTIONS,
		fixtureSource({
			...hostFiles,
			"/sys/fs/cgroup/user/session/child/memory.current": "1000000",
			"/sys/fs/cgroup/user/session/child/memory.max": "max",
			"/sys/fs/cgroup/user/session/memory.current": "1000000000",
			"/sys/fs/cgroup/user/session/memory.high": "1073741824",
			"/sys/fs/cgroup/user/session/memory.max": "2147483648",
		}),
	);
	expect(sample.level).toBe("critical");
	expect(sample.availableBytes).toBe(73741824);
});

it("uses PSI and conservative fallback when raw Linux telemetry is missing", async () => {
	expect(
		(
			await sampleProcessPressure(
				DEFAULT_PROCESS_RESOURCE_OPTIONS,
				fixtureSource({ ...hostFiles, "/proc/pressure/memory": "some avg10=6.00\nfull avg10=0.00\n" }),
			)
		).level,
	).toBe("constrained");
	expect(
		(
			await sampleProcessPressure(
				DEFAULT_PROCESS_RESOURCE_OPTIONS,
				fixtureSource({ ...hostFiles, "/proc/pressure/memory": "full avg10=15.00\n" }),
			)
		).level,
	).toBe("critical");
	expect((await sampleProcessPressure(DEFAULT_PROCESS_RESOURCE_OPTIONS, fixtureSource({}))).level).toBe("constrained");
});

it("supports cgroup v1 memory limits and namespace mount roots", async () => {
	const sample = await sampleProcessPressure(
		DEFAULT_PROCESS_RESOURCE_OPTIONS,
		fixtureSource({
			...hostFiles,
			"/proc/self/cgroup": "3:memory:/worker\n",
			"/proc/self/mountinfo": "1 2 0:1 /container /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n",
			"/sys/fs/cgroup/memory/worker/memory.usage_in_bytes": "1000000000",
			"/sys/fs/cgroup/memory/worker/memory.limit_in_bytes": "1073741824",
		}),
	);
	expect(sample.level).toBe("critical");
});

it("creates private project temp, preserves explicit env, and isolates owners", async () => {
	const nested = path.join(cwd, "src", "nested");
	await fs.mkdir(nested, { recursive: true });
	const first = await projectProcessEnv(
		{
			cwd: nested,
			owner: "one",
			env: { KEEP: "yes", TMPDIR: "/ignored", MAKEFLAGS: "-k -j8" },
			options: { mode: "conservative" },
		},
		runtime,
	);
	const second = await projectProcessEnv({ cwd, owner: "two" }, runtime);
	expect(first.TMPDIR).toStartWith(path.join(cwd, "build", "tests", "omp"));
	expect(first.TMPDIR).not.toBe(second.TMPDIR);
	expect(first.KEEP).toBe("yes");
	expect(first.MAKEFLAGS).toBe("-k -j1");
	expect(first.CARGO_BUILD_JOBS).toBe("1");
	expect(first.TMP).toBe(first.TMPDIR);
	expect(first.TEMP).toBe(first.TMPDIR);
	if (process.platform !== "win32") expect((await fs.stat(first.TMPDIR)).mode & 0o777).toBe(0o700);
	await Bun.write(path.join(first.TMPDIR, "retained-state"), "owned persistent data");
	const lease = await prepareProcessResources({ cwd, owner: "one", command: "make" }, runtime);
	await lease.release();
	await lease.release();
	expect(await Bun.file(path.join(first.TMPDIR, "retained-state")).text()).toBe("owned persistent data");
});

it.skipIf(process.platform === "win32")(
	"rejects symlink ancestors, writable-to-others leaves, and RAM filesystems",
	async () => {
		const outside = path.join(cwd, "outside");
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(cwd, "build"));
		await expect(projectProcessEnv({ cwd, owner: "one" }, runtime)).rejects.toThrow("symlink");
		await fs.unlink(path.join(cwd, "build"));
		await expect(
			projectProcessEnv(
				{ cwd, owner: "one" },
				{ ...runtime, platform: "linux", filesystemType: async () => 0x01021994 },
			),
		).rejects.toThrow("tmpfs/ramfs");
		const temporary = path.join(cwd, "build", "tests", "omp", await resourceOwnerHash("one"), "tmp");
		await fs.chmod(temporary, 0o500);
		await expect(projectProcessEnv({ cwd, owner: "one" }, runtime)).rejects.toThrow("0700");
		expect((await fs.stat(temporary)).mode & 0o777).toBe(0o500);
		await fs.chmod(temporary, 0o700);
	},
);

it("off and virtual cwd do not touch the filesystem or parallel flags", async () => {
	const env = { TMPDIR: "/caller", MAKEFLAGS: "-j8" };
	expect(await projectProcessEnv({ cwd: "ssh://host/work", owner: "one", env }, runtime)).toEqual(env);
	expect(
		await projectProcessEnv({ cwd: path.join(cwd, "missing"), owner: "one", env, options: { mode: "off" } }, runtime),
	).toEqual(env);
});

it("permits two healthy leases, holds capacity until actual release, and aborts waits", async () => {
	for (const owner of ["one", "two"])
		leases.push(
			await prepareProcessResources({ cwd, owner, command: "make", options: { projectTemp: false } }, runtime),
		);
	const controller = new AbortController();
	const waiting = prepareProcessResources(
		{ cwd, owner: "three", command: "make", signal: controller.signal, options: { projectTemp: false } },
		runtime,
	);
	controller.abort(new Error("cancel admission"));
	await expect(waiting).rejects.toThrow("cancel admission");
	await leases[0].release();
	leases.push(
		await prepareProcessResources({ cwd, owner: "three", command: "make", options: { projectTemp: false } }, runtime),
	);
	expect(
		(await fs.readdir(path.join(cwd, "build", "tests", "omp", ".leases"))).filter(name => name.startsWith("lease-")),
	).toHaveLength(2);
});

it("serializes conservative jobs and times out critical builds without blocking diagnostics", async () => {
	leases.push(
		await prepareProcessResources(
			{ cwd, owner: "one", command: "make", options: { mode: "conservative", projectTemp: false } },
			runtime,
		),
	);
	await expect(
		prepareProcessResources(
			{
				cwd,
				owner: "two",
				command: "make",
				options: { mode: "conservative", projectTemp: false, admissionTimeoutMs: 40 },
			},
			runtime,
		),
	).rejects.toThrow("timed out");
	await expect(
		prepareProcessResources(
			{ cwd, owner: "critical", command: "make", options: { projectTemp: false, admissionTimeoutMs: 40 } },
			{ ...runtime, samplePressure: async () => critical },
		),
	).rejects.toThrow("critical memory pressure");
	const diagnostic = await prepareProcessResources(
		{ cwd, owner: "critical", command: "printf diagnostic", options: { projectTemp: false } },
		{ ...runtime, samplePressure: async () => critical },
	);
	expect(diagnostic.command).toBe("printf diagnostic");
	await diagnostic.release();
});

it("prunes stale PID-reused leases without removing project or temp data", async () => {
	const lease = await prepareProcessResources(
		{ cwd, owner: "old", command: "make", options: { projectTemp: false } },
		runtime,
	);
	await lease.release();
	const base = path.join(cwd, "build", "tests", "omp", ".leases");
	const nonce = crypto.randomUUID();
	const stale = path.join(base, `lease-${nonce}`);
	await fs.mkdir(stale, { mode: 0o700 });
	await fs.writeFile(
		path.join(stale, `owner-${nonce}.json`),
		JSON.stringify({ version: 1, owner: "old", nonce, pid: process.pid, start: "old-pid-start" }),
		{ mode: 0o600 },
	);
	const fresh = await prepareProcessResources(
		{ cwd, owner: "new", command: "make", options: { projectTemp: false, maxHeavyJobs: 1 } },
		runtime,
	);
	leases.push(fresh);
	expect(await fs.readdir(base)).not.toContain(`lease-${nonce}`);
	expect(await readProcessStart(process.pid)).toBeTruthy();
});

it("recovers stale lock ownership and leaves incomplete unpublished candidates alone", async () => {
	const first = await prepareProcessResources(
		{ cwd, owner: "one", command: "make", options: { projectTemp: false } },
		runtime,
	);
	await first.release();
	const base = path.join(cwd, "build", "tests", "omp", ".leases");
	const nonce = crypto.randomUUID();
	await fs.mkdir(path.join(base, "lock"), { mode: 0o700 });
	await fs.writeFile(
		path.join(base, "lock", `owner-${nonce}.json`),
		JSON.stringify({ version: 1, owner: "crashed", nonce, pid: process.pid, start: "reused" }),
		{ mode: 0o600 },
	);
	await fs.mkdir(path.join(base, "candidate-unpublished"), { mode: 0o700 });
	leases.push(
		await prepareProcessResources({ cwd, owner: "two", command: "make", options: { projectTemp: false } }, runtime),
	);
	expect(await fs.readdir(base)).toContain("candidate-unpublished");
});

it("reaps only registered released owner resources before pressure sampling", async () => {
	let cleaned = false;
	let foreignCleaned = false;
	const unregister = registerReleasedProcessResource("foreign", {}, async () => {
		foreignCleaned = true;
	});
	registerReleasedProcessResource("one", {}, async () => {
		cleaned = true;
	});
	try {
		leases.push(
			await prepareProcessResources(
				{ cwd, owner: "one", command: "make", options: { projectTemp: false } },
				{
					...runtime,
					samplePressure: async () => {
						expect(cleaned).toBe(true);
						return healthy;
					},
				},
			),
		);
		expect(foreignCleaned).toBe(false);
		expect(await reapReleasedProcessResources("one")).toBe(0);
	} finally {
		unregister();
	}
});

it("surfaces cleanup errors and allows explicit unregister", async () => {
	const unregister = registerReleasedProcessResource("broken", {}, async () => {
		throw new Error("cleanup failed");
	});
	await expect(reapReleasedProcessResources("broken")).rejects.toThrow("cleanup failed");
	unregister();
	expect(await reapReleasedProcessResources("broken")).toBe(0);
});

// This integration crosses independent processes: fake timers cannot drive the
// child's filesystem lock or clock. Poll only the explicit readiness/release markers.
it("coordinates admission with a real independently running process", async () => {
	const modulePath = path.resolve(import.meta.dir, "../../src/exec/process-resources.ts");
	const marker = path.join(cwd, "child-acquired");
	const releaseMarker = path.join(cwd, "release-child");
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { prepareProcessResources } from ${JSON.stringify(modulePath)};
		const lease = await prepareProcessResources({cwd:${JSON.stringify(cwd)},owner:'child',command:'make',options:{mode:'conservative',projectTemp:false}}, {samplePressure:async()=>(${JSON.stringify(healthy)})});
		await Bun.write(${JSON.stringify(marker)}, 'ready');
		while (!(await Bun.file(${JSON.stringify(releaseMarker)}).exists())) await Bun.sleep(20);
		await lease.release();
	`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		const deadline = performance.now() + 4000;
		while (!(await Bun.file(marker).exists()) && performance.now() < deadline) await Bun.sleep(20);
		expect(await Bun.file(marker).exists()).toBe(true);
		await expect(
			prepareProcessResources(
				{
					cwd,
					owner: "parent",
					command: "make",
					options: { mode: "conservative", projectTemp: false, admissionTimeoutMs: 100 },
				},
				runtime,
			),
		).rejects.toThrow("timed out");
		await Bun.write(releaseMarker, "release");
		expect(await child.exited).toBe(0);
		leases.push(
			await prepareProcessResources(
				{ cwd, owner: "parent", command: "make", options: { mode: "conservative", projectTemp: false } },
				runtime,
			),
		);
	} finally {
		child.kill();
		await child.exited;
	}
}, 10_000);
