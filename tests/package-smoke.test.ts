import { $ } from "bun";
import { expect, test } from "bun:test";

const root = (await $`pwd`.cwd(`${import.meta.dir}/..`).text()).trim();

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 60_000,
  });
  expect(await child.exited, `bun ${args.join(" ")}`).toBe(0);
}

async function installedVersion(name: string): Promise<string> {
  const path = Bun.resolveSync(`${name}/package.json`, root);
  return (await Bun.file(path).json()).version;
}

test("published package installs and exposes working runtime and type entry points", async () => {
  const manifest = await Bun.file(`${root}/package.json`).json();
  const temporaryBase =
    Bun.env["TMPDIR"] ?? Bun.env["TEMP"] ?? Bun.env["TMP"] ?? "/tmp";
  const temporary = `${temporaryBase.replaceAll("\\", "/")}/kysely-bun-psql-${crypto.randomUUID()}`;
  await $`mkdir ${temporary}`;

  try {
    const tarball = `${temporary}/package.tgz`;
    await run(["pm", "pack", "--ignore-scripts", "--filename", tarball], root);
    const files = await new Bun.Archive(
      await Bun.file(tarball).bytes(),
    ).files();
    for (const path of [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ]) {
      expect(files.has(path), `Package is missing ${path}`).toBe(true);
    }
    for (const path of files.keys()) {
      expect(path).not.toMatch(/^package\/(src|tests|node_modules)\//);
    }

    const consumer = `${temporary}/consumer`;
    await $`mkdir ${consumer}`;
    const version = await installedVersion("kysely");
    const typescriptVersion = await installedVersion("typescript");
    await Bun.write(
      `${consumer}/package.json`,
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          [manifest.name]: `file:${tarball.replaceAll("\\", "/")}`,
          kysely: version,
        },
        devDependencies: {
          "@types/bun": await installedVersion("@types/bun"),
          typescript: typescriptVersion,
        },
      }),
    );
    await Bun.write(
      `${consumer}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["bun"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["smoke.test.ts"],
      }),
    );
    await Bun.write(
      `${consumer}/smoke.test.ts`,
      `
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { Kysely, type Generated, type RawBuilder } from "kysely";
import { BunDialect, jsonb, jsonbArray, pgArray, type BunDialectConfig } from ${JSON.stringify(manifest.name)};

interface Database {
  person: { id: Generated<number>; name: string };
}
test("installed ESM/CJS exports and declarations", async () => {
  const config: BunDialectConfig = { url: "postgres://unused/unused", bigint: true, normalizeNumericArrays: true };
  const db = new Kysely<Database>({ dialect: new BunDialect(config) });
  try {
    const query = db.selectFrom("person").selectAll().where("name", "=", "smoke").compile();
    expect(query.sql).toBe('select * from "person" where "name" = $1');
    expect(query.parameters).toEqual(["smoke"]);
    const json: RawBuilder<readonly number[]> = jsonb(Object.freeze([1, 2]));
    const jsonArray: RawBuilder<{ id: number }[]> = jsonbArray([{ id: 1 }]);
    const array: RawBuilder<number[]> = pgArray(new Int32Array([1, 2]), "INT");
    const parameters = [json, jsonArray, array].map(value => value.toOperationNode());
    expect(parameters.every(node => node.kind === "RawNode")).toBe(true);
    const client = new SQL({ url: "postgres://unused/unused", prepare: false });
    const externalConfig: BunDialectConfig = { sql: client, closeTimeout: 1, normalizeNumericArrays: true };
    const externalDb = new Kysely<Database>({ dialect: new BunDialect(externalConfig) });
    await externalDb.destroy();
    await client.close();
    const cjs = require(${JSON.stringify(manifest.name)});
    expect(typeof cjs.BunDialect).toBe("function");
    expect(typeof cjs.pgArray).toBe("function");
  } finally {
    await db.destroy();
  }
});
`,
    );
    await run(["install", "--ignore-scripts"], consumer);
    const entry = Bun.resolveSync(manifest.name, consumer).replaceAll(
      "\\",
      "/",
    );
    expect(entry.startsWith(`${consumer}/node_modules/${manifest.name}/`)).toBe(
      true,
    );
    await run(["check", "--no-script"], consumer);
    await run(
      ["run", "tsc", "--noEmit", "--project", "tsconfig.json"],
      consumer,
    );
    await run(["test", "./smoke.test.ts"], consumer);
    console.log(
      `Verified published package with Bun ${Bun.version}, TypeScript ${typescriptVersion}, and Kysely ${version}`,
    );
  } finally {
    await $`rm -rf ${temporary}`;
  }
}, 120_000);
