/**
 * The NDJSON event union: the contract between the reporter (which appends
 * these, in the test path) and ingest (which folds them into the database,
 * outside it).
 *
 * Every event carries `runId` so a run directory can be reassembled from files
 * written by processes that never saw each other, and `kind` so ingest can
 * dispatch without positional assumptions.
 *
 * These are deliberately flat records of primitives. NDJSON is the durable raw
 * form the whole design leans on — it is what makes the database re-creatable
 * and what keeps the data out of any one dependency — so nothing here may
 * become a shape only a specific library can read back.
 */

export type Lane = 'unit' | 'integration' | 'route' | 'workerd' | 'sdk_pipeline' | 'unknown'

export type FailureClass =
  | 'timeout'
  | 'hook_timeout'
  | 'assertion'
  | 'thrown'
  | 'unhandled_rejection'
  | 'db_timeout'
  | 'unknown'

export type RunStartEvent = {
  kind: 'run_start'
  runId: string
  startedAt: number
  invocation: string
  repo: string
  branch: string
  worktree: string
  gitSha: string
  dirty: boolean
  hostId: string
  cpuCount: number
  totalMemoryBytes: number
  concurrency: number
  liveSlots: number
  queuedMs: number
  queueTimedOut: boolean
  turboForce: boolean
}

export type RunEndEvent = {
  kind: 'run_end'
  runId: string
  endedAt: number
  exitCode: number
}

export type SampleEvent = {
  kind: 'sample'
  runId: string
  at: number
  load1: number
  load5: number
  freeMemoryBytes: number
  liveSlots: number
}

export type FileEvent = {
  kind: 'file'
  runId: string
  pid: number
  lane: Lane
  packageName: string
  file: string
  startedAt: number
  durationMs: number
  setupMs: number
  collectMs: number
  environmentSetupMs: number
  prepareMs: number
  passed: number
  failed: number
  skipped: number
}

export type TestEvent = {
  kind: 'test'
  runId: string
  pid: number
  file: string
  fullName: string
  state: 'passed' | 'failed' | 'skipped' | 'pending'
  durationMs: number
  startedAt: number
  retryCount: number
  failureClass?: FailureClass
  failureMessage?: string
}

export type TurboTaskEvent = {
  kind: 'turbo_task'
  runId: string
  packageName: string
  task: string
  durationMs: number
  cacheStatus: string
}

export type LedgerEvent =
  | RunStartEvent
  | RunEndEvent
  | SampleEvent
  | FileEvent
  | TestEvent
  | TurboTaskEvent

const EVENT_KINDS = new Set(['run_start', 'run_end', 'sample', 'file', 'test', 'turbo_task'])

/**
 * Ingest reads files a crashed process may have truncated mid-line, so every
 * parsed line is validated rather than trusted. This checks the discriminant
 * and the two fields ingest needs to route a record at all; per-kind columns
 * are read defensively at insert time. A stricter schema here would reject
 * whole runs over one malformed line, which is the wrong trade for telemetry.
 */
export function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = value as Record<string, unknown>
  return (
    typeof record['kind'] === 'string' &&
    EVENT_KINDS.has(record['kind']) &&
    typeof record['runId'] === 'string' &&
    record['runId'].length > 0
  )
}
