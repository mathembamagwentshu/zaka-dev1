import { execSync } from "node:child_process";

/**
 * Recreate the isolated TEST database schema once per run, then apply migrations.
 * Refuses to touch any database whose name does not end in "_test".
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/zaka_test`;
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  execSync(`psql "${url}" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`, {
    stdio: "pipe",
  });
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
