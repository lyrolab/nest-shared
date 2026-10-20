const { ConfigService } = require("@nestjs/config")
const {
  SharedDatabaseModule: Database,
  recoverTestDatabase,
  TestDatabaseRecoveryError,
} = require("@lyrolab/nest-shared/database")

const config = new ConfigService()
const databaseUrl = config.get("DATABASE_URL")
const base = {
  databaseUrl,
  expectedRole: decodeURIComponent(new URL(databaseUrl).username),
}
const send = (value) => process.send(value)
const finish = () => process.disconnect()

async function recover(input) {
  try {
    const result = await recoverTestDatabase({
      ...input,
      base: input.base ?? base,
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
      if (message === "clear") {
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

if (process.argv[2] === "creator") void create().catch(fail)
else process.once("message", (input) => void recover(input).catch(fail))
