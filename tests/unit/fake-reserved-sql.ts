import type { ReservedSQL, SQL } from "bun";

type FakeResultOptions<Row> = {
  rows?: Row[];
  command?: string;
  count?: number;
  affectedRows?: number;
  columns?: readonly SQL.ResultColumn[] | null;
  error?: Error;
  deferred?: boolean;
  releaseError?: Error;
  release?: ReservedSQL["release"];
};

type FakeQuery = {
  started: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  readonly cancels: number;
};

export function createFakeReservedSQL<Row = Record<string, unknown>>(
  options: FakeResultOptions<Row> = {},
) {
  const result = Object.assign([...(options.rows ?? [])], {
    command: options.command ?? "SELECT",
    count: options.count,
    affectedRows: options.affectedRows,
    columns: options.columns,
  });
  const calls: { sql: string; parameters: unknown[] }[] = [];
  const queries: FakeQuery[] = [];
  const firstStarted = Promise.withResolvers<void>();
  let releases = 0;

  const unsafe: ReservedSQL["unsafe"] = <T>(
    sql: string,
    parameters: unknown[] = [],
  ) => {
    calls.push({ sql, parameters });
    let resolve!: (value: typeof result) => void;
    let reject!: (error: unknown) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let promise: Promise<typeof result> | undefined;
    let cancels = 0;
    const execute = () => {
      if (!promise) {
        promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        start();
        firstStarted.resolve();
        if (!options.deferred) {
          if (options.error) reject(options.error);
          else resolve(result);
        }
      }
      return promise;
    };
    // Only implement the lazy methods the connection uses. Keep the assertion
    // at this boundary rather than pretending to implement all of Bun.SQL.
    const query = {
      then: (...args: Parameters<Promise<typeof result>["then"]>) =>
        execute().then(...args),
      catch: (...args: Parameters<Promise<typeof result>["catch"]>) =>
        execute().catch(...args),
      finally: (...args: Parameters<Promise<typeof result>["finally"]>) =>
        execute().finally(...args),
      execute() {
        execute();
        return query;
      },
      cancel() {
        cancels += 1;
        return query;
      },
    };
    queries.push({
      started,
      resolve() {
        execute();
        resolve(result);
      },
      reject(error) {
        execute();
        reject(error);
      },
      get cancels() {
        return cancels;
      },
    });
    return query as unknown as SQL.Query<T>;
  };

  const fake = {
    unsafe,
    async release() {
      releases += 1;
      if (options.releaseError) {
        throw options.releaseError;
      }
      await options.release?.();
    },
  } satisfies Pick<ReservedSQL, "unsafe" | "release">;

  return {
    reserved: fake as ReservedSQL,
    calls,
    queries,
    started: firstStarted.promise,
    get releases() {
      return releases;
    },
  };
}
