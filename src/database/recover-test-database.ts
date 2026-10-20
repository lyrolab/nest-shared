import { performance } from "node:perf_hooks"
import type { TestDatabaseInfo } from "./shared-database.module"
import { captureRecoveryInput } from "./helpers/test-database-recovery-input"
import {
  quoteIdentifier,
  testDatabaseLockKey,
} from "./helpers/test-database-identity"
import { TestDatabaseSession } from "./helpers/test-database-session"
import {
  TestDatabaseRecoveryError,
  TestDatabaseRecoveryCode,
  TestDatabaseRecoveryFailure,
  TestDatabaseRecoveryOutcome,
  TestDatabaseRecoveryPhase,
} from "./test-database-recovery-error"

export interface TestDatabaseRecoveryBase {
  readonly databaseUrl: string
  readonly expectedRole: string
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

interface DatabaseRow {
  oid: number
  name: string
  owner: number
  template: boolean
}

export async function recoverTestDatabase(
  options: RecoverTestDatabaseOptions,
): Promise<TestDatabaseRecoveryResult> {
  const input = captureRecoveryInput(options)
  const deadline = performance.now() + input.timeoutMs
  let phase: TestDatabaseRecoveryPhase = "connect"
  let outcome: TestDatabaseRecoveryOutcome = "not-attempted"
  let stopped: TestDatabaseRecoveryCode | undefined
  let session: TestDatabaseSession | undefined
  const failures: TestDatabaseRecoveryFailure[] = []
  const abort = () => {
    stopped ??= "CANCELLED"
    session?.interrupt()
  }
  const timer = setTimeout(() => {
    stopped ??= "DEADLINE_EXCEEDED"
    session?.interrupt()
  }, input.timeoutMs)
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()
  const fail = (code: TestDatabaseRecoveryCode): never => {
    throw new TestDatabaseRecoveryError([{ code, phase }])
  }
  const remaining = () => {
    if (stopped) fail(stopped)
    const ms = Math.ceil(deadline - performance.now())
    if (ms <= 0) {
      stopped = "DEADLINE_EXCEEDED"
      session?.interrupt()
      fail(stopped)
    }
    return ms
  }
  const query = async <T extends object>(
    text: string,
    values: unknown[] = [],
  ) => {
    const ms = remaining()
    const rows = await session!.query<T>(text, values, phase, ms)
    remaining()
    return rows
  }
  try {
    remaining()
    session = await TestDatabaseSession.create(input.databaseUrl)
    await session.connect(remaining())
    // Server timeouts limit DDL even if the peer stops returning responses.
    await query(
      "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $1, false)",
      [String(remaining())],
    )
    const binding = await query<{
      name: string
      session: string
      current: string
      role: number
      template: boolean
    }>(
      `SELECT current_database() AS name, session_user AS session,
         current_user AS current, r.oid AS role, d.datistemplate AS template
       FROM pg_database d JOIN pg_roles r ON r.rolname = session_user
       WHERE d.datname = current_database()`,
    )
    if (
      binding.length !== 1 ||
      binding[0].name !== input.baseName ||
      binding[0].session !== input.expectedRole ||
      binding[0].current !== input.expectedRole ||
      binding[0].template
    )
      fail("IDENTITY_MISMATCH")
    phase = "lock"
    const lock = await query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [testDatabaseLockKey(input.databaseName)],
    )
    if (lock.length !== 1 || lock[0].locked !== true) fail("BUSY")
    const inspect = () =>
      query<DatabaseRow>(
        `SELECT oid, datname AS name, datdba AS owner, datistemplate AS template
         FROM pg_database WHERE datname = $1 OR oid = $2::oid`,
        [input.databaseName, input.acquiredOid],
      )
    const validate = (rows: DatabaseRow[]) => {
      if (rows.length === 0) return false
      if (
        rows.length !== 1 ||
        rows[0].name !== input.databaseName ||
        rows[0].oid !== input.acquiredOid
      )
        fail("IDENTITY_MISMATCH")
      if (rows[0].template) fail("UNSAFE_TARGET")
      if (rows[0].owner !== binding[0].role) fail("OWNERSHIP_MISMATCH")
      return true
    }
    phase = "inspect"
    if (!validate(await inspect())) {
      outcome = "already-absent"
    } else {
      if (!validate(await inspect())) fail("IDENTITY_MISMATCH")
      phase = "drop"
      remaining()
      if (!session.healthy) fail("DATABASE_FAILURE")
      outcome = "unknown"
      await query(`DROP DATABASE ${quoteIdentifier(input.databaseName)}`)
      phase = "verify"
      if ((await inspect()).length !== 0) fail("IDENTITY_MISMATCH")
      outcome = "removed"
    }
  } catch (error) {
    if (stopped) failures.push({ code: stopped, phase })
    else if (error instanceof TestDatabaseRecoveryError)
      failures.push(...error.failures)
    else failures.push({ code: "DATABASE_FAILURE", phase })
  } finally {
    clearTimeout(timer)
    // Cancellation during close still disposes immediately within the same close budget.
    try {
      if (stopped) session?.interrupt()
      await session?.close(input.closeTimeoutMs)
    } catch {
      failures.push({ code: "CLOSE_FAILED", phase: "close" })
    }
    input.signal?.removeEventListener("abort", abort)
  }
  if (failures.length) throw new TestDatabaseRecoveryError(failures, outcome)
  if (outcome !== "removed" && outcome !== "already-absent")
    throw new TestDatabaseRecoveryError(
      [{ code: "DATABASE_FAILURE", phase }],
      outcome,
    )
  return { status: outcome }
}
