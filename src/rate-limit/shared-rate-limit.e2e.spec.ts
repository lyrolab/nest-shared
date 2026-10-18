import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  UseGuards,
} from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Request } from "express"
import * as request from "supertest"
import { App } from "supertest/types"
import { GenericContainer, StartedTestContainer } from "testcontainers"
import { RedisConfig } from "../redis/redis.config"
import { RateLimit } from "./decorators/rate-limit.decorator"
import { SharedRateLimitModule } from "./shared-rate-limit.module"

jest.setTimeout(120_000)

@Injectable()
class EndUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { endUser?: { id: string } | null }>()
    const id = req.headers["x-end-user"]
    req.endUser = typeof id === "string" ? { id } : null
    return true
  }
}

@Controller()
@UseGuards(EndUserGuard)
class ItemsController {
  @Get("items")
  @RateLimit("writes", "writes-ip")
  create() {
    return { ok: true }
  }

  @Get("open")
  open() {
    return { ok: true }
  }
}

describe("SharedRateLimitModule (e2e)", () => {
  let container: StartedTestContainer
  let app: INestApplication<App>

  beforeAll(async () => {
    container = await new GenericContainer("redis:7")
      .withExposedPorts(6379)
      .start()
    const redisConfig = new RedisConfig(
      `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
      "e2e",
    )

    const moduleRef = await Test.createTestingModule({
      imports: [
        {
          module: class RedisConfigModule {},
          global: true,
          providers: [{ provide: RedisConfig, useValue: redisConfig }],
          exports: [RedisConfig],
        },
        SharedRateLimitModule.forRoot({
          limits: {
            writes: { limit: 2, ttl: 60_000 },
            "writes-ip": { limit: 3, ttl: 60_000, key: "ip" },
          },
          identify: (req) => {
            const endUser = (req as { endUser?: { id: string } | null }).endUser
            return endUser ? `end-user:${endUser.id}` : null
          },
          clientIpHeader: "cf-connecting-ip",
        }),
      ],
      controllers: [ItemsController],
    }).compile()

    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    await container.stop()
  })

  const call = (endUser: string, ip: string) =>
    request(app.getHttpServer())
      .get("/items")
      .set("x-end-user", endUser)
      .set("cf-connecting-ip", ip)

  it("limits per identity resolved by a controller guard, then per IP, with Retry-After", async () => {
    await call("alice", "10.0.0.1").expect(200)
    await call("alice", "10.0.0.1").expect(200)
    const perUser = await call("alice", "10.0.0.1").expect(429)
    expect(perUser.headers["retry-after"]).toBe("60")

    await call("bob", "10.0.0.2").expect(200)
    await call("carol", "10.0.0.2").expect(200)
    await call("dave", "10.0.0.2").expect(200)
    await call("erin", "10.0.0.2").expect(429)
  })

  it("leaves routes without @RateLimit untouched", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get("/open").expect(200)
    }
  })
})
