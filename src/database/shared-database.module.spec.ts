import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { DataSource, EntitySchema } from "typeorm"
import {
  createTestDatabaseInvocation,
  recoverTestDatabase,
  RecoverTestDatabaseOptions,
  TestDatabaseRecoveryError,
  TestDatabaseRecoveryResult,
  SharedDatabaseModule as Database,
} from "./index"

import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { captureRecoveryInput } from "./helpers/test-database-recovery-input"
import { TestDatabaseSession } from "./helpers/test-database-session"

const baseUrl = "postgres://local:local@localhost/base"
function config(name = "base") {
  return new ConfigService({
    DATABASE_URL: `postgres://local:local@localhost/${encodeURIComponent(name)}`,
  })
}

function connected(source: DataSource, value: boolean) {
  Object.defineProperty(source, "isInitialized", { value, configurable: true })
}

describe("test database public API", () => {
  let worker: Record<string, string | undefined>
  beforeEach(() => {
    worker = {}
    const original = ConfigService.prototype.get as (key: string) => unknown
    jest.spyOn(ConfigService.prototype, "get").mockImplementation(function (
      this: ConfigService,
      key: string,
    ) {
      if (key === "VITEST_POOL_ID" || key === "JEST_WORKER_ID")
        return worker[key]
      return original.call(this, key)
    })
  })
  afterEach(async () => {
    jest.spyOn(DataSource.prototype, "destroy").mockImplementation(function (
      this: DataSource,
    ) {
      connected(this, false)
      return Promise.resolve()
    })
    jest.spyOn(DataSource.prototype, "initialize").mockImplementation(function (
      this: DataSource,
    ) {
      connected(this, true)
      return Promise.resolve(this)
    })
    // Preserve the fixture catalog through retry cleanup.
    const query = jest.mocked(DataSource.prototype.query)
    if (query.mock) query.mockImplementation(catalogQuery)
    await Database.resetTestDatabase()
    jest.restoreAllMocks()
  })

  it("exports frozen random tokens and captures one invocation before database configuration", () => {
    const first = createTestDatabaseInvocation()
    expect(Object.isFrozen(first)).toBe(true)
    expect(first.namespace).toMatch(new RegExp(`^${process.pid}-[a-f0-9-]+$`))
    expect(createTestDatabaseInvocation().namespace).not.toBe(first.namespace)
    expect(Database.initializeTestInvocation(first)).toEqual(first)
    expect(Database.initializeTestInvocation()).toEqual(first)
    expect(() =>
      Database.initializeTestInvocation(createTestDatabaseInvocation()),
    ).toThrow("resetTestDatabase")
    expect(() => Database.getTestDataSource()).toThrow("not initialized")
  })

  it.each([
    [{ VITEST_POOL_ID: "v", JEST_WORKER_ID: "j" }, "v"],
    [{ VITEST_POOL_ID: "", JEST_WORKER_ID: "j" }, ""],
    [{ JEST_WORKER_ID: "j" }, "j"],
    [{}, "0"],
  ])("captures nullish worker precedence for %p", (input, expected) => {
    worker = input
    const info = Database.getTestDatabaseInfo(config())
    expect(info.workerId).toBe(expected)
    worker.VITEST_POOL_ID = "later"
    expect(Database.getTestDatabaseInfo(config())).toBe(info)
    expect(info.processId).toBe(process.pid)
  })

  it.each([
    "a".repeat(100),
    '雪" / %'.repeat(30),
    'spaces and quotes"',
    "normal",
  ])("bounds and encodes %s", (base) => {
    const info = Database.getTestDatabaseInfo(config(base))
    expect(Buffer.byteLength(info.databaseName)).toBeLessThanOrEqual(63)
    expect(info.databaseName).toMatch(/_test_[a-f0-9]{32}$/)
    expect(info.databaseName).not.toContain("�")
    expect(Object.isFrozen(info)).toBe(true)
    expect(() => Database.getTestDatabaseInfo(config(base + "other"))).toThrow(
      "DATABASE_URL changed",
    )
  })

  it.each(["", "nul\0name"])("rejects invalid base %p", (base) => {
    expect(() => Database.getTestDatabaseInfo(config(base))).toThrow(
      "Invalid database identifier",
    )
  })

  it("isolates reloaded module realms and accepts a shared pre-import token", () => {
    const token = createTestDatabaseInvocation()
    const names: string[] = []
    const defaults: string[] = []
    for (let i = 0; i < 2; i++) {
      jest.isolateModules(() => {
        const module = jest.requireActual<typeof import("./index")>("./index")
        defaults.push(
          module.SharedDatabaseModule.initializeTestInvocation().namespace,
        )
      })
      jest.isolateModules(() => {
        const module = jest.requireActual<typeof import("./index")>("./index")
        module.SharedDatabaseModule.initializeTestInvocation(token)
        names.push(
          module.SharedDatabaseModule.getTestDatabaseInfo(config())
            .databaseName,
        )
      })
    }
    expect(defaults[0]).not.toBe(defaults[1])
    expect(names[0]).toBe(names[1])
  })

  it("does not expose connection credentials in invalid URL diagnostics", () => {
    expect(() =>
      Database.getTestDatabaseInfo(
        new ConfigService({ DATABASE_URL: "postgres://private:secret@[" }),
      ),
    ).toThrow("Invalid test DATABASE_URL")
  })

  it("hashes the full base even when readable prefixes match", async () => {
    const token = createTestDatabaseInvocation()
    Database.initializeTestInvocation(token)
    const a = Database.getTestDatabaseInfo(
      config("a".repeat(100) + "x"),
    ).databaseName
    await Database.resetTestDatabase()
    Database.initializeTestInvocation(token)
    const b = Database.getTestDatabaseInfo(
      config("a".repeat(100) + "y"),
    ).databaseName
    expect(a.slice(0, 25)).toBe(b.slice(0, 25))
    expect(a).not.toBe(b)
  })

  it("rejects conflicting options and invalid migration settings before any connection", () => {
    const initialize = jest.spyOn(DataSource.prototype, "initialize")
    Database.forTest({ entities: [] })
    Database.forTest({ entities: [] })
    expect(() =>
      Database.forTest({ entities: [], synchronize: false }),
    ).toThrow("options changed")
    expect(() =>
      Database.forTest({ entities: [], migrationsRun: true }),
    ).toThrow("requires migrations")
    expect(() =>
      Database.forTest({
        entities: [],
        migrations: ["migration.ts"],
        migrationsRun: true,
        synchronize: true,
      }),
    ).toThrow("requires migrations")
    expect(initialize).not.toHaveBeenCalled()
  })

  let present = false
  function catalogQuery(
    sql: string,
    parameters?: unknown[],
  ): Promise<object[]> {
    if (sql.startsWith("CREATE DATABASE")) {
      present = true
      return Promise.resolve([])
    }
    if (sql.startsWith("DROP DATABASE")) {
      present = false
      return Promise.resolve([])
    }
    if (sql.includes("pg_try_advisory_lock"))
      return Promise.resolve([{ locked: true }])
    if (sql.includes("session_user"))
      return Promise.resolve([
        {
          name: decodeURIComponent(new URL(currentBase).pathname.slice(1)),
          session: "local",
          current: "local",
          template: false,
        },
      ])
    if (sql.includes("current_database"))
      return Promise.resolve([
        {
          name: Database.getTestDatabaseInfo(
            new ConfigService({ DATABASE_URL: currentBase }),
          ).databaseName,
        },
      ])
    if (sql.includes("OR oid"))
      return Promise.resolve(
        present
          ? [{ oid: 42, name: parameters![0], owner: true, template: false }]
          : [],
      )
    return Promise.resolve([{ oid: 42 }])
  }
  let currentBase = baseUrl
  function mockBoundary() {
    jest.spyOn(DataSource.prototype, "synchronize").mockResolvedValue()
    jest.spyOn(DataSource.prototype, "runMigrations").mockResolvedValue([])
    const sources: DataSource[] = []
    const initialize = jest
      .spyOn(DataSource.prototype, "initialize")
      .mockImplementation(function (this: DataSource) {
        sources.push(this)
        connected(this, true)
        return Promise.resolve(this)
      })
    const destroy = jest
      .spyOn(DataSource.prototype, "destroy")
      .mockImplementation(function (this: DataSource) {
        connected(this, false)
        return Promise.resolve()
      })
    present = false
    const query = jest
      .spyOn(DataSource.prototype, "query")
      .mockImplementation(catalogQuery)
    const admin = new DataSource({ type: "postgres", url: baseUrl })
    const connect = jest.fn().mockResolvedValue(undefined)
    const close = jest.fn().mockResolvedValue(undefined)
    const session = {
      healthy: true,
      disposed: true,
      connect,
      close,
      query: (sql: string, values: unknown[]) => admin.query(sql, values),
    }
    const create = jest
      .spyOn(TestDatabaseSession, "create")
      .mockImplementation((url) => {
        currentBase = url
        return Promise.resolve(session as unknown as TestDatabaseSession)
      })
    return {
      sources,
      initialize,
      destroy,
      query,
      connect,
      close,
      create,
      session,
    }
  }

  it("shares setup, quotes DDL, closes pools and supports repeat setup and reset", async () => {
    const { sources, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Promise.all([
      Database.setupTestDatabase(config('base"name')),
      Database.setupTestDatabase(config('base"name')),
    ])
    const factory = Database.getTestDataSource()
    expect(
      decodeURIComponent(
        new URL((factory.options as { url: string }).url).pathname.slice(1),
      ),
    ).toBe(Database.getTestDatabaseInfo(config('base"name')).databaseName)
    expect(
      query.mock.calls.find(([sql]) => String(sql).startsWith("CREATE"))![0],
    ).toMatch(/^CREATE DATABASE "base""name_test_/)
    expect(sources).toHaveLength(1)
    await Database.closeTestConnection()
    expect(sources.every((source) => !source.isInitialized)).toBe(true)
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("FORCE")),
    ).toBe(false)
    expect(() => Database.getTestDataSource()).toThrow()
    await Database.closeTestConnection()
    await Database.setupTestDatabase(config('base"name'))
    const namespace = Database.initializeTestInvocation().namespace
    await Database.resetTestDatabase()
    expect(Database.initializeTestInvocation().namespace).not.toBe(namespace)
  })

  it("keeps production configuration and discovery contracts", async () => {
    mockBoundary()
    const app = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: baseUrl })],
        }),
        Database.forRoot({
          entities: ["dist/entities/*.js"],
          migrations: ["dist/migrations/*.js"],
        }),
      ],
    }).compile()
    try {
      expect(app.get<DataSource>(DataSource).options).toMatchObject({
        type: "postgres",
        url: baseUrl,
        entities: ["dist/entities/*.js"],
        migrations: ["dist/migrations/*.js"],
        synchronize: false,
        autoLoadEntities: true,
      })
    } finally {
      await app.close()
    }
  })

  it("clears schema-qualified tables while excluding views/history and rejects foreign metadata", async () => {
    const { query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    const source = Database.getTestDataSource()
    const selection = [
      new EntitySchema({
        name: "Quoted",
        tableName: 'table"name',
        schema: 'schema"name',
        columns: { id: { type: Number, primary: true } },
      }),
      new EntitySchema({
        name: "View",
        type: "view",
        expression: "SELECT 1 AS id",
        columns: { id: { type: Number } },
      }),
      new EntitySchema({
        name: "History",
        tableName: "migrations",
        columns: { id: { type: Number, primary: true } },
      }),
    ]
    class MetadataSource extends DataSource {
      async build(): Promise<void> {
        await this.buildMetadatas()
      }
    }
    const built = new MetadataSource({
      type: "postgres",
      entities: selection,
    })
    await built.build()
    Object.defineProperty(source, "entityMetadatas", {
      value: built.entityMetadatas,
    })
    await Database.clearTestDatabase()
    expect(query).toHaveBeenLastCalledWith(
      'TRUNCATE TABLE "schema""name"."table""name" CASCADE',
    )
    source.entityMetadatas[0].database = "development"
    await expect(Database.clearTestDatabase()).rejects.toThrow(
      "foreign database",
    )
  })

  it("reports an admin initialization failure without attempting CREATE", async () => {
    const { connect, query, sources } = mockBoundary()
    connect.mockRejectedValueOnce(new Error("admin initialize failed"))
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "admin initialize failed",
    )
    expect(query).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
  })

  it("preserves a collision without adopting or dropping it", async () => {
    const { query, sources } = mockBoundary()
    const original = catalogQuery
    query.mockImplementation((sql, values) => {
      if (sql.startsWith("CREATE"))
        return Promise.reject(new Error("database already exists"))
      return original(sql, values)
    })
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "already exists",
    )
    await Database.closeTestConnection()
    expect(
      query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP")),
    ).toHaveLength(0)
    expect(sources.every((source) => !source.isInitialized)).toBe(true)
  })

  it("preserves administration and destroy failures and retries cleanup", async () => {
    const { query, close } = mockBoundary()
    query.mockImplementation((sql, values) => {
      if (sql.startsWith("CREATE"))
        return Promise.reject(new Error("create failed"))
      return catalogQuery(sql, values)
    })
    close.mockRejectedValueOnce(new Error("admin destroy failed"))
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toBeInstanceOf(
      AggregateError,
    )
    await Database.resetTestDatabase()
  })

  it("rolls back migration initialization failures and rejects overlapping lifecycle calls", async () => {
    const { connect, query } = mockBoundary()
    let release: () => void = () => undefined
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    Database.forTest({ entities: [] })
    const setup = Database.setupTestDatabase(config())
    await expect(Database.closeTestConnection()).rejects.toThrow("busy")
    await expect(Database.resetTestDatabase()).rejects.toThrow("busy")
    await expect(Database.clearTestDatabase()).rejects.toThrow("busy")
    jest
      .spyOn(DataSource.prototype, "synchronize")
      .mockRejectedValueOnce(new Error("migration failed"))
    release()
    await expect(setup).rejects.toThrow("migration failed")
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP DATABASE")),
    ).toBe(true)
  })

  it("attempts all owners and refuses release until a failed destroy succeeds", async () => {
    const { query, destroy } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    const factory = Database.getTestDataSource()
    destroy.mockRejectedValueOnce(new Error("factory destroy failed"))
    await expect(Database.resetTestDatabase()).rejects.toThrow(
      "factory destroy failed",
    )
    expect(factory.isInitialized).toBe(true)
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "cleanup must succeed",
    )
    expect(() => Database.forTest({ entities: [] })).toThrow(
      "cleanup must succeed",
    )
    expect(() => Database.getTestDataSource()).toThrow("not initialized")
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
    await Database.resetTestDatabase()
    expect(factory.isInitialized).toBe(false)
  })

  it("retains owners that report success without closing", async () => {
    const { destroy, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    destroy.mockResolvedValueOnce(undefined)
    await expect(Database.closeTestConnection()).rejects.toThrow(
      "did not close",
    )
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
    await Database.resetTestDatabase()
  })

  it("refuses changed OIDs and retains state for retry", async () => {
    const { query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    query.mockResolvedValueOnce([{ oid: 99 }])
    await expect(Database.clearTestDatabase()).rejects.toThrow("ownership")
    query.mockResolvedValueOnce([{ oid: 99 }])
    await expect(Database.resetTestDatabase()).rejects.toThrow("ownership")
    await expect(
      Database.setupTestDatabase(new ConfigService({ DATABASE_URL: baseUrl })),
    ).rejects.toThrow("cleanup must succeed")
    await Database.resetTestDatabase()
  })
  it("refuses a cooperating lease holder before CREATE and closes the refused session", async () => {
    const { query, close } = mockBoundary()
    query.mockImplementation((sql, values) =>
      sql.includes("pg_try_advisory_lock")
        ? Promise.resolve([{ locked: false }])
        : catalogQuery(sql, values),
    )
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toMatchObject({
      code: "BUSY",
    })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("CREATE")),
    ).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("retains the lease through active use, clear and a failed target close", async () => {
    const { close, destroy, create, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    await Database.clearTestDatabase()
    expect(close).not.toHaveBeenCalled()
    destroy.mockRejectedValueOnce(new Error("retained target owner"))
    await expect(Database.closeTestConnection()).rejects.toThrow(
      "retained target",
    )
    expect(close).not.toHaveBeenCalled()
    await Database.closeTestConnection()
    expect(close).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes("pg_try_advisory_lock"),
      ),
    ).toHaveLength(1)
  })

  it("refuses use after lease loss and reacquires before owned DROP", async () => {
    const { session, create, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    session.healthy = false
    expect(() => Database.getTestDataSource()).toThrow("not initialized")
    expect(() => Database.forTest({ entities: [] })).toThrow(
      "cleanup must succeed",
    )
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "cleanup must succeed",
    )
    await expect(Database.clearTestDatabase()).rejects.toThrow(
      "not initialized",
    )
    create.mockImplementationOnce(() =>
      Promise.resolve({
        ...session,
        healthy: true,
      } as unknown as TestDatabaseSession),
    )
    await Database.resetTestDatabase()
    const sql = query.mock.calls.map(([text]) => String(text))
    expect(
      sql.filter((text) => text.includes("pg_try_advisory_lock")),
    ).toHaveLength(2)
    expect(
      sql.findLastIndex((text) => text.includes("pg_try_advisory_lock")),
    ).toBeLessThan(sql.findIndex((text) => text.startsWith("DROP")))
  })

  it("cannot bypass a server-held lease after local session loss", async () => {
    const { session, create, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    session.healthy = false
    create.mockImplementation(() =>
      Promise.resolve({
        ...session,
        healthy: true,
      } as unknown as TestDatabaseSession),
    )
    query.mockImplementation((sql, values) =>
      sql.includes("pg_try_advisory_lock")
        ? Promise.resolve([{ locked: false }])
        : catalogQuery(sql, values),
    )
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(Database.closeTestConnection()).rejects.toMatchObject({
        code: "BUSY",
      })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
  })

  it("retains an uncertain DROP and verifies exact absence on explicit retry", async () => {
    const { query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    query.mockImplementation((sql, values) => {
      const result = catalogQuery(sql, values)
      if (sql.startsWith("DROP"))
        return Promise.reject(new Error("lost acknowledgement"))
      return result
    })
    await expect(Database.closeTestConnection()).rejects.toThrow(
      "lost acknowledgement",
    )
    await Database.closeTestConnection()
    expect(
      query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP")),
    ).toHaveLength(1)
  })

  it("keeps cleanup required after DROP succeeds but lease close fails", async () => {
    const { close, query } = mockBoundary()
    Database.forTest({ entities: [] })
    await Database.setupTestDatabase(config())
    close.mockRejectedValueOnce(
      new TestDatabaseRecoveryError([{ code: "CLOSE_FAILED", phase: "close" }]),
    )
    await expect(Database.closeTestConnection()).rejects.toMatchObject({
      code: "CLOSE_FAILED",
    })
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "cleanup must succeed",
    )
    await Database.closeTestConnection()
    expect(
      query.mock.calls.filter(([sql]) => String(sql).startsWith("DROP")),
    ).toHaveLength(1)
    await Database.setupTestDatabase(config())
  })
})

