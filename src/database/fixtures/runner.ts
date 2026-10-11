import { ConfigModule } from "@nestjs/config"
import { Test, TestingModule } from "@nestjs/testing"
import { DataSource } from "typeorm"
import { basename, join } from "node:path"
import { access, writeFile } from "node:fs/promises"
import { SharedDatabaseModule as Database } from "../index"
import { Person, Tag, Note } from "./records.entity"
import { FailingSchema1700000000001 } from "./schema.migration"

declare global {
  const scenario: {
    directory: string
    mode:
      | "pass"
      | "hold"
      | "test-fail"
      | "setup-fail"
      | "compile-fail"
      | "teardown-fail"
      | "replacement"
  }
}

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Sentinel release deadline expired")
}

export function runScenario(): void {
  const label = basename(expect.getState().testPath!)
  let app: TestingModule | undefined
  let factory: DataSource | undefined
  let nest: DataSource | undefined
  beforeAll(async () => {
    const database = Database.forTest({
      entities: [Person, Tag, Note],
      ...(scenario.mode === "setup-fail"
        ? { migrations: [FailingSchema1700000000001], migrationsRun: true }
        : {}),
    })
    const info = Database.getTestDatabaseInfo()
    await writeFile(
      join(scenario.directory, `${label}.identity.json`),
      JSON.stringify(info),
    )
    app = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), database],
      providers:
        scenario.mode === "compile-fail"
          ? [
              {
                provide: "failure",
                inject: [DataSource],
                useFactory: () => {
                  throw new Error("intentional compilation failure")
                },
              },
            ]
          : [],
    }).compile()
    factory = Database.getTestDataSource()
    nest = app.get(DataSource)
    const factoryRows = await factory.query<{ name: string }[]>(
      "SELECT current_database() AS name",
    )
    const nestRows = await nest.query<{ name: string }[]>(
      "SELECT current_database() AS name",
    )
    expect(factoryRows[0].name).toBe(info.databaseName)
    expect(nestRows[0].name).toBe(info.databaseName)
  }, 60000)

  it("keeps its own data and reports the selected scenario", async () => {
    await factory!
      .getRepository(Person)
      .save({ name: "sentinel", tags: [{ name: "tag" }] })
    await writeFile(
      join(scenario.directory, `${label}.ready.json`),
      JSON.stringify({
        ...Database.getTestDatabaseInfo(),
        factory: Database.getTestDatabaseInfo().databaseName,
        nest: Database.getTestDatabaseInfo().databaseName,
      }),
    )
    if (scenario.mode === "hold")
      await waitForRelease(join(scenario.directory, "release"))
    expect(await nest!.getRepository(Person).count()).toBe(1)
    await Database.clearTestDatabase()
    expect(await factory!.getRepository(Person).count()).toBe(0)
    if (scenario.mode === "replacement") {
      const name = Database.getTestDatabaseInfo().databaseName
      await app!.close()
      app = undefined
      await factory!.destroy()
      const base = new (
        await import("@nestjs/config")
      ).ConfigService().get<string>("DATABASE_URL")!
      const admin = await new DataSource({
        type: "postgres",
        url: base,
      }).initialize()
      try {
        const quoted = `"${name.replaceAll('"', '""')}"`
        await admin.query(`DROP DATABASE ${quoted}`)
        await admin.query(`CREATE DATABASE ${quoted}`)
        const replacement = await new DataSource({
          type: "postgres",
          url: base,
          database: name,
        }).initialize()
        try {
          await replacement.query("CREATE TABLE sentinel (id integer)")
          await replacement.query("INSERT INTO sentinel VALUES (7)")
        } finally {
          await replacement.destroy()
        }
        await expect(Database.closeTestConnection()).rejects.toThrow(
          "ownership",
        )
      } finally {
        await admin.destroy()
      }
    }
    if (scenario.mode === "test-fail")
      throw new Error("intentional test failure")
    if (scenario.mode === "teardown-fail")
      jest
        .spyOn(nest!, "destroy")
        .mockRejectedValueOnce(new Error("intentional Nest destroy failure"))
  }, 65000)

  afterAll(async () => {
    const errors: unknown[] = []
    try {
      if (app) await app.close()
    } catch (error) {
      errors.push(error)
    }
    try {
      await Database.closeTestConnection()
    } catch (error) {
      errors.push(error)
    }
    await writeFile(
      join(scenario.directory, `${label}.closed.json`),
      JSON.stringify({
        factoryClosed: !factory?.isInitialized,
        nestClosed: !nest?.isInitialized,
        errors: errors.map(String),
      }),
    )
    if (errors.length)
      throw new AggregateError(errors, "Scenario cleanup failed")
  })
}
