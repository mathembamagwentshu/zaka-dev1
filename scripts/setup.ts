import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import pg from "pg";

/**
 * Local development setup (safe to re-run):
 *   1. creates .env from .env.example if it does not exist;
 *   2. fills EMPTY local secrets (token keys, merchant API secret) with fresh random values —
 *      existing values are never overwritten and no value is printed;
 *   3. creates the local databases (dev, test, e2e) if missing and applies migrations.
 * Usage: npm run setup
 */

const ENV = ".env";
const created = !existsSync(ENV);
if (created) copyFileSync(".env.example", ENV);

let text = readFileSync(ENV, "utf8");
const filled: string[] = [];
function fill(name: string, value: () => string) {
  const re = new RegExp(`^${name}=(.*)$`, "m");
  const m = re.exec(text);
  if (m && m[1].trim() !== "") return;
  text = m ? text.replace(re, `${name}=${value()}`) : `${text.trimEnd()}\n${name}=${value()}\n`;
  filled.push(name);
}
fill("TOKEN_PEPPER", () => randomBytes(32).toString("base64"));
fill("TOKEN_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
fill("MERCHANT_API_SECRET", () => randomBytes(32).toString("hex"));
if (created) {
  const user = userInfo().username;
  text = text.replace(/^DATABASE_URL=postgresql:\/\/USER@/m, `DATABASE_URL=postgresql://${user}@`);
  text = text.replace(/^EMAIL_ALLOWLIST=$/m, "EMAIL_ALLOWLIST=@example.test");
  text = text.replace(/^EMAIL_PREVIEW_ENABLED=false$/m, "EMAIL_PREVIEW_ENABLED=true");
}
writeFileSync(ENV, text, { mode: 0o600 });
console.log(created ? "Created .env from .env.example." : ".env exists — kept every existing value.");
if (filled.length) console.log(`Generated local values for: ${filled.join(", ")} (not printed).`);

const databaseUrl = /^DATABASE_URL=(.+)$/m.exec(text)?.[1]?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is empty in .env — set it, then re-run npm run setup.");
  process.exit(1);
}

async function ensureDatabases(url: string) {
  const base = new URL(url);
  const dev = base.pathname.slice(1);
  const names = [dev, "zaka_test", "zaka_e2e"];
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (e) {
    console.error(`Cannot reach PostgreSQL (${(e as Error).message}). Start it, then re-run npm run setup.`);
    process.exit(1);
  }
  for (const name of names) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected database name: ${name}`);
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}"`);
      console.log(`Created database ${name}.`);
    }
  }
  await client.end();
  const withDb = (name: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
  };
  for (const name of [dev, "zaka_e2e"]) {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "ignore", env: { ...process.env, DATABASE_URL: withDb(name) } });
    console.log(`Migrations applied to ${name}.`);
  }
  console.log("zaka_test is reset and migrated automatically by the integration tests.");
}

ensureDatabases(databaseUrl)
  .then(() => {
    console.log("\nNext: npm run dev   (and in a second terminal)   npm run worker");
    console.log("Then open http://localhost:3000/demo-store — emails appear at http://localhost:3000/dev/emails");
    console.log("Check configuration any time with: npm run preflight");
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
