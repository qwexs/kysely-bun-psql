import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { CompiledQuery, Kysely, type ControlConnectionProvider } from "kysely";
import { BunConnection } from "../src/connection";
import { BunDialect } from "../src/index";

// Integration only: run against the disposable DATABASE_URL selected by the main runner.
// Every table below is temporary and belongs to an explicitly reserved session.
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a disposable PostgreSQL database for native connection tests",
  );
}

function createPool() {
  return new SQL(databaseUrl!, {
    max: 1,
    connectionTimeout: 5,
    connection: { statement_timeout: "10000" },
  });
}

async function withConnection(
  run: (connection: BunConnection) => Promise<void>,
) {
  const pool = createPool();
  const connection = new BunConnection(await pool.reserve());
  try {
    await run(connection);
  } finally {
    try {
      await connection.releaseConnection();
    } finally {
      await pool.close();
    }
  }
}

async function waitForSleep(observer: SQL, pid: number, marker: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await observer<
      { state: string; wait_event: string; query: string }[]
    >`
      select state, wait_event, query from pg_stat_activity where pid = ${pid}
    `;
    if (
      rows[0]?.state === "active" &&
      rows[0].wait_event === "PgSleep" &&
      rows[0].query.includes(marker)
    )
      return;
  }
  throw new Error(`Session ${pid} did not enter pg_sleep for ${marker}`);
}

const unusedControlProvider: ControlConnectionProvider = async () => {
  throw new Error(
    "native cancellation must not acquire another pool connection",
  );
};

async function sessionPid(connection: BunConnection) {
  const { rows } = await connection.executeQuery<{ pid: number }>(
    CompiledQuery.raw("select pg_backend_pid() as pid"),
  );
  return rows[0]!.pid;
}

