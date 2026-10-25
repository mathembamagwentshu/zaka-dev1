import "dotenv/config";
import { db } from "@/server/db";
import { stopBoss } from "@/server/jobs";
import { cancelSession, expireSession } from "@/server/payments/lifecycle";
import {
  auditTrail,
  listSessions,
  reconcileSession,
  retryCaptureException,
  reverseCaptureException,
  setFaultPlan,
} from "@/server/payments/recovery";

/**
 * Sandbox operator CLI. Usage: npm run ops -- <command> [args]
 *
 *   list                               recent sessions
 *   reconcile <ref>                    DB vs provider, per card (JSON)
 *   audit <ref>                        event history
 *   retry-capture <ref> <operator>     CAPTURE_EXCEPTION → retry failed capture
 *   reverse <ref> <operator> <reason>  CAPTURE_EXCEPTION → refund captured, release held
 *   fault <ref> <cardIndex> <operator> arm "cancel hold before capture" (FAULT_INJECTION_ENABLED)
 *   expire-now <ref>                   shorten deadline to now and expire (controlled fixture)
 *   cancel <ref> <operator>            cancel a live session, releasing holds
 *
 * Output never includes payer tokens, card numbers or full email addresses.
 */
const [cmd, ...args] = process.argv.slice(2);

function out(v: unknown) {
  console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

async function byRef(ref: string) {
  return db.checkoutSession.findUniqueOrThrow({ where: { publicRef: ref } });
}

async function main() {
  switch (cmd) {
    case "list":
      return out(await listSessions());
    case "reconcile":
      return out(await reconcileSession(args[0]));
    case "audit":
      return out((await auditTrail(args[0])).map((e) => ({ at: e.createdAt, type: e.type, actor: e.actor, data: e.data })));
    case "retry-capture":
      return out(await retryCaptureException(args[0], args[1] ?? "operator"));
    case "reverse":
      return out(await reverseCaptureException(args[0], args[1] ?? "operator", args.slice(2).join(" ") || "sandbox reversal"));
    case "fault":
      await setFaultPlan(args[0], { cancelBeforeCapture: Number(args[1]) }, args[2] ?? "operator");
      return out({ armed: true, cancelBeforeCapture: Number(args[1]) });
    case "expire-now": {
      const s = await byRef(args[0]);
      await db.checkoutSession.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      return out({ expired: await expireSession(s.id, "operator:expire-now") });
    }
    case "cancel": {
      const s = await byRef(args[0]);
      await cancelSession(s.id, "CANCELLED_BY_OPERATOR", `operator:${args[1] ?? "operator"}`);
      return out({ cancelled: true });
    }
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
