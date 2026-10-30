// Real-process integration: native shell/socket completion cannot be driven by
// fake timers. File barriers prove child startup; short real waits give a queued
// competing spawn a scheduling opportunity before its cancellation is tested.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { executeBash, releaseShellSessions } from "../../src/exec/bash-executor";
import { DEFAULT_PROCESS_RESOURCE_OPTIONS } from "../../src/exec/process-resources";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

let project = "";
const owner = "resource-integration-owner";
function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
async function until(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("owned fixture did not reach its barrier");
		await Bun.sleep(10);
	}
}
beforeEach(async () => {
	project = await fs.mkdtemp(path.join(process.cwd(), ".omp-process-integration-"));
	await fs.mkdir(path.join(project, ".git"));
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		cwd: project,
		overrides: {
			"processResources.mode": "conservative",
			"processResources.admissionTimeoutMs": 3000,
			"processResources.minAvailableMemoryBytes": 0,
			"processResources.minAvailableMemoryRatio": 0,
			"bash.direnv": "off",
			"shellMinimizer.enabled": false,
		},
	});
});
afterEach(async () => {
	releaseShellSessions(owner);
	resetSettingsForTest();
	await fs.rm(project, { recursive: true, force: true });
});
describe("process resource execution integration", () => {
	it("makes a real child inherit project temp and preserves shell state", async () => {
		const first = await executeBash("OMP_RETAINED=kept", { cwd: project, sessionKey: owner, timeout: 5000 });
		expect(first.exitCode).toBe(0);
		const script =
			"console.log(JSON.stringify({tmp:process.env.TMPDIR,work:process.env.OMP_WORK_DIR,jobs:process.env.CMAKE_BUILD_PARALLEL_LEVEL}))";
		const child = await executeBash(`${quote(process.execPath)} -e ${quote(script)}`, {
			cwd: project,
			sessionKey: owner,
			timeout: 5000,
		});
		expect(child.exitCode).toBe(0);
		const info = JSON.parse(child.output);
		expect(info.tmp.startsWith(path.join(project, "build/tests/omp/"))).toBe(true);
		expect(info.tmp).toBe(path.join(info.work, "tmp"));
		expect(info.jobs).toBe("1");
		const state = await executeBash("printf '%s' \"$OMP_RETAINED\"", {
			cwd: project,
			sessionKey: owner,
			timeout: 5000,
		});
		expect(state.output).toBe("kept");
	}, 15_000);

	it("holds heavy admission through the actual shell child, not merely scheduling", async () => {
		const fixture = path.join(project, "work.py");
		await fs.writeFile(
			fixture,
			"import pathlib,time,sys\np=pathlib.Path(sys.argv[1]);p.write_text('started')\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(.01)\n",
		);
		const release = path.join(project, "release");
		const firstMarker = path.join(project, "first");
		const secondMarker = path.join(project, "second");
		const first = executeBash(`python3 ${quote(fixture)} ${quote(firstMarker)} ${quote(release)}`, {
			cwd: project,
			sessionKey: owner,
			timeout: 5000,
		});
		await until(() => Bun.file(firstMarker).exists());
		const abort = new AbortController();
		const second = executeBash(`python3 ${quote(fixture)} ${quote(secondMarker)} ${quote(release)}`, {
			cwd: project,
			sessionKey: "other-owner",
			signal: abort.signal,
			timeout: 5000,
		});
		const observed = second.catch(error => error);
		await Bun.sleep(50);
		expect(await Bun.file(secondMarker).exists()).toBe(false);
		abort.abort(new Error("cancel queued workload"));
		expect(await observed).toBeInstanceOf(Error);
		await fs.writeFile(release, "go");
		expect((await first).exitCode).toBe(0);
		expect(await Bun.file(secondMarker).exists()).toBe(false);
	}, 15_000);

	it("keeps broker admission until exit and never terminates another owner", async () => {
		const runtimeDir = path.join(project, "broker");
		const client = await createDaemonBrokerClient(project, { runtimeDir });
		const previous = {
			project: process.env[DAEMON_PROJECT_DIR_ENV],
			runtime: process.env[DAEMON_RUNTIME_DIR_ENV],
			title: process.title,
		};
		process.env[DAEMON_PROJECT_DIR_ENV] = project;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		const listening = Promise.withResolvers<void>();
		const broker = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve() });
		if (previous.project === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
		else process.env[DAEMON_PROJECT_DIR_ENV] = previous.project;
		if (previous.runtime === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
		else process.env[DAEMON_RUNTIME_DIR_ENV] = previous.runtime;
		await listening.promise;
		const script = path.join(project, "service.py");
		await fs.writeFile(script, "import os,sys,pathlib\nprint(os.environ['TMPDIR'],flush=True)\ninput()\n");
		const command = `python3 ${quote(script)}`;
		const spec = {
			name: "owned-heavy",
			application: "/bin/sh",
			args: ["-c", command],
			env: {},
			cwd: project,
			pty: false,
			restart: "no" as const,
			persist: false,
			detached: false,
			processResources: {
				command,
				options: {
					...DEFAULT_PROCESS_RESOURCE_OPTIONS,
					mode: "conservative" as const,
					minAvailableMemoryBytes: 0,
					minAvailableMemoryRatio: 0,
				},
			},
		};
		try {
			const started = await client.request({ op: "start", spec, owner });
			expect(started.op).toBe("start");
			const logs = await client.request({
				op: "wait",
				name: spec.name,
				for: "ready",
				pattern: "build/tests/omp",
				timeoutMs: 5000,
			});
			expect(logs.op).toBe("wait");
			const controller = new AbortController();
			const waiting = executeBash(command, {
				cwd: project,
				sessionKey: "unrelated-owner",
				signal: controller.signal,
				timeout: 5000,
			});
			const observed = waiting.catch(error => error);
			await Bun.sleep(40);
			controller.abort();
			expect(await observed).toBeInstanceOf(Error);
			const alive = await client.request({ op: "list" });
			expect(
				alive.op === "list" &&
					alive.daemons.some(daemon => daemon.name === spec.name && daemon.state === "running"),
			).toBe(true);
			await client.request({ op: "send", name: spec.name, data: "done\n" });
			const stopped = await client.request({ op: "wait", name: spec.name, for: "exit", timeoutMs: 5000 });
			expect(stopped.op === "wait" && stopped.daemon.exitCode).toBe(0);
		} finally {
			await client.request({ op: "shutdown" });
			client.close();
			await broker;
			process.title = previous.title;
		}
	}, 20_000);
});
