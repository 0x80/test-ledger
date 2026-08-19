import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect } from '@tursodatabase/database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { flakyReport } from '../src/reports/flaky.ts'
import { contentionReport } from '../src/reports/contention.ts'
import { shapeReport } from '../src/reports/shape.ts'
import { slowReport } from '../src/reports/slow.ts'
import { ingestAll } from '../src/store/ingest.ts'
import { openLedger } from '../src/store/open.ts'
import { databasePath } from '../src/paths.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-'))
  process.env['TEST_LEDGER_DIR'] = directory
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
})

function writeRun(runId: string, events: Record<string, unknown>[]): void {
  const runDirectory = path.join(directory, 'runs', runId)
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(
    path.join(runDirectory, '1.ndjson'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  )
}

/** Four runs of one test: three pass, one fails with a timeout. */
function seedFlaky(): void {
  for (const [index, state] of ['passed', 'failed', 'passed', 'passed'].entries()) {
    writeRun(`r${index}`, [
      {
        kind: 'file',
        runId: `r${index}`,
        file: '/a.test.ts',
        lane: 'unit',
        durationMs: 100,
        passed: state === 'passed' ? 1 : 0,
        failed: state === 'failed' ? 1 : 0,
      },
      {
        kind: 'test',
        runId: `r${index}`,
        file: '/a.test.ts',
        fullName: 'a > sometimes',
        state,
        durationMs: 10,
        ...(state === 'failed' ? { failureClass: 'timeout' } : {}),
      },
    ])
  }
}

describe('reports', () => {
  it('ranks a flaky test with its denominator', async () => {
    seedFlaky()
    const database = await openLedger()
    await ingestAll(database)

    const rows = await flakyReport(database, { minRuns: 2 })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      file: '/a.test.ts',
      fullName: 'a > sometimes',
      runs: 4,
      failures: 1,
    })
    expect(rows[0]?.failureRate).toBeCloseTo(0.25)
    expect(rows[0]?.classes).toContain('timeout')
  })

  /** A test that always passes is not flaky and must not appear. */
  it('omits a test that never failed', async () => {
    writeRun('r1', [
      { kind: 'test', runId: 'r1', file: '/b.ts', fullName: 'b > x', state: 'passed' },
    ])
    const database = await openLedger()
    await ingestAll(database)

    expect(await flakyReport(database, { minRuns: 1 })).toHaveLength(0)
  })

  /** Below the denominator threshold a rate is noise, not signal. */
  it('omits a test seen fewer times than minRuns', async () => {
    writeRun('r1', [
      { kind: 'test', runId: 'r1', file: '/c.ts', fullName: 'c > x', state: 'failed' },
    ])
    const database = await openLedger()
    await ingestAll(database)

    expect(await flakyReport(database, { minRuns: 5 })).toHaveLength(0)
  })

  /**
   * The denominator must be the number of runs THIS test appeared in, not the
   * total number of runs in the ledger. r1/r2 carry test A only; r3/r4 carry an
   * unrelated test B and never mention A. A denominator computed from the
   * whole ledger would read A as 4 runs / 1 failure (rate 0.25); the correct
   * per-test count is 2 runs / 1 failure (rate 0.5). A test added recently must
   * not read as more stable merely because the ledger holds older runs it was
   * never part of.
   */
  it('scopes the denominator to runs the test appeared in, not every run in the ledger', async () => {
    writeRun('r1', [
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > sometimes', state: 'passed' },
    ])
    writeRun('r2', [
      { kind: 'test', runId: 'r2', file: '/a.test.ts', fullName: 'a > sometimes', state: 'failed' },
    ])
    writeRun('r3', [
      { kind: 'test', runId: 'r3', file: '/b.test.ts', fullName: 'b > other', state: 'passed' },
    ])
    writeRun('r4', [
      { kind: 'test', runId: 'r4', file: '/b.test.ts', fullName: 'b > other', state: 'passed' },
    ])
    const database = await openLedger()
    await ingestAll(database)

    const rows = await flakyReport(database, { minRuns: 2 })
    const row = rows.find((candidate) => candidate.fullName === 'a > sometimes')

    expect(row).toMatchObject({ runs: 2, failures: 1 })
    expect(row?.failureRate).toBeCloseTo(0.5)
  })

  /** GROUP_CONCAT(DISTINCT ...) returns NULL for an all-NULL group; the row must surface '' instead. */
  it('reports an empty classes string when the failure has no class', async () => {
    writeRun('r1', [
      { kind: 'test', runId: 'r1', file: '/d.ts', fullName: 'd > x', state: 'failed' },
    ])
    writeRun('r2', [
      { kind: 'test', runId: 'r2', file: '/d.ts', fullName: 'd > x', state: 'passed' },
    ])
    const database = await openLedger()
    await ingestAll(database)

    const rows = await flakyReport(database, { minRuns: 2 })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.classes).toBe('')
  })

  it('ranks slow files by share of total wall-clock', async () => {
    writeRun('r1', [
      { kind: 'file', runId: 'r1', file: '/fast.ts', lane: 'unit', durationMs: 100 },
      { kind: 'file', runId: 'r1', file: '/slow.ts', lane: 'unit', durationMs: 900 },
    ])
    const database = await openLedger()
    await ingestAll(database)

    const rows = await slowReport(database, { limit: 10 })

    expect(rows[0]).toMatchObject({ file: '/slow.ts', totalMs: 900 })
    expect(rows[0]?.shareOfTotal).toBeCloseTo(0.9)
  })

  /**
   * A test that failed then passed on retry must still surface: `failures`
   * alone would miss it because its final recorded state is 'passed', even
   * though `retry_count > 0` marks it as unstable.
   */
  it('surfaces a test that passed only after a retry', async () => {
    writeRun('r1', [
      {
        kind: 'test',
        runId: 'r1',
        file: '/e.test.ts',
        fullName: 'e > retried',
        state: 'passed',
        retryCount: 1,
      },
    ])
    writeRun('r2', [
      {
        kind: 'test',
        runId: 'r2',
        file: '/e.test.ts',
        fullName: 'e > retried',
        state: 'passed',
        retryCount: 0,
      },
    ])

    const database = await openLedger()
    await ingestAll(database)

    const rows = await flakyReport(database, { minRuns: 2 })
    const row = rows.find((candidate) => candidate.fullName === 'e > retried')

    expect(row).toMatchObject({ runs: 2, failures: 0, retries: 1 })
  })

  /** Turbo cache-status counts land in `shape`, joined in by package only. */
  it('reports turbo task cache-hit and cache-miss counts by package', async () => {
    writeRun('r1', [
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', packageName: '@repo/db' },
      {
        kind: 'turbo_task',
        runId: 'r1',
        packageName: '@repo/db',
        task: 'test',
        cacheStatus: 'HIT',
      },
      {
        kind: 'turbo_task',
        runId: 'r1',
        packageName: '@repo/db',
        task: 'build',
        cacheStatus: 'MISS',
      },
    ])
    const database = await openLedger()
    await ingestAll(database)

    const rows = await shapeReport(database)
    const row = rows.find((candidate) => candidate.packageName === '@repo/db')

    expect(row).toMatchObject({ turboTasks: 2, turboCacheHits: 1, turboCacheMisses: 1 })
  })

  it('persists an integration queue wait and reports it with host contention', async () => {
    writeRun('r1', [
      {
        kind: 'run_start',
        runId: 'r1',
        startedAt: 100,
        branch: 'ran-2228',
        concurrency: 3,
        queuedMs: 12_500,
        queueTimedOut: true,
      },
      { kind: 'sample', runId: 'r1', at: 110, load1: 4, liveSlots: 3 },
      { kind: 'run_end', runId: 'r1', endedAt: 200, exitCode: 0 },
    ])
    const database = await openLedger()
    await ingestAll(database)

    const stored = await database
      .prepare('SELECT queued_ms, queue_timed_out FROM runs WHERE run_id = ?')
      .get(['r1'])
    expect(stored).toMatchObject({ queued_ms: 12_500, queue_timed_out: 1 })

    await expect(contentionReport(database)).resolves.toMatchObject([
      { runId: 'r1', queuedMs: 12_500, queueTimedOut: 1 },
    ])
  })

  it('adds the queue fields to a ledger created before they existed', async () => {
    const legacy = await connect(databasePath())
    await legacy.exec(`
      CREATE TABLE runs (
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
        has_envelope INTEGER NOT NULL DEFAULT 0
      );
    `)
    await legacy.close()

    const database = await openLedger()
    const columns = await database.prepare('PRAGMA table_info(runs)').all()
    const names = columns.map((column) => (column as { name: string }).name)

    expect(names).toContain('queued_ms')
    expect(names).toContain('queue_timed_out')
  })
})
