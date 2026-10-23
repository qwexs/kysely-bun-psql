import { CompiledQuery } from "kysely";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { BunDriver } from "../src/driver";
import type { BunConnection } from "../src/connection";

const TEST_CONFIG = {
  url: process.env["DATABASE_URL"] ?? "postgres://admin@localhost:5432/test",
};

interface TestTable {
  id: number;
  value: string;
}

interface BasicSelect {
  num: number;
  str: string;
  date: Date;
}

describe("Bun PostgreSQL Dialect Implementation", () => {
  describe("Driver Implementation", () => {
    let driver: BunDriver;

    beforeEach(() => {
      driver = new BunDriver(TEST_CONFIG);
    });

    afterEach(async () => {
      await driver.destroy();
    });

    test("should acquire and release a connection", async () => {
      const connection = await driver.acquireConnection();
      expect(connection).toBeDefined();
      expect(typeof connection.executeQuery).toBe("function");
      await driver.releaseConnection(connection);
    }, 1000);

    describe("transactions", () => {
      test("should begin and commit a transaction", async () => {
        const connection = await driver.acquireConnection();

        try {
          await driver.beginTransaction(connection, {});
          const result = await connection.executeQuery(
            CompiledQuery.raw("SELECT 1 as num"),
          );
          expect(result.rows).toHaveLength(1);
          expect(result.rows[0]).toEqual({ num: 1 });
          await driver.commitTransaction(connection);
        } finally {
          await driver.releaseConnection(connection);
        }
      }, 1000);

      test("should rollback a transaction", async () => {
        const connection = await driver.acquireConnection();

        try {
          await connection.executeQuery(
            CompiledQuery.raw(
              "CREATE TEMPORARY TABLE test_rollback (id integer PRIMARY KEY)",
            ),
          );
          await driver.beginTransaction(connection, {});
          const inserted = await connection.executeQuery<{ id: number }>(
            CompiledQuery.raw(
              "INSERT INTO test_rollback VALUES (1) RETURNING id",
            ),
          );
          expect(inserted.rows).toEqual([{ id: 1 }]);
          const visible = await connection.executeQuery<{ id: number }>(
            CompiledQuery.raw("SELECT id FROM test_rollback"),
          );
          expect(visible.rows).toEqual([{ id: 1 }]);

          await driver.rollbackTransaction(connection);
          const rolledBack = await connection.executeQuery(
            CompiledQuery.raw("SELECT id FROM test_rollback"),
          );
          expect(rolledBack.rows).toEqual([]);
        } finally {
          await driver.releaseConnection(connection);
        }
      }, 1000);

      test("should handle transaction isolation levels", async () => {
        const connection = await driver.acquireConnection();

        try {
          await driver.beginTransaction(connection, {
            isolationLevel: "serializable",
          });
          const result = await connection.executeQuery<{
            transaction_isolation: string;
          }>(CompiledQuery.raw("SHOW transaction_isolation"));
          expect(result.rows).toEqual([
            { transaction_isolation: "serializable" },
          ]);
          await driver.commitTransaction(connection);
        } finally {
          await driver.releaseConnection(connection);
        }
      }, 1000);
    });

    describe("connection management", () => {
      test("should keep two reserved sessions independent", async () => {
        const acquisitions = await Promise.allSettled([
          driver.acquireConnection(),
          driver.acquireConnection(),
        ]);
        const connections = acquisitions.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const table = `reservation_${crypto.randomUUID().replaceAll("-", "")}`;

        try {
          expect(connections).toHaveLength(2);
          const [first, second] = connections;
          const results = await Promise.all(
            connections.map(async (connection, index) => {
              const backend = await connection.executeQuery<{ pid: number }>(
                CompiledQuery.raw("SELECT pg_backend_pid() AS pid"),
              );
              // The same name must refer to a different temporary table in each session.
              await connection.executeQuery(
                CompiledQuery.raw(
                  `CREATE TEMPORARY TABLE ${table} (value integer)`,
                ),
              );
              await connection.executeQuery(
                CompiledQuery.raw(`INSERT INTO ${table} VALUES ($1)`, [index]),
              );
              return backend.rows[0].pid;
            }),
          );
          expect(results[0]).not.toBe(results[1]);

          await driver.beginTransaction(first, {});
          await expect(
            first.executeQuery(CompiledQuery.raw("SELECT 1 / 0")),
          ).rejects.toMatchObject({ errno: "22012" });
          await expect(
            first.executeQuery(CompiledQuery.raw("SELECT 1")),
          ).rejects.toMatchObject({ errno: "25P02" });

          const unaffected = await second.executeQuery<{ value: number }>(
            CompiledQuery.raw(`SELECT value FROM ${table}`),
          );
          expect(unaffected.rows).toEqual([{ value: 1 }]);

          await driver.rollbackTransaction(first);
          const recovered = await first.executeQuery<{
            pid: number;
            value: number;
          }>(
            CompiledQuery.raw(
              `SELECT pg_backend_pid() AS pid, value FROM ${table}`,
            ),
          );
          expect(recovered.rows).toEqual([{ pid: results[0], value: 0 }]);
        } finally {
          await Promise.all(
            connections.map((connection) =>
              driver.releaseConnection(connection),
            ),
          );
        }
      }, 5000);

      test("should wait for release when max is one", async () => {
        const singleDriver = new BunDriver({
          ...TEST_CONFIG,
          max: 1,
          idleTimeout: 0,
          maxLifetime: 0,
        });
        let first: BunConnection | undefined;
        let waiting: Promise<BunConnection> | undefined;
        let acquired = false;

        try {
          first = await singleDriver.acquireConnection();
          const original = await first.executeQuery<{ pid: number }>(
            CompiledQuery.raw("SELECT pg_backend_pid() AS pid"),
          );
          waiting = singleDriver.acquireConnection().then((connection) => {
            acquired = true;
            return connection;
          });
          // Attach a rejection handler immediately; cleanup still awaits the original promise.
          void waiting.catch(() => {});

          // A completed round trip on the holder is the barrier, not an elapsed delay.
          await first.executeQuery(
            CompiledQuery.raw("SELECT 1 AS holder_barrier"),
          );
          expect(acquired).toBe(false);

          await singleDriver.releaseConnection(first);
          first = undefined;
          const second = await waiting;
          const reused = await second.executeQuery<{ pid: number }>(
            CompiledQuery.raw("SELECT pg_backend_pid() AS pid"),
          );
          expect(acquired).toBe(true);
          expect(reused.rows).toEqual(original.rows);
        } finally {
          try {
            if (first) await singleDriver.releaseConnection(first);
            if (waiting) {
              const second = await waiting;
              await singleDriver.releaseConnection(second);
            }
          } finally {
            await singleDriver.destroy();
          }
        }
      }, 5000);

      test("should recover a reserved session after a SQL error", async () => {
        const connection = await driver.acquireConnection();
        try {
          const original = await connection.executeQuery<{ pid: number }>(
            CompiledQuery.raw("SELECT pg_backend_pid() AS pid"),
          );
          await expect(
            connection.executeQuery(CompiledQuery.raw("SELECT 1 / 0")),
          ).rejects.toMatchObject({ errno: "22012" });
          const recovered = await connection.executeQuery<{ pid: number }>(
            CompiledQuery.raw("SELECT pg_backend_pid() AS pid"),
          );
          expect(recovered.rows).toEqual(original.rows);
        } finally {
          await driver.releaseConnection(connection);
        }
      }, 3000);

      test("should fail when using released connection", async () => {
        const connection = await driver.acquireConnection();
        await driver.releaseConnection(connection);

        await expect(
          connection.executeQuery(CompiledQuery.raw("SELECT 1")),
        ).rejects.toThrow();
      }, 1000);

      test("should fail when acquiring connection after destroy", async () => {
        await driver.destroy();
        await expect(driver.acquireConnection()).rejects.toThrow();
      }, 1000);

      test("should handle connection timeouts", async () => {
        let accepted = false;
        let receivedStartup = false;
        const listener = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open() {
              accepted = true;
            },
            // Consume the startup message without replying to the handshake.
            data() {
              receivedStartup = true;
            },
          },
        });
        const timeoutDriver = new BunDriver({
          url: `postgres://invalid:invalid@127.0.0.1:${listener.port}/nonexistent`,
          connectionTimeout: 1,
          max: 1,
          tls: false,
        });

        try {
          await expect(timeoutDriver.acquireConnection()).rejects.toMatchObject(
            {
              code: "ERR_POSTGRES_CONNECTION_TIMEOUT",
            },
          );
          expect(accepted).toBe(true);
          expect(receivedStartup).toBe(true);
        } finally {
          listener.stop(true);
          await timeoutDriver.destroy();
        }
      }, 5000);

      test("should handle authentication errors", async () => {
        const url = new URL(TEST_CONFIG.url);
        url.username = "invalid";
        url.password = "invalid";
        url.pathname = "/nonexistent";
        const badDriver = new BunDriver({ url: url.toString() });

        try {
          await expect(badDriver.acquireConnection()).rejects.toThrow(
            /role.*does not exist|password authentication failed|database.*does not exist/i,
          );
        } finally {
          await badDriver.destroy();
        }
      }, 1000);

      test("should handle connection refused", async () => {
        const listener = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: { data() {} },
        });
        const port = listener.port;
        listener.stop(true);

        // Use only the closed loopback endpoint, never the integration database.
        const unreachableDriver = new BunDriver({
          url: `postgres://invalid:invalid@127.0.0.1:${port}/nonexistent`,
          connectionTimeout: 1,
          max: 1,
          tls: false,
        });

        try {
          await expect(
            unreachableDriver.acquireConnection(),
          ).rejects.toMatchObject({
            code: "ERR_POSTGRES_CONNECTION_REFUSED",
          });
        } finally {
          listener.stop(true);
          await unreachableDriver.destroy();
        }
      }, 3000);
    });
  });

  describe("Connection Implementation", () => {
    let driver: BunDriver;
    let connection: BunConnection;

    beforeEach(async () => {
      driver = new BunDriver(TEST_CONFIG);
      connection = await driver.acquireConnection();
      // Create a test table for our queries
      await connection.executeQuery(
        CompiledQuery.raw(
          "CREATE TEMPORARY TABLE test_table (id serial PRIMARY KEY, value text NOT NULL)",
        ),
      );
    });

    afterEach(async () => {
      if (connection) {
        // Drop the temporary table
        await connection.executeQuery(
          CompiledQuery.raw("DROP TABLE IF EXISTS test_table"),
        );
        await driver.releaseConnection(connection);
      }
      await driver.destroy();
    });

    test("should execute basic SELECT queries", async () => {
      const result = await connection.executeQuery<BasicSelect>(
        CompiledQuery.raw("SELECT 1 as num, 'test' as str, NOW() as date"),
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        num: 1,
        str: "test",
      });
      expect(result.rows[0].date).toBeInstanceOf(Date);
    }, 1000);

    test("should execute parameterized queries", async () => {
      const value = "test_value";

      // Insert with parameter
      const insertResult = await connection.executeQuery<Pick<TestTable, "id">>(
        CompiledQuery.raw(
          "INSERT INTO test_table (value) VALUES ($1) RETURNING id",
          [value],
        ),
      );
      expect(insertResult.rows).toHaveLength(1);
      const id = insertResult.rows[0].id;

      // Select with parameter
      const selectResult = await connection.executeQuery<
        Pick<TestTable, "value">
      >(CompiledQuery.raw("SELECT value FROM test_table WHERE id = $1", [id]));
      expect(selectResult.rows).toHaveLength(1);
      expect(selectResult.rows[0].value).toBe(value);
    }, 1000);

    test("should handle INSERT operations", async () => {
      const result = await connection.executeQuery<TestTable>(
        CompiledQuery.raw(
          "INSERT INTO test_table (value) VALUES ($1), ($2) RETURNING id, value",
          ["value1", "value2"],
        ),
      );

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].value).toBe("value1");
      expect(result.rows[1].value).toBe("value2");
      expect(result.rows[0].id).toBeLessThan(result.rows[1].id);
    }, 1000);

    test("should handle UPDATE operations", async () => {
      // Insert initial data
      await connection.executeQuery<TestTable>(
        CompiledQuery.raw("INSERT INTO test_table (value) VALUES ($1)", [
          "old_value",
        ]),
      );

      // Perform update
      const result = await connection.executeQuery<TestTable>(
        CompiledQuery.raw(
          "UPDATE test_table SET value = $1 WHERE value = $2 RETURNING *",
          ["new_value", "old_value"],
        ),
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].value).toBe("new_value");
    }, 1000);

    test("should handle DELETE operations", async () => {
      // Insert data to delete
      await connection.executeQuery<TestTable>(
        CompiledQuery.raw("INSERT INTO test_table (value) VALUES ($1), ($2)", [
          "delete_me",
          "keep_me",
        ]),
      );

      // Perform delete
      const result = await connection.executeQuery<TestTable>(
        CompiledQuery.raw(
          "DELETE FROM test_table WHERE value = $1 RETURNING *",
          ["delete_me"],
        ),
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].value).toBe("delete_me");

      // Verify only one row remains
      const remaining = await connection.executeQuery<{ count: string }>(
        CompiledQuery.raw("SELECT COUNT(*) as count FROM test_table"),
      );
      expect(remaining.rows[0].count).toBe("1");
    }, 1000);

    test("should handle multiple result rows", async () => {
      // Insert multiple rows
      await connection.executeQuery<TestTable>(
        CompiledQuery.raw(
          "INSERT INTO test_table (value) VALUES ($1), ($2), ($3)",
          ["one", "two", "three"],
        ),
      );

      // Select with ORDER BY to ensure consistent results
      const result = await connection.executeQuery<TestTable>(
        CompiledQuery.raw("SELECT * FROM test_table ORDER BY value"),
      );

      expect(result.rows).toHaveLength(3);
      expect(result.rows.map((r) => r.value)).toEqual(["one", "three", "two"]);
    }, 1000);

    test("should report zero and multiple affected rows without RETURNING", async () => {
      const inserted = await connection.executeQuery(
        CompiledQuery.raw(
          "INSERT INTO test_table (value) VALUES ('one'), ('two'), ('three')",
        ),
      );
      expect(inserted.rows).toEqual([]);
      expect(inserted.numAffectedRows).toBe(3n);

      const updated = await connection.executeQuery(
        CompiledQuery.raw(
          "UPDATE test_table SET value = 'updated' WHERE value <> 'three'",
        ),
      );
      expect(updated.rows).toEqual([]);
      expect(updated.numAffectedRows).toBe(2n);
      const noUpdate = await connection.executeQuery(
        CompiledQuery.raw("UPDATE test_table SET value = 'unused' WHERE false"),
      );
      expect(noUpdate.numAffectedRows).toBe(0n);

      const deleted = await connection.executeQuery(
        CompiledQuery.raw("DELETE FROM test_table WHERE value = 'updated'"),
      );
      expect(deleted.rows).toEqual([]);
      expect(deleted.numAffectedRows).toBe(2n);
      const noDelete = await connection.executeQuery(
        CompiledQuery.raw("DELETE FROM test_table WHERE false"),
      );
      expect(noDelete.numAffectedRows).toBe(0n);
    }, 3000);

    test("should report affected rows for ON CONFLICT", async () => {
      await connection.executeQuery(
        CompiledQuery.raw(
          "INSERT INTO test_table (id, value) VALUES (1, 'original')",
        ),
      );
      const ignored = await connection.executeQuery(
        CompiledQuery.raw(
          "INSERT INTO test_table (id, value) VALUES (1, 'ignored') ON CONFLICT (id) DO NOTHING",
        ),
      );
      expect(ignored.rows).toEqual([]);
      expect(ignored.numAffectedRows).toBe(0n);

      const upserted = await connection.executeQuery(
        CompiledQuery.raw(
          "INSERT INTO test_table (id, value) VALUES (1, 'updated'), (2, 'new') ON CONFLICT (id) DO UPDATE SET value = excluded.value",
        ),
      );
      expect(upserted.rows).toEqual([]);
      expect(upserted.numAffectedRows).toBe(2n);
      const rows = await connection.executeQuery<TestTable>(
        CompiledQuery.raw("SELECT id, value FROM test_table ORDER BY id"),
      );
      expect(rows.rows).toEqual([
        { id: 1, value: "updated" },
        { id: 2, value: "new" },
      ]);
    }, 3000);

    test("should handle empty result sets", async () => {
      const result = await connection.executeQuery<TestTable>(
        CompiledQuery.raw("SELECT * FROM test_table WHERE false"),
      );

      expect(result.rows).toHaveLength(0);
    }, 1000);
  });

  describe("Error Handling", () => {
    let driver: BunDriver;
    let connection: BunConnection;

    beforeEach(async () => {
      driver = new BunDriver(TEST_CONFIG);
      connection = await driver.acquireConnection();
      // Create a test table for our error tests
      await connection.executeQuery(
        CompiledQuery.raw(
          "CREATE TEMPORARY TABLE error_test (id serial PRIMARY KEY, value text NOT NULL UNIQUE)",
        ),
      );
    });

    afterEach(async () => {
      if (connection) {
        await connection.executeQuery(
          CompiledQuery.raw("DROP TABLE IF EXISTS error_test"),
        );
        await driver.releaseConnection(connection);
      }
      await driver.destroy();
    });

    test("should handle syntax errors", async () => {
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("SELCT * FROM error_test"), // Intentional typo
        ),
      ).rejects.toThrow(/syntax error/i);
    }, 1000);

    test("should handle constraint violations", async () => {
      // Insert initial row
      await connection.executeQuery(
        CompiledQuery.raw("INSERT INTO error_test (value) VALUES ($1)", [
          "unique_value",
        ]),
      );

      // Try to insert duplicate value (UNIQUE constraint violation)
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("INSERT INTO error_test (value) VALUES ($1)", [
            "unique_value",
          ]),
        ),
      ).rejects.toThrow(/unique constraint/i);

      // Try to insert NULL (NOT NULL constraint violation)
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("INSERT INTO error_test (value) VALUES ($1)", [
            null,
          ]),
        ),
      ).rejects.toThrow(/null constraint/i);
    }, 1000);

    test("should handle invalid parameter types", async () => {
      await expect(
        connection.executeQuery(
          CompiledQuery.raw(
            "INSERT INTO error_test (id) VALUES ($1)",
            ["not_a_number"], // id is serial (integer)
          ),
        ),
      ).rejects.toThrow(/invalid input syntax/i);
    }, 1000);

    test("should handle table not found errors", async () => {
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("SELECT * FROM nonexistent_table"),
        ),
      ).rejects.toThrow(/relation.*does not exist/i);
    }, 1000);

    test("should handle column not found errors", async () => {
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("SELECT nonexistent_column FROM error_test"),
        ),
      ).rejects.toThrow(/column.*does not exist/i);
    }, 1000);

    test("should handle parameter count mismatch", async () => {
      await expect(
        connection.executeQuery(
          CompiledQuery.raw("INSERT INTO error_test (value) VALUES ($1, $2)", [
            "too_few_params",
          ]),
        ),
      ).rejects.toThrow();
    }, 1000);
  });
});
