import "dotenv/config";
import { Resend } from "resend";
import { loadConfig } from "@/server/config";
import { isAllowlisted } from "@/server/notifications/service";
import { layoutForCheck } from "@/server/notifications/templates";

/**
 * Resend delivery check: sends ONE labelled test message to an allowlisted address.
 *   npm run email:check -- you@your-domain.example
 * Refuses addresses outside EMAIL_ALLOWLIST. Prints the Resend message id, never the key.
 */
async function main() {
  const c = loadConfig();
  const to = (process.argv[2] ?? "").trim().toLowerCase();
  if (!c.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set.");
  if (!to) throw new Error("Pass the recipient: npm run email:check -- you@your-domain.example");
  if (!isAllowlisted(to, c.emailAllowlist)) throw new Error("Recipient is not on EMAIL_ALLOWLIST — refusing to send.");
  const email = layoutForCheck();
  const { data, error } = await new Resend(c.RESEND_API_KEY).emails.send({ from: c.EMAIL_FROM, to: [to], ...email });
  if (error || !data) throw new Error(`Resend refused the message: ${error?.name ?? ""} ${error?.message ?? ""}`);
  console.log(JSON.stringify({ sent: true, resendMessageId: data.id, from: c.EMAIL_FROM }, null, 2));
}

main().catch((e) => {
  console.error("email:check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
