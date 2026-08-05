import {
  a as RunEndEvent,
  c as TestEvent,
  i as LedgerEvent,
  l as TurboTaskEvent,
  n as FileEvent,
  o as RunStartEvent,
  r as Lane,
  s as SampleEvent,
  t as FailureClass,
  u as isLedgerEvent,
} from './events-B4CI0IVw.mjs'
import { connect } from '@tursodatabase/database'

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
//#region src/failure-class.d.ts
/**
 * Classifies a failure so "genuine flake" and "load artifact" are separable by
 * query rather than by judgment. This encodes the heuristic `/run-tests` asks a
 * human to apply by hand on every red run.
 *
 * The raw message is stored alongside the class by the caller, deliberately: a
 * misclassification stays re-derivable, so these rules can change later without
 * a backfill being required for correctness.
 */
declare function classifyFailure(error: { name?: string; message?: string }): FailureClass
//#endregion
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
//#region src/format.d.ts
/** Renders rows as an aligned table, or a stated absence. */
declare function table(rows: readonly Record<string, unknown>[], emptyMessage: string): string
//#endregion
//#region src/store/open.d.ts
type Ledger = Awaited<ReturnType<typeof connect>>
/**
 * Opens the local ledger, applying the schema every time.
 *
 * Phase 1 uses `@tursodatabase/database`, the local-only package, rather than
 * `@tursodatabase/sync`: the sync package's `url` and `authToken` are required,
 * so there is no remote-less mode to start in. Same engine and same SQL, so the
 * schema carries across to phase 2 unchanged — but phase 2 creates a FRESH
 * synced database and re-ingests from the retained NDJSON rather than
 * converting this file, because a synced database carries change-tracking state
 * a local-only file does not.
 *
 * `exec()` is called once with the whole schema string rather than split
 * statement-by-statement: the driver's own SQL parser walks block comments
 * correctly, and `SCHEMA`'s doc comments themselves contain a `;` (see the
 * `runs` table's leading comment), so a naive split on `;` cuts a comment in
 * half and produces a syntax error. Confirmed against the installed
 * `@tursodatabase/database@0.3.2`.
 */
declare function openLedger(): Promise<Ledger>
//#endregion
//#region src/store/ingest.d.ts
/**
 * Folds one run's events into the tables.
 *
 * Idempotent two ways at once, deliberately layered rather than relying on
 * either alone:
 *
 * 1. A short-circuit up front: if `ingested_runs` already has this `runId`,
 *    return `0` without touching any table. This is what makes the whole run
 *    idempotent, including `run_samples` and `turbo_tasks`, which are plain
 *    `INSERT` with no primary key (append-only time series, by design) and so
 *    have no per-row convergence of their own — without this check, a second
 *    `ingestRun` on an already-completed directory would duplicate their rows.
 * 2. Per-row upserts (`INSERT ... ON CONFLICT ... DO UPDATE SET`) on `runs`,
 *    `files`, and `tests`. These stay even though (1) makes them redundant on
 *    a *completed* re-ingest, because they are what makes a *partial* one
 *    safe: a prior process that died mid-ingest never reached the final
 *    `ingested_runs` write, so the short-circuit does not fire and the run
 *    re-executes in full, converging on the same rows rather than duplicating
 *    the partial write. `INSERT OR REPLACE` was the natural spelling for
 *    that, but the installed `@tursodatabase/database@0.3.2` engine rejects it
 *    at prepare time with "is only supported with UPSERT", so the upsert form
 *    is used instead; it is the standard-SQL equivalent and converges to the
 *    same rows.
 */
declare function ingestRun(database: Ledger, runId: string): Promise<number>
/** Folds every run directory not already recorded in `ingested_runs`. */
declare function ingestAll(database: Ledger): Promise<{
  runs: number
  rows: number
}>
//#endregion
//#region src/reports/flaky.d.ts
type FlakyRow = {
  file: string
  fullName: string
  runs: number
  failures: number
  failureRate: number
  classes: string
}
/**
 * Ranks tests by how often they failed, with the denominator alongside.
 *
 * The denominator is the number of runs in which this test appeared at all, not
 * the number of runs overall — a test added last week must not read as stable
 * because it was absent for a hundred earlier runs. Failure classes are
 * aggregated into the row because the class is what separates a genuine flake
 * from a host-capacity artifact: a test failing only as `timeout` under load is
 * a different problem from one failing as `assertion`.
 */
declare function flakyReport(
  database: Ledger,
  options?: {
    minRuns?: number
  },
): Promise<FlakyRow[]>
//#endregion
//#region src/reports/slow.d.ts
type SlowRow = {
  file: string
  runs: number
  meanMs: number
  totalMs: number
  shareOfTotal: number
}
/**
 * Ranks files by total wall-clock, with each file's share of the whole.
 *
 * Share rather than raw duration is the ranking that answers "what would
 * cutting this actually buy": a 3s file run on every branch costs more than a
 * 40s file run once a week, and only the share makes that visible.
 */
declare function slowReport(
  database: Ledger,
  options?: {
    limit?: number
  },
): Promise<SlowRow[]>
//#endregion
//#region src/reports/contention.d.ts
type ContentionRow = {
  runId: string
  branch: string
  startedAt: number
  durationMs: number
  meanLoad1: number
  peakLoad1: number
  peakLiveSlots: number
  concurrency: number
}
/**
 * Runs ranked by how loaded the host was while they ran.
 *
 * Joined from the sample timeline rather than from a start/end snapshot,
 * because the whole point is that a run's average conditions and its worst
 * conditions are different numbers and it is the worst ones that produce a
 * deadline failure.
 *
 * `COALESCE(r.ended_at - r.started_at, 0)` is NULL-propagating: a run killed
 * mid-run (no `run_end`, so `ended_at` is NULL) reports `durationMs` as `0`
 * rather than a negative or nonsense figure, confirmed against the installed
 * `@tursodatabase/database@0.3.2` driver. `LEFT JOIN` plus `GROUP BY` and the
 * aggregates below are likewise confirmed working on that driver, so a run
 * with no samples (an ad-hoc invocation outside the sampler) still gets a row
 * with all-zero load figures rather than being dropped.
 */
declare function contentionReport(
  database: Ledger,
  options?: {
    limit?: number
  },
): Promise<ContentionRow[]>
//#endregion
//#region src/reports/shape.d.ts
type ShapeRow = {
  packageName: string
  lane: string
  files: number
  totalMs: number
  setupMs: number
  environmentSetupMs: number
}
/**
 * Where a run's time goes, split by package and lane, with the environment and
 * setup share broken out.
 *
 * The environment column is the one worth watching: it is what turns "jsdom
 * costs us something" from a number someone measured once by hand into a
 * standing figure.
 */
declare function shapeReport(database: Ledger): Promise<ShapeRow[]>
//#endregion
//#region src/reports/runs.d.ts
type RunRow = {
  runId: string
  branch: string
  worktree: string
  startedAt: number
  durationMs: number
  exitCode: number
  concurrency: number
  turboForce: number
  hasEnvelope: number
}
/** Recent run history: the index into everything else. */
declare function runsReport(
  database: Ledger,
  options?: {
    limit?: number
  },
): Promise<RunRow[]>
//#endregion
export {
  type ContentionRow,
  FailureClass,
  FileEvent,
  type FlakyRow,
  Lane,
  type Ledger,
  LedgerEvent,
  RunEndEvent,
  type RunRow,
  RunStartEvent,
  SampleEvent,
  type ShapeRow,
  type SlowRow,
  TestEvent,
  TurboTaskEvent,
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
