import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { DataSource, EntitySchema } from "typeorm"
import {
  createTestDatabaseInvocation,
  SharedDatabaseModule as Database,
} from "./index"

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
    jest.restoreAllMocks()
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
    jest.spyOn(DataSource.prototype, "query").mockResolvedValue([{ oid: 42 }])
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

  function mockBoundary() {
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
    const query = jest
      .spyOn(DataSource.prototype, "query")
      .mockImplementation((sql: string) => {
        if (sql.includes("current_database"))
          return Promise.resolve([
            { name: Database.getTestDatabaseInfo(config()).databaseName },
          ])
        return Promise.resolve([{ oid: 42 }])
      })
    return { sources, initialize, destroy, query }
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
    expect(query.mock.calls[0][0]).toMatch(/^CREATE DATABASE "base""name_test_/)
    expect(sources).toHaveLength(2)
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
    const { initialize, query, sources } = mockBoundary()
    initialize.mockRejectedValueOnce(new Error("admin initialize failed"))
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "admin initialize failed",
    )
    expect(query).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
  })

  it("preserves a collision without adopting or dropping it", async () => {
    const { query, sources } = mockBoundary()
    query.mockRejectedValueOnce(new Error("database already exists"))
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toThrow(
      "already exists",
    )
    await Database.closeTestConnection()
    expect(query).toHaveBeenCalledTimes(1)
    expect(sources.every((source) => !source.isInitialized)).toBe(true)
  })

  it("preserves administration and destroy failures and retries cleanup", async () => {
    const { query, destroy } = mockBoundary()
    query.mockRejectedValueOnce(new Error("create failed"))
    destroy.mockRejectedValueOnce(new Error("admin destroy failed"))
    Database.forTest({ entities: [] })
    await expect(Database.setupTestDatabase(config())).rejects.toBeInstanceOf(
      AggregateError,
    )
    await Database.resetTestDatabase()
  })

  it("rolls back migration initialization failures and rejects overlapping lifecycle calls", async () => {
    const { initialize, query } = mockBoundary()
    let release: () => void = () => undefined
    initialize.mockImplementationOnce(function (this: DataSource) {
      return new Promise<DataSource>((resolve) => {
        release = () => {
          connected(this, true)
          resolve(this)
        }
      })
    })
    Database.forTest({ entities: [] })
    const setup = Database.setupTestDatabase(config())
    await expect(Database.closeTestConnection()).rejects.toThrow("busy")
    await expect(Database.resetTestDatabase()).rejects.toThrow("busy")
    await expect(Database.clearTestDatabase()).rejects.toThrow("busy")
    initialize.mockRejectedValueOnce(new Error("migration failed"))
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
})
