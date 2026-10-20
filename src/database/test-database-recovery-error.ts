export type TestDatabaseRecoveryCode =
  | "INVALID_INPUT"
  | "UNSAFE_TARGET"
  | "IDENTITY_MISMATCH"
  | "OWNERSHIP_MISMATCH"
  | "BUSY"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "DATABASE_FAILURE"
  | "CLOSE_FAILED"

export type TestDatabaseRecoveryPhase =
  | "validate"
  | "connect"
  | "lock"
  | "inspect"
  | "drop"
  | "verify"
  | "close"

export type TestDatabaseRecoveryOutcome =
  | "not-attempted"
  | "unknown"
  | "removed"
  | "already-absent"

export interface TestDatabaseRecoveryFailure {
  readonly code: TestDatabaseRecoveryCode
  readonly phase: TestDatabaseRecoveryPhase
}

export class TestDatabaseRecoveryError extends Error {
  readonly code: TestDatabaseRecoveryCode
  readonly phase: TestDatabaseRecoveryPhase
  readonly outcome: TestDatabaseRecoveryOutcome
  readonly failures: readonly TestDatabaseRecoveryFailure[]

  constructor(
    failures: readonly TestDatabaseRecoveryFailure[],
    outcome: TestDatabaseRecoveryOutcome = "not-attempted",
  ) {
    super("Test database recovery failed")
    this.name = "TestDatabaseRecoveryError"
    this.failures = Object.freeze(
      failures.map(({ code, phase }) => Object.freeze({ code, phase })),
    )
    this.code = this.failures[0].code
    this.phase = this.failures[0].phase
    this.outcome = outcome
  }
}
