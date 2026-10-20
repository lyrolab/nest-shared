const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const net = require("node:net")
const crypto = require("node:crypto")
const { spawn } = require("node:child_process")
const { EventEmitter } = require("node:events")
const { createRequire } = require("node:module")
const root = process.cwd()
const localRequire = createRequire(path.join(root, "package.json"))
const scenario = JSON.parse(process.argv[3] ?? "null")
const scratch = process.argv[4]

function adaptedEntry(directory) {
  const input = path.join(
    root,
    "dist/database/internal/test-database-recovery-child.js",
  )
  let source = fs.readFileSync(input, "utf8")
  const replace = (from, to) => {
    assert.ok(source.includes(from), "Compiled prerequisite input changed")
    source = source.replace(from, to)
  }
  replace("let fence;", "let fence; let fenceUntil = Infinity;")
  replace(
    "function emergency() {",
    `function armFence() {
    const until = Math.min(fenceUntil, closeUntil, Date.now() + closeBudget / 2);
    process.emit("prerequisite-fence-attempt", until);
    if (fence && until >= fenceUntil) return;
    clearTimeout(fence);
    fenceUntil = until;
    process.emit("prerequisite-fence", until);
    fence = setTimeout(() => process.kill(process.pid, "SIGKILL"), Math.max(0, until - Date.now()));
    fence.unref();
}
process.once("exit", () => clearTimeout(fence));
function emergency() {`,
  )
  replace(
    'fence ??= setTimeout(() => process.kill(process.pid, "SIGKILL"), Math.max(0, Math.min(closeBudget / 2, closeUntil - Date.now())));',
    "armFence();",
  )
  replace("reported = true;", "armFence(); reported = true;")
  replace(
    'clearTimeout(fence);\n        process.removeListener("message", onMessage);',
    "armFence();",
  )
  replace("if (!finished)\n        emergency();", "emergency();")
  replace(
    "closeUntil = Math.min(closeUntil, value.closeUntil);",
    "closeUntil = Math.min(closeUntil, value.closeUntil);\n        if (fence) armFence();",
  )
  const entry = path.join(
    directory,
    "dist/database/internal/test-database-recovery-child.js",
  )
  fs.writeFileSync(entry, source, { mode: 0o600 })
  return entry
}

function engine() {
  let started = 0,
    settled = 0,
    queries = 0
  const send = process.send.bind(process)
  const audit = (event, extra = {}) =>
    send({ audit: event, started, settled, queries, ...extra }, () => {})
  const auditFile = path.join(
    scratch,
    `${scenario.acquisition}-${scenario.boundary}-${scenario.races}.jsonl`,
  )
  process.on("prerequisite-fence-attempt", (until) =>
    fs.appendFileSync(
      auditFile,
      JSON.stringify({ until, time: Date.now() }) + "\n",
      { mode: 0o600 },
    ),
  )

  const saturate = () => {
    for (let n = 0; n < 4; n++)
      crypto.pbkdf2("local", "fixture", 8_000_000, 32, "sha256", () => {})
  }
  if (scenario.acquisition === "dns") {
    const dns = require("node:dns"),
      lookup = dns.lookup
    dns.lookup = function (...args) {
      saturate()
      started++
      audit("acquisition")
      const done = args.pop()
      return lookup.call(this, ...args, (...values) => {
        settled++
        audit("settled")
        done(...values)
      })
    }
  } else {
    const derive = crypto.webcrypto.subtle.deriveBits
    crypto.webcrypto.subtle.deriveBits = function (...args) {
      saturate()
      started++
      audit("acquisition")
      return derive.apply(this, args).finally(() => {
        settled++
        audit("settled")
      })
    }
  }
  const { Client } = localRequire("pg"),
    query = Client.prototype.query
  Client.prototype.query = function (...args) {
    queries++
    audit("query")
    return query.apply(this, args)
  }
  let injectedRaces = false
  process.prependListener("message", (message) => {
    if (message.type === "finish") {
      audit("finish-received")
      if (scenario.races && !injectedRaces) {
        injectedRaces = true
        // Repeated terminal/error events must not move the disposal ceiling.
        setTimeout(
          () => process.emit("message", { version: 1, type: "finish" }),
          15,
        )
        setTimeout(
          () => process.emit("uncaughtException", new Error("local fixture")),
          30,
        )
        setTimeout(() => process.emit("disconnect"), 60)
      }
    }
  })
  require(
    path.join(
      scratch,
      "dist/database/internal/test-database-recovery-child.js",
    ),
  )
}

