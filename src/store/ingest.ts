import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { isLedgerEvent, type LedgerEvent } from '../events.ts'
import { runDir, runsDir } from '../paths.ts'
import { withIngestLock } from './lock.ts'
import { openLedger, type Ledger } from './open.ts'

type SqlValue = string | number | null

/**
 * Reads every NDJSON file in a run directory, skipping lines that do not parse.
 *
 * A crashed or killed writer leaves a truncated final line, which is normal
 * rather than exceptional. Rejecting the whole run over it would lose the data
 * the crash makes most interesting.
 */
function readRunEvents(runId: string): LedgerEvent[] {
  const directory = runDir(runId)
  const events: LedgerEvent[] = []

  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      /** No directory for this run id: a no-op, not a crash. */
      return events
    }
    /**
     * Anything else (`EACCES`, `ELOOP`, `EMFILE`, ...) is a real filesystem
     * failure, not a normal "run never happened" case. Swallowing it here
     * would write an all-null `runs` row as though the run were genuinely
     * empty, hiding the actual problem, so it must propagate instead.
     */
    throw error
  }

  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue

    const contents = readFileSync(path.join(directory, name), 'utf8')
    for (const line of contents.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isLedgerEvent(parsed)) events.push(parsed)
      } catch {
        /** A torn write. Skip the line, keep the run. */
      }
    }
  }

  return events
}

/**
 * Bound parameters per `INSERT`, which sets how many rows go in one statement.
 *
 * Comfortably under SQLite's 32,766-variable ceiling, and past the point where
 * a wider batch still buys anything: a full-suite run's ~13,000 rows already
 * fold in a handful of statements per table, and the remaining cost is the
 * engine's, not the round trip's.
 */
const MAX_BOUND_PARAMETERS = 4000

/** `ON CONFLICT (keys) DO UPDATE SET` over every column that is not part of the key. */
function upsertClause(keyColumns: readonly string[], columns: readonly string[]): string {
  const updates = columns
    .filter((column) => !keyColumns.includes(column))
    .map((column) => `${column} = excluded.${column}`)

  return ` ON CONFLICT (${keyColumns.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
}

/**
 * Inserts `rows` with as few statements as the parameter budget allows.
 *
 * One multi-row `VALUES` list per chunk rather than one awaited statement per
 * row: the per-statement cost dominated ingest entirely (a full-suite run took
 * over 100s of it), and it is pure overhead — the rows are known up front and
 * nothing between them needs a decision.
 *
 * Callers must have de-duplicated on the conflict key first. SQLite's handling
 * of a row that conflicts with another row inserted by the *same* statement is
 * not something to lean on, and de-duplicating in JavaScript reproduces the
 * previous row-at-a-time upsert semantics exactly: last event wins.
 */
async function insertRows(
  database: Ledger,
  table: string,
  columns: readonly string[],
  rows: readonly SqlValue[][],
  onConflict = '',
): Promise<void> {
  if (rows.length === 0) return

  const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / columns.length))
  const tuple = `(${columns.map(() => '?').join(',')})`

  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk)
    await database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk
          .map(() => tuple)
          .join(',')}${onConflict}`,
      )
      .run(chunk.flat())
  }
}

/**
 * Runs `fn` inside one `IMMEDIATE` transaction, rolling back if anything throws.
 *
 * `IMMEDIATE` takes the write lock at `BEGIN` rather than on the first write, so
 * a concurrent writer fails immediately instead of halfway through a fold. The
 * driver's own `transaction()` helper does expose an immediate variant, but only
 * as a property on the returned function that its type declarations don't
 * describe (`transaction(fn)` is typed as returning a plain
 * `(...args: any[]) => Promise<any>`), so reaching it would mean asserting
 * through the types and taking `any` back. Spelling the three statements out
 * keeps the mode explicit and the whole path typed.
 *
 * The commit is inside the `try` on purpose: a `COMMIT` that fails leaves the
 * transaction open, and on a connection that outlives this call — every caller's
 * does — the next fold would then begin inside the failed one's transaction.
 */
async function inTransaction<T>(database: Ledger, fn: () => Promise<T>): Promise<T> {
  await database.exec('BEGIN IMMEDIATE')

  try {
    const result = await fn()
    await database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      await database.exec('ROLLBACK')
    } catch {
      /**
       * A failed rollback (the engine may already have rolled the transaction
       * back itself) must not replace the error that caused it, which is the
       * one describing what actually went wrong.
       */
    }
    throw error
  }
}

