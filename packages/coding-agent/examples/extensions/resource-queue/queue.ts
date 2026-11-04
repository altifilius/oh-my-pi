import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Pressure {
  available: number;
  total: number;
  swapUsedRatio: number;
  cpuBusy: number;
  memoryStall: number;
}

export interface QueueState {
  position: number;
  admitted: boolean;
  reason: string;
}

interface Entry {
  id: number;
  owner: string;
  pid: number;
  started: string;
  active: number;
}

export function processStart(pid: number): string | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').trim().split(/\s+/);
    if (fields[0] === 'Z') return undefined;
    return fields[19];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function samplePressure(): Pressure {
  const memory: Record<string, number> = {};
  for (const match of readFileSync('/proc/meminfo', 'utf8').matchAll(/^(\w+):\s+(\d+) kB/gm)) {
    memory[match[1]] = Number(match[2]) * 1024;
  }
  const total = memory.MemTotal;
  const available = memory.MemAvailable;
  const swapTotal = memory.SwapTotal;
  const swapFree = memory.SwapFree;
  if (!total || available === undefined || swapTotal === undefined || swapFree === undefined) {
    throw new Error('Cannot read Linux memory availability; work remains queued.');
  }
  const average = (path: string, category: string): number => {
    const value = readFileSync(path, 'utf8').match(new RegExp(`^${category} avg10=([0-9.]+)`, 'm'));
    if (!value) throw new Error(`Cannot read ${path}; work remains queued.`);
    return Number(value[1]);
  };
  return {
    total, available,
    swapUsedRatio: swapTotal ? (swapTotal - swapFree) / swapTotal : 0,
    cpuBusy: average('/proc/pressure/cpu', 'some'),
    memoryStall: average('/proc/pressure/memory', 'some'),
  };
}

export function admissionReason(pressure: Pressure): string {
  const reserve = Math.max(3 * 1024 ** 3, pressure.total * 0.25);
  if (pressure.available < reserve) return 'RAM boşalması bekleniyor';
  if (pressure.swapUsedRatio >= 0.75 && pressure.available < pressure.total * 0.4) {
    return 'Swap baskısının azalması bekleniyor';
  }
  if (pressure.memoryStall >= 5) return 'Bellek baskısının azalması bekleniyor';
  return '';
}

/** One process family runs until its finite work settles; CPU load cannot stall an empty queue. */
export class ResourceQueue {
  private readonly db: Database;
  private readonly owner: string;
  private readonly pid: number;
  private readonly started: string;

  constructor(path = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'omp-resource-queue', 'queue.sqlite')) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = statSync(directory);
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('OMP resource queue directory must be owner-only.');
    }
    this.pid = process.pid;
    this.started = processStart(this.pid) ?? '';
    if (!this.started) throw new Error('Cannot establish OMP process identity.');
    this.owner = `${this.pid}:${this.started}`;
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL UNIQUE, pid INTEGER NOT NULL, started TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)');
  }

  private prune(): void {
    const rows = this.db.query<Entry, []>('SELECT * FROM queue').all();
    const remove = this.db.query('DELETE FROM queue WHERE owner = ?');
    for (const row of rows) if (processStart(row.pid) !== row.started) remove.run(row.owner);
  }

  poll(pressure?: Pressure): QueueState {
    return this.db.transaction(() => {
      this.prune();
      this.db.query('INSERT OR IGNORE INTO queue(owner, pid, started) VALUES (?, ?, ?)').run(this.owner, this.pid, this.started);
      const entries = this.db.query<Entry, []>('SELECT * FROM queue ORDER BY id').all();
      // Sibling calls and nested dispatch belong to the same execution family.
      // Rechecking an acquired lease here can deadlock an unstarted tool batch.
      if (entries.some(row => row.owner === this.owner && row.active)) {
        return { position: 0, admitted: true, reason: '' };
      }
      const active = entries.filter(row => row.active).length;
      const pending = entries.filter(row => !row.active);
      const position = pending.findIndex(row => row.owner === this.owner) + 1;
      const reason = active ? 'Çalışan OMP işleminin bitmesi bekleniyor'
        : position > 1 ? 'Önceki kaynak isteğinin başlaması bekleniyor'
        : admissionReason(pressure ?? samplePressure());
      if (!reason) this.db.query('UPDATE queue SET active = 1 WHERE owner = ?').run(this.owner);
      return { position: position + active, admitted: !reason, reason };
    }).immediate();
  }

  release(): void {
    this.db.query('DELETE FROM queue WHERE owner = ?').run(this.owner);
  }

  close({ release = true }: { release?: boolean } = {}): void {
    if (release) this.release();
    this.db.close();
  }
}
