import { BullModule } from "@nestjs/bullmq"
import { DynamicModule, Module } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { SharedRedisModule } from "../redis/shared-redis.module"
import { RedisConfig } from "../redis/redis.config"

@Module({})
export class SharedBullModule {
  static forRoot(): DynamicModule {
    return {
      module: SharedBullModule,
      imports: [
        SharedRedisModule,
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [RedisConfig],
          useFactory: (redisConfig: RedisConfig) => ({
            connection: {
              url: redisConfig.url,
            },
          }),
        }),
      ],
      exports: [BullModule],
    }
  }
}
