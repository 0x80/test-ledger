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
} from './events-BisYort7.mjs'
import {
  a as writeRunEnd,
  i as appendEvents,
  n as parseTurboSummary,
  o as writeRunStart,
  r as startSampler,
  t as mintRunId,
} from './run-id-Cfrih-y7.mjs'
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
/**
 * Reserved for when ingest becomes automated (phase 2 wiring it into the
 * test-selection harness). Nothing acquires this lock today: concurrent
 * `ingest` invocations are currently unguarded, and the path exists so the
 * automated caller has somewhere to acquire it without a later schema/path
 * change.
 */
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
  retries: number
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
 *
 * A test surfaces if it either failed outright, or passed only after a retry:
 * Vitest's own retry mechanism means a test that failed then passed on retry
 * records `state = 'passed'` with `retry_count > 0`, so `failures > 0` alone
 * would miss it even though it is exactly the kind of instability this report
 * exists to surface. `retries` counts the runs in which this test needed at
 * least one retry, alongside the run/failure counts.
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
 * Ranks files by summed duration, with each file's share of the column total.
 *
 * Share rather than raw duration is the ranking that answers "what would
 * cutting this actually buy": a 3s file run on every branch costs more than a
 * 40s file run once a week, and only the share makes that visible.
 *
 * `shareOfTotal` is share of `SUM(duration_ms)` **summed across every file
 * row** — not of the run's wall-clock. A `pnpm test` invocation fans out to
 * roughly two dozen parallel Vitest processes, so the denominator here is on
 * the order of 24x wall-clock; a file reading `shareOfTotal: 0.09` did not
 * cost 9% of the run's actual duration, only 9% of the summed per-file time.
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
  turboTasks: number
  turboCacheHits: number
  turboCacheMisses: number
}
/**
 * Where a run's time goes, split by package and lane, with the environment and
 * setup share broken out.
 *
 * The environment column is the one worth watching: it is what turns "jsdom
 * costs us something" from a number someone measured once by hand into a
 * standing figure.
 *
 * `turboTasks` / `turboCacheHits` / `turboCacheMisses` come from `turbo_tasks`,
 * joined in by package only: Turbo's cache is a per-package/per-task concept
 * with no lane of its own, so every lane row for a package repeats the same
 * three figures rather than splitting them. A cache miss is any status other
 * than `HIT` (`MISS`, `UNKNOWN`, ...), read as "this task actually ran" rather
 * than "this task was served from cache."
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
