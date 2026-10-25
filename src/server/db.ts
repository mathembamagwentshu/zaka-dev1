import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";

export { Prisma };
export type Tx = Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { zakaPrisma?: PrismaClient };

function create() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const db: PrismaClient = globalForPrisma.zakaPrisma ?? create();
if (process.env.NODE_ENV !== "production") globalForPrisma.zakaPrisma = db;

/**
 * Run `fn` in a transaction holding a row lock on the checkout session. Every session-level
 * state transition goes through here, so capture / cancel / expiry / authorisation updates for
 * one session are serialised.
 */
export async function withSessionLock<T>(sessionId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM checkout_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
      return fn(tx);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/**
 * Serialise work on one logical key across processes (Postgres advisory lock held by a short
 * transaction). Used around provider calls that must not run concurrently for the same object.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn();
    },
    { timeout, maxWait: timeout },
  );
}
