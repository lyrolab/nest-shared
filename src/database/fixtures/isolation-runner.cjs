const assert = require("node:assert/strict")
const { once } = require("node:events")
const childProcess = require("node:child_process")
const path = require("node:path")
const net = require("node:net")
const crypto = require("node:crypto")
const tls = require("node:tls")
const fs = require("node:fs")
const scenarios = [
  ...require("./isolation-scenarios.json"),
  ...require("./recovery-fault-scenarios.json"),
]
const scenario = scenarios.find((entry) => entry.name === process.argv[3])

function saturate(iterations = 8_000_000) {
  return Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          crypto.pbkdf2(
            "local",
            "fixture",
            iterations,
            32,
            "sha256",
            (error) => (error ? reject(error) : resolve()),
          )
        }),
    ),
  )
}

function acquisitionFixture() {
  assert.deepEqual(Object.keys(process.env), [])
  assert.deepEqual(process.execArgv, [])
  const report = (event) => {
    if (process.connected) process.send({ audit: event }, () => {})
  }
  const observe = (promise) =>
    promise.then(
      (value) => {
        report("settled")
        return value
      },
      (error) => {
        report("settled")
        throw error
      },
    )
  if (scenario.acquisition === "dns") {
    const dns = require("node:dns")
    const lookup = dns.lookup
    dns.lookup = function (...args) {
      void saturate()
      const callback = args.pop()
      report("acquisition")
      return lookup.call(this, ...args, (...values) => {
        report("settled")
        callback(...values)
      })
    }
  } else {
    const derive = crypto.webcrypto.subtle.deriveBits
    crypto.webcrypto.subtle.deriveBits = function (...args) {
      void saturate()
      report("acquisition")
      return observe(derive.apply(this, args))
    }
  }
  const { Client } = require("pg")
  const query = Client.prototype.query
  Client.prototype.query = function (...args) {
    report("query")
    return query.apply(this, args)
  }
  require("../../../dist/database/internal/test-database-recovery-child.js")
}

function childFixture() {
  if (scenario.acquisition) return acquisitionFixture()
  if (scenario.tls || scenario.emptyPassword)
    return require("../../../dist/database/internal/test-database-recovery-child.js")
  if (scenario.noReady) {
    setInterval(() => {}, 1000)
    return
  }
  if (scenario.backpressure) {
    process.send({ version: 1, type: "ready" }, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000)
    })
    return
  }
  const {
    TestDatabaseSession,
  } = require("../../../dist/database/helpers/test-database-session")
  let input,
    permission = false,
    dropped = false,
    inspections = 0
  let release
  process.prependListener("message", (message) => {
    if (message.type === "start") input = message.input
    if (message.type === "permit-drop") {
      permission = true
      if (scenario.crash === "permit") process.kill(process.pid, "SIGKILL")
    }
  })
  const originalSend = process.send.bind(process)
  process.send = (message, ...args) => {
    if (scenario.badReady && message.type === "ready")
      message = { version: 99, type: "ready" }
    if (scenario.malformedClosing && message.type === "closing")
      message = {
        ...message,
        failures: [{ code: "CANCELLED", phase: "inspect" }],
      }
    if (
      scenario.duplicateFailure &&
      ["closing", "result"].includes(message.type)
    )
      message = {
        ...message,
        failures: [
          { code: "DATABASE_FAILURE", phase: "connect" },
          { code: "DATABASE_FAILURE", phase: "connect" },
        ],
      }
    const result = originalSend(message, ...args)
    if (scenario.duplicateReady && message.type === "ready")
      originalSend(message)
    return result
  }
  const pause = () =>
    new Promise((resolve) => {
      release = resolve
    })
  TestDatabaseSession.create = async () => ({
    healthy: true,
    connect: async () => {
      if (scenario.rejectConnect) throw new Error("Fixture connection failure")
      if (scenario.stall === "connect") await pause()
    },
    query: async (sql) => {
      let at = "configure",
        rows = []
      if (sql.includes("current_database() AS name")) {
        at = "binding"
        rows = [
          {
            name: input.baseName,
            session: input.expectedRole,
            current: input.expectedRole,
            role: 7,
            template: false,
          },
        ]
      } else if (sql.includes("pg_try_advisory_lock")) {
        at = "lock"
        rows = [{ locked: true }]
      } else if (sql.includes("WHERE datname = $1 OR oid")) {
        // The third inspection follows the parent's permission fence.
        at = ["inspect", "recheck", "permitted-recheck", "verify"][
          inspections++
        ]
        rows =
          dropped || scenario.absent
            ? []
            : [
                {
                  name: input.databaseName,
                  oid: input.acquiredOid,
                  owner: 7,
                  template: false,
                },
              ]
      } else if (sql.startsWith("DROP")) {
        assert.equal(permission, true)
        at = "drop"
        dropped = true
        if (scenario.crash === "drop") process.kill(process.pid, "SIGKILL")
      }
      if (at === scenario.stall) await pause()
      if (at === scenario.at) {
        if (scenario.reject) throw new Error("Fixture query failure")
        if (scenario.empty) return []
        if (scenario.patch) return [{ ...rows[0], ...scenario.patch }]
        if (scenario.duplicate) return [...rows, ...rows]
      }
      return rows
    },
    interrupt: () => release?.(),
    close: async () => {
      if (scenario.stallClose) await new Promise(() => {})
      if (scenario.rejectClose || scenario.closeFailure)
        throw new Error("Fixture close failure")
    },
  })
  require("../../../dist/database/internal/test-database-recovery-child.js")
}

