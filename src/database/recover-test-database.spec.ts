import { ConfigService } from "@nestjs/config"
import { createHash } from "node:crypto"
import {
  recoverTestDatabase,
  RecoverTestDatabaseOptions,
  SharedDatabaseModule,
  TestDatabaseRecoveryError,
  TestDatabaseRecoveryResult,
} from "./index"
import { captureRecoveryInput } from "./helpers/test-database-recovery-input"
import { TestDatabaseSession } from "./helpers/test-database-session"

function record(baseName = "base"): RecoverTestDatabaseOptions {
  const identity = { namespace: "saved-creator", workerId: "", processId: 123 }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        baseName,
        identity.namespace,
        identity.processId,
        identity.workerId,
      ]),
    )
    .digest("hex")
    .slice(0, 32)
  let prefix = ""
  for (const character of baseName) {
    if (Buffer.byteLength(prefix + character + `_test_${digest}`) > 63) break
    prefix += character
  }
  return {
    base: {
      databaseUrl: `postgres://local:local@localhost/${encodeURIComponent(baseName)}`,
      expectedRole: "local",
    },
    database: { ...identity, databaseName: `${prefix}_test_${digest}` },
    acquiredOid: 42,
    exclusiveTarget: true,
  }
}

const binding = {
  name: "base",
  session: "local",
  current: "local",
  role: 7,
  template: false,
}
function mockSession() {
  const input = record()
  const target = {
    name: input.database.databaseName,
    oid: 42,
    owner: 7,
    template: false,
  }
  const query = jest
    .fn<Promise<object[]>, [string, unknown[], string, number]>()
    .mockResolvedValue([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([binding])
    .mockResolvedValueOnce([{ locked: true }])
    .mockResolvedValueOnce([target])
    .mockResolvedValueOnce([target])
  const connect = jest.fn().mockResolvedValue(undefined)
  const close = jest.fn().mockResolvedValue(undefined)
  const interrupt = jest.fn()
  const session = { query, connect, close, interrupt, healthy: true }
  jest
    .spyOn(TestDatabaseSession, "create")
    .mockResolvedValue(session as unknown as TestDatabaseSession)
  return { input, target, query, close, interrupt, session }
}

describe("retained test database recovery public contract", () => {
  afterEach(async () => {
    jest.restoreAllMocks()
    await SharedDatabaseModule.resetTestDatabase()
  })

  it.each(["normal", 'quoted"base', "雪😀 /%".repeat(30), "a".repeat(100)])(
    "uses the existing original identity for %p",
    (baseName) => {
      const input = record(baseName)
      expect(captureRecoveryInput(input).databaseName).toBe(
        input.database.databaseName,
      )
      SharedDatabaseModule.initializeTestInvocation({
        namespace: "current-invocation",
      })
      const original = SharedDatabaseModule.getTestDatabaseInfo(
        new ConfigService({ DATABASE_URL: input.base.databaseUrl }),
      )
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            baseName,
            original.namespace,
            original.processId,
            original.workerId,
          ]),
        )
        .digest("hex")
        .slice(0, 32)
      expect(original.databaseName).toBe(
        record(baseName).database.databaseName.replace(/[a-f0-9]{32}$/, digest),
      )
      expect(Buffer.byteLength(original.databaseName)).toBeLessThanOrEqual(63)
    },
  )

  const invalid: Array<
    [string, (input: RecoverTestDatabaseOptions) => unknown, string]
  > = [
    [
      "missing evidence",
      (input) => ({ ...input, acquiredOid: undefined }),
      "INVALID_INPUT",
    ],
    ["zero OID", (input) => ({ ...input, acquiredOid: 0 }), "INVALID_INPUT"],
    [
      "overflow OID",
      (input) => ({ ...input, acquiredOid: 0x100000000 }),
      "INVALID_INPUT",
    ],
    [
      "fractional OID",
      (input) => ({ ...input, acquiredOid: 1.5 }),
      "INVALID_INPUT",
    ],
    [
      "false exclusivity",
      (input) => ({ ...input, exclusiveTarget: false }),
      "INVALID_INPUT",
    ],
    [
      "missing record",
      (input) => ({ ...input, database: null }),
      "INVALID_INPUT",
    ],
    [
      "invalid PID",
      (input) => ({ ...input, database: { ...input.database, processId: -1 } }),
      "INVALID_INPUT",
    ],
    [
      "empty namespace",
      (input) => ({ ...input, database: { ...input.database, namespace: "" } }),
      "INVALID_INPUT",
    ],
    [
      "invalid Unicode",
      (input) => ({
        ...input,
        database: { ...input.database, workerId: "\ud800" },
      }),
      "INVALID_INPUT",
    ],
    [
      "wrong name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "unrelated" },
      }),
      "IDENTITY_MISMATCH",
    ],
    [
      "system name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "postgres" },
      }),
      "UNSAFE_TARGET",
    ],
    [
      "reserved name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "pg_reserved" },
      }),
      "UNSAFE_TARGET",
    ],
    [
      "base name",
      (input) => ({
        ...input,
        database: { ...input.database, databaseName: "base" },
      }),
      "UNSAFE_TARGET",
    ],
    ["NaN budget", (input) => ({ ...input, timeoutMs: NaN }), "INVALID_INPUT"],
    [
      "zero close budget",
      (input) => ({ ...input, closeTimeoutMs: 0 }),
      "INVALID_INPUT",
    ],
    [
      "large budget",
      (input) => ({ ...input, timeoutMs: 300001 }),
      "INVALID_INPUT",
    ],
    [
      "wrong role",
      (input) => ({ ...input, base: { ...input.base, expectedRole: "other" } }),
      "INVALID_INPUT",
    ],
    ...[
      "?host=other",
      "?user=other",
      "?database=other",
      "?options=-c%20role=other",
      "?sslnegotiation=direct",
      "?sslmode=no-verify",
      "?sslmode=disable&sslmode=verify-full",
      "?uselibpqcompat=true",
    ].map(
      (
        suffix,
      ): [string, (input: RecoverTestDatabaseOptions) => unknown, string] => [
        "binding override",
        (input) => ({
          ...input,
          base: { ...input.base, databaseUrl: input.base.databaseUrl + suffix },
        }),
        "INVALID_INPUT",
      ],
    ),
  ]
  it.each(invalid)(
    "refuses %s before creating a session",
    async (_label, change, code) => {
      const create = jest.spyOn(TestDatabaseSession, "create")
      await expect(
        recoverTestDatabase(change(record()) as RecoverTestDatabaseOptions),
      ).rejects.toMatchObject({
        code,
        phase: "validate",
        outcome: "not-attempted",
      })
      expect(create).not.toHaveBeenCalled()
    },
  )

  it("captures primitive evidence before caller mutation", () => {
    const input = record()
    const captured = captureRecoveryInput(input)
    Object.assign(input.database, { databaseName: "replacement" })
    Object.assign(input.base, {
      databaseUrl: "postgres://other@elsewhere/other",
    })
    expect(captured.databaseName).toBe(record().database.databaseName)
    expect(captured.databaseUrl).toBe(record().base.databaseUrl)
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it("removes through ordinary DROP and checks absence without changing the current invocation", async () => {
    const { input, query } = mockSession()
    const token = SharedDatabaseModule.initializeTestInvocation()
    const result: TestDatabaseRecoveryResult = await recoverTestDatabase(input)
    expect(result).toEqual({ status: "removed" })
    expect(SharedDatabaseModule.initializeTestInvocation()).toBe(token)
    const ddl = query.mock.calls.filter(([sql]) =>
      String(sql).startsWith("DROP"),
    )
    expect(ddl).toHaveLength(1)
    expect(ddl[0][0]).toBe(`DROP DATABASE "${input.database.databaseName}"`)
    expect(query.mock.calls.at(-1)?.[0]).toContain(
      "WHERE datname = $1 OR oid = $2::oid",
    )
  })

  it("returns explicit already-absent without DROP", async () => {
    const { input, query } = mockSession()
    query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValue([])
    await expect(recoverTestDatabase(input)).resolves.toEqual({
      status: "already-absent",
    })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
  })

  it.each([
    ["replacement", { oid: 99 }, "IDENTITY_MISMATCH"],
    ["rename", { name: "renamed" }, "IDENTITY_MISMATCH"],
    ["indirect owner", { owner: 8 }, "OWNERSHIP_MISMATCH"],
    ["template", { template: true }, "UNSAFE_TARGET"],
  ])("preserves %s without DDL", async (_label, change, code) => {
    const { input, query, target } = mockSession()
    query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([binding])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValue([{ ...target, ...change }])
    await expect(recoverTestDatabase(input)).rejects.toMatchObject({
      code,
      outcome: "not-attempted",
    })
    expect(
      query.mock.calls.some(([sql]) => String(sql).startsWith("DROP")),
    ).toBe(false)
  })

  it("retains uncertainty and safe primary plus close failures", async () => {
    const { input, query, close } = mockSession()
    query.mockRejectedValueOnce(new Error("private server response"))
    close.mockRejectedValueOnce(new Error("private close response"))
    const error: unknown = await recoverTestDatabase(input).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(TestDatabaseRecoveryError)
    expect(error).toMatchObject({
      outcome: "unknown",
      failures: [
        { code: "DATABASE_FAILURE", phase: "drop" },
        { code: "CLOSE_FAILED", phase: "close" },
      ],
    })
    expect(JSON.stringify(error)).not.toMatch(/private|local|base_test/)
    expect((error as Error).cause).toBeUndefined()
  })

  it("rejects confirmed absence when close fails", async () => {
    const { input, close } = mockSession()
    close.mockRejectedValueOnce(new Error("close failed"))
    await expect(recoverTestDatabase(input)).rejects.toMatchObject({
      code: "CLOSE_FAILED",
      outcome: "removed",
    })
  })

  it("rejects preconnect cancellation without creating a session", async () => {
    const create = jest.spyOn(TestDatabaseSession, "create")
    const controller = new AbortController()
    controller.abort()
    await expect(
      recoverTestDatabase({ ...record(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", outcome: "not-attempted" })
    expect(create).not.toHaveBeenCalled()
  })
})
