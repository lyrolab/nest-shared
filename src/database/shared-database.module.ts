import { DynamicModule, Module, OnModuleDestroy } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { TypeOrmModule, TypeOrmModuleOptions } from "@nestjs/typeorm"
import { join } from "path"
import { findMainPath } from "./helpers/find-main-path"
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers"
import { DataSource } from "typeorm"

const ENTITIES_PATH = "dist/**/*.entity{.ts,.js}"
const MIGRATIONS_PATH = "dist/migrations/**/*.{ts,js}"

type SharedDatabaseModuleOptions = {
  entities?: string[]
  migrations?: string[]
}

@Module({})
export class SharedDatabaseModule implements OnModuleDestroy {
  private static testContainer: StartedTestContainer
  private static testDataSource: DataSource

  static forRoot(options: SharedDatabaseModuleOptions = {}): DynamicModule {
    return {
      module: SharedDatabaseModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: async (configService: ConfigService) => {
            const isTestEnvironment = process.env.NODE_ENV === "test"

            if (isTestEnvironment) {
              return await this.createTestConfiguration(options)
            }

            return this.createProductionConfiguration(configService, options)
          },
        }),
      ],
      exports: [TypeOrmModule],
    }
  }

  private static async createTestConfiguration(
    options: SharedDatabaseModuleOptions,
  ): Promise<TypeOrmModuleOptions> {
    if (!this.testContainer) {
      this.testContainer = await new GenericContainer("postgres")
        .withExposedPorts(5432)
        .withEnvironment({
          POSTGRES_PASSWORD: "secret",
          POSTGRES_DB: "test",
        })
        .withWaitStrategy(
          Wait.forAll([
            Wait.forListeningPorts(),
            Wait.forLogMessage(
              "database system is ready to accept connections",
            ),
          ]),
        )
        .start()
    }

    const connectionUri = `postgres://postgres:secret@localhost:${this.testContainer.getMappedPort(
      5432,
    )}/test`

    const entities = options.entities || [join(findMainPath(), ENTITIES_PATH)]
    const migrations = options.migrations || [
      join(findMainPath(), MIGRATIONS_PATH),
    ]

    if (!this.testDataSource) {
      this.testDataSource = new DataSource({
        type: "postgres",
        url: connectionUri,
        entities,
        synchronize: true,
        migrations,
      })

      await this.testDataSource.initialize()
    }

    return {
      type: "postgres",
      url: connectionUri,
      entities,
      synchronize: true,
      autoLoadEntities: true,
    }
  }

  private static createProductionConfiguration(
    configService: ConfigService,
    options: SharedDatabaseModuleOptions,
  ): TypeOrmModuleOptions {
    return {
      type: "postgres",
      url: configService.get("DATABASE_URL"),
      entities: options.entities || [
        join(findMainPath(), "dist/**/*.entity{.ts,.js}"),
      ],
      migrations: options.migrations || [
        join(findMainPath(), "dist/migrations/**/*.{ts,js}"),
      ],
      synchronize: false,
      autoLoadEntities: true,
    }
  }

  static getTestDataSource(): DataSource {
    return this.testDataSource
  }

  static async closeTestConnection(): Promise<void> {
    if (this.testDataSource) {
      await this.testDataSource.destroy()
    }
    if (this.testContainer) {
      await this.testContainer.stop()
    }
  }

  static async clearTestDatabase(): Promise<void> {
    if (this.testDataSource) {
      await this.testDataSource.synchronize(true)
    }
  }

  async onModuleDestroy() {
    if (SharedDatabaseModule.testDataSource) {
      await SharedDatabaseModule.testDataSource.destroy()
    }
  }
}
