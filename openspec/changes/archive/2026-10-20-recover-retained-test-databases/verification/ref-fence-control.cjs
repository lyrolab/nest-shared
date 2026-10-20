const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")

async function observe(retainFence) {
  const source = `
    const { performance } = require('node:perf_hooks');
    const started = performance.now();
    let beforeExit = false;
    process.on('beforeExit', () => { beforeExit = true; });
    ${
      retainFence
        ? `setTimeout(() => {
      process.stdout.write(JSON.stringify({ beforeExit, elapsedMs: Math.round(performance.now() - started) }));
      process.kill(process.pid, 'SIGKILL');
    }, 100);`
        : ""
    }
  `
  const child = spawn(process.execPath, ["-e", source], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  let watchdog = false
  const timer = setTimeout(() => {
    watchdog = true
    child.kill("SIGKILL")
  }, 2000)
  const result = await new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  )
  clearTimeout(timer)
  assert.equal(watchdog, false)
  assert.equal(stderr, "")
  if (retainFence) {
    assert.deepEqual(result, { code: null, signal: "SIGKILL" })
    const observation = JSON.parse(stdout)
    assert.equal(observation.beforeExit, false)
    assert.ok(observation.elapsedMs >= 90)
    return { retainFence, ...result, ...observation }
  }
  assert.deepEqual(result, { code: 0, signal: null })
  return { retainFence, ...result }
}

async function main() {
  console.log(JSON.stringify(await observe(false)))
  console.log(JSON.stringify(await observe(true)))
}
main().catch(() => {
  console.error("Referenced-fence control failed")
  process.exitCode = 1
})
