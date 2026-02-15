import { DynamicModule, Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm"
import { join } from "path"
import { findMainPath } from "./helpers/find-main-path"
import { DataSource } from "typeorm"

const ENTITIES_PATH = "**/*.entity.{ts,js}"
const MIGRATIONS_PATH = "dist/migrations/**/*.{ts,js}"

type EntityClass = new (...args: any[]) => any

type SharedDatabaseModuleOptions = {
  entities?: string[]
  migrations?: string[]
}

type ForTestOptions = {
  entities: EntityClass[]
}

@Module({})
export class SharedDatabaseModule {
  private static testDataSource: DataSource
  private static testEntities: EntityClass[]

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

  static forTest(options: ForTestOptions): DynamicModule {
    this.testEntities = options.entities

    return {
      module: SharedDatabaseModule,
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          url: this.workerDatabaseUrl(),
          entities: options.entities,
          synchronize: false,
        }),
      ],
      exports: [TypeOrmModule],
    }
  }

  static async setupTestDatabase(): Promise<void> {
    if (this.testDataSource) return

    const { baseUrl, testDbName } = this.getWorkerDbInfo()

    // Connect to the base database to create the worker-specific database
    const adminDataSource = new DataSource({
      type: "postgres",
      url: baseUrl,
    })
    await adminDataSource.initialize()

    await adminDataSource.query(
      `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`,
    )
    await adminDataSource.query(`CREATE DATABASE "${testDbName}"`)
    await adminDataSource.destroy()

    // Build the worker database URL
    const workerUrl = new URL(baseUrl)
    workerUrl.pathname = `/${testDbName}`

    // Initialize the worker-specific database with synchronize
    this.testDataSource = new DataSource({
      type: "postgres",
      url: workerUrl.toString(),
      entities: this.testEntities,
      synchronize: true,
    })
    await this.testDataSource.initialize()
  }

  static async clearTestDatabase(): Promise<void> {
    if (!this.testDataSource) return

    const tableNames = this.testDataSource.entityMetadatas
      .map((meta) => meta.tableName)
      .join(", ")

    if (tableNames) {
      await this.testDataSource.query(`TRUNCATE TABLE ${tableNames} CASCADE`)
    }
  }

  static getTestDataSource(): DataSource {
    if (!this.testDataSource) {
      throw new Error(
        "SharedDatabaseModule not initialized. Call setupTestDatabase() first.",
      )
    }
    return this.testDataSource
  }

  static async closeTestConnection(): Promise<void> {
    if (this.testDataSource) {
      await this.testDataSource.destroy()
    }
  }

  private static getWorkerDbInfo(): { baseUrl: string; testDbName: string } {
    const baseUrl = process.env.DATABASE_URL
    if (!baseUrl) {
      throw new Error(
        "DATABASE_URL environment variable is required for test database setup",
      )
    }

    const url = new URL(baseUrl)
    const dbName = url.pathname.slice(1)
    const poolId =
      process.env.VITEST_POOL_ID ?? process.env.JEST_WORKER_ID ?? "0"
    return { baseUrl, testDbName: `${dbName}_test_${poolId}` }
  }

  private static workerDatabaseUrl(): string {
    const { baseUrl, testDbName } = this.getWorkerDbInfo()
    const url = new URL(baseUrl)
    url.pathname = `/${testDbName}`
    return url.toString()
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
