import {
  recoverTestDatabase,
  TestDatabaseRecoveryError,
  type RecoverTestDatabaseOptions,
  type TestDatabaseInfo,
  type TestDatabaseRecoveryBase,
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
