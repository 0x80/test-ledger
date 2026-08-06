import { i as LedgerEvent, l as TurboTaskEvent, o as RunStartEvent } from './events-BisYort7.mjs'

//#region src/envelope.d.ts

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
declare function appendEvents(runId: string, pid: number, events: readonly LedgerEvent[]): void
type RunStartFields = Omit<
  RunStartEvent,
  'kind' | 'runId' | 'startedAt' | 'hostId' | 'cpuCount' | 'totalMemoryBytes'
>
/** Writes the `run_start` event that opens a run's envelope. */
declare function writeRunStart(runId: string, fields: RunStartFields): void
/** Writes the `run_end` event that closes a run's envelope. */
declare function writeRunEnd(runId: string, exitCode: number): void
//#endregion
//#region src/sampler.d.ts
type SamplerOptions = {
  intervalMs?: number
  liveSlots: () => number
}
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
declare function startSampler(runId: string, options: SamplerOptions): () => void
//#endregion
//#region src/turbo-summary.d.ts
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
declare function parseTurboSummary(contents: string, runId: string): TurboTaskEvent[]
//#endregion
//#region src/run-id.d.ts
/**
 * A fresh 128-bit id per run.
 *
 * Unlike `review-ledger`, which derives its run id from ledger identity so a
 * republish is idempotent, a test run has no natural key: the same branch on
 * the same machine is run over and over, and each of those IS a distinct run.
 * Random is therefore correct here, not merely convenient.
 */
declare function mintRunId(): string
//#endregion
export {
  writeRunEnd as a,
  appendEvents as i,
  parseTurboSummary as n,
  writeRunStart as o,
  startSampler as r,
  mintRunId as t,
}
