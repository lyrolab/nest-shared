import { NestFactory } from "@nestjs/core"
import { NestExpressApplication } from "@nestjs/platform-express"
import { OpenAPIObject } from "@nestjs/swagger"
import * as request from "supertest"
import { configureApp, ConfigureAppOptions } from "./configure-app"
import { TestAppModule } from "./test-app.fixture"

describe("configureApp", () => {
  const originalEnv = process.env
  let app: NestExpressApplication | undefined

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.CORS_ORIGINS
    delete process.env.FRONTEND_URL
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    process.env = originalEnv
  })

  const createApp = async (options?: ConfigureAppOptions) => {
    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      logger: false,
    })
    if (options) {
      configureApp(app, options)
    } else {
      configureApp(app)
    }
    await app.init()
    return app.getHttpServer()
  }

  const preflight = (server: unknown, origin: string) =>
    request(server as Parameters<typeof request>[0])
      .options("/greetings")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")

  describe("cors", () => {
    it("allows FRONTEND_URL with credentials", async () => {
      process.env.FRONTEND_URL = "http://front.test"
      const server = await createApp()

      const response = await preflight(server, "http://front.test")

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://front.test",
      )
      expect(response.headers["access-control-allow-credentials"]).toBe("true")
    })

    it("allows every origin listed in CORS_ORIGINS over FRONTEND_URL", async () => {
      process.env.FRONTEND_URL = "http://front.test"
      process.env.CORS_ORIGINS = "http://a.test, http://b.test"
      const server = await createApp()

      const allowed = await preflight(server, "http://b.test")
      const rejected = await preflight(server, "http://front.test")

      expect(allowed.headers["access-control-allow-origin"]).toBe(
        "http://b.test",
      )
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("falls back to FRONTEND_URL when CORS_ORIGINS is empty", async () => {
      process.env.FRONTEND_URL = "http://front.test"
      process.env.CORS_ORIGINS = ""
      const server = await createApp()

      const response = await preflight(server, "http://front.test")

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://front.test",
      )
    })

    it("merges custom cors options", async () => {
      process.env.FRONTEND_URL = "http://front.test"
      const server = await createApp({ cors: { credentials: false } })

      const response = await preflight(server, "http://front.test")

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://front.test",
      )
      expect(
        response.headers["access-control-allow-credentials"],
      ).toBeUndefined()
    })

    it("can be disabled", async () => {
      process.env.FRONTEND_URL = "http://front.test"
      const server = await createApp({ cors: false })

      const response = await preflight(server, "http://front.test")

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    })
  })

  describe("swagger", () => {
    it("serves the document at /api by default", async () => {
      const server = await createApp()

      const response = await request(server).get("/api-json").expect(200)
      const document = response.body as OpenAPIObject

      expect(document.info.version).toBe("1.0")
      expect(Object.keys(document.paths)).toEqual(["/greetings"])
    })

    it("uses the given document options and path", async () => {
      const server = await createApp({
        swagger: { path: "docs", title: "My API", bearerAuth: true },
      })

      const response = await request(server).get("/docs-json").expect(200)
      const document = response.body as OpenAPIObject

      expect(document.info.title).toBe("My API")
      expect(document.security).toEqual([{ bearer: [] }])
    })

    it("can be disabled", async () => {
      const server = await createApp({ swagger: false })

      await request(server).get("/api-json").expect(404)
    })
  })

  describe("validation", () => {
    it("rejects properties that are not whitelisted", async () => {
      const server = await createApp()

      await request(server)
        .post("/greetings")
        .send({ name: "Ada", extra: true })
        .expect(400)
    })

    it("merges custom validation pipe options", async () => {
      const server = await createApp({
        validationPipe: { forbidNonWhitelisted: false },
      })

      const response = await request(server)
        .post("/greetings")
        .send({ name: "Ada", extra: true })
        .expect(201)

      expect(response.body).toEqual({ name: "Ada" })
    })
  })
})
