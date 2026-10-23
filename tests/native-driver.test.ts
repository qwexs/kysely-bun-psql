import { describe, expect, test } from "bun:test";
import { SQL, type ReservedSQL } from "bun";
import { CompiledQuery, Kysely, sql } from "kysely";
import { BunConnection } from "../src/connection";
import { BunDialect } from "../src/dialect";
import { BunDriver } from "../src/driver";
import type { BunDialectConfig } from "../src/types";

// Independent of tests/setup.ts: these tests need no shared tables or schemas.
// Run explicitly against a disposable PostgreSQL DATABASE_URL.
const databaseUrl = process.env["DATABASE_URL"];

function config() {
  if (!databaseUrl) {
    throw new Error(
      "Set DATABASE_URL before running native-driver integration tests",
    );
  }
  return { url: databaseUrl, max: 1, connectionTimeout: 5, closeTimeout: 1 };
}

function database(options: BunDialectConfig) {
  return new Kysely<Record<string, never>>({
    dialect: new BunDialect(options),
  });
}

async function within<T>(
  operation: PromiseLike<T>,
  name: string,
  milliseconds = 3000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe.skipIf(!databaseUrl)("native Bun PostgreSQL driver", () => {
  test("passes startup parameters and prepare:false to actual SQL connections", async () => {
    const db = database({
      ...config(),
      prepare: false,
      connection: {
        application_name: "kysely-native-driver",
        search_path: "pg_catalog",
        statement_timeout: 2000,
      },
    });
    try {
      await db.connection().execute(async (connection) => {
        const settings = await sql<{
          application_name: string;
          search_path: string;
          statement_timeout: string;
        }>`select current_setting('application_name') as application_name,
                  current_setting('search_path') as search_path,
                  current_setting('statement_timeout') as statement_timeout`.execute(
          connection,
        );
        expect(settings.rows[0]).toEqual({
          application_name: "kysely-native-driver",
          search_path: "pg_catalog",
          statement_timeout: "2s",
        });

        const value = "quote'; select 99; --";
        for (let i = 0; i < 2; i++) {
          const result = await sql<{
            value: string;
          }>`select ${value}::text as value`.execute(connection);
          expect(result.rows).toEqual([{ value }]);
        }
        const prepared = await sql<{ prepared_count: number }>`
          select count(*)::integer as prepared_count from pg_prepared_statements
        `.execute(connection);
        expect(prepared.rows[0]?.prepared_count).toBe(0);
      });
    } finally {
      await db.destroy();
    }
  });

  test("db.destroy leaves an external pool open by default", async () => {
    const client = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 5 });
    const db = database({ sql: client });
    try {
      expect(
        (await sql<{ answer: number }>`select 42 as answer`.execute(db)).rows,
      ).toEqual([{ answer: 42 }]);
      await db.destroy();
      const result = await client`select 43 as answer`;
      expect(result[0].answer).toBe(43);
      const nextDb = database({ sql: client });
      try {
        expect(
          (await sql<{ answer: number }>`select 44 as answer`.execute(nextDb))
            .rows,
        ).toEqual([{ answer: 44 }]);
      } finally {
        await nextDb.destroy();
      }
    } finally {
      await db.destroy();
      await client.close({ timeout: 0 });
    }
  });

  test("shared external SQL delivers LISTEN/NOTIFY payloads across db.destroy", async () => {
    const client = new SQL({
      url: databaseUrl,
      max: 1,
      connectionTimeout: 2,
      connection: { statement_timeout: 2000 },
    });
    const db = database({ sql: client });
    const channel = `native_driver_${crypto.randomUUID().replaceAll("-", "")}`;
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    const received: string[] = [];
    let subscription: SQL.ListenSubscription | undefined;
    try {
      await within(sql`select 1`.execute(db), "Kysely query before LISTEN");
      // listen() resolves only after the server has acknowledged the subscription.
      // Keep the handle even if registration finishes after the deadline.
      await within(
        client
          .listen(channel, (payload) => {
            received.push(payload);
            if (received.length === 1) first.resolve(payload);
            else if (received.length === 2) second.resolve(payload);
          })
          .then((registered) => {
            subscription = registered;
          }),
        "LISTEN",
      );
      const payload = JSON.stringify({ value: 'Привет, "Bun"!', id: channel });
      await within(client.notify(channel, payload), "NOTIFY");
      expect(await within(first.promise, "first notification delivery")).toBe(
        payload,
      );

      await within(db.destroy(), "non-owning db.destroy");
      const afterDestroy = JSON.stringify({
        value: "external client still owns LISTEN",
      });
      await within(
        client.notify(channel, afterDestroy),
        "NOTIFY after db.destroy",
      );
      expect(
        await within(second.promise, "notification delivery after db.destroy"),
      ).toBe(afterDestroy);
      expect(received).toEqual([payload, afterDestroy]);
    } finally {
      try {
        if (subscription) await within(subscription.unlisten(), "UNLISTEN");
      } finally {
        try {
          await within(db.destroy(), "db cleanup");
        } finally {
          await client.close({ timeout: 0 });
        }
      }
    }
  }, 20000);

  test("shared external SQL COPY streams round-trip bytes on one reserved session", async () => {
    const client = new SQL({
      url: databaseUrl,
      max: 1,
      connectionTimeout: 2,
      connection: { statement_timeout: 2000 },
    });
    const db = database({ sql: client });
    const driver = new BunDriver({ sql: client });
    try {
      const reserved = await client.reserve({
        signal: AbortSignal.timeout(3000),
      });
      const connection = new BunConnection(reserved);
      try {
        // Compile with Kysely, but execute on the already reserved session:
        // db.executeQuery here would try to reserve the only connection again.
        await within(
          connection.executeQuery(
            sql`
          create temporary table native_driver_copy (id integer, value text)
        `.compile(db),
          ),
          "create COPY temp table",
        );
        const input = new TextEncoder().encode(
          '1,"Привет, ""Bun""!"\n2,\n3,"line one\nline two"\n',
        );
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            // Split CSV records and multibyte UTF-8 characters across writes.
            for (let offset = 0; offset < input.length; offset += 5) {
              controller.enqueue(input.subarray(offset, offset + 5));
            }
            controller.close();
          },
        });
        const copyIn = reserved`
          copy pg_temp.native_driver_copy (id, value)
          from stdin (format csv, encoding 'UTF8')
        `;
        // pipeTo closes on success, aborts/cancels on failure, and releases locks.
        await source.pipeTo(copyIn.writable(), {
          signal: AbortSignal.timeout(3000),
        });
        expect((await within(copyIn, "COPY FROM completion")).count).toBe(3);

        const selected = await within(
          connection.executeQuery<{
            id: number;
            value: string | null;
          }>(
            sql`
          select id, value from pg_temp.native_driver_copy order by id
        `.compile(db),
          ),
          "Kysely-compiled query after COPY FROM",
        );
        expect(selected.rows).toEqual([
          { id: 1, value: 'Привет, "Bun"!' },
          { id: 2, value: null },
          { id: 3, value: "line one\nline two" },
        ]);

        const chunks: Buffer[] = [];
        const copyOut = reserved`
          copy (select id, value from pg_temp.native_driver_copy order by id)
          to stdout (format csv, encoding 'UTF8')
        `;
        await copyOut.readable().pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(Buffer.from(chunk));
            },
          }),
          { signal: AbortSignal.timeout(3000) },
        );
        await within(copyOut, "COPY TO completion");
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(input));
        await within(
          connection.executeQuery(
            sql`
          drop table pg_temp.native_driver_copy
        `.compile(db),
          ),
          "drop COPY temp table",
        );
      } finally {
        // Failed transfers abort their streams; closing the client below also
        // drops the session-local table if the explicit DROP was not reached.
        await within(
          driver.releaseConnection(connection),
          "release COPY session",
        );
      }
      expect(
        (
          await within(
            sql<{ answer: number }>`select 42 as answer`.execute(db),
            "Kysely query after COPY session release",
          )
        ).rows,
      ).toEqual([{ answer: 42 }]);
    } finally {
      try {
        await within(db.destroy(), "db cleanup after COPY");
      } finally {
        try {
          await within(driver.destroy(), "driver cleanup after COPY");
        } finally {
          await client.close({ timeout: 0 });
        }
      }
    }
  }, 20000);

  test("db.destroy closes an external pool with explicit ownership", async () => {
    const client = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 5 });
    const db = database({ sql: client, ownsSql: true, closeTimeout: 1 });
    try {
      await sql`select 1`.execute(db);
      await db.destroy();
      await expect(client`select 1`).rejects.toMatchObject({
        code: "ERR_POSTGRES_CONNECTION_CLOSED",
      });
    } finally {
      await db.destroy();
      await client.close({ timeout: 0 });
    }
  });

  test("closeTimeout bounds owned-pool shutdown with a running native query", async () => {
    const client = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 5 });
    const driver = new BunDriver({
      sql: client,
      ownsSql: true,
      closeTimeout: 0.05,
    });
    try {
      await client`select 1`;
      const query = client`select pg_sleep(10)`.execute();
      // Attach a rejection handler before shutdown interrupts the running query.
      const settled = query.then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let i = 0; i < 200 && !query.active; i++) {
        await Bun.sleep(5);
      }
      expect(query.active).toBe(true);
      await driver.destroy();
      expect(await settled).toMatchObject({
        code: "ERR_POSTGRES_CONNECTION_CLOSED",
      });
    } finally {
      await client.close({ timeout: 0 });
    }
  }, 5000);

  test("native reserve abort rejects before the held connection is released", async () => {
    const client = new SQL({ url: databaseUrl, max: 1, connectionTimeout: 2 });
    let held: ReservedSQL | undefined;
    try {
      held = await within(client.reserve(), "native held reservation");
      const controller = new AbortController();
      const reason = new Error("native reservation aborted");
      let settled = false;
      // Observe with ordinary Promise handlers, independent of Bun's matchers.
      const outcome = client.reserve({ signal: controller.signal }).then(
        async (unexpected) => {
          settled = true;
          await unexpected.release();
          throw new Error(
            "Aborted native reserve unexpectedly acquired a connection",
          );
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await Bun.sleep(20);
      expect(settled).toBe(false);
      controller.abort(reason);
      expect(await within(outcome, "native reservation abort", 1000)).toBe(
        reason,
      );
      await held.release();
      held = undefined;
      const next = await client.reserve({ signal: AbortSignal.timeout(2000) });
      try {
        expect(
          (
            await within(next`select 1 as answer`, "native query after abort")
          )[0].answer,
        ).toBe(1);
      } finally {
        await next.release();
      }
    } finally {
      try {
        if (held)
          await within(held.release(), "native held reservation cleanup");
      } finally {
        await client.close({ timeout: 0 });
      }
    }
  }, 10000);

  test("aborts native pool waiting without stealing the next free connection", async () => {
    const driver = new BunDriver({ ...config(), closeTimeout: 0 });
    let held: BunConnection | undefined;
    try {
      held = await within(
        driver.acquireConnection(),
        "initial pool reservation",
      );
      const controller = new AbortController();
      const reason = new Error("cancel queued reservation");
      const waiting = driver.acquireConnection({ signal: controller.signal });
      // Bun 1.4.4's rejects matcher waits before returning. Schedule abort
      // first: code placed after the matcher cannot unblock its own Promise.
      const abortTimer = setTimeout(() => controller.abort(reason), 20);
      try {
        await expect(
          within(waiting, "aborted pool reservation", 1000),
        ).rejects.toBe(reason);
      } finally {
        clearTimeout(abortTimer);
      }
      await within(driver.releaseConnection(held), "release held reservation");
      held = undefined;
      const next = await within(
        driver.acquireConnection({
          signal: AbortSignal.timeout(2000),
        }),
        "reservation after abort",
      );
      try {
        expect(
          (
            await within(
              next.executeQuery(CompiledQuery.raw("select 1 as answer")),
              "query after aborted reservation",
            )
          ).rows,
        ).toEqual([{ answer: 1 }]);
      } finally {
        await within(
          driver.releaseConnection(next),
          "release next reservation",
        );
      }
    } finally {
      try {
        if (held)
          await within(
            driver.releaseConnection(held),
            "held reservation cleanup",
          );
      } finally {
        await within(driver.destroy(), "pool reservation test cleanup");
      }
    }
  }, 10000);

  test("supports safely quoted savepoints through a Kysely controlled transaction", async () => {
    const db = database(config());
    try {
      const trx = await db.startTransaction().execute();
      try {
        await sql`create temporary table native_driver_savepoints (value integer) on commit drop`.execute(
          trx,
        );
        await sql`insert into native_driver_savepoints values (1)`.execute(trx);
        const name = 'safe"; rollback; --';
        const saved = await trx.savepoint(name).execute();
        await sql`insert into native_driver_savepoints values (2)`.execute(
          saved,
        );
        await expect(sql`select 1 / 0`.execute(saved)).rejects.toMatchObject({
          errno: "22012",
        });
        await saved.rollbackToSavepoint(name).execute();
        expect(
          (
            await sql<{
              value: number;
            }>`select value from native_driver_savepoints`.execute(saved)
          ).rows,
        ).toEqual([{ value: 1 }]);
        await sql`insert into native_driver_savepoints values (3)`.execute(
          saved,
        );
        await saved.releaseSavepoint(name).execute();
        expect(
          (
            await sql<{
              value: number;
            }>`select value from native_driver_savepoints order by value`.execute(
              trx,
            )
          ).rows,
        ).toEqual([{ value: 1 }, { value: 3 }]);
        await trx.commit().execute();
      } catch (error) {
        if (!trx.isCommitted && !trx.isRolledBack)
          await trx.rollback().execute();
        throw error;
      }
      await sql`select 1`.execute(db);
    } finally {
      await db.destroy();
    }
  });

  test("accepts async password providers even on servers configured with trust", async () => {
    const url = new URL(databaseUrl!);
    const password = decodeURIComponent(url.password);
    url.password = "";
    const db = database({
      url,
      max: 1,
      connectionTimeout: 5,
      closeTimeout: 1,
      password: async () => password,
    });
    try {
      expect(
        (await sql<{ answer: number }>`select 42 as answer`.execute(db)).rows,
      ).toEqual([{ answer: 42 }]);
      // A trust-authenticated server need not invoke the provider at all.
    } finally {
      await db.destroy();
    }
  });
});

