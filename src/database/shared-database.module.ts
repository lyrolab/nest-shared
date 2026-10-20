import {
  BeforeApplicationShutdown,
  DynamicModule,
  Injectable,
  Module,
} from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { join } from "path"
import { findMainPath } from "./helpers/find-main-path"
import { DataSource, DataSourceOptions } from "typeorm"
import {
  quoteIdentifier,
  testDatabaseName,
  testDatabaseLockKey,
} from "./helpers/test-database-identity"

import { TestDatabaseSession } from "./helpers/test-database-session"
import { TestDatabaseRecoveryError } from "./test-database-recovery-error"

const ENTITIES_PATH = "**/*.entity.{ts,js}"
const MIGRATIONS_PATH = "dist/migrations/**/*.{ts,js}"

type SharedDatabaseModuleOptions = {
  entities?: string[]
  migrations?: string[]
}

export interface TestDatabaseInvocation {
  readonly namespace: string
}

export interface TestDatabaseInfo extends TestDatabaseInvocation {
  readonly workerId: string
  readonly processId: number
  readonly databaseName: string
}

export interface ForTestOptions {
  entities: NonNullable<DataSourceOptions["entities"]>
  migrations?: DataSourceOptions["migrations"]
  migrationsRun?: boolean
  synchronize?: boolean
  migrationsTableName?: string
  migrationsTransactionMode?: DataSourceOptions["migrationsTransactionMode"]
  namingStrategy?: DataSourceOptions["namingStrategy"]
  schema?: string
}

export function createTestDatabaseInvocation(): TestDatabaseInvocation {
  return Object.freeze({ namespace: `${process.pid}-${randomUUID()}` })
}

function throwErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

async function closeSource(source: DataSource): Promise<void> {
  if (source.isInitialized) await source.destroy()
  if (source.isInitialized)
    throw new Error("Test database connection did not close")
}

@Injectable()
class TestDatabaseShutdown implements BeforeApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  async beforeApplicationShutdown(): Promise<void> {
    // TypeOrmModule's later shutdown hook logs destroy errors instead of rejecting.
    await closeSource(this.dataSource)
  }
}

@Module({})
export class SharedDatabaseModule {
  private static invocation?: TestDatabaseInvocation
  private static identity?: { workerId: string; processId: number }
  private static configuration?: {
    baseUrl: string
    url: string
    info: TestDatabaseInfo
  }
  private static testOptions?: ForTestOptions
  private static testDataSource?: DataSource
  private static sources = new Set<DataSource>()
  private static lease?: TestDatabaseSession
  private static leaseLocked = false
  private static owned?: { name: string; oid?: number; dropAttempted?: boolean }
  private static setupPromise?: Promise<void>
  private static busy?: "setup" | "clear" | "close"
  private static initializing = 0
  private static cleanupRequired = false

