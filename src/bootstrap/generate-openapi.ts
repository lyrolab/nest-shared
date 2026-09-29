import { DynamicModule, Type } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { OpenAPIObject } from "@nestjs/swagger"
import { writeFileSync } from "fs"
import { join } from "path"
import {
  createOpenApiDocument,
  OpenApiDocumentOptions,
} from "./openapi-document"

export type GenerateOpenApiOptions = OpenApiDocumentOptions & {
  outputPath?: string
  preview?: boolean
}

export async function generateOpenApi(
  appModule: Type | DynamicModule,
  options: GenerateOpenApiOptions = {},
): Promise<OpenAPIObject> {
  const { outputPath, preview = true, ...documentOptions } = options
  // Preview mode registers controllers for metadata scanning without
  // instantiating providers, so no database, Redis or external API is touched.
  const app = await NestFactory.create(appModule, { preview, logger: false })

  try {
    const document = createOpenApiDocument(app, documentOptions)
    writeFileSync(
      outputPath ?? join(process.cwd(), "openapi.json"),
      JSON.stringify(document, null, 2),
      { encoding: "utf8" },
    )
    return document
  } finally {
    await app.close()
  }
}
