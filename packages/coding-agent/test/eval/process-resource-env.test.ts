import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "../../src/eval/js/context-manager";
import { WorkerCore } from "../../src/eval/js/worker-core";
import type { WorkerInbound, WorkerOutbound } from "../../src/eval/js/worker-protocol";
import { PythonKernel } from "../../src/eval/py/kernel";
import { cfgProcessResourcesMode } from "../../src/exec/settings";
import type { ToolSession } from "../../src/tools";

const projects: string[] = [];
let restoreFactories: (() => void) | undefined;

async function project(): Promise<string> {
	// A private project on the checkout's filesystem, never the platform's tmpfs.
	const cwd = await fs.mkdtemp(path.join(process.cwd(), ".omp-eval-resources-"));
	projects.push(cwd);
	await fs.mkdir(path.join(cwd, ".git"));
	return cwd;
}

function session(cwd: string, mode: "auto" | "conservative" | "off" = "conservative"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "processResources.mode": mode }),
	};
}

function readyHandle(mode: "process" | "worker", received: WorkerInbound[]): JsEvalWorkerHandle {
	const listeners = new Set<(message: WorkerOutbound) => void>();
	return {
		mode,
		send(message) {
			received.push(message);
			queueMicrotask(() => {
				const reply: WorkerOutbound | undefined =
					message.type === "init"
						? { type: "ready" }
						: message.type === "run"
							? { type: "result", runId: message.runId, ok: true }
							: undefined;
				if (reply) for (const listener of listeners) listener(reply);
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async close() {
			return true;
		},
		async terminate() {
			listeners.clear();
		},
	};
}

async function runJs(cwd: string, key: string, toolSession: ToolSession, code: string): Promise<string> {
	let output = "";
	await executeInVmContext({
		cwd,
		sessionKey: key,
		sessionId: key,
		ownerId: key,
		session: toolSession,
		code,
		filename: "[resource-env].js",
		timeoutMs: 30_000,
		runState: {
			signal: AbortSignal.timeout(30_000),
			onText: chunk => {
				output += chunk;
			},
		},
	});
	return output.trim();
}

async function runPython(kernel: PythonKernel, code: string, env?: Record<string, string>): Promise<string> {
	let output = "";
	const result = await kernel.execute(code, {
		timeoutMs: 15_000,
		env,
		onChunk: chunk => {
			output += chunk;
		},
	});
	expect(result.status).toBe("ok");
	return output.trim();
}

function expectManagedTemp(cwd: string, value: string): void {
	expect(value.startsWith(path.join(cwd, "build", "tests", "omp") + path.sep)).toBe(true);
	expect(path.basename(value)).toBe("tmp");
}

afterEach(async () => {
	restoreFactories?.();
	restoreFactories = undefined;
	await disposeAllVmContexts();
	for (const cwd of projects.splice(0)) await fs.rm(cwd, { recursive: true, force: true });
});

describe("eval process resource environment", () => {
	it("keeps auto fallback available without changing host environment and refuses strict fallback", async () => {
		const cwd = await project();
		const before = { ...process.env };
		let fallbacks = 0;
		restoreFactories = setJsEvalWorkerFactoriesForTests({
			spawnProcess() {
				throw new Error("Subprocess unavailable");
			},
			spawnWorker() {
				fallbacks++;
				return readyHandle("worker", []);
			},
		});
		await runJs(cwd, "fallback-auto", session(cwd, "auto"), "1");
		await expect(runJs(cwd, "fallback-strict", session(cwd), "1")).rejects.toThrow(
			"conservative project-temp policy",
		);
		expect(fallbacks).toBe(1);
		expect(process.env).toEqual(before);
	});

	it("does not apply native process patches in a Worker or inline runtime", async () => {
		const before = process.env.TMPDIR;
		let handler: ((message: WorkerInbound) => void) | undefined;
		const ready = Promise.withResolvers<void>();
		new WorkerCore(
			{
				send(message) {
					if (message.type === "ready") ready.resolve();
				},
				onMessage(callback) {
					handler = callback;
					return () => {
						handler = undefined;
					};
				},
				close() {},
			},
			{ mode: "isolated", interceptUnhandledRejections: () => () => {} },
		);
		try {
			handler?.({
				type: "init",
				snapshot: { cwd: process.cwd(), sessionId: "host-env", processEnv: { TMPDIR: "/must-not-touch-host" } },
			});
			await ready.promise;
			expect(process.env.TMPDIR).toBe(before);
		} finally {
			handler?.({ type: "close" });
		}
	});

	it("real JS subprocess and its child inherit project temp, preserving retained state and owner isolation", async () => {
		const cwd = await project();
		const toolSession = session(cwd);
		// Imports intentionally execute inside the child evaluator, not the host test realm.
		const code = `var os = await import("node:os");
var cp = await import("node:child_process");
var child = JSON.parse(cp.execFileSync(process.execPath, ["-e", 'console.log(JSON.stringify({tmp:require("node:os").tmpdir(),jobs:process.env.CARGO_BUILD_JOBS}))'], {encoding:"utf8"}));
print(JSON.stringify({tmp:os.tmpdir(),child,jobs:process.env.CARGO_BUILD_JOBS}));`;
		const first = JSON.parse(await runJs(cwd, "real-js-a", toolSession, code));
		expectManagedTemp(cwd, first.tmp);
		expect(first.child).toEqual({ tmp: first.tmp, jobs: "1" });
		await runJs(
			cwd,
			"real-js-a",
			toolSession,
			'var retainedResourceValue = 42; process.env.CARGO_BUILD_JOBS = "99";',
		);
		const retained = JSON.parse(
			await runJs(
				cwd,
				"real-js-a",
				toolSession,
				"print(JSON.stringify({value:retainedResourceValue,jobs:process.env.CARGO_BUILD_JOBS,tmp:os.tmpdir()}));",
			),
		);
		expect(retained).toEqual({ value: 42, jobs: "1", tmp: first.tmp });
		const second = JSON.parse(await runJs(cwd, "real-js-b", toolSession, code));
		expect(second.tmp).not.toBe(first.tmp);
		cfgProcessResourcesMode.override(toolSession.settings, "off");
		const restored = JSON.parse(
			await runJs(
				cwd,
				"real-js-a",
				toolSession,
				"print(JSON.stringify({jobs:process.env.CARGO_BUILD_JOBS ?? null,value:retainedResourceValue}));",
			),
		);
		expect(restored).toEqual({ jobs: process.env.CARGO_BUILD_JOBS ?? null, value: 42 });
	}, 60_000);

	it.skipIf(!Bun.which("python3"))(
		"real Python tempfile and child inherit managed temp before caching, with per-cell hints",
		async () => {
			const cwd = await project();
			const settings = session(cwd).settings;
			const kernel = await PythonKernel.start({
				cwd,
				interpreter: Bun.which("python3")!,
				resourceOwner: "real-python-a",
				resourceSettings: settings,
				env: { TMPDIR: "/unmanaged-override", OMP_RESOURCE_SENTINEL: "explicit", CARGO_BUILD_JOBS: "99" },
			});
			try {
				const first = JSON.parse(
					await runPython(
						kernel,
						`import os, tempfile, subprocess, sys, json
child = json.loads(subprocess.check_output([sys.executable, "-c", "import tempfile,os,json; print(json.dumps({'tmp':tempfile.gettempdir(),'jobs':os.environ.get('CARGO_BUILD_JOBS')}))"], text=True))
print(json.dumps({'tmp':tempfile.gettempdir(),'child':child,'sentinel':os.environ.get('OMP_RESOURCE_SENTINEL')}))`,
					),
				);
				expectManagedTemp(cwd, first.tmp);
				expect(first.child).toEqual({ tmp: first.tmp, jobs: "1" });
				expect(first.sentinel).toBe("explicit");
				await runPython(
					kernel,
					'retained_resource_value = 42\nos.environ["CARGO_BUILD_JOBS"] = "99"\nos.environ["TMPDIR"] = "/unmanaged-override"\ntempfile.tempdir = "/unmanaged-override"',
				);
				const retained = JSON.parse(
					await runPython(
						kernel,
						'print(json.dumps({"value":retained_resource_value,"jobs":os.environ["CARGO_BUILD_JOBS"],"tmp":tempfile.gettempdir()}))',
						{ CARGO_BUILD_JOBS: "32" },
					),
				);
				expect(retained).toEqual({ value: 42, jobs: "1", tmp: first.tmp });
				cfgProcessResourcesMode.override(settings, "off");
				expect(await runPython(kernel, 'print(os.environ["CARGO_BUILD_JOBS"])')).toBe("99");
				cfgProcessResourcesMode.override(settings, "conservative");
			} finally {
				await kernel.shutdown();
			}
			const other = await PythonKernel.start({
				cwd,
				interpreter: Bun.which("python3")!,
				resourceOwner: "real-python-b",
				resourceSettings: settings,
			});
			try {
				const tmp = await runPython(other, "import tempfile; print(tempfile.gettempdir())");
				expectManagedTemp(cwd, tmp);
				const ownerDirectories = await fs.readdir(path.join(cwd, "build", "tests", "omp"));
				expect(ownerDirectories.length).toBe(2);
			} finally {
				await other.shutdown();
			}
		},
		60_000,
	);
});
