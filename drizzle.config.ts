import { defineConfig } from "drizzle-kit";

// Generates D1 migrations from src/server/db/schema.ts into migrations/
// (run `npm run db:generate`). Wrangler applies them: `npm run db:migrate`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
});
