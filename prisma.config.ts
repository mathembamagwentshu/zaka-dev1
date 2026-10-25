import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` (run on install) needs no database, so a fresh clone without .env works.
    // Migration commands fail clearly if DATABASE_URL is unset.
    url: process.env.DATABASE_URL ?? "",
  },
});
