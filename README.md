# kysely-bun-psql

![Powered by TypeScript](https://img.shields.io/badge/powered%20by-typescript-blue.svg)

> ⚠️ **Beta Status**: This package is currently in beta. While it's functional and tested, you may encounter bugs or missing features. Please [open an issue](https://github.com/zacknovosad/kysely-bun-psql/issues) if you find any problems or have feature requests. Pull requests are welcome!

[Kysely](https://github.com/koskimas/kysely) dialect for [PostgreSQL](https://www.postgresql.org/) using Bun's built-in SQL client under the hood.

This dialect provides a fast, native PostgreSQL client for Kysely when running in Bun, leveraging [Bun's built-in SQL support](https://bun.sh/docs/api/sql) introduced in v1.2.

## Installation

```bash
bun add @ratiu5/kysely-bun-psql
```

## Usage

```typescript
import { Kysely, type Generated } from "kysely";
import { BunDialect } from "kysely-bun-psql";

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

## Configuration

The dialect accepts all the same options as Bun's SQL client:

```typescript
interface BunDialectConfig {
  url: string;
  hostname?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  max?: number;
  idleTimeout?: number;
  maxLifetime?: number;
  connectionTimeout?: number;
  tls?: boolean;
}
```

## Requirements

- Bun v1.2 or higher

## License

MIT License, see \`LICENSE\`
