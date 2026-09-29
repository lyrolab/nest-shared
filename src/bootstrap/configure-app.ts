import { NestExpressApplication } from "@nestjs/platform-express"
import { ValidationPipe, ValidationPipeOptions } from "@nestjs/common"
import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface"
import { ConfigService } from "@nestjs/config"
import { SwaggerModule } from "@nestjs/swagger"
import { TypeOrmExceptionFilter } from "../database/filters/typeorm-exception.filter"
import { parseCorsOrigins } from "./cors-origins"
import {
  createOpenApiDocument,
  OpenApiDocumentOptions,
} from "./openapi-document"

export type SwaggerSetupOptions = OpenApiDocumentOptions & {
  path?: string
}

export type ConfigureAppOptions = {
  cors?: boolean | CorsOptions
  swagger?: boolean | SwaggerSetupOptions
  validationPipe?: ValidationPipeOptions
}

export const configureApp = (
  app: NestExpressApplication,
  options: ConfigureAppOptions = {},
) => {
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      whitelist: true,
      ...options.validationPipe,
    }),
  )
  app.useGlobalFilters(new TypeOrmExceptionFilter())

  const { cors = true, swagger = true } = options
  if (cors) {
    configureCors(app, cors === true ? {} : cors)
  }
  app.enableShutdownHooks()

  if (swagger) {
    configureSwagger(app, swagger === true ? {} : swagger)
  }
}

const configureCors = (app: NestExpressApplication, overrides: CorsOptions) => {
  const configService = app.get(ConfigService)
  const origins = parseCorsOrigins(
    configService.get<string>("CORS_ORIGINS") ||
      configService.get<string>("FRONTEND_URL"),
  )
  app.enableCors({
    origin: origins.length > 0 ? origins : undefined,
    credentials: true,
    ...overrides,
  })
}

const configureSwagger = (
  app: NestExpressApplication,
  { path = "api", ...documentOptions }: SwaggerSetupOptions,
) => {
  SwaggerModule.setup(path, app, () =>
    createOpenApiDocument(app, documentOptions),
  )
}
