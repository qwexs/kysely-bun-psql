import type { BunDialectConfig } from "../src/index";
import { beforeAll, afterAll } from "bun:test";

// Test database configuration matching Docker settings
const TEST_CONFIG: BunDialectConfig = {
  url: process.env["DATABASE_URL"] ?? "postgres://admin@localhost:5434/test",
};

async function setupTestTable() {
  const sql = new Bun.SQL(TEST_CONFIG.url);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS test_table (
        id SERIAL PRIMARY KEY,
        value VARCHAR NOT NULL
      )
    `;
    await sql.close();
  } catch (error) {
    console.error("Error setting up test table:", error);
    throw error;
  } finally {
    await sql.close();
  }
}

async function setupTestPersonTable() {
  const sql = new Bun.SQL(TEST_CONFIG.url);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS person (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR NOT NULL,
        last_name VARCHAR,
        tags TEXT[],
        number_tags INTEGER[],
        nullable_string_tags TEXT[],
        metadata JSONB[],
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
  } catch (error) {
    console.error("Error setting up test person table:", error);
    throw error;
  } finally {
    await sql.close();
  }
}

async function cleanupTestTable() {
  const sql = new Bun.SQL(TEST_CONFIG.url);
  try {
    await sql`DROP TABLE IF EXISTS test_table`;
  } finally {
    await sql.close();
  }
}

async function cleanupTestPersonTable() {
  const sql = new Bun.SQL(TEST_CONFIG.url);
  try {
    await sql`DROP TABLE IF EXISTS person`;
  } finally {
    await sql.close();
  }
}

beforeAll(async () => {
  await setupTestTable();
  await setupTestPersonTable();
});

afterAll(async () => {
  await cleanupTestTable();
  await cleanupTestPersonTable();
});
