const assert = require("node:assert/strict")
const { spawn, execFileSync } = require("node:child_process")
const { once } = require("node:events")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const tls = require("node:tls")
const { performance } = require("node:perf_hooks")
const {
  TestDatabaseSession,
} = require("../../../dist/database/helpers/test-database-session")
const scenarios = require("./transport-scenarios.json")
let activeScenario = process.argv[3] ?? "initialization"

function diagnostic(error) {
  const scalar = (value) =>
    typeof value === "boolean" ||
    typeof value === "number" ||
    ["DATABASE_FAILURE", "CANCELLED", "DEADLINE_EXCEEDED"].includes(value)
      ? value
      : undefined
  return {
    scenario: activeScenario,
    line: Number(
      error.line ?? error.stack?.match(/transport-runner\.cjs:(\d+)/)?.[1],
    ),
    actual: scalar(error.actual),
    expected: scalar(error.expected),
  }
}

const closeBudgetMs = 1000
const gracefulMs = Math.floor(closeBudgetMs / 2)
const workMs = 100
const ready = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])

async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function settled(promise) {
  return promise.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, code: error.code }),
  )
}

async function child(scenario, port, certificateDir) {
  if (scenario.phase === "configuration")
    return configurationChild(scenario, port, certificateDir)
  const host = scenario.ip ? "127.0.0.1" : "localhost"
  const url = new URL(`postgres://probe:probe@${host}:${port}/probe`)
  if (scenario.tls) {
    url.searchParams.set("sslmode", "verify-full")
    if (!scenario.untrusted)
      url.searchParams.set("sslrootcert", path.join(certificateDir, "cert.pem"))
  }
  const session = await TestDatabaseSession.create(url.toString())
  let dispatches = 0
  let unhandled = 0
  let primaryFailed = false
  const onUnhandled = () => unhandled++
  process.on("unhandledRejection", onUnhandled)
  let notifyPhase
  const atPhase = new Promise((resolve) => (notifyPhase = resolve))
  process.on("message", (message) => {
    if (message === "phase") notifyPhase()
  })
  const connecting = session
    .connect(4000)
    .then(() => {
      if (scenario.phase === "active" && session.healthy) {
        dispatches++
        return session.query("SELECT 1", [], "inspect", 4000)
      }
    })
    .catch((error) => {
      assert.equal(error.code, "DATABASE_FAILURE")
      primaryFailed = true
    })
  await within(atPhase, 4000, "Fixture phase not reached")
  if (scenario.interrupt)
    await new Promise((resolve) => setTimeout(resolve, workMs))
  else if (scenario.phase !== "active")
    await within(connecting, 4000, "Connection did not settle")
  const closeStarted = performance.now()
  if (scenario.interrupt) session.interrupt()
  let closeFailed = false
  try {
    await session.close(closeBudgetMs)
  } catch (error) {
    assert.equal(error.code, "CLOSE_FAILED")
    closeFailed = true
  }
  await within(connecting, closeBudgetMs, "Started work did not settle")
  const closeMs = Math.ceil(performance.now() - closeStarted)
  assert.equal(session.healthy, false)
  await assert.rejects(session.query("SELECT 2", [], "inspect", 100), {
    code: "DATABASE_FAILURE",
  })
  if (scenario.interrupt || scenario.phase === "certificate")
    assert.equal(primaryFailed, true)
  assert.equal(closeFailed, Boolean(scenario.forced))
  assert.equal(unhandled, 0)
  process.removeListener("unhandledRejection", onUnhandled)
  process.disconnect()
  console.log(
    JSON.stringify({
      closed: true,
      closeMs,
      closeFailed,
      dispatches,
      unhandled,
    }),
  )
}

