import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sleepLong } from "@oh-my-pi/pi-utils";
import { ownerPrivateDirError } from "../utils/owner-private-dir";

export interface ResourceIdentity {
	version: 1;
	owner: string;
	nonce: string;
	pid: number;
	start: string;
}

export interface ResourceFileRuntime {
	platform?: NodeJS.Platform;
	readProcessStart?: (pid: number) => Promise<string | null>;
	filesystemType?: (directory: string) => Promise<number>;
}

/** Linux starttime is field 22; comm can contain spaces and closing parentheses. */
export async function readProcessStart(pid: number): Promise<string | null> {
	try {
		if (process.platform !== "linux") {
			process.kill(pid, 0);
			return "portable-live";
		}
		const text = await Bun.file(`/proc/${pid}/stat`).text();
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z" || fields[0] === "X") return null;
		if (!/^\d+$/.test(fields[19] ?? "")) throw new Error(`Cannot read process start identity for ${pid}`);
		return fields[19];
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ESRCH") return null;
		throw error;
	}
}

export async function resourceOwnerHash(owner: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
	return Buffer.from(bytes).toString("hex").slice(0, 32);
}

async function checkedDirectory(directory: string, privateLeaf: boolean, create: boolean): Promise<void> {
	if (create) {
		try {
			await fs.mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const stat = await fs.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new Error(`Process resource directory ${directory} is a symlink or not a directory`);
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
	try {
		const pinned = await handle.stat();
		if (pinned.dev !== stat.dev || pinned.ino !== stat.ino)
			throw new Error(`Process resource directory changed: ${directory}`);
		if (privateLeaf && process.platform !== "win32") {
			const reason = ownerPrivateDirError(
				{ isSymlink: false, isDir: pinned.isDirectory(), uid: pinned.uid, mode: pinned.mode },
				process.getuid?.(),
			);
			if (reason) throw new Error(`Process resource directory ${directory} ${reason}`);
		}
	} finally {
		await handle.close();
	}
}

export async function projectResourceDirectory(cwd: string): Promise<string> {
	// Canonicalize the anchor only; the shell retains its caller's logical PWD.
	// Managed descendants below this root still reject symlinks.
	const resolved = await fs.realpath(cwd);
	let cursor = path.parse(resolved).root;
	for (const component of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, component);
		await checkedDirectory(cursor, false, false);
	}
	let project = resolved;
	cursor = resolved;
	const home = path.resolve(os.homedir());
	while (true) {
		try {
			const git = await fs.lstat(path.join(cursor, ".git"));
			if (!git.isSymbolicLink() && (git.isDirectory() || git.isFile())) {
				project = cursor;
				break;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(cursor);
		if (cursor === home || parent === cursor || parent === home || parent === path.parse(cursor).root) break;
		cursor = parent;
	}
	for (const component of ["build", "tests", "omp"]) {
		project = path.join(project, component);
		await checkedDirectory(project, component === "omp", true);
	}
	return project;
}

export async function projectTempDirectory(base: string, owner: string, runtime: ResourceFileRuntime): Promise<string> {
	const ownerDirectory = path.join(base, await resourceOwnerHash(owner));
	await checkedDirectory(ownerDirectory, true, true);
	const temporary = path.join(ownerDirectory, "tmp");
	await checkedDirectory(temporary, true, true);
	if ((runtime.platform ?? process.platform) === "linux") {
		const type = runtime.filesystemType ? await runtime.filesystemType(temporary) : (await fs.statfs(temporary)).type;
		if (type === 0x01021994 || type === 0x858458f6 || type === -2054924042)
			throw new Error(
				`Project temporary directory ${temporary} is on tmpfs/ramfs; disk-backed project storage is required`,
			);
	}
	// A write probe catches ACLs/read-only mounts too; never chmod a pre-existing path.
	const probe = path.join(temporary, `.omp-write-${crypto.randomUUID()}`);
	const handle = await fs.open(
		probe,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	await handle.close();
	await fs.unlink(probe);
	return temporary;
}

async function readIdentity(directory: string): Promise<ResourceIdentity | undefined> {
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (entries.length === 0) return undefined;
	if (entries.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(entries[0]))
		throw new Error(`Unexpected files in process lease directory ${directory}`);
	const filename = path.join(directory, entries[0]);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.size > 4096 ||
			(process.getuid && stat.uid !== process.getuid()) ||
			(stat.mode & 0o077) !== 0
		)
			throw new Error(`Unsafe process resource identity: ${filename}`);
		const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const value = parsed as Partial<ResourceIdentity>;
		if (
			value.version !== 1 ||
			typeof value.owner !== "string" ||
			typeof value.nonce !== "string" ||
			!/^[0-9a-f-]{36}$/.test(value.nonce) ||
			!Number.isSafeInteger(value.pid) ||
			(value.pid ?? 0) <= 0 ||
			typeof value.start !== "string"
		)
			return undefined;
		if (entries[0] !== `owner-${value.nonce}.json`) throw new Error(`Process lease nonce mismatch: ${directory}`);
		return value as ResourceIdentity;
	} finally {
		await handle.close();
	}
}

async function writeIdentity(directory: string, identity: ResourceIdentity): Promise<void> {
	const handle = await fs.open(
		path.join(directory, `owner-${identity.nonce}.json`),
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(JSON.stringify(identity));
	} finally {
		await handle.close();
	}
}

async function removeIdentityDirectory(directory: string, expected: ResourceIdentity): Promise<boolean> {
	const current = await readIdentity(directory);
	if (
		!current ||
		current.nonce !== expected.nonce ||
		current.owner !== expected.owner ||
		current.pid !== expected.pid ||
		current.start !== expected.start
	)
		return false;
	// Unlink a nonce-specific name: a racing stale reaper can never unlink the
	// identity of a newly published lock. rmdir cannot remove its populated tree.
	try {
		await fs.unlink(path.join(directory, `owner-${expected.nonce}.json`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		await fs.rmdir(directory);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	return true;
}

/** Cooperative per-project admission, not a kernel limit on descendants or other tools. */
export class ProjectResourceGate {
	#directory: string;
	#identity: ResourceIdentity;
	#readStart: (pid: number) => Promise<string | null>;

	constructor(directory: string, identity: ResourceIdentity, runtime: ResourceFileRuntime) {
		this.#directory = path.join(directory, ".leases");
		this.#identity = identity;
		this.#readStart = runtime.readProcessStart ?? readProcessStart;
	}

	async initialize(): Promise<void> {
		await checkedDirectory(this.#directory, true, true);
	}

	async #withLock<T>(deadline: number, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
		const candidate = path.join(this.#directory, `candidate-${this.#identity.pid}-${this.#identity.nonce}`);
		const lock = path.join(this.#directory, "lock");
		await fs.mkdir(candidate, { mode: 0o700 });
		try {
			await writeIdentity(candidate, this.#identity);
		} catch (error) {
			await fs.unlink(path.join(candidate, `owner-${this.#identity.nonce}.json`)).catch(() => {});
			await fs.rmdir(candidate).catch(() => {});
			throw error;
		}
		let locked = false;
		try {
			while (!locked) {
				signal?.throwIfAborted();
				if (performance.now() >= deadline)
					throw new Error("Process resource admission timed out waiting for the project lease lock");
				try {
					// A populated directory is published atomically. Unlike mkdir + write,
					// there is no unowned empty-lock window after a process crash.
					await fs.rename(candidate, lock);
					locked = true;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
					await checkedDirectory(lock, true, false).catch(error => {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					});
					const owner = await readIdentity(lock);
					if (owner && (await this.#readStart(owner.pid)) !== owner.start) {
						await removeIdentityDirectory(lock, owner);
					}
					await sleepLong(Math.min(75, Math.max(1, deadline - performance.now())), signal);
				}
			}
			return await action();
		} finally {
			await removeIdentityDirectory(locked ? lock : candidate, this.#identity);
		}
	}

	async tryAcquire(limit: number, deadline: number, signal?: AbortSignal): Promise<(() => Promise<void>) | undefined> {
		return this.#withLock(deadline, signal, async () => {
			let count = 0;
			for (const entry of await fs.readdir(this.#directory, { withFileTypes: true })) {
				if (!entry.name.startsWith("lease-") || !entry.isDirectory()) continue;
				const directory = path.join(this.#directory, entry.name);
				await checkedDirectory(directory, true, false);
				const owner = await readIdentity(directory);
				if (!owner) throw new Error(`Unrecognized process resource lease ${directory}`);
				if ((await this.#readStart(owner.pid)) !== owner.start) await removeIdentityDirectory(directory, owner);
				else if (entry.name.startsWith("lease-")) count++;
			}
			if (count >= limit) return undefined;
			signal?.throwIfAborted();
			const lease = path.join(this.#directory, `lease-${this.#identity.nonce}`);
			const staging = path.join(this.#directory, `pending-${this.#identity.nonce}`);
			await fs.mkdir(staging, { mode: 0o700 });
			try {
				await writeIdentity(staging, this.#identity);
				await fs.rename(staging, lease);
			} catch (error) {
				await fs.unlink(path.join(staging, `owner-${this.#identity.nonce}.json`)).catch(() => {});
				await fs.rmdir(staging).catch(() => {});
				throw error;
			}
			let release: Promise<void> | undefined;
			return () => {
				release ??= this.#withLock(performance.now() + 30_000, undefined, async () => {
					await removeIdentityDirectory(lease, this.#identity);
				}).catch(error => {
					release = undefined;
					throw error;
				});
				return release;
			};
		});
	}
}
