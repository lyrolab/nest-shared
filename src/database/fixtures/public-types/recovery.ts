import { ConfigService } from "@nestjs/config"
import { readFile } from "node:fs/promises"
import {
  recoverTestDatabase,
  TestDatabaseRecoveryError,
  type RecoverTestDatabaseOptions,
  type TestDatabaseInfo,
  type TestDatabaseRecoveryBase,
  type TestDatabaseRecoveryTls,
  type TestDatabaseRecoveryResult,
} from "@lyrolab/nest-shared/database"

export async function recoverSaved(
  base: TestDatabaseRecoveryBase,
  database: TestDatabaseInfo,
  acquiredOid: number,
  signal: AbortSignal,
): Promise<TestDatabaseRecoveryResult> {
  const options: RecoverTestDatabaseOptions = {
    base,
    database,
    acquiredOid,
    exclusiveTarget: true,
    timeoutMs: 30_000,
    closeTimeoutMs: 5_000,
    signal,
  }
  try {
    return await recoverTestDatabase(options)
  } catch (error) {
    if (error instanceof TestDatabaseRecoveryError) {
      const safe: string = `${error.code}:${error.phase}:${error.outcome}:${error.failures.map((failure) => failure.code).join(",")}`
      throw new Error(safe)
    }
    throw error
  }
}

export function withTls(
  base: TestDatabaseRecoveryBase,
  tls: TestDatabaseRecoveryTls,
): TestDatabaseRecoveryBase {
  return { ...base, tls }
}

export async function prepareRecoveryBase(
  config: ConfigService,
  expectedRole: string,
): Promise<TestDatabaseRecoveryBase> {
  const configured = new URL(config.getOrThrow<string>("DATABASE_URL"))
  const caPath = configured.searchParams.get("sslrootcert")
  if (!caPath) throw new Error("Explicit TLS trust material is required")
  const certPath = configured.searchParams.get("sslcert")
  const keyPath = configured.searchParams.get("sslkey")
  if (Boolean(certPath) !== Boolean(keyPath))
    throw new Error("Both client certificate and key are required")
  const tls: TestDatabaseRecoveryTls = {
    caPem: await readFile(caPath, "utf8"),
    ...(certPath && keyPath
      ? {
          certPem: await readFile(certPath, "utf8"),
          keyPem: await readFile(keyPath, "utf8"),
        }
      : {}),
  }
  const explicit = new URL("postgresql://localhost")
  explicit.hostname = configured.hostname
  explicit.port = configured.port
  explicit.username = configured.username
  explicit.password = configured.password
  explicit.pathname = configured.pathname
  explicit.searchParams.set("sslmode", "verify-full")
  return { databaseUrl: explicit.toString(), expectedRole, tls }
}
