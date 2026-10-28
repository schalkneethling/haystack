// Applies migration files to a harness D1 one at a time, and reads tables back, for the tests
// that show a migration keeps the rows already in the database, as the production database
// holds them. They apply the files themselves, rather than with `applyD1Migrations`, because
// they need rows in the database between two migrations.
import { readFile } from "node:fs/promises";

// The harness types its D1 binding as `any`; this is the part the helpers use.
interface D1Statement {
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

interface D1Like<Statement extends D1Statement> {
  prepare(query: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}

/**
 * Runs the migration file `name` from `migrations/` as a single batch, split into statements
 * where drizzle-kit marks the breaks.
 */
export async function applyMigration<Statement extends D1Statement>(
  db: D1Like<Statement>,
  name: string,
): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

/** Every row of each table, in the order they were inserted, keyed by the table's name. */
export async function tableRows<Statement extends D1Statement>(
  db: D1Like<Statement>,
  tables: readonly string[],
): Promise<Record<string, Record<string, unknown>[]>> {
  const entries = await Promise.all(
    tables.map(async (table) => {
      const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return [table, results] as const;
    }),
  );
  return Object.fromEntries(entries);
}
