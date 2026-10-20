const assert = require("node:assert/strict")
const fs = require("node:fs")
const acquisition = process.argv[2] ?? "scram"
assert.ok(["dns", "scram"].includes(acquisition))
const path = require("node:path")
const { spawn } = require("node:child_process")
const { createRequire } = require("node:module")
const { setTimeout: delay } = require("node:timers/promises")

async function main() {
  const root = process.cwd()
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR
  assert.ok(scratch, "Set the run-owned scratch directory")
  const localRequire = createRequire(path.join(root, "package.json"))
  const directory = fs.mkdtempSync(path.join(scratch, "finish-parent-loss-"))
  const entry = path.join(directory, "fixture.cjs")
  const evidence = path.join(directory, "events.jsonl")
  let source = fs.readFileSync(
    path.join(root, "src/database/fixtures/isolation-runner.cjs"),
    "utf8",
  )
  const replace = (from, to) => {
    assert.ok(source.includes(from), "The tracked fixture input changed")
    source = source.replace(from, to)
  }
  replace(
    '...require("./isolation-scenarios.json"),',
    "...require(" +
      JSON.stringify(
        path.join(root, "src/database/fixtures/isolation-scenarios.json"),
      ) +
      "),",
  )
  replace(
    '...require("./recovery-fault-scenarios.json"),',
    "...require(" +
      JSON.stringify(
        path.join(root, "src/database/fixtures/recovery-fault-scenarios.json"),
      ) +
      "),",
  )
  replace(
    "const scenario = scenarios.find",
    `scenarios.push({name:"finish-parent-loss",acquisition:${JSON.stringify(acquisition)},finishLoss:true,code:"DEADLINE_EXCEEDED",outcome:"not-attempted",forced:true});\nlet auditStarted=0,auditSettled=0;\nconst scenario = scenarios.find`,
  )
  source = source.replaceAll(
    '"../../../dist/database/internal/test-database-recovery-child.js"',
    JSON.stringify(
      path.join(root, "dist/database/internal/test-database-recovery-child.js"),
    ),
  )
  source = source.replaceAll(
    '"../../../dist/database/helpers/test-database-session"',
    JSON.stringify(
      path.join(root, "dist/database/helpers/test-database-session"),
    ),
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
  replace(
    "function acquisitionFixture() {",
    `function acquisitionFixture() {
    if (scenario.finishLoss) {
      let finished = false;
      const traceFile = ${JSON.stringify(evidence)};
      const log = (event, extra={}) => fs.appendFileSync(traceFile, JSON.stringify({event,time:Date.now(),...extra})+"\\n",{mode:0o600});
      const send = process.send.bind(process);
      process.send = (message,...args) => {
        if(message.type === "result") log("result",{outcome:message.outcome,failures:message.failures});
        return send(message,...args);
      };
      process.prependListener("message", message => {
        if(message.type === "finish") { finished = true; log("finish-received"); }
      });
      process.prependListener("disconnect", () => {
        log(finished ? "disconnect-after-finish" : "disconnect-before-finish");
        setTimeout(() => {
          log("still-alive-1000ms-after-disconnect",{acquisitions:auditStarted,settlements:auditSettled});
          process.kill(process.pid,"SIGKILL");
        },1000);
      });
    }`,
  )
  replace(
    "const report = (event) => {",
    `const report = (event) => {
    if(scenario.finishLoss) {
      if(event === "acquisition") auditStarted++;
      if(event === "settled") auditSettled++;
      fs.appendFileSync(${JSON.stringify(evidence)},JSON.stringify({event,time:Date.now()})+"\\n",{mode:0o600});
    }`,
  )
  replace(
    "if (scenario.earlyCancel) controller.abort()",
    'if(scenario.finishLoss) owned.once("disconnect",()=>process.kill(process.pid,"SIGKILL"));\n      if (scenario.earlyCancel) controller.abort()',
  )
  fs.writeFileSync(entry, source, { mode: 0o600 })
  let caller
  try {
    caller = spawn(
      process.execPath,
      [entry, "--caller", "finish-parent-loss"],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    let stderr = ""
    caller.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const watchdog = setTimeout(() => caller.kill("SIGKILL"), 8000)
    const exit = await new Promise((resolve) =>
      caller.once("close", (code, signal) => resolve({ code, signal })),
    )
    clearTimeout(watchdog)
    await delay(1400)
    const events = fs.existsSync(evidence)
      ? fs.readFileSync(evidence, "utf8").trim().split("\n").map(JSON.parse)
      : []
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" })
    assert.equal(stderr, "")
    assert.ok(events.some((event) => event.event === "finish-received"))
    const disconnect = events.find(
      (event) => event.event === "disconnect-after-finish",
    )
    const late = events.find(
      (event) => event.event === "still-alive-1000ms-after-disconnect",
    )
    assert.ok(disconnect && late)
    assert.equal(late.acquisitions, 1)
    assert.equal(late.settlements, 0)
    assert.ok(!events.some((event) => event.event === "query"))
    const started = events[0].time
    console.log(
      JSON.stringify({
        findingReproduced: true,
        acquisition,
        caller: exit,
        events: events.map(({ time, ...event }) => ({
          ...event,
          elapsedMs: time - started,
        })),
        postDisconnectMs: late.time - disconnect.time,
        fixtureWatchdogSelfDisposal: true,
      }),
    )
  } finally {
    if (caller && caller.exitCode === null && caller.signalCode === null) {
      const closed = new Promise((resolve) => caller.once("close", resolve))
      caller.kill("SIGKILL")
      await closed
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(() => {
  console.error("Parent-loss reproducer did not reach its expected observation")
  process.exitCode = 1
})
