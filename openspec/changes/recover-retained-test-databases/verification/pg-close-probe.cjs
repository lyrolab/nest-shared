const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { once } = require("node:events")
const net = require("node:net")
const { Client } = require("pg")

const closeBudgetMs = 100
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function observe(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function child(scenario, port) {
  const client = new Client({
    host: "127.0.0.1",
    port: Number(port),
    user: "probe",
    database: "probe",
    password: "",
    ssl: false,
    connectionTimeoutMillis: closeBudgetMs,
    query_timeout: closeBudgetMs,
    statement_timeout: closeBudgetMs,
    lock_timeout: closeBudgetMs,
  })
  client.on("error", () => {})
  await client.connect()
  let query
  if (scenario === "active") {
    query = client.query("SELECT 1").catch(() => {})
    await delay(10)
  }
  const closing = client.end()
  const closeSettled = await observe(closing, closeBudgetMs)
  const repeatedEndSettled = await observe(client.end(), closeBudgetMs)
  console.log(JSON.stringify({ closeSettled, repeatedEndSettled }))
  await closing
  await query
}

async function probe(scenario) {
  const peers = new Set()
  // Keep the peer's readable side open after the client's graceful FIN.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket)
    socket.on("close", () => peers.delete(socket))
    socket.on("error", () => {})
    socket.once("data", () => {
      // AuthenticationOk and ReadyForQuery; no live database or credentials.
      socket.write(
        Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const childProcess = spawn(process.execPath, [
    __filename,
    "--child",
    scenario,
    String(server.address().port),
  ])
  const exited = once(childProcess, "exit")
  const reported = new Promise((resolve, reject) => {
    let output = ""
    childProcess.stdout.on("data", (chunk) => {
      output += chunk.toString()
      if (output.includes("\n")) {
        try {
          resolve(JSON.parse(output.trim()))
        } catch {
          reject(new Error("Invalid probe report"))
        }
      }
    })
    childProcess.on("error", reject)
  })
  let watchdog
  try {
    const report = await Promise.race([
      reported,
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("Probe child did not report")),
          5000,
        )
      }),
    ])
    clearTimeout(watchdog)
    const naturalExitBeforePeerCleanup = await observe(exited, 200)
    const expected = scenario === "active"
    assert.equal(report.closeSettled, expected)
    assert.equal(report.repeatedEndSettled, expected)
    assert.equal(naturalExitBeforePeerCleanup, expected)
    for (const peer of peers) peer.destroy()
    assert.equal(await observe(exited, 1000), true)
    const [code, signal] = await exited
    assert.equal(code, 0)
    assert.equal(signal, null)
    console.log(
      JSON.stringify({
        driver: require("pg/package.json").version,
        scenario,
        closeBudgetMs,
        ...report,
        naturalExitBeforePeerCleanup,
        exitCodeAfterPeerCleanup: code,
      }),
    )
  } finally {
    clearTimeout(watchdog)
    for (const peer of peers) peer.destroy()
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      if (!(await observe(exited, 1000))) childProcess.kill()
      await exited
    }
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  if (process.argv[2] === "--child") {
    await child(process.argv[3], process.argv[4])
  } else {
    for (const scenario of ["active", "idle"]) await probe(scenario)
  }
}

main().catch(() => {
  console.error("Driver close probe failed")
  process.exitCode = 1
})