async function configurationChild(scenario, port, certificateDir) {
  const { ConfigService } = require("@nestjs/config")
  const { Client } = require("pg")
  const {
    SharedDatabaseModule: Database,
    recoverTestDatabase,
  } = require("@lyrolab/nest-shared/database")
  const controller = new AbortController()
  let connects = 0
  let queries = 0
  let opened = 0
  let closed = 0
  let reads = 0
  let settledReads = 0
  let abortTimer
  const originalConnect = Client.prototype.connect
  const originalQuery = Client.prototype.query
  Client.prototype.connect = function (...args) {
    connects++
    return originalConnect.apply(this, args)
  }
  Client.prototype.query = function (...args) {
    queries++
    return originalQuery.apply(this, args)
  }
  const files = require("node:fs/promises")
  const originalOpen = files.open
  const originalRead = files.readFile
  files.open = async (...args) => {
    const file = await originalOpen(...args)
    opened++
    const originalClose = file.close.bind(file)
    file.close = async () => {
      await originalClose()
      closed++
    }
    return file
  }
  if (scenario.file === "regular") {
    files.readFile = async (file, { signal }) => {
      reads++
      if (scenario.mode === "cancel")
        abortTimer = setTimeout(() => controller.abort(), 20)
      try {
        // Hold this public file operation until interruption reaches it.
        if (!signal.aborted)
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          )
        return await originalRead(file, { signal })
      } finally {
        settledReads++
      }
    }
  }
  const url = new URL(`postgres://probe:probe@127.0.0.1:${port}/probe`)
  url.searchParams.set("sslmode", "verify-full")
  const filename =
    scenario.file === "fifo"
      ? path.join(certificateDir, "input.fifo")
      : scenario.file === "directory"
        ? certificateDir
        : scenario.file === "device"
          ? "/dev/null"
          : path.join(certificateDir, "cert.pem")
  url.searchParams.set(scenario.key, filename)
  const config = new ConfigService({ DATABASE_URL: url.toString() })
  const database = Database.getTestDatabaseInfo(config)
  const started = performance.now()
  let failure
  if (scenario.mode === "cancel" && scenario.file !== "regular")
    abortTimer = setTimeout(() => controller.abort(), 20)
  try {
    await recoverTestDatabase({
      base: { databaseUrl: url.toString(), expectedRole: "probe" },
      database,
      acquiredOid: 42,
      exclusiveTarget: true,
      timeoutMs: scenario.mode === "deadline" ? 40 : 500,
      closeTimeoutMs: 40,
      signal: controller.signal,
    })
    assert.fail("Configuration must refuse before connecting")
  } catch (error) {
    failure = error.code
    assert.equal(error.outcome, "not-attempted")
    assert.equal(error.phase, "connect")
  } finally {
    clearTimeout(abortTimer)
  }
  const elapsedMs = Math.ceil(performance.now() - started)
  const stopped = scenario.mode === "cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED"
  if (scenario.file === "regular") assert.equal(failure, stopped)
  else if (scenario.mode === "refusal")
    assert.equal(failure, "DATABASE_FAILURE")
  else assert.ok(["DATABASE_FAILURE", stopped].includes(failure))
  assert.ok(elapsedMs < 250)
  if (failure === "DATABASE_FAILURE" || scenario.file === "regular")
    assert.equal(opened, 1)
  assert.equal(closed, opened)
  assert.equal(reads, scenario.file === "regular" ? 1 : 0)
  assert.equal(settledReads, reads)
  // Wait beyond the work budget to catch any resumed dispatch after return.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(connects, 0)
  assert.equal(queries, 0)
  process.disconnect()
  console.log(
    JSON.stringify({
      closed: true,
      closeMs: elapsedMs,
      failure,
      opened,
      settledReads,
      dispatches: connects + queries,
      unhandled: 0,
    }),
  )
}

