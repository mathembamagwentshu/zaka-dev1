/**
 * Minimal structured logger with redaction. Bearer tokens, client secrets, API keys and email
 * addresses are masked before anything is written.
 */

const PATTERNS: [RegExp, string][] = [
  [/zk[A-Za-z0-9_-]{20,}/g, "zk_[redacted]"],
  [/(pi_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+/g, "$1_secret_[redacted]"],
  [/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "$1_$2_[redacted]"],
  [/whsec_[A-Za-z0-9]+/g, "whsec_[redacted]"],
  [/re_[A-Za-z0-9]{16,}/g, "re_[redacted]"],
  [/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (process.env.ZAKA_LOG_SILENT === "true" && level !== "error") return;
  const line = redact(
    JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
      v instanceof Error ? { name: v.name, message: v.message } : typeof v === "bigint" ? v.toString() : v,
    ),
  );
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}
