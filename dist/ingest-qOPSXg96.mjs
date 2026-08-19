import {
  a as runDir,
  i as ledgerWriterLockPath,
  o as runsDir,
  r as ledgerDir,
  t as databasePath,
} from './paths-ZwcASZDt.mjs'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { hostname } from 'node:os'
import { open, readFile, rm, stat } from 'node:fs/promises'
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
              COALESCE(r.queued_ms, 0) AS queuedMs,
              COALESCE(r.queue_timed_out, 0) AS queueTimedOut,
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
//#region src/store/lock.ts
/**
 * How long to keep retrying before giving up on a held lock.
 *
 * **Must stay comfortably larger than {@link STALE_AFTER_MS}**, and that is the
 * whole reason for the value. A waiter that gave up first could never reach the
 * reclamation path for a lock that went stale while it waited — it would exit
 * minutes before the lock became eligible — so the only reclaimable lock would
 * be one already stale when the waiter arrived. The earlier one-minute budget
 * had exactly that defect.
 *
 * The upper bound is also sized against a real fold rather than a typical one.
 * A batched full-suite run is well under a second, but a first ingest of a long
 * backlog is legitimately minutes (999 runs measured at 53s), and a waiter
 * behind one should queue rather than fail.
 */
const ACQUIRE_TIMEOUT_MS = 900 * 1e3
const RETRY_INTERVAL_MS = 100
/**
 * A lock file older than this *may* be reclaimed — but only once its holder is
 * also shown to be gone (see {@link holderIsAlive}).
 *
 * A process killed with `SIGKILL` never runs its release, so without
 * reclamation a single hard kill would wedge every later writer on the machine
 * permanently. Age alone is deliberately not sufficient: a first ingest of a
 * long backlog legitimately runs for hours, and reclaiming the lock out from
 * under a live one is the worse failure of the two.
 */
