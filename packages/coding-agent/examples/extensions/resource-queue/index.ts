import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { AsyncJobManager } from '@oh-my-pi/pi-coding-agent/async/job-manager';
import { ResourceQueue, type QueueState } from './queue';

// Child agents and a tool batch share one process-family lease. A coordinator
// must never wait for a slot held by the very children it is awaiting.
let queue: ResourceQueue | undefined;
let waiters = 0;
let mainContext: ExtensionContext | undefined;
let shuttingDown = false;
const pendingCalls = new Map<string, string>();
const contexts = new Map<string, ExtensionContext>();
const cancellations = new Set<AbortController>();
const unsettled = new Set<Promise<void>>();
let jobs: AsyncJobManager | undefined;

function callKey(ctx: ExtensionContext, id: string, tool: string): string {
  return `${ctx.agent.id}:${id}:${tool}`;
}

function releaseIdle(): void {
  if (!queue) return;
  // The CLI has one root manager. Retain actual promises, not recent snapshot
  // rows: cancellation is reported before the process has finished cleanup.
  for (const job of jobs?.getAllJobs() ?? []) {
    if (!job.ownerId || !contexts.has(job.ownerId) || job.endTime !== undefined || unsettled.has(job.promise)) continue;
    unsettled.add(job.promise);
    void job.promise.finally(() => {
      unsettled.delete(job.promise);
      releaseIdle();
    });
  }
  if (pendingCalls.size || unsettled.size) return;
  contexts.clear();
  // Waiting requests retain their FIFO position, not an execution slot.
  if (!waiters) queue.release();
}