// Optional dedicated password-authenticated PostgreSQL (SCRAM/MD5), not trust.
// Do not change pg_hba.conf or create privileged roles in the shared test setup.
const authenticatedUrl = process.env["NATIVE_DRIVER_AUTH_URL"];
describe.skipIf(!authenticatedUrl)(
  "native async password authentication",
  () => {
    test("invokes the async provider and rejects an incorrect password", async () => {
      const url = new URL(authenticatedUrl!);
      const password = decodeURIComponent(url.password);
      url.password = "";
      const options = {
        url,
        max: 1,
        connectionTimeout: 5,
        closeTimeout: 1,
      } as const;
      const wrongDb = database({
        ...options,
        password: async () => `wrong-${crypto.randomUUID()}`,
      });
      try {
        await expect(sql`select 1`.execute(wrongDb)).rejects.toMatchObject({
          errno: "28P01",
        });
      } finally {
        await wrongDb.destroy();
      }

      let calls = 0;
      const db = database({
        ...options,
        password: async () => {
          calls += 1;
          await Promise.resolve();
          return password;
        },
      });
      try {
        expect(
          (await sql<{ answer: number }>`select 42 as answer`.execute(db)).rows,
        ).toEqual([{ answer: 42 }]);
        expect(calls).toBeGreaterThan(0);
      } finally {
        await db.destroy();
      }
    });
  },
);
