import { DynamicModule, Module, OnModuleDestroy } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers"
import { RedisConfig } from "./redis.config"

@Module({})
export class SharedRedisModule implements OnModuleDestroy {
  private static testContainer: StartedTestContainer | null = null

  static forRoot(): DynamicModule {
    return {
      module: SharedRedisModule,
      providers: [
        {
          provide: RedisConfig,
          useFactory: async (configService: ConfigService) => {
            const isTestEnvironment = process.env.NODE_ENV === "test"

            if (isTestEnvironment) {
              return new RedisConfig(await this.createTestConfiguration())
            }

            return new RedisConfig(
              this.createProductionConfiguration(configService),
            )
          },
          inject: [ConfigService],
        },
      ],
      exports: [RedisConfig],
      imports: [ConfigModule],
      global: true,
    }
  }

  private static async createTestConfiguration() {
    if (!this.testContainer) {
      this.testContainer = await new GenericContainer("redis")
        .withExposedPorts(6379)
        .withWaitStrategy(
          Wait.forAll([
            Wait.forListeningPorts(),
            Wait.forLogMessage("Ready to accept connections tcp"),
          ]),
        )
        .start()
    }

    return `redis://${this.testContainer.getHost()}:${this.testContainer.getMappedPort(6379)}`
  }

  private static createProductionConfiguration(configService: ConfigService) {
    return configService.get("REDIS_URL") as string
  }

  static async closeTestConnection(): Promise<void> {
    if (this.testContainer) {
      await this.testContainer.stop()
      this.testContainer = null
    }
  }

  async onModuleDestroy() {
    await SharedRedisModule.closeTestConnection()
  }
}
