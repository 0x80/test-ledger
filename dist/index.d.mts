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
} from './events-BYYQlQ0j.mjs'
import {
  a as writeRunEnd,
  i as appendEvents,
  n as parseTurboSummary,
  o as writeRunStart,
  r as startSampler,
  t as mintRunId,
} from './run-id-UdAeayfZ.mjs'
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
 * The lock every command that writes `ledger.db` holds before opening it, so
 * concurrent ingest and prune invocations serialize instead of interleaving
 * writes or colliding on the driver's exclusive file lock.
 *
 * Machine-global like the rest of the ledger directory, which is what makes it
 * work across worktrees: the writers it has to exclude are separate processes
 * started from unrelated checkouts, not threads of one run.
 */
declare const ledgerWriterLockPath: () => string
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
 * The whole fold — every table plus the `ingested_runs` marker — commits as one
 * transaction, which is what makes it idempotent. `run_samples` and
 * `turbo_tasks` are append-only with no per-row key, so they have no
 * convergence of their own; before the transaction, a process that died between
 * their inserts and the `ingested_runs` write left rows the retry duplicated,
 * because the short-circuit never fired for a run the database had no record of.
 * Committing the marker with the rows it describes removes that window: either
 * both are there, or neither is.
 *
 * The two mechanisms cover different cases and neither replaces the other. The
 * `ingested_runs` short-circuit is what makes a *completed* run idempotent on a
 * later re-ingest: `run_samples` and `turbo_tasks` would happily append a second
 * copy of every row, since they have no key to conflict on. The transaction is
 * what makes an *interrupted* run idempotent, by ensuring a fold that never
 * finished left nothing for the retry to duplicate. The per-row upserts on
 * `runs`, `files`, and `tests` remain too, because within a single fold they are
 * what makes a re-ingest converge rather than conflict.
 * `INSERT OR REPLACE` was the natural spelling for that, but the installed
 * `@tursodatabase/database@0.3.2` engine rejects it at prepare time with "is
 * only supported with UPSERT", so the upsert form is used instead; it is the
 * standard-SQL equivalent and converges to the same rows.
 *
 * Not self-locking: {@link ingestAll} holds the ledger writer lock across every run it
 * folds, and acquiring it here as well would deadlock. A caller driving
 * `ingestRun` directly wraps it in {@link withLedgerWriterLock} itself.
 */
declare function ingestRun(database: Ledger, runId: string): Promise<number>
type IngestResult = {
  runs: number
  rows: number
}
/**
 * Folds every un-ingested run directory into an already-open ledger.
 *
 * Holds the ledger writer lock for the whole sweep rather than per run: taking it per
 * run would let a second invocation slot whole runs in between a first one's,
 * which is exactly the interleaving the lock exists to prevent.
 *
 * Prefer {@link ingest} unless you already hold an open ledger for other
 * reasons. The database file itself is locked by the driver at open, so a
 * second process that opens before calling this fails at `openLedger` rather
 * than waiting here — the lock can only make invocations queue when it is taken
 * before the file is opened, which is what `ingest` does.
 */
declare function ingestAll(database: Ledger): Promise<IngestResult>
/**
 * Acquires the ledger writer lock, opens the ledger, folds every un-ingested run,
 * collapses the WAL, and closes again. The entry point for the CLI and for any
 * automated caller.
 *
 * The ordering is the whole point: `@tursodatabase/database` takes an exclusive
 * OS-level lock on `ledger.db` when it opens, so a second invocation that opens
 * first dies with "File is locked by another process" before it can queue on
 * anything. Taking the ledger writer lock around the open turns that crash into a wait,
 * and closing before release means the next holder finds the file free.
 */
declare function ingest(): Promise<IngestResult>
//#endregion
//#region src/store/lock.d.ts
/**
 * Runs `fn` while holding the ledger's writer lock.
 *
 * The lock is a file created with the exclusive `wx` flag, which is atomic on
 * every filesystem we care about, so two invocations racing to create it always
 * produce exactly one winner. It carries a random token identifying its holder;
 * release only removes the file when that token still matches, so a process
 * whose lock was reclaimed as stale does not delete its successor's on the way
 * out. (Read alongside {@link reclaimIfStale}, which is candid about the one
 * window neither mechanism closes.)
 *
 * Held for the whole database operation rather than per statement: a
 * per-statement lock would let writers interleave partial operations.
 */
declare function withLedgerWriterLock<T>(fn: () => Promise<T>): Promise<T>
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
  queuedMs: number
  queueTimedOut: number
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
  type IngestResult,
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
  ingest,
  ingestAll,
  ingestRun,
  isLedgerEvent,
  ledgerDir,
  ledgerWriterLockPath,
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
  withLedgerWriterLock,
  writeRunEnd,
  writeRunStart,
}
