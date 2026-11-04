# Linux resource queue

Opt-in cooperative admission for multiple OMP CLI processes sharing a Linux
user account. It is not enabled by default and does not change core scheduling,
CPU affinity, cgroups, swap, OOM policy, or the user's desktop.

## Run

Requires Linux `/proc`, Bun's SQLite support, and OMP's exported
`AsyncJobManager` integration. The original deployment was exercised on OMP
18.16.0. Non-Linux systems and multi-root SDK embedding are not supported.

From the repository root:

```sh
omp --extension ./packages/coding-agent/examples/extensions/resource-queue/index.ts
```

For auto-discovery, copy this **whole directory**, including `package.json`,
to `~/.omp/agent/extensions/resource-queue/`. The manifest loads only `index.ts`;
`queue.ts` and `queue.test.ts` are support files. Do not also load another
resource-queue extension or a previous loose-file installation. Finish the old
session normally and start a new OMP process to load changed extension code.
Named profiles require their own explicit installation.

The example retains the original deployment's Turkish status and cancellation
labels. `/resource-queue` describes the policy; `/resource-queue cancel` cancels
pending admission only. It never kills a running job. Existing native job
controls, such as `write proc://<job>/kill`, remain available.

## Admission and lifetime

- One process family owns a slot. Other families wait FIFO in an owner-only
  SQLite database under `$XDG_RUNTIME_DIR/omp-resource-queue/`, falling back to
  `/run/user/<uid>/omp-resource-queue/`. Native execution holds no DB lock.
- A batch and its nested eval/task children reuse that family's slot. OMP
  prepares a whole batch before execution, so a separate exclusive lock for
  each `tool_call` would deadlock before the first command could run.
- Finite Bash/eval/task jobs retain admission after a tool returns a background
  handle. Cancellation does not release it until the actual job promise settles.
  The implementation does not mistake a truncated recent-job list for proof
  of completion. Once the family drains, later work rejoins the FIFO tail.
- Dead owners are pruned using PID plus Linux process start time. Shutdown
  keeps the lease until the CLI process exits rather than releasing before
  native cleanup has begun.
- CPU PSI alone never blocks an otherwise safe first admission. A pressure-only
  CPU veto can leave every session waiting even when no queued work is active.
- Memory guards remain strict: available RAM must be at least
  `max(3 GiB, 25% of MemTotal)`; swap usage of 75% or more additionally requires
  40% available RAM; memory PSI `some avg10` must be below 5%. No timeout bypass
  overrides these guards. PSI measures stalls, not CPU utilization.

Literal one-shot `ps`, `free`, `uptime`, supported `/proc` pressure/memory reads
and `systemctl show` diagnostics bypass admission. Shell composition and
interpreters do not qualify. Filesystem reading and `proc://` inspection/control
are not gated. The existing cancellable selector pauses OMP's handler deadline
and resumes automatically when admitted; Escape cancels the pending request.

## Limits

This is a conservative **family-level** queue, not a per-command resource quota
or preemptive scheduler. Sibling commands and child agents inside an admitted
family can still run in parallel; one oversized build can still exhaust memory.
A continuously busy family can retain admission, and a task awaiting remote
inference retains its family's slot. Existing work is never paused or killed.

Named services reserve startup only. Readiness success, timeout or interruption
can leave a service running without holding a slot; its memory still affects
subsequent admission. User `!` shell commands and tools outside Bash/eval/task,
`xd://` writes and direct Playwright calls are not gated. This is not a sandbox.

Independent headless roots fail closed if they cannot acquire a slot because
they have no supported cancellable waiting UI. Normal headless task children
inherit the parent's already-acquired family slot. `AsyncJobManager.instance()`
is a single-root CLI integration, not a context-scoped API for several roots in
one embedded process. Do not infer support for that topology.

The default queue directory is volatile across boot. A custom persistent DB
passed directly to `ResourceQueue` does not add boot identity to its PID records.
Keep system OOM protection enabled; never test by exhausting host RAM/swap.

## Verification

```sh
bun test ./packages/coding-agent/examples/extensions/resource-queue/queue.test.ts
```

The regression suite uses injected pressure and four lightweight child processes
to cover memory guards, progress under CPU pressure, FIFO handoff, cancelled
waiters and dead owners. It does not create host memory pressure.

The original deployment was additionally exercised through four actual OMP
18.16.0 CLI processes using an offline scripted provider: finite background work,
six-job cancellation settlement, a multi-call batch, nested eval-to-Bash,
headless task-child completion, diagnostics during another family's admission,
and cancelled-waiter removal. A real PTY exercised Escape and automatic resume.
These checks used private profiles and bounded CPU/RAM cgroups; they do not
establish an OOM guarantee, arbitrary-service lifetime tracking, or multi-root
SDK compatibility.

The portable directory in this example also passed its four queue tests
(40 assertions). Copied into two private default-profile extension directories,
its manifest auto-discovery loaded the entrypoint and real OMP 18.16.0 native
Bash jobs completed in `start A, end A, start B, end B` order; A ran in the
background while B waited. That run used a one-CPU, 1 GiB memory cgroup with
swap disabled. Only the relative queue import differs from the original
deployment; the queue implementation and regression suite are byte-identical.

To remove the policy, finish sessions normally and stop loading this directory
(or move it out of the extension discovery directory). Do not delete the live
shared database while other OMP processes are using it.
