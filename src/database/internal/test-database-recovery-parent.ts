import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { captureRecoveryInput } from "../helpers/test-database-recovery-input"
import type { TestDatabaseRecoveryResult } from "../recover-test-database"
import {
  TestDatabaseRecoveryError,
  TestDatabaseRecoveryCode,
  TestDatabaseRecoveryFailure,
  TestDatabaseRecoveryOutcome,
  TestDatabaseRecoveryPhase,
} from "../test-database-recovery-error"
import {
  boundedMessage,
  childMessage,
  ParentMessage,
  RecoveryObservation,
  workPhases,
} from "./test-database-recovery-protocol"

export async function superviseRecovery(
  captured: ReturnType<typeof captureRecoveryInput>,
  started: number,
): Promise<TestDatabaseRecoveryResult> {
  const { signal, ...input } = captured
  const workDeadline = started + input.timeoutMs
  const initialFailure = signal?.aborted
    ? "CANCELLED"
    : performance.now() >= workDeadline
      ? "DEADLINE_EXCEEDED"
      : process.platform !== "linux"
        ? "DATABASE_FAILURE"
        : undefined
  if (initialFailure)
    throw new TestDatabaseRecoveryError([
      { code: initialFailure, phase: "connect" },
    ])
  let child: ChildProcess
  try {
    child = spawn(
      process.execPath,
      [join(__dirname, "test-database-recovery-child.js")],
      {
        env: {},
        shell: false,
        detached: false,
        serialization: "json",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    )
  } catch {
    throw new TestDatabaseRecoveryError([
      { code: "DATABASE_FAILURE", phase: "connect" },
    ])
  }
  let phase: TestDatabaseRecoveryPhase = "connect"
  const state = { outcome: "not-attempted" as TestDatabaseRecoveryOutcome }
  const failures: TestDatabaseRecoveryFailure[] = []
  let ready = false,
    requested = false,
    permitted = false,
    closing = false,
    terminal = false
  let childClosing: RecoveryObservation | undefined
  let phaseIndex = 0,
    received = 0,
    sent = 0,
    pendingSends = 0
  let exited = false,
    disconnected = false,
    spawnFailed = false,
    aggregateClosed = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let finalTimer: ReturnType<typeof setTimeout> | undefined
  let closeDeadline = 0,
    gracefulDeadline = 0
  let resolveDisposed!: () => void
  const disposed = new Promise<void>((resolve) => {
    resolveDisposed = resolve
  })
  const checkDisposed = () => {
    if (
      ((exited && disconnected) || (spawnFailed && aggregateClosed)) &&
      pendingSends === 0
    )
      resolveDisposed()
  }
  const add = (code: TestDatabaseRecoveryCode, at = phase) => {
    if (!failures.some((failure) => failure.code === code))
      failures.push({ code, phase: at })
  }
  const send = (message: ParentMessage) => {
    if (++sent > 16 || !boundedMessage(message) || !child.connected) {
      stop("DATABASE_FAILURE")
      return
    }
    pendingSends++
    const settled = (error: Error | null) => {
      pendingSends--
      if (error) stop("DATABASE_FAILURE")
      checkDisposed()
    }
    try {
      child.send(message, settled)
    } catch {
      settled(new Error("Recovery channel failed"))
    }
  }
  const ceilings = () => ({
    gracefulUntil:
      Date.now() + Math.max(0, gracefulDeadline - performance.now()),
    closeUntil: Date.now() + Math.max(0, closeDeadline - performance.now()),
  })
  const force = () => {
    if (exited || spawnFailed) return
    add("CLOSE_FAILED", "close")
    try {
      child.kill("SIGKILL")
    } catch {
      add("CLOSE_FAILED", "close")
    }
  }
  const beginClose = () => {
    if (closing) return
    closing = true
    clearTimeout(workTimer)
    closeDeadline = Math.min(
      performance.now() + input.closeTimeoutMs,
      workDeadline + input.closeTimeoutMs,
    )
    gracefulDeadline =
      performance.now() + Math.max(0, closeDeadline - performance.now()) / 2
    forceTimer = setTimeout(
      force,
      Math.max(0, gracefulDeadline - performance.now()),
    )
    // Keep joining after a missed bound: a timer cannot prove that an owned child died.
    finalTimer = setTimeout(
      () => {
        add("CLOSE_FAILED", "close")
        force()
      },
      Math.max(0, closeDeadline - performance.now()),
    )
  }
  const stop = (
    code: "CANCELLED" | "DEADLINE_EXCEEDED" | "DATABASE_FAILURE",
  ) => {
    const first = failures.length === 0
    add(code)
    const alreadyClosing = closing
    beginClose()
    if ((first || !alreadyClosing) && child.connected && sent < 16)
      send({ version: 1, type: "cancel", reason: code, ...ceilings() })
  }
  const abort = () => stop("CANCELLED")
  const workTimer = setTimeout(
    () => stop("DEADLINE_EXCEEDED"),
    Math.max(0, workDeadline - performance.now()),
  )
  const accept = (observation: RecoveryObservation) => {
    if (
      (observation.outcome === "removed" &&
        (!permitted || phase !== "verify")) ||
      (observation.outcome === "already-absent" &&
        (permitted || phase !== "inspect")) ||
      (observation.outcome === "unknown" && !permitted)
    )
      return false
    if (
      observation.outcome === "removed" ||
      observation.outcome === "already-absent"
    )
      state.outcome = observation.outcome
    for (const failure of observation.failures) add(failure.code, failure.phase)
    return true
  }
  const onMessage = (message: unknown) => {
    if (++received > 16 || !boundedMessage(message) || !childMessage(message)) {
      stop("DATABASE_FAILURE")
      return
    }
    if (message.type === "ready") {
      if (ready || terminal || closing) {
        if (!closing) stop("DATABASE_FAILURE")
        return
      }
      ready = true
      if (signal?.aborted || performance.now() >= workDeadline) {
        stop(signal?.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED")
        return
      }
      send({
        version: 1,
        type: "start",
        input,
        workUntil: Date.now() + Math.max(0, workDeadline - performance.now()),
        closeUntil:
          Date.now() +
          Math.max(0, workDeadline + input.closeTimeoutMs - performance.now()),
      })
    } else if (message.type === "phase") {
      if (
        !ready ||
        phaseIndex + 1 >= workPhases.length ||
        message.phase !== workPhases[phaseIndex + 1] ||
        (message.phase === "verify" && !permitted)
      ) {
        stop("DATABASE_FAILURE")
        return
      }
      phase = message.phase
      phaseIndex++
    } else if (message.type === "request-drop") {
      if (requested || terminal || !ready || phase !== "drop") {
        stop("DATABASE_FAILURE")
        return
      }
      requested = true
      if (closing || signal?.aborted || performance.now() >= workDeadline) {
        if (!closing) stop(signal?.aborted ? "CANCELLED" : "DEADLINE_EXCEEDED")
        return
      }
      permitted = true
      state.outcome = "unknown"
      send({ version: 1, type: "permit-drop", sequence: 1 })
    } else if (message.type === "closing") {
      if (childClosing || terminal || !accept(message)) {
        stop("DATABASE_FAILURE")
        return
      }
      childClosing = message
      beginClose()
      if (child.connected) send({ version: 1, type: "close", ...ceilings() })
    } else {
      if (
        !childClosing ||
        terminal ||
        !accept(message) ||
        message.outcome !== childClosing.outcome ||
        JSON.stringify(
          message.failures.filter((failure) => failure.code !== "CLOSE_FAILED"),
        ) !==
          JSON.stringify(
            childClosing.failures.filter(
              (failure) => failure.code !== "CLOSE_FAILED",
            ),
          )
      ) {
        stop("DATABASE_FAILURE")
        return
      }
      terminal = true
      beginClose()
      if (child.connected) send({ version: 1, type: "finish" })
    }
  }
  const onError = () => {
    if (!child.pid) spawnFailed = true
    stop("DATABASE_FAILURE")
    checkDisposed()
  }
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    exited = true
    if (!terminal || code !== 0 || exitSignal !== null) {
      if (!failures.length && !childClosing) add("DATABASE_FAILURE")
      if (closing || terminal) add("CLOSE_FAILED", "close")
    }
    beginClose()
    checkDisposed()
  }
  const onDisconnect = () => {
    disconnected = true
    if (!terminal) {
      if (closing) add("CLOSE_FAILED", "close")
      else stop("DATABASE_FAILURE")
    }
    checkDisposed()
  }
  const onClose = () => {
    aggregateClosed = true
    checkDisposed()
  }
  child.on("message", onMessage)
  child.on("error", onError)
  child.on("exit", onExit)
  child.on("disconnect", onDisconnect)
  child.on("close", onClose)
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  await disposed
  clearTimeout(workTimer)
  clearTimeout(forceTimer)
  clearTimeout(finalTimer)
  signal?.removeEventListener("abort", abort)
  child.removeListener("message", onMessage)
  child.removeListener("error", onError)
  child.removeListener("exit", onExit)
  child.removeListener("disconnect", onDisconnect)
  child.removeListener("close", onClose)
  if (failures.length) {
    const ordered = [
      ...failures.filter((failure) => failure.code !== "CLOSE_FAILED"),
      ...failures.filter((failure) => failure.code === "CLOSE_FAILED"),
    ]
    throw new TestDatabaseRecoveryError(ordered, state.outcome)
  }
  if (
    !terminal ||
    (state.outcome !== "removed" && state.outcome !== "already-absent")
  )
    throw new TestDatabaseRecoveryError(
      [{ code: "DATABASE_FAILURE", phase }],
      state.outcome,
    )
  return { status: state.outcome }
}
