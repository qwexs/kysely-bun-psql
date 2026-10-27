import { describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { SQL } from "bun";
import {
  CompiledQuery,
  PostgresQueryCompiler,
  type AbortableOperationOptions,
  type QueryCompiler,
} from "kysely";
import { BunConnection } from "../../src/connection";
import { BunDriver } from "../../src/driver";
import type { BunDialectConfig } from "../../src/types";
import { createFakeReservedSQL } from "./fake-reserved-sql";

const unusedUrl = "postgres://unused:unused@127.0.0.1:1/unused";

function createClient() {
  return new SQL({ url: unusedUrl, tls: false });
}

function acceptConfig(config: BunDialectConfig): BunDialectConfig {
  return config;
}

describe("BunDriver native config types", () => {
  test("inherits PostgreSQL constructor options, not a handwritten subset", async () => {
    const client = createClient();
    try {
      const configs = [
        {},
        { hostname: "localhost", port: "5432" },
        { url: new URL(unusedUrl), prepare: false, bigint: true },
        { path: "/var/run/postgresql", socket: "/tmp/.s.PGSQL.5432" },
        { connection: { application_name: "kysely", statement_timeout: 1000 } },
        { password: async () => "token", channelBinding: "require" },
        { tls: "verify-full" },
        { tls: { ca: Bun.file("ca.pem"), rejectUnauthorized: true } },
        { tls: Bun.file("ca.pem") },
        { transform: SQL.camel },
        { adapter: "postgres", ownsSql: true, closeTimeout: 0.5 },
        { sql: client },
        { sql: client, ownsSql: true, closeTimeout: 2 },
      ] satisfies BunDialectConfig[];
      expect(configs).toHaveLength(13);

      expectTypeOf<BunDialectConfig["password"]>().toEqualTypeOf<
        SQL.PostgresOrMySQLOptions["password"]
      >();
      expectTypeOf<BunDialectConfig["tls"]>().toEqualTypeOf<
        SQL.PostgresOrMySQLOptions["tls"]
      >();
      expectTypeOf<BunDialectConfig["transform"]>().toEqualTypeOf<
        SQL.PostgresOrMySQLOptions["transform"]
      >();

      // @ts-expect-error Numeric arrays are normalized without a configuration switch.
      acceptConfig({ url: unusedUrl, normalizeNumericArrays: true });
      // @ts-expect-error Shared clients do not need a normalization switch either.
      acceptConfig({ sql: client, normalizeNumericArrays: false });
      // @ts-expect-error External clients cannot be mixed with constructor options.
      acceptConfig({ sql: client, url: unusedUrl });
      // @ts-expect-error Even shared pool/transform options belong to the client.
      acceptConfig({ sql: client, max: 2, transform: SQL.camel });
      // @ts-expect-error Internal clients cannot opt out of ownership.
      acceptConfig({ url: unusedUrl, ownsSql: false });
      // @ts-expect-error Only PostgreSQL is supported.
      acceptConfig({ adapter: "mysql" });
      // @ts-expect-error MySQL-only options are not part of this dialect.
      acceptConfig({ allowPublicKeyRetrieval: true });
      // @ts-expect-error MySQL-only options are not part of this dialect.
      acceptConfig({ foundRows: true });
      // @ts-expect-error SQLite-only options are not part of this dialect.
      acceptConfig({ filename: ":memory:" });
    } finally {
      await client.close();
    }
  });
});

describe("BunDriver client lifecycle", () => {
  test("uses an external native client unchanged and does not close it by default", async () => {
    const password = async () => "token";
    const client = new SQL({
      url: unusedUrl,
      password,
      prepare: false,
      connection: { application_name: "external" },
      channelBinding: "prefer",
      transform: SQL.camel,
      idleTimeout: 7,
      tls: false,
    });
    const fake = createFakeReservedSQL({ rows: [{ answer: 42 }] });
    const reserve = spyOn(client, "reserve").mockResolvedValue(fake.reserved);
    const close = spyOn(client, "close");
    const driver = new BunDriver({ sql: client, closeTimeout: 0 });
    try {
      expect(client.options.adapter).toBe("postgres");
      expect(typeof client.options.adapter).toBe("string");
      expect(client.options.password).toBe(password);
      expect(client.options.prepare).toBe(false);
      // Resolved options are output, not reusable constructor input (ms vs s).
      expect(client.options.idleTimeout).toBe(7000);
      const connection = await driver.acquireConnection();
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(
        (await connection.executeQuery(CompiledQuery.raw("select 42"))).rows,
      ).toEqual([{ answer: 42 }]);
      await driver.releaseConnection(connection);
      expect(fake.releases).toBe(1);
      await driver.destroy();
      expect(close).not.toHaveBeenCalled();
    } finally {
      reserve.mockRestore();
      close.mockRestore();
      await client.close();
    }
  });

  test("normalizes numeric results without reconfiguring a shared client", async () => {
    const client = createClient();
    const ints = new Int32Array([1, 2]);
    const fake = createFakeReservedSQL({
      rows: [{ ints }],
      columns: [{ name: "ints", type: 1007, table: 0 }],
    });
    const reserve = spyOn(client, "reserve").mockResolvedValue(fake.reserved);
    const driver = new BunDriver({ sql: client });
    try {
      const connection = await driver.acquireConnection();
      const result = await connection.executeQuery<{ ints: number[] }>(
        CompiledQuery.raw("select"),
      );
      expect(Array.isArray(result.rows[0]!.ints)).toBe(true);
      expect(result.rows[0]!.ints).toEqual([1, 2]);
      expect(ints).toBeInstanceOf(Int32Array);
      await driver.releaseConnection(connection);
      await driver.destroy();
    } finally {
      reserve.mockRestore();
      await client.close();
    }
  });

  test.each([undefined, 0, 0.25])(
    "awaits closing an explicitly owned external client (timeout %s seconds)",
    async (closeTimeout) => {
      const client = createClient();
      const finish = Promise.withResolvers<void>();
      const close = spyOn(client, "close").mockImplementation(
        () => finish.promise,
      );
      const driver = new BunDriver({
        sql: client,
        ownsSql: true,
        closeTimeout,
      });
      let completed = false;
      const destroying = driver.destroy().then(() => {
        completed = true;
      });
      try {
        expect(close).toHaveBeenCalledTimes(1);
        expect(close.mock.calls[0]).toEqual(
          closeTimeout === undefined ? [] : [{ timeout: closeTimeout }],
        );
        await Promise.resolve();
        expect(completed).toBe(false);
        finish.resolve();
        await destroying;
        expect(completed).toBe(true);
      } finally {
        finish.resolve();
        await destroying;
        close.mockRestore();
        await client.close();
      }
    },
  );

  test("owns internally constructed clients and allows hostname without url", async () => {
    const driver = new BunDriver({
      adapter: "postgres",
      hostname: "127.0.0.1",
      port: 1,
      tls: false,
      closeTimeout: 0,
    });
    await driver.init();
    await driver.destroy();
    // Closing before reserve proves ownership without making a network request.
    await expect(driver.acquireConnection()).rejects.toMatchObject({
      code: "ERR_POSTGRES_CONNECTION_CLOSED",
    });
  });

  test.each([-1, NaN, Infinity])(
    "rejects invalid closeTimeout %s",
    (closeTimeout) => {
      expect(() => new BunDriver({ url: unusedUrl, closeTimeout })).toThrow(
        "closeTimeout",
      );
    },
  );

  test("enforces config exclusivity and ownership for untyped callers too", async () => {
    const client = createClient();
    try {
      expect(
        () =>
          new BunDriver({
            sql: client,
            prepare: false,
          } as unknown as BunDialectConfig),
      ).toThrow("mutually exclusive");
      expect(
        () =>
          new BunDriver({
            url: unusedUrl,
            ownsSql: false,
          } as unknown as BunDialectConfig),
      ).toThrow("must be owned");
    } finally {
      await client.close();
    }
  });

  test.each(["mysql://unused:unused@127.0.0.1:1/unused", ":memory:"])(
    "rejects non-PostgreSQL constructor URLs: %s",
    (url) => {
      expect(() => new BunDriver({ url })).toThrow("only supports PostgreSQL");
    },
  );

  test("checks the adapter resolved from native environment defaults", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
        import { BunDriver } from "./src/driver.ts";
        try {
          new BunDriver({});
          process.exit(1);
        } catch (error) {
          if (!(error instanceof TypeError) || !error.message.includes("only supports PostgreSQL")) {
            throw error;
          }
        }
      `,
      ],
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, DATABASE_URL: ":memory:" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  });

  test("rejects a non-PostgreSQL adapter supplied by an untyped caller", () => {
    expect(
      () =>
        new BunDriver({
          url: unusedUrl,
          adapter: "mysql",
        } as unknown as BunDialectConfig),
    ).toThrow("only supports PostgreSQL");
  });

  test.each(["mysql://unused:unused@127.0.0.1:1/unused", ":memory:"])(
    "rejects external non-PostgreSQL clients without closing them: %s",
    async (url) => {
      const client = new SQL(url);
      const close = spyOn(client, "close");
      try {
        expect(() => new BunDriver({ sql: client, ownsSql: true })).toThrow(
          "only supports PostgreSQL",
        );
        expect(close).not.toHaveBeenCalled();
      } finally {
        close.mockRestore();
        await client.close();
      }
    },
  );
});

describe("BunDriver acquireConnection", () => {
  test("native reserve rejects a pre-aborted signal without opening a connection", async () => {
    const driver = new BunDriver({
      url: unusedUrl,
      tls: false,
      closeTimeout: 0,
    });
    const reason = new Error("already aborted");
    try {
      await expect(
        driver.acquireConnection({ signal: AbortSignal.abort(reason) }),
      ).rejects.toBe(reason);
    } finally {
      await driver.destroy();
    }
  });

  test("passes AbortableOperationOptions directly to native reserve", async () => {
    const client = createClient();
    const fake = createFakeReservedSQL();
    const reserve = spyOn(client, "reserve").mockResolvedValue(fake.reserved);
    const driver = new BunDriver({ sql: client });
    const options: AbortableOperationOptions = {
      signal: new AbortController().signal,
    };
    try {
      const connection = await driver.acquireConnection(options);
      expect(reserve.mock.calls[0]?.[0]).toBe(options);
      await driver.releaseConnection(connection);
      expect(fake.releases).toBe(1);
    } finally {
      reserve.mockRestore();
      await client.close();
    }
  });

  test("propagates native reserve rejection without acquiring or releasing a client", async () => {
    const client = createClient();
    const reason = new Error("pool wait aborted");
    const signal = AbortSignal.abort(reason);
    const reserve = spyOn(client, "reserve").mockImplementation(
      async (options) => {
        options?.signal?.throwIfAborted();
        throw new Error("expected an aborted signal");
      },
    );
    try {
      const driver = new BunDriver({ sql: client });
      await expect(driver.acquireConnection({ signal })).rejects.toBe(reason);
      expect(reserve).toHaveBeenCalledWith({ signal });
    } finally {
      reserve.mockRestore();
      await client.close();
    }
  });

  test("awaits deferred reserved-client release", async () => {
    const client = createClient();
    const finish = Promise.withResolvers<void>();
    const fake = createFakeReservedSQL({ release: () => finish.promise });
    const driver = new BunDriver({ sql: client });
    let completed = false;
    const releasing = driver
      .releaseConnection(new BunConnection(fake.reserved))
      .then(() => {
        completed = true;
      });
    try {
      await Promise.resolve();
      expect(completed).toBe(false);
      finish.resolve();
      await releasing;
      expect(completed).toBe(true);
    } finally {
      finish.resolve();
      await releasing;
      await client.close();
    }
  });
});

describe("BunDriver savepoints", () => {
  test.each(["simple", 'a"; rollback; --', "with space.dot", "точка"])(
    "uses the provided Kysely compiler to quote %s as one identifier",
    async (name) => {
      const client = createClient();
      const fake = createFakeReservedSQL();
      const connection = new BunConnection(fake.reserved);
      const driver = new BunDriver({ sql: client });
      const compiler = new PostgresQueryCompiler();
      const compileQuery = spyOn(compiler, "compileQuery");
      const compile: QueryCompiler["compileQuery"] =
        compiler.compileQuery.bind(compiler);
      try {
        await driver.savepoint(connection, name, compile);
        await driver.rollbackToSavepoint(connection, name, compile);
        await driver.releaseSavepoint(connection, name, compile);
        const quotedName = `"${name.replaceAll('"', '""')}"`;
        expect(fake.calls).toEqual([
          { sql: `savepoint ${quotedName}`, parameters: [] },
          { sql: `rollback to ${quotedName}`, parameters: [] },
          { sql: `release ${quotedName}`, parameters: [] },
        ]);
        expect(compileQuery).toHaveBeenCalledTimes(3);
        for (const [node, queryId] of compileQuery.mock.calls) {
          expect(node.kind).toBe("RawNode");
          expect(queryId.queryId).toBeString();
        }
      } finally {
        compileQuery.mockRestore();
        await driver.releaseConnection(connection);
        await client.close();
      }
    },
  );
});
