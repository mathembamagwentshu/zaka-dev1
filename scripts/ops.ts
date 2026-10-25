import "dotenv/config";
import { db } from "@/server/db";
import { stopBoss } from "@/server/jobs";
import {
  auditTrail,
  cancelByOperator,
  expireNow,
  listSessions,
  reconcileSession,
  retryCaptureException,
  reverseCaptureException,
  setFaultPlan,
} from "@/server/payments/recovery";

/**
 * Sandbox operator CLI. Usage: npm run ops -- <command> [args]
 *
 *   list [--attention]                 recent sessions (or only those needing an operator)
 *   reconcile <ref>                    DB vs provider per card, refunds, next permitted actions (read-only)
 *   audit <ref>                        event history (read-only)
 *   retry-capture <ref> <operator>     CAPTURE_EXCEPTION → continue capture, only if every remaining card is still held
 *   reverse <ref> <operator> <reason>  CAPTURE_EXCEPTION → refund captured cards, release holds (re-runnable)
 *   cancel <ref> <operator>            cancel a live session before capture, releasing holds
 *   fault <ref> <cardIndex> <operator> arm "cancel hold before capture" (FAULT_INJECTION_ENABLED only)
 *   expire-now <ref> <operator>        controlled expiry fixture: deadline → now, then normal expiry
 *
 * Access: the CLI needs the environment's DATABASE_URL and provider keys, i.e. shell access to the
 * deployment. Mutating commands require an operator name (checked against OPS_OPERATORS when set)
 * and are audited. Output never includes payer tokens, card numbers or full email addresses.
 */
const [cmd, ...args] = process.argv.slice(2);

function out(v: unknown) {
  console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

async function main() {
  switch (cmd) {
    case "list":
      return out(await listSessions(20, args.includes("--attention")));
    case "reconcile":
      return out(await reconcileSession(args[0]));
    case "audit":
      return out((await auditTrail(args[0])).map((e) => ({ at: e.createdAt, type: e.type, actor: e.actor, data: e.data })));
    case "retry-capture":
      return out(await retryCaptureException(args[0], args[1]));
    case "reverse":
      return out(await reverseCaptureException(args[0], args[1], args.slice(2).join(" ")));
    case "cancel":
      return out(await cancelByOperator(args[0], args[1]));
    case "fault":
      await setFaultPlan(args[0], { cancelBeforeCapture: Number(args[1]) }, args[2]);
      return out({ armed: true, cancelBeforeCapture: Number(args[1]) });
    case "expire-now":
      return out({ expired: await expireNow(args[0], args[1]) });
    default:
      console.error("Unknown command. See the header of scripts/ops.ts.");
      process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopBoss();
    await db.$disconnect();
  });
