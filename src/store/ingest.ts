import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { isLedgerEvent, type LedgerEvent } from '../events.ts'
import { runDir, runsDir } from '../paths.ts'
import type { Ledger } from './open.ts'

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
export async function ingestRun(database: Ledger, runId: string): Promise<number> {
  const alreadyIngested: unknown = await database
    .prepare('SELECT 1 FROM ingested_runs WHERE run_id = ?')
    .get([runId])
  if (alreadyIngested !== undefined) return 0

  const events = readRunEvents(runId)
  let rows = 0

  const start = events.find((event) => event.kind === 'run_start')
  const end = events.find((event) => event.kind === 'run_end')

  await database
    .prepare(
      `INSERT INTO runs (
         run_id, started_at, ended_at, exit_code, invocation, repo, branch, worktree,
         git_sha, dirty, host_id, cpu_count, total_memory_bytes, concurrency, live_slots,
         turbo_force, has_envelope
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (run_id) DO UPDATE SET
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         exit_code = excluded.exit_code,
         invocation = excluded.invocation,
         repo = excluded.repo,
         branch = excluded.branch,
         worktree = excluded.worktree,
         git_sha = excluded.git_sha,
         dirty = excluded.dirty,
         host_id = excluded.host_id,
         cpu_count = excluded.cpu_count,
         total_memory_bytes = excluded.total_memory_bytes,
         concurrency = excluded.concurrency,
         live_slots = excluded.live_slots,
         turbo_force = excluded.turbo_force,
         has_envelope = excluded.has_envelope`,
    )
    .run([
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
    ])

  for (const event of events) {
    if (event.kind === 'sample') {
      await database
        .prepare(
          `INSERT INTO run_samples (run_id, at, load1, load5, free_memory_bytes, live_slots)
           VALUES (?,?,?,?,?,?)`,
        )
        .run([
          runId,
          event.at ?? null,
          event.load1 ?? null,
          event.load5 ?? null,
          event.freeMemoryBytes ?? null,
          event.liveSlots ?? null,
        ])
      rows += 1
    } else if (event.kind === 'turbo_task') {
      await database
        .prepare(
          `INSERT INTO turbo_tasks (run_id, package_name, task, duration_ms, cache_status)
           VALUES (?,?,?,?,?)`,
        )
        .run([
          runId,
          event.packageName ?? null,
          event.task ?? null,
          event.durationMs ?? null,
          event.cacheStatus ?? null,
        ])
      rows += 1
    } else if (event.kind === 'file') {
      await database
        .prepare(
          `INSERT INTO files (
             run_id, pid, lane, package_name, file, started_at, duration_ms,
             setup_ms, collect_ms, environment_setup_ms, prepare_ms, passed, failed, skipped
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (run_id, file) DO UPDATE SET
             pid = excluded.pid,
             lane = excluded.lane,
             package_name = excluded.package_name,
             started_at = excluded.started_at,
             duration_ms = excluded.duration_ms,
             setup_ms = excluded.setup_ms,
             collect_ms = excluded.collect_ms,
             environment_setup_ms = excluded.environment_setup_ms,
             prepare_ms = excluded.prepare_ms,
             passed = excluded.passed,
             failed = excluded.failed,
             skipped = excluded.skipped`,
        )
        .run([
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
      rows += 1
    } else if (event.kind === 'test') {
      await database
        .prepare(
          `INSERT INTO tests (
             run_id, pid, file, full_name, state, duration_ms, started_at,
             retry_count, failure_class, failure_message
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (run_id, file, full_name) DO UPDATE SET
             pid = excluded.pid,
             state = excluded.state,
             duration_ms = excluded.duration_ms,
             started_at = excluded.started_at,
             retry_count = excluded.retry_count,
             failure_class = excluded.failure_class,
             failure_message = excluded.failure_message`,
        )
        .run([
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
      rows += 1
    }
  }

  await database
    .prepare(
      `INSERT INTO ingested_runs (run_id, ingested_at) VALUES (?,?)
       ON CONFLICT (run_id) DO UPDATE SET ingested_at = excluded.ingested_at`,
    )
    .run([runId, Date.now()])

  return rows
}

/** Folds every run directory not already recorded in `ingested_runs`. */
export async function ingestAll(database: Ledger): Promise<{ runs: number; rows: number }> {
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
