import { connection } from "next/server";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { json } from "@/server/http";

export async function GET() {
  await connection();
  try {
    const c = config();
    await db.$queryRaw`SELECT 1`;
    return json({ ok: true, provider: c.PAYMENT_PROVIDER, testMode: true });
  } catch {
    return json({ ok: false }, 503);
  }
}
