import { a as runDir, i as ledgerDir, o as runsDir, t as databasePath } from './paths-BfgS-0Zu.mjs'
import path from 'node:path'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { connect } from '@tursodatabase/database'

//#region src/format.ts
/** Renders rows as an aligned table, or a stated absence. */
function table(rows, emptyMessage) {
  if (rows.length === 0) return emptyMessage
  /**
   * Every current report returns homogeneous rows (one fixed shape per
   * report), so reading columns from the first row alone always matches the
   * rest. A report that ever mixed row shapes would need a union of keys
   * here instead; that branch is unreachable today.
   */
  const columns = Object.keys(rows[0] ?? {})
  const rendered = rows.map((row) => columns.map((column) => renderCell(row[column])))
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rendered.map((cells) => (cells[index] ?? '').length)),
  )
  const line = (cells) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rendered.map((cells) => line(cells)),
  ].join('\n')
}
/** Renders one cell: empty for a nullish value, three decimals for a non-integer. */
function renderCell(value) {
  if (value === null || value === void 0) return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? ''
}

//#endregion
//#region src/reports/contention.ts
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
async function contentionReport(database, options = {}) {
  return await database
    .prepare(`SELECT r.run_id AS runId,
              COALESCE(r.branch, '') AS branch,
              COALESCE(r.started_at, 0) AS startedAt,
              COALESCE(r.ended_at - r.started_at, 0) AS durationMs,
              COALESCE(r.concurrency, 0) AS concurrency,
              COALESCE(AVG(s.load1), 0) AS meanLoad1,
              COALESCE(MAX(s.load1), 0) AS peakLoad1,
              COALESCE(MAX(s.live_slots), 0) AS peakLiveSlots
         FROM runs r
         LEFT JOIN run_samples s ON s.run_id = r.run_id
        GROUP BY r.run_id
        ORDER BY peakLoad1 DESC
        LIMIT ?`)
    .all([options.limit ?? 25])
}

//#endregion
//#region src/reports/flaky.ts
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
async function flakyReport(database, options = {}) {
  const minRuns = options.minRuns ?? 3
  return (
    await database
      .prepare(`SELECT file,
              full_name AS fullName,
              COUNT(*) AS runs,
              SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retries,
              GROUP_CONCAT(DISTINCT failure_class) AS classes
         FROM tests
        WHERE state IN ('passed', 'failed')
        GROUP BY file, full_name
       HAVING (failures > 0 OR retries > 0) AND runs >= ?
        ORDER BY (CAST(failures AS REAL) / runs) DESC, failures DESC`)
      .all([minRuns])
  ).map((row) => {
    const record = row
    return {
      file: record.file,
      fullName: record.fullName,
      runs: record.runs,
      failures: record.failures,
      failureRate: record.failures / record.runs,
      retries: record.retries,
      classes: record.classes ?? '',
    }
  })
}

//#endregion
//#region src/reports/runs.ts
/** Recent run history: the index into everything else. */
async function runsReport(database, options = {}) {
  return await database
    .prepare(`SELECT run_id AS runId,
              COALESCE(branch, '') AS branch,
              COALESCE(worktree, '') AS worktree,
              COALESCE(started_at, 0) AS startedAt,
              COALESCE(ended_at - started_at, 0) AS durationMs,
              COALESCE(exit_code, -1) AS exitCode,
              COALESCE(concurrency, 0) AS concurrency,
              COALESCE(turbo_force, 0) AS turboForce,
              has_envelope AS hasEnvelope
         FROM runs
        ORDER BY started_at DESC
        LIMIT ?`)
    .all([options.limit ?? 25])
}

//#endregion
//#region src/reports/shape.ts
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
async function shapeReport(database) {
  return await database
    .prepare(`SELECT COALESCE(f.package_name, '') AS packageName,
              COALESCE(f.lane, '') AS lane,
              COUNT(*) AS files,
              COALESCE(SUM(f.duration_ms), 0) AS totalMs,
              COALESCE(SUM(f.setup_ms), 0) AS setupMs,
              COALESCE(SUM(f.environment_setup_ms), 0) AS environmentSetupMs,
              COALESCE(t.turboTasks, 0) AS turboTasks,
              COALESCE(t.turboCacheHits, 0) AS turboCacheHits,
              COALESCE(t.turboCacheMisses, 0) AS turboCacheMisses
         FROM files f
         LEFT JOIN (
           SELECT package_name,
                  COUNT(*) AS turboTasks,
                  SUM(CASE WHEN cache_status = 'HIT' THEN 1 ELSE 0 END) AS turboCacheHits,
                  SUM(CASE WHEN cache_status != 'HIT' THEN 1 ELSE 0 END) AS turboCacheMisses
             FROM turbo_tasks
            GROUP BY package_name
         ) t ON t.package_name = f.package_name
        GROUP BY f.package_name, f.lane
        ORDER BY totalMs DESC`)
    .all()
}

