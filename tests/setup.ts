import type { BunDialectConfig } from "../src/index";
import { beforeAll, afterAll } from "bun:test";

// Test database configuration matching Docker settings
const TEST_CONFIG: BunDialectConfig = {
  url: process.env["DATABASE_URL"] ?? "postgres://admin@localhost:5434/test",
};

// Docker container management
async function waitForDatabase(maxAttempts = 20) {
  const sql = new Bun.SQL(TEST_CONFIG.url);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`SELECT 1`;
      await sql.close();
      return true;
    } catch (error) {
      if (attempt === maxAttempts) {
        await sql.close();
        throw new Error(
          `Database not ready after ${maxAttempts} attempts: ${error}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await sql.close();
  return false;
}

async function startTestDatabase() {
  try {
    const process = Bun.spawn(["docker", "compose", "up", "-d"], {
      cwd: import.meta.dir,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const success = await process.exited;
    if (success !== 0) {
      throw new Error("Failed to start test database");
    }

    // Wait for database to be ready
    await waitForDatabase();
  } catch (error) {
    console.error("Error starting test database:", error);
    await stopTestDatabase(); // Cleanup on startup failure
    throw error;
  }
}

async function stopTestDatabase() {
  try {
    const process = Bun.spawn(["docker", "compose", "down"], {
      cwd: import.meta.dir,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const success = await process.exited;
    if (success !== 0) {
      throw new Error("Failed to stop test database");
    }
  } catch (error) {
    console.error("Error stopping test database:", error);
    throw error;
  }
}

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
  await startTestDatabase();
  await setupTestTable();
  await setupTestPersonTable();
});

afterAll(async () => {
  await cleanupTestTable();
  await cleanupTestPersonTable();
  await stopTestDatabase();
});
