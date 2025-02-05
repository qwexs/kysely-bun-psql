import { CompiledQuery } from "kysely";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { BunDriver } from "../src/driver";
import { BunConnection } from "../src/connection";

const TEST_CONFIG = {
  url: "postgres://admin@localhost:5434/test",
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
          await driver.beginTransaction(connection, {});
          await connection.executeQuery(
            CompiledQuery.raw(
              "CREATE TEMPORARY TABLE IF NOT EXISTS test_rollback (id serial PRIMARY KEY)",
            ),
          );
          await driver.rollbackTransaction(connection);

          // Verify table doesn't exist after rollback
          await expect(
            connection.executeQuery(
              CompiledQuery.raw("SELECT * FROM test_rollback"),
            ),
          ).rejects.toThrow();
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
          await connection.executeQuery(CompiledQuery.raw("SELECT 1"));
          await driver.commitTransaction(connection);
        } finally {
          await driver.releaseConnection(connection);
        }
      }, 1000);
    });

    describe("connection management", () => {
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
        // Create a driver with a non-existent host that will fail quickly
        const timeoutDriver = new BunDriver({
          url: "postgres://admin@non.existent.host:5434/test",
          connectionTimeout: 100,
        });

        try {
          await expect(timeoutDriver.acquireConnection()).rejects.toThrow(
            /getaddrinfo|connection|network/i,
          );
        } finally {
          await timeoutDriver.destroy();
        }
      }, 500);

      test("should handle authentication errors", async () => {
        // Create a driver with invalid credentials
        const badDriver = new BunDriver({
          url: "postgres://invalid:invalid@localhost:5434/nonexistent",
        });

        try {
          await expect(badDriver.acquireConnection()).rejects.toThrow(
            /role.*does not exist/i,
          );
        } finally {
          await badDriver.destroy();
        }
      }, 1000);

      test("should handle connection refused", async () => {
        // Create a driver pointing to a non-existent server
        const unreachableDriver = new BunDriver({
          url: "postgres://admin@localhost:5435/test", // Wrong port
        });

        try {
          await expect(unreachableDriver.acquireConnection()).rejects.toThrow(
            /connection closed|ECONNREFUSED|connect failed/i,
          );
        } finally {
          await unreachableDriver.destroy();
        }
      }, 1000);
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