const RUN_COLUMNS = [
  'run_id',
  'started_at',
  'ended_at',
  'exit_code',
  'invocation',
  'repo',
  'branch',
  'worktree',
  'git_sha',
  'dirty',
  'host_id',
  'cpu_count',
  'total_memory_bytes',
  'concurrency',
  'live_slots',
  'turbo_force',
  'has_envelope',
] as const

const SAMPLE_COLUMNS = [
  'run_id',
  'at',
  'load1',
  'load5',
  'free_memory_bytes',
  'live_slots',
] as const

const TURBO_TASK_COLUMNS = [
  'run_id',
  'package_name',
  'task',
  'duration_ms',
  'cache_status',
] as const

const FILE_COLUMNS = [
  'run_id',
  'pid',
  'lane',
  'package_name',
  'file',
  'started_at',
  'duration_ms',
  'setup_ms',
  'collect_ms',
  'environment_setup_ms',
  'prepare_ms',
  'passed',
  'failed',
  'skipped',
] as const

const TEST_COLUMNS = [
  'run_id',
  'pid',
  'file',
  'full_name',
  'state',
  'duration_ms',
  'started_at',
  'retry_count',
  'failure_class',
  'failure_message',
] as const

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
 * Not self-locking: {@link ingestAll} holds the ingest lock across every run it
 * folds, and acquiring it here as well would deadlock. A caller driving
 * `ingestRun` directly wraps it in {@link withIngestLock} itself.
 */
export async function ingestRun(database: Ledger, runId: string): Promise<number> {
  const alreadyIngested: unknown = await database
    .prepare('SELECT 1 FROM ingested_runs WHERE run_id = ?')
    .get([runId])
  if (alreadyIngested !== undefined) return 0

  const events = readRunEvents(runId)

  const start = events.find((event) => event.kind === 'run_start')
  const end = events.find((event) => event.kind === 'run_end')

  const runRow: SqlValue[] = [
    runId,
    start?.startedAt ?? null,
    end?.endedAt ?? null,
    end?.exitCode ?? null,
    start?.invocation ?? null,
    start?.repo ?? null,
    start?.branch ?? null,
    start?.worktree ?? null,
    start?.gitSha ?? null,
    start?.dirty === undefined ? null : Number(start.dirty),
    start?.hostId ?? null,
    start?.cpuCount ?? null,
    start?.totalMemoryBytes ?? null,
    start?.concurrency ?? null,
    start?.liveSlots ?? null,
    start?.turboForce === undefined ? null : Number(start.turboForce),
    start === undefined ? 0 : 1,
  ]

  const sampleRows: SqlValue[][] = []
  const turboTaskRows: SqlValue[][] = []
  /** Keyed by the table's primary key, so a repeated event converges instead of conflicting. */
  const fileRows = new Map<string, SqlValue[]>()
  const testRows = new Map<string, SqlValue[]>()

  for (const event of events) {
    if (event.kind === 'sample') {
      sampleRows.push([
        runId,
        event.at ?? null,
        event.load1 ?? null,
        event.load5 ?? null,
        event.freeMemoryBytes ?? null,
        event.liveSlots ?? null,
      ])
    } else if (event.kind === 'turbo_task') {
      turboTaskRows.push([
        runId,
        event.packageName ?? null,
        event.task ?? null,
        event.durationMs ?? null,
        event.cacheStatus ?? null,
      ])
    } else if (event.kind === 'file') {
      fileRows.set(event.file, [
        runId,
        event.pid ?? null,
        event.lane ?? null,
        event.packageName ?? null,
        event.file,
        event.startedAt ?? null,
        event.durationMs ?? null,
        event.setupMs ?? null,
        event.collectMs ?? null,
        event.environmentSetupMs ?? null,
        event.prepareMs ?? null,
        event.passed ?? null,
        event.failed ?? null,
        event.skipped ?? null,
      ])
    } else if (event.kind === 'test') {
      /**
       * NUL separates the two parts. A path cannot contain one, which is what
       * makes the split unambiguous — a test name is an unrestricted JavaScript
       * string and may contain anything, including NUL, but it only ever sits
       * after the separator.
       */
      testRows.set(`${event.file}\u0000${event.fullName}`, [
        runId,
        event.pid ?? null,
        event.file,
        event.fullName,
        event.state,
        event.durationMs ?? null,
        event.startedAt ?? null,
        event.retryCount ?? null,
        event.failureClass ?? null,
        event.failureMessage ?? null,
      ])
    }
  }

  return inTransaction(database, async () => {
    await insertRows(database, 'runs', RUN_COLUMNS, [runRow], upsertClause(['run_id'], RUN_COLUMNS))
    await insertRows(database, 'run_samples', SAMPLE_COLUMNS, sampleRows)
    await insertRows(database, 'turbo_tasks', TURBO_TASK_COLUMNS, turboTaskRows)
    await insertRows(
      database,
      'files',
      FILE_COLUMNS,
      [...fileRows.values()],
      upsertClause(['run_id', 'file'], FILE_COLUMNS),
    )
    await insertRows(
      database,
      'tests',
      TEST_COLUMNS,
      [...testRows.values()],
      upsertClause(['run_id', 'file', 'full_name'], TEST_COLUMNS),
    )

    await database
      .prepare(
        `INSERT INTO ingested_runs (run_id, ingested_at) VALUES (?,?)
         ON CONFLICT (run_id) DO UPDATE SET ingested_at = excluded.ingested_at`,
      )
      .run([runId, Date.now()])

    return sampleRows.length + turboTaskRows.length + fileRows.size + testRows.size
  })
}

