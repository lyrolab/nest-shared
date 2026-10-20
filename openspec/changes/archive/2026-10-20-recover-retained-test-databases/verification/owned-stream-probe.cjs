const assert = require("node:assert/strict")
const { spawn, execFileSync } = require("node:child_process")
const { once } = require("node:events")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const tls = require("node:tls")
const { performance } = require("node:perf_hooks")
const { Client } = require("pg")
const scenarios = require("./transport-scenarios.json")

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
  const ownedSocket = new net.Socket()
  const socketClosed = new Promise((resolve) =>
    ownedSocket.once("close", resolve),
  )
  let clientEnded = false
  let stopping = false
  let forced = false
  let closeFailed = false
  let factoryCalls = 0
  let unhandled = 0
  const onError = () => {}
  const onUnhandled = () => unhandled++
  process.on("unhandledRejection", onUnhandled)
  ownedSocket.on("error", onError)
  const client = new Client({
    host: scenario.ip ? "127.0.0.1" : "localhost",
    port,
    user: "probe",
    database: "probe",
    password: "",
    ssl: scenario.tls
      ? {
          rejectUnauthorized: true,
          ...(scenario.untrusted
            ? {}
            : { ca: fs.readFileSync(path.join(certificateDir, "cert.pem")) }),
        }
      : false,
    sslnegotiation: "postgres",
    stream: () => {
      factoryCalls++
      return ownedSocket
    },
    connectionTimeoutMillis: 4000,
    query_timeout: 4000,
  })
  client.on("error", onError)
  const ended = new Promise((resolve) => {
    client.once("end", () => {
      clientEnded = true
      resolve()
    })
  })
  let notifyPhase
  const atPhase = new Promise((resolve) => (notifyPhase = resolve))
  process.on("message", (message) => {
    if (message === "phase") notifyPhase()
  })
  let dispatches = 0
  const connecting = settled(
    client.connect().then(() => {
      if (!stopping && scenario.phase === "active") {
        dispatches++
        return client.query("SELECT 1")
      }
    }),
  )
  // The fixture confirms the stalled phase before interruption/close starts.
  await within(atPhase, 4000, "Fixture phase not reached")
  let workTimer
  if (scenario.interrupt) {
    await new Promise((resolve) => {
      workTimer = setTimeout(resolve, workMs)
    })
  } else if (scenario.phase !== "active") {
    await within(connecting, 4000, "Connection did not settle")
  }
  stopping = true
  const closeStarted = performance.now()
  if (scenario.interrupt) ownedSocket.destroy(new Error("Probe interrupted"))
  const closing = settled(client.end())
  let fallback
  if (scenario.phase === "certificate") {
    ownedSocket.destroy()
  } else if (!scenario.interrupt) {
    fallback = setTimeout(() => {
      forced = true
      closeFailed = true
      ownedSocket.destroy()
    }, gracefulMs)
  }
  try {
    await within(
      Promise.all([socketClosed, ended, closing, connecting]),
      closeBudgetMs,
      "Transport disposal exceeded budget",
    )
  } finally {
    clearTimeout(fallback)
    clearTimeout(workTimer)
  }
  const closeMs = Math.ceil(performance.now() - closeStarted)
  const connection = await connecting
  const close = await closing
  assert.equal(factoryCalls, 1)
  assert.equal(clientEnded, true)
  assert.equal(close.ok, true)
  assert.equal(dispatches, scenario.phase === "active" ? 1 : 0)
  if (scenario.interrupt || scenario.phase === "certificate") {
    assert.equal(connection.ok, false)
  }
  if (scenario.untrusted)
    assert.equal(connection.code, "DEPTH_ZERO_SELF_SIGNED_CERT")
  if (scenario.mismatch)
    assert.equal(connection.code, "ERR_TLS_CERT_ALTNAME_INVALID")
  if (scenario.forced) assert.equal(forced, true)
  assert.equal(closeFailed, forced)
  assert.equal(unhandled, 0)
  client.removeListener("error", onError)
  ownedSocket.removeListener("error", onError)
  process.removeListener("unhandledRejection", onUnhandled)
  // A successful child must exit through the ordinary event loop, without IPC.
  process.disconnect()
  console.log(
    JSON.stringify({
      closed: true,
      clientEnded,
      operationsSettled: true,
      forced,
      closeFailed,
      closeMs,
      dispatches,
      unhandled,
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
  const phase = () => {
    if (!phaseSent && childProcess.connected) {
      phaseSent = true
      childProcess.send("phase")
    }
  }
  function track(socket) {
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
    assert.equal(code, 0, `Failed child: ${scenario.name}`)
    assert.equal(signal, null)
    assert.equal(stderr, "")
    const report = JSON.parse(output.trim())
    assert.equal(report.closed, true)
    assert.equal(report.clientEnded, true)
    assert.ok(report.closeMs < closeBudgetMs)
    assert.equal(queries, scenario.phase === "active" ? 1 : 0)
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
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR
  assert.ok(scratch, "Set a run-owned scratch directory")
  const directory = fs.mkdtempSync(path.join(scratch, "owned-stream-"))
  try {
    for (const mismatch of [false, true]) {
      const certDir = path.join(directory, mismatch ? "mismatch" : "valid")
      fs.mkdirSync(certDir, { mode: 0o700 })
      certificate(certDir, mismatch)
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
      await probe(
        scenario,
        path.join(directory, scenario.mismatch ? "mismatch" : "valid"),
      )
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(() => {
  if (process.connected) process.disconnect()
  console.error("Owned transport probe failed")
  process.exitCode = 1
})