describe("native BunConnection runtime contracts", () => {
  test("transaction accessMode and PostgreSQL isolation levels reach the server", async () => {
    await withConnection(async (connection) => {
      for (const isolationLevel of [
        "read uncommitted",
        "read committed",
        "repeatable read",
        "serializable",
      ] as const) {
        for (const accessMode of ["read only", "read write"] as const) {
          await connection.beginTransaction({ isolationLevel, accessMode });
          try {
            const { rows } = await connection.executeQuery<{
              isolation: string;
              read_only: string;
            }>(
              CompiledQuery.raw(
                "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
              ),
            );
            expect(rows).toEqual([
              {
                isolation: isolationLevel,
                read_only: accessMode === "read only" ? "on" : "off",
              },
            ]);
          } finally {
            await connection.rollbackTransaction();
          }
        }
      }
      await connection.beginTransaction({ accessMode: "read only" });
      try {
        const { rows } = await connection.executeQuery<{
          transaction_read_only: string;
        }>(CompiledQuery.raw("show transaction_read_only"));
        expect(rows).toEqual([{ transaction_read_only: "on" }]);
      } finally {
        await connection.rollbackTransaction();
      }
    });
  }, 15000);

  test("INSERT/UPDATE/DELETE/MERGE use native counts; SELECT has no affected-row property", async () => {
    await withConnection(async (connection) => {
      await connection.executeQuery(
        CompiledQuery.raw(
          "create temporary table native_connection_rows (id integer primary key, value integer)",
        ),
      );
      expect(
        await connection.executeQuery(
          CompiledQuery.raw(
            "insert into native_connection_rows values (1, 10), (2, 20)",
          ),
        ),
      ).toEqual({ rows: [], numAffectedRows: 2n });
      expect(
        await connection.executeQuery(
          CompiledQuery.raw(
            "update native_connection_rows set value = value + 1 returning id",
          ),
        ),
      ).toEqual({ rows: [{ id: 1 }, { id: 2 }], numAffectedRows: 2n });
      expect(
        await connection.executeQuery(
          CompiledQuery.raw(
            "delete from native_connection_rows where id = 999",
          ),
        ),
      ).toEqual({ rows: [], numAffectedRows: 0n });
      expect(
        await connection.executeQuery(
          CompiledQuery.raw(`
        merge into native_connection_rows as target
        using (values (1, 100), (3, 300)) as source(id, value)
        on target.id = source.id
        when matched then update set value = source.value
        when not matched then insert (id, value) values (source.id, source.value)
      `),
        ),
      ).toEqual({ rows: [], numAffectedRows: 2n });
      expect(
        await connection.executeQuery(
          CompiledQuery.raw(
            "select id, value from native_connection_rows order by id",
          ),
        ),
      ).toStrictEqual({
        rows: [
          { id: 1, value: 100 },
          { id: 2, value: 21 },
          { id: 3, value: 300 },
        ],
      });
    });
  }, 15000);

  test("cancelQuery produces server SQLSTATE 57014 and leaves the same session reusable", async () => {
    const observer = createPool();
    try {
      await withConnection(async (connection) => {
        const pid = await sessionPid(connection);
        const marker = `native_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
        const outcome = connection
          .executeQuery(
            CompiledQuery.raw(`select pg_sleep(30) /* ${marker} */`),
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        try {
          await waitForSleep(observer, pid, marker);
          await connection.cancelQuery(unusedControlProvider);
          const error = await outcome;
          expect(error).toBeInstanceOf(SQL.PostgresError);
          expect(error).toMatchObject({
            code: "ERR_POSTGRES_SERVER_ERROR",
            errno: "57014",
          });
          expect(await sessionPid(connection)).toBe(pid);
          expect(
            await connection.executeQuery(
              CompiledQuery.raw("select 42 as value"),
            ),
          ).toStrictEqual({ rows: [{ value: 42 }] });
        } finally {
          await connection.cancelQuery(unusedControlProvider);
          await outcome;
        }
      });
    } finally {
      await observer.close();
    }
  }, 15000);

  test("direct in-flight AbortSignal does not cancel SQL or replace its result", async () => {
    const observer = createPool();
    try {
      await withConnection(async (connection) => {
        const pid = await sessionPid(connection);
        const controller = new AbortController();
        const reason = new Error("native operation aborted");
        const marker = `native_signal_${crypto.randomUUID().replaceAll("-", "")}`;
        const outcome = connection
          .executeQuery(
            CompiledQuery.raw(
              `select 42 as value from pg_sleep(2) /* ${marker} */`,
            ),
            {
              signal: controller.signal,
            },
          )
          .then(
            (result) => result,
            (error: unknown) => error,
          );
        try {
          await waitForSleep(observer, pid, marker);
          controller.abort(reason);
          expect(await outcome).toStrictEqual({ rows: [{ value: 42 }] });
          expect(await sessionPid(connection)).toBe(pid);
          const state = await observer<
            { state: string }[]
          >`select state from pg_stat_activity where pid = ${pid}`;
          expect(state[0]?.state).not.toBe("active");
        } finally {
          await connection.cancelQuery(unusedControlProvider);
          await outcome;
        }
      });
    } finally {
      await observer.close();
    }
  }, 15000);

  test("real Kysely ignore query lets an aborted INSERT finish and persist on the same session", async () => {
    const pool = createPool();
    const observer = createPool();
    const db = new Kysely<Record<string, never>>({
      dialect: new BunDialect({ sql: pool }),
    });
    const controller = new AbortController();
    const reason = new Error("stop waiting for INSERT, not its execution");
    let outcome: Promise<unknown> | undefined;
    try {
      const initial = await pool.reserve();
      let pid: number;
      try {
        await initial`create temporary table native_ignored_abort (value integer not null)`;
        const rows = await initial<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        pid = rows[0]!.pid;
      } finally {
        await initial.release();
      }
      const marker = `native_ignore_${crypto.randomUUID().replaceAll("-", "")}`;
      outcome = db
        .executeQuery(
          CompiledQuery.raw(`
        with delay as materialized (select pg_sleep(3))
        insert into native_ignored_abort (value) select 42 from delay
        returning value /* ${marker} */
      `),
          {
            signal: controller.signal,
            inflightQueryAbortStrategy: "ignore query",
          },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await waitForSleep(observer, pid, marker);
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      // No cancel hook: acquiring the only reservation waits for the INSERT's
      // natural completion. The persisted row proves that SQL was not cancelled.
      const reserved = await pool.reserve();
      try {
        expect(
          Array.from(await reserved`select pg_backend_pid() as pid`),
        ).toEqual([{ pid }]);
        expect(
          Array.from(await reserved`select value from native_ignored_abort`),
        ).toEqual([{ value: 42 }]);
      } finally {
        await reserved.release();
      }
    } finally {
      controller.abort(reason);
      await outcome;
      await db.destroy();
      await pool.close();
      await observer.close();
    }
  }, 15000);

  test("real Kysely executor cancellation returns the reason and safely releases a max:1 reservation", async () => {
    const pool = createPool();
    const observer = createPool();
    const db = new Kysely<Record<string, never>>({
      dialect: new BunDialect({ sql: pool }),
    });
    const controller = new AbortController();
    const reason = new Error("Kysely operation aborted");
    let outcome: Promise<unknown> | undefined;
    try {
      const [{ pid }] = await pool<
        { pid: number }[]
      >`select pg_backend_pid() as pid`;
      const marker = `native_executor_${crypto.randomUUID().replaceAll("-", "")}`;
      outcome = db
        .executeQuery(
          CompiledQuery.raw(`select pg_sleep(30) /* ${marker} */`),
          {
            signal: controller.signal,
            inflightQueryAbortStrategy: "cancel query",
          },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await waitForSleep(observer, pid, marker);
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      // reserve() can only resolve after Kysely's background cancellation and
      // query promises settle. No additional pool connection is available.
      const reserved = await pool.reserve();
      try {
        expect(
          Array.from(
            await reserved`select pg_backend_pid() as pid, 42 as value`,
          ),
        ).toEqual([{ pid, value: 42 }]);
        const state = await observer<
          { state: string }[]
        >`select state from pg_stat_activity where pid = ${pid}`;
        expect(state[0]?.state).not.toBe("active");
      } finally {
        await reserved.release();
      }
    } finally {
      controller.abort(reason);
      await outcome;
      await db.destroy();
      await pool.close();
      await observer.close();
    }
  }, 15000);
});
