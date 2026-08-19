import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ingest } from '../src/store/ingest.ts'
import { withLedgerWriterLock } from '../src/store/lock.ts'
import { openLedger } from '../src/store/open.ts'
import { prune } from '../src/store/prune.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-prune-lock-'))
  process.env['TEST_LEDGER_DIR'] = directory
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
})

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function seedOldRun(): void {
  const startedAt = Date.now() - 200 * 24 * 60 * 60 * 1000
  const runDirectory = path.join(directory, 'runs', 'old')
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(
    path.join(runDirectory, '1.ndjson'),
    [
      JSON.stringify({ kind: 'run_start', runId: 'old', startedAt, branch: 'main' }),
      JSON.stringify({
        kind: 'test',
        runId: 'old',
        file: '/old.ts',
        fullName: 'old',
        state: 'passed',
      }),
    ].join('\n'),
  )
}

describe('prune', () => {
  /**
   * The holder has opened the database, just as ingest does for a fold. If
   * prune opens first, the driver rejects it instead of allowing it to wait for
   * the writer lock. This direct call avoids a child-process startup race.
   */
  it('waits for an ingest writer to release the database before pruning', async () => {
    seedOldRun()
    await ingest()

    let releaseWriter: () => void = () => undefined
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    let signalWriterReady: () => void = () => undefined
    const writerReady = new Promise<void>((resolve) => {
      signalWriterReady = resolve
    })

    const writer = withLedgerWriterLock(async () => {
      const database = await openLedger()
      signalWriterReady()

      try {
        await writerReleased
      } finally {
        await database.close()
      }
    })

    await writerReady

    let pruneFinished = false
    const pruning = prune(90).then(() => {
      pruneFinished = true
      return undefined
    })

    try {
      await sleep(300)
      expect(pruneFinished).toBe(false)
    } finally {
      releaseWriter()
      await writer
    }

    await pruning

    const database = await openLedger()
    expect(await database.prepare('SELECT run_id FROM runs').all()).toEqual([])
    await database.close()
  })
})
