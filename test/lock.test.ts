import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ingestLockPath } from '../src/paths.ts'
import { withIngestLock } from '../src/store/lock.ts'

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
  await utimes(ingestLockPath(), longAgo, longAgo)
}

describe('withIngestLock', () => {
  it('holds a lock naming its holder for the duration, then releases it', async () => {
    await withIngestLock(async () => {
      const contents: unknown = JSON.parse(await readFile(ingestLockPath(), 'utf8'))
      expect(contents).toMatchObject({ pid: process.pid })
    })

    expect(existsSync(ingestLockPath())).toBe(false)
  })

  /**
   * The point of the lock: two invocations must not overlap. Anything short of
   * a strict enter/exit/enter/exit order means the second holder ran while the
   * first still held it.
   */
  it('serializes concurrent holders rather than interleaving them', async () => {
    const order: string[] = []

    async function hold(name: string): Promise<void> {
      await withIngestLock(async () => {
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
      withIngestLock(async () => {
        await sleep(0)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(existsSync(ingestLockPath())).toBe(false)
  })

  /**
   * A `SIGKILL`ed holder never runs its release. Without stale reclamation one
   * hard kill would wedge every later ingest on the machine permanently.
   */
  it('reclaims a lock left behind by a killed holder', async () => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      ingestLockPath(),
      JSON.stringify({ token: 'dead', pid: 1, host: 'gone', acquiredAt: 0 }),
    )
    await ageLockFile()

    await expect(
      withIngestLock(async () => {
        await sleep(0)
        return 'ran'
      }),
    ).resolves.toBe('ran')
    expect(existsSync(ingestLockPath())).toBe(false)
  })

  /**
   * A lock file with no readable contents is still a lock. Staleness is judged
   * from its mtime, which exists whether or not the holder got as far as
   * writing its token.
   */
  it('waits on a fresh lock whose contents are unreadable', async () => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(ingestLockPath(), 'not json')

    let entered = false
    const pending = withIngestLock(async () => {
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
