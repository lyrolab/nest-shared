const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { once } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")

const childSource = String.raw`
;(async () => {
  const { pbkdf2 } = require('node:crypto')
  const { performance } = require('node:perf_hooks')
  const { ConfigService } = require('@nestjs/config')
  const { Client } = require('pg')
  const { SharedDatabaseModule: Database, recoverTestDatabase } = require('@lyrolab/nest-shared/database')
  await Promise.all([import('pg'), import('node:fs'), import('node:fs/promises'), import('node:net')])
  const files = require('node:fs/promises')
  const originalOpen = files.open
  let opensStarted = 0
  let opensSettled = 0
  let dispatches = 0
  files.open = async (...args) => {
    opensStarted++
    try { return await originalOpen(...args) }
    finally { opensSettled++ }
  }
  for (const key of ['connect', 'query']) {
    const original = Client.prototype[key]
    Client.prototype[key] = function (...args) { dispatches++; return original.apply(this, args) }
  }
  const url = new URL('postgres://fixture:fixture@127.0.0.1:1/base')
  url.searchParams.set('sslmode', 'verify-full')
  url.searchParams.set('sslrootcert', process.argv[1])
  const mode = process.argv[2]
  const database = Database.getTestDatabaseInfo(new ConfigService({ DATABASE_URL: url.toString() }))
  const controller = new AbortController()
  const started = performance.now()
  const jobs = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    pbkdf2('local', 'fixture', 1000000, 32, 'sha256', error => error ? reject(error) : resolve())
  }))
  let settled = false
  const observation = new Promise(resolve => setTimeout(() => resolve({
    observationMs: Math.round(performance.now() - started),
    settledAtObservation: settled,
    opensStartedAtObservation: opensStarted,
    opensSettledAtObservation: opensSettled,
  }), 150))
  let abortAtMs
  const abortTimer = mode === 'cancel' ? setTimeout(() => {
    abortAtMs = Math.round(performance.now() - started)
    controller.abort()
  }, 20) : undefined
  let failure
  try {
    await recoverTestDatabase({
      base: { databaseUrl: url.toString(), expectedRole: 'fixture' },
      database, acquiredOid: 1, exclusiveTarget: true,
      timeoutMs: 40, closeTimeoutMs: 40, signal: controller.signal,
    })
  } catch (error) { failure = { code: error.code, phase: error.phase, outcome: error.outcome } }
  finally { clearTimeout(abortTimer); settled = true }
  const settledMs = Math.round(performance.now() - started)
  const report = await observation
  await Promise.all(jobs)
  console.log(JSON.stringify({ mode, threadpoolSize: 4, workBudgetMs: 40, closeBudgetMs: 40,
    ...report, abortAtMs, settledMs, dispatches, opensStarted, opensSettled, ...failure }))
})().catch(() => { console.error('Queued configuration probe failed'); process.exitCode = 1 })
`

async function main() {
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR
  assert.ok(scratch)
  const dir = fs.mkdtempSync(path.join(scratch, "review-queued-config-"))
  const filename = path.join(dir, "regular-ca.pem")
  fs.writeFileSync(filename, "regular local fixture", { mode: 0o600 })
  try {
    for (const mode of ["deadline", "cancel"]) {
      const child = spawn(
        process.execPath,
        ["-e", childSource, filename, mode],
        {
          cwd: process.cwd(),
          env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
      const exited = once(child, "exit")
      let stdout = "",
        stderr = "",
        watchdogFired = false
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      const timer = setTimeout(() => {
        watchdogFired = true
        child.kill("SIGKILL")
      }, 15000)
      try {
        const [code, signal] = await exited
        assert.equal(watchdogFired, false)
        assert.equal(code, 0)
        assert.equal(signal, null)
        assert.equal(stderr, "")
        const report = JSON.parse(stdout)
        assert.equal(report.dispatches, 0)
        assert.equal(report.outcome, "not-attempted")
        console.log(JSON.stringify({ ...report, naturalExitCode: code }))
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(() => {
  console.error("Queued configuration probe failed")
  process.exitCode = 1
})
