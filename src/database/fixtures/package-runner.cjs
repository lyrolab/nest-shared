const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const root = path.resolve(__dirname, "../../..")
const scratch =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR
assert.ok(scratch)
const directory = fs.mkdtempSync(path.join(scratch, "packed public API "))
const lock = require(path.join(root, "package-lock.json"))
function run(executable, args, cwd = directory) {
  try {
    return execFileSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout: 240000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    fs.writeFileSync(
      path.join(scratch, "packed-failure.log"),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
      { mode: 0o600 },
    )
    throw new Error("Packed package check failed")
  }
}
async function main() {
  const [packed] = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      root,
    ),
  )
  assert.ok(
    packed.files.some(
      (entry) =>
        entry.path === "dist/database/internal/test-database-recovery-child.js",
    ),
  )
  assert.ok(!packed.files.some((entry) => /(^|\/)fixtures\//.test(entry.path)))
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ private: true }),
  )
  const dependencies = [
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/config",
    "@nestjs/typeorm",
    "typeorm",
    "pg",
    "rxjs",
    "reflect-metadata",
    "jest",
  ].map((name) => `${name}@${lock.packages["node_modules/" + name].version}`)
  run("npm", [
    "install",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    path.join(directory, packed.filename),
    ...dependencies,
    "vitest@3.2.4",
  ])
  fs.writeFileSync(
    path.join(directory, "probe.cjs"),
    `
const assert = require("node:assert/strict")
const net = require("node:net")
const childProcess = require("node:child_process")
const { once } = require("node:events")
const { ConfigService } = require("@nestjs/config")
module.exports = async function probe(supplied) {
  const api = supplied ?? require("@lyrolab/nest-shared/database")
  const server = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const spawn = childProcess.spawn
  let child, exited = false, disconnected = false, sends = 0
  childProcess.spawn = (exe, args, options) => {
    if (process.argv.includes("--deny")) throw new Error("Fixture launch denied")
    assert.equal(exe, process.execPath)
    assert.equal(args.length, 1)
    assert.ok(args[0].startsWith(__dirname))
    assert.equal(options.shell, false)
    assert.equal(options.detached, false)
    assert.deepEqual(options.env, {})
    child = spawn(exe, args, options)
    child.on("exit", () => { exited = true })
    child.on("disconnect", () => { disconnected = true })
    const send = child.send.bind(child)
    child.send = (value, callback) => {
      sends++
      return send(value, (error) => { sends--; callback(error) })
    }
    return child
  }
  try {
    const databaseUrl = "postgres://fixture:fixture@127.0.0.1:" + server.address().port + "/base"
    const database = api.SharedDatabaseModule.getTestDatabaseInfo(new ConfigService({DATABASE_URL:databaseUrl}))
    const options = {base:{databaseUrl,expectedRole:"fixture"},database,acquiredOid:42,exclusiveTarget:true,timeoutMs:4000,closeTimeoutMs:1000}
    const controller = new AbortController();controller.abort()
    await assert.rejects(api.recoverTestDatabase({...options,signal:controller.signal}), (error) => error.code === "CANCELLED" && error.outcome === "not-attempted")
    assert.equal(child, undefined)
    await assert.rejects(api.recoverTestDatabase(options), (error) => error instanceof api.TestDatabaseRecoveryError && error.code === "DATABASE_FAILURE" && error.phase === "connect" && error.outcome === "not-attempted")
    if (!process.argv.includes("--deny")) {
      assert.ok(child)
      assert.equal(exited, true)
      assert.equal(disconnected, true)
      assert.equal(sends, 0)
      assert.equal(child.exitCode, 0)
    }
  } finally {
    childProcess.spawn = spawn
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");child.kill("SIGKILL");await closed
    }
    await new Promise((resolve) => server.close(resolve))
  }
}
if (require.main === module) module.exports().catch(() => { console.error("Packed API probe failed");process.exitCode = 1 })
`,
  )
  fs.writeFileSync(
    path.join(directory, "probe.mjs"),
    `import * as api from "@lyrolab/nest-shared/database"\nimport probe from "./probe.cjs"\nawait probe(api)\n`,
  )
  fs.writeFileSync(
    path.join(directory, "public.test.cjs"),
    `test("packed public API owns its private child", require("./probe.cjs"), 15000)\n`,
  )
  fs.writeFileSync(
    path.join(directory, "jest.config.cjs"),
    `module.exports = { testMatch: ["**/public.test.cjs"], testEnvironment: "node" }\n`,
  )
  fs.writeFileSync(
    path.join(directory, "vitest.config.mjs"),
    `export default { test: { include: ["public.test.cjs"], globals: true, pool: "forks", maxWorkers: 1, minWorkers: 1 } }\n`,
  )
  for (const entry of ["probe.cjs", "probe.mjs"]) run(process.execPath, [entry])
  run(process.execPath, ["probe.cjs", "--deny"])
  run(process.execPath, [
    path.join(directory, "node_modules/jest/bin/jest.js"),
    "--runInBand",
    "--silent",
  ])
  run(process.execPath, [
    path.join(directory, "node_modules/vitest/vitest.mjs"),
    "run",
    "--silent",
  ])
  const pg = path.join(directory, "node_modules/pg")
  fs.renameSync(pg, pg + ".unavailable")
  try {
    for (const entry of ["probe.cjs", "probe.mjs"])
      run(process.execPath, [entry])
  } finally {
    fs.renameSync(pg + ".unavailable", pg)
  }
  console.log(
    JSON.stringify({
      passed: true,
      cases: 7,
      fixtureFiles: 0,
      privateEntry: true,
      naturalCallerExits: 7,
      vitest: "3.2.4",
      packageLockSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(directory, "package-lock.json")))
        .digest("hex"),
    }),
  )
}
main()
  .catch(() => {
    console.error("Packed package compatibility failed")
    process.exitCode = 1
  })
  .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
