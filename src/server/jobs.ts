import { PgBoss } from "pg-boss";
import { log } from "./log";

/**
 * Durable background work on pg-boss (same Postgres). Every job handler is idempotent and
 * re-reads state, so a duplicate or late job is harmless. A periodic sweep re-enqueues anything
 * whose enqueue was lost (e.g. a crash between commit and send).
 */

export const QUEUES = {
  capture: "session-capture",
  expire: "session-expire",
  release: "hold-release",
  notify: "notification-send",
  merchant: "merchant-status",
  sweep: "maintenance-sweep",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface SendOptions {
  singletonKey?: string;
  startAfter?: Date;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
}

export interface JobQueue {
  send(name: QueueName, data: Record<string, unknown>, opts?: SendOptions): Promise<void>;
}

const DEFAULTS: Record<QueueName, SendOptions> = {
  "session-capture": { retryLimit: 10, retryDelay: 5, retryBackoff: true },
  "session-expire": { retryLimit: 10, retryDelay: 10, retryBackoff: true },
  "hold-release": { retryLimit: 10, retryDelay: 5, retryBackoff: true },
  "notification-send": { retryLimit: 5, retryDelay: 15, retryBackoff: true },
  "merchant-status": { retryLimit: 8, retryDelay: 10, retryBackoff: true },
  "maintenance-sweep": { retryLimit: 0 },
};

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function getBoss(opts: { worker: boolean } = { worker: false }): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "pgboss",
      supervise: opts.worker,
      schedule: opts.worker,
      max: opts.worker ? 6 : 3,
    });
    b.on("error", (e: unknown) => log.error("pg-boss error", { error: e }));
    await b.start();
    for (const name of Object.values(QUEUES)) {
      await b.createQueue(name);
    }
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopBoss() {
  if (boss) await boss.stop({ graceful: true, timeout: 10_000 });
  boss = undefined;
  starting = undefined;
}

const pgBossQueue: JobQueue = {
  async send(name, data, opts) {
    const b = await getBoss();
    const o = { ...DEFAULTS[name], ...opts };
    await b.send(name, data, {
      singletonKey: o.singletonKey,
      startAfter: o.startAfter,
      retryLimit: o.retryLimit,
      retryDelay: o.retryDelay,
      retryBackoff: o.retryBackoff,
    });
  },
};

let queue: JobQueue = pgBossQueue;

/** Enqueue after the relevant transaction committed. Failure is logged; the sweep recovers it. */
export async function enqueue(name: QueueName, data: Record<string, unknown>, opts?: SendOptions) {
  try {
    await queue.send(name, data, opts);
  } catch (e) {
    log.error("enqueue failed; maintenance sweep will recover", { queue: name, error: e });
  }
}

export function setJobQueueForTests(q: JobQueue | undefined) {
  queue = q ?? pgBossQueue;
}
