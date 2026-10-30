import { sql as bunSql } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type ControlConnectionProvider,
  type TransactionSettings,
} from "kysely";
import { BunConnection } from "../../src/connection";
import { BunDialectError } from "../../src/index";
import { createFakeReservedSQL } from "./fake-reserved-sql";

describe("BunConnection without a database", () => {
  test("maps SELECT rows without exposing native result metadata", async () => {
    const rows = [
      { id: 1, name: "Alice", metadata: { active: true } },
      { id: 2, name: null, metadata: null },
    ];
    const fake = createFakeReservedSQL({ rows, count: 2, affectedRows: 99 });
    const connection = new BunConnection(fake.reserved);

    const result = await connection.executeQuery<(typeof rows)[number]>(
      CompiledQuery.raw("select * from person"),
    );

    expect(result).toStrictEqual({ rows });
    expect(result.rows[0]).toBe(rows[0]);
    expect(Object.keys(result.rows)).toEqual(["0", "1"]);
  });

  test("returns an empty SELECT result without an affected-row count", async () => {
    const fake = createFakeReservedSQL({ count: 0 });
    const connection = new BunConnection(fake.reserved);

    expect(
      await connection.executeQuery(CompiledQuery.raw("select 1 where false")),
    ).toStrictEqual({ rows: [] });
  });

  describe.each(["INSERT", "UPDATE", "DELETE", "MERGE"])(
    "%s results",
    (command) => {
      test.each([0, 7])(
        "uses protocol count %i without RETURNING",
        async (count) => {
          const fake = createFakeReservedSQL({ command, count });
          const connection = new BunConnection(fake.reserved);

          const result = await connection.executeQuery(
            CompiledQuery.raw(command),
          );

          expect(result).toStrictEqual({
            rows: [],
            numAffectedRows: BigInt(count),
          });
        },
      );

      test.each([0, 9])(
        "prefers native affectedRows %i over count and rows",
        async (affectedRows) => {
          const fake = createFakeReservedSQL({
            command,
            affectedRows,
            count: 7,
            rows: [{ id: 1 }],
          });
          const connection = new BunConnection(fake.reserved);
          expect(
            await connection.executeQuery(CompiledQuery.raw(command)),
          ).toStrictEqual({
            rows: [{ id: 1 }],
            numAffectedRows: BigInt(affectedRows),
          });
        },
      );

      test("preserves RETURNING rows and prefers protocol count", async () => {
        const rows = [{ id: 11 }, { id: 12 }];
        const fake = createFakeReservedSQL({ command, count: 7, rows });
        const connection = new BunConnection(fake.reserved);

        const result = await connection.executeQuery<{ id: number }>(
          CompiledQuery.raw(`${command} returning id`),
        );

        expect(result).toStrictEqual({ rows, numAffectedRows: 7n });
      });

      test("falls back to RETURNING row count when protocol count is absent", async () => {
        const rows = [{ id: 11 }, { id: 12 }];
        const fake = createFakeReservedSQL({ command, rows });
        const connection = new BunConnection(fake.reserved);

        const result = await connection.executeQuery(
          CompiledQuery.raw(`${command} returning id`),
        );

        expect(result).toStrictEqual({ rows, numAffectedRows: 2n });
      });
    },
  );

  test("forwards SQL and native parameters by identity without mutating the query", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);
    const array = ['a"b', "c\\d", null];
    const object = { active: true };
    const nativeJson = bunSql.json([1, 2]);
    const parameters = [array, object, nativeJson, null, 42];
    const query = CompiledQuery.raw("select $1, $2, $3, $4, $5", parameters);

    await connection.executeQuery(query);

    expect(fake.calls).toStrictEqual([
      {
        sql: query.sql,
        parameters,
      },
    ]);
    expect(fake.calls[0]?.parameters[0]).toBe(array);
    expect(fake.calls[0]?.parameters[1]).toBe(object);
    expect(fake.calls[0]?.parameters[2]).toBe(nativeJson);
    expect(parameters[0]).toBe(array);
    expect(array).toEqual(['a"b', "c\\d", null]);
    expect(query.parameters).toEqual(parameters);
  });

  test("propagates the original query error and allows explicit release afterward", async () => {
    const error = new Error("query rejected");
    const fake = createFakeReservedSQL({ error });
    const connection = new BunConnection(fake.reserved);

    await expect(
      connection.executeQuery(CompiledQuery.raw("select 1")),
    ).rejects.toBe(error);
    expect(fake.releases).toBe(0);

    await connection.releaseConnection();
    expect(fake.releases).toBe(1);
  });

  test("releases the reserved client after a successful query", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);

    await connection.executeQuery(CompiledQuery.raw("select 1"));
    expect(fake.releases).toBe(0);
    await connection.releaseConnection();

    expect(fake.releases).toBe(1);
  });

  test("propagates the original release rejection", async () => {
    const error = new Error("release rejected");
    const fake = createFakeReservedSQL({ releaseError: error });
    const connection = new BunConnection(fake.reserved);

    await expect(connection.releaseConnection()).rejects.toBe(error);
    expect(fake.releases).toBe(1);
  });

  test("rejects streaming with BunDialectError without executing SQL", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);

    await expect(connection.streamQuery().next()).rejects.toBeInstanceOf(
      BunDialectError,
    );
    await expect(connection.streamQuery().next()).rejects.toThrow(
      "streamQuery is not supported",
    );
    expect(fake.calls).toEqual([]);
  });

  test("begins, commits, and rolls back transactions", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);

    await connection.beginTransaction({});
    await connection.commitTransaction();
    await connection.rollbackTransaction();

    expect(fake.calls).toEqual([
      { sql: "begin", parameters: [] },
      { sql: "commit", parameters: [] },
      { sql: "rollback", parameters: [] },
    ]);
  });

  test("requests the configured transaction isolation level", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);

    await connection.beginTransaction({ isolationLevel: "serializable" });

    expect(fake.calls).toEqual([
      { sql: "start transaction isolation level serializable", parameters: [] },
    ]);
  });

  test.each([
    "read uncommitted",
    "read committed",
    "repeatable read",
    "serializable",
  ] as const)(
    "combines %s and read-only access mode",
    async (isolationLevel) => {
      const fake = createFakeReservedSQL();
      const connection = new BunConnection(fake.reserved);
      await connection.beginTransaction({
        isolationLevel,
        accessMode: "read only",
      });
      expect(fake.calls[0]?.sql).toBe(
        `start transaction isolation level ${isolationLevel} read only`,
      );
    },
  );

  test.each(["read only", "read write"] as const)(
    "requests %s without isolation",
    async (accessMode) => {
      const fake = createFakeReservedSQL();
      await new BunConnection(fake.reserved).beginTransaction({ accessMode });
      expect(fake.calls[0]?.sql).toBe(`start transaction ${accessMode}`);
    },
  );

  test.each([
    { isolationLevel: "snapshot" },
    { isolationLevel: "serializable; commit" },
    { accessMode: "read only; commit" },
  ])(
    "rejects unsupported transaction settings before SQL: %j",
    async (settings) => {
      const fake = createFakeReservedSQL();
      await expect(
        new BunConnection(fake.reserved).beginTransaction(
          settings as TransactionSettings,
        ),
      ).rejects.toBeInstanceOf(BunDialectError);
      expect(fake.calls).toEqual([]);
    },
  );

  test("propagates transaction query errors", async () => {
    const error = new Error("transaction rejected");
    const fake = createFakeReservedSQL({ error });
    const connection = new BunConnection(fake.reserved);

    await expect(connection.beginTransaction({})).rejects.toBe(error);
    await expect(connection.commitTransaction()).rejects.toBe(error);
    await expect(connection.rollbackTransaction()).rejects.toBe(error);
  });
});

