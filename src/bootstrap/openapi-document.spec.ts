import { NestFactory } from "@nestjs/core"
import { INestApplication } from "@nestjs/common"
import { buildSwaggerConfig, createOpenApiDocument } from "./openapi-document"
import { TestAppModule } from "./test-app.fixture"

describe("buildSwaggerConfig", () => {
  it("defaults to version 1.0 without title or security", () => {
    const config = buildSwaggerConfig()

    expect(config.info.version).toBe("1.0")
    expect(config.info.title).toBe("")
    expect(config.components?.securitySchemes).toBeUndefined()
  })

  it("applies title, description, bearer auth and customizations", () => {
    const config = buildSwaggerConfig({
      title: "My API",
      description: "My API description",
      version: "2.0",
      bearerAuth: true,
      customize: (builder) =>
        builder.addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }),
    })

    expect(config.info).toMatchObject({
      title: "My API",
      description: "My API description",
      version: "2.0",
    })
    expect(config.components?.securitySchemes).toMatchObject({
      bearer: { type: "http", scheme: "bearer" },
      api_key: { type: "apiKey", name: "x-api-key", in: "header" },
    })
  })
})

describe("createOpenApiDocument", () => {
  let app: INestApplication

  beforeEach(async () => {
    app = await NestFactory.create(TestAppModule, { logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  it("documents the application routes", () => {
    const document = createOpenApiDocument(app, { title: "Test" })

    expect(Object.keys(document.paths)).toEqual(["/greetings"])
    expect(document.security).toBeUndefined()
  })

  it("requires bearer auth globally when bearerAuth is enabled", () => {
    const document = createOpenApiDocument(app, { bearerAuth: true })

    expect(document.security).toEqual([{ bearer: [] }])
  })
})
