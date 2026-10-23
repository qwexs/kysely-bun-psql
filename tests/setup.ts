import { beforeAll, afterAll } from "bun:test";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a disposable PostgreSQL database before running integration tests. See README.md.",
  );
}

// Each test process owns a schema; never drop a user's existing public tables.
const schema = `kysely_test_${crypto.randomUUID().replaceAll("-", "")}`;
const url = new URL(databaseUrl);
url.searchParams.set("search_path", schema);
process.env["DATABASE_URL"] = url.toString();

beforeAll(async () => {
  const sql = new Bun.SQL(url.toString());
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql`
      CREATE TABLE IF NOT EXISTS test_table (
        id SERIAL PRIMARY KEY,
        value VARCHAR NOT NULL
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS person (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR NOT NULL,
        last_name VARCHAR,
        tags TEXT[],
        number_tags INTEGER[],
        nullable_string_tags TEXT[],
        metadata JSONB[],
        settings JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
  } finally {
    await sql.close();
  }
});

afterAll(async () => {
  const sql = new Bun.SQL(databaseUrl);
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await sql.close();
  }
});