function createDatabase(connection: BunConnection, released: () => void) {
  return new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          return connection;
        },
        async releaseConnection() {
          await connection.releaseConnection();
          released();
        },
        async beginTransaction(_connection, settings) {
          await connection.beginTransaction(settings);
        },
        async commitTransaction() {
          await connection.commitTransaction();
        },
        async rollbackTransaction() {
          await connection.rollbackTransaction();
        },
        async destroy() {},
      }),
    },
  });
}

const noControlConnection: ControlConnectionProvider = async () => {
  throw new Error("native cancellation must not acquire a control connection");
};
const cancelled = () =>
  Object.assign(new Error("canceling statement due to user request"), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "57014",
  });

async function checkpoint() {
  // Flush continuations without a wall-clock delay.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("BunConnection cancellation", () => {
  test.each([new Error("stop"), "stop", null])(
    "pre-abort preserves the original reason %p without SQL",
    async (reason) => {
      const fake = createFakeReservedSQL();
      const controller = new AbortController();
      controller.abort(reason);
      const add = spyOn(controller.signal, "addEventListener");
      try {
        await expect(
          new BunConnection(fake.reserved).executeQuery(
            CompiledQuery.raw("select 1"),
            {
              signal: controller.signal,
            },
          ),
        ).rejects.toBe(reason);
        expect(fake.calls).toEqual([]);
        expect(add).not.toHaveBeenCalled();
      } finally {
        add.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "does not install connection-level abort listeners (error: %p)",
    async (fail) => {
      const error = new Error("failure");
      const fake = createFakeReservedSQL(fail ? { error } : {});
      const controller = new AbortController();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      try {
        const promise = new BunConnection(fake.reserved).executeQuery(
          CompiledQuery.raw("select 1"),
          { signal: controller.signal },
        );
        if (fail) await expect(promise).rejects.toBe(error);
        else await promise;
        expect(add).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        controller.abort();
        expect(fake.queries[0]?.cancels).toBe(0);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "only the hook cancels once and waits for native settlement (native success: %p)",
    async (nativeSuccess) => {
      const fake = createFakeReservedSQL({ deferred: true });
      const connection = new BunConnection(fake.reserved);
      const controller = new AbortController();
      const reason = new Error("original abort reason");
      const nativeError = cancelled();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      try {
        let finished = false;
        const query = connection.executeQuery(
          CompiledQuery.raw("select pg_sleep(30)"),
          { signal: controller.signal },
        );
        const outcome = query.then(
          (result) => {
            finished = true;
            return result;
          },
          (error: unknown) => {
            finished = true;
            return error;
          },
        );
        await fake.queries[0]!.started;
        controller.abort(reason);
        expect(fake.queries[0]?.cancels).toBe(0);
        let hookFinished = false;
        const hook = connection.cancelQuery(noControlConnection).then(() => {
          hookFinished = true;
        });
        const repeatedHook = connection.cancelQuery(noControlConnection);
        const release = connection.releaseConnection();
        await checkpoint();
        expect(fake.queries[0]?.cancels).toBe(1);
        expect(finished).toBe(false);
        expect(hookFinished).toBe(false);
        expect(fake.releases).toBe(0);
        if (nativeSuccess) fake.queries[0]!.resolve();
        else fake.queries[0]!.reject(nativeError);
        if (nativeSuccess) expect(await outcome).toEqual({ rows: [] });
        else expect(await outcome).toBe(nativeError);
        await hook;
        await repeatedHook;
        await release;
        expect(fake.releases).toBe(1);
        expect(add).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(fake.calls).toHaveLength(1); // no automatic retry
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "a direct in-flight signal preserves native settlement without cancellation (error: %p)",
    async (fail) => {
      const fake = createFakeReservedSQL({
        deferred: true,
        rows: [{ value: 42 }],
      });
      const connection = new BunConnection(fake.reserved);
      const controller = new AbortController();
      const nativeError = new Error("native failure after abort");
      let finished = false;
      const outcome = connection
        .executeQuery(CompiledQuery.raw("select 42"), {
          signal: controller.signal,
        })
        .then(
          (result) => {
            finished = true;
            return result;
          },
          (error: unknown) => {
            finished = true;
            return error;
          },
        );
      await fake.started;
      controller.abort(new Error("direct abort"));
      await checkpoint();
      expect(finished).toBe(false);
      expect(fake.queries[0]?.cancels).toBe(0);
      if (fail) fake.queries[0]!.reject(nativeError);
      else fake.queries[0]!.resolve();
      if (fail) expect(await outcome).toBe(nativeError);
      else expect(await outcome).toEqual({ rows: [{ value: 42 }] });
      expect(fake.calls).toHaveLength(1);
    },
  );

  test("hook exposes the native SQLSTATE to the query, and is a no-op when idle", async () => {
    const fake = createFakeReservedSQL({ deferred: true });
    const connection = new BunConnection(fake.reserved);
    await connection.cancelQuery(noControlConnection);
    expect(fake.calls).toEqual([]);
    const query = connection.executeQuery(
      CompiledQuery.raw("select pg_sleep(30)"),
    );
    const error = cancelled();
    const outcome = query.catch((error: unknown) => error);
    await fake.queries[0]!.started;
    const hook = connection.cancelQuery(noControlConnection);
    fake.queries[0]!.reject(error);
    await hook;
    expect(await outcome).toBe(error);
    await connection.cancelQuery(noControlConnection);
    expect(fake.queries[0]?.cancels).toBe(1);
  });

  test("a completion that wins native cancellation is not retried", async () => {
    const fake = createFakeReservedSQL({
      deferred: true,
      rows: [{ value: 1 }],
    });
    const connection = new BunConnection(fake.reserved);
    const query = connection.executeQuery(CompiledQuery.raw("select 1"));
    await fake.queries[0]!.started;
    const hook = connection.cancelQuery(noControlConnection);
    fake.queries[0]!.resolve();
    expect(await query).toEqual({ rows: [{ value: 1 }] });
    await hook;
    expect(fake.calls).toHaveLength(1);
  });

  test("does not pipeline queued SQL or execute a queued pre-aborted operation", async () => {
    const fake = createFakeReservedSQL({ deferred: true });
    const connection = new BunConnection(fake.reserved);
    const first = connection.executeQuery(CompiledQuery.raw("select 1"));
    await fake.queries[0]!.started;
    const controller = new AbortController();
    const reason = new Error("queued abort");
    const second = connection.executeQuery(CompiledQuery.raw("select 2"), {
      signal: controller.signal,
    });
    const secondOutcome = second.catch((error: unknown) => error);
    const third = connection.executeQuery(CompiledQuery.raw("select 3"));
    controller.abort(reason);
    expect(fake.calls).toHaveLength(1);
    fake.queries[0]!.resolve();
    await first;
    expect(await secondOutcome).toBe(reason);
    await fake.queries[1]!.started;
    expect(fake.calls.map((call) => call.sql)).toEqual([
      "select 1",
      "select 3",
    ]);
    fake.queries[1]!.resolve();
    await third;
  });

  test("an ambiguous native cancellation drains the session before query/hook/release settle", async () => {
    const fake = createFakeReservedSQL({ deferred: true });
    const connection = new BunConnection(fake.reserved);
    const error = Object.assign(new Error("cancel request not delivered"), {
      code: "ERR_POSTGRES_QUERY_CANCELLED",
      hint: "server may still run the query",
    });
    const query = connection.executeQuery(
      CompiledQuery.raw("select pg_sleep(30)"),
    );
    let finished = false;
    const outcome = query.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await fake.queries[0]!.started;
    const hook = connection.cancelQuery(noControlConnection);
    const release = connection.releaseConnection();
    fake.queries[0]!.reject(error);
    await checkpoint();
    expect(fake.calls.map((call) => call.sql)).toEqual([
      "select pg_sleep(30)",
      "select 1",
    ]);
    expect(finished).toBe(false);
    expect(fake.releases).toBe(0);
    fake.queries[1]!.reject(
      Object.assign(new Error("failed transaction"), { errno: "25P02" }),
    );
    expect(await outcome).toBe(error);
    await hook;
    await release;
    expect(fake.releases).toBe(1);
  });

  test("release rejects queued SQL instead of letting it use a returned reservation", async () => {
    const fake = createFakeReservedSQL({ deferred: true });
    const connection = new BunConnection(fake.reserved);
    const first = connection.executeQuery(CompiledQuery.raw("select 1"));
    await fake.queries[0]!.started;
    const second = connection.executeQuery(CompiledQuery.raw("select 2"));
    const secondOutcome = second.catch((error: unknown) => error);
    const release = connection.releaseConnection();
    fake.queries[0]!.resolve();
    await first;
    expect(await secondOutcome).toBeInstanceOf(BunDialectError);
    await release;
    expect(fake.calls).toHaveLength(1);
  });

  test.each([undefined, "ignore query"] as const)(
    "the real Kysely executor ignores in-flight SQL on abort without cancelling it (strategy: %p)",
    async (inflightQueryAbortStrategy) => {
      const rows = [{ value: "write completed" }];
      const fake = createFakeReservedSQL({
        deferred: true,
        command: "INSERT",
        affectedRows: 1,
        rows,
      });
      const connection = new BunConnection(fake.reserved);
      const released = Promise.withResolvers<void>();
      const db = createDatabase(connection, released.resolve);
      const hook = spyOn(connection, "cancelQuery");
      const execute = spyOn(connection, "executeQuery");
      const controller = new AbortController();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      const reason = new Error("stop waiting, not the SQL");
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const outcome = db
          .executeQuery(
            CompiledQuery.raw(
              "insert into example values (42) returning value",
            ),
            {
              signal: controller.signal,
              inflightQueryAbortStrategy,
            },
          )
          .catch((error: unknown) => error);
        await fake.started;
        const nativeOutcome = execute.mock.results[0]!.value;
        controller.abort(reason);
        expect(await outcome).toBe(reason);
        expect(hook).not.toHaveBeenCalled();
        expect(fake.queries[0]?.cancels).toBe(0);
        expect(fake.releases).toBe(0);
        expect(add.mock.calls.length).toBeGreaterThan(0);
        for (const [type, listener] of add.mock.calls) {
          expect(remove).toHaveBeenCalledWith(type, listener);
        }
        fake.queries[0]!.resolve();
        expect(await nativeOutcome).toEqual({ rows, numAffectedRows: 1n });
        await released.promise;
        expect(fake.releases).toBe(1);
        expect(fake.calls).toHaveLength(1);
        expect(log).not.toHaveBeenCalled();
      } finally {
        hook.mockRestore();
        execute.mockRestore();
        add.mockRestore();
        remove.mockRestore();
        log.mockRestore();
        await db.destroy();
      }
    },
  );

  test("the real Kysely executor returns the original reason but holds the reservation until query and hook settle", async () => {
    const fake = createFakeReservedSQL({ deferred: true });
    const connection = new BunConnection(fake.reserved);
    const released = Promise.withResolvers<void>();
    const db = createDatabase(connection, released.resolve);
    const hookBarrier = Promise.withResolvers<void>();
    const originalCancel = connection.cancelQuery.bind(connection);
    const hookSpy = spyOn(connection, "cancelQuery").mockImplementation(
      async (provider) => {
        await originalCancel(provider);
        await hookBarrier.promise;
      },
    );
    const controller = new AbortController();
    const reason = new Error("executor abort");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const query = db.executeQuery(CompiledQuery.raw("select pg_sleep(30)"), {
        signal: controller.signal,
        inflightQueryAbortStrategy: "cancel query",
      });
      const outcome = query.catch((error: unknown) => error);
      await fake.started;
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      expect(fake.releases).toBe(0);
      expect(fake.queries[0]?.cancels).toBe(1);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      fake.queries[0]!.reject(cancelled());
      await checkpoint();
      expect(fake.releases).toBe(0);
      hookBarrier.resolve();
      await released.promise;
      expect(fake.releases).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      hookBarrier.resolve();
      hookSpy.mockRestore();
      log.mockRestore();
      await db.destroy();
    }
  });
});
