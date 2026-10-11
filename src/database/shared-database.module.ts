import {
  BeforeApplicationShutdown,
  DynamicModule,
  Injectable,
  Module,
} from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { join } from "path"
import { findMainPath } from "./helpers/find-main-path"
import { DataSource, DataSourceOptions } from "typeorm"

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

function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0"))
    throw new Error("Invalid database identifier")
  return `"${identifier.replaceAll('"', '""')}"`
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
  private static admins = new Set<DataSource>()
  private static owned?: { name: string; oid?: number }
  private static setupPromise?: Promise<void>
  private static busy?: "setup" | "clear" | "close"
  private static initializing = 0

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
    const url = new URL(baseUrl)
    const baseName = decodeURIComponent(url.pathname.slice(1))
    quoteIdentifier(baseName)
    const identity = this.identity!
    const namespace = this.invocation!.namespace
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          baseName,
          namespace,
          identity.processId,
          identity.workerId,
        ]),
      )
      .digest("hex")
      .slice(0, 32)
    const suffix = `_test_${digest}`
    let prefix = ""
    for (const character of baseName) {
      if (Buffer.byteLength(prefix + character + suffix) > 63) break
      prefix += character
    }
    const databaseName = prefix + suffix
    url.pathname = `/${encodeURIComponent(databaseName)}`
    const info = Object.freeze({ namespace, ...identity, databaseName })
    this.configuration = { baseUrl, url: url.toString(), info }
    return info
  }

  static forTest(options: ForTestOptions): DynamicModule {
    this.initializeTestInvocation()
    if (this.busy) throw new Error(`Test database is busy: ${this.busy}`)
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
            if (this.busy || !this.testDataSource?.isInitialized)
              throw new Error("Test database is not ready for Nest")
            const source = new DataSource(options as DataSourceOptions)
            this.sources.add(source)
            this.initializing++
            try {
              return await source.initialize()
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
    if (this.setupPromise) return this.setupPromise
    if (this.testDataSource?.isInitialized) return
    if (this.owned || this.sources.size || this.admins.size)
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
      await this.withAdmin(async (admin) => {
        const name = this.configuration!.info.databaseName
        await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
        this.owned = { name }
        this.owned.oid = await this.databaseOid(admin, name)
      })
      const source = new DataSource(this.connectionOptions())
      this.sources.add(source)
      await source.initialize()
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

  private static async withAdmin<T>(
    action: (source: DataSource) => Promise<T>,
  ): Promise<T> {
    const source = new DataSource({
      type: "postgres",
      url: this.configuration!.baseUrl,
      // TypeORM parses URL paths without decoding PostgreSQL database names.
      database: decodeURIComponent(
        new URL(this.configuration!.baseUrl).pathname.slice(1),
      ),
    })
    this.admins.add(source)
    const errors: unknown[] = []
    let result: T | undefined
    try {
      await source.initialize()
      result = await action(source)
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        await closeSource(source)
        this.admins.delete(source)
      } catch (error) {
        errors.push(error)
      }
    }
    throwErrors(errors, "Database administration and cleanup failed")
    return result as T
  }

  private static async databaseOid(
    source: DataSource,
    name: string,
  ): Promise<number> {
    const rows = await source.query<{ oid: number }[]>(
      "SELECT oid FROM pg_database WHERE datname = $1",
      [name],
    )
    if (rows.length !== 1) throw new Error("Owned database is missing")
    return rows[0].oid
  }

  private static async assertOwnership(source: DataSource): Promise<void> {
    if (
      !this.owned?.oid ||
      this.owned.name !== this.configuration?.info.databaseName ||
      (await this.databaseOid(source, this.owned.name)) !== this.owned.oid
    ) {
      throw new Error("Test database ownership could not be verified")
    }
  }

  static async clearTestDatabase(): Promise<void> {
    if (this.busy || this.initializing) throw new Error("Test database is busy")
    if (!this.testDataSource) return
    this.busy = "clear"
    try {
      const source = this.getTestDataSource()
      await this.assertOwnership(source)
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
      if (tables.size)
        await source.query(`TRUNCATE TABLE ${[...tables].join(", ")} CASCADE`)
    } finally {
      this.busy = undefined
    }
  }

  static getTestDataSource(): DataSource {
    if (!this.testDataSource?.isInitialized || this.busy === "close") {
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
    const errors: unknown[] = []
    for (const sources of [this.sources, this.admins]) {
      for (const source of sources) {
        try {
          await closeSource(source)
          sources.delete(source)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length === 0 && this.owned) {
      try {
        await this.withAdmin(async (admin) => {
          await this.assertOwnership(admin)
          await admin.query(
            `DROP DATABASE ${quoteIdentifier(this.owned!.name)}`,
          )
          this.owned = undefined
        })
      } catch (error) {
        errors.push(error)
      }
    }
    throwErrors(errors, "Test database cleanup failed")
    this.testDataSource = undefined
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
