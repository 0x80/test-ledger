import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeRunEnd, writeRunStart } from '../src/envelope.ts'
import { startSampler } from '../src/sampler.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-'))
  process.env['TEST_LEDGER_DIR'] = directory
})

afterEach(() => {
  delete process.env['TEST_LEDGER_DIR']
})

function readAll(runId: string): Record<string, unknown>[] {
  const runDirectory = path.join(directory, 'runs', runId)
  return readdirSync(runDirectory).flatMap((name) =>
    readFileSync(path.join(runDirectory, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  )
}

describe('the run envelope', () => {
  it('writes a start and an end event', () => {
    writeRunStart('r1', {
      invocation: 'pnpm test',
      repo: 'randezvous',
      branch: 'main',
      worktree: 'main',
      gitSha: 'abc',
      dirty: false,
      concurrency: 9,
      liveSlots: 1,
      turboForce: true,
    })
    writeRunEnd('r1', 0)

    const events = readAll('r1')
    expect(events.find((event) => event['kind'] === 'run_start')).toMatchObject({
      branch: 'main',
      concurrency: 9,
      turboForce: true,
    })
    expect(events.find((event) => event['kind'] === 'run_end')).toMatchObject({ exitCode: 0 })
  })

  it('never throws when the destination is unwritable', () => {
    process.env['TEST_LEDGER_DIR'] = '/proc/nonexistent-and-unwritable'
    expect(() => {
      writeRunEnd('r9', 1)
    }).not.toThrow()
  })

  it('samples on an interval until stopped', async () => {
    const stop = startSampler('r2', { intervalMs: 10, liveSlots: () => 2 })
    await new Promise((resolve) => {
      setTimeout(resolve, 60)
    })
    stop()

    const samples = readAll('r2').filter((event) => event['kind'] === 'sample')

    /**
     * `startSampler` always writes once immediately and once on stop, so
     * `>= 2` would pass even if `setInterval` were never wired up at all.
     * Requiring a third sample proves the interval fired at least once
     * during the 60ms wait, and requiring more than one distinct `at`
     * timestamp rules out three writes landing in the same tick.
     */
    expect(samples.length).toBeGreaterThan(2)
    expect(samples[0]).toMatchObject({ liveSlots: 2 })

    const distinctTimestamps = new Set(samples.map((sample) => sample['at']))
    expect(distinctTimestamps.size).toBeGreaterThan(1)
  })
})
