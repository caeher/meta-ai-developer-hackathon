import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import * as schema from "./schema/index";

const databaseUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, "DATABASE_URL debe usar PostgreSQL");

export type GameDatabase = NodePgDatabase<typeof schema>;

function validateDatabaseUrl(connectionString: unknown): string {
  const parsed = databaseUrlSchema.safeParse(connectionString);
  if (!parsed.success) {
    throw new Error("DATABASE_URL debe ser una URL PostgreSQL válida; su valor no se registra.");
  }
  return parsed.data;
}

export function createDatabase(connectionString: string, options: Omit<PoolConfig, "connectionString"> = {}) {
  const validatedConnectionString = validateDatabaseUrl(connectionString);
  const pool = new Pool({
    connectionString: validatedConnectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...options,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export function createDatabaseFromEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const connectionString = validateDatabaseUrl(source.DATABASE_URL);
  return createDatabase(connectionString);
}
