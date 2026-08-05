import {
  a as slowReport,
  c as flakyReport,
  i as isLedgerEvent,
  l as contentionReport,
  n as ingestAll,
  o as shapeReport,
  r as ingestRun,
  s as runsReport,
  t as openLedger,
  u as table,
} from './open-W_R1LvBi.mjs'
import {
  a as runDir,
  i as ledgerDir,
  n as eventsPath,
  o as runsDir,
  r as ingestLockPath,
  t as databasePath,
} from './paths-BtOSn20v.mjs'
import { n as classifyFailure, t as mintRunId } from './run-id-DJVHgJq8.mjs'
import { availableParallelism, freemem, hostname, loadavg, totalmem } from 'node:os'
import { appendFileSync, mkdirSync } from 'node:fs'

//#region src/envelope.ts
/**
 * Appends events, swallowing every failure.
 *
 * Shared by the envelope and the sampler for the same reason the reporter has
 * its own copy of this logic: telemetry must never be able to fail the thing
 * it is measuring, and the wrapper this runs in is the parent of the entire
 * test run. Synchronous on purpose: this is called from a synchronous wrapper
 * process, including at process-exit, where nothing awaits it and an
 * unawaited async write could be lost entirely.
 */
function appendEvents(runId, pid, events) {
  if (events.length === 0) return
  try {
    mkdirSync(runDir(runId), { recursive: true })
    appendFileSync(
      eventsPath(runId, pid),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
  } catch {}
}
/** Writes the `run_start` event that opens a run's envelope. */
function writeRunStart(runId, fields) {
  const event = {
    kind: 'run_start',
    runId,
    startedAt: Date.now(),
    hostId: hostname(),
    cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
    ...fields,
  }
  appendEvents(runId, process.pid, [event])
}
/** Writes the `run_end` event that closes a run's envelope. */
function writeRunEnd(runId, exitCode) {
  const event = {
    kind: 'run_end',
    runId,
    endedAt: Date.now(),
    exitCode,
  }
  appendEvents(runId, process.pid, [event])
}

//#endregion
//#region src/sampler.ts
/**
 * Samples host load for the life of the run, returning a stop function.
 *
 * The timeline is what makes a slow file attributable. Start and end
 * snapshots cannot distinguish a run that was calm throughout from one
 * crushed at minute three, and per-file absolute timestamps are only useful
 * if there is something to join them against.
 *
 * `unref()` so a hung stop call can never keep the wrapper process alive.
 */
function startSampler(runId, options) {
  const intervalMs = options.intervalMs ?? 5e3
  const write = () => {
    const [load1 = 0, load5 = 0] = loadavg()
    const event = {
      kind: 'sample',
      runId,
      at: Date.now(),
      load1,
      load5,
      freeMemoryBytes: freemem(),
      liveSlots: options.liveSlots(),
    }
    appendEvents(runId, process.pid, [event])
  }
  write()
  const timer = setInterval(write, intervalMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    write()
  }
}

//#endregion
//#region src/turbo-summary.ts
/**
 * Parses Turbo's `--summarize` output into per-task events.
 *
 * This is free data: Turbo already records per-package timing and cache
 * status, so the only cost is passing the flag and reading the file. Cache
 * status is what makes the `--force` question answerable: it is the
 * difference between "this run executed 69 tasks" and "this run executed 69
 * tasks that a warm cache would have served".
 *
 * Returns nothing rather than throwing for unusable input: an absent or
 * malformed summary is a missing dimension, never a failed run.
 */
function parseTurboSummary(contents, runId) {
  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const tasks = parsed.tasks
  if (!Array.isArray(tasks)) return []
  const events = []
  for (const entry of tasks) {
    if (typeof entry !== 'object' || entry === null) continue
    const task = entry
    if (typeof task.package !== 'string' || typeof task.task !== 'string') continue
    const startTime = typeof task.execution?.startTime === 'number' ? task.execution.startTime : 0
    const endTime = typeof task.execution?.endTime === 'number' ? task.execution.endTime : 0
    events.push({
      kind: 'turbo_task',
      runId,
      packageName: task.package,
      task: task.task,
      durationMs: Math.max(0, endTime - startTime),
      cacheStatus: typeof task.cache?.status === 'string' ? task.cache.status : 'UNKNOWN',
    })
  }
  return events
}

//#endregion
export {
  appendEvents,
  classifyFailure,
  contentionReport,
  databasePath,
  eventsPath,
  flakyReport,
  ingestAll,
  ingestLockPath,
  ingestRun,
  isLedgerEvent,
  ledgerDir,
  mintRunId,
  openLedger,
  parseTurboSummary,
  runDir,
  runsDir,
  runsReport,
  shapeReport,
  slowReport,
  startSampler,
  table,
  writeRunEnd,
  writeRunStart,
}
