const assert = require("node:assert/strict")
const { spawn, execFileSync } = require("node:child_process")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const tls = require("node:tls")
const crypto = require("node:crypto")
const { performance } = require("node:perf_hooks")
const scenarios = require("./isolation-scenarios.json")
const ready = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])
const workMs = 200,
  closeMs = 300
function auth(code, text) {
  const body = Buffer.from(text),
    header = Buffer.alloc(9)
  header[0] = 82
  header.writeInt32BE(8 + body.length, 1)
  header.writeInt32BE(code, 5)
  return Buffer.concat([header, body])
}
function saturate() {
  return Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          crypto.pbkdf2("local", "fixture", 1000000, 32, "sha256", (error) =>
            error ? reject(error) : resolve(),
          )
        }),
    ),
  )
}
function send(cp, message, callback = () => {}) {
  if (!cp.connected) {
    callback(new Error("Probe channel closed"))
    return false
  }
  try {
    return cp.send(message, callback)
  } catch {
    callback(new Error("Probe send failed"))
    return false
  }
}
async function child() {
  const mode = process.argv[3]
  if (mode === "ipc-backpressure") {
    setInterval(() => {}, 1000)
    return
  }
  let client,
    socket,
    closing,
    ended,
    socketClosed,
    stopped = false
  let fixtureJobs
  const pending = new Set()
  const observe = (p) => {
    const settled = p.then(
      () => undefined,
      () => undefined,
    )
    pending.add(settled)
    settled.then(() => pending.delete(settled))
    return settled
  }
  async function stop() {
    if (closing) return closing
    stopped = true
    closing = (async () => {
      if (socket) socket.destroy(new Error("Probe interrupted"))
      if (client) await observe(client.end())
      await Promise.all([socketClosed, ended, ...pending])
      if (fixtureJobs) await fixtureJobs
      process.removeAllListeners("message")
      if (process.connected) process.disconnect()
    })()
    return closing
  }
  process.on("disconnect", () => {
    void stop()
    // Only the isolated probe child may terminate itself after parent loss.
    const fence = setTimeout(
      () => process.kill(process.pid, "SIGKILL"),
      closeMs / 4,
    )
    closing?.then(() => clearTimeout(fence))
  })
  process.on("message", async (message) => {
    if (message.type === "cancel") {
      void stop()
      return
    }
    if (message.type === "permit") {
      if (stopped) return
      if (mode === "child-crash-after-permit") process.exit(7)
      send(process, { v: 1, type: "simulated-dispatch" })
      if (mode === "verified-result-natural") {
        send(process, { v: 1, type: "verified" })
        void stop()
      }
      return
    }
    if (message.type !== "init" || stopped) return
    const { scenario, port, material } = message
    assert.equal(process.env.NODE_OPTIONS, undefined)
    assert.equal(process.env.PGPASSWORD, undefined)
    assert.deepEqual(process.execArgv, [])
    if (scenario.crash) process.exit(7)
    if (scenario.malformed) {
      send(process, { v: 9, type: "invalid" })
      return
    }
    const { Client } = require("pg")
    const dns = require("node:dns")
    if (scenario.acquisition === "dns") {
      fixtureJobs = saturate()
      const original = dns.lookup
      dns.lookup = function (...args) {
        const callback = args.pop()
        send(process, { v: 1, type: "acquisition", kind: "dns" })
        return original.call(this, ...args, (...values) => {
          send(process, { v: 1, type: "acquisition-settled" })
          callback(...values)
        })
      }
    }
    if (scenario.acquisition === "scram") {
      const original = crypto.webcrypto.subtle.deriveBits
      crypto.webcrypto.subtle.deriveBits = function (...args) {
        send(process, { v: 1, type: "acquisition", kind: "scram" })
        const result = original.apply(this, args)
        observe(
          result.then(() =>
            send(process, { v: 1, type: "acquisition-settled" }),
          ),
        )
        return result
      }
    }
    socket = new net.Socket()
    socket.on("error", () => {})
    socketClosed = new Promise((resolve) => socket.once("close", resolve))
    const config = {
      host:
        scenario.ip || scenario.acquisition === "scram"
          ? "127.0.0.1"
          : "localhost",
      port,
      user: "fixture",
      database: "base",
      password: () => "fixture",
      ssl: scenario.tls
        ? {
            rejectUnauthorized: true,
            ...(scenario.untrusted ? {} : { ca: material.ca }),
            ...(scenario.mutual
              ? { cert: material.ca, key: material.key }
              : {}),
          }
        : false,
      sslnegotiation: "postgres",
      options: " ",
      client_encoding: "UTF8",
      application_name: "probe",
      stream: () => socket,
    }
    client = new Client(config)
    client.on("error", () => {})
    ended = new Promise((resolve) => client.once("end", resolve))
    observe(
      client
        .connect()
        .then(async () => {
          if (stopped) return
          send(process, { v: 1, type: "connected" })
          if (scenario.phase === "active") {
            await client.query("SELECT 1")
          } else if (!scenario.phase && !scenario.acquisition) {
            send(process, { v: 1, type: "permit-request" })
            if (scenario.duplicate)
              send(process, { v: 1, type: "permit-request" })
          }
        })
        .catch(() => {
          if (!stopped) {
            send(process, { v: 1, type: "connection-failed" })
            void stop()
          }
        }),
    )
    if (scenario.acquisition === "scram")
      process.on("message", async (m) => {
        if (m.type !== "saturate" || stopped) return
        fixtureJobs = saturate()
        send(process, { v: 1, type: "saturated" })
      })
  })
  send(process, { v: 1, type: "ready" })
}
async function fixture(scenario, material) {
  const peers = new Set()
  let fixtureClosing = false
  let cp,
    nonce,
    scramPeer,
    queries = 0,
    secure = false,
    mutual = false
  const track = (socket) => {
    peers.add(socket)
    if (fixtureClosing) socket.destroy()
    socket.on("error", () => {})
    socket.on("close", () => peers.delete(socket))
    if (scenario.acquisition) socket.on("end", () => socket.end())
    return socket
  }
  const protocol = (socket) => {
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
          if (scenario.acquisition === "scram")
            socket.write(auth(10, "SCRAM-SHA-256\0\0"))
          else socket.write(ready)
        } else if (packet[0] === 112 && !nonce) {
          nonce = packet
            .subarray(packet.indexOf(0, 5) + 5)
            .toString()
            .match(/r=([^,]+)/)[1]
          scramPeer = socket
          send(cp, { type: "saturate" })
        } else if (packet[0] === 81) {
          queries++
        }
      }
    })
  }
  const context = scenario.tls
    ? tls.createSecureContext({
        cert: material.cert,
        key: material.key,
        ca: material.ca,
      })
    : undefined
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    track(raw)
    if (!scenario.tls) return protocol(raw)
    raw.once("data", (packet) => {
      assert.equal(packet.readInt32BE(4), 80877103)
      raw.write("S")
      if (scenario.phase === "handshake") {
        raw.on("data", () => {})
        return
      }
      const encrypted = track(
        new tls.TLSSocket(raw, {
          isServer: true,
          secureContext: context,
          requestCert: !!scenario.mutual,
          rejectUnauthorized: true,
          allowHalfOpen: true,
        }),
      )
      encrypted.on("secure", () => {
        secure = true
        const peer = encrypted.getPeerCertificate()
        mutual =
          !!peer.raw &&
          new crypto.X509Certificate(peer.raw).verify(
            new crypto.X509Certificate(material.ca).publicKey,
          )
      })
      protocol(encrypted)
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: server.address().port,
    bind(childProcess) {
      cp = childProcess
    },
    saturated() {
      scramPeer.write(auth(11, `r=${nonce}fixture,s=Zml4dHVyZQ==,i=4096`))
    },
    report() {
      return { queries, secure, mutual, peers: peers.size }
    },
    async close() {
      fixtureClosing = true
      for (const peer of peers) peer.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
async function probe(scenario, material) {
  if (scenario.terminationControl) {
    const start = performance.now()
    const cp = spawn(process.execPath, [__filename, "--termination-control"], {
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    })
    let fenceAt, watchdog
    cp.stdout.on("data", () => {
      fenceAt = performance.now()
    })
    const exited = new Promise((resolve) =>
      cp.once("exit", (code, signal) => resolve({ code, signal })),
    )
    const outputClosed = new Promise((resolve) =>
      cp.stdout.once("close", resolve),
    )
    try {
      watchdog = setTimeout(() => cp.kill("SIGKILL"), 5000)
      const [status] = await Promise.all([exited, outputClosed])
      assert.equal(status.code, 1)
      assert.equal(status.signal, null)
      assert.ok(fenceAt)
      console.log(
        JSON.stringify({
          scenario: scenario.name,
          elapsedMs: Math.ceil(performance.now() - start),
          fenceToExitMs: Math.ceil(performance.now() - fenceAt),
          code: status.code,
          signal: status.signal,
          fixtureJobs: 4,
          control: true,
        }),
      )
    } finally {
      clearTimeout(watchdog)
    }
    return
  }
  if (scenario.preAbort) {
    const controller = new AbortController()
    controller.abort()
    assert.equal(controller.signal.aborted, true)
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        launches: 0,
        queries: 0,
        outcome: "not-attempted",
        primary: "CANCELLED",
      }),
    )
    return
  }
  const callerMaterial = { ca: material.ca, key: material.key }
  const capturedMaterial = { ...callerMaterial }
  const local = await fixture(scenario, material)
  if (scenario.mutation) {
    callerMaterial.ca = "invalid"
    callerMaterial.key = "invalid"
  }
  const start = performance.now()
  const allowance = scenario.cold ? 1 : scenario.acquisition ? workMs : 1000
  let primary,
    closeFailed = false,
    forced = false,
    phase = "startup",
    outcome = "not-attempted"
  let acquisition,
    acquisitionSettled = false,
    permit = false,
    dispatches = 0,
    result = false
  let closeTimer,
    forceTimer,
    cancelTimer,
    closed = false,
    exitSeen = false,
    backpressure = false
  let sends = 0,
    callbacks = 0,
    afterClosed = 0,
    killAt,
    interruptAt
  const jobs = scenario.parentPool ? saturate() : undefined
  const cp = spawn(
    process.execPath,
    [
      scenario.startupFailure
        ? path.join(__dirname, "unavailable-entry.cjs")
        : __filename,
      "--child",
      scenario.name,
    ],
    {
      env: {},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: false,
      shell: false,
    },
  )
  local.bind(cp)
  let aggregateClose = false
  cp.once("close", () => {
    aggregateClose = true
  })
  const exited = new Promise((resolve) =>
    cp.once("exit", (code, signal) => resolve({ code, signal })),
  )
  const disconnected = new Promise((resolve) => cp.once("disconnect", resolve))
  const pipeClosures = [cp.stdout, cp.stderr].map(
    (pipe) => new Promise((resolve) => pipe.once("close", resolve)),
  )
  const disposal = Promise.all([exited, disconnected, ...pipeClosures]).then(
    ([status]) => {
      closed = true
      return status
    },
  )
  let diagnostics = 0
  cp.stdout.on("data", (chunk) => {
    diagnostics += chunk.length
  })
  cp.stderr.on("data", (chunk) => {
    diagnostics += chunk.length
  })
  const post = (message) => {
    sends++
    const writable = send(cp, message, (error) => {
      callbacks++
      if (error && !primary) interrupt("IPC_FAILURE")
    })
    backpressure ||= !writable
  }
  const interrupt = (code) => {
    if (closed) return
    primary ??= code
    if (closeTimer) return
    closeTimer = true
    interruptAt = performance.now()
    post({ v: 1, type: "cancel" })
    forceTimer = setTimeout(
      () => {
        if (closed) return
        closeFailed = true
        forced = true
        killAt = performance.now()
        cp.kill("SIGKILL")
      },
      Math.floor(closeMs / 2),
    )
    closeTimer = setTimeout(() => {
      // A failed proof still joins its exact owned child; it never abandons it.
      if (!closed) {
        closeFailed = true
        cp.kill("SIGKILL")
      }
    }, closeMs)
  }
  const timer = setTimeout(
    () => interrupt("DEADLINE_EXCEEDED"),
    Math.max(0, allowance - (performance.now() - start)),
  )
  if (scenario.earlyCancel)
    cancelTimer = setTimeout(() => interrupt("CANCELLED"), 1)
  cp.on("error", () => interrupt("SPAWN_OR_IPC_FAILURE"))
  cp.on("exit", (code, signal) => {
    if ((code !== 0 || signal) && !primary) primary = "DATABASE_FAILURE"
    if (scenario.selfExit) closeFailed = true
    exitSeen = true
  })
  cp.on("message", (message) => {
    if (closed) afterClosed++
    if (message.v !== 1) {
      interrupt("PROTOCOL_FAILURE")
      return
    }
    if (message.type === "ready") {
      phase = "connect"
      if (primary) return
      const captured = { ...capturedMaterial }
      post({
        v: 1,
        type: "init",
        scenario,
        port: local.port,
        material: captured,
      })
      if (scenario.mutation) {
        captured.ca = "invalid"
        captured.key = "invalid"
      }
      if (scenario.disconnect) {
        cp.disconnect()
        primary = "IPC_FAILURE"
        if (scenario.sendFailure) post({ v: 1, type: "cancel" })
      }
    } else if (message.type === "acquisition") {
      acquisition = message.kind
      if (scenario.disconnectOnAcquisition) {
        cp.disconnect()
        interrupt("IPC_FAILURE")
      }
      if (scenario.cancel)
        cancelTimer = setTimeout(() => interrupt("CANCELLED"), 20)
    } else if (message.type === "acquisition-settled") acquisitionSettled = true
    else if (message.type === "saturated") local.saturated()
    else if (message.type === "connected" && scenario.phase === "idle")
      interrupt("COMPLETE")
    else if (message.type === "connection-failed")
      primary ??= "DATABASE_FAILURE"
    else if (message.type === "permit-request") {
      if (scenario.abortAtPermit) interrupt("CANCELLED")
      if (permit) {
        interrupt("PROTOCOL_FAILURE")
        return
      }
      if (primary || performance.now() - start >= allowance) {
        interrupt(primary || "DEADLINE_EXCEEDED")
        return
      }
      permit = true
      outcome = "unknown"
      post({ v: 1, type: "permit" })
      if (scenario.abortAfterPermit) interrupt("CANCELLED")
      if (
        !scenario.complete &&
        !scenario.crashAfterPermit &&
        !scenario.abortAfterPermit &&
        !scenario.duplicate
      )
        interrupt("COMPLETE")
    } else if (message.type === "simulated-dispatch") dispatches++
    else if (message.type === "verified") {
      result = true
      outcome = "removed"
    }
  })
  if (scenario.ipcStall)
    post({ v: 1, type: "init", padding: "x".repeat(3 * 1024 * 1024) })
  let watchdog
  try {
    const status = await Promise.race([
      disposal,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          cp.kill("SIGKILL")
          reject(new Error("Probe child disposal failed"))
        }, 3000)
      }),
    ])
    const elapsedMs = Math.ceil(performance.now() - start)
    clearTimeout(timer)
    clearTimeout(forceTimer)
    clearTimeout(closeTimer)
    clearTimeout(cancelTimer)
    clearTimeout(watchdog)
    assert.ok(exitSeen)
    assert.equal(cp.connected, false)
    assert.ok(cp.stdout.destroyed && cp.stderr.destroyed)
    assert.equal(afterClosed, 0)
    assert.equal(sends, callbacks)
    assert.ok(elapsedMs <= allowance + closeMs + 50)
    if (interruptAt) assert.ok(performance.now() - interruptAt <= closeMs + 50)
    if (!scenario.startupFailure) assert.equal(diagnostics, 0)
    else {
      assert.equal(status.code, 1)
      assert.equal(status.signal, null)
      assert.equal(permit, false)
      assert.equal(outcome, "not-attempted")
    }
    assert.equal(local.report().queries, scenario.phase === "active" ? 1 : 0)
    if (scenario.acquisition) {
      assert.equal(acquisition, scenario.acquisition)
      assert.equal(acquisitionSettled, false)
    }
    if (scenario.force) {
      assert.equal(forced, true)
      assert.equal(status.signal, "SIGKILL")
      assert.equal(closeFailed, true)
    }
    if (scenario.selfExit) {
      assert.equal(forced, false)
      assert.equal(status.code, null)
      assert.equal(status.signal, "SIGKILL")
      assert.equal(permit, false)
    }
    if (scenario.natural) {
      assert.equal(status.code, 0)
      assert.equal(status.signal, null)
    }
    if (scenario.abortAtPermit) {
      assert.equal(permit, false)
      assert.equal(dispatches, 0)
      assert.equal(outcome, "not-attempted")
    }
    if (scenario.crash) {
      assert.equal(permit, false)
      assert.equal(outcome, "not-attempted")
      assert.equal(status.code, 7)
    }
    if (scenario.crashAfterPermit) assert.equal(status.code, 7)
    if (scenario.unknown) assert.equal(outcome, "unknown")
    if (scenario.complete) {
      assert.equal(result, true)
      assert.equal(outcome, "removed")
    }
    if (scenario.ipcStall) assert.equal(backpressure, true)
    if (
      scenario.tls &&
      !scenario.untrusted &&
      !scenario.mismatch &&
      scenario.phase !== "handshake"
    )
      assert.equal(local.report().secure, true)
    if (scenario.mutual) assert.equal(local.report().mutual, true)
    if (scenario.untrusted || scenario.mismatch)
      assert.equal(primary, "DATABASE_FAILURE")
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (scenario.acquisition === "scram") assert.equal(local.report().peers, 0)
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        workMs: allowance,
        closeMs,
        elapsedMs,
        interruptAtMs: interruptAt ? Math.ceil(interruptAt - start) : undefined,
        phase,
        primary,
        forced,
        selfExit: !!scenario.selfExit,
        closeFailed,
        acquisition,
        acquisitionSettled,
        permit,
        outcome,
        dispatches,
        queries: local.report().queries,
        exitSeen,
        channelsClosed: closed,
        aggregateClose,
        code: status.code,
        signal: status.signal,
        killToCloseMs: killAt
          ? Math.ceil(performance.now() - killAt - 20)
          : undefined,
        fixtureJobs: scenario.parentPool ? 4 : scenario.acquisition ? 4 : 0,
      }),
    )
  } catch (error) {
    console.error(
      "Scenario failed",
      scenario.name,
      error.name,
      error.code || "",
      {
        closed,
        exitSeen,
        connected: cp.connected,
        code: cp.exitCode,
        signal: cp.signalCode,
      },
    )
    throw error
  } finally {
    for (const timer of [watchdog, forceTimer, closeTimer, cancelTimer])
      clearTimeout(timer)
    clearTimeout(timer)
    if (!closed) {
      cp.kill("SIGKILL")
      await disposal
    }
    await local.close()
    await jobs
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
  const cert = fs.readFileSync(path.join(directory, "cert.pem"), "utf8"),
    key = fs.readFileSync(path.join(directory, "key.pem"), "utf8")
  return { ca: cert, cert, key }
}
async function main() {
  if (process.argv[2] === "--termination-control") {
    void saturate()
    setTimeout(() => {
      process.stdout.write("fence")
      process.exit(1)
    }, 20)
    return
  }
  if (process.argv[2] === "--child") return child()
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR
  assert.ok(scratch)
  const directory = fs.mkdtempSync(path.join(scratch, "isolated-connection-"))
  try {
    fs.mkdirSync(path.join(directory, "valid"))
    fs.mkdirSync(path.join(directory, "mismatch"))
    const valid = certificate(path.join(directory, "valid"), false),
      mismatch = certificate(path.join(directory, "mismatch"), true)
    console.log(
      JSON.stringify({
        node: process.version,
        driver: require("pg/package.json").version,
        platform: process.platform,
        workMs,
        closeMs,
      }),
    )
    for (const scenario of scenarios.filter(
      (s) => !process.argv[2] || s.name === process.argv[2],
    ))
      await probe(scenario, scenario.mismatch ? mismatch : valid)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(
    "Isolation prerequisite failed",
    error.stack
      ?.split("\n")
      .find((line) => line.includes("isolated-connection-probe.cjs:"))
      ?.match(/:(\d+):/)?.[1],
    error.name,
    error.code || "",
    "See safe case diagnostics",
  )
  process.exitCode = 1
})