  static forRoot(options: SharedDatabaseModuleOptions = {}): DynamicModule {
    return {
      module: SharedDatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => {
            return this.createProductionConfiguration(configService, options)
          },
        }),
      ],
      exports: [TypeOrmModule],
    }
  }

  static initializeTestInvocation(
    invocation?: TestDatabaseInvocation,
  ): TestDatabaseInvocation {
    if (
      invocation &&
      (!invocation.namespace || invocation.namespace.includes("\0"))
    ) {
      throw new Error("Invalid test invocation namespace")
    }
    if (
      this.invocation &&
      invocation &&
      this.invocation.namespace !== invocation.namespace
    ) {
      throw new Error(
        "Test invocation already captured; call resetTestDatabase first",
      )
    }
    if (!this.invocation) {
      this.invocation = invocation
        ? Object.freeze({ ...invocation })
        : createTestDatabaseInvocation()
      const config = new ConfigService()
      this.identity = {
        workerId:
          config.get<string>("VITEST_POOL_ID") ??
          config.get<string>("JEST_WORKER_ID") ??
          "0",
        processId: process.pid,
      }
    }
    return this.invocation
  }

  static getTestDatabaseInfo(
    configService = new ConfigService(),
  ): TestDatabaseInfo {
    this.initializeTestInvocation()
    const baseUrl = configService.get<string>("DATABASE_URL")
    if (!baseUrl)
      throw new Error("DATABASE_URL is required for test database setup")
    if (this.configuration) {
      if (this.configuration.baseUrl !== baseUrl)
        throw new Error(
          "Test DATABASE_URL changed; call resetTestDatabase first",
        )
      return this.configuration.info
    }
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new Error("Invalid test DATABASE_URL")
    }
    const baseName = decodeURIComponent(url.pathname.slice(1))
    quoteIdentifier(baseName)
    const identity = this.identity!
    const namespace = this.invocation!.namespace
    const databaseName = testDatabaseName(baseName, { namespace, ...identity })
    url.pathname = `/${encodeURIComponent(databaseName)}`
    const info = Object.freeze({ namespace, ...identity, databaseName })
    this.configuration = { baseUrl, url: url.toString(), info }
    return info
  }

  static forTest(options: ForTestOptions): DynamicModule {
    this.initializeTestInvocation()
    if (this.busy) throw new Error(`Test database is busy: ${this.busy}`)
    if (this.cleanupRequired || (this.lease && !this.lease.healthy))
      throw new Error("Test database cleanup must succeed before setup")
    if (
      options.migrationsRun &&
      (options.synchronize === true ||
        !options.migrations ||
        Object.keys(options.migrations).length === 0)
    ) {
      throw new Error(
        "migrationsRun requires migrations and synchronize disabled",
      )
    }
    if (this.testOptions && !isDeepStrictEqual(this.testOptions, options)) {
      throw new Error(
        "Test database options changed; call resetTestDatabase first",
      )
    }
    const captured = { ...options }
    captured.entities = Array.isArray(options.entities)
      ? [...options.entities]
      : { ...options.entities }
    if (options.migrations)
      captured.migrations = Array.isArray(options.migrations)
        ? [...options.migrations]
        : { ...options.migrations }
    Object.freeze(captured.entities)
    if (captured.migrations) Object.freeze(captured.migrations)
    this.testOptions = Object.freeze(captured)
    return {
      module: SharedDatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: async (config: ConfigService) => {
            await this.setupTestDatabase(config)
            return {
              ...this.connectionOptions(),
              synchronize: false,
              migrationsRun: false,
              retryAttempts: 1,
            }
          },
          dataSourceFactory: async (options) => {
            if (
              this.busy ||
              this.cleanupRequired ||
              !this.lease?.healthy ||
              !this.testDataSource?.isInitialized
            )
              throw new Error("Test database is not ready for Nest")
            const source = new DataSource(options as DataSourceOptions)
            this.sources.add(source)
            this.initializing++
            try {
              await source.initialize()
              if (!this.lease?.healthy)
                throw new Error("Test database lease was lost")
              return source
            } finally {
              this.initializing--
            }
          },
        }),
      ],
      providers: [TestDatabaseShutdown],
      exports: [TypeOrmModule],
    }
  }

  private static connectionOptions(): DataSourceOptions {
    return {
      ...this.testOptions,
      type: "postgres",
      url: this.configuration!.url,
      database: this.configuration!.info.databaseName,
      synchronize: this.testOptions!.migrationsRun
        ? false
        : (this.testOptions!.synchronize ?? true),
    }
  }

  static async setupTestDatabase(
    configService = new ConfigService(),
  ): Promise<void> {
    if (this.busy && this.busy !== "setup")
      throw new Error(`Test database is busy: ${this.busy}`)
    if (!this.testOptions)
      throw new Error("Call forTest before setupTestDatabase")
    this.getTestDatabaseInfo(configService)
    if (this.cleanupRequired || (this.lease && !this.lease.healthy))
      throw new Error("Test database cleanup must succeed before setup")
    if (this.setupPromise) return this.setupPromise
    if (this.testDataSource?.isInitialized) return
    if (this.owned || this.sources.size || this.lease)
      throw new Error("Test database cleanup must succeed before setup")
    this.busy = "setup"
    this.setupPromise = this.setup()
    try {
      await this.setupPromise
    } finally {
      this.busy = undefined
      this.setupPromise = undefined
    }
  }

  private static async setup(): Promise<void> {
    try {
      await this.acquireLease()
      const name = this.configuration!.info.databaseName
      await this.adminQuery(`CREATE DATABASE ${quoteIdentifier(name)}`)
      this.owned = { name }
      this.owned.oid = await this.databaseOid(name)
      const options = this.connectionOptions()
      // TypeORM initialize can replace a schema error with its automatic destroy error.
      const source = new DataSource({
        ...options,
        synchronize: false,
        migrationsRun: false,
      })
      this.sources.add(source)
      await source.initialize()
      if (this.testOptions!.migrationsRun) await source.runMigrations()
      if (options.synchronize) await source.synchronize()
      if (!this.lease?.healthy) throw new Error("Test database lease was lost")
      this.testDataSource = source
    } catch (error) {
      const errors = [error]
      try {
        await this.cleanup()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }
      throwErrors(errors, "Test database setup and cleanup failed")
    }
  }

  private static async acquireLease(): Promise<void> {
    if (this.lease?.healthy && this.leaseLocked) return
    if (this.lease) await this.closeLease()
    const url = new URL(this.configuration!.baseUrl)
    const base = decodeURIComponent(url.pathname.slice(1))
    const role = decodeURIComponent(url.username)
    this.lease = await TestDatabaseSession.create(this.configuration!.baseUrl)
    await this.lease.connect(30_000)
    const rows = await this.adminQuery<{
      name: string
      session: string
      current: string
      template: boolean
    }>(`SELECT current_database() AS name, session_user AS session,
      current_user AS current, datistemplate AS template
      FROM pg_database WHERE datname = current_database()`)
    if (
      rows.length !== 1 ||
      rows[0].name !== base ||
      rows[0].session !== role ||
      rows[0].current !== role ||
      rows[0].template
    )
      throw new TestDatabaseRecoveryError([
        { code: "IDENTITY_MISMATCH", phase: "connect" },
      ])
    const lock = await this.adminQuery<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [testDatabaseLockKey(this.configuration!.info.databaseName)],
      "lock",
    )
    if (lock.length !== 1 || lock[0].locked !== true)
      throw new TestDatabaseRecoveryError([{ code: "BUSY", phase: "lock" }])
    this.leaseLocked = true
  }

  private static async closeLease(): Promise<void> {
    const lease = this.lease
    if (!lease) return
    this.leaseLocked = false
    try {
      await lease.close(5_000)
      this.lease = undefined
    } finally {
      // A recorded close failure still rejects this attempt, even after disposal.
      if (lease.disposed) this.lease = undefined
    }
  }

  private static adminQuery<T extends object>(
    text: string,
    values: unknown[] = [],
    phase: "inspect" | "lock" | "drop" | "verify" = "inspect",
  ): Promise<T[]> {
    if (!this.lease?.healthy)
      throw new TestDatabaseRecoveryError([{ code: "DATABASE_FAILURE", phase }])
    return this.lease.query<T>(text, values, phase, 30_000)
  }

  private static async databaseOid(name: string): Promise<number> {
    const rows = await this.adminQuery<{ oid: number }>(
      "SELECT oid FROM pg_database WHERE datname = $1",
      [name],
    )
    if (rows.length !== 1 || !Number.isInteger(rows[0].oid) || rows[0].oid <= 0)
      throw new Error("Owned database is missing")
    return rows[0].oid
  }

  private static async assertOwnership(): Promise<void> {
    if (
      !this.owned?.oid ||
      this.owned.name !== this.configuration?.info.databaseName ||
      (await this.databaseOid(this.owned.name)) !== this.owned.oid
    )
      throw new Error("Test database ownership could not be verified")
  }

  static async clearTestDatabase(): Promise<void> {
    if (this.busy || this.initializing) throw new Error("Test database is busy")
    if (!this.testDataSource) return
    this.busy = "clear"
    try {
      const source = this.getTestDataSource()
      await this.assertOwnership()
      const rows = await source.query<{ name: string }[]>(
        "SELECT current_database() AS name",
      )
      if (rows[0].name !== this.owned!.name)
        throw new Error("Refusing to clear a foreign database")
      const tables = new Set<string>()
      for (const metadata of source.entityMetadatas) {
        if (metadata.database && metadata.database !== this.owned!.name)
          throw new Error("Entity targets a foreign database")
        if (
          metadata.tableType === "view" ||
          metadata.tableName ===
            (this.testOptions?.migrationsTableName ?? "migrations")
        )
          continue
        tables.add(
          `${quoteIdentifier(metadata.schema ?? this.testOptions?.schema ?? "public")}.${quoteIdentifier(metadata.tableName)}`,
        )
      }
      if (!this.lease?.healthy) throw new Error("Test database lease was lost")
      if (tables.size)
        await source.query(`TRUNCATE TABLE ${[...tables].join(", ")} CASCADE`)
    } finally {
      this.busy = undefined
    }
  }

  static getTestDataSource(): DataSource {
    if (
      !this.testDataSource?.isInitialized ||
      this.cleanupRequired ||
      !this.lease?.healthy ||
      this.busy === "close"
    ) {
      throw new Error(
        "SharedDatabaseModule not initialized. Call setupTestDatabase first.",
      )
    }
    return this.testDataSource
  }

  static closeTestConnection(): Promise<void> {
    return this.teardown(false)
  }

  static resetTestDatabase(): Promise<void> {
    return this.teardown(true)
  }

  private static async teardown(reset: boolean): Promise<void> {
    if (this.busy || this.initializing) throw new Error("Test database is busy")
    this.busy = "close"
    try {
      await this.cleanup()
      if (reset) {
        this.testOptions = undefined
        this.configuration = undefined
        this.identity = undefined
        this.invocation = undefined
      }
    } finally {
      this.busy = undefined
    }
  }

  private static async cleanup(): Promise<void> {
    this.cleanupRequired = true
    const errors: unknown[] = []
    for (const source of this.sources) {
      try {
        await closeSource(source)
        this.sources.delete(source)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 0 && this.owned) {
      try {
        await this.acquireLease()
        const owned = this.owned
        if (!owned.oid)
          throw new Error("Test database ownership could not be verified")
        const inspect = () =>
          this.adminQuery<{
            oid: number
            name: string
            owner: boolean
            template: boolean
          }>(
            `SELECT oid, datname AS name, datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner,
           datistemplate AS template FROM pg_database WHERE datname = $1 OR oid = $2::oid`,
            [owned.name, owned.oid],
          )
        const rows = await inspect()
        if (rows.length === 0 && owned.dropAttempted) {
          this.owned = undefined
        } else {
          if (
            rows.length !== 1 ||
            rows[0].oid !== owned.oid ||
            rows[0].name !== owned.name ||
            rows[0].owner !== true ||
            rows[0].template
          )
            throw new Error("Test database ownership could not be verified")
          owned.dropAttempted = true
          await this.adminQuery(
            `DROP DATABASE ${quoteIdentifier(owned.name)}`,
            [],
            "drop",
          )
          if ((await inspect()).length !== 0)
            throw new Error("Test database removal could not be verified")
          this.owned = undefined
        }
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 0) {
      try {
        await this.closeLease()
      } catch (error) {
        errors.push(error)
      }
    }
    throwErrors(errors, "Test database cleanup failed")
    this.testDataSource = undefined
    this.cleanupRequired = false
  }

  private static createProductionConfiguration(
    configService: ConfigService,
    options: SharedDatabaseModuleOptions,
  ): TypeOrmModuleOptions {
    return {
      type: "postgres",
      url: configService.get("DATABASE_URL"),
      entities: options.entities || [
        join(findMainPath(), "dist", ENTITIES_PATH),
      ],
      migrations: options.migrations || [join(findMainPath(), MIGRATIONS_PATH)],
      synchronize: false,
      autoLoadEntities: true,
    }
  }
}