async function probe(scenario, certificateDir) {
  const peers = new Set()
  const timers = new Set()
  let childProcess
  let queries = 0
  let secure = false
  let phaseSent = false
  let connections = 0
  const phase = () => {
    if (!phaseSent && childProcess.connected) {
      phaseSent = true
      childProcess.send("phase")
    }
  }
  function track(socket) {
    connections++
    peers.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => peers.delete(socket))
    return socket
  }
  function protocol(socket) {
    let startup = true
    let pending = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= (startup ? 4 : 5)) {
        const size = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
        if (pending.length < size) return
        const packet = pending.subarray(0, size)
        pending = pending.subarray(size)
        if (startup) {
          startup = false
          if (scenario.phase === "startup") {
            phase()
            // A late ReadyForQuery must never resume work after interruption.
            const timer = setTimeout(() => {
              timers.delete(timer)
              if (!socket.destroyed && socket.writable) socket.write(ready)
            }, 350)
            timers.add(timer)
          } else {
            socket.write(ready)
            if (scenario.phase === "idle") phase()
          }
        } else if (packet[0] === 81) {
          queries++
          phase()
        }
      }
    })
  }
  const context = scenario.tls
    ? tls.createSecureContext({
        key: fs.readFileSync(path.join(certificateDir, "key.pem")),
        cert: fs.readFileSync(path.join(certificateDir, "cert.pem")),
      })
    : undefined
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    track(raw)
    if (!scenario.tls) return protocol(raw)
    raw.once("data", (request) => {
      assert.equal(request.length, 8)
      assert.equal(request.readInt32BE(4), 80877103)
      raw.write("S")
      if (scenario.phase === "handshake") {
        raw.on("data", () => {})
        phase()
        return
      }
      const encrypted = track(
        new tls.TLSSocket(raw, {
          isServer: true,
          secureContext: context,
          allowHalfOpen: true,
        }),
      )
      encrypted.on("secure", () => {
        secure = true
      })
      if (scenario.phase === "certificate") {
        phase()
      } else {
        protocol(encrypted)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  childProcess = spawn(
    process.execPath,
    [
      __filename,
      "--child",
      scenario.name,
      String(server.address().port),
      certificateDir,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  )
  const exited = once(childProcess, "exit")
  let output = ""
  let stderr = ""
  childProcess.stdout.on("data", (chunk) => (output += chunk.toString()))
  childProcess.stderr.on("data", (chunk) => (stderr += chunk.toString()))
  try {
    const [code, signal] = await within(
      exited,
      6000,
      "Child failed natural exit",
    )
    if (code !== 0) {
      try {
        const childFailure = JSON.parse(stderr.trim())
        const error = new Error("Fixture child failed")
        error.actual = childFailure.actual
        error.expected = childFailure.expected
        error.line = childFailure.line
        throw error
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    assert.equal(code, 0, `Failed child: ${scenario.name}`)
    assert.equal(signal, null)
    assert.equal(stderr, "")
    const report = JSON.parse(output.trim())
    assert.equal(report.closed, true)
    assert.ok(report.closeMs < closeBudgetMs)
    assert.equal(queries, scenario.phase === "active" ? 1 : 0)
    if (scenario.phase === "configuration") assert.equal(connections, 0)
    if (
      scenario.tls &&
      ["idle", "active", "startup"].includes(scenario.phase)
    ) {
      assert.equal(secure, true)
    }
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        ...report,
        tlsEstablished: secure,
        queries,
        naturalExitBeforeFixtureCleanup: true,
        exitCode: code,
      }),
    )
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const peer of peers) peer.destroy()
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill()
      await within(exited, 1000, "Child cleanup failed")
    }
    await within(
      new Promise((resolve) => server.close(resolve)),
      1000,
      "Fixture cleanup failed",
    )
  }
}

function certificate(directory, mismatch) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      mismatch
        ? "subjectAltName=DNS:wrong.invalid"
        : "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  )
}

async function main() {
  if (process.argv[2] === "--child") {
    const scenario = scenarios.find((item) => item.name === process.argv[3])
    assert.ok(scenario)
    await child(scenario, Number(process.argv[4]), process.argv[5])
    return
  }
  const scratch = require("node:os").tmpdir()
  const directory = fs.mkdtempSync(path.join(scratch, "owned-stream-"))
  try {
    for (const mismatch of [false, true]) {
      const certDir = path.join(directory, mismatch ? "mismatch" : "valid")
      fs.mkdirSync(certDir, { mode: 0o700 })
      certificate(certDir, mismatch)
      execFileSync("mkfifo", [path.join(certDir, "input.fifo")])
    }
    console.log(
      JSON.stringify({
        driver: require("pg/package.json").version,
        node: process.version,
        closeBudgetMs,
        gracefulMs,
        workMs,
      }),
    )
    for (const scenario of scenarios) {
      activeScenario = scenario.name
      await probe(
        scenario,
        path.join(directory, scenario.mismatch ? "mismatch" : "valid"),
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  if (process.connected) process.disconnect()
  console.error(JSON.stringify(diagnostic(error)))
  process.exitCode = 1
})
