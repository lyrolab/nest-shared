import type { TestDatabaseInfo } from "./shared-database.module"
import { performance } from "node:perf_hooks"
import { captureRecoveryInput } from "./helpers/test-database-recovery-input"
import { superviseRecovery } from "./internal/test-database-recovery-parent"

export interface TestDatabaseRecoveryTls {
  readonly caPem: string
  readonly certPem?: string
  readonly keyPem?: string
}

export interface TestDatabaseRecoveryBase {
  readonly databaseUrl: string
  readonly expectedRole: string
  readonly tls?: TestDatabaseRecoveryTls
}

export interface RecoverTestDatabaseOptions {
  readonly base: TestDatabaseRecoveryBase
  readonly database: TestDatabaseInfo
  readonly acquiredOid: number
  readonly exclusiveTarget: true
  readonly timeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly signal?: AbortSignal
}

export type TestDatabaseRecoveryResult =
  | { readonly status: "removed" }
  | { readonly status: "already-absent" }

export async function recoverTestDatabase(
  options: RecoverTestDatabaseOptions,
): Promise<TestDatabaseRecoveryResult> {
  const started = performance.now()
  const input = captureRecoveryInput(options)
  return superviseRecovery(input, started)
}
