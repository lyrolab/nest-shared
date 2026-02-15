import { DynamicModule, Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { RedisConfig } from "./redis.config"

@Module({})
export class SharedRedisModule {
  static forRoot(): DynamicModule {
    return {
      module: SharedRedisModule,
      providers: [
        {
          provide: RedisConfig,
          useFactory: (configService: ConfigService) => {
            return new RedisConfig(configService.get("REDIS_URL") as string)
          },
          inject: [ConfigService],
        },
      ],
      exports: [RedisConfig],
      imports: [ConfigModule],
      global: true,
    }
  }

  static forTest(): DynamicModule {
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
      throw new Error(
        "REDIS_URL environment variable is required for test setup",
      )
    }

    return {
      module: SharedRedisModule,
      providers: [
        {
          provide: RedisConfig,
          useValue: new RedisConfig(redisUrl),
        },
      ],
      exports: [RedisConfig],
      global: true,
    }
  }
}
