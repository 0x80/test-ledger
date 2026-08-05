//#region src/events.d.ts
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
type Lane = 'unit' | 'integration' | 'route' | 'workerd' | 'sdk_pipeline' | 'unknown'
type FailureClass =
  | 'timeout'
  | 'hook_timeout'
  | 'assertion'
  | 'thrown'
  | 'unhandled_rejection'
  | 'db_timeout'
  | 'unknown'
type RunStartEvent = {
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
  turboForce: boolean
}
type RunEndEvent = {
  kind: 'run_end'
  runId: string
  endedAt: number
  exitCode: number
}
type SampleEvent = {
  kind: 'sample'
  runId: string
  at: number
  load1: number
  load5: number
  freeMemoryBytes: number
  liveSlots: number
}
type FileEvent = {
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
type TestEvent = {
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
type TurboTaskEvent = {
  kind: 'turbo_task'
  runId: string
  packageName: string
  task: string
  durationMs: number
  cacheStatus: string
}
type LedgerEvent =
  | RunStartEvent
  | RunEndEvent
  | SampleEvent
  | FileEvent
  | TestEvent
  | TurboTaskEvent
/**
 * Ingest reads files a crashed process may have truncated mid-line, so every
 * parsed line is validated rather than trusted. This checks the discriminant
 * and the two fields ingest needs to route a record at all; per-kind columns
 * are read defensively at insert time. A stricter schema here would reject
 * whole runs over one malformed line, which is the wrong trade for telemetry.
 */
declare function isLedgerEvent(value: unknown): value is LedgerEvent
//#endregion
//#region src/paths.d.ts
/**
 * Resolved per call rather than at module load, so tests can point $HOME at a
 * temp directory. Machine-global on purpose: every worktree writes here, which
 * is what makes cross-run contention analysis possible at all, and what lets
 * the data outlive the worktree that produced it.
 */
declare const ledgerDir: () => string
declare const runsDir: () => string
declare const runDir: (runId: string) => string
/** Per-process, so concurrent writers never share a file handle or a lock. */
declare const eventsPath: (runId: string, pid: number) => string
declare const databasePath: () => string
/** Held by `ingest` so concurrent runs cannot write the database at once. */
declare const ingestLockPath: () => string
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
  FailureClass,
  FileEvent,
  Lane,
  LedgerEvent,
  RunEndEvent,
  RunStartEvent,
  SampleEvent,
  TestEvent,
  TurboTaskEvent,
  databasePath,
  eventsPath,
  ingestLockPath,
  isLedgerEvent,
  ledgerDir,
  mintRunId,
  runDir,
  runsDir,
}
