import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import TestLedgerReporter from '../src/reporter.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-'))
  process.env['TEST_LEDGER_DIR'] = directory
  process.env['TEST_LEDGER_RUN_ID'] = 'run-1'
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
  delete process.env['TEST_LEDGER_RUN_ID']
})

/** Minimal stand-ins for Vitest's TestModule / TestCase shapes. */
function fakeModule(options: {
  moduleId: string
  tests: {
    fullName: string
    state: 'passed' | 'failed' | 'skipped'
    duration: number
    startTime: number
    retryCount?: number
    errors?: { name?: string; message?: string }[]
  }[]
}) {
  return {
    moduleId: options.moduleId,
    diagnostic: () => ({
      environmentSetupDuration: 3,
      prepareDuration: 4,
      collectDuration: 2,
      setupDuration: 1,
      duration: 10,
      heap: undefined,
      importDurations: {},
    }),
    children: {
      *allTests() {
        for (const test of options.tests) {
          yield {
            fullName: test.fullName,
            result: () => ({ state: test.state, errors: test.errors ?? [] }),
            diagnostic: () => ({
              duration: test.duration,
              startTime: test.startTime,
              retryCount: test.retryCount ?? 0,
              slow: false,
              heap: undefined,
            }),
          }
        }
      },
    },
  }
}

function readEvents(runId: string): Record<string, unknown>[] {
  const runDirectory = path.join(directory, 'runs', runId)
  return readdirSync(runDirectory).flatMap((name) =>
    readFileSync(path.join(runDirectory, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )
}

describe('the ledger reporter', () => {
  it('writes one file event and one test event per test', async () => {
    const reporter = new TestLedgerReporter({ lane: 'unit', packageName: '@repo/db' })

    await reporter.onTestModuleEnd(
      fakeModule({
        moduleId: '/abs/a.test.ts',
        tests: [
          { fullName: 'a > works', state: 'passed', duration: 5, startTime: 1000 },
          { fullName: 'a > breaks', state: 'failed', duration: 7, startTime: 1010 },
        ],
      }) as never,
    )

    const events = readEvents('run-1')
    const files = events.filter((event) => event['kind'] === 'file')
    const tests = events.filter((event) => event['kind'] === 'test')

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      lane: 'unit',
      packageName: '@repo/db',
      file: '/abs/a.test.ts',
      passed: 1,
      failed: 1,
      skipped: 0,
      setupMs: 1,
      collectMs: 2,
      environmentSetupMs: 3,
      prepareMs: 4,
    })
    expect(tests).toHaveLength(2)
  })

  it('classifies a failure and keeps the raw message', async () => {
    const reporter = new TestLedgerReporter({ lane: 'route', packageName: '@repo/events-api' })

    await reporter.onTestModuleEnd(
      fakeModule({
        moduleId: '/abs/b.test.ts',
        tests: [
          {
            fullName: 'b > times out',
            state: 'failed',
            duration: 5000,
            startTime: 1,
            errors: [{ name: 'Error', message: 'Test timed out in 5000ms' }],
          },
        ],
      }) as never,
    )

    const failure = readEvents('run-1').find((event) => event['kind'] === 'test')
    expect(failure).toMatchObject({
      failureClass: 'timeout',
      failureMessage: 'Test timed out in 5000ms',
    })
  })

  /**
   * The reporter runs inside the test path. A ledger that can red a suite is
   * worse than no ledger, so a broken destination must degrade to silence.
   */
  it('never throws when its destination is unwritable', async () => {
    process.env['TEST_LEDGER_DIR'] = '/proc/nonexistent-and-unwritable'
    const reporter = new TestLedgerReporter({ lane: 'unit', packageName: '@repo/db' })

    await expect(
      reporter.onTestModuleEnd(
        fakeModule({
          moduleId: '/abs/c.test.ts',
          tests: [{ fullName: 'c > works', state: 'passed', duration: 1, startTime: 1 }],
        }) as never,
      ),
    ).resolves.toBeUndefined()
  })

  it('writes nothing when disabled by environment', async () => {
    process.env['TEST_LEDGER_DISABLED'] = '1'
    const reporter = new TestLedgerReporter({ lane: 'unit', packageName: '@repo/db' })
    await reporter.onTestModuleEnd(
      fakeModule({
        moduleId: '/abs/e.test.ts',
        tests: [{ fullName: 'e > works', state: 'passed', duration: 1, startTime: 1 }],
      }) as never,
    )
    delete process.env['TEST_LEDGER_DISABLED']
    expect(() => readdirSync(path.join(directory, 'runs'))).toThrow()
  })

  it('mints its own run id when the envelope is absent', async () => {
    delete process.env['TEST_LEDGER_RUN_ID']
    const reporter = new TestLedgerReporter({ lane: 'unit', packageName: '@repo/db' })

    await reporter.onTestModuleEnd(
      fakeModule({
        moduleId: '/abs/d.test.ts',
        tests: [{ fullName: 'd > works', state: 'passed', duration: 1, startTime: 1 }],
      }) as never,
    )

    const runIds = readdirSync(path.join(directory, 'runs'))
    expect(runIds).toHaveLength(1)
    expect(runIds[0]).toMatch(/^[0-9a-f]{32}$/)
  })
})
