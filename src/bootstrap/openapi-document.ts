import { INestApplication } from "@nestjs/common"
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerDocumentOptions,
  SwaggerModule,
} from "@nestjs/swagger"

export type OpenApiDocumentOptions = {
  title?: string
  description?: string
  version?: string
  bearerAuth?: boolean
  customize?: (builder: DocumentBuilder) => DocumentBuilder
  documentOptions?: SwaggerDocumentOptions
}

export function buildSwaggerConfig(
  options: OpenApiDocumentOptions = {},
): Omit<OpenAPIObject, "paths"> {
  let builder = new DocumentBuilder()
  if (options.title !== undefined) builder = builder.setTitle(options.title)
  if (options.description !== undefined)
    builder = builder.setDescription(options.description)
  builder = builder.setVersion(options.version ?? "1.0")
  if (options.bearerAuth) builder = builder.addBearerAuth()
  if (options.customize) builder = options.customize(builder)
  return builder.build()
}

export function createOpenApiDocument(
  app: INestApplication,
  options: OpenApiDocumentOptions = {},
): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    buildSwaggerConfig(options),
    options.documentOptions,
  )
  if (options.bearerAuth) {
    document.security = [{ bearer: [] }]
  }
  return document
}
