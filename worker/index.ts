import "dotenv/config";
import { config } from "@/server/config";
import { getBoss, QUEUES, stopBoss } from "@/server/jobs";
import { log } from "@/server/log";
import { sendNotification } from "@/server/notifications/service";
import { runCapture } from "@/server/payments/capture";
import { expireSession } from "@/server/payments/lifecycle";
import { releaseAllocation } from "@/server/payments/release";
import { sweep } from "@/server/payments/sweep";

/**
 * Background worker: same business logic as the web app, separate process.
 * Jobs survive restarts (pg-boss tables in Postgres); handlers are idempotent.
 */

type Job = { id: string; data: Record<string, string> };

async function main() {
  const c = config(); // fail fast on invalid / live configuration
  log.info("worker starting", { provider: c.PAYMENT_PROVIDER, window: c.SESSION_WINDOW_MINUTES });
  const boss = await getBoss({ worker: true });

  const handle = (name: string, fn: (data: Record<string, string>) => Promise<unknown>) =>
    boss.work(name, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs: Job[]) => {
      for (const job of jobs) {
        try {
          await fn(job.data);
        } catch (e) {
          log.warn("job failed; will retry", { queue: name, jobId: job.id, error: e });
          throw e;
        }
      }
    });

  await handle(QUEUES.capture, (d) => runCapture(d.sessionId));
  await handle(QUEUES.expire, (d) => expireSession(d.sessionId));
  await handle(QUEUES.release, (d) => releaseAllocation(d.allocationId));
  await handle(QUEUES.notify, (d) => sendNotification(d.notificationId));
  await handle(QUEUES.sweep, () => sweep());
  await boss.schedule(QUEUES.sweep, "* * * * *");

  // Run one sweep at start-up: recovers anything left pending by a previous crash/restart.
  await sweep().catch((e) => log.error("startup sweep failed", { error: e }));
  log.info("worker ready");

  const shutdown = async (signal: string) => {
    log.info("worker stopping", { signal });
    await stopBoss();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("worker failed to start", { error: e });
  process.exit(1);
});
