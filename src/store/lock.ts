import { mkdirSync } from 'node:fs'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'

import { ingestLockPath, ledgerDir } from '../paths.ts'

/**
 * How long to keep retrying before giving up on a held lock.
 *
 * Sized against a worst-case ingest, not a typical one: a batched fold of a
 * full-suite run is a few seconds, so a minute of waiting means the holder is
 * doing something far larger (a first ingest of a long backlog) rather than
 * merely being slow.
 */
const ACQUIRE_TIMEOUT_MS = 60_000

const RETRY_INTERVAL_MS = 100

/**
 * A lock file older than this is treated as abandoned and reclaimed.
 *
 * A process killed with `SIGKILL` never runs its release, so without this a
 * single hard kill would wedge every later ingest permanently. The window is
 * deliberately far wider than any real ingest: reclaiming a lock a live writer
 * still holds is the worse failure, and the release path already handles the
 * common crash cases.
 */
const STALE_AFTER_MS = 10 * 60 * 1000

type LockFileContents = {
  token: string
  pid: number
  host: string
  acquiredAt: number
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Reads the lock file, returning `undefined` for anything unreadable or malformed. */
async function readLockFile(path: string): Promise<LockFileContents | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record['token'] !== 'string') return undefined
    return {
      token: record['token'],
      pid: typeof record['pid'] === 'number' ? record['pid'] : 0,
      host: typeof record['host'] === 'string' ? record['host'] : 'unknown',
      acquiredAt: typeof record['acquiredAt'] === 'number' ? record['acquiredAt'] : 0,
    }
  } catch {
    /**
     * The holder may be mid-write, or may have died between creating the file
     * and filling it. Either way there is nothing to read; staleness is judged
     * from the file's mtime instead, which exists regardless of contents.
     */
    return undefined
  }
}

/**
 * Removes a lock file whose mtime is older than {@link STALE_AFTER_MS}.
 *
 * Returns whether anything was removed, so the caller can retry immediately
 * rather than sleeping out another interval. Two processes can reach this at
 * once; both may unlink, and the exclusive create that follows is what decides
 * which of them actually takes the lock.
 */
async function reclaimIfStale(path: string): Promise<boolean> {
  let modifiedAt: number
  try {
    const stats = await stat(path)
    modifiedAt = stats.mtimeMs
  } catch {
    /** Released between the failed create and this check: retry immediately. */
    return true
  }

  if (Date.now() - modifiedAt < STALE_AFTER_MS) return false

  await rm(path, { force: true })
  return true
}

/**
 * Runs `fn` while holding the ledger's ingest lock.
 *
 * The lock is a file created with the exclusive `wx` flag, which is atomic on
 * every filesystem we care about, so two invocations racing to create it always
 * produce exactly one winner. It carries a random token identifying its holder;
 * release only removes the file when the token still matches, so a process
 * whose lock was reclaimed as stale cannot delete its successor's lock on the
 * way out.
 *
 * Held for the whole fold rather than per statement: the thing being made
 * mutually exclusive is one ingest against another, and a per-statement lock
 * would let two invocations interleave whole runs while never overlapping on a
 * single write.
 */
export async function withIngestLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = ingestLockPath()
  const token = crypto.randomUUID()

  mkdirSync(ledgerDir(), { recursive: true })

  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        const contents: LockFileContents = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: Date.now(),
        }
        await handle.writeFile(JSON.stringify(contents))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      if (!(await reclaimIfStale(path))) {
        if (Date.now() >= deadline) {
          const holder = await readLockFile(path)
          throw new Error(
            `test-ledger ingest lock at ${path} is held by pid ${holder?.pid ?? 'unknown'} on ${
              holder?.host ?? 'unknown'
            }; gave up after ${ACQUIRE_TIMEOUT_MS}ms`,
            { cause: error },
          )
        }
        await sleep(RETRY_INTERVAL_MS)
      }
    }
  }

  try {
    return await fn()
  } finally {
    /**
     * Strict token match, not "remove unless clearly someone else's": an
     * unreadable lock file here is most likely a successor's, written after
     * this one was reclaimed as stale, and deleting it would hand a third
     * process a lock two others believe they hold.
     */
    const holder = await readLockFile(path)
    if (holder?.token === token) await rm(path, { force: true })
  }
}
