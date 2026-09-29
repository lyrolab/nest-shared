import { DynamicModule, Type } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { DataSource } from "typeorm"

export async function createCliDataSource(
  appModule: Type | DynamicModule,
): Promise<DataSource> {
  // NestFactory.create builds the module graph without init(), so no lifecycle
  // hook (onModuleInit, onApplicationBootstrap, shutdown hooks) ever runs.
  const app = await NestFactory.create(appModule, {
    logger: ["error", "warn"],
  })
  const dataSource = app.get(DataSource)
  // The TypeORM CLI initializes the data source itself and refuses one that is
  // already connected.
  if (dataSource.isInitialized) await dataSource.destroy()
  return dataSource
}