function diagnostic(command: unknown): boolean {
  // Only literal, short read-only commands. Shell composition and interpreters
  // are not a diagnostic escape hatch; proc:// cancellation remains ungated.
  if (typeof command !== 'string' || !/^[a-zA-Z0-9_ /.,:%=+\-]+$/.test(command)) return false;
  const [program, ...args] = command.trim().split(/\s+/);
  const name = program.replace(/^\/(?:usr\/)?bin\//, '');
  if (name === 'ps' || name === 'uptime') return true;
  if (name === 'free') return args.every(arg => /^(-[bkmghwltv]|--(?:bytes|kibi|mebi|gibi|human|wide|lohi|total|version))$/.test(arg));
  if (name === 'cat') return args.length > 0 && args.every(arg => /^\/proc\/(meminfo|loadavg|pressure\/(cpu|memory|io))$/.test(arg));
  if (name === 'systemctl') {
    const rest = args[0] === '--user' ? args.slice(1) : args;
    return rest[0] === 'show' && rest.slice(1).every(arg => /^(--property=[\w,]+|-[pP]|[\w.@,-]+)$/.test(arg));
  }
  return false;
}

function finish(ctx: ExtensionContext, id: string, tool: string): void {
  pendingCalls.delete(callKey(ctx, id, tool));
  releaseIdle();
}

export default function resourceQueue(pi: ExtensionAPI) {
  let timer: Timer | undefined;

  pi.on('session_start', (_event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    queue ??= new ResourceQueue();
    jobs = AsyncJobManager.instance();
    mainContext = ctx;
    shuttingDown = false;
    timer = ctx.setInterval(() => {
      releaseIdle();
      if (!waiters) ctx.ui.setStatus('resource-queue', undefined);
    }, 250);
  });

  pi.on('tool_call', async (event, ctx) => {
    if (shuttingDown) return { block: true, reason: 'OMP kapanıyor; yeni işlem başlatılmadı.' };
    const nativeWork = event.toolName === 'bash' || event.toolName === 'eval' || event.toolName === 'task';
    const devicePath = event.toolName === 'write' && typeof event.input.path === 'string' ? event.input.path : '';
    const deviceWork = devicePath.startsWith('xd://');
    const mcpWork = event.toolName.startsWith('mcp__playwright_');
    if (!nativeWork && !deviceWork && !mcpWork) return;
    if (event.toolName === 'bash' && !event.input.name && !event.input.async && diagnostic(event.input.command)) return;
    if (!jobs) return { block: true, reason: 'Kaynak kuyruğu OMP iş yöneticisine bağlanamadı; yeni işlem başlatılmadı' };
    // The legacy singleton must not account for an unrelated embedded root.
    const snapshot = ctx.getAsyncJobSnapshot();
    if (snapshot?.running.some(job => jobs?.getJob(job.id)?.startTime !== job.startTime)) {
      return { block: true, reason: 'Kaynak kuyruğu farklı bir OMP kökü gördü; ayrı CLI süreci kullanın' };
    }
    queue ??= new ResourceQueue();
    releaseIdle();
    const lease = queue;
    const key = callKey(ctx, event.toolCallId, event.toolName);
    contexts.set(ctx.agent.id, ctx);
    let state: QueueState;
    try {
      state = lease.poll();
    } catch (error) {
      releaseIdle();
      return { block: true, reason: `Kaynak kuyruğu okunamadı; işlem başlatılmadı: ${String(error)}` };
    }
    if (state.admitted) {
      pendingCalls.set(key, event.toolName);
      return;
    }
    if (!ctx.hasUI) {
      releaseIdle();
      return { block: true, reason: `${state.reason}. Kaynak kuyruğu bekleme ekranı için OMP'yi etkileşimli açın.` };
    }

    const controller = new AbortController();
    cancellations.add(controller);
    waiters++;
    let admitted = false;
    let failed: string | undefined;
    let completed = false;
    const poll = ctx.setInterval(() => {
      if (completed || controller.signal.aborted || admitted || shuttingDown) return;
      try {
        const next = lease.poll();
        (mainContext ?? ctx).ui.setStatus('resource-queue', `Sıra ${next.position} · ${next.reason || 'Başlıyor'}`);
        if (next.admitted) {
          admitted = true;
          contexts.set(ctx.agent.id, ctx);
          pendingCalls.set(key, event.toolName);
          controller.abort();
        }
      } catch (error) {
        failed = String(error);
        controller.abort();
      }
    }, 250);
    try {
      // A real cancellable dialog pauses OMP's 30s handler deadline. No native
      // tool is replaced, so approval, scheduling, xdev and renderers stay native.
      await ctx.ui.select(
        `Sırada (${state.position}) · ${state.reason}`,
        ['Bu işlemi iptal et'],
        { signal: controller.signal, helpText: 'Çalışan işlem bitince otomatik başlar. Esc: iptal. Teşhis ve proc:// iptal yolu açık.' },
      );
      if (!admitted) return { block: true, reason: failed ? `Kaynak kuyruğu hatası: ${failed}` : 'Kuyruktaki işlem kullanıcı tarafından iptal edildi.' };
    } catch (error) {
      if (!admitted) return { block: true, reason: `Kaynak beklemesi iptal edildi: ${String(error)}` };
    } finally {
      completed = true;
      ctx.clearTimer(poll);
      cancellations.delete(controller);
      waiters--;
      if (!shuttingDown) releaseIdle();
      (mainContext ?? ctx).ui.setStatus('resource-queue', undefined);
    }
  });

  pi.on('tool_execution_end', (event, ctx) => {
    finish(ctx, event.toolCallId, event.toolName);
  });

  pi.on('tool_result', (event, ctx) => {
    finish(ctx, event.toolCallId, event.toolName);
  });

  pi.on('agent_end', (_event, ctx) => {
    // An approval denial or interrupted batch can skip tool_execution_end.
    for (const key of pendingCalls.keys()) if (key.startsWith(`${ctx.agent.id}:`)) pendingCalls.delete(key);
    releaseIdle();
  });

  pi.on('tool_approval_resolved', event => {
    if (event.approved) return;
    for (const key of pendingCalls.keys()) if (key.includes(`:${event.toolCallId}:`)) pendingCalls.delete(key);
    releaseIdle();
  });

  pi.on('session_switch', (_event, ctx) => {
    for (const key of pendingCalls.keys()) if (key.startsWith(`${ctx.agent.id}:`)) pendingCalls.delete(key);
    releaseIdle();
  });

  pi.registerCommand('resource-queue', {
    description: 'Ortak kaynak kuyruğunu göster; cancel ile bekleyen işlemi iptal et',
    handler: async (args, ctx) => {
      if (args.trim() === 'cancel') {
        for (const controller of cancellations) controller.abort();
        ctx.ui.notify('Bekleyen kaynak istekleri iptal edildi; çalışan işler durdurulmadı.', 'info');
      } else {
        ctx.ui.notify(waiters ? 'Sıradaki işlem otomatik başlayacak; /resource-queue cancel yalnız bekleyenleri iptal eder.' : 'Yerel işler oturum aileleri arasında FIFO sırayla çalışır. Arka plan işleri bitene kadar sıra korunur; CPU yoğunluğu boş kuyruğu durdurmaz.', 'info');
      }
    },
  });

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.agent.kind !== 'main') return;
    shuttingDown = true;
    for (const controller of cancellations) controller.abort();
    if (timer) ctx.clearTimer(timer);
    // Shutdown precedes native job cancellation. Other processes prune this
    // lease only after our PID exits, not while children are still unwinding.
    queue?.close({ release: false });
    pendingCalls.clear();
    contexts.clear();
    jobs = undefined;
    queue = undefined;
    mainContext = undefined;
  });
}
