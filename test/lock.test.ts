import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, rm, utimes } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ledgerWriterLockPath } from '../src/paths.ts'
import { withLedgerWriterLock } from '../src/store/lock.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ledger-lock-'))
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

/** Backdates the lock file past the staleness window without waiting it out. */
async function ageLockFile(): Promise<void> {
  const longAgo = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(ledgerWriterLockPath(), longAgo, longAgo)
}

describe('withLedgerWriterLock', () => {
  it('holds a lock naming its holder for the duration, then releases it', async () => {
    await withLedgerWriterLock(async () => {
      const contents: unknown = JSON.parse(await readFile(ledgerWriterLockPath(), 'utf8'))
      expect(contents).toMatchObject({ pid: process.pid })
    })

    expect(existsSync(ledgerWriterLockPath())).toBe(false)
  })

  /**
   * The point of the lock: two invocations must not overlap. Anything short of
   * a strict enter/exit/enter/exit order means the second holder ran while the
   * first still held it.
   */
  it('serializes concurrent holders rather than interleaving them', async () => {
    const order: string[] = []

    async function hold(name: string): Promise<void> {
      await withLedgerWriterLock(async () => {
        order.push(`${name}:enter`)
        await sleep(50)
        order.push(`${name}:exit`)
      })
    }

    await Promise.all([hold('a'), hold('b')])

    const [winner, loser] = order[0] === 'a:enter' ? ['a', 'b'] : ['b', 'a']
    expect(order).toEqual([`${winner}:enter`, `${winner}:exit`, `${loser}:enter`, `${loser}:exit`])
  })

  it('releases the lock when the body throws', async () => {
    await expect(
      withLedgerWriterLock(async () => {
        await sleep(0)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(existsSync(ledgerWriterLockPath())).toBe(false)
  })

  /**
   * A `SIGKILL`ed holder never runs its release. Without stale reclamation one
   * hard kill would wedge every later ingest on the machine permanently.
   */
  it('reclaims a lock left behind by a killed holder', async () => {
    /**
     * A genuinely dead pid on *this* host, so the reclaim path runs through
     * `process.kill(pid, 0)` and its `ESRCH` branch. An earlier version of this
     * test used a foreign hostname, which short-circuits the liveness probe
     * before it ever signals — leaving the same-host dead-holder case, the one
     * that actually unwedges a `kill -9`ed ingest, with no coverage at all.
     */
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(dead.status).toBe(0)
    const deadPid = dead.pid
    expect(deadPid).toBeGreaterThan(0)

    mkdirSync(directory, { recursive: true })
    writeFileSync(
      ledgerWriterLockPath(),
      JSON.stringify({ token: 'dead', pid: deadPid, host: hostname(), acquiredAt: 0 }),
    )
    await ageLockFile()

    await expect(
      withLedgerWriterLock(async () => {
        await sleep(0)
        return 'ran'
      }),
    ).resolves.toBe('ran')
    expect(existsSync(ledgerWriterLockPath())).toBe(false)
  })

  /**
   * A holder whose lock was reclaimed as stale must not delete whatever took
   * its place on the way out. Without the token check on release, the sequence
   * below hands a third process a lock two others believe they hold.
   */
  it('does not delete a successor lock on release', async () => {
    const successor = JSON.stringify({
      token: 'successor',
      pid: process.pid,
      host: 'elsewhere',
      acquiredAt: Date.now(),
    })

    await withLedgerWriterLock(async () => {
      await sleep(0)
      /** Stands in for this holder having been reclaimed mid-body. */
      writeFileSync(ledgerWriterLockPath(), successor)
    })

    expect(existsSync(ledgerWriterLockPath())).toBe(true)
    expect(await readFile(ledgerWriterLockPath(), 'utf8')).toBe(successor)
  })

  /**
   * Age alone must not be enough to reclaim. A first ingest of a long backlog
   * legitimately runs for hours, and before the liveness check an ingest past
   * the ten-minute window had its lock taken out from under it by the next
   * invocation — the exact case observed on a 999-run backlog.
   */
  it('does not reclaim an aged lock whose holder is still running', async () => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      ledgerWriterLockPath(),
      JSON.stringify({
        token: 'alive',
        /** This test process: unambiguously running, on this host. */
        pid: process.pid,
        host: hostname(),
        acquiredAt: 0,
      }),
    )
    await ageLockFile()

    let entered = false
    const pending = withLedgerWriterLock(async () => {
      await sleep(0)
      entered = true
    })

    await sleep(300)
    expect(entered).toBe(false)

    /** Hand it over the only legitimate way: the holder releases. */
    await rm(ledgerWriterLockPath(), { force: true })

    await pending
    expect(entered).toBe(true)
  })

  /**
   * A lock file with no readable contents is still a lock. Staleness is judged
   * from its mtime, which exists whether or not the holder got as far as
   * writing its token.
   */
  it('waits on a fresh lock whose contents are unreadable', async () => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(ledgerWriterLockPath(), 'not json')

    let entered = false
    const pending = withLedgerWriterLock(async () => {
      await sleep(0)
      entered = true
    })

    await sleep(300)
    expect(entered).toBe(false)

    await ageLockFile()

    await pending
    expect(entered).toBe(true)
  })
})
