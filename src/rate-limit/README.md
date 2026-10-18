# Rate Limit Module — `@lyrolab/nest-shared/rate-limit`

Route-level rate limiting on top of `@nestjs/throttler`, with counters in Redis so every replica enforces the same limits.

## Dependencies

```bash
npm install @nestjs/throttler
```

Requires a global `RedisConfig`, provided by `SharedRedisModule.forRoot()` (or `forTest()`) from `@lyrolab/nest-shared/redis`. Keys are written under `RedisConfig.keyPrefix` when set.

## Usage

Register named limits once:

```typescript
import { SharedRedisModule } from "@lyrolab/nest-shared/redis"
import { SharedRateLimitModule } from "@lyrolab/nest-shared/rate-limit"

@Module({
  imports: [
    SharedRedisModule.forRoot(),
    SharedRateLimitModule.forRoot({
      limits: {
        "comment-create": { limit: 10, ttl: 60_000 },
        "comment-create-ip": { limit: 40, ttl: 60_000, key: "ip" },
      },
      clientIpHeader: "cf-connecting-ip",
    }),
  ],
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` builds the same options from injected providers (e.g. `ConfigService`).

Apply them to routes or controllers with `@RateLimit()`:

```typescript
import { RateLimit } from "@lyrolab/nest-shared/rate-limit"

@Controller("comments")
export class CommentController {
  @Post()
  @RateLimit("comment-create", "comment-create-ip")
  create() {}

  @Patch(":id")
  @RateLimit({ name: "comment-create", limit: 20 })
  update() {}

  @Post("search")
  @RateLimit({
    name: "search",
    limit: 20,
    ttl: 60_000,
    blockDuration: 300_000,
    key: "ip",
  })
  search() {}
}
```

- A string references a registered limit. An object references one and overrides some fields, or defines an unregistered limit inline (then `limit` and `ttl` are required).
- A route can stack several limits (e.g. per identity and per IP); the request is rejected as soon as one is exceeded.
- A limit is one bucket per tracker, shared by every route that uses the same name. Give routes distinct names to count them separately.
- Routes without `@RateLimit()` are never limited: there is no global guard.

## Limit definition

| Field           | Default      | Description                                                               |
| --------------- | ------------ | ------------------------------------------------------------------------- |
| `limit`         | —            | Requests allowed per window                                               |
| `ttl`           | —            | Window length (ms). Fixed window, starting at the tracker's first request |
| `blockDuration` | `ttl`        | How long the tracker stays rejected once over the limit (ms)              |
| `key`           | `"identity"` | `"identity"` counts per caller, `"ip"` per client IP                      |

## Keying

`key: "identity"` resolves, in order:

1. the `identify(request)` option, for identities set by your own guards (e.g. `end-user:<id>`),
2. the authenticated `request.user` from `@lyrolab/nest-shared/auth`, as `user:<issuer>:<sub>`,
3. the client IP.

`@RateLimit()` attaches its guard at method or controller level. Nest runs global guards, then controller guards, then method guards, so the identity set by a controller-level guard is visible when the decorator is on the method.

Trackers are hashed before being used as Redis keys.

## Client IP behind proxies

The client IP comes from `clientIpHeader` when configured, otherwise from `request.ip`. IPv6 addresses are grouped by /64.

- **Behind a proxy that overwrites a header with the real client IP** (Cloudflare's `CF-Connecting-IP`, an ingress `X-Real-IP`), set `clientIpHeader`. The header is trusted verbatim, so the origin must only be reachable through that proxy (Cloudflare Authenticated Origin Pulls, or an allowlist of the proxy's IP ranges); otherwise a client can forge it and get a fresh bucket per request.
- **Otherwise**, configure Express's `trust proxy` with the number of proxy hops in front of the app, e.g. `app.set("trust proxy", 1)`, and leave `clientIpHeader` unset. `request.ip` then reads the right entry of `X-Forwarded-For`. `trust proxy` also makes `request.hostname` and `request.protocol` honour `X-Forwarded-Host` and `X-Forwarded-Proto`.
- With neither, `request.ip` is the socket address: behind a proxy every client shares the proxy's bucket.

## 429 response

Exceeding a limit throws `ThrottlerException` (`429 Too Many Requests`) with a `Retry-After` header in seconds, until the block expires.

## Redis failures

The Redis client fails fast (250 ms command timeout, no offline queue) so a request never waits on its rate limit check. When Redis is unavailable, requests are allowed and a warning is logged at most once a minute. Set `onStorageError: "deny"` to answer `503` instead.

## Options

| Option           | Description                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `limits`         | Named limit definitions referenced by `@RateLimit()`                                         |
| `identify`       | `(request) => string \| null \| undefined`, the caller identity for `key: "identity"` limits |
| `clientIpHeader` | Header holding the client IP, set by a trusted proxy                                         |
| `onStorageError` | `"allow"` (default) or `"deny"`                                                              |

## Standalone storage

`RedisThrottlerStorage` implements `@nestjs/throttler`'s `ThrottlerStorage` and can back a plain `ThrottlerModule`:

```typescript
ThrottlerModule.forRootAsync({
  inject: [RedisConfig],
  useFactory: (redis: RedisConfig) => ({
    throttlers: [{ limit: 10, ttl: 60_000 }],
    storage: new RedisThrottlerStorage(redis.url, redis.keyPrefix),
  }),
})
```

Call its `onModuleInit()` and `onApplicationShutdown()` when it is not registered as a Nest provider.
