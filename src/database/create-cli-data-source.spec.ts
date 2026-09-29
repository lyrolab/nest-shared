import {
  BeforeApplicationShutdown,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { DataSource } from "typeorm"
import { createCliDataSource } from "./create-cli-data-source"

const hook = jest.fn()

@Injectable()
class LifecycleProbe
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  onModuleInit() {
    hook("onModuleInit")
  }

  onApplicationBootstrap() {
    hook("onApplicationBootstrap")
  }

  onModuleDestroy() {
    hook("onModuleDestroy")
  }

  beforeApplicationShutdown() {
    hook("beforeApplicationShutdown")
  }

  onApplicationShutdown() {
    hook("onApplicationShutdown")
  }
}

function connectedDataSource(): DataSource {
  const dataSource = Object.create(DataSource.prototype) as DataSource
  Object.defineProperty(dataSource, "isInitialized", {
    value: true,
    writable: true,
  })
  dataSource.destroy = jest.fn(() => {
    Object.defineProperty(dataSource, "isInitialized", { value: false })
    return Promise.resolve()
  })
  return dataSource
}

async function runWith(dataSource: DataSource) {
  @Module({
    providers: [{ provide: DataSource, useValue: dataSource }, LifecycleProbe],
  })
  class CliAppModule {}

  return createCliDataSource(CliAppModule)
}

describe("createCliDataSource", () => {
  beforeEach(() => hook.mockClear())

  it("returns the application data source without running lifecycle hooks", async () => {
    const dataSource = connectedDataSource()

    const result = await runWith(dataSource)

    expect(result).toBe(dataSource)
    expect(hook).not.toHaveBeenCalled()
  })

  it("releases the connection so the TypeORM CLI can initialize it", async () => {
    const dataSource = connectedDataSource()

    const result = await runWith(dataSource)

    expect(dataSource.destroy).toHaveBeenCalledTimes(1)
    expect(result.isInitialized).toBe(false)
  })

  it("leaves an uninitialized data source untouched", async () => {
    const dataSource = connectedDataSource()
    Object.defineProperty(dataSource, "isInitialized", { value: false })

    await runWith(dataSource)

    expect(dataSource.destroy).not.toHaveBeenCalled()
  })
})