export type IngestResult = { runs: number; rows: number }

/** The sweep itself. Both exported entry points below run it under the ingest lock. */
async function foldUnIngestedRuns(database: Ledger): Promise<IngestResult> {
  let directories: string[]
  try {
    directories = readdirSync(runsDir())
  } catch {
    return { runs: 0, rows: 0 }
  }

  const ingestedRunRows = await database.prepare('SELECT run_id FROM ingested_runs').all()
  const ingested = new Set(ingestedRunRows.map((row) => (row as { run_id: string }).run_id))

  let runs = 0
  let rows = 0

  for (const runId of directories) {
    if (ingested.has(runId)) continue
    rows += await ingestRun(database, runId)
    runs += 1
  }

  return { runs, rows }
}

/**
 * Folds every un-ingested run directory into an already-open ledger.
 *
 * Holds the ingest lock for the whole sweep rather than per run: taking it per
 * run would let a second invocation slot whole runs in between a first one's,
 * which is exactly the interleaving the lock exists to prevent.
 *
 * Prefer {@link ingest} unless you already hold an open ledger for other
 * reasons. The database file itself is locked by the driver at open, so a
 * second process that opens before calling this fails at `openLedger` rather
 * than waiting here — the lock can only make invocations queue when it is taken
 * before the file is opened, which is what `ingest` does.
 */
export async function ingestAll(database: Ledger): Promise<IngestResult> {
  const result = await withIngestLock(async () => {
    const swept = await foldUnIngestedRuns(database)
    return swept
  })

  return result
}

/**
 * Closes the ledger without letting the close itself change the outcome.
 *
 * Once the fold has committed, its rows are durable, so a failure to close is
 * not a failure to ingest — reporting one would call a successful run broken.
 * And when the fold already threw, that error is the one describing what went
 * wrong; a close failure must not displace it.
 */
async function closeQuietly(database: Ledger): Promise<void> {
  try {
    await database.close()
  } catch {
    /** Nothing actionable here: the fold's own outcome is the answer. */
  }
}

/**
 * Collapses the write-ahead log back into the database file after a fold.
 *
 * Left alone, the WAL only grows: a 999-run backlog folded through the previous
 * row-at-a-time path produced a 41 GB WAL beside a 1.4 GB database, roughly ten
 * times the whole ledger in write amplification that no reader ever needed.
 * `TRUNCATE` returns the space rather than merely marking it reusable.
 *
 * Deliberately `exec` and not `.all()`: the installed
 * `@tursodatabase/database@0.3.2` bindings panic outright (a Rust
 * index-out-of-bounds in `bindings/javascript/src/lib.rs`, which takes the
 * process down rather than throwing) when asked to hand back this pragma's
 * result row. `exec` and `.run()` both execute it without reading rows and were
 * confirmed safe by hand against that version.
 */
async function checkpointQuietly(database: Ledger): Promise<void> {
  try {
    await database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /** Best effort: a WAL that did not collapse costs disk, not correctness. */
  }
}

/**
 * Acquires the ingest lock, opens the ledger, folds every un-ingested run,
 * collapses the WAL, and closes again. The entry point for the CLI and for any
 * automated caller.
 *
 * The ordering is the whole point: `@tursodatabase/database` takes an exclusive
 * OS-level lock on `ledger.db` when it opens, so a second invocation that opens
 * first dies with "File is locked by another process" before it can queue on
 * anything. Taking the ingest lock around the open turns that crash into a wait,
 * and closing before release means the next holder finds the file free.
 */
export async function ingest(): Promise<IngestResult> {
  const result = await withIngestLock(async () => {
    const database = await openLedger()

    let folded: IngestResult
    try {
      folded = await foldUnIngestedRuns(database)
    } catch (error) {
      await closeQuietly(database)
      throw error
    }

    await checkpointQuietly(database)
    await closeQuietly(database)

    return folded
  })

  return result
}
