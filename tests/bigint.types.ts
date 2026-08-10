import { BunDialect } from "../src/index";

const dialect = new BunDialect({
  url: "postgres://example.invalid/example",
  bigint: true,
});

void dialect;