const STALE_AFTER_MS = 600 * 1e3
async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
/** Reads the lock file, returning `undefined` for anything unreadable or malformed. */
async function readLockFile(path$1) {
  try {
    const parsed = JSON.parse(await readFile(path$1, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return void 0
    const record = parsed
    if (typeof record['token'] !== 'string') return void 0
    return {
      token: record['token'],
      pid: typeof record['pid'] === 'number' ? record['pid'] : 0,
      host: typeof record['host'] === 'string' ? record['host'] : 'unknown',
      acquiredAt: typeof record['acquiredAt'] === 'number' ? record['acquiredAt'] : 0,
    }
  } catch {
    /**
     * The holder may be mid-write, or may have died between creating the file
     * and filling it. Either way there is nothing to read; staleness is judged
     * from the file's mtime instead, which exists regardless of contents.
     */
    return
  }
}
/**
 * Whether the recorded holder is still running.
 *
 * Only answerable for a lock taken on this host — a pid from another machine
 * says nothing about a local process table — so a foreign lock reports `false`
 * and is reclaimable on age alone, which is the best available answer when the
 * ledger directory is shared.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid is
 * addressable. `EPERM` means the process exists but belongs to another user,
 * which still counts as alive.
 *
 * Pid reuse is the known imprecision: if the holder died and an unrelated
 * process inherited its pid, this reports alive and the lock is never
 * reclaimed, so acquisition fails with the timeout message naming that pid
 * instead. That is the safe direction to be wrong in: a stuck writer the user
 * can diagnose beats two writers that both believe they hold the lock.
 */
function holderIsAlive(holder) {
  if (holder === void 0 || holder.pid <= 0) return false
  if (holder.host !== hostname()) return false
  try {
    process.kill(holder.pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
/**
 * Removes a lock file that is both older than {@link STALE_AFTER_MS} and whose
 * holder is no longer running. Returns whether the caller should retry the
 * exclusive create immediately rather than sleeping out another interval.
 *
 * **This is not an atomic take-over, and does not claim to be.** Between the
 * `stat` that finds the lock stale and the `rm` that removes it, the original
 * holder could in principle release and a successor acquire, and this would
 * then delete the successor's fresh lock. Re-reading the token immediately
 * before removing narrows that window to the gap between the two calls, but
 * does not close it — closing it needs an OS advisory lock (`flock`/`fcntl`),
 * which Node does not expose without a native dependency.
 *
 * The residual race is tolerated because its cost here is bounded and visible.
 * Reaching it requires a lock left by a dead process, two writers racing to
 * reclaim it within the same instant, and a third acquiring in between. The
 * outcome is not a corrupt ledger: writer commands take this lock *before*
 * opening the database, so a successor will wait unless it lands in this narrow
 * reclaim race.
 */
async function reclaimIfStale(path$1) {
  let modifiedAt
  try {
    modifiedAt = (await stat(path$1)).mtimeMs
  } catch (error) {
    if (error.code === 'ENOENT')
      /** Released between the failed create and this check: retry immediately. */
      return true
    /**
     * Anything else (`EACCES`, `EIO`, ...) is a real filesystem failure. It must
     * propagate rather than read as "the lock vanished": treating it as a
     * disappearance returns the caller to the top of its retry loop, where a
     * persistent error would spin without ever sleeping or reaching the
     * deadline.
     */
    throw error
  }
  if (Date.now() - modifiedAt < STALE_AFTER_MS) return false
  const holder = await readLockFile(path$1)
  if (holderIsAlive(holder)) return false
  if ((await readLockFile(path$1))?.token !== holder?.token) return false
  await rm(path$1, { force: true })
  return true
}
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
async function withLedgerWriterLock(fn) {
  const path$1 = ledgerWriterLockPath()
  const token = crypto.randomUUID()
  mkdirSync(ledgerDir(), { recursive: true })
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    let acquired = false
    try {
      const handle = await open(path$1, 'wx')
      acquired = true
      try {
        const contents = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: Date.now(),
        }
        await handle.writeFile(JSON.stringify(contents))
        await handle.close()
      } catch (error) {
        /**
         * The exclusive create succeeded, so this process owns the file even
         * though it failed to describe itself in it. Leaving it behind would
         * block every later writer until the staleness window expired, over a
         * failure that has nothing to do with contention.
         */
        try {
          await handle.close()
        } catch {}
        try {
          await rm(path$1, { force: true })
        } catch {}
        throw error
      }
      break
    } catch (error) {
      if (acquired) throw error
      if (error.code !== 'EEXIST') throw error
      /**
       * Checked before the reclaim attempt, so it bounds every path through
       * this loop. Checking it only on the contended branch let a lock that
       * kept appearing and disappearing spin without a ceiling.
       */
      if (Date.now() >= deadline) {
        const holder = await readLockFile(path$1)
        throw new Error(
          `test-ledger ledger writer lock at ${path$1} is held by pid ${holder?.pid ?? 'unknown'} on ${holder?.host ?? 'unknown'}; gave up after ${ACQUIRE_TIMEOUT_MS}ms`,
          { cause: error },
        )
      }
      if (!(await reclaimIfStale(path$1))) await sleep(RETRY_INTERVAL_MS)
    }
  }
  try {
    return await fn()
  } finally {
    if ((await readLockFile(path$1))?.token === token) await rm(path$1, { force: true })
  }
}

//#endregion
//#region src/store/schema.ts
/**
 * The phase 1 schema.
 *
 * Every fresh-table statement is `IF NOT EXISTS`, so opening an empty ledger
 * is idempotent. `openLedger` applies additive column upgrades separately for
 * schema changes that must work against an existing ledger file.
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
  queued_ms INTEGER,
  queue_timed_out INTEGER,
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
const RUN_COLUMN_UPGRADES = [
  {
    name: 'queued_ms',
    statement: 'ALTER TABLE runs ADD COLUMN queued_ms INTEGER',
  },
  {
    name: 'queue_timed_out',
    statement: 'ALTER TABLE runs ADD COLUMN queue_timed_out INTEGER',
  },
]
/** Adds columns introduced after an existing ledger file's `runs` table was first created. */
async function applyRunColumnUpgrades(database) {
  for (const upgrade of RUN_COLUMN_UPGRADES)
    if (
      (await database
        .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
        .get(['runs', upgrade.name])) === void 0
    )
      await database.exec(upgrade.statement)
}
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
  await applyRunColumnUpgrades(database)
  return database
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
 * Bound parameters per `INSERT`, which sets how many rows go in one statement.
 *
 * Comfortably under SQLite's 32,766-variable ceiling, and past the point where
 * a wider batch still buys anything: a full-suite run's ~13,000 rows already
 * fold in a handful of statements per table, and the remaining cost is the
 * engine's, not the round trip's.
 */
const MAX_BOUND_PARAMETERS = 4e3
/** `ON CONFLICT (keys) DO UPDATE SET` over every column that is not part of the key. */
function upsertClause(keyColumns, columns) {
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
async function insertRows(database, table$1, columns, rows, onConflict = '') {
  if (rows.length === 0) return
  const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / columns.length))
  const tuple = `(${columns.map(() => '?').join(',')})`
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk)
    await database
      .prepare(
        `INSERT INTO ${table$1} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(',')}${onConflict}`,
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
async function inTransaction(database, fn) {
  await database.exec('BEGIN IMMEDIATE')
  try {
    const result = await fn()
    await database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      await database.exec('ROLLBACK')
    } catch {}
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
  'queued_ms',
  'queue_timed_out',
  'turbo_force',
  'has_envelope',
]
const SAMPLE_COLUMNS = ['run_id', 'at', 'load1', 'load5', 'free_memory_bytes', 'live_slots']
const TURBO_TASK_COLUMNS = ['run_id', 'package_name', 'task', 'duration_ms', 'cache_status']
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
]
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
]
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
async function ingestRun(database, runId) {
  if (
    (await database.prepare('SELECT 1 FROM ingested_runs WHERE run_id = ?').get([runId])) !== void 0
  )
    return 0
  const events = readRunEvents(runId)
  const start = events.find((event) => event.kind === 'run_start')
  const end = events.find((event) => event.kind === 'run_end')
  const runRow = [
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
    start?.queuedMs ?? null,
    start?.queueTimedOut === void 0 ? null : Number(start.queueTimedOut),
    start?.turboForce === void 0 ? null : Number(start.turboForce),
    start === void 0 ? 0 : 1,
  ]
  const sampleRows = []
  const turboTaskRows = []
  /** Keyed by the table's primary key, so a repeated event converges instead of conflicting. */
  const fileRows = /* @__PURE__ */ new Map()
  const testRows = /* @__PURE__ */ new Map()
  for (const event of events)
    if (event.kind === 'sample')
      sampleRows.push([
        runId,
        event.at ?? null,
        event.load1 ?? null,
        event.load5 ?? null,
        event.freeMemoryBytes ?? null,
        event.liveSlots ?? null,
      ])
    else if (event.kind === 'turbo_task')
      turboTaskRows.push([
        runId,
        event.packageName ?? null,
        event.task ?? null,
        event.durationMs ?? null,
        event.cacheStatus ?? null,
      ])
    else if (event.kind === 'file')
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
    else if (event.kind === 'test')
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
      .prepare(`INSERT INTO ingested_runs (run_id, ingested_at) VALUES (?,?)
         ON CONFLICT (run_id) DO UPDATE SET ingested_at = excluded.ingested_at`)
      .run([runId, Date.now()])
    return sampleRows.length + turboTaskRows.length + fileRows.size + testRows.size
  })
}
/** The sweep itself. Both exported entry points below run it under the ledger writer lock. */
async function foldUnIngestedRuns(database) {
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
async function ingestAll(database) {
  return await withLedgerWriterLock(async () => {
    return await foldUnIngestedRuns(database)
  })
}
/**
 * Closes the ledger without letting the close itself change the outcome.
 *
 * Once the fold has committed, its rows are durable, so a failure to close is
 * not a failure to ingest — reporting one would call a successful run broken.
 * And when the fold already threw, that error is the one describing what went
 * wrong; a close failure must not displace it.
 *
 * The one cost worth naming: a connection that failed to close may still hold
 * the driver's exclusive OS lock on `ledger.db` after this function releases
 * the ledger writer lock, so the next writer could fail at open rather than queue.
 * For the CLI that is unreachable — the process exits immediately afterward and
 * the OS drops the handle — and for a long-lived caller a failed close is
 * already a broken connection it has to deal with. Swallowing is still the
 * right trade against reporting a committed fold as failed.
 */
async function closeQuietly(database) {
  try {
    await database.close()
  } catch {}
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
async function checkpointQuietly(database) {
  try {
    await database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {}
}
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
async function ingest() {
  return await withLedgerWriterLock(async () => {
    const database = await openLedger()
    let folded
    try {
      folded = await foldUnIngestedRuns(database)
    } catch (error) {
      /**
       * Checkpoint on the way out of a *failed* sweep too, not only a clean
       * one. A sweep commits run by run, so one that dies on run 900 still
       * committed 899 runs' worth of WAL frames — and a long backlog fold
       * dying partway is precisely how the 41 GB WAL that motivated this
       * happened. Skipping the checkpoint here would leave the worst case
       * uncovered while handling the cheap one.
       */
      await checkpointQuietly(database)
      await closeQuietly(database)
      throw error
    }
    await checkpointQuietly(database)
    await closeQuietly(database)
    return folded
  })
}

//#endregion
export {
  withLedgerWriterLock as a,
  shapeReport as c,
  contentionReport as d,
  table as f,
  openLedger as i,
  runsReport as l,
  ingestAll as n,
  isLedgerEvent as o,
  ingestRun as r,
  slowReport as s,
  ingest as t,
  flakyReport as u,
}
