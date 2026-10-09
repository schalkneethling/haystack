// drizzle-kit only generates migrations. Wrangler applies them (plan decision 16), so this
// config has no database credentials and `drizzle-kit push` or `migrate` cannot run.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
