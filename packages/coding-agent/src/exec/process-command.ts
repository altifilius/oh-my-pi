import * as path from "node:path";
import { extractLiteralAndChainSegments, lexShellCommand, tokenizeShellSegments } from "../tools/shell-tokenize";

export interface ProcessCommandPolicy {
	command: string;
	heavy: boolean;
	notices: string[];
}

type CommandKind =
	| "make"
	| "ninja"
	| "cmake"
	| "cargo"
	| "ctest"
	| "go"
	| "pytest"
	| "jest"
	| "vitest"
	| "bun"
	| "opaque";

function commandKind(argv: string[]): CommandKind | undefined {
	if (!argv[0]) return undefined;
	const name = path.basename(argv[0]);
	if (argv.includes("--help") || argv.includes("--version")) return undefined;
	if (name === "make" || name === "gmake") return "make";
	if (name === "ninja" || name === "ctest") return name;
	if (name === "cmake" && argv[1] === "--build") return "cmake";
	if (name === "cargo" && ["build", "test", "check", "clippy", "bench", "install"].includes(argv[1])) return "cargo";
	if (name === "go" && ["build", "test", "install"].includes(argv[1])) return "go";
	if (name === "pytest" || name === "py.test") return "pytest";
	if ((name === "python" || name === "python3") && argv[1] === "-m" && argv[2] === "pytest") return "pytest";
	if (name === "jest" || name === "vitest") return name;
	if (name === "bun" && argv[1] === "test") return "bun";
	if (["tsc", "webpack", "rollup", "rustc"].includes(name)) return "opaque";
	if (["bun", "npm", "pnpm", "yarn", "npx", "uv"].includes(name)) {
		const action = argv[1] === "run" || argv[1] === "exec" ? argv[2] : argv[1];
		if (action && /(?:^|:)(?:build|test|check|lint|typecheck|compile|bench|install)(?:$|:)/.test(action))
			return "opaque";
		if (argv[1] === "run" || name === "npx" || argv[1] === "exec") return "opaque";
	}
	if (/\.(?:sh|py|js|mjs|cjs|ts)$/.test(name)) return "opaque";
	if (["python", "python3", "node", "bash", "sh"].includes(name) && argv[1] && !argv[1].startsWith("-"))
		return "opaque";
	return undefined;
}

