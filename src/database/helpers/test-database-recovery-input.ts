import type {
  RecoverTestDatabaseOptions,
  TestDatabaseRecoveryTls,
} from "../recover-test-database"
import { TestDatabaseRecoveryError } from "../test-database-recovery-error"
import { testDatabaseName } from "./test-database-identity"

function refuse(
  code: "INVALID_INPUT" | "UNSAFE_TARGET" | "IDENTITY_MISMATCH",
): never {
  throw new TestDatabaseRecoveryError([{ code, phase: "validate" }])
}

function validText(value: unknown, empty = false): value is string {
  if (typeof value !== "string" || (!empty && !value) || value.includes("\0"))
    return false
  // Buffer replaces lone surrogates; accepting them would change the saved identity.
  return Buffer.from(value, "utf8").toString("utf8") === value
}

function budget(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    refuse("INVALID_INPUT")
  return value
}

function record(value: unknown, fields: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        fields.includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    )
  )
}

export function captureTestDatabaseBase(
  databaseUrl: string,
  expectedRole: string,
) {
  try {
    const url = new URL(databaseUrl)
    const baseName = decodeURIComponent(url.pathname.slice(1))
    const role = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.hostname.includes("%") ||
      !validText(baseName) ||
      !validText(role) ||
      !validText(password, true) ||
      url.hash ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) ||
      role !== expectedRole
    )
      refuse("INVALID_INPUT")
    // Binding/transport options must not override the explicit URL identity.
    const tlsKeys = new Set(["sslmode", "sslcert", "sslkey", "sslrootcert"])
    const seen = new Set<string>()
    for (const [key, value] of url.searchParams) {
      if (!tlsKeys.has(key) || seen.has(key) || !validText(value))
        refuse("INVALID_INPUT")
      seen.add(key)
    }
    const sslmode = url.searchParams.get("sslmode")
    if (
      sslmode !== null &&
      !["disable", "require", "verify-ca", "verify-full"].includes(sslmode)
    )
      refuse("INVALID_INPUT")
    return { databaseUrl, baseName, expectedRole }
  } catch (error) {
    if (error instanceof TestDatabaseRecoveryError) throw error
    refuse("INVALID_INPUT")
  }
}

function captureTls(value: unknown): TestDatabaseRecoveryTls | undefined {
  if (value === undefined) return undefined
  if (!record(value, ["caPem", "certPem", "keyPem"])) refuse("INVALID_INPUT")
  const { caPem, certPem, keyPem } = value as TestDatabaseRecoveryTls
  const pem = (text: unknown, kind: "certificate" | "key") => {
    if (!validText(text) || Buffer.byteLength(text) > 1_048_576)
      refuse("INVALID_INPUT")
    const source = text
    const pattern =
      kind === "certificate"
        ? /^(?:\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/
        : /^\s*-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]+-----END \1-----\s*$/
    if (!pattern.test(source)) refuse("INVALID_INPUT")
    return source
  }
  const ca = pem(caPem, "certificate")
  if ((certPem === undefined) !== (keyPem === undefined))
    refuse("INVALID_INPUT")
  return Object.freeze({
    caPem: ca,
    ...(certPem === undefined
      ? {}
      : {
          certPem: pem(certPem, "certificate"),
          keyPem: pem(keyPem, "key"),
        }),
  })
}

export function captureRecoveryInput(options: RecoverTestDatabaseOptions) {
  try {
    if (
      !record(options, [
        "base",
        "database",
        "acquiredOid",
        "exclusiveTarget",
        "timeoutMs",
        "closeTimeoutMs",
        "signal",
      ])
    )
      refuse("INVALID_INPUT")
    const { base, database, acquiredOid, exclusiveTarget, signal } = options
    if (
      !record(base, ["databaseUrl", "expectedRole", "tls"]) ||
      !record(database, ["namespace", "workerId", "processId", "databaseName"])
    )
      refuse("INVALID_INPUT")
    const { databaseUrl, expectedRole } = base
    const tls = captureTls(base.tls)
    const { namespace, workerId, processId, databaseName } = database
    if (
      exclusiveTarget !== true ||
      !validText(databaseUrl) ||
      !validText(expectedRole) ||
      Buffer.byteLength(databaseUrl) > 16_384 ||
      Buffer.byteLength(expectedRole) > 63 ||
      !validText(namespace) ||
      !validText(workerId, true) ||
      Buffer.byteLength(namespace) > 65_536 ||
      Buffer.byteLength(workerId) > 65_536 ||
      !validText(databaseName) ||
      Buffer.byteLength(databaseName) > 63 ||
      !Number.isSafeInteger(processId) ||
      processId <= 0 ||
      !Number.isInteger(acquiredOid) ||
      acquiredOid <= 0 ||
      acquiredOid > 0xffffffff ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      refuse("INVALID_INPUT")
    const timeoutMs = budget(options.timeoutMs, 30_000, 300_000)
    const closeTimeoutMs = budget(options.closeTimeoutMs, 5_000, 30_000)
    const { baseName } = captureTestDatabaseBase(databaseUrl, expectedRole)
    const url = new URL(databaseUrl)
    for (const key of url.searchParams.keys()) {
      if (key !== "sslmode") refuse("INVALID_INPUT")
    }
    const mode = url.searchParams.get("sslmode")
    if (
      (tls && mode === "disable") ||
      (!tls && mode !== null && mode !== "disable")
    )
      refuse("INVALID_INPUT")
    if (
      databaseName === baseName ||
      ["postgres", "template0", "template1"].includes(databaseName) ||
      databaseName.startsWith("pg_")
    )
      refuse("UNSAFE_TARGET")
    if (
      databaseName !==
      testDatabaseName(baseName, { namespace, workerId, processId })
    )
      refuse("IDENTITY_MISMATCH")
    return Object.freeze({
      databaseUrl,
      tls,
      baseName,
      expectedRole,
      databaseName,
      acquiredOid,
      timeoutMs,
      closeTimeoutMs,
      signal,
    })
  } catch (error) {
    if (error instanceof TestDatabaseRecoveryError) throw error
    refuse("INVALID_INPUT")
  }
}
