import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test, TestingModule } from "@nestjs/testing"
import { DataSource } from "typeorm"
import { createHash, randomUUID } from "node:crypto"
import { spawn, fork, ChildProcess, Serializable } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  createTestDatabaseInvocation,
  SharedDatabaseModule as Database,
  TestDatabaseInfo,
} from "./index"
import { createTlsProxy } from "./fixtures/tls-proxy"
import { FailingSchema1700000000001 } from "./fixtures/failing.migration"
import { Person, Tag, Note, Entry } from "./fixtures/records.entity"

const environment = new ConfigService()
const suppliedUrl = environment.get<string>("DATABASE_URL")
if (environment.get("CI") && !suppliedUrl)
  throw new Error("CI requires DATABASE_URL for native database acceptance")
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
  const recoveryRole = `fixture_role_${randomUUID().replaceAll("-", "")}`
  let recoveryBaseUrl: string
  let roleCreated = false
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
    const password = randomUUID()
    await admin.query(
      `CREATE ROLE ${quote(recoveryRole)} LOGIN CREATEDB PASSWORD '${password}'`,
    )
    roleCreated = true
    const recoveryUrl = new URL(databaseUrl)
    recoveryUrl.username = recoveryRole
    recoveryUrl.password = password
    recoveryBaseUrl = recoveryUrl.toString()
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
    await Promise.all(
      [...children].map(async (child) => {
        const exited = new Promise<void>((resolveExit) =>
          child.once("exit", () => resolveExit()),
        )
        child.kill("SIGKILL")
        await exited
      }),
    )
    try {
      for (const name of externalDatabases) {
        const rows = await admin.query<{ oid: number }[]>(
          "SELECT oid FROM pg_database WHERE datname = $1",
          [name],
        )
        if (rows.length) await admin.query(`DROP DATABASE ${quote(name)}`)
      }
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
        if (roleCreated)
          await serverAdmin.query(`DROP ROLE ${quote(recoveryRole)}`)
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
      ).rejects.toMatchObject({ code: "DATABASE_FAILURE" })
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
      await expect(Database.resetTestDatabase()).rejects.toMatchObject({
        code: "DATABASE_FAILURE",
      })
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

  function ordinaryChild(mode: "creator" | "recovery", url = recoveryBaseUrl) {
    const child = fork(
      join(__dirname, "fixtures/recovery-runner.cjs"),
      [mode],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    )
    children.add(child)
    const messages: unknown[] = []
    const waiters: Array<(value: unknown) => void> = []
    child.on("message", (message) => {
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else messages.push(message)
    })
    const exit = new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolveExit) => {
      child.once("exit", (code, signal) => {
        children.delete(child)
        resolveExit({ code, signal })
      })
    })
    return {
      child,
      exit,
      async message<T>(): Promise<T> {
        if (messages.length) return messages.shift() as T
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            new Promise<T>((resolveMessage) =>
              waiters.push((value) => resolveMessage(value as T)),
            ),
            exit.then(() => {
              throw new Error("Fixture exited before its message")
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Fixture message deadline")),
                15000,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      },
    }
  }

  async function retainedCreator(url = recoveryBaseUrl) {
    const run = ordinaryChild("creator", url)
    const { ready } = await run.message<{
      ready: {
        database: TestDatabaseInfo
        acquiredOid: number
        exclusiveTarget: true
      }
    }>()
    expect(ready).toBeDefined()
    recordedDatabases.add(ready.database.databaseName)
    externalDatabases.add(ready.database.databaseName)
    const savedPath = join(scratch, `acquired-${randomUUID()}.json`)
    await writeFile(savedPath, JSON.stringify(ready), { mode: 0o600 })
    const saved = JSON.parse(await readFile(savedPath, "utf8")) as typeof ready
    return { ...run, input: saved }
  }

  async function stopCreator(run: Awaited<ReturnType<typeof retainedCreator>>) {
    run.child.kill("SIGKILL")
    expect((await run.exit).signal).toBe("SIGKILL")
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const [{ count }] = await admin.query<{ count: string }[]>(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = $1",
        [run.input.database.databaseName],
      )
      if (count === "0") return
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
    throw new Error("Creator connection did not leave")
  }

  async function freshRecovery(
    input: Serializable,
    afterDispatch?: (run: ReturnType<typeof ordinaryChild>) => Promise<void>,
    url = recoveryBaseUrl,
  ) {
    const run = ordinaryChild("recovery", url)
    run.child.send(input)
    await afterDispatch?.(run)
    const result = await run.message<{
      result?: { status: string }
      failure?: {
        code: string
        phase: string
        outcome: string
        failures: Array<{ code: string; phase: string }>
      }
    }>()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(
        await Promise.race([
          run.exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              run.child.kill("SIGKILL")
              reject(new Error("Recovery failed to exit naturally"))
            }, 5000)
          }),
        ]),
      ).toEqual({ code: 0, signal: null })
    } finally {
      clearTimeout(timer)
    }
    return result
  }

  it("recovers a terminated creator through a fresh public-package process and retries idempotently", async () => {
    const creator = await retainedCreator()
    const sibling = await retainedCreator()
    try {
      expect(await freshRecovery(creator.input)).toMatchObject({
        failure: { code: "BUSY", outcome: "not-attempted" },
      })
      creator.child.send("clear")
      expect(await creator.message()).toEqual({ cleared: true })
      expect(await freshRecovery(creator.input)).toMatchObject({
        failure: { code: "BUSY" },
      })
      await stopCreator(creator)
      expect(await freshRecovery(creator.input)).toEqual({
        result: { status: "removed" },
      })
      externalDatabases.delete(creator.input.database.databaseName)
      await absent(creator.input.database.databaseName)
      expect(await freshRecovery(creator.input)).toEqual({
        result: { status: "already-absent" },
      })
      sibling.child.send("sentinel")
      expect(await sibling.message()).toEqual({ sentinel: [{ id: 7 }] })
      sibling.child.send("close")
      expect(await sibling.message()).toEqual({ closed: true })
      expect(await sibling.exit).toEqual({ code: 0, signal: null })
      externalDatabases.delete(sibling.input.database.databaseName)
      expect(await freshRecovery(sibling.input)).toEqual({
        result: { status: "already-absent" },
      })
      evidence.push({
        mode: "fresh-public-recovery",
        removed: 1,
        alreadyAbsent: 2,
        busy: 2,
        siblingSentinel: "preserved",
        recoveryNaturalExits: 5,
        normalCreatorNaturalExits: 1,
      })
    } finally {
      for (const run of [creator, sibling])
        if (children.has(run.child)) {
          run.child.kill("SIGKILL")
          await run.exit
        }
    }
  }, 60000)

  it.each(['quoted"base', "雪😀".repeat(7)])(
    "recovers original identities with a %s base",
    async (prefix) => {
      const baseName = prefix + randomUUID().slice(0, 8)
      await admin.query(
        `CREATE DATABASE ${quote(baseName)} OWNER ${quote(recoveryRole)}`,
      )
      externalDatabases.add(baseName)
      const url = targetUrl(recoveryBaseUrl, baseName)
      const creator = await retainedCreator(url)
      try {
        expect(
          Buffer.byteLength(creator.input.database.databaseName),
        ).toBeLessThanOrEqual(63)
        await stopCreator(creator)
        expect(await freshRecovery(creator.input, undefined, url)).toEqual({
          result: { status: "removed" },
        })
        externalDatabases.delete(creator.input.database.databaseName)
        expect(await freshRecovery(creator.input, undefined, url)).toEqual({
          result: { status: "already-absent" },
        })
      } finally {
        if (children.has(creator.child)) {
          creator.child.kill("SIGKILL")
          await creator.exit
        }
        await admin.query(`DROP DATABASE ${quote(baseName)}`)
        externalDatabases.delete(baseName)
      }
    },
    30000,
  )

  it("serializes concurrent fresh recovery and permits an explicit retry", async () => {
    const creator = await retainedCreator()
    await stopCreator(creator)
    const results = await Promise.all([
      freshRecovery(creator.input),
      freshRecovery(creator.input),
    ])
    expect(
      results.filter((value) => value.result?.status === "removed"),
    ).toHaveLength(1)
    for (const value of results) {
      if (value.failure)
        expect(value.failure).toMatchObject({
          code: "BUSY",
          outcome: "not-attempted",
        })
      else expect(["removed", "already-absent"]).toContain(value.result?.status)
    }
    expect(await freshRecovery(creator.input)).toEqual({
      result: { status: "already-absent" },
    })
    externalDatabases.delete(creator.input.database.databaseName)
  }, 30000)

  it("refuses two recovery callers behind a real held lifecycle lock", async () => {
    const creator = await retainedCreator()
    await stopCreator(creator)
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "@lyrolab/nest-shared/test-database",
          creator.input.database.databaseName,
        ]),
      )
      .digest()
      .readBigInt64BE()
      .toString()
    const barrier = admin.createQueryRunner()
    await barrier.connect()
    try {
      await barrier.query("SELECT pg_advisory_lock($1::bigint)", [key])
      for (const result of await Promise.all([
        freshRecovery(creator.input),
        freshRecovery(creator.input),
      ]))
        expect(result).toMatchObject({
          failure: { code: "BUSY", outcome: "not-attempted" },
        })
    } finally {
      await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [key])
      await barrier.release()
    }
    expect(await freshRecovery(creator.input)).toEqual({
      result: { status: "removed" },
    })
    externalDatabases.delete(creator.input.database.databaseName)
  }, 30000)

  it.each(["deadline", "cancellation"])(
    "bounds a real connected-target DROP with %s and retries explicitly",
    async (mode) => {
      const creator = await retainedCreator()
      await stopCreator(creator)
      const name = creator.input.database.databaseName
      const peer = await new DataSource({
        type: "postgres",
        url: targetUrl(recoveryBaseUrl, name),
      }).initialize()
      try {
        const started = Date.now()
        const result = await freshRecovery(
          { ...creator.input, timeoutMs: mode === "deadline" ? 1500 : 10000 },
          async (run) => {
            const limit = Date.now() + 5000
            while (Date.now() < limit) {
              const rows = await admin.query<{ query: string }[]>(
                "SELECT query FROM pg_stat_activity WHERE usename = $1 AND datname = $2 AND state = 'active' AND query LIKE 'DROP DATABASE %'",
                [recoveryRole, fixtureBase],
              )
              if (rows.length) {
                if (mode === "cancellation") run.child.send("abort")
                return
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 10))
            }
            throw new Error("DROP barrier was not reached")
          },
        )
        expect(result).toMatchObject({
          failure: {
            code: mode === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED",
            outcome: "unknown",
          },
        })
        expect(Date.now() - started).toBeLessThan(7000)
        expect(await peer.query("SELECT id FROM sentinel")).toEqual([{ id: 7 }])
      } finally {
        await peer.destroy()
      }
      const retry = await freshRecovery(creator.input)
      expect(["removed", "already-absent"]).toContain(retry.result?.status)
      expect(retry.failure).toBeUndefined()
      await absent(name)
      externalDatabases.delete(name)
    },
    30000,
  )

  const lifecycleScenarios = JSON.parse(
    readFileSync(join(__dirname, "fixtures/lifecycle-scenarios.json"), "utf8"),
  ) as Array<{ operation: string; phase: string }>
  it.each(lifecycleScenarios)(
    "holds the native lifecycle lease during $operation at $phase",
    async ({ operation, phase }) => {
      const creator = await retainedCreator()
      try {
        creator.child.send({ operation, phase })
        expect(await creator.message()).toEqual({ barrier: phase })
        expect(await freshRecovery(creator.input)).toMatchObject({
          failure: { code: "BUSY", outcome: "not-attempted" },
        })
        creator.child.send("release")
        expect(await creator.message()).toEqual({ completed: operation })
        creator.child.send("close")
        expect(await creator.message()).toEqual({ closed: true })
        expect(await creator.exit).toEqual({ code: 0, signal: null })
        expect(await freshRecovery(creator.input)).toEqual({
          result: { status: "already-absent" },
        })
        externalDatabases.delete(creator.input.database.databaseName)
      } finally {
        if (children.has(creator.child)) {
          creator.child.kill("SIGKILL")
          await creator.exit
        }
      }
    },
    30000,
  )

  it("refuses unsafe use after native lease loss and reacquires for cleanup retry", async () => {
    const creator = await retainedCreator()
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "@lyrolab/nest-shared/test-database",
          creator.input.database.databaseName,
        ]),
      )
      .digest()
      .readBigInt64BE()
      .toString()
    const barrier = admin.createQueryRunner()
    await barrier.connect()
    try {
      const leases = await admin.query<{ pid: number }[]>(
        "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND datname = $2 AND application_name = 'nest-shared-test-database'",
        [recoveryRole, fixtureBase],
      )
      expect(leases).toHaveLength(1)
      await admin.query("SELECT pg_terminate_backend($1)", [leases[0].pid])
      await barrier.query("SELECT pg_advisory_lock($1::bigint)", [key])
      creator.child.send("unsafe")
      expect(await creator.message()).toEqual({ refused: 3 })
      creator.child.send("retry-close")
      expect(await creator.message()).toEqual({ cleanup: "refused" })
      const target = await new DataSource({
        type: "postgres",
        url: targetUrl(recoveryBaseUrl, creator.input.database.databaseName),
      }).initialize()
      try {
        expect(await target.query("SELECT id FROM sentinel")).toEqual([
          { id: 7 },
        ])
      } finally {
        await target.destroy()
      }
      await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [key])
      creator.child.send("close")
      expect(await creator.message()).toEqual({ closed: true })
      expect(await creator.exit).toEqual({ code: 0, signal: null })
      expect(await freshRecovery(creator.input)).toEqual({
        result: { status: "already-absent" },
      })
      externalDatabases.delete(creator.input.database.databaseName)
    } finally {
      await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [key])
      await barrier.release()
      if (children.has(creator.child)) {
        creator.child.kill("SIGKILL")
        await creator.exit
      }
    }
  }, 30000)

  const nativeTlsScenarios = JSON.parse(
    readFileSync(join(__dirname, "fixtures/native-tls-scenarios.json"), "utf8"),
  ) as Array<{ name: string; mutual: boolean }>
  it.each(nativeTlsScenarios)(
    "preserves normal TLS setup, lifetime lease and recovery with $name",
    async ({ mutual }) => {
      const proxy = await createTlsProxy(recoveryBaseUrl, scratch, mutual)
      try {
        const natural = await retainedCreator(proxy.normalUrl)
        const recover = (input: typeof natural.input) =>
          freshRecovery({ ...input, base: proxy.base })
        expect(await recover(natural.input)).toMatchObject({
          failure: { code: "BUSY", outcome: "not-attempted" },
        })
        natural.child.send("clear")
        expect(await natural.message()).toEqual({ cleared: true })
        natural.child.send("close")
        expect(await natural.message()).toEqual({ closed: true })
        expect(await natural.exit).toEqual({ code: 0, signal: null })
        expect(await recover(natural.input)).toEqual({
          result: { status: "already-absent" },
        })
        externalDatabases.delete(natural.input.database.databaseName)
        const retained = await retainedCreator(proxy.normalUrl)
        await stopCreator(retained)
        expect(await recover(retained.input)).toEqual({
          result: { status: "removed" },
        })
        await absent(retained.input.database.databaseName)
        expect(await recover(retained.input)).toEqual({
          result: { status: "already-absent" },
        })
        externalDatabases.delete(retained.input.database.databaseName)
        expect(proxy.report().secureConnections).toBeGreaterThan(4)
        if (mutual)
          expect(proxy.report().verifiedClients).toBe(
            proxy.report().secureConnections,
          )
      } finally {
        await proxy.close()
      }
    },
    60000,
  )

  const nativeFaultScenarios = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/native-fault-scenarios.json"),
      "utf8",
    ),
  ) as Array<{
    fault: string
    code: string
    phase: string
    outcome: string
    closeFailure?: boolean
  }>
  it.each(nativeFaultScenarios)(
    "preserves $fault at the injected driver boundary with a native postcondition",
    async ({ fault, code, phase, outcome, closeFailure }) => {
      const creator = await retainedCreator()
      await stopCreator(creator)
      const result = await freshRecovery({ options: creator.input, fault })
      expect(result).toMatchObject({ failure: { code, phase, outcome } })
      if (closeFailure)
        expect(result.failure?.failures).toEqual([
          { code, phase },
          { code: "CLOSE_FAILED", phase: "close" },
        ])
      await absent(creator.input.database.databaseName)
      expect(await freshRecovery(creator.input)).toEqual({
        result: { status: "already-absent" },
      })
      externalDatabases.delete(creator.input.database.databaseName)
    },
    30000,
  )

  it("retains native teardown retry state after DROP and an injected lease-close failure", async () => {
    const creator = await retainedCreator()
    try {
      creator.child.send("failed-close")
      expect(await creator.message()).toEqual({ closeFailed: true })
      await absent(creator.input.database.databaseName)
      creator.child.send("unsafe")
      expect(await creator.message()).toEqual({ refused: 3 })
      creator.child.send("close")
      expect(await creator.message()).toEqual({ closed: true })
      expect(await creator.exit).toEqual({ code: 0, signal: null })
      expect(await freshRecovery(creator.input)).toEqual({
        result: { status: "already-absent" },
      })
      externalDatabases.delete(creator.input.database.databaseName)
    } finally {
      if (children.has(creator.child)) {
        creator.child.kill("SIGKILL")
        await creator.exit
      }
    }
  }, 30000)

  const recoveryScenarios = JSON.parse(
    readFileSync(join(__dirname, "fixtures/recovery-scenarios.json"), "utf8"),
  ) as Array<{ name: string; mutation: string; code: string }>
  it.each(recoveryScenarios)(
    "preserves the retained sentinel for $name",
    async ({ mutation, code }) => {
      const creator = await retainedCreator()
      await stopCreator(creator)
      const input = structuredClone(creator.input)
      if (mutation === "missing-oid")
        delete (input as { acquiredOid?: number }).acquiredOid
      if (mutation === "wrong-oid") input.acquiredOid++
      if (mutation === "wrong-name")
        input.database = { ...input.database, databaseName: "foreign" }
      if (mutation === "malformed")
        input.database = { ...input.database, namespace: "" }
      const name = creator.input.database.databaseName
      let renamed: string | undefined
      let peer: DataSource | undefined
      if (mutation === "replacement") {
        await admin.query(`DROP DATABASE ${quote(name)}`)
        await admin.query(
          `CREATE DATABASE ${quote(name)} OWNER ${quote(recoveryRole)}`,
        )
        const source = await new DataSource({
          type: "postgres",
          url: targetUrl(databaseUrl!, name),
        }).initialize()
        await source.query("CREATE TABLE sentinel (id integer)")
        await source.query("INSERT INTO sentinel VALUES (7)")
        await source.destroy()
      }
      if (mutation === "rename") {
        renamed = `renamed_${randomUUID().replaceAll("-", "")}`
        await admin.query(
          `ALTER DATABASE ${quote(name)} RENAME TO ${quote(renamed)}`,
        )
        externalDatabases.delete(name)
        externalDatabases.add(renamed)
      }
      if (mutation === "owner")
        await admin.query(
          `ALTER DATABASE ${quote(name)} OWNER TO ${quote(decodeURIComponent(new URL(databaseUrl!).username))}`,
        )
      if (mutation === "connected")
        peer = await new DataSource({
          type: "postgres",
          url: targetUrl(databaseUrl!, name),
        }).initialize()
      if (mutation === "base")
        Object.assign(input, {
          base: {
            databaseUrl: targetUrl(recoveryBaseUrl, "postgres"),
            expectedRole: recoveryRole,
          },
        })
      if (mutation === "role")
        Object.assign(input, {
          base: { databaseUrl: recoveryBaseUrl, expectedRole: "foreign" },
        })
      try {
        expect(await freshRecovery(input)).toMatchObject({
          failure: {
            code,
            outcome: mutation === "connected" ? "unknown" : "not-attempted",
          },
        })
        const target = await new DataSource({
          type: "postgres",
          url: targetUrl(databaseUrl!, renamed ?? name),
        }).initialize()
        try {
          expect(await target.query("SELECT id FROM sentinel")).toEqual([
            { id: 7 },
          ])
        } finally {
          await target.destroy()
        }
      } finally {
        if (peer?.isInitialized) await peer.destroy()
      }
      if (renamed) {
        await admin.query(
          `ALTER DATABASE ${quote(renamed)} RENAME TO ${quote(name)}`,
        )
        externalDatabases.delete(renamed)
        externalDatabases.add(name)
      }
      if (mutation === "owner")
        await admin.query(
          `ALTER DATABASE ${quote(name)} OWNER TO ${quote(recoveryRole)}`,
        )
      if (mutation === "replacement") {
        await admin.query(`DROP DATABASE ${quote(name)}`)
        expect(await freshRecovery(creator.input)).toEqual({
          result: { status: "already-absent" },
        })
      } else
        expect(await freshRecovery(creator.input)).toEqual({
          result: { status: "removed" },
        })
      externalDatabases.delete(name)
    },
    30000,
  )

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
