import { Injectable, Module, OnApplicationShutdown } from "@nestjs/common"
import { DataSource } from "typeorm"
import { createCliDataSource } from "./create-cli-data-source"

const shutdown = jest.fn()

@Injectable()
class ShutdownProbe implements OnApplicationShutdown {
  onApplicationShutdown() {
    shutdown()
  }
}

const dataSource = Object.create(DataSource.prototype) as DataSource

@Module({
  providers: [{ provide: DataSource, useValue: dataSource }, ShutdownProbe],
})
class CliAppModule {}

describe("createCliDataSource", () => {
  it("returns the application data source after closing the application", async () => {
    const result = await createCliDataSource(CliAppModule)

    expect(result).toBe(dataSource)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