async function caller() {
  const childProcess = require("node:child_process")
  let proxy,
    sequence = 0
  const callbacks = new Map()
  childProcess.spawn = () => {
    proxy = new EventEmitter()
    proxy.connected = true
    proxy.send = (message, callback) => {
      const id = ++sequence
      callbacks.set(id, callback)
      process.send({ kind: "send", message, id })
      return true
    }
    proxy.kill = () => {
      process.send({ kind: "kill" })
      return true
    }
    process.send({ kind: "launch" })
    return proxy
  }
  process.on("message", (packet) => {
    if (packet.kind === "ack") {
      const callback = callbacks.get(packet.id)
      callbacks.delete(packet.id)
      callback?.(packet.failed ? new Error("Fixture channel failed") : null)
    } else if (packet.kind === "event") {
      if (packet.event === "disconnect") proxy.connected = false
      proxy.emit(packet.event, ...packet.values)
    }
  })
  const { ConfigService } = localRequire("@nestjs/config")
  const { SharedDatabaseModule, recoverTestDatabase } = localRequire(
    "@lyrolab/nest-shared/database",
  )
  const databaseUrl = `postgres://fixture:fixture@${scenario.acquisition === "dns" ? "localhost" : "127.0.0.1"}:${scenario.port}/base`
  const database = SharedDatabaseModule.getTestDatabaseInfo(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  )
  try {
    await recoverTestDatabase({
      base: { databaseUrl, expectedRole: "fixture" },
      database,
      acquiredOid: 42,
      exclusiveTarget: true,
      timeoutMs: 500,
      closeTimeoutMs: 400,
    })
    process.send({ kind: "unexpected-return" })
  } catch (error) {
    process.send(
      {
        kind: "returned",
        code: error.code,
        outcome: error.outcome,
        failures: error.failures,
      },
      () => process.disconnect(),
    )
  }
}

