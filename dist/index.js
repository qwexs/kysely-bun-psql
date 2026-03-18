// @bun
// src/connection.ts
import {
  CompiledQuery
} from "kysely";

// src/errors.ts
class BunDialectError extends Error {
  constructor(message) {
    super(message);
    this.name = "BunDialectError";
  }
}

// src/utils.ts
var JSONB_SYMBOL = Symbol.for("kysely-bun-psql:jsonb");
function transformValue(value) {
  if (Array.isArray(value)) {
    if (JSONB_SYMBOL in value) {
      return value;
    }
    const containsObjects = value.some((item) => {
      return item !== null && typeof item === "object" && !Array.isArray(item);
    });
    if (containsObjects) {
      return value;
    }
    return createPostgresArray(value);
  }
  return value;
}
function createPostgresArray(arr) {
  const serialized = arr.map((item) => {
    if (typeof item === "string") {
      const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      return `"${escaped}"`;
    }
    return String(item);
  }).join(",");
  return `{${serialized}}`;
}
function freeze(obj) {
  return Object.freeze(obj);
}
function jsonbArray(arr) {
  if (arr.length === 0) {
    return "{}";
  }
  const elements = arr.map((item) => {
    if (item === null) {
      return "null";
    }
    const jsonStr = JSON.stringify(item);
    const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return `"${escaped}"`;
  });
  return `{${elements.join(",")}}`;
}

// src/connection.ts
class BunConnection {
  #reservedConnection;
  constructor(reservedConnection) {
    this.#reservedConnection = reservedConnection;
  }
  async beginTransaction(settings) {
    const { isolationLevel } = settings;
    const compiledQuery = CompiledQuery.raw(isolationLevel ? `start transaction isolation level ${isolationLevel}` : "begin");
    await this.executeQuery(compiledQuery);
  }
  async commitTransaction() {
    await this.executeQuery(CompiledQuery.raw("commit"));
  }
  async executeQuery(compiledQuery) {
    const parameters = compiledQuery.parameters.map(transformValue);
    const result = await this.#reservedConnection.unsafe(compiledQuery.sql, parameters);
    const rows = Array.from(result.values());
    if (["INSERT", "UPDATE", "DELETE"].includes(result.command)) {
      const numAffectedRows = BigInt(rows.length);
      return { numAffectedRows, rows };
    }
    return { rows };
  }
  releaseConnection() {
    this.#reservedConnection.release();
    this.#reservedConnection = null;
  }
  async rollbackTransaction() {
    await this.executeQuery(CompiledQuery.raw("rollback"));
  }
  async* streamQuery() {
    throw new BunDialectError("streamQuery is not supported");
  }
}
// src/dialect.ts
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";

// src/driver.ts
var {SQL } = globalThis.Bun;
class BunDriver {
  #config;
  #sql;
  constructor(config) {
    this.#config = freeze({ ...config });
    this.#sql = new SQL({
      url: this.#config.url,
      hostname: this.#config.hostname,
      port: this.#config.port,
      database: this.#config.database,
      username: this.#config.username,
      password: this.#config.password,
      max: this.#config.max,
      idleTimeout: this.#config.idleTimeout,
      maxLifetime: this.#config.maxLifetime,
      connectionTimeout: this.#config.connectionTimeout,
      tls: this.#config.tls,
      onconnect: this.#config.onconnect,
      onclose: this.#config.onclose
    });
  }
  async init() {}
  async acquireConnection() {
    const reserved = await this.#sql.reserve();
    return new BunConnection(reserved);
  }
  async beginTransaction(connection, settings) {
    await connection.beginTransaction(settings);
  }
  async commitTransaction(connection) {
    await connection.commitTransaction();
  }
  async rollbackTransaction(connection) {
    await connection.rollbackTransaction();
  }
  async releaseConnection(connection) {
    connection.releaseConnection();
  }
  async destroy() {
    await this.#sql.close();
  }
}

// src/dialect.ts
class BunDialect {
  #config;
  constructor(config) {
    this.#config = freeze({ ...config });
  }
  createAdapter() {
    return new PostgresAdapter;
  }
  createDriver() {
    return new BunDriver(this.#config);
  }
  createIntrospector(db) {
    return new PostgresIntrospector(db);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler;
  }
}
// src/index.ts
var JSONB_SYMBOL2 = JSONB_SYMBOL;
function jsonb(value) {
  Object.defineProperty(value, JSONB_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: true
  });
  return value;
}
export {
  jsonbArray,
  jsonb,
  JSONB_SYMBOL2 as JSONB_SYMBOL,
  BunDriver,
  BunDialectError,
  BunDialect,
  BunConnection
};

//# debugId=DE2807A76E2B655E64756E2164756E21
//# sourceMappingURL=index.js.map
