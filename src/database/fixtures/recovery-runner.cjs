const { ConfigService } = require("@nestjs/config")
const { DataSource } = require("typeorm")
const { Client } = require("pg")
const {
  SharedDatabaseModule: Database,
  recoverTestDatabase,
  TestDatabaseRecoveryError,
} = require("@lyrolab/nest-shared/database")

const config = new ConfigService()
const databaseUrl = config.get("DATABASE_URL")
const base = databaseUrl
  ? {
      databaseUrl,
      expectedRole: decodeURIComponent(new URL(databaseUrl).username),
    }
  : undefined
const send = (value) => process.send(value)
const finish = () => process.disconnect()

async function recover(input) {
  if (input.options) {
    fault = input.fault
    input = input.options
  }
  const childProcess = require("node:child_process")
  const spawn = childProcess.spawn
  childProcess.spawn = (executable, args, options) =>
    spawn(executable, [__filename, "--engine", fault ?? "none"], options)
  const controller = new AbortController()
  process.on("message", (message) => {
    if (message === "abort") controller.abort()
  })
  try {
    const result = await recoverTestDatabase({
      ...input,
      base: input.base ?? base,
      signal: controller.signal,
    })
    send({ result })
  } catch (error) {
    if (!(error instanceof TestDatabaseRecoveryError)) throw error
    send({
      failure: {
        code: error.code,
        phase: error.phase,
        outcome: error.outcome,
        failures: error.failures,
      },
    })
  } finally {
    finish()
  }
}

let armed
let fault
let dropped = false
let releaseBarrier
const baseClients = new WeakSet()
async function barrier(phase) {
  if (armed !== phase) return
  armed = undefined
  send({ barrier: phase })
  await new Promise((resolve) => {
    releaseBarrier = resolve
  })
}
const originalQuery = Client.prototype.query
Client.prototype.query = function (...args) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text
  if (sql?.includes("pg_try_advisory_lock")) baseClients.add(this)
  const phase = sql?.startsWith("CREATE DATABASE")
    ? "create"
    : sql?.includes("SELECT oid FROM pg_database WHERE datname = $1")
      ? "inspect"
      : undefined
  if (phase && armed === phase)
    return barrier(phase).then(() => originalQuery.apply(this, args))
  if (
    fault === "verify" &&
    dropped &&
    sql?.includes("WHERE datname = $1 OR oid")
  )
    return Promise.reject(new Error("Injected verification failure"))
  const result = originalQuery.apply(this, args)
  if (sql?.startsWith("DROP DATABASE"))
    return result.then((value) => {
      dropped = true
      if (fault?.startsWith("drop-ack"))
        throw new Error("Injected acknowledgement failure")
      return value
    })
  return result
}
const originalEnd = Client.prototype.end
Client.prototype.end = function (...args) {
  if (baseClients.has(this) && armed === "lease-close")
    return barrier("lease-close").then(() => originalEnd.apply(this, args))
  const result = originalEnd.apply(this, args)
  if (baseClients.has(this) && fault?.includes("close")) {
    fault = undefined
    return result.then(() => {
      throw new Error("Injected close failure")
    })
  }
  return result
}
const originalSynchronize = DataSource.prototype.synchronize
DataSource.prototype.synchronize = async function (...args) {
  await barrier("schema")
  return originalSynchronize.apply(this, args)
}
const originalDestroy = DataSource.prototype.destroy
DataSource.prototype.destroy = async function (...args) {
  await barrier("target-close")
  return originalDestroy.apply(this, args)
}

async function create() {
  Database.forTest({ entities: [] })
  await Database.setupTestDatabase(config)
  const database = Database.getTestDatabaseInfo(config)
  const source = Database.getTestDataSource()
  await source.query("CREATE TABLE sentinel (id integer PRIMARY KEY)")
  await source.query("INSERT INTO sentinel VALUES (7)")
  const [{ oid }] = await source.query(
    "SELECT oid FROM pg_database WHERE datname = current_database()",
  )
  send({ ready: { database, acquiredOid: oid, exclusiveTarget: true } })
  process.on("message", (message) => {
    void (async () => {
      if (message === "release") {
        releaseBarrier?.()
      } else if (typeof message === "object" && message.operation) {
        armed = message.phase
        if (message.operation === "recreate") {
          await Database.closeTestConnection()
          await Database.setupTestDatabase(config)
        } else if (message.operation === "clear") {
          await Database.clearTestDatabase()
        } else if (message.operation === "close") {
          await Database.closeTestConnection()
        }
        send({ completed: message.operation })
      } else if (message === "unsafe") {
        let refused = 0
        for (const action of [
          () => Database.getTestDataSource(),
          () => Database.clearTestDatabase(),
          () => Database.setupTestDatabase(config),
        ]) {
          try {
            await action()
          } catch {
            refused++
          }
        }
        send({ refused })
      } else if (message === "failed-close") {
        fault = "close"
        try {
          await Database.closeTestConnection()
          send({ closeFailed: false })
        } catch {
          send({ closeFailed: true })
        }
      } else if (message === "retry-close") {
        try {
          await Database.closeTestConnection()
          send({ cleanup: "closed" })
        } catch {
          send({ cleanup: "refused" })
        }
      } else if (message === "clear") {
        await Database.clearTestDatabase()
        send({ cleared: true })
      } else if (message === "close") {
        await Database.resetTestDatabase()
        send({ closed: true })
        finish()
      } else if (message === "sentinel") {
        send({ sentinel: await source.query("SELECT id FROM sentinel") })
      }
    })().catch(fail)
  })
}

function fail() {
  process.exitCode = 1
  send({ fixtureFailure: true })
  if (process.connected) finish()
}

if (process.argv[2] === "--engine") {
  fault = process.argv[3] === "none" ? undefined : process.argv[3]
  require("../../../dist/database/internal/test-database-recovery-child.js")
} else if (process.argv[2] === "creator") void create().catch(fail)
else process.once("message", (input) => void recover(input).catch(fail))