//#endregion
//#region src/reports/slow.ts
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
async function slowReport(database, options = {}) {
  const limit = options.limit ?? 25
  const total =
    (await database.prepare('SELECT COALESCE(SUM(duration_ms), 0) AS total FROM files').all())[0]
      ?.total ?? 0
  return (
    await database
      .prepare(`SELECT file,
              COUNT(*) AS runs,
              SUM(duration_ms) AS totalMs,
              AVG(duration_ms) AS meanMs
         FROM files
        GROUP BY file
        ORDER BY totalMs DESC
        LIMIT ?`)
      .all([limit])
  ).map((row) => {
    const record = row
    return {
      file: record.file,
      runs: record.runs,
      meanMs: record.meanMs,
      totalMs: record.totalMs,
      shareOfTotal: total === 0 ? 0 : record.totalMs / total,
    }
  })
}

//#endregion
//#region src/events.ts
const EVENT_KINDS = new Set(['run_start', 'run_end', 'sample', 'file', 'test', 'turbo_task'])
/**
 * Ingest reads files a crashed process may have truncated mid-line, so every
 * parsed line is validated rather than trusted. This checks the discriminant
 * and the two fields ingest needs to route a record at all; per-kind columns
 * are read defensively at insert time. A stricter schema here would reject
 * whole runs over one malformed line, which is the wrong trade for telemetry.
 */
function isLedgerEvent(value) {
  if (typeof value !== 'object' || value === null) return false
  const record = value
  return (
    typeof record['kind'] === 'string' &&
    EVENT_KINDS.has(record['kind']) &&
    typeof record['runId'] === 'string' &&
    record['runId'].length > 0
  )
}

//#endregion
//#region src/store/ingest.ts
/**
 * Reads every NDJSON file in a run directory, skipping lines that do not parse.
 *
 * A crashed or killed writer leaves a truncated final line, which is normal
 * rather than exceptional. Rejecting the whole run over it would lose the data
 * the crash makes most interesting.
 */
function readRunEvents(runId) {
  const directory = runDir(runId)
  const events = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error.code === 'ENOENT')
      /** No directory for this run id: a no-op, not a crash. */
      return events
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
        const parsed = JSON.parse(line)
        if (isLedgerEvent(parsed)) events.push(parsed)
      } catch {}
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
async function ingestRun(database, runId) {
  if (
    (await database.prepare('SELECT 1 FROM ingested_runs WHERE run_id = ?').get([runId])) !== void 0
  )
    return 0
  const events = readRunEvents(runId)
  let rows = 0
  const start = events.find((event) => event.kind === 'run_start')
  const end = events.find((event) => event.kind === 'run_end')
  await database
    .prepare(`INSERT INTO runs (
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
         has_envelope = excluded.has_envelope`)
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
      start?.dirty === void 0 ? null : Number(start.dirty),
      start?.hostId ?? null,
      start?.cpuCount ?? null,
      start?.totalMemoryBytes ?? null,
      start?.concurrency ?? null,
      start?.liveSlots ?? null,
      start?.turboForce === void 0 ? null : Number(start.turboForce),
      start === void 0 ? 0 : 1,
    ])
  for (const event of events)
    if (event.kind === 'sample') {
      await database
        .prepare(`INSERT INTO run_samples (run_id, at, load1, load5, free_memory_bytes, live_slots)
           VALUES (?,?,?,?,?,?)`)
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
        .prepare(`INSERT INTO turbo_tasks (run_id, package_name, task, duration_ms, cache_status)
           VALUES (?,?,?,?,?)`)
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
        .prepare(`INSERT INTO files (
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
             skipped = excluded.skipped`)
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
        .prepare(`INSERT INTO tests (
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
             failure_message = excluded.failure_message`)
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
  await database
    .prepare(`INSERT INTO ingested_runs (run_id, ingested_at) VALUES (?,?)
       ON CONFLICT (run_id) DO UPDATE SET ingested_at = excluded.ingested_at`)
    .run([runId, Date.now()])
  return rows
}
/** Folds every run directory not already recorded in `ingested_runs`. */
async function ingestAll(database) {
  let directories
  try {
    directories = readdirSync(runsDir())
  } catch {
    return {
      runs: 0,
      rows: 0,
    }
  }
  const ingestedRunRows = await database.prepare('SELECT run_id FROM ingested_runs').all()
  const ingested = new Set(ingestedRunRows.map((row) => row.run_id))
  let runs = 0
  let rows = 0
  for (const runId of directories) {
    if (ingested.has(runId)) continue
    rows += await ingestRun(database, runId)
    runs += 1
  }
  return {
    runs,
    rows,
  }
}

