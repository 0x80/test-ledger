import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openLedger } from '../src/store/open.ts'
import { withLedgerWriterLock } from '../src/store/lock.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-'))
  const runDirectory = path.join(directory, 'runs', 'r1')
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(
    path.join(runDirectory, '1.ndjson'),
    [
      JSON.stringify({ kind: 'file', runId: 'r1', file: '/a.ts', lane: 'unit', durationMs: 10 }),
      JSON.stringify({ kind: 'test', runId: 'r1', file: '/a.ts', fullName: 'x', state: 'failed' }),
    ].join('\n'),
  )
})

function run(...args: string[]): string {
  return execFileSync('node', [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TEST_LEDGER_DIR: directory },
  })
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

type CommandResult = {
  error: Error | undefined
  exitCode: number | null
  stderr: string
  stdout: string
}

function runAsync(ledgerDirectory: string, ...args: string[]): Promise<CommandResult> {
  const child = spawn('node', [cli, ...args], {
    env: { ...process.env, TEST_LEDGER_DIR: ledgerDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  return new Promise<CommandResult>((resolve) => {
    let settled = false
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.on('error', (error: Error) => {
      finish({ error, exitCode: null, stderr, stdout })
    })
    child.on('close', (exitCode: number | null) => {
      finish({ error: undefined, exitCode, stderr, stdout })
    })
  })
}

describe('the CLI', () => {
  it('ingests and then reports', () => {
    expect(run('ingest')).toContain('1 run')
    expect(run('flaky', '--min-runs', '1')).toContain('/a.ts')
    expect(run('slow')).toContain('/a.ts')
  })

  it('reports an empty ledger without failing', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'ledger-empty-'))
    const output = execFileSync('node', [cli, 'flaky'], {
      encoding: 'utf8',
      env: { ...process.env, TEST_LEDGER_DIR: empty },
    })
    expect(output).toContain('no ')
  })

  it('reports contention, shape, and run history', () => {
    run('ingest')
    expect(run('contention')).toContain('r1')
    expect(run('shape')).toContain('unit')
    expect(run('runs')).toContain('r1')
  })
})

describe('the prune subcommand', () => {
  let pruneDirectory: string

  beforeEach(() => {
    pruneDirectory = mkdtempSync(path.join(tmpdir(), 'ledger-prune-'))
  })

  afterEach(() => {
    delete process.env['TEST_LEDGER_DIR']
  })

  /** Writes a run directory with an envelope, a sample, a Turbo task, a file, and a test. */
  function seedRun(runId: string, startedAt: number): void {
    const runDirectory = path.join(pruneDirectory, 'runs', runId)
    mkdirSync(runDirectory, { recursive: true })
    writeFileSync(
      path.join(runDirectory, '1.ndjson'),
      [
        JSON.stringify({ kind: 'run_start', runId, startedAt, branch: 'main' }),
        JSON.stringify({ kind: 'run_end', runId, endedAt: startedAt + 1000, exitCode: 0 }),
        JSON.stringify({ kind: 'sample', runId, at: startedAt + 500, load1: 1, liveSlots: 1 }),
        JSON.stringify({
          kind: 'turbo_task',
          runId,
          packageName: '@repo/foo',
          task: 'test',
          durationMs: 100,
          cacheStatus: 'MISS',
        }),
        JSON.stringify({ kind: 'file', runId, file: `/${runId}.ts`, lane: 'unit', durationMs: 10 }),
        JSON.stringify({
          kind: 'test',
          runId,
          file: `/${runId}.ts`,
          fullName: `${runId} > x`,
          state: 'passed',
        }),
      ].join('\n'),
    )
  }

  /**
   * Seeds an old run (well past a 90-day retention window) and a recent one,
   * prunes with `--days 90`, and confirms the old run is gone from every
   * table `prune` touches while the recent run is untouched. `prune` deletes
   * children first (tests, files, run_samples, turbo_tasks) and `runs` last;
   * the reverse order would strand the children, since their own delete is a
   * subquery over `runs`.
   *
   * Also confirms `prune` removes the old run's NDJSON directory from disk
   * (age-based, not delete-after-ingest, so the retained NDJSON still backs a
   * future re-ingest until it ages out) while leaving the recent run's
   * directory in place. Asserted on the filesystem, not just the database:
   * the database assertions above would pass even if the directory removal
   * silently did nothing.
   */
  it('deletes only the runs older than the retention window, from every table and from disk', async () => {
    const dayMs = 24 * 60 * 60 * 1000
    const oldStartedAt = Date.now() - 200 * dayMs
    const recentStartedAt = Date.now() - 1 * dayMs

    seedRun('old', oldStartedAt)
    seedRun('recent', recentStartedAt)

    execFileSync('node', [cli, 'ingest'], {
      encoding: 'utf8',
      env: { ...process.env, TEST_LEDGER_DIR: pruneDirectory },
    })
    execFileSync('node', [cli, 'prune', '--days', '90'], {
      encoding: 'utf8',
      env: { ...process.env, TEST_LEDGER_DIR: pruneDirectory },
    })

    process.env['TEST_LEDGER_DIR'] = pruneDirectory
    const database = await openLedger()

    for (const table of ['runs', 'files', 'tests', 'run_samples', 'turbo_tasks']) {
      const rows = await database.prepare(`SELECT run_id FROM ${table}`).all()
      const runIds = rows.map((row) => (row as { run_id: string }).run_id)
      expect(runIds).not.toContain('old')
      expect(runIds).toContain('recent')
    }

    expect(existsSync(path.join(pruneDirectory, 'runs', 'old'))).toBe(false)
    expect(existsSync(path.join(pruneDirectory, 'runs', 'recent'))).toBe(true)
  })

  /**
   * The lock must come before opening `ledger.db`. The holder has already
   * opened the database, just as ingest does for a fold. If prune opens first,
   * the driver rejects it instead of allowing it to wait for the writer lock.
   */
  it('waits for an ingest writer to release the database before pruning', async () => {
    const dayMilliseconds = 24 * 60 * 60 * 1000
    seedRun('old', Date.now() - 200 * dayMilliseconds)
    execFileSync('node', [cli, 'ingest'], {
      encoding: 'utf8',
      env: { ...process.env, TEST_LEDGER_DIR: pruneDirectory },
    })
    process.env['TEST_LEDGER_DIR'] = pruneDirectory

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
    const prune = runAsync(pruneDirectory, 'prune', '--days', '90').then((result) => {
      pruneFinished = true
      return result
    })

    let outcome: CommandResult
    try {
      await sleep(300)
      expect(pruneFinished).toBe(false)
    } finally {
      releaseWriter()
      await writer
      outcome = await prune
    }

    expect(outcome.error).toBeUndefined()
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stderr).toBe('')
    expect(outcome.stdout).toContain('pruned runs older than 90 days')

    process.env['TEST_LEDGER_DIR'] = pruneDirectory
    const database = await openLedger()
    expect(await database.prepare('SELECT run_id FROM runs').all()).toEqual([])
    await database.close()
  })
})