async function caller() {
  const trace = []
  const spawn = childProcess.spawn
  let owned,
    exited = false,
    disconnected = false,
    pendingSends = 0
  const controller = new AbortController()
  let acquisitions = 0,
    settlements = 0,
    queries = 0,
    backpressure = false
  const peers = new Set()
  let database
  let server,
    directory,
    material,
    secure = false,
    clientVerified = false,
    passwordObserved = false
  let connections = 0
  let port = 5432
  if (scenario.tls) {
    directory = fs.mkdtempSync(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? require("node:os").tmpdir(),
        "recovery-tls-",
      ),
    )
    const certificate = (prefix, mismatch) => {
      childProcess.execFileSync(
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
          path.join(directory, prefix + ".key"),
          "-out",
          path.join(directory, prefix + ".crt"),
          "-subj",
          "/CN=localhost",
          "-addext",
          mismatch
            ? "subjectAltName=DNS:wrong.invalid"
            : "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore", timeout: 10000 },
      )
      return {
        cert: fs.readFileSync(path.join(directory, prefix + ".crt"), "utf8"),
        key: fs.readFileSync(path.join(directory, prefix + ".key"), "utf8"),
      }
    }
    material = certificate("server", scenario.mismatch)
    if (scenario.untrusted || scenario.keyMismatch)
      material.other = certificate("other", false)
  }
  if (scenario.acquisition || scenario.tls || scenario.emptyPassword) {
    const auth = (code, text) => {
      const body = Buffer.from(text),
        header = Buffer.alloc(9)
      header[0] = 82
      header.writeInt32BE(8 + body.length, 1)
      header.writeInt32BE(code, 5)
      return Buffer.concat([header, body])
    }
    const packet = (type, body) => {
      const header = Buffer.alloc(5)
      header[0] = type.charCodeAt(0)
      header.writeInt32BE(body.length + 4, 1)
      return Buffer.concat([header, body])
    }
    const ready = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])
    const reply = (socket, rows) => {
      if (rows.length) {
        const keys = Object.keys(rows[0]),
          count = Buffer.alloc(2)
        count.writeInt16BE(keys.length)
        socket.write(
          packet(
            "T",
            Buffer.concat([
              count,
              ...keys.map((key) => {
                const field = Buffer.alloc(18),
                  value = rows[0][key]
                field.writeInt32BE(
                  typeof value === "boolean"
                    ? 16
                    : typeof value === "number"
                      ? 23
                      : 25,
                  6,
                )
                field.writeInt16BE(-1, 10)
                field.writeInt32BE(-1, 12)
                return Buffer.concat([Buffer.from(key + "\0"), field])
              }),
            ]),
          ),
        )
        for (const row of rows)
          socket.write(
            packet(
              "D",
              Buffer.concat([
                count,
                ...keys.map((key) => {
                  const value = Buffer.from(
                    typeof row[key] === "boolean"
                      ? row[key]
                        ? "t"
                        : "f"
                      : String(row[key]),
                  )
                  const size = Buffer.alloc(4)
                  size.writeInt32BE(value.length)
                  return Buffer.concat([size, value])
                }),
              ]),
            ),
          )
      }
      socket.write(packet("C", Buffer.from("SELECT 1\0")))
      socket.write(Buffer.from([90, 0, 0, 0, 5, 73]))
    }
    const protocol = (socket) => {
      let startup = true,
        pending = Buffer.alloc(0),
        first = true,
        dropped = false,
        prepared = ""
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= (startup ? 4 : 5)) {
          const size = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
          if (pending.length < size) return
          const data = pending.subarray(0, size)
          pending = pending.subarray(size)
          if (startup) {
            startup = false
            if (scenario.emptyPassword) socket.write(auth(3, ""))
            else if (scenario.acquisition)
              socket.write(auth(10, "SCRAM-SHA-256\0\0"))
            else socket.write(ready)
          } else if (data[0] === 112 && first) {
            first = false
            if (scenario.emptyPassword) {
              assert.deepEqual(data.subarray(5), Buffer.from([0]))
              passwordObserved = true
              socket.write(ready)
            } else {
              const offset = data.indexOf(0, 5) + 5
              const nonce = data
                .subarray(offset)
                .toString()
                .match(/r=([^,]+)/)[1]
              socket.write(auth(11, `r=${nonce}fixture,s=Zml4dHVyZQ==,i=4096`))
            }
          } else if (data[0] === 81) {
            queries++
            if (scenario.cancelAtQuery) controller.abort()
            const sql = data.subarray(5, -1).toString()
            if (scenario.activeStall) continue
            if (sql.includes("current_database() AS name"))
              reply(socket, [
                {
                  name: "base",
                  session: "fixture",
                  current: "fixture",
                  role: 7,
                  template: false,
                },
              ])
            else if (sql.includes("pg_try_advisory_lock"))
              reply(socket, [{ locked: true }])
            else if (sql.includes("WHERE datname = $1 OR oid"))
              reply(
                socket,
                dropped || scenario.absent
                  ? []
                  : [
                      {
                        oid: 42,
                        name: database.databaseName,
                        owner: 7,
                        template: false,
                      },
                    ],
              )
            else if (sql.startsWith("DROP")) {
              assert.ok(trace.includes("parent:permit-drop"))
              dropped = true
              reply(socket, [])
            } else reply(socket, [])
          } else if (data[0] === 88) socket.end()
          else if (data[0] === 80) {
            const offset = data.indexOf(0, 5) + 1
            prepared = data.subarray(offset, data.indexOf(0, offset)).toString()
            socket.write(packet("1", Buffer.alloc(0)))
          } else if (data[0] === 66) socket.write(packet("2", Buffer.alloc(0)))
          else if (data[0] === 68) socket.write(packet("n", Buffer.alloc(0)))
          else if (data[0] === 69) {
            queries++
            if (scenario.cancelAtQuery) controller.abort()
            if (!scenario.activeStall) {
              if (prepared.includes("current_database() AS name"))
                reply(socket, [
                  {
                    name: "base",
                    session: "fixture",
                    current: "fixture",
                    role: 7,
                    template: false,
                  },
                ])
              else if (prepared.includes("pg_try_advisory_lock"))
                reply(socket, [{ locked: true }])
              else if (prepared.includes("WHERE datname = $1 OR oid"))
                reply(
                  socket,
                  dropped || scenario.absent
                    ? []
                    : [
                        {
                          oid: 42,
                          name: database.databaseName,
                          owner: 7,
                          template: false,
                        },
                      ],
                )
              else reply(socket, [])
            }
          }
        }
      })
    }
    server = net.createServer((socket) => {
      connections++
      peers.add(socket)
      socket.on("error", () => {})
      socket.on("close", () => peers.delete(socket))
      if (!scenario.tls) return protocol(socket)
      socket.once("data", (request) => {
        assert.equal(request.readInt32BE(4), 80877103)
        socket.write("S")
        if (scenario.cancelHandshake) controller.abort()
        if (scenario.handshakeStall) return
        const encrypted = new tls.TLSSocket(socket, {
          isServer: true,
          secureContext: tls.createSecureContext({
            cert: material.cert,
            key: material.key,
            ca: material.cert,
          }),
          requestCert: !!scenario.mutual,
          rejectUnauthorized: !!scenario.mutual,
        })
        encrypted.on("error", () => {})
        encrypted.on("secure", () => {
          secure = true
          if (scenario.mutual) {
            const peer = encrypted.getPeerCertificate()
            clientVerified =
              !!peer.raw &&
              new crypto.X509Certificate(peer.raw).verify(
                new crypto.X509Certificate(material.cert).publicKey,
              )
            assert.equal(clientVerified, true)
          }
        })
        protocol(encrypted)
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = server.address().port
  }
  try {
    childProcess.spawn = (executable, args, options) => {
      assert.equal(owned, undefined)
      assert.equal(executable, process.execPath)
      assert.deepEqual(options.env, {})
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"])
      assert.equal(options.shell, false)
      assert.equal(options.detached, false)
      assert.equal(args.length, 1)
      if (scenario.deniedLaunch) throw new Error("Fixture launch denied")
      owned = spawn(
        executable,
        scenario.missingEntry
          ? [path.join(__dirname, "absent-entry.cjs")]
          : [__filename, "--engine", scenario.name],
        options,
      )
      const emit = owned.emit
      owned.emit = function (event, ...values) {
        if (event === "message" && values[0]?.audit) {
          const kind = values[0].audit
          if (kind === "acquisition") {
            acquisitions++
            if (scenario.cancelAcquisition) controller.abort()
            if (scenario.parentLoss) owned.disconnect()
          } else if (kind === "settled") settlements++
          else if (kind === "query") queries++
          return true
        }
        return emit.call(this, event, ...values)
      }
      if (scenario.earlyCancel) controller.abort()
      owned.on("exit", () => {
        exited = true
      })
      owned.on("disconnect", () => {
        disconnected = true
      })
      owned.on("message", (message) => {
        trace.push(
          "child:" +
            message.type +
            ":" +
            (message.phase ?? message.outcome ?? ""),
        )
        if (message.type === "phase" && message.phase === scenario.abort)
          controller.abort()
      })
      const originalSend = owned.send.bind(owned)
      owned.send = (message, callback) => {
        trace.push("parent:" + message.type)
        pendingSends++
        if (scenario.sendFailure === message.type) {
          pendingSends--
          callback(new Error("Fixture send failed"))
          return false
        }
        const result = originalSend(message, (error) => {
          pendingSends--
          callback(error)
        })
        if (!result) backpressure = true
        if (message.type === "permit-drop" && scenario.abort === "permit")
          controller.abort()
        return result
      }
      return owned
    }
    const { ConfigService } = require("@nestjs/config")
    const {
      SharedDatabaseModule: Database,
      recoverTestDatabase,
      TestDatabaseRecoveryError,
    } = require("@lyrolab/nest-shared/database")
    const databaseUrl = `postgres://fixture:${scenario.emptyPassword ? "" : "fixture"}@${scenario.acquisition === "dns" || (scenario.tls && !scenario.ip) ? "localhost" : "127.0.0.1"}:${port}/base`
    const tlsInput = scenario.tls
      ? {
          caPem: scenario.untrusted
            ? material.other.cert
            : scenario.malformed
              ? "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"
              : material.cert,
          ...(scenario.mutual || scenario.keyMismatch
            ? {
                certPem: material.cert,
                keyPem: scenario.keyMismatch
                  ? material.other.key
                  : material.key,
              }
            : {}),
        }
      : undefined
    database = Database.getTestDatabaseInfo(
      new ConfigService({ DATABASE_URL: databaseUrl }),
    )
    if (scenario.preabort) controller.abort()
    const jobs = scenario.parentPool ? saturate(1_000_000) : Promise.resolve()
    const workMs =
      scenario.acquisition || scenario.noReady || scenario.backpressure
        ? 500
        : scenario.stall
          ? 500
          : 2000
    const started = performance.now()
    try {
      const recovering = recoverTestDatabase({
        base: {
          databaseUrl,
          expectedRole: "fixture",
          ...(tlsInput ? { tls: tlsInput } : {}),
          ...(scenario.backpressure
            ? {
                tls: {
                  caPem:
                    "-----BEGIN CERTIFICATE-----\n" +
                    "A".repeat(1_000_000) +
                    "\n-----END CERTIFICATE-----",
                },
              }
            : {}),
        },
        database,
        acquiredOid: 42,
        exclusiveTarget: true,
        timeoutMs: workMs,
        closeTimeoutMs: 400,
        signal: controller.signal,
      })
      if (scenario.mutation) {
        tlsInput.caPem = "changed"
        tlsInput.certPem = "changed"
        tlsInput.keyPem = "changed"
      }
      const result = await recovering
      assert.equal(scenario.code, undefined)
      assert.equal(result.status, scenario.status)
    } catch (error) {
      assert.ok(error instanceof TestDatabaseRecoveryError)
      assert.equal(error.code, scenario.code)
      assert.equal(error.outcome, scenario.outcome)
      if (scenario.closeFailure || scenario.forced)
        assert.equal(error.failures.at(-1).code, "CLOSE_FAILED")
      assert.doesNotMatch(
        JSON.stringify(error),
        /fixture|base_test_|password|certificate|Error:/,
      )
    }
    if (scenario.preabort || scenario.deniedLaunch)
      assert.equal(owned, undefined)
    else {
      assert.equal(exited, true)
      assert.equal(disconnected, true)
      assert.equal(pendingSends, 0)
      if (scenario.forced || scenario.crash)
        assert.equal(owned.signalCode, "SIGKILL")
      else if (!scenario.missingEntry)
        assert.equal(owned.exitCode, 0, JSON.stringify(trace))
    }
    const elapsedMs = Math.round(performance.now() - started)
    assert.ok(
      elapsedMs < workMs + 400,
      `Invocation exceeded its budget: ${elapsedMs}`,
    )
    if (scenario.acquisition) {
      assert.equal(acquisitions, 1)
      assert.equal(settlements, 0)
      assert.equal(queries, 0)
      assert.ok(!trace.includes("parent:permit-drop"))
      if (scenario.acquisition === "scram") assert.equal(peers.size, 0)
    }
    if (scenario.tls) {
      if (scenario.malformed || scenario.keyMismatch)
        assert.equal(connections, 0)
      else if (
        scenario.untrusted ||
        scenario.mismatch ||
        scenario.handshakeStall
      )
        assert.equal(queries, 0)
      else {
        assert.equal(secure, true)
        assert.ok(queries > 0)
      }
      if (scenario.mutual) assert.equal(clientVerified, true)
    }
    if (scenario.emptyPassword) {
      assert.equal(passwordObserved, true)
      assert.ok(queries > 0)
    }
    if (scenario.backpressure) assert.equal(backpressure, true)
    if (scenario.earlyCancel || scenario.noReady)
      assert.ok(!trace.includes("parent:start"))
    await jobs
    console.log(
      JSON.stringify({
        name: scenario.name,
        passed: true,
        elapsedMs,
        acquisitions,
        queries,
        backpressure,
        forcedChild: owned?.signalCode === "SIGKILL",
      }),
    )
  } finally {
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      const closed = once(owned, "close")
      owned.kill("SIGKILL")
      await closed
    }
    for (const peer of peers) peer.destroy()
    if (server) await new Promise((resolve) => server.close(resolve))
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  for (const entry of scenarios) {
    const child = childProcess.spawn(
      process.execPath,
      [__filename, "--caller", entry.name],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let stderr = "",
      stdout = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    let timer
    try {
      const exit = await Promise.race([
        once(child, "close"),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Caller did not exit")),
            8000,
          )
        }),
      ])
      assert.equal(
        exit[0],
        0,
        `Scenario ${entry.name} failed: ${stderr.slice(0, 700)}`,
      )
      assert.equal(exit[1], null)
      assert.equal(JSON.parse(stdout).passed, true)
      console.log(
        JSON.stringify({
          ...JSON.parse(stdout),
          naturalCallerExit: true,
        }),
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await once(child, "close")
      }
    }
  }
}
if (process.argv[2] === "--engine") childFixture()
else
  (process.argv[2] === "--caller" ? caller() : main()).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
