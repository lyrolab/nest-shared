import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test, TestingModule } from "@nestjs/testing"
import { DataSource } from "typeorm"
import { randomUUID } from "node:crypto"
import { spawn, ChildProcess } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  createTestDatabaseInvocation,
  SharedDatabaseModule as Database,
  TestDatabaseInfo,
} from "./index"
import { FailingSchema1700000000001 } from "./fixtures/failing.migration"
import { Person, Tag, Note, Entry } from "./fixtures/records.entity"

const environment = new ConfigService()
const suppliedUrl = environment.get<string>("DATABASE_URL")
let databaseUrl = suppliedUrl
const integration = databaseUrl ? describe : describe.skip
function targetUrl(base: string, name: string) {
  const url = new URL(base)
  url.pathname = `/${encodeURIComponent(name)}`
  return url.toString()
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

integration("owned PostgreSQL public boundary", () => {
  let admin: DataSource
  let serverAdmin: DataSource
  const fixtureBase = `fixture_${randomUUID().replaceAll("-", "")}`
  let fixtureCreated = false
  const recordedDatabases = new Set<string>()
  let app: TestingModule | undefined
  let scratch: string
  const children = new Set<ChildProcess>()
  const evidence: unknown[] = []
  const externalDatabases = new Set<string>()
  let initialCatalog: { datname: string }[]

  beforeAll(async () => {
    if (
      !databaseUrl ||
      !["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Integration requires an owned local PostgreSQL server")
    const scratchRoot =
      environment.get<string>("RUNNER_TEMP") ??
      join(process.cwd(), ".cache/nest-shared-tests")
    await mkdir(scratchRoot, { recursive: true })
    scratch = await mkdtemp(join(scratchRoot, "database-"))
    serverAdmin = await new DataSource({
      type: "postgres",
      url: databaseUrl,
      database: decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),
    }).initialize()
    initialCatalog = await serverAdmin.query<{ datname: string }[]>(
      "SELECT datname FROM pg_database ORDER BY datname",
    )
    await serverAdmin.query(`CREATE DATABASE ${quote(fixtureBase)}`)
    fixtureCreated = true
    databaseUrl = targetUrl(suppliedUrl!, fixtureBase)
    admin = await new DataSource({
      type: "postgres",
      url: databaseUrl,
    }).initialize()
    await admin.query(
      "CREATE TABLE public.base_sentinel (id integer PRIMARY KEY)",
    )
    await admin.query("INSERT INTO public.base_sentinel VALUES (1)")
  })

  afterEach(async () => {
    const errors: unknown[] = []
    try {
      if (app) await app.close()
    } catch (error) {
      errors.push(error)
    }
    app = undefined
    try {
      await Database.resetTestDatabase()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      throw new AggregateError(errors, "Integration cleanup failed")
  })

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL")
    try {
      for (const name of externalDatabases)
        await admin.query(`DROP DATABASE ${quote(name)}`)
      expect(
        await admin.query<{ id: number }[]>(
          "SELECT id FROM public.base_sentinel",
        ),
      ).toEqual([{ id: 1 }])
      const catalog = await admin.query<{ datname: string }[]>(
        "SELECT datname FROM pg_database ORDER BY datname",
      )
      for (const name of recordedDatabases) await absent(name)
      evidence.push({
        initialCatalog,
        finalCatalog: catalog,
        baseSentinel: "preserved",
        fixtureBase,
        recordedDatabases: [...recordedDatabases],
      })
      await writeFile(
        join(scratch, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      )
      console.log(`PostgreSQL evidence: ${join(scratch, "evidence.json")}`)
    } finally {
      if (admin?.isInitialized) await admin.destroy()
      try {
        if (fixtureCreated)
          await serverAdmin.query(`DROP DATABASE ${quote(fixtureBase)}`)
      } finally {
        if (serverAdmin?.isInitialized) await serverAdmin.destroy()
      }
    }
  })

  async function compile(
    options: Parameters<typeof Database.forTest>[0],
    url = databaseUrl!,
  ) {
    app = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: url })],
        }),
        Database.forTest(options),
      ],
    }).compile()
    recordedDatabases.add(
      Database.getTestDatabaseInfo(new ConfigService({ DATABASE_URL: url }))
        .databaseName,
    )
    return { factory: Database.getTestDataSource(), nest: app.get(DataSource) }
  }

  async function absent(name: string) {
    expect(
      await admin.query<{ datname: string }[]>(
        "SELECT datname FROM pg_database WHERE datname = $1",
        [name],
      ),
    ).toEqual([])
  }

  it("runs a real migration with TypeORM discovery and complete repository/junction metadata", async () => {
    const { factory, nest } = await compile({
      entities: [join(__dirname, "fixtures/records.entity.ts")],
      migrations: [join(__dirname, "fixtures/schema.migration.ts")],
      migrationsRun: true,
      migrationsTableName: "fixture_history",
      migrationsTransactionMode: "all",
    })
    const info = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    for (const source of [factory, nest]) {
      expect(source.options.synchronize).toBe(false)
      expect(
        await source.query<{ name: string }[]>(
          "SELECT current_database() AS name",
        ),
      ).toEqual([{ name: info.databaseName }])
      expect(
        source.entityMetadatas.map((meta) => meta.tableName).sort(),
      ).toEqual(
        [
          "note",
          "person record",
          "person_tags",
          "tag",
          'quote"record',
          "entry",
        ].sort(),
      )
    }
    expect(nest.options.migrationsRun).toBe(false)
    await factory
      .getRepository(Person)
      .save({ name: "Alice", tags: [{ name: "friend" }] })
    const people = await nest
      .getRepository(Person)
      .find({ relations: { tags: true } })
    expect(people[0].tags[0].name).toBe("friend")
    await nest.getRepository(Note).save({ text: "note" })
    expect(await factory.getRepository(Note).count()).toBe(1)
    await factory.query('INSERT INTO public."quote""record" VALUES (1)')
    await Database.clearTestDatabase()
    expect(
      await factory.query<{ count: string }[]>(
        'SELECT count(*) FROM public."quote""record"',
      ),
    ).toEqual([{ count: "0" }])
    expect(await nest.getRepository(Person).count()).toBe(0)
    expect(await factory.getRepository(Tag).count()).toBe(0)
    expect(
      await factory.query<{ count: string }[]>(
        "SELECT count(*) FROM fixtures.person_tags",
      ),
    ).toEqual([{ count: "0" }])
    expect(
      await factory.query<{ count: string }[]>(
        "SELECT count(*) FROM public.fixture_history",
      ),
    ).toEqual([{ count: "1" }])
    expect(
      await factory.query<{ id: number }[]>(
        "SELECT id FROM public.migration_only",
      ),
    ).toEqual([{ id: 1 }])
    evidence.push({
      mode: "migrations-discovery",
      ...info,
      metadata: factory.entityMetadatas.map((meta) => meta.tableName),
    })
    await app!.close()
    app = undefined
    await Database.closeTestConnection()
    expect(factory.isInitialized).toBe(false)
    expect(nest.isInitialized).toBe(false)
    await absent(info.databaseName)
  })

  it("keeps class-list and EntitySchema callers synchronized and supports repeat setup", async () => {
    const { factory, nest } = await compile({
      entities: [Entry, Note],
    })
    await nest.getRepository(Note).save({ text: "compatible" })
    expect(await factory.getRepository(Note).count()).toBe(1)
    const info = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    await Database.closeTestConnection()
    expect(factory.isInitialized).toBe(false)
    expect(nest.isInitialized).toBe(false)
    await absent(info.databaseName)
    await Database.setupTestDatabase(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    expect(await Database.getTestDataSource().getRepository(Note).count()).toBe(
      0,
    )
  })

  it("preserves a collision and its sentinel on setup and close", async () => {
    Database.forTest({ entities: [Note] })
    const info = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    await admin.query(`CREATE DATABASE ${quote(info.databaseName)}`)
    externalDatabases.add(info.databaseName)
    const other = await new DataSource({
      type: "postgres",
      url: targetUrl(databaseUrl!, info.databaseName),
    }).initialize()
    try {
      await other.query("CREATE TABLE sentinel (id integer)")
      await other.query("INSERT INTO sentinel VALUES (7)")
      await expect(
        Database.setupTestDatabase(
          new ConfigService({ DATABASE_URL: databaseUrl }),
        ),
      ).rejects.toThrow(/already exists/)
      await Database.clearTestDatabase()
      await Database.closeTestConnection()
      expect(
        await other.query<{ id: number }[]>("SELECT id FROM sentinel"),
      ).toEqual([{ id: 7 }])
    } finally {
      await other.destroy()
    }
  })

  it("refuses ordinary DROP while an external connection is active and supports retry", async () => {
    const { factory, nest } = await compile({ entities: [Note] })
    const info = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    const other = await new DataSource({
      type: "postgres",
      url: targetUrl(databaseUrl!, info.databaseName),
    }).initialize()
    try {
      await expect(Database.resetTestDatabase()).rejects.toThrow(
        /being accessed/,
      )
      expect(factory.isInitialized).toBe(false)
      expect(nest.isInitialized).toBe(false)
      expect(Database.initializeTestInvocation().namespace).toBe(info.namespace)
      expect(
        await other.query<{ name: string }[]>(
          "SELECT current_database() AS name",
        ),
      ).toEqual([{ name: info.databaseName }])
    } finally {
      await other.destroy()
    }
    await Database.resetTestDatabase()
    await absent(info.databaseName)
  }, 15000)

  it("preserves a real migration error when factory cleanup also fails", async () => {
    Database.forTest({
      entities: [Note],
      migrations: [FailingSchema1700000000001],
      migrationsRun: true,
    })
    const config = new ConfigService({ DATABASE_URL: databaseUrl })
    const info = Database.getTestDatabaseInfo(config)
    recordedDatabases.add(info.databaseName)
    const destroy = jest.spyOn(DataSource.prototype, "destroy")
    const original = destroy.getMockImplementation()!
    destroy.mockImplementation(function (this: DataSource) {
      if (this.options.database === info.databaseName)
        return Promise.reject(
          new Error("intentional automatic destroy failure"),
        )
      return original.call(this)
    })
    try {
      let failure: unknown
      try {
        await Database.setupTestDatabase(config)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(AggregateError)
      const messages = (failure as AggregateError).errors.map(String)
      expect(messages.join("\n")).toMatch(/intentional migration failure/)
      expect(messages.join("\n")).toMatch(
        /intentional automatic destroy failure/,
      )
      await expect(Database.setupTestDatabase(config)).rejects.toThrow(
        "cleanup must succeed",
      )
      expect(() => Database.forTest({ entities: [Note] })).toThrow(
        "cleanup must succeed",
      )
      evidence.push({
        mode: "migration-and-destroy-failure",
        ...info,
        errors: messages,
      })
    } finally {
      destroy.mockRestore()
    }
    await Database.closeTestConnection()
    await absent(info.databaseName)
  })

  it("blocks setup and Nest creation after failed factory teardown until cleanup succeeds", async () => {
    const { factory } = await compile({ entities: [Note] })
    const config = new ConfigService({ DATABASE_URL: databaseUrl })
    const info = Database.getTestDatabaseInfo(config)
    const destroy = jest
      .spyOn(factory, "destroy")
      .mockRejectedValue(new Error("intentional retained factory"))
    try {
      await expect(Database.closeTestConnection()).rejects.toThrow(
        "intentional retained factory",
      )
      expect(factory.isInitialized).toBe(true)
      await expect(Database.setupTestDatabase(config)).rejects.toThrow(
        "cleanup must succeed",
      )
      expect(() => Database.forTest({ entities: [Note] })).toThrow(
        "cleanup must succeed",
      )
      expect(() => Database.getTestDataSource()).toThrow("not initialized")
      evidence.push({
        mode: "failed-teardown-blocks-setup",
        ...info,
        setupRejected: true,
        factoryRetained: factory.isInitialized,
      })
    } finally {
      destroy.mockRestore()
    }
    await Database.closeTestConnection()
    await absent(info.databaseName)
    await Database.setupTestDatabase(config)
    expect(Database.getTestDataSource()).not.toBe(factory)
  })

  it("rejects replaced ownership and preserves the replacement sentinel", async () => {
    await verifyChild(await childRun("replacement"), 1)
  }, 120000)

  it.each([
    `雪" space%_${randomUUID()}`,
    `a${randomUUID().replaceAll("-", "")} ${"a".repeat(29)}`,
  ])("connects to safely quoted UTF-8 bases %p", async (base) => {
    const url = new URL(databaseUrl!)
    url.pathname = `/${encodeURIComponent(base)}`
    await admin.query(`CREATE DATABASE ${quote(base)}`)
    externalDatabases.add(base)
    const { factory, nest } = await compile(
      { entities: [Note] },
      url.toString(),
    )
    const info = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: url.toString() }),
    )
    expect(Buffer.byteLength(info.databaseName)).toBeLessThanOrEqual(63)
    await factory.getRepository(Note).save({ text: "quoted" })
    expect(await nest.getRepository(Note).count()).toBe(1)
    await Database.closeTestConnection()
    await absent(info.databaseName)
  })

  async function waitForFile(
    path: string,
    run: Awaited<ReturnType<typeof childRun>>,
    limit = 60000,
  ): Promise<void> {
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
      const ended = run.result()
      if (ended)
        throw new Error(
          `Child exited before readiness (${ended.code}): ${ended.output}`,
        )
      try {
        await access(path)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Child evidence deadline expired: ${path}`)
  }

  async function childRun(mode: typeof scenario.mode, count = 1) {
    const directory = await mkdtemp(join(scratch, "child-"))
    const source = `import { runScenario } from ${JSON.stringify(join(__dirname, "fixtures/runner"))}; runScenario()\n`
    for (let i = 0; i < count; i++)
      await writeFile(join(directory, `worker-${i}.spec.ts`), source)
    const config = {
      rootDir: process.cwd(),
      roots: [directory],
      testRegex: ".*\\.spec\\.ts$",
      transform: {
        "^.+\\.ts$": ["ts-jest", { tsconfig: resolve("tsconfig.json") }],
      },
      testEnvironment: "node",
      setupFiles: [join(__dirname, "fixtures/initialize.ts")],
      globals: {
        ...(count > 1 ? { invocation: createTestDatabaseInvocation() } : {}),
        scenario: { directory, mode },
      },
      cacheDirectory: join(scratch, "jest-cache"),
    }
    const args = [
      require.resolve("jest/bin/jest"),
      "--config",
      JSON.stringify(config),
      ...(count === 1 ? ["--runInBand"] : ["--maxWorkers=2"]),
    ]
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.add(child)
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    let completed: { code: number | null; output: string } | undefined
    const completion = new Promise<{ code: number | null; output: string }>(
      (resolveExit, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`Child failed to exit naturally: ${output}`))
        }, 90000)
        child.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once("exit", (code, signal) => {
          clearTimeout(timer)
          children.delete(child)
          if (signal) reject(new Error(`Child received ${signal}: ${output}`))
          else {
            completed = { code, output }
            resolveExit(completed)
          }
        })
      },
    )
    return { directory, completion, args, count, mode, result: () => completed }
  }

  async function verifyChild(
    run: Awaited<ReturnType<typeof childRun>>,
    expected: number,
  ) {
    const result = await run.completion
    expect(result.output).not.toMatch(/did not exit|forceExit|open handle/i)
    if (result.code !== expected)
      throw new Error(`Unexpected child exit ${result.code}: ${result.output}`)
    const identities: TestDatabaseInfo[] = []
    for (let i = 0; i < run.count; i++) {
      const identity = JSON.parse(
        await readFile(
          join(run.directory, `worker-${i}.spec.ts.identity.json`),
          "utf8",
        ),
      ) as TestDatabaseInfo
      const closed = JSON.parse(
        await readFile(
          join(run.directory, `worker-${i}.spec.ts.closed.json`),
          "utf8",
        ),
      ) as { factoryClosed: boolean; nestClosed: boolean }
      expect(closed).toMatchObject({ factoryClosed: true, nestClosed: true })
      if (run.mode === "replacement" || run.mode === "oid-fail") {
        const other = await new DataSource({
          type: "postgres",
          url: targetUrl(databaseUrl!, identity.databaseName),
        }).initialize()
        try {
          if (run.mode === "replacement")
            expect(
              await other.query<{ id: number }[]>("SELECT id FROM sentinel"),
            ).toEqual([{ id: 7 }])
        } finally {
          await other.destroy()
        }
        await admin.query(`DROP DATABASE ${quote(identity.databaseName)}`)
      }
      recordedDatabases.add(identity.databaseName)
      await absent(identity.databaseName)
      identities.push(identity)
    }
    if (run.mode.endsWith("fail"))
      expect(result.output).toMatch(/intentional|cleanup failed/i)
    evidence.push({
      mode: run.mode,
      command: [process.execPath, ...run.args],
      code: result.code,
      identities,
      output: result.output,
    })
    return identities
  }

  it("isolates two concurrent ordinary invocations while one holds a sentinel", async () => {
    const a = await childRun("hold")
    try {
      await waitForFile(join(a.directory, "worker-0.spec.ts.ready.json"), a)
      const b = await childRun("pass")
      const bInfo = await verifyChild(b, 0)
      await writeFile(join(a.directory, "release"), "release")
      const aInfo = await verifyChild(a, 0)
      expect(aInfo[0].databaseName).not.toBe(bInfo[0].databaseName)
      expect(aInfo[0].namespace).not.toBe(bInfo[0].namespace)
    } finally {
      await writeFile(join(a.directory, "release"), "release")
    }
  }, 160000)

  it("uses actual distinct Jest workers with one pre-import invocation token", async () => {
    const run = await childRun("hold", 2)
    try {
      await Promise.all(
        [0, 1].map((i) =>
          waitForFile(
            join(run.directory, `worker-${i}.spec.ts.ready.json`),
            run,
          ),
        ),
      )
      await writeFile(join(run.directory, "release"), "release")
      const info = await verifyChild(run, 0)
      expect(new Set(info.map((value) => value.processId)).size).toBe(2)
      expect(new Set(info.map((value) => value.workerId)).size).toBe(2)
      expect(new Set(info.map((value) => value.databaseName)).size).toBe(2)
      expect(new Set(info.map((value) => value.namespace)).size).toBe(1)
    } finally {
      await writeFile(join(run.directory, "release"), "release")
    }
  }, 120000)

  it.each([
    "test-fail",
    "setup-fail",
    "compile-fail",
    "teardown-fail",
    "oid-fail",
    "admin-destroy-fail",
    "factory-destroy-fail",
  ] as const)(
    "exits naturally and cleans both owners for %s",
    async (mode) => {
      const run = await childRun(mode)
      await verifyChild(run, 1)
    },
    120000,
  )
})
