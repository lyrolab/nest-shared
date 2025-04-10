import KeyvRedis from "@keyv/redis"
import { CacheModule } from "@nestjs/cache-manager"
import { DynamicModule, Module } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { RedisConfig } from "../redis/redis.config"
import { SharedRedisModule } from "../redis/shared-redis.module"

@Module({})
export class SharedCacheModule {
  static forRoot(): DynamicModule {
    return {
      module: SharedCacheModule,
      imports: [
        SharedRedisModule,
        CacheModule.registerAsync({
          isGlobal: true,
          useFactory: (
            configService: ConfigService,
            redisConfig: RedisConfig,
          ) => ({
            ttl: configService.get("CACHE_TTL")
              ? +configService.get("CACHE_TTL") * 1000
              : undefined,
            stores: [new KeyvRedis(redisConfig.url)],
          }),
          inject: [ConfigService, RedisConfig],
        }),
      ],
      exports: [CacheModule],
    }
  }
}