function record(baseName = "base"): RecoverTestDatabaseOptions {
  const identity = { namespace: "saved-creator", workerId: "", processId: 123 }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        baseName,
        identity.namespace,
        identity.processId,
        identity.workerId,
      ]),
    )
    .digest("hex")
    .slice(0, 32)
  let prefix = ""
  for (const character of baseName) {
    if (Buffer.byteLength(prefix + character + `_test_${digest}`) > 63) break
    prefix += character
  }
  return {
    base: {
      databaseUrl: `postgres://local:local@localhost/${encodeURIComponent(baseName)}`,
      expectedRole: "local",
    },
    database: { ...identity, databaseName: `${prefix}_test_${digest}` },
    acquiredOid: 42,
    exclusiveTarget: true,
  }
}

const binding = {
  name: "base",
  session: "local",
  current: "local",
  role: 7,
  template: false,
}
function mockSession() {
  const input = record()
  const target = {
    name: input.database.databaseName,
    oid: 42,
    owner: 7,
    template: false,
  }
  const query = jest
    .fn<Promise<object[]>, [string, unknown[], string, number]>()
    .mockResolvedValue([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([binding])
    .mockResolvedValueOnce([{ locked: true }])
    .mockResolvedValueOnce([target])
    .mockResolvedValueOnce([target])
  const connect = jest.fn().mockResolvedValue(undefined)
  const close = jest.fn().mockResolvedValue(undefined)
  const interrupt = jest.fn()
  const session = { query, connect, close, interrupt, healthy: true }
  jest
    .spyOn(TestDatabaseSession, "create")
    .mockResolvedValue(session as unknown as TestDatabaseSession)
  return { input, target, query, close, interrupt, session }
}

describe("retained test database recovery public contract", () => {
  afterEach(async () => {
    jest.restoreAllMocks()
    await Database.resetTestDatabase()
  })

  it.each(["normal", 'quoted"base', "雪😀 /%".repeat(30), "a".repeat(100)])(
    "uses the existing original identity for %p",
    (baseName) => {
      const input = record(baseName)
      expect(captureRecoveryInput(input).databaseName).toBe(
        input.database.databaseName,
      )
      Database.initializeTestInvocation({
        namespace: "current-invocation",
      })
      const original = Database.getTestDatabaseInfo(
        new ConfigService({ DATABASE_URL: input.base.databaseUrl }),
      )
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            baseName,
            original.namespace,
            original.processId,
            original.workerId,
          ]),
        )
        .digest("hex")
        .slice(0, 32)
      expect(original.databaseName).toBe(
        record(baseName).database.databaseName.replace(/[a-f0-9]{32}$/, digest),
      )
      expect(Buffer.byteLength(original.databaseName)).toBeLessThanOrEqual(63)
    },
  )

  const invalid: Array<
    [string, (input: RecoverTestDatabaseOptions) => unknown, string]
  > = [
    [
      "unsupported descriptor",
      (input) => ({ ...input, database: { ...input.database, version: 99 } }),
      "INVALID_INPUT",
    ],
    ["array record", (input) => ({ ...input, database: [] }), "INVALID_INPUT"],
    [
      "invalid port",
      (input) => ({
        ...input,
        base: {
          ...input.base,
          databaseUrl: input.base.databaseUrl.replace(
            "localhost/",
            "localhost:99999/",
          ),
        },
      }),
      "INVALID_INPUT",
    ],

    [
      "missing evidence",
      (input) => ({ ...input, acquiredOid: undefined }),
      "INVALID_INPUT",
    ],
    ["zero OID", (input) => ({ ...input, acquiredOid: 0 }), "INVALID_INPUT"],
    [
      "overflow OID",
      (input) => ({ ...input, acquiredOid: 0x100000000 }),
      "INVALID_INPUT",
    ],
    [
      "fractional OID",
      (input) => ({ ...input, acquiredOid: 1.5 }),
      "INVALID_INPUT",
    ],
    [
      "false exclusivity",
      (input) => ({ ...input, exclusiveTarget: false }),
      "INVALID_INPUT",
    ],
    [
      "missing record",
      (input) => ({ ...input, database: null }),
      "INVALID_INPUT",
    ],
    [
      "invalid PID",
      (input) => ({ ...input, database: { ...input.database, processId: -1 } }),
      "INVALID_INPUT",
    ],
    [
      "empty namespace",
      (input) => ({ ...input, database: { ...input.database, namespace: "" } }),
      "INVALID_INPUT",
    ],
    [
      "invalid Unicode",
      (input) => ({
        ...input,
        database: { ...input.database, workerId: "\ud800" },
      }),
      "INVALID_INPUT",
    ],
    [
      "wrong name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "unrelated" },
      }),
      "IDENTITY_MISMATCH",
    ],
    [
      "system name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "postgres" },
      }),
      "UNSAFE_TARGET",
    ],
    [
      "reserved name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "pg_reserved" },
      }),
      "UNSAFE_TARGET",
    ],
    [
      "base name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "base" },
      }),
      "UNSAFE_TARGET",
    ],
    ["NaN budget", (input) => ({ ...input, timeoutMs: NaN }), "INVALID_INPUT"],
    [
      "zero close budget",
      (input) => ({ ...input, closeTimeoutMs: 0 }),
      "INVALID_INPUT",
    ],
    [
      "large budget",
      (input) => ({ ...input, timeoutMs: 300001 }),
      "INVALID_INPUT",
    ],
    [
      "wrong role",
      (input) => ({ ...input, base: { ...input.base, expectedRole: "other" } }),
      "INVALID_INPUT",
    ],
    ...[
      "?host=other",
      "?user=other",
      "?database=other",
      "?options=-c%20role=other",
      "?sslnegotiation=direct",
      "?sslmode=no-verify",
      "?sslmode=disable&sslmode=verify-full",
      "?uselibpqcompat=true",
    ].map(
      (
        suffix,
      ): [string, (input: RecoverTestDatabaseOptions) => unknown, string] => [
        "binding override",
        (input) => ({
          ...input,
          base: { ...input.base, databaseUrl: input.base.databaseUrl + suffix },
        }),
        "INVALID_INPUT",
      ],
    ),
  ]
  it.each(invalid)(
    "refuses %s before creating a session",
    async (_label, change, code) => {
      const create = jest.spyOn(TestDatabaseSession, "create")
      await expect(
        recoverTestDatabase(change(record()) as RecoverTestDatabaseOptions),
      ).rejects.toMatchObject({
        code,
        phase: "validate",
        outcome: "not-attempted",
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it("captures primitive evidence before caller mutation", () => {
    const input = record()
    const captured = captureRecoveryInput(input)
    Object.assign(input.database, { databaseName: "replacement" })
    Object.assign(input.base, {
      databaseUrl: "postgres://other@elsewhere/other",
    })
    expect(captured.databaseName).toBe(record().database.databaseName)
    expect(captured.databaseUrl).toBe(record().base.databaseUrl)
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it("removes through ordinary DROP and checks absence without changing the current invocation", async () => {
    const { input, query } = mockSession()
    const token = Database.initializeTestInvocation()
    const result: TestDatabaseRecoveryResult = await recoverTestDatabase(input)
    expect(result).toEqual({ status: "removed" })
    expect(Database.initializeTestInvocation()).toBe(token)
    const ddl = query.mock.calls.filter(([sql]) =>
      String(sql).startsWith("DROP"),
    )
    expect(ddl).toHaveLength(1)
    expect(ddl[0][0]).toBe(`DROP DATABASE "${input.database.databaseName}"`)
    expect(query.mock.calls.at(-1)?.[0]).toContain(
      "WHERE datname = $1 OR oid = $2::oid",
    )
  })

  it("returns explicit already-absent without DROP", async () => {
    const { input, query } = mockSession()
    query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValue([])
    await expect(recoverTestDatabase(input)).resolves.toEqual({
      status: "already-absent",
    })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
  })

  it.each([
    ["replacement", { oid: 99 }, "IDENTITY_MISMATCH"],
    ["rename", { name: "renamed" }, "IDENTITY_MISMATCH"],
    ["indirect owner", { owner: 8 }, "OWNERSHIP_MISMATCH"],
    ["template", { template: true }, "UNSAFE_TARGET"],
  ])("preserves %s without DDL", async (_label, change, code) => {
    const { input, query, target } = mockSession()
    query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValue([{ ...target, ...change }])
    await expect(recoverTestDatabase(input)).rejects.toMatchObject({
      code,
      outcome: "not-attempted",
    })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
  })

  it("retains uncertainty and safe primary plus close failures", async () => {
    const { input, query, close } = mockSession()
    query.mockRejectedValueOnce(new Error("private server response"))
    close.mockRejectedValueOnce(new Error("private close response"))
    const error: unknown = await recoverTestDatabase(input).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(TestDatabaseRecoveryError)
    expect(error).toMatchObject({
      outcome: "unknown",
      failures: [
        { code: "DATABASE_FAILURE", phase: "drop" },
        { code: "CLOSE_FAILED", phase: "close" },
      ],
    })
    expect(JSON.stringify(error)).not.toMatch(/private|local|base_test/)
    expect((error as Error).cause).toBeUndefined()
  })

  it("rejects confirmed absence when close fails", async () => {
    const { input, close } = mockSession()
    close.mockRejectedValueOnce(new Error("close failed"))
    await expect(recoverTestDatabase(input)).rejects.toMatchObject({
      code: "CLOSE_FAILED",
      outcome: "removed",
    })
  })

  it("rejects preconnect cancellation without creating a session", async () => {
    const create = jest.spyOn(TestDatabaseSession, "create")
    const controller = new AbortController()
    controller.abort()
    await expect(
      recoverTestDatabase({ ...record(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", outcome: "not-attempted" })
    expect(create).not.toHaveBeenCalled()
  })
  it("closes implemented plaintext/TLS transports and exits naturally in every fixture scenario", async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [join(__dirname, "fixtures/transport-runner.cjs")],
      { timeout: 30000 },
    )
    expect(stderr).toBe("")
    const reports = stdout
      .trim()
      .split("\n")
      .slice(1)
      .map(
        (line) =>
          JSON.parse(line) as {
            naturalExitBeforeFixtureCleanup: boolean
            exitCode: number
            closeMs: number
            unhandled: number
          },
      )
    expect(reports).toHaveLength(13)
    for (const report of reports) {
      expect(report.naturalExitBeforeFixtureCleanup).toBe(true)
      expect(report.exitCode).toBe(0)
      expect(report.closeMs).toBeLessThan(1000)
      expect(report.unhandled).toBe(0)
    }
  }, 35000)

  it("does not load the optional driver while importing the public database module", () => {
    jest.isolateModules(() => {
      const load = jest.fn(() => {
        throw new Error("Optional driver is unavailable")
      })
      jest.doMock("pg", load)
      try {
        const api = jest.requireActual<typeof import("./index")>("./index")
        expect(typeof api.recoverTestDatabase).toBe("function")
        expect(load).not.toHaveBeenCalled()
      } finally {
        jest.dontMock("pg")
      }
    })
  })

  it("uses the captured target when the caller mutates its record during connection", async () => {
    const { input, query, session } = mockSession()
    const original = input.database.databaseName
    session.connect.mockImplementation(() => {
      Object.assign(input.database, { databaseName: "caller-replacement" })
      return Promise.resolve()
    })
    await expect(recoverTestDatabase(input)).resolves.toEqual({
      status: "removed",
    })
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith("DROP"))[0][0],
    ).toBe(`DROP DATABASE "${original}"`)
  })

  it.each(["connect", "inspect", "drop"])(
    "stops dispatch after cancellation during %s",
    async (at) => {
      const { input, query, session, interrupt } = mockSession()
      const controller = new AbortController()
      let release: () => void = () => undefined
      let reached: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        reached = resolve
      })
      const paused = () =>
        new Promise<object[]>((resolve) => {
          release = () => resolve([])
          reached()
        })
      if (at === "connect") session.connect.mockImplementationOnce(paused)
      else {
        query
          .mockReset()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([binding])
          .mockResolvedValueOnce([{ locked: true }])
        if (at === "inspect") query.mockImplementationOnce(paused)
        else
          query
            .mockResolvedValueOnce([
              {
                name: input.database.databaseName,
                oid: 42,
                owner: 7,
                template: false,
              },
            ])
            .mockResolvedValueOnce([
              {
                name: input.database.databaseName,
                oid: 42,
                owner: 7,
                template: false,
              },
            ])
            .mockImplementationOnce(paused)
      }
      const result = recoverTestDatabase({
        ...input,
        signal: controller.signal,
      })
      await barrier
      controller.abort()
      release()
      await expect(result).rejects.toMatchObject({
        code: "CANCELLED",
        outcome: at === "drop" ? "unknown" : "not-attempted",
      })
      expect(interrupt).toHaveBeenCalled()
      expect(
        query.mock.calls.filter(([sql]) => sql.startsWith("DROP")),
      ).toHaveLength(at === "drop" ? 1 : 0)
    },
  )
})
