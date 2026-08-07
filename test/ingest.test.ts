import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ingest, ingestAll, ingestRun } from '../src/store/ingest.ts'
import { withIngestLock } from '../src/store/lock.ts'
import { openLedger } from '../src/store/open.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-'))
  process.env['TEST_LEDGER_DIR'] = directory
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
})

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function writeRun(runId: string, events: Record<string, unknown>[]): void {
  const runDirectory = path.join(directory, 'runs', runId)
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(
    path.join(runDirectory, '1.ndjson'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  )
}

describe('ingest', () => {
  it('folds a run directory into the tables', async () => {
    writeRun('r1', [
      { kind: 'run_start', runId: 'r1', startedAt: 100, branch: 'main', concurrency: 9 },
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', passed: 2, failed: 0 },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
      { kind: 'run_end', runId: 'r1', endedAt: 200, exitCode: 0 },
    ])

    const database = await openLedger()
    await ingestRun(database, 'r1')

    const runs = await database.prepare('SELECT * FROM runs').all()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ run_id: 'r1', started_at: 100, ended_at: 200, exit_code: 0 })

    const tests = await database.prepare('SELECT * FROM tests').all()
    expect(tests).toHaveLength(1)
  })

  /** Re-ingesting must not double-count, or every rate the reports compute is wrong. */
  it('is idempotent', async () => {
    writeRun('r1', [
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', passed: 1, failed: 0 },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
    ])

    const database = await openLedger()
    await ingestRun(database, 'r1')
    await ingestRun(database, 'r1')

    const tests = await database.prepare('SELECT * FROM tests').all()
    expect(tests).toHaveLength(1)
  })

  /**
   * `run_samples` and `turbo_tasks` have no primary key, so their idempotency
   * comes entirely from `ingestRun`'s short-circuit, not a per-row upsert.
   * The other idempotency test only checks `tests`, which would miss a
   * regression here.
   */
  it('is idempotent for append-only tables with no primary key', async () => {
    writeRun('r1', [
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', passed: 1, failed: 0 },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
      { kind: 'sample', runId: 'r1', at: 100, load1: 0.5, load5: 0.4 },
      { kind: 'turbo_task', runId: 'r1', packageName: '@repo/foo', task: 'build' },
    ])

    const database = await openLedger()
    await ingestRun(database, 'r1')
    await ingestRun(database, 'r1')

    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(1)
  })

  /** A caller naming a run directory that was never written gets a no-op, not a crash. */
  it('is a no-op when the run directory does not exist', async () => {
    const database = await openLedger()

    await expect(ingestRun(database, 'never-written')).resolves.toBe(0)
  })

  /**
   * ENOENT (no directory) is the only error `readRunEvents` swallows. A real
   * filesystem failure, exercised here as an unreadable run directory, must
   * reject rather than silently becoming an all-null `runs` row.
   */
  it('rejects rather than swallowing a real filesystem error', async () => {
    const runDirectory = path.join(directory, 'runs', 'r4')
    mkdirSync(runDirectory, { recursive: true })
    chmodSync(runDirectory, 0o000)

    try {
      const database = await openLedger()

      await expect(ingestRun(database, 'r4')).rejects.toThrow()
    } finally {
      /** Restore so the temp directory can still be cleaned up. */
      chmodSync(runDirectory, 0o755)
    }
  })

  /** A crashed writer leaves a truncated last line; one bad line must not lose the run. */
  it('skips malformed lines rather than discarding the run', async () => {
    const runDirectory = path.join(directory, 'runs', 'r2')
    mkdirSync(runDirectory, { recursive: true })
    writeFileSync(
      path.join(runDirectory, '1.ndjson'),
      [
        JSON.stringify({
          kind: 'test',
          runId: 'r2',
          file: '/a.ts',
          fullName: 'x',
          state: 'passed',
        }),
        '{"kind":"test","runId":"r2","fi',
      ].join('\n'),
    )

    const database = await openLedger()
    await ingestRun(database, 'r2')

    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(1)
  })

  it('records a run with no envelope as envelope-less', async () => {
    writeRun('r3', [{ kind: 'test', runId: 'r3', file: '/a.ts', fullName: 'x', state: 'passed' }])

    const database = await openLedger()
    await ingestRun(database, 'r3')

    const runs = await database.prepare('SELECT has_envelope FROM runs').all()
    expect(runs[0]).toMatchObject({ has_envelope: 0 })
  })

  /**
   * `isLedgerEvent` validates only `kind` and `runId`, so a truncated-but-
   * parseable `sample` line missing `at` (or any other field) must not abort
   * ingest of the rest of the run — it must bind `null`, the same as the
   * `file` and `test` branches already do.
   */
  it('does not abort ingest when a sample event is missing a field', async () => {
    writeRun('r1', [
      { kind: 'sample', runId: 'r1' },
      { kind: 'turbo_task', runId: 'r1' },
      { kind: 'test', runId: 'r1', file: '/a.ts', fullName: 'x', state: 'passed' },
    ])

    const database = await openLedger()

    await expect(ingestRun(database, 'r1')).resolves.toBeGreaterThan(0)
    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(1)
  })

  it('ingests every un-ingested run', async () => {
    writeRun('r1', [{ kind: 'test', runId: 'r1', file: '/a.ts', fullName: 'x', state: 'passed' }])
    writeRun('r2', [{ kind: 'test', runId: 'r2', file: '/b.ts', fullName: 'y', state: 'failed' }])

    const database = await openLedger()
    const result = await ingestAll(database)

    expect(result.runs).toBe(2)
    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(2)
  })

  /**
   * The last `file` or `test` event for a given primary key wins, matching the
   * row-at-a-time upserts this replaced. Batching made this the caller's job:
   * two rows with the same key in one `VALUES` list is not behavior to lean on.
   */
  it('converges on the last event for a repeated file or test', async () => {
    writeRun('r1', [
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', durationMs: 1 },
      { kind: 'file', runId: 'r1', file: '/a.test.ts', lane: 'unit', durationMs: 2 },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'failed' },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
    ])

    const database = await openLedger()
    await ingestRun(database, 'r1')

    const files = await database.prepare('SELECT * FROM files').all()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ duration_ms: 2 })

    const tests = await database.prepare('SELECT * FROM tests').all()
    expect(tests).toHaveLength(1)
    expect(tests[0]).toMatchObject({ state: 'passed' })
  })

  /**
   * The idempotency window this closes: `run_samples` and `turbo_tasks` are
   * append-only with no per-row key, so a fold that died after their inserts
   * but before the `ingested_runs` marker used to leave rows the retry
   * duplicated. The whole fold is one transaction now, so a failed attempt
   * leaves nothing behind and the retry writes exactly one copy.
   */
  it('leaves no rows behind when a fold fails partway, and does not duplicate on retry', async () => {
    writeRun('r1', [
      { kind: 'sample', runId: 'r1', at: 100, load1: 0.5, load5: 0.4 },
      { kind: 'turbo_task', runId: 'r1', packageName: '@repo/foo', task: 'test' },
      { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
    ])

    const database = await openLedger()

    /**
     * Stands in for a crash: the `tests` insert is the last table written
     * before the `ingested_runs` marker, so failing it lands the process
     * exactly inside the old window.
     */
    let failNextTestsInsert = true
    const crashing = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (failNextTestsInsert && sql.startsWith('INSERT INTO tests')) {
              throw new Error('simulated crash mid-ingest')
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    await expect(ingestRun(crashing, 'r1')).rejects.toThrow('simulated crash mid-ingest')

    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(0)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(0)
    expect(await database.prepare('SELECT * FROM ingested_runs').all()).toHaveLength(0)

    failNextTestsInsert = false
    await ingestRun(database, 'r1')

    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(1)
  })

  /**
   * The lock is only load-bearing if it is taken before the database file is
   * opened: the driver locks that file exclusively at open, so an `ingest` that
   * opened first would crash rather than queue. `ingest()` is the entry point
   * that gets the ordering right, and this pins it — the sweep must not finish
   * until an unrelated lock holder has let go.
   */
  it('waits for the ingest lock before opening the ledger', async () => {
    writeRun('r1', [{ kind: 'test', runId: 'r1', file: '/a.ts', fullName: 'x', state: 'passed' }])

    const completed: string[] = []

    const holder = withIngestLock(async () => {
      await sleep(300)
      completed.push('holder')
    })
    const sweep = ingest().then((result) => {
      completed.push('ingest')
      return result
    })

    const [, result] = await Promise.all([holder, sweep])

    expect(completed).toEqual(['holder', 'ingest'])
    expect(result.runs).toBe(1)

    const database = await openLedger()
    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(1)
  })
})
