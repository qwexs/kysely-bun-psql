# kysely-bun-psql

[![npm version](https://img.shields.io/npm/v/@qwexs/kysely-bun-psql.svg)](https://www.npmjs.com/package/@qwexs/kysely-bun-psql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Powered by TypeScript](https://img.shields.io/badge/powered%20by-typescript-blue.svg)

[Kysely](https://github.com/koskimas/kysely) dialect for [PostgreSQL](https://www.postgresql.org/) using Bun's built-in SQL client under the hood.

This dialect provides a fast, native PostgreSQL client for Kysely when running in Bun, leveraging [Bun's built-in SQL support](https://bun.sh/docs/api/sql) introduced in v1.2.

## Installation

```bash
bun add @qwexs/kysely-bun-psql
```

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

## Working with JSONB[] Arrays

For PostgreSQL `JSONB[]` columns (array of JSONB elements), use the `jsonbArray()` helper:

```typescript
import { BunDialect, jsonbArray } from "@qwexs/kysely-bun-psql";

// JSONB[] column - requires jsonbArray()
await db.insertInto("table").values({
  items: jsonbArray([{ id: 1 }, { id: 2 }])  // ← required for JSONB[]
}).execute();

// JSONB column - no helper needed
await db.insertInto("table").values({
  data: [{ id: 1 }, { id: 2 }]  // ← works directly for JSONB
}).execute();

// Primitive arrays (TEXT[], INTEGER[]) - no helper needed
await db.insertInto("table").values({
  tags: ["a", "b", "c"]  // ← works directly for TEXT[]
}).execute();
```

## Configuration

The dialect accepts all the same options as Bun's SQL client:

```typescript
interface BunDialectConfig {
  // Connection
  url: string;
  hostname?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;

  // Connection pool
  max?: number;              // Maximum connections in pool
  idleTimeout?: number;      // Close idle connections after N seconds
  maxLifetime?: number;      // Connection lifetime in seconds (0 = forever)
  connectionTimeout?: number; // Timeout when establishing new connections

  // SSL/TLS
  tls?: boolean;

  // Callbacks
  onconnect?: (err: Error | null) => void;
  onclose?: (err: Error | null) => void;
}
```

### Recommended Production Settings

When running in production, configure the connection pool based on your PostgreSQL `max_connections` setting and the number of services connecting to the database:

```typescript
const db = new Kysely<Database>({
  dialect: new BunDialect({
    url: process.env.DATABASE_URL,
    // PostgreSQL max_connections = 100, with multiple services sharing the database
    // Reserve a portion for this service (e.g., 20 out of 100)
    max: 20,
    connectionTimeout: 35,  // 35 seconds - time to wait for a connection
    idleTimeout: 30,        // 30 seconds - close idle connections
    maxLifetime: 86400,     // 24 hours - force reconnection for long-term stability
  }),
});
```

**Configuration tips:**

- **max**: Set based on `(PostgreSQL max_connections) / (number of services)` with some headroom
- **connectionTimeout**: Should be higher than your typical query time; 30-60 seconds is reasonable
- **idleTimeout**: Balance between keeping connections ready and freeing resources; 30 seconds works well
- **maxLifetime**: Prevents connection staleness; 24 hours (86400s) ensures daily reconnection

## AI Agent Integration

For AI-powered development with Kysely queries, check out the [kysely-postgres-skill](https://github.com/qwexs/kysely-postgres-skill) - a skill for AI agents that enables more effective database query generation.

## Requirements

- Bun v1.2 or higher

## License

MIT License, see `LICENSE`
