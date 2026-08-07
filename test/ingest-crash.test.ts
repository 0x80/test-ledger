import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ingestRun } from '../src/store/ingest.ts'
import { openLedger } from '../src/store/open.ts'

/**
 * Spawning a real child process is the point of this file, and child startup is
 * wall-clock this suite does not control — under a loaded host it stretches far
 * past Vitest's default per-test budget.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const ingestModule = path.join(import.meta.dirname, '..', 'src', 'store', 'ingest.ts')
const openModule = path.join(import.meta.dirname, '..', 'src', 'store', 'open.ts')

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-crash-'))
  process.env['TEST_LEDGER_DIR'] = directory
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
})

/**
 * A child that folds one run and hard-kills itself partway through, from inside
 * the transaction.
 *
 * `SIGKILL` on its own pid is what makes this the real case rather than a
 * simulation: nothing unwinds, no `finally` runs, no `ROLLBACK` is issued, and
 * the database is left to recover on its own — which is precisely the crash the
 * acceptance criterion describes and precisely what a caught-and-rolled-back
 * exception cannot exercise. The kill is triggered off the `tests` insert, the
 * last table written before the `ingested_runs` marker, so it lands inside the
 * window where `run_samples` and `turbo_tasks` rows already exist.
 */
const CHILD_SOURCE = `
import { writeFileSync } from 'node:fs'

import { ingestRun } from ${JSON.stringify(ingestModule)}
import { openLedger } from ${JSON.stringify(openModule)}

const database = await openLedger()

const killing = new Proxy(database, {
  get(target, property) {
    if (property === 'prepare') {
      return (sql) => {
        if (sql.startsWith('INSERT INTO tests')) {
          /**
           * Written immediately before the kill, so the parent can prove the
           * child reached this point rather than dying on startup — without it
           * a child that never ran at all would satisfy the row assertions just
           * as well, and the test would pass having exercised nothing.
           */
          writeFileSync(process.env.CRASH_MARKER, 'reached the tests insert')
          process.kill(process.pid, 'SIGKILL')
        }
        return target.prepare(sql)
      }
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

await ingestRun(killing, 'r1')
`

describe('ingest after an abrupt interruption', () => {
  it('leaves no partial rows behind and does not duplicate them on retry', async () => {
    const runDirectory = path.join(directory, 'runs', 'r1')
    mkdirSync(runDirectory, { recursive: true })
    writeFileSync(
      path.join(runDirectory, '1.ndjson'),
      [
        { kind: 'run_start', runId: 'r1', startedAt: 100 },
        { kind: 'sample', runId: 'r1', at: 100, load1: 0.5, load5: 0.4 },
        { kind: 'turbo_task', runId: 'r1', packageName: '@repo/foo', task: 'test' },
        { kind: 'test', runId: 'r1', file: '/a.test.ts', fullName: 'a > x', state: 'passed' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    )

    const childPath = path.join(directory, 'crash-child.mjs')
    writeFileSync(childPath, CHILD_SOURCE)
    const markerPath = path.join(directory, 'reached-tests-insert')

    const child = spawnSync(process.execPath, ['--experimental-strip-types', childPath], {
      env: { ...process.env, TEST_LEDGER_DIR: directory, CRASH_MARKER: markerPath },
      encoding: 'utf8',
    })

    /**
     * Both assertions are load-bearing. The signal proves the child died the way
     * this test needs it to; the marker proves it died *inside* the transaction,
     * with `run_samples` and `turbo_tasks` rows already written. Without the
     * second one a child that crashed on startup would sail through everything
     * below.
     */
    expect(child.signal, `child stderr: ${child.stderr || '(none)'}`).toBe('SIGKILL')
    expect(existsSync(markerPath)).toBe(true)

    const database = await openLedger()

    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(0)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(0)
    expect(await database.prepare('SELECT * FROM ingested_runs').all()).toHaveLength(0)

    await ingestRun(database, 'r1')

    expect(await database.prepare('SELECT * FROM run_samples').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM turbo_tasks').all()).toHaveLength(1)
    expect(await database.prepare('SELECT * FROM tests').all()).toHaveLength(1)
  })
})
