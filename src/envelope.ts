import { appendFileSync, mkdirSync } from 'node:fs'
import { availableParallelism, hostname, totalmem } from 'node:os'

import type { LedgerEvent, RunEndEvent, RunStartEvent } from './events.ts'
import { eventsPath, runDir } from './paths.ts'

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
export function appendEvents(runId: string, pid: number, events: readonly LedgerEvent[]): void {
  if (events.length === 0) return
  try {
    mkdirSync(runDir(runId), { recursive: true })
    appendFileSync(
      eventsPath(runId, pid),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
  } catch {
    /** Deliberately silent. */
  }
}

type RunStartFields = Omit<
  RunStartEvent,
  'kind' | 'runId' | 'startedAt' | 'hostId' | 'cpuCount' | 'totalMemoryBytes'
>

/** Writes the `run_start` event that opens a run's envelope. */
export function writeRunStart(runId: string, fields: RunStartFields): void {
  const event: RunStartEvent = {
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
export function writeRunEnd(runId: string, exitCode: number): void {
  const event: RunEndEvent = { kind: 'run_end', runId, endedAt: Date.now(), exitCode }
  appendEvents(runId, process.pid, [event])
}
