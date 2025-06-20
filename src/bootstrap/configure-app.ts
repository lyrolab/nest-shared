import { NestExpressApplication } from "@nestjs/platform-express"
import { ValidationPipe } from "@nestjs/common"
import { TypeOrmExceptionFilter } from "../database/filters/typeorm-exception.filter"
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger"
import { ConfigService } from "@nestjs/config"

export const configureApp = (app: NestExpressApplication) => {
  app.useGlobalPipes(
    new ValidationPipe({ forbidNonWhitelisted: true, whitelist: true }),
  )
  app.useGlobalFilters(new TypeOrmExceptionFilter())
  const configService = app.get(ConfigService)
  app.enableCors({
    origin: configService.get("FRONTEND_URL"),
    credentials: true,
  })
  app.enableShutdownHooks()

  configureSwagger(app)
}

const configureSwagger = (app: NestExpressApplication) => {
  const config = new DocumentBuilder().setVersion("1.0").build()
  const documentFactory = () => SwaggerModule.createDocument(app, config)
  SwaggerModule.setup("api", app, documentFactory)
}
