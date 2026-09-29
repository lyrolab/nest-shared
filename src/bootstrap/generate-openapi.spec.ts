import { OpenAPIObject } from "@nestjs/swagger"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { generateOpenApi } from "./generate-openapi"
import { ExplodingAppModule } from "./test-app.fixture"

describe("generateOpenApi", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openapi-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes the document without instantiating providers", async () => {
    const outputPath = join(dir, "openapi.json")

    const document = await generateOpenApi(ExplodingAppModule, {
      title: "Test API",
      bearerAuth: true,
      outputPath,
    })

    const written = JSON.parse(
      readFileSync(outputPath, "utf8"),
    ) as OpenAPIObject
    expect(written).toEqual(JSON.parse(JSON.stringify(document)))
    expect(written.info.title).toBe("Test API")
    expect(written.security).toEqual([{ bearer: [] }])
    expect(Object.keys(written.paths)).toEqual(["/greetings"])
  })

  it("writes pretty-printed JSON to openapi.json in the working directory by default", async () => {
    const cwd = jest.spyOn(process, "cwd").mockReturnValue(dir)

    try {
      await generateOpenApi(ExplodingAppModule)
    } finally {
      cwd.mockRestore()
    }

    const content = readFileSync(join(dir, "openapi.json"), "utf8")
    expect(content).toContain('\n  "openapi"')
  })
})
