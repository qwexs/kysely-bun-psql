import { $ } from "bun";
import { expect, test } from "bun:test";

const root = Bun.fileURLToPath(new URL("../", import.meta.url));

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ...Bun.env,
      NODE_PATH: "",
      GIT_EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      npm_config_ignore_scripts: "false",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, `${command.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
  return stdout.trim();
}

function isolatedTemporaryBase(): string {
  // Windows TEMP may be below a home-level node_modules. Reject that ancestry.
  const candidates = [
    Bun.env["TMPDIR"],
    Bun.env["TEMP"],
    Bun.env["TMP"],
    Bun.env["SystemRoot"] && `${Bun.env["SystemRoot"]}/Temp`,
    "/tmp",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.replaceAll("\\", "/").replace(/\/$/, "");
    let directory = Bun.pathToFileURL(`${base}/`);
    try {
      while (true) {
        const modules = Array.from(
          new Bun.Glob("node_modules").scanSync({
            cwd: Bun.fileURLToPath(directory),
            onlyFiles: false,
            dot: true,
          }),
        );
        if (modules.length) break;
        const parent = new URL("../", directory);
        if (parent.href === directory.href) return base;
        directory = parent;
      }
    } catch {
      // Skip nonexistent or inaccessible platform-specific temp locations.
    }
  }
  throw new Error("Set TMPDIR to a directory with no ancestor node_modules");
}

async function installedVersion(name: string): Promise<string> {
  return (await Bun.file(Bun.resolveSync(`${name}/package.json`, root)).json())
    .version;
}

test("trusted Git dependency prepares source without package devDependencies", async () => {
  const manifest = await Bun.file(`${root}/package.json`).json();
  const kyselyVersion = await installedVersion("kysely");
  const temporary = `${isolatedTemporaryBase()}/kysely-git-install-${crypto.randomUUID()}`;
  const source = `${temporary}/source`;
  const consumer = `${temporary}/consumer`;
  const hooks = `${temporary}/hooks`;

  try {
    await $`mkdir -p ${source} ${consumer} ${hooks}`.quiet();
    // Snapshot current worktree build inputs, never dist, node_modules or .git.
    const inputs = [
      "package.json",
      "build.config.ts",
      "tsconfig.json",
      "tsconfig.dts.json",
      ...new Bun.Glob("src/**/*").scanSync({ cwd: root, onlyFiles: true }),
    ];
    for (const path of inputs) {
      await Bun.write(`${source}/${path}`, Bun.file(`${root}/${path}`));
    }
    expect(await Bun.file(`${source}/dist/index.js`).exists()).toBe(false);
    expect(await Bun.file(`${source}/dist/index.d.ts`).exists()).toBe(false);

    // Commit only the disposable fixture; pin the actual Git dependency to it.
    await run(["git", "init", "--quiet", "--template="], source);
    await run(["git", "add", "."], source);
    await run(
      [
        "git",
        "-c",
        "user.name=Git install smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "-c",
        `core.hooksPath=${hooks}`,
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "Snapshot build inputs",
      ],
      source,
    );
    const commit = await run(
      ["git", "--no-pager", "rev-parse", "HEAD"],
      source,
    );
    const consumerManifest = {
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `git+${Bun.pathToFileURL(source).href}#${commit}`,
        kysely: kyselyVersion,
      },
      trustedDependencies: [manifest.name],
    };
    await Bun.write(
      `${consumer}/package.json`,
      JSON.stringify(consumerManifest),
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
import { Kysely, type Generated, type RawBuilder } from "kysely";
import { BunDialect, jsonb, jsonbArray, pgArray, type BunDialectConfig } from ${JSON.stringify(manifest.name)};

interface Database {
  person: { id: Generated<number>; name: string };
}

test("Git-installed exports, declarations and compiled helpers", async () => {
  const config: BunDialectConfig = { url: "postgres://unused/unused", bigint: true };
  const db = new Kysely<Database>({ dialect: new BunDialect(config) });
  try {
    const query = db.selectFrom("person").selectAll().where("name", "=", "git-smoke").compile();
    expect(query.sql).toBe('select * from "person" where "name" = $1');
    expect(query.parameters).toEqual(["git-smoke"]);
    const json: RawBuilder<readonly number[]> = jsonb(Object.freeze([1, 2]));
    const jsonArray: RawBuilder<{ id: number }[]> = jsonbArray([{ id: 1 }]);
    const array: RawBuilder<number[]> = pgArray(new Int32Array([1, 2]), "INT");
    const helpers = db.selectNoFrom([
      json.as("json"), jsonArray.as("json_array"), array.as("array"),
    ]).compile();
    expect(helpers.sql).toBe('select $1 as "json", $2 as "json_array", $3 as "array"');
    expect(helpers.parameters).toHaveLength(3);
    expect(typeof require(${JSON.stringify(manifest.name)}).BunDialect).toBe("function");
  } finally {
    await db.destroy();
  }
});
`,
    );

    // A fresh Git cache prevents a previously prepared package masking failures.
    await run(
      [process.execPath, "install", "--cache-dir", `${temporary}/cache`],
      consumer,
    );
    const lockfile = await Bun.file(`${consumer}/bun.lock`).text();
    expect(lockfile).toContain("git+file://");
    expect(lockfile).toContain(commit);
    const installed = `${consumer}/node_modules/${manifest.name}`;
    for (const path of [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/types.d.ts",
    ]) {
      expect(await Bun.file(`${installed}/${path}`).exists(), path).toBe(true);
    }
    expect(Bun.resolveSync(manifest.name, consumer).replaceAll("\\", "/")).toBe(
      `${installed}/dist/index.js`,
    );
    expect(await Bun.file(`${source}/dist/index.js`).exists()).toBe(false);
    expect(
      await Bun.file(`${source}/node_modules/kysely/package.json`).exists(),
    ).toBe(false);

    // Consumer tooling must not hide missing prepare dependencies of the package.
    const actualConsumer = await Bun.file(`${consumer}/package.json`).json();
    expect(actualConsumer.dependencies).toEqual(consumerManifest.dependencies);
    expect(actualConsumer.devDependencies).toBeUndefined();
    expect(actualConsumer.trustedDependencies).toEqual([manifest.name]);
    for (const name of ["typescript", "@types/bun"]) {
      expect(Object.hasOwn(actualConsumer.dependencies, name)).toBe(false);
      const resolved = Bun.resolveSync(`${name}/package.json`, installed);
      expect(
        resolved.replaceAll("\\", "/").startsWith(`${consumer}/node_modules/`),
      ).toBe(true);
      expect((await Bun.file(resolved).json()).version).toBe(
        await installedVersion(name),
      );
    }
    for (const name of Object.keys(manifest.devDependencies ?? {})) {
      if (
        name in (manifest.dependencies ?? {}) ||
        name in (manifest.optionalDependencies ?? {}) ||
        name in (manifest.peerDependencies ?? {})
      )
        continue;
      expect(
        await Bun.file(
          `${consumer}/node_modules/${name}/package.json`,
        ).exists(),
        `Git dependency must not install dev-only ${name}`,
      ).toBe(false);
    }

    await run([process.execPath, "check", "--no-script"], consumer);
    await run(
      [
        process.execPath,
        "run",
        "tsc",
        "--noEmit",
        "--project",
        "tsconfig.json",
      ],
      consumer,
    );
    await run([process.execPath, "test", "./smoke.test.ts"], consumer);
    console.log(
      `Verified trusted Git prepare with Bun ${Bun.version}, TypeScript ${await installedVersion("typescript")}, and Kysely ${kyselyVersion}`,
    );
  } finally {
    await $`rm -rf ${temporary}`.quiet();
  }
}, 240_000);
