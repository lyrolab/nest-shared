import { Type } from "class-transformer"
import { IsInt, IsOptional, IsString, IsUrl } from "class-validator"
import { registerConfig, validateEnv } from "./register-config"

class DatabaseConfig {
  @IsUrl({ require_tld: false, protocols: ["postgres"] })
  DATABASE_URL!: string

  @Type(() => Number)
  @IsInt()
  POOL_SIZE!: number

  @IsOptional()
  @IsString()
  SCHEMA?: string
}

describe("validateEnv", () => {
  const validate = validateEnv(DatabaseConfig)

  it("returns a typed instance with converted values", () => {
    const config = validate({
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      POOL_SIZE: "10",
    })

    expect(config).toBeInstanceOf(DatabaseConfig)
    expect(config.POOL_SIZE).toBe(10)
    expect(config.SCHEMA).toBeUndefined()
  })

  it("strips variables not declared on the class", () => {
    const config = validate({
      DATABASE_URL: "postgres://localhost:5432/app",
      POOL_SIZE: "1",
      UNRELATED: "value",
    })

    expect(config).not.toHaveProperty("UNRELATED")
  })

  it("fails on a missing variable", () => {
    expect(() => validate({ POOL_SIZE: "10" })).toThrow(
      /Invalid environment configuration \(DatabaseConfig\):\n {2}- DATABASE_URL: /,
    )
  })

  it("fails on an invalid variable without echoing its value", () => {
    const run = () =>
      validate({
        DATABASE_URL: "postgres://localhost:5432/app",
        POOL_SIZE: "secret-value",
      })

    expect(run).toThrow(/- POOL_SIZE: POOL_SIZE must be an integer number/)
    expect(run).not.toThrow(/secret-value/)
  })

  it("lists every failing variable", () => {
    expect(() => validate({})).toThrow(/DATABASE_URL[\s\S]*POOL_SIZE/)
  })
})

describe("registerConfig", () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it("registers the validated config under the class name", () => {
    process.env = {
      DATABASE_URL: "postgres://localhost:5432/app",
      POOL_SIZE: "5",
    }

    const factory = registerConfig(DatabaseConfig)

    expect(factory.KEY).toBe("CONFIGURATION(DatabaseConfig)")
    expect(factory()).toMatchObject({ POOL_SIZE: 5 })
  })

  it("fails when the environment is invalid", () => {
    process.env = {}

    expect(() => registerConfig(DatabaseConfig)()).toThrow(/DATABASE_URL/)
  })
})
