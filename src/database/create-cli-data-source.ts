import { DynamicModule, Type } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { DataSource } from "typeorm"

export async function createCliDataSource(
  appModule: Type | DynamicModule,
): Promise<DataSource> {
  const app = await NestFactory.createApplicationContext(appModule, {
    logger: ["error", "warn"],
  })
  const dataSource = app.get(DataSource)
  // The TypeORM CLI initializes the data source itself and refuses one that is
  // already connected.
  await app.close()
  return dataSource
}
