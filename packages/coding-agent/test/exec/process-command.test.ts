import { expect, it } from "bun:test";
import { applyProcessCommandPolicy } from "../../src/exec/process-command";

it.each([
	["make -j8 target", "make -j1 target"],
	["ninja -j 8", "ninja -j 1"],
	["cargo test --jobs=8", "cargo test --jobs=1"],
	["cmake --build 'build path'", "cmake --build 'build path' --parallel 1"],
	["cmake --build build --parallel 8", "cmake --build build --parallel 1"],
	["ctest --parallel 8", "ctest --parallel 1"],
	["go test -p=8 ./pkg", "go test -p=1 ./pkg"],
	["go build ./cmd", "go build -p=1 ./cmd"],
	["pytest -n auto", "pytest -n 1"],
	["pytest tests", "pytest tests"],
	["bun test --max-concurrency=8", "bun test --max-concurrency=1"],
	["cargo test -- --test-threads=8", "cargo test -j1 -- --test-threads=1"],
	["cargo test --jobs 8 -- --test-threads 8", "cargo test --jobs 1 -- --test-threads 1"],
	["cargo test -- --test-threads=8 --test-threads 16", "cargo test -j1 -- --test-threads=1 --test-threads 1"],
	["cargo test 'a test' -- '--test-threads=8' --nocapture", "cargo test 'a test' -j1 -- --test-threads=1 --nocapture"],
	[
		"cargo test -- '--test-threads' '8' --skip 'another test'",
		"cargo test -j1 -- '--test-threads' 1 --skip 'another test'",
	],
	["cargo test -- --test-threads=1 -- --test-threads=8", "cargo test -j1 -- --test-threads=1 -- --test-threads=8"],
	["cargo test -- -- --test-threads 8", "cargo test -j1 -- -- --test-threads 8"],
	["cargo test -- --test-threads -- --test-threads=8", "cargo test -j1 -- --test-threads -- --test-threads=8"],
	[
		"cargo test -- --test-threads=unknown --unknown 'literal value'",
		"cargo test -j1 -- --test-threads=unknown --unknown 'literal value'",
	],
	["cargo test -- --test-threads unknown", "cargo test -j1 -- --test-threads unknown"],
	["cargo test -- --test-threads", "cargo test -j1 -- --test-threads"],
	["cargo build -- --test-threads=8", "cargo build -j1 -- --test-threads=8"],
	["make --jobs target", "make --jobs=1 target"],
	["ctest --parallel --verbose", "ctest --parallel=1 --verbose"],
	["jest --maxWorkers 'a test'", "jest  'a test' --runInBand"],
	["jest -w 50% 'a test'", "jest   'a test' --runInBand"],
	["jest -- --runInBand", "jest --runInBand -- --runInBand"],
	[
		"cargo test -- --test-threads=8 && cargo test -- --test-threads 4",
		"cargo test -j1 -- --test-threads=1 && cargo test -j1 -- --test-threads 1",
	],
	[
		"cargo test -- --skip '--test-threads=8' --test-threads=4",
		"cargo test -j1 -- --skip '--test-threads=8' --test-threads=1",
	],
	["cargo test -- --skip -- --test-threads=8", "cargo test -j1 -- --skip -- --test-threads=8"],
	["vitest run --maxWorkers 'a test'", "vitest run --maxWorkers=1 'a test' --minWorkers=1 --no-file-parallelism"],
	["bun test --max-concurrency 'a test'", "bun test --max-concurrency=1 'a test'"],
	["make -j8 && ninja -j8", "make -j1 && ninja -j1"],
])("reduces only known flags: %s", (command, expected) => {
	expect(applyProcessCommandPolicy(command, true).command).toBe(expected);
	expect(applyProcessCommandPolicy(command, false).command).toBe(command);
});

it.each([
	"make -j$JOBS",
	"make -j8; ninja -j8",
	"make -j8 | tee log",
	"make >build.log",
	"echo $(make -j8)",
	"cat <<EOF\nmake -j8\nEOF",
	"for x in a; do make; done",
	"JOBS=8 make -j8",
	"bash -c 'make -j8'",
	"make *.o",
	"cargo test -- --test-threads=$THREADS",
	'cargo test -- --test-threads "$THREADS"',
	"cargo test -- --test-threads=$(nproc)",
	"cargo test -- --test-threads=8; echo done",
	"bash -c 'cargo test -- --test-threads=8'",
	"npm run test -- --test-threads=8",
])("leaves unsupported shell syntax untouched: %s", command => {
	expect(applyProcessCommandPolicy(command, true).command).toBe(command);
});

it("does not classify quoted diagnostic text as heavy", () => {
	expect(applyProcessCommandPolicy("echo 'make -j8'", true).heavy).toBe(false);
	expect(applyProcessCommandPolicy("printf '%s' 'cargo test'", true).heavy).toBe(false);
	expect(applyProcessCommandPolicy("make --help", true).heavy).toBe(false);
});

it("still admits recognizable nonliteral and opaque heavy commands", () => {
	expect(applyProcessCommandPolicy("make -j8; ninja", true).heavy).toBe(true);
	const opaque = applyProcessCommandPolicy("npm run build", true);
	expect(opaque.command).toBe("npm run build");
	expect(opaque.heavy).toBe(true);
});

it("removes Jest maxWorkers before selecting runInBand", () => {
	const command = applyProcessCommandPolicy("jest --maxWorkers=8 'a test'", true).command;
	expect(command).not.toContain("maxWorkers");
	expect(command).toContain("--runInBand");
	expect(command).toContain("'a test'");
});

it("sets Vitest bounds and disables file-level parallelism", () => {
	const command = applyProcessCommandPolicy("vitest run --maxWorkers 8", true).command;
	expect(command).toContain("--maxWorkers 1");
	expect(command).toContain("--minWorkers=1");
	expect(command).toContain("--no-file-parallelism");
});
