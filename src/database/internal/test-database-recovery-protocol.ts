import type { captureRecoveryInput } from "../helpers/test-database-recovery-input"
import type {
  TestDatabaseRecoveryFailure,
  TestDatabaseRecoveryOutcome,
  TestDatabaseRecoveryPhase,
} from "../test-database-recovery-error"

export type RecoveryInput = Omit<
  ReturnType<typeof captureRecoveryInput>,
  "signal"
>
export interface RecoveryObservation {
  outcome: TestDatabaseRecoveryOutcome
  failures: TestDatabaseRecoveryFailure[]
}
export type ParentMessage =
  | {
      version: 1
      type: "start"
      input: RecoveryInput
      workUntil: number
      closeUntil: number
    }
  | { version: 1; type: "permit-drop"; sequence: 1 }
  | {
      version: 1
      type: "cancel"
      reason: "CANCELLED" | "DEADLINE_EXCEEDED" | "DATABASE_FAILURE"
      gracefulUntil: number
      closeUntil: number
    }
  | { version: 1; type: "close"; gracefulUntil: number; closeUntil: number }
  | { version: 1; type: "finish" }
export type ChildMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "phase"; phase: TestDatabaseRecoveryPhase }
  | { version: 1; type: "request-drop"; sequence: 1 }
  | ({ version: 1; type: "closing" | "result" } & RecoveryObservation)

export const workPhases = [
  "connect",
  "lock",
  "inspect",
  "drop",
  "verify",
] as const
const codes = [
  "INVALID_INPUT",
  "UNSAFE_TARGET",
  "IDENTITY_MISMATCH",
  "OWNERSHIP_MISMATCH",
  "BUSY",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "DATABASE_FAILURE",
  "CLOSE_FAILED",
]
export function shape(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  )
}
export function childMessage(value: unknown): value is ChildMessage {
  if (
    typeof value !== "object" ||
    !value ||
    !("version" in value) ||
    value.version !== 1 ||
    !("type" in value)
  )
    return false
  switch (value.type) {
    case "ready":
      return shape(value, ["version", "type"])
    case "phase":
      return (
        shape(value, ["version", "type", "phase"]) &&
        workPhases.some((phase) => phase === value.phase)
      )
    case "request-drop":
      return (
        shape(value, ["version", "type", "sequence"]) && value.sequence === 1
      )
    case "closing":
    case "result":
      return observation(value)
    default:
      return false
  }
}
export function boundedMessage(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 4 * 1024 * 1024
  } catch {
    return false
  }
}

function observation(value: unknown): boolean {
  if (!shape(value, ["version", "type", "outcome", "failures"])) return false
  const failures: unknown = value.failures
  return (
    ["not-attempted", "unknown", "removed", "already-absent"].includes(
      value.outcome as string,
    ) &&
    Array.isArray(failures) &&
    failures.length <= 3 &&
    failures.every(
      (entry: unknown) =>
        shape(entry, ["code", "phase"]) &&
        codes.includes(entry.code as string) &&
        ["validate", ...workPhases, "close"].includes(entry.phase as string) &&
        (entry.code === "CLOSE_FAILED"
          ? entry.phase === "close"
          : entry.phase !== "close"),
    )
  )
}
