import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DATABASE_URL ?? "./data/app.sqlite";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: dbUrl },
  strict: true,
  verbose: true,
});
