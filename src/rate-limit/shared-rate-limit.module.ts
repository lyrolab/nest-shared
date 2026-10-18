import { DynamicModule, Module, Provider } from "@nestjs/common"
import { RedisConfig } from "../redis/redis.config"
import { RateLimitGuard } from "./guards/rate-limit.guard"
import {
  RateLimitModuleAsyncOptions,
  RateLimitModuleOptions,
} from "./interfaces/rate-limit-options.interface"
import {
  RATE_LIMIT_MODULE_OPTIONS,
  RATE_LIMIT_STORAGE,
} from "./rate-limit.constants"
import { RedisThrottlerStorage } from "./storage/redis-throttler.storage"

const storageProvider: Provider = {
  provide: RATE_LIMIT_STORAGE,
  useFactory: (redisConfig: RedisConfig) =>
    new RedisThrottlerStorage(redisConfig.url, redisConfig.keyPrefix),
  inject: [RedisConfig],
}

@Module({})
export class SharedRateLimitModule {
  static forRoot(options: RateLimitModuleOptions = {}): DynamicModule {
    return this.build([
      { provide: RATE_LIMIT_MODULE_OPTIONS, useValue: options },
    ])
  }

  static forRootAsync(options: RateLimitModuleAsyncOptions): DynamicModule {
    return this.build(
      [
        {
          provide: RATE_LIMIT_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
      options.imports,
    )
  }

  private static build(
    optionsProviders: Provider[],
    imports: DynamicModule["imports"] = [],
  ): DynamicModule {
    return {
      module: SharedRateLimitModule,
      global: true,
      imports,
      providers: [...optionsProviders, storageProvider, RateLimitGuard],
      exports: [RATE_LIMIT_MODULE_OPTIONS, RATE_LIMIT_STORAGE, RateLimitGuard],
    }
  }
}
