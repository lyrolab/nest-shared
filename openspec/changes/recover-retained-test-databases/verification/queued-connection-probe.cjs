const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { once } = require("node:events")
const net = require("node:net")
const path = require("node:path")
const scenarios = require("./queued-connection-scenarios.json")
const workMs = 100,
  closeMs = 100
function auth(code, text) {
  const body = Buffer.from(text)
  const header = Buffer.alloc(9)
  header[0] = 82
  header.writeInt32BE(8 + body.length, 1)
  header.writeInt32BE(code, 5)
  return Buffer.concat([header, body])
}
async function child() {
  const crypto = require("node:crypto")
  const dns = require("node:dns")
  const { performance } = require("node:perf_hooks")
  const projectRequire = require("node:module").createRequire(
    path.join(process.cwd(), "package.json"),
  )
  const { ConfigService } = projectRequire("@nestjs/config")
  const { SharedDatabaseModule: Database, recoverTestDatabase } =
    projectRequire("@lyrolab/nest-shared/database")
  const scenario = scenarios.find((item) => item.name === process.argv[3])
  assert.ok(scenario)
  const port = Number(process.argv[4])
  const scram = scenario.acquisition === "scram",
    cancel = scenario.cancel
  const started = performance.now()
  let lookupStarted = 0,
    lookupSettled = 0,
    derivationStarted = 0,
    derivationSettled = 0,
    derivationSettledMs,
    cryptoAfterReturn = 0
  let returned = false,
    jobs = [],
    fixtureSettled = 0,
    abortAtMs,
    report,
    unhandled = 0
  process.on("unhandledRejection", () => unhandled++)
  const controller = new AbortController()
  const originalLookup = dns.lookup
  dns.lookup = function (...args) {
    lookupStarted++
    const callback = args.pop()
    return originalLookup.call(this, ...args, (...values) => {
      lookupSettled++
      callback(...values)
    })
  }
  const originalDerive = crypto.webcrypto.subtle.deriveBits
  crypto.webcrypto.subtle.deriveBits = function (...args) {
    derivationStarted++
    if (cancel)
      setTimeout(() => {
        abortAtMs = Math.round(performance.now() - started)
        controller.abort()
      }, 20)
    return originalDerive.apply(this, args).then(
      (value) => {
        derivationSettled++
        derivationSettledMs = Math.round(performance.now() - started)
        return value
      },
      (error) => {
        derivationSettled++
        derivationSettledMs = Math.round(performance.now() - started)
        throw error
      },
    )
  }
  for (const key of ["importKey", "sign", "digest"]) {
    const original = crypto.webcrypto.subtle[key]
    crypto.webcrypto.subtle[key] = function (...args) {
      if (returned) cryptoAfterReturn++
      return original.apply(this, args)
    }
  }
  function saturate() {
    jobs = Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          crypto.pbkdf2("local", "fixture", 1000000, 32, "sha256", (error) => {
            fixtureSettled++
            error ? reject(error) : resolve()
          })
        }),
    )
  }
  if (!scram) {
    saturate()
    process.disconnect()
    if (cancel)
      setTimeout(() => {
        abortAtMs = Math.round(performance.now() - started)
        controller.abort()
      }, 20)
  } else {
    process.on("message", (message) => {
      if (message === "saturate") {
        saturate()
        process.send("saturated")
        process.disconnect()
      }
    })
  }
  const url = `postgres://fixture:fixture@${scram ? "127.0.0.1" : "localhost"}:${port}/base`
  const database = Database.getTestDatabaseInfo(
    new ConfigService({ DATABASE_URL: url }),
  )
  let failure
  try {
    await recoverTestDatabase({
      base: { databaseUrl: url, expectedRole: "fixture" },
      database,
      acquiredOid: 1,
      exclusiveTarget: true,
      timeoutMs: workMs,
      closeTimeoutMs: closeMs,
      signal: controller.signal,
    })
  } catch (error) {
    failure = { code: error.code, phase: error.phase, outcome: error.outcome }
  }
  returned = true
  report = {
    scenario: scenario.name,
    workMs,
    closeMs,
    settledMs: Math.round(performance.now() - started),
    abortAtMs,
    lookupStarted,
    lookupSettledAtReturn: lookupSettled,
    derivationStarted,
    derivationSettledAtReturn: derivationSettled,
    fixtureSettledAtReturn: fixtureSettled,
    ...failure,
  }
  await Promise.all(jobs)
  process.once("beforeExit", () =>
    console.log(
      JSON.stringify({
        ...report,
        lookupSettled,
        derivationSettled,
        derivationSettledMs,
        cryptoAfterReturn,
        fixtureSettled,
        unhandled,
        allWorkDoneMs: Math.round(performance.now() - started),
      }),
    ),
  )
}
async function probe(scenario) {
  const peers = new Set()
  let queries = 0,
    authenticationStarted = false,
    firstNonce,
    peer
  const server = net.createServer((socket) => {
    peer = socket
    peers.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => peers.delete(socket))
    let startup = true,
      pending = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= (startup ? 4 : 5)) {
        const size = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
        if (pending.length < size) return
        const packet = pending.subarray(0, size)
        pending = pending.subarray(size)
        if (startup) {
          startup = false
          authenticationStarted = true
          socket.write(auth(10, "SCRAM-SHA-256\0\0"))
        } else if (packet[0] === 112 && !firstNonce) {
          const offset = packet.indexOf(0, 5) + 5
          const first = packet.subarray(offset).toString()
          firstNonce = first.match(/r=([^,]+)/)[1]
          cp.send("saturate")
        } else if (packet[0] === 81) queries++
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const cp = spawn(
    process.execPath,
    [__filename, "--child", scenario.name, String(server.address().port)],
    {
      cwd: process.cwd(),
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  )
  const exited = once(cp, "exit")
  cp.on("message", (message) => {
    if (message === "saturated")
      peer.write(auth(11, `r=${firstNonce}fixture,s=Zml4dHVyZQ==,i=4096`))
  })
  let stdout = "",
    stderr = "",
    watchdog = false
  cp.stdout.on("data", (chunk) => (stdout += chunk))
  cp.stderr.on("data", (chunk) => (stderr += chunk))
  const timer = setTimeout(() => {
    watchdog = true
    cp.kill("SIGKILL")
  }, 15000)
  try {
    const [code, signal] = await exited
    assert.equal(watchdog, false)
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(stderr, "")
    const report = JSON.parse(stdout)
    assert.equal(report.outcome, "not-attempted")
    assert.equal(queries, 0)
    assert.equal(report.unhandled, 0)
    assert.equal(report.fixtureSettled, 4)
    assert.equal(
      report.code,
      scenario.cancel ? "CANCELLED" : "DEADLINE_EXCEEDED",
    )
    assert.equal(report.phase, "connect")
    if (scenario.acquisition === "scram") {
      assert.equal(report.derivationStarted, 1)
      assert.equal(report.derivationSettledAtReturn, 0)
      assert.equal(report.derivationSettled, 1)
      assert.ok(report.cryptoAfterReturn > 0)
    } else {
      assert.ok(report.lookupStarted > 0)
      assert.equal(report.lookupSettledAtReturn, 0)
      assert.equal(report.lookupStarted, report.lookupSettled)
    }
    console.log(
      JSON.stringify({
        ...report,
        queries,
        authenticationStarted,
        naturalExitCode: code,
        naturalExitBeforeFixtureCleanup: true,
      }),
    )
  } finally {
    clearTimeout(timer)
    for (const socket of peers) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}
async function main() {
  if (process.argv[2] === "--child") return child()
  for (const scenario of scenarios) await probe(scenario)
}
main().catch(() => {
  if (process.connected) process.disconnect()
  console.error("Connection acquisition audit failed")
  process.exitCode = 1
})
