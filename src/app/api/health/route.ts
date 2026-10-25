import { connection } from "next/server";
import { config, ConfigError } from "@/server/config";
import { db } from "@/server/db";
import { json } from "@/server/http";
import { log } from "@/server/log";

/** Health check for the platform. Reports which dependency failed, never configuration values. */
export async function GET() {
  await connection();
  let provider: string;
  try {
    provider = config().PAYMENT_PROVIDER;
  } catch (e) {
    log.error("health: invalid configuration", { error: e });
    return json({ ok: false, failing: "configuration", hint: e instanceof ConfigError ? "run npm run preflight" : null }, 503);
  }
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    log.error("health: database unreachable", { error: e });
    return json({ ok: false, failing: "database" }, 503);
  }
  return json({ ok: true, provider, testMode: true });
}
