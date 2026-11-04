import { expect, test } from 'bun:test';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResourceQueue, type Pressure } from './queue';

const healthy: Pressure = { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, swapUsedRatio: 0.1, cpuBusy: 0, memoryStall: 0 };

test('memory and swap guards hold the queue until resources recover', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omp-queue-test-'));
  const queue = new ResourceQueue(join(directory, 'queue.sqlite'));
  try {
    for (const pressure of [
      { ...healthy, available: 3 * 1024 ** 3 },
      { ...healthy, available: 5 * 1024 ** 3, swapUsedRatio: 0.8 },
      { ...healthy, memoryStall: 6 },
    ]) {
      expect(queue.poll(pressure).admitted).toBe(false);
      expect(queue.poll(healthy).admitted).toBe(true);
      queue.release();
    }
  } finally {
    queue.close();
    rmSync(directory, { recursive: true });
  }
});

test('an admitted family can finish dependencies, then its next operation rechecks memory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omp-queue-test-'));
  const queue = new ResourceQueue(join(directory, 'queue.sqlite'));
  try {
    expect(queue.poll(healthy).admitted).toBe(true);
    expect(queue.poll({ ...healthy, available: 0 }).admitted).toBe(true);
    queue.release();
    expect(queue.poll({ ...healthy, available: 0 }).admitted).toBe(false);
    expect(queue.poll(healthy).admitted).toBe(true);
  } finally {
    queue.close();
    rmSync(directory, { recursive: true });
  }
});

test('CPU pressure alone cannot strand the only waiting family', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omp-queue-test-'));
  const queue = new ResourceQueue(join(directory, 'queue.sqlite'));
  try {
    expect(queue.poll({ ...healthy, cpuBusy: 99 }).admitted).toBe(true);
  } finally {
    queue.close();
    rmSync(directory, { recursive: true });
  }
});

test('four live families hand off FIFO without overlap, cancellation and dead owners cannot block the head', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omp-queue-test-'));
  const path = join(directory, 'queue.sqlite');
  const script = `import {ResourceQueue} from ${JSON.stringify(join(import.meta.dir, 'queue.ts'))}; import {createInterface} from 'node:readline'; const q=new ResourceQueue(process.env.QUEUE_DB); createInterface({input:process.stdin}).on('line',command=>{ if(command.startsWith('{'))console.log(JSON.stringify(q.poll(JSON.parse(command)))); if(command==='release'){q.release();console.log('released');} }); console.log('ready');`;
  const workers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, QUEUE_DB: path }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }));
  const lines = workers.map(worker => createInterface({ input: Readable.fromWeb(worker.stdout) })[Symbol.asyncIterator]());
  const receive = async (index: number) => {
    const result = await lines[index].next();
    if (result.done) throw new Error(`Queue worker ${index} exited before replying`);
    return result.value;
  };
  const poll = async (index: number, pressure = healthy) => {
    workers[index].stdin.write(`${JSON.stringify(pressure)}\n`);
    const state: unknown = JSON.parse(await receive(index));
    if (!state || typeof state !== 'object' || !('position' in state) || typeof state.position !== 'number'
        || !('admitted' in state) || typeof state.admitted !== 'boolean') throw new Error('Invalid queue worker response');
    return state;
  };
  try {
    for (let index = 0; index < workers.length; index++) expect(await receive(index)).toBe('ready');
    const busyCPU = { ...healthy, cpuBusy: 95 };
    expect((await poll(0, busyCPU)).admitted).toBe(true);
    for (let index = 1; index < workers.length; index++) {
      const state = await poll(index, busyCPU);
      expect(state.admitted).toBe(false);
      expect(state.position).toBe(index + 1);
    }
    // A healthy sample never launches a second family behind the active one.
    expect((await poll(1)).admitted).toBe(false);
    for (let index = 0; index < workers.length; index++) {
      workers[index].stdin.write('release\n');
      expect(await receive(index)).toBe('released');
      if (index + 1 < workers.length) {
        expect((await poll(index + 1, busyCPU)).admitted).toBe(true);
      }
    }
    // Requeue a new batch, then cancel its first waiter and kill its owner.
    expect((await poll(0)).admitted).toBe(true);
    for (let index = 1; index < workers.length; index++) expect((await poll(index)).admitted).toBe(false);
    workers[1].stdin.write('release\n');
    expect(await receive(1)).toBe('released');
    workers[0].kill();
    await workers[0].exited;
    expect((await poll(3)).admitted).toBe(false);
    expect((await poll(2, busyCPU)).admitted).toBe(true);
    expect((await poll(3)).admitted).toBe(false);
    workers[2].stdin.write('release\n');
    expect(await receive(2)).toBe('released');
    expect((await poll(3, busyCPU)).admitted).toBe(true);
  } finally {
    for (const worker of workers) worker.kill();
    await Promise.all(workers.map(worker => worker.exited));
    for (const iterator of lines) await iterator.return?.();
    rmSync(directory, { recursive: true });
  }
});
