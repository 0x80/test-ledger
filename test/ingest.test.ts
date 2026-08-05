import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ingestAll, ingestRun } from '../src/store/ingest.ts'
import { openLedger } from '../src/store/open.ts'

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
})