//#endregion
//#region src/store/schema.ts
/**
 * The phase 1 schema.
 *
 * Every statement is `IF NOT EXISTS`, so applying it on every open is the
 * migration story for phase 1. A real migration ladder can wait until the
 * schema has to change under data someone would miss.
 */
const SCHEMA = `
/** Every table keys on run_id; a run is the unit of ingest and of pruning. */
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  invocation TEXT,
  repo TEXT,
  branch TEXT,
  worktree TEXT,
  git_sha TEXT,
  dirty INTEGER,
  host_id TEXT,
  cpu_count INTEGER,
  total_memory_bytes INTEGER,
  concurrency INTEGER,
  live_slots INTEGER,
  turbo_force INTEGER,
  /** 0 when the run had no envelope (an ad-hoc invocation outside the wrapper). */
  has_envelope INTEGER NOT NULL DEFAULT 0
);

/**
 * No primary key: an append-only time series, and neither \`at\` nor any other
 * column is needed to make a row unique, so none but \`run_id\` is NOT NULL.
 * \`isLedgerEvent\` validates only \`kind\` and \`runId\` before ingest ever sees a
 * row, so a truncated-but-parseable \`sample\` line legitimately reaches this
 * insert missing \`at\`; a NOT NULL constraint there would turn one malformed
 * telemetry line into a thrown error that aborts ingest of the rest of the
 * run, which is the trade this table is designed to avoid.
 */
CREATE TABLE IF NOT EXISTS run_samples (
  run_id TEXT NOT NULL,
  at INTEGER,
  load1 REAL,
  load5 REAL,
  free_memory_bytes INTEGER,
  live_slots INTEGER
);
CREATE INDEX IF NOT EXISTS run_samples_run_at ON run_samples (run_id, at);

/** Same reasoning as \`run_samples\`: no primary key, so only \`run_id\` is NOT NULL. */
CREATE TABLE IF NOT EXISTS turbo_tasks (
  run_id TEXT NOT NULL,
  package_name TEXT,
  task TEXT,
  duration_ms INTEGER,
  cache_status TEXT
);

CREATE TABLE IF NOT EXISTS files (
  run_id TEXT NOT NULL,
  pid INTEGER,
  lane TEXT,
  package_name TEXT,
  file TEXT NOT NULL,
  started_at INTEGER,
  duration_ms INTEGER,
  setup_ms INTEGER,
  collect_ms INTEGER,
  environment_setup_ms INTEGER,
  prepare_ms INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  PRIMARY KEY (run_id, file)
);
CREATE INDEX IF NOT EXISTS files_file ON files (file);

CREATE TABLE IF NOT EXISTS tests (
  run_id TEXT NOT NULL,
  pid INTEGER,
  file TEXT NOT NULL,
  full_name TEXT NOT NULL,
  state TEXT NOT NULL,
  duration_ms INTEGER,
  started_at INTEGER,
  retry_count INTEGER,
  failure_class TEXT,
  failure_message TEXT,
  PRIMARY KEY (run_id, file, full_name)
);
CREATE INDEX IF NOT EXISTS tests_identity ON tests (file, full_name);
CREATE INDEX IF NOT EXISTS tests_state ON tests (state);

/** Which run directories have already been folded in, so ingest is idempotent. */
CREATE TABLE IF NOT EXISTS ingested_runs (
  run_id TEXT PRIMARY KEY,
  ingested_at INTEGER NOT NULL
);
`

//#endregion
//#region src/store/open.ts
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
async function openLedger() {
  mkdirSync(ledgerDir(), { recursive: true })
  const database = await connect(databasePath())
  await database.exec(SCHEMA)
  return database
}

//#endregion
export {
  slowReport as a,
  flakyReport as c,
  isLedgerEvent as i,
  contentionReport as l,
  ingestAll as n,
  shapeReport as o,
  ingestRun as r,
  runsReport as s,
  openLedger as t,
  table as u,
}