async function observe(acquisition, boundary, races, directory) {
  const peers = new Set(),
    events = []
  let callerChild,
    child,
    watchdog = false,
    lossAt,
    closeAt,
    ceiling,
    result
  const log = (event, more = {}) =>
    events.push({ event, time: Date.now(), ...more })
  const packet = (code, text) => {
    const body = Buffer.from(text),
      data = Buffer.alloc(9 + body.length)
    data[0] = 82
    data.writeInt32BE(8 + body.length, 1)
    data.writeInt32BE(code, 5)
    body.copy(data, 9)
    return data
  }
  const server = net.createServer((socket) => {
    peers.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => {
      peers.delete(socket)
      log("peer-close")
    })
    let pending = Buffer.alloc(0),
      startup = true
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= (startup ? 4 : 5)) {
        const size = pending.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1)
        if (pending.length < size) return
        const data = pending.subarray(0, size)
        pending = pending.subarray(size)
        if (startup) {
          startup = false
          socket.write(packet(10, "SCRAM-SHA-256\0\0"))
        } else if (data[0] === 112) {
          const offset = data.indexOf(0, 5) + 5
          const nonce = data
            .subarray(offset)
            .toString()
            .match(/r=([^,]+)/)[1]
          socket.write(packet(11, `r=${nonce}fixture,s=Zml4dHVyZQ==,i=4096`))
        } else if (data[0] === 81 || data[0] === 69) log("query")
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const data = { acquisition, boundary, races, port: server.address().port }
  let callerExited,
    childExited,
    childDisconnected = false,
    childClosed = false,
    pipeClosed = 0,
    sends = 0
  let resolveCaller, resolveChild
  const callerDone = new Promise((resolve) => (resolveCaller = resolve))
  const childDone = new Promise((resolve) => (resolveChild = resolve))
  const check = () => {
    if (childExited && childDisconnected && pipeClosed === 2 && sends === 0) {
      closeAt = Date.now()
      resolveChild()
    }
  }
  const forward = (payload) => {
    if (callerChild.connected) callerChild.send(payload, () => {})
  }
  const loseCaller = () => {
    if (lossAt) return
    lossAt = Date.now()
    log("caller-loss")
    callerChild.kill("SIGKILL")
    if (child.connected) child.disconnect()
  }
  const timer = setTimeout(() => {
    watchdog = true
    callerChild?.kill("SIGKILL")
    child?.kill("SIGKILL")
  }, 2500)
  try {
    callerChild = spawn(
      process.execPath,
      [__filename, "--caller", JSON.stringify(data), directory],
      { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    )
    let stderr = ""
    callerChild.stderr.on("data", (chunk) => (stderr += chunk))
    callerChild.on("error", () => log("caller-error"))
    callerChild.on("close", (code, signal) => {
      callerExited = { code, signal }
      resolveCaller()
    })
    callerChild.on("message", (message) => {
      if (message.kind === "launch") {
        child = spawn(
          process.execPath,
          [__filename, "--engine", JSON.stringify(data), directory],
          { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] },
        )
        for (const pipe of [child.stdout, child.stderr]) {
          pipe.on("data", () => log("unexpected-output"))
          pipe.on("close", () => {
            pipeClosed++
            check()
          })
        }
        child.on("exit", (code, signal) => {
          childExited = { code, signal }
          log("child-exit")
          forward({ kind: "event", event: "exit", values: [code, signal] })
          check()
        })
        child.on("close", () => {
          childClosed = true
          closeAt = Date.now()
          check()
        })
        child.on("disconnect", () => {
          childDisconnected = true
          log("child-disconnect")
          forward({ kind: "event", event: "disconnect", values: [] })
          if (boundary === "disconnect") loseCaller()
          check()
        })
        child.on("error", () => log("child-error"))
        child.on("message", (value) => {
          if (value.audit) {
            log(value.audit, {
              started: value.started,
              settled: value.settled,
              queries: value.queries,
              until: value.until,
            })
            if (value.audit === "acquisition" && boundary === "work")
              loseCaller()
            if (value.audit === "finish-received" && boundary === "finish")
              loseCaller()
            return
          }
          log("child:" + value.type)
          if (value.type === "result") {
            result = value
            if (boundary === "result") {
              loseCaller()
              return
            }
          }
          if (value.type === "ready" && boundary === "ready") {
            loseCaller()
            return
          }
          forward({ kind: "event", event: "message", values: [value] })
        })
        if (boundary === "pre-ready") loseCaller()
      } else if (message.kind === "send") {
        if (
          message.message.type === "close" ||
          message.message.type === "cancel"
        )
          ceiling = message.message.closeUntil
        if (message.message.type === "permit-drop") log("permission")
        sends++
        try {
          child.send(message.message, (error) => {
            sends--
            forward({ kind: "ack", id: message.id, failed: !!error })
            check()
          })
        } catch {
          sends--
          forward({ kind: "ack", id: message.id, failed: true })
          check()
        }
      } else if (message.kind === "kill") {
        log("parent-kill")
        child.kill("SIGKILL")
      } else log(message.kind)
    })
    await Promise.all([callerDone, childDone])
    // The peer must close without fixture destruction providing the evidence.
    for (let n = 0; peers.size && n < 20; n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(watchdog, false)
    assert.equal(stderr, "")
    assert.deepEqual(callerExited, { code: null, signal: "SIGKILL" })
    assert.deepEqual(
      childExited,
      ["pre-ready", "ready"].includes(boundary)
        ? { code: 0, signal: null }
        : { code: null, signal: "SIGKILL" },
    )
    assert.equal(peers.size, 0)
    assert.ok(closeAt - lossAt < 400)
    if (ceiling) assert.ok(closeAt <= ceiling)
    assert.ok(
      !events.some((e) =>
        [
          "query",
          "permission",
          "settled",
          "returned",
          "parent-kill",
          "unexpected-output",
        ].includes(e.event),
      ),
    )
    if (!["pre-ready", "ready", "work"].includes(boundary)) {
      assert.equal(result.outcome, "not-attempted")
      assert.equal(result.failures[0].code, "DEADLINE_EXCEEDED")
      assert.equal(events.find((e) => e.event === "acquisition").started, 1)
    }
    const auditFile = path.join(
      directory,
      `${acquisition}-${boundary}-${races}.jsonl`,
    )
    const fences = fs.existsSync(auditFile)
      ? fs.readFileSync(auditFile, "utf8").trim().split("\n").map(JSON.parse)
      : []
    if (races)
      assert.ok(
        fences.length >= 4,
        "Repeated terminal/error/disconnect events must exercise the retained fence",
      )
    for (let n = 1; n < fences.length; n++)
      assert.ok(fences[n].until <= fences[n - 1].until)
    if (ceiling) for (const fence of fences) assert.ok(fence.until <= ceiling)
    const first = events[0].time
    const observation = {
      acquisition,
      boundary,
      races,
      passed: true,
      postLossMs: closeAt - lossAt,
      remainingCeilingMs: ceiling ? ceiling - closeAt : null,
      childExit: childExited,
      observedChannelsClosed: true,
      fixtureWatchdog: false,
      fenceAttempts: fences.length,
      events: events.map(({ time, ...e }) => ({
        ...e,
        elapsedMs: time - first,
      })),
    }
    console.log(JSON.stringify(observation))
  } finally {
    clearTimeout(timer)
    for (const owned of [callerChild, child])
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        owned.kill("SIGKILL")
        await (owned === child ? childDone : callerDone)
      }
    for (const peer of peers) peer.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function naturalControls(directory) {
  let source = fs.readFileSync(
    path.join(root, "src/database/fixtures/isolation-runner.cjs"),
    "utf8",
  )
  for (const file of [
    "isolation-scenarios.json",
    "recovery-fault-scenarios.json",
  ])
    source = source.replace(
      'require("./' + file + '")',
      "require(" +
        JSON.stringify(path.join(root, "src/database/fixtures", file)) +
        ")",
    )
  for (const module of [
    "@nestjs/config",
    "@lyrolab/nest-shared/database",
    "pg",
  ])
    source = source.replaceAll(
      "require(" + JSON.stringify(module) + ")",
      "require(" + JSON.stringify(localRequire.resolve(module)) + ")",
    )
  source = source.replaceAll(
    '"../../../dist/database/internal/test-database-recovery-child.js"',
    JSON.stringify(
      path.join(
        directory,
        "dist/database/internal/test-database-recovery-child.js",
      ),
    ),
  )
  source = source.replaceAll(
    '"../../../dist/database/helpers/test-database-session"',
    JSON.stringify(
      path.join(directory, "dist/database/helpers/test-database-session"),
    ),
  )
  source = source.replace(
    "const scenario = scenarios.find",
    `scenarios.push(...["dns","scram"].map(acquisition=>({name:acquisition+"-terminal-self",acquisition,terminalFence:true,code:"DEADLINE_EXCEEDED",outcome:"not-attempted",forced:true})));\nconst scenario = scenarios.find`,
  )
  source = source.replace(
    "const scenario = scenarios.find",
    `scenarios.push({name:"terminal-success-self",absent:true,terminalSuccessNative:true,terminalFence:true,code:"CLOSE_FAILED",outcome:"already-absent",forced:true});\nconst scenario = scenarios.find`,
  )
  source = source.replace(
    "close: async () => {",
    "close: async () => { if(scenario.terminalSuccessNative) void saturate();",
  )
  source = source.replace(
    "if (scenario.parentLoss) {",
    "if (scenario.parentLoss || scenario.terminalFence) {",
  )
  source = source.replace(
    "const elapsedMs = Math.round(performance.now() - started)",
    "assert.equal(emergencyWatchdog, false);\n    const elapsedMs = Math.round(performance.now() - started)",
  )
  source = source.replace(
    "childSelfDisposal: !!scenario.parentLoss",
    "childSelfDisposal: !!(scenario.parentLoss || scenario.terminalFence)",
  )
  const selected = [
    "terminal-success-self",
    "dns-terminal-self",
    "scram-terminal-self",
    "cancel-before-ready",
    "remove",
    "absent",
    "connect-failure",
    "close-failure",
    "cancel-before-permit",
    "cancel-after-permit",
    "permit-send-failure",
    "dns-deadline",
    "scram-deadline",
    "dns-parent-loss",
    "scram-parent-loss",
  ]
  source = source.replace(
    "for (const entry of scenarios)",
    "for (const entry of scenarios.filter(entry => " +
      JSON.stringify(selected) +
      ".includes(entry.name)))",
  )
  const entry = path.join(directory, "controls.cjs")
  fs.writeFileSync(entry, source, { mode: 0o600 })
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = "",
    watchdog = false
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const timer = setTimeout(() => {
    watchdog = true
    child.kill("SIGKILL")
  }, 30000)
  const exit = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  )
  clearTimeout(timer)
  assert.equal(watchdog, false)
  assert.deepEqual(exit, { code: 0, signal: null }, stderr.slice(0, 900))
  const observations = stdout.trim().split("\n").map(JSON.parse)
  assert.equal(observations.length, selected.length)
  for (const observation of observations)
    console.log(JSON.stringify({ control: true, ...observation }))
}

async function main() {
  const base =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR
  assert.ok(base, "Set run-owned scratch")
  const directory = fs.mkdtempSync(path.join(base, "retained-fence-"))
  try {
    fs.cpSync(path.join(root, "dist"), path.join(directory, "dist"), {
      recursive: true,
    })
    fs.symlinkSync(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    )
    adaptedEntry(directory)
    for (const acquisition of ["dns", "scram"])
      for (const boundary of [
        "pre-ready",
        "ready",
        "work",
        "result",
        "finish",
        "disconnect",
      ])
        await observe(acquisition, boundary, false, directory)
    for (const acquisition of ["dns", "scram"])
      await observe(acquisition, "finish", true, directory)
    await naturalControls(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
Promise.resolve(
  process.argv[2] === "--engine"
    ? engine()
    : process.argv[2] === "--caller"
      ? caller()
      : main(),
).catch((error) => {
  console.error("Retained-fence prerequisite failed", error.message)
  process.exitCode = 1
})
