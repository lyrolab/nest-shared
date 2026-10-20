const assert = require("node:assert/strict")
const { once } = require("node:events")
const childProcess = require("node:child_process")
const path = require("node:path")
const scenarios = [
  ...require("./isolation-scenarios.json"),
  ...require("./recovery-fault-scenarios.json"),
]
const scenario = scenarios.find((entry) => entry.name === process.argv[3])

function childFixture() {
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
      const result = originalSend(message, (error) => {
        pendingSends--
        callback(error)
      })
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
  const databaseUrl = "postgres://fixture:fixture@127.0.0.1/base"
  const database = Database.getTestDatabaseInfo(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  )
  if (scenario.preabort) controller.abort()
  const started = performance.now()
  try {
    const result = await recoverTestDatabase({
      base: { databaseUrl, expectedRole: "fixture" },
      database,
      acquiredOid: 42,
      exclusiveTarget: true,
      timeoutMs: scenario.stall ? 500 : 2000,
      closeTimeoutMs: 400,
      signal: controller.signal,
    })
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
  if (scenario.preabort || scenario.deniedLaunch) assert.equal(owned, undefined)
  else {
    assert.equal(exited, true)
    assert.equal(disconnected, true)
    assert.equal(pendingSends, 0)
    if (scenario.forced || scenario.crash)
      assert.equal(owned.signalCode, "SIGKILL")
    else if (!scenario.missingEntry)
      assert.equal(owned.exitCode, 0, JSON.stringify(trace))
  }
  assert.ok(performance.now() - started < (scenario.stall ? 500 : 2000) + 400)
  console.log(JSON.stringify({ name: scenario.name, passed: true }))
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
          name: entry.name,
          passed: true,
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
