import { performance } from "node:perf_hooks"
import type { TestDatabaseSession } from "../helpers/test-database-session"
import type { TestDatabaseRecoveryCode } from "../test-database-recovery-error"
import {
  boundedMessage,
  ChildMessage,
  ParentMessage,
  RecoveryInput,
  RecoveryObservation,
  shape,
} from "./test-database-recovery-protocol"

const controller = new AbortController()
let session: TestDatabaseSession | undefined
let started = false,
  finished = false,
  requested = false,
  permitted = false,
  reported = false
let received = 0,
  sent = 0
let workUntil = Date.now(),
  closeUntil = Date.now() + 1000,
  closeBudget = 1000
let workTimer: ReturnType<typeof setTimeout> | undefined
let fence: ReturnType<typeof setTimeout> | undefined
let permitResolve: (() => void) | undefined
let permitReject: (() => void) | undefined
let closeResolve: ((deadline: number) => void) | undefined
let gracefulUntil: number | undefined
let closing = false
let closeReceived = false
let resultSend: Promise<void> | undefined

function stop(reason: TestDatabaseRecoveryCode) {
  if (!controller.signal.aborted) controller.abort(reason)
  session?.interrupt()
  permitReject?.()
}
function emergency() {
  stop("DATABASE_FAILURE")
  clearTimeout(workTimer)
  // Only this dedicated child may dispose itself when its owning channel disappears.
  fence ??= setTimeout(
    () => process.kill(process.pid, "SIGKILL"),
    Math.max(0, Math.min(closeBudget / 2, closeUntil - Date.now())),
  )
}
function send(message: ChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (
      ++sent > 16 ||
      !boundedMessage(message) ||
      !process.connected ||
      !process.send
    ) {
      emergency()
      reject(new Error("Recovery channel failed"))
      return
    }
    const done = (error: Error | null) => {
      if (error) {
        emergency()
        reject(new Error("Recovery channel failed"))
      } else resolve()
    }
    try {
      process.send(message, done)
    } catch {
      done(new Error("Recovery channel failed"))
    }
  })
}
function validInput(value: unknown): value is RecoveryInput {
  if (typeof value !== "object" || !value) return false
  const keys = Object.keys(value)
  if (
    !keys.every((key) =>
      [
        "databaseUrl",
        "tls",
        "baseName",
        "expectedRole",
        "databaseName",
        "acquiredOid",
        "timeoutMs",
        "closeTimeoutMs",
      ].includes(key),
    )
  )
    return false
  const input = value as RecoveryInput
  return (
    typeof input.databaseUrl === "string" &&
    typeof input.baseName === "string" &&
    typeof input.expectedRole === "string" &&
    typeof input.databaseName === "string" &&
    Number.isInteger(input.acquiredOid) &&
    input.acquiredOid > 0 &&
    input.acquiredOid <= 0xffffffff &&
    Number.isInteger(input.timeoutMs) &&
    input.timeoutMs > 0 &&
    input.timeoutMs <= 300_000 &&
    Number.isInteger(input.closeTimeoutMs) &&
    input.closeTimeoutMs > 0 &&
    input.closeTimeoutMs <= 30_000
  )
}
function parentMessage(raw: unknown): raw is ParentMessage {
  if (typeof raw !== "object" || !raw) return false
  const value = raw as Record<string, unknown>
  if (value.version !== 1 || typeof value.type !== "string") return false
  if (value.type === "start")
    return (
      shape(value, ["version", "type", "input", "workUntil", "closeUntil"]) &&
      validInput(value.input) &&
      Number.isFinite(value.workUntil) &&
      Number.isFinite(value.closeUntil)
    )
  if (value.type === "permit-drop")
    return shape(value, ["version", "type", "sequence"]) && value.sequence === 1
  if (value.type === "finish") return shape(value, ["version", "type"])
  if (value.type === "close" || value.type === "cancel")
    return (
      shape(
        value,
        value.type === "close"
          ? ["version", "type", "gracefulUntil", "closeUntil"]
          : ["version", "type", "reason", "gracefulUntil", "closeUntil"],
      ) &&
      Number.isFinite(value.gracefulUntil) &&
      Number.isFinite(value.closeUntil) &&
      (value.type === "close" ||
        ["CANCELLED", "DEADLINE_EXCEEDED", "DATABASE_FAILURE"].includes(
          value.reason as string,
        ))
    )
  return false
}
async function finishWork(observation: RecoveryObservation) {
  if (closing) return
  closing = true
  clearTimeout(workTimer)
  const allocation = new Promise<number>((resolve) => {
    closeResolve = resolve
    if (gracefulUntil !== undefined) resolve(gracefulUntil)
  })
  await send({ version: 1, type: "closing", ...observation })
  const until = await allocation
  try {
    await session?.close(Math.max(0, until - Date.now()))
  } catch {
    observation.failures.push({ code: "CLOSE_FAILED", phase: "close" })
  }
  reported = true
  resultSend = send({ version: 1, type: "result", ...observation })
  await resultSend
}
async function run(input: RecoveryInput, remaining: number) {
  const { executeRecovery } = await import("./test-database-recovery-engine")
  const observation = await executeRecovery(
    input,
    controller.signal,
    performance.now() +
      Math.max(0, Math.min(remaining, workUntil - Date.now())),
    (phase) => {
      void send({ version: 1, type: "phase", phase }).catch(() =>
        stop("DATABASE_FAILURE"),
      )
    },
    () =>
      new Promise<void>((resolve, reject) => {
        if (controller.signal.aborted || Date.now() >= workUntil) {
          reject(new Error("Recovery stopped"))
          return
        }
        requested = true
        permitResolve = resolve
        permitReject = () => reject(new Error("Recovery stopped"))
        void send({ version: 1, type: "request-drop", sequence: 1 }).catch(() =>
          reject(new Error("Recovery channel failed")),
        )
      }),
    (created) => {
      session = created
      if (controller.signal.aborted) created.interrupt()
    },
  )
  await finishWork({
    outcome: observation.outcome,
    failures: observation.failures,
  })
}
function onMessage(value: unknown) {
  if (++received > 16 || !boundedMessage(value) || !parentMessage(value)) {
    emergency()
    return
  }
  if (value.type === "start") {
    if (started || closing || finished) {
      emergency()
      return
    }
    started = true
    closeBudget = value.input.closeTimeoutMs
    workUntil = Math.min(value.workUntil, Date.now() + value.input.timeoutMs)
    closeUntil = Math.min(value.closeUntil, workUntil + closeBudget)
    const remaining = workUntil - Date.now()
    if (remaining <= 0) stop("DEADLINE_EXCEEDED")
    workTimer = setTimeout(
      () => stop("DEADLINE_EXCEEDED"),
      Math.max(0, remaining),
    )
    void run(value.input, remaining).catch(() => emergency())
  } else if (value.type === "permit-drop") {
    if (
      !requested ||
      permitted ||
      closing ||
      controller.signal.aborted ||
      Date.now() >= workUntil
    ) {
      if (!controller.signal.aborted) emergency()
      return
    }
    permitted = true
    permitResolve?.()
  } else if (value.type === "finish") {
    if (!reported || finished) {
      emergency()
      return
    }
    finished = true
    clearTimeout(workTimer)
    clearTimeout(fence)
    process.removeListener("message", onMessage)
    void resultSend
      ?.then(() => {
        if (process.connected) process.disconnect()
      })
      .catch(() => emergency())
  } else {
    if (value.type === "close" && (!closing || closeReceived)) {
      emergency()
      return
    }
    if (value.type === "close") closeReceived = true
    if (value.type === "cancel") stop(value.reason)
    closeUntil = Math.min(closeUntil, value.closeUntil)
    gracefulUntil = Math.min(
      gracefulUntil ?? Infinity,
      value.gracefulUntil,
      closeUntil,
    )
    closeResolve?.(gracefulUntil)
    if (!started && !closing)
      void finishWork({ outcome: "not-attempted", failures: [] }).catch(() =>
        emergency(),
      )
  }
}
process.on("disconnect", () => {
  if (!finished) emergency()
})
process.on("message", onMessage)
process.on("uncaughtException", emergency)
process.on("unhandledRejection", emergency)
if (!process.connected) emergency()
else void send({ version: 1, type: "ready" }).catch(() => emergency())