/** Only literal argv is rewritten. Unsupported shell syntax remains byte-for-byte intact. */
export function applyProcessCommandPolicy(command: string, constrained: boolean): ProcessCommandPolicy {
	// The existing strict parser requires an && chain; a literal sentinel validates
	// single commands too without adding a second shell parser.
	const parsed = extractLiteralAndChainSegments(`${command} && omp-resource-policy-sentinel`);
	if (!parsed) {
		return {
			command,
			heavy: tokenizeShellSegments(command).some(argv => commandKind(argv) !== undefined),
			notices: constrained
				? [
						"Shell syntax is not a literal command; parallel environment hints cannot enforce its child concurrency.",
					]
				: [],
		};
	}
	const segments = parsed.slice(0, -1);
	const kinds = segments.map(segment => commandKind(segment.argv));
	const heavy = kinds.some(Boolean);
	if (!constrained || !heavy) return { command, heavy, notices: [] };
	const tokens = lexShellCommand(command);
	let segmentIndex = 0;
	const segmentWords: number[][] = segments.map(() => []);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.kind === "separator" && token.raw.includes("&&")) segmentIndex++;
		else if (token.kind === "word") segmentWords[segmentIndex].push(index);
	}
	const notices: string[] = [];
	for (let index = 0; index < segments.length; index++) {
		const kind = kinds[index];
		if (!kind) continue;
		const argv = segments[index].argv;
		if (kind === "opaque") {
			notices.push(
				"Opaque build/test command: parallel environment hints are advisory; child flags cannot be enforced.",
			);
			continue;
		}
		const words = segmentWords[index];
		const short =
			kind === "go"
				? "-p"
				: kind === "pytest"
					? "-n"
					: ["make", "ninja", "cmake", "cargo", "ctest"].includes(kind)
						? "-j"
						: undefined;
		const longs =
			kind === "make" || kind === "cargo"
				? ["--jobs"]
				: kind === "cmake" || kind === "ctest"
					? ["--parallel"]
					: kind === "pytest"
						? ["--numprocesses"]
						: kind === "jest"
							? ["--maxWorkers", "--maxConcurrency"]
							: kind === "vitest"
								? ["--maxWorkers", "--minWorkers", "--maxConcurrency"]
								: kind === "bun"
									? ["--max-concurrency"]
									: [];
		const start = ["cmake", "cargo", "go", "bun"].includes(kind) ? 2 : kind === "pytest" && argv[1] === "-m" ? 3 : 1;
		const boundary = argv.indexOf("--", start);
		const end = boundary < 0 ? argv.length : boundary;
		let found = false;
		for (let arg = start; arg < end; arg++) {
			const value = argv[arg];
			const exact = value === short || longs.includes(value) || (kind === "jest" && value === "-w");
			const attached =
				(short !== undefined && new RegExp(`^${short}(?:=)?(?:\\d+|auto|logical)$`).test(value)) ||
				longs.some(flag => value.startsWith(`${flag}=`)) ||
				(kind === "jest" && /^-w\d+$/.test(value));
			if (!exact && !attached) continue;
			found = true;
			if (kind === "jest" && (value === "-w" || value.startsWith("--maxWorkers") || /^-w\d+$/.test(value))) {
				// Jest rejects maxWorkers together with runInBand.
				tokens[words[arg]].raw = "";
				if (exact && arg + 1 < end && /^(?:\d+(?:%)?|auto|logical)$/.test(argv[arg + 1]))
					tokens[words[++arg]].raw = "";
			} else if (exact) {
				if (arg + 1 < end && /^(?:\d+(?:%)?|auto|logical)$/.test(argv[arg + 1])) tokens[words[++arg]].raw = "1";
				else tokens[words[arg]].raw = longs.includes(value) ? `${value}=1` : `${value} 1`;
			} else {
				tokens[words[arg]].raw = value.includes("=")
					? `${value.slice(0, value.indexOf("="))}=1`
					: `${short ?? "-w"}1`;
			}
		}
		if (kind === "cargo" && argv[1] === "test" && boundary >= 0) {
			// Cargo's first separator begins libtest argv; a second separator makes
			// subsequent words test filters, not libtest options. Explicit worker
			// flags override RUST_TEST_THREADS, so constrain every literal count.
			for (let arg = boundary + 1; arg < argv.length && argv[arg] !== "--"; arg++) {
				if (/^--test-threads=\d+$/.test(argv[arg])) tokens[words[arg]].raw = "--test-threads=1";
				else if (argv[arg] === "--test-threads" && arg + 1 < argv.length && /^\d+$/.test(argv[arg + 1])) {
					tokens[words[++arg]].raw = "1";
				} else if (
					["--skip", "--format", "--color", "--logfile", "--shuffle-seed", "-Z"].includes(argv[arg]) &&
					argv[arg + 1] !== "--"
				) {
					arg++;
				}
			}
		}
		let addition = "";
		if (["make", "ninja", "cargo", "ctest"].includes(kind) && !found) addition = "-j1";
		if (kind === "cmake" && !found) addition = "--parallel 1";
		if (kind === "go" && !found) addition = "-p=1";
		if (kind === "jest" && !argv.slice(start, end).some(value => value === "--runInBand" || value === "-i"))
			addition = "--runInBand";
		if (kind === "vitest") {
			const flags = argv.slice(start, end);
			addition = [
				flags.some(value => value === "--maxWorkers" || value.startsWith("--maxWorkers=")) ? "" : "--maxWorkers=1",
				flags.some(value => value === "--minWorkers" || value.startsWith("--minWorkers=")) ? "" : "--minWorkers=1",
				"--no-file-parallelism",
			]
				.filter(Boolean)
				.join(" ");
		}
		if (kind === "bun" && !found) addition = "--max-concurrency=1";
		// pytest without xdist is already serial: never require an optional plugin.
		if (addition) {
			if (kind === "go") tokens[words[1]].raw += ` ${addition}`;
			else if (boundary >= 0) tokens[words[boundary]].raw = `${addition} ${tokens[words[boundary]].raw}`;
			else tokens[words.at(-1)!].raw += ` ${addition}`;
		}
	}
	const rewritten = tokens.map(token => token.raw).join("");
	if (rewritten !== command) notices.push("Memory pressure: recognized build/test parallelism reduced to one worker.");
	return { command: rewritten, heavy, notices };
}
