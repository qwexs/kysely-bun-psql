# kysely-bun-psql

[![npm version](https://img.shields.io/npm/v/@qwexs/kysely-bun-psql.svg)](https://www.npmjs.com/package/@qwexs/kysely-bun-psql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Powered by TypeScript](https://img.shields.io/badge/powered%20by-typescript-blue.svg)

[Kysely](https://github.com/koskimas/kysely) dialect for [PostgreSQL](https://www.postgresql.org/) using Bun's built-in SQL client under the hood.

Uses [Bun's native SQL client](https://bun.com/docs/runtime/sql.md) for parameter binding, JSON and PostgreSQL arrays, pooling, and query cancellation. Targets the latest stable Bun, currently **1.4.4**, and **Kysely 0.29.7**.

## Installation

```bash
bun add @qwexs/kysely-bun-psql kysely
```

### Installing from GitHub

Pin a reviewed commit instead of a moving branch:

```json
{
  "dependencies": {
    "@qwexs/kysely-bun-psql": "github:qwexs/kysely-bun-psql#<commit-sha>",
    "kysely": "^0.29.7"
  },
  "trustedDependencies": ["@qwexs/kysely-bun-psql"]
}
```

Then run `bun install`. Bun must be allowed to run the package's `prepare` script to build `dist`; `--ignore-scripts` prevents this. Keep any other dependencies whose lifecycle scripts you need in your existing trust list: an explicit `trustedDependencies` list replaces Bun's defaults. See [Bun lifecycle scripts](https://bun.com/docs/pm/lifecycle.md).

## Usage

```typescript
import { Kysely, type Generated } from "kysely";
import { BunDialect } from "@qwexs/kysely-bun-psql";

interface Database {
  person: {
    id: Generated<number>;
    first_name: string;
    last_name: string | null;
    created_at: Generated<Date>;
  };
}

const db = new Kysely<Database>({
  dialect: new BunDialect({
    url: "postgres://user:pass@localhost:5432/db",
  }),
});

// Execute queries
const person = await db
  .selectFrom("person")
  .selectAll()
  .where("id", "=", 1)
  .executeTakeFirst();

// Use transactions
await db.transaction().execute(async (trx) => {
  await trx
    .insertInto("person")
    .values({
      first_name: "John",
      last_name: "Doe",
    })
    .execute();
});

// Clean up
await db.destroy();
```

## Native JSON and PostgreSQL arrays

Ordinary JavaScript arrays are bound as PostgreSQL arrays using Bun's native `sql.array()` helper. This includes arrays of user-defined enums when PostgreSQL can infer the element type from the query. Nested arrays retain their SQL dimensions; the dialect does not construct array literals itself.

Use `jsonb(value)` to bind **any JSON value**, including arrays of primitives or objects, scalars, frozen objects/arrays and JSON `null`. It uses native `sql.json()` and works consistently with `prepare: true` and `prepare: false`:

```typescript
import { jsonb, jsonbArray, pgArray } from "@qwexs/kysely-bun-psql";

await db
  .insertInto("events")
  .values({
    data: jsonb(Object.freeze([1, 2])), // one JSONB value
    payloads: jsonbArray([{ id: 1 }, null, [1, 2]]), // JSONB[] elements
    tags: ["bun", "sql"], // native TEXT[] parameter
    moods: ["ok", "happy"], // enum[] when the column provides the type
  })
  .execute();

// Explicit SQL array helpers for typed arrays or a type without query context:
const scores = pgArray(new Float32Array([1.5, 2.5]), "REAL");
const moods = pgArray(["ok", "happy"], "mood"); // e.g. SELECT with no type context
const matrix = pgArray(
  [
    [1, 2],
    [3, 4],
  ],
  "INT",
);
```

- Always use `jsonb()` when a JavaScript array should be one JSON/JSONB value, including empty arrays and arrays of objects. An unwrapped array is bound as an SQL array; PostgreSQL may store its array literal as a JSON string instead of rejecting it.
- `jsonb(null)` is JSON null; a bare `null` is SQL NULL.
- `jsonbArray()` uses native `sql.array(..., "JSONB")`. Nested JS arrays are individual JSON elements, not extra SQL dimensions. `null` elements are JSON null; `undefined` elements are SQL NULL.
- `pgArray()` accepts an element type name or an **array type OID**, matching Bun's native helper. Nested arrays represent SQL dimensions.
- These helpers return **Kysely `RawBuilder<T>` expressions**, not serialized strings or mutated input values. Use them inside queries, not as standalone JSON values.
- Model JSON columns with their actual write types. For example, `JSONColumnType<Payload, Payload, Payload>` accepts `jsonb(payload)`; Kysely's default `JSONColumnType<Payload>` expects JSON strings for writes.

### Numeric array results

By default, read results retain Bun's native types. Bun may decode `integer[]` and `real[]` as `Int32Array` / `Float32Array` in binary results, but plain arrays in text results. Arrays containing NULL elements or multiple dimensions are plain arrays. The same column can therefore return different JavaScript types depending on the query and its values. See [Bun's typed array decoding](https://bun.com/docs/runtime/sql.md#typed-arrays-and-real).

Enable `normalizeNumericArrays` when validators, `.map()` or JSON responses need ordinary JavaScript arrays:

```typescript
const dialect = new BunDialect({
  url: Bun.env.DATABASE_URL,
  normalizeNumericArrays: true, // default: false
});
```

This dialect-only option converts top-level `integer[]` / `real[]` typed results to plain arrays in both `SELECT` and `RETURNING`, using PostgreSQL column metadata and the actual value type. It works with internally created and externally supplied SQL clients; direct queries on a shared native client remain unchanged. Missing or unknown metadata leaves the value unchanged.

Already-plain arrays, SQL NULL, JSON/JSONB, `bytea`, bigint values and custom enum-array strings are not modified. There is no recursive conversion or automatic decoding of enum arrays; use an explicit `to_jsonb(column)` projection for an ordinary JSON array, or keep your existing type-aware parser. Normalization preserves decoded numbers: it does not remove binary-versus-text rounding differences for `real`.

### Migration from earlier helper behavior

`jsonb()` no longer marks the input with `JSONB_SYMBOL`, and `jsonbArray()` no longer returns a PostgreSQL literal masquerading as an array. Stop serializing or inspecting the helpers' return values outside queries. The deprecated `JSONB_SYMBOL` export remains for source compatibility but has no serialization effect. JSONB[] `null` elements now mean JSON null; use `undefined` for SQL NULL.

Ordinary arrays now always bind as PostgreSQL arrays. Wrap arrays intended for JSON/JSONB in `jsonb()`, even if an array of objects previously worked without a helper. This is also a change from earlier v2 pass-through behavior.

## Configuration

`BunDialectConfig` derives from Bun's native PostgreSQL options instead of maintaining a partial option list. Connection options are passed through unchanged. MySQL and SQLite clients are rejected; omitting `url` lets Bun resolve PostgreSQL settings from the environment.

```typescript
const dialect = new BunDialect({
  url: Bun.env.DATABASE_URL,
  max: 20,
  prepare: false, // e.g. an environment requiring unnamed statements
  connection: {
    application_name: "my-service",
    search_path: "app,public",
    statement_timeout: 5000, // PostgreSQL milliseconds
  },
  password: async () => getDatabaseToken(),
  tls: "verify-full", // also accepts a TLS options object or CA BunFile
  channelBinding: "require", // requires TLS and SCRAM-SHA-256-PLUS
  closeTimeout: 5, // maximum seconds for shutdown of an owned pool
});
```

Native `path` / `socket`, TLS modes and certificate options, `bigint`, callbacks, pool limits and startup settings are supported. See [Bun SQL connection options](https://bun.com/docs/runtime/sql.md#connection-options) for their full semantics. `closeTimeout` and `normalizeNumericArrays` are dialect-specific, not native SQL options. For `closeTimeout`, omitted means wait without a deadline; `0` closes immediately.

Native `transform` is opt-in. It can rename result keys but cannot rewrite identifiers compiled by Kysely. Prefer Kysely's `CamelCasePlugin` for Kysely queries; do not stack both naming systems unintentionally.

### Recommended Production Settings

When running in production, configure the connection pool based on your PostgreSQL `max_connections` setting and the number of services connecting to the database:

```typescript
const db = new Kysely<Database>({
  dialect: new BunDialect({
    url: process.env.DATABASE_URL,
    // PostgreSQL max_connections = 100, with multiple services sharing the database
    // Reserve a portion for this service (e.g., 20 out of 100)
    max: 20,
    connectionTimeout: 35, // 35 seconds - connection establishment timeout
    idleTimeout: 30, // 30 seconds - close idle connections
    maxLifetime: 86400, // 24 hours - force reconnection for long-term stability
  }),
});
```

**Configuration tips:**

- **max**: Set based on `(PostgreSQL max_connections) / (number of services)` with some headroom
- **connectionTimeout**: Bounds connection establishment, not pool acquisition or SQL execution. Use PostgreSQL `statement_timeout` to limit query execution.
- **idleTimeout**: Balance between keeping connections ready and freeing resources; 30 seconds works well
- **maxLifetime**: Prevents connection staleness; 24 hours (86400s) ensures daily reconnection

### PostgreSQL `BIGINT` values

Bun SQL returns PostgreSQL `BIGINT` (`int8`) values as strings by default, including small values such as `42::bigint`. Set `bigint: true` to receive all `int8` values as JavaScript `bigint` instead:

```typescript
const db = new Kysely<Database>({
  dialect: new BunDialect({
    url: process.env.DATABASE_URL,
    bigint: true,
  }),
});
```

This option changes `int8` results, not `integer` (`int4`) columns. Model `BIGINT` columns as `string` with the default settings or `bigint` with `bigint: true`; Kysely's schema types do not perform runtime conversion.

## Shared native client, COPY and LISTEN/NOTIFY

Supply an existing PostgreSQL `SQL` client to share it with native Bun features. Connection options and `sql` are mutually exclusive:

```typescript
import { SQL } from "bun";

const client = new SQL({ url: Bun.env.DATABASE_URL });
const db = new Kysely<Database>({
  dialect: new BunDialect({ sql: client }),
});

const subscription = await client.listen("orders", (payload) => {
  console.log(payload);
});
await client.notify("orders", JSON.stringify({ id: 42 }));
await subscription.unlisten();

// Native COPY streams carry CSV/text/binary bytes, not Kysely row batches.
await Bun.file("people.csv")
  .stream()
  .pipeTo(
    client`COPY person (first_name, last_name) FROM STDIN (FORMAT csv)`.writable(),
  );

await db.destroy(); // does not close an external client by default
await client.close(); // the caller owns its lifecycle
```

Pass `ownsSql: true` to transfer pool ownership to the dialect, optionally with `closeTimeout`. **Lazy lifecycle caveat:** Kysely only calls the driver's destroy hook after its driver has initialized. If you create `db` but use only the native client before `db.destroy()`, even `ownsSql: true` will not close that client. Keep explicit `client.close()` cleanup for this case (native close is safe to call again).

Native queries on the shared pool use their own connections: they do **not** join a Kysely transaction automatically. Do not use an injected `BunConnection`'s reserved handle elsewhere. Kysely `.stream()` remains unsupported; COPY is a separate byte-stream API.

## Transactions, savepoints and cancellation

Read-only / read-write access modes and PostgreSQL isolation levels are honored:

```typescript
await db
  .transaction()
  .setIsolationLevel("repeatable read")
  .setAccessMode("read only")
  .execute(async (trx) => {
    await trx.selectFrom("person").selectAll().execute();
  });
```

Kysely controlled transactions support `savepoint(name)`, `rollbackToSavepoint(name)` and `releaseSavepoint(name)`. Names are quoted by Kysely's PostgreSQL compiler.

Use Kysely's cancellation options to cancel both pool acquisition and a running query:

```typescript
await db
  .selectFrom("person")
  .selectAll()
  .execute({
    signal: AbortSignal.timeout(5000),
    inflightQueryAbortStrategy: "cancel query",
  });
```

With only `{ signal }`, Kysely's default `"ignore query"` stops waiting but lets SQL finish. With `"cancel query"`, the dialect invokes native `query.cancel()` without acquiring a second pool connection. In both cases it holds the reservation until native work settles. A pre-aborted signal sends no SQL; native `reserve({ signal })` can interrupt pool waiting.

Cancellation is **best-effort**, not a rollback guarantee: a write can finish before the cancel request arrives. Never retry a write blindly. The dialect serializes queries on each reservation to avoid pipelined cancellation targeting another statement. Direct low-level `BunConnection.executeQuery(..., { signal })` checks abort only before SQL starts; running-query cancellation uses the Kysely executor and its `cancelQuery` hook. See [Bun cancellation semantics](https://bun.com/docs/runtime/sql.md#execute-and-cancelling-queries).

`numAffectedRows` uses Bun's native `affectedRows` for `INSERT`, `UPDATE`, `DELETE` and `MERGE` (with protocol-count fallback). It is not added to SELECT results.

## Development and validation

Development targets the latest stable Bun, currently **1.4.4**, recorded in `.bun-version` and `packageManager`. Older Bun releases are not part of the supported test matrix. PostgreSQL tests use the current `postgres:latest` image.

Formatting uses native `bun fmt`; type checking uses native `bun check`. Declaration generation uses stable **TypeScript 7.0.2** (`tsc`), with explicit Bun types and bundler module resolution. ESLint, typescript-eslint and Prettier are not required. Native `bun lint` is currently canary-only and is not part of stable CI; formatting and type checking do not replace all lint rules.

`typescript` and `@types/bun` are regular package dependencies because a trusted Git dependency must be able to run `prepare` without its development dependencies. This adds build tooling to the installed dependency tree even when using the prebuilt npm tarball.

```bash
bun install --frozen-lockfile
docker compose up -d --pull always --wait
```

Set `DATABASE_URL` to the disposable Docker database before running integration tests:

```bash
# Bun Shell, bash or sh
DATABASE_URL=postgres://admin@localhost:5434/test bun run test:ci
```

```powershell
$env:DATABASE_URL = "postgres://admin@localhost:5434/test"
bun run test:ci
```

| Command                    | Checks                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bun run test:unit`        | Database-free connection and serialization tests                                                     |
| `bun run test:integration` | PostgreSQL CRUD, affected rows, transactions, concurrent reservations, pool reuse and network errors |
| `bun run test:dialect`     | Kysely integration tests with schema setup                                                           |
| `bun run test:package`     | TS7 build, isolated tarball and trusted Git installs, ESM/CJS imports and consumer types             |
| `bun run fmt:check`        | Native Bun formatting check                                                                          |
| `bun run type-check`       | Native Bun type check                                                                                |
| `bun run test:ci`          | Formatting, type check, unit, integration and package checks                                         |

Integration tests require an explicit `DATABASE_URL` and create a uniquely named schema for their fixtures. Teardown drops only that schema. The database user must be able to create schemas. Do not point the suite at a production database, and do not enable parallel file execution without isolating each file's fixtures.

`tests/unit/regressions.test.ts` protects the fixes for multidimensional arrays, `MERGE` affected rows, read-only transactions and frozen JSON values. Native integration tests additionally cover prepared/unprepared parameters, savepoints, external-pool ownership, startup settings, pool-wait abort and active-query cancellation.

Optional `NATIVE_DRIVER_AUTH_URL` enables a password-authenticated PostgreSQL scenario for the async password provider. The default local Docker database uses trust authentication, so it cannot prove the provider was invoked.

Tagging a release validates `v<package.version>`, runs the full validation workflow, publishes to npm using `NPM_TOKEN`, and then creates the GitHub release. Prereleases use the npm `next` tag. No publication runs from pull requests.

## AI Agent Integration

For AI-powered development with Kysely queries, check out the [kysely-postgres-skill](https://github.com/qwexs/kysely-postgres-skill) - a skill for AI agents that enables more effective database query generation.

## Requirements

- Bun v1.4.4 or higher; only the latest stable release is tested and supported
- Kysely `>=0.29.7 <0.30` (the current cancellation and driver interfaces)
- PostgreSQL; integration tests run against `postgres:latest`

## License

MIT License, see `LICENSE`
