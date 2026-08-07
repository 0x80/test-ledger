import { mkdirSync } from 'node:fs'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'

import { ingestLockPath, ledgerDir } from '../paths.ts'

/**
 * How long to keep retrying before giving up on a held lock.
 *
 * **Must stay comfortably larger than {@link STALE_AFTER_MS}**, and that is the
 * whole reason for the value. A waiter that gave up first could never reach the
 * reclamation path for a lock that went stale while it waited — it would exit
 * minutes before the lock became eligible — so the only reclaimable lock would
 * be one already stale when the waiter arrived. The earlier one-minute budget
 * had exactly that defect.
 *
 * The upper bound is also sized against a real fold rather than a typical one.
 * A batched full-suite run is well under a second, but a first ingest of a long
 * backlog is legitimately minutes (999 runs measured at 53s), and a waiter
 * behind one should queue rather than fail.
 */
const ACQUIRE_TIMEOUT_MS = 15 * 60 * 1000

const RETRY_INTERVAL_MS = 100

/**
 * A lock file older than this *may* be reclaimed — but only once its holder is
 * also shown to be gone (see {@link holderIsAlive}).
 *
 * A process killed with `SIGKILL` never runs its release, so without
 * reclamation a single hard kill would wedge every later ingest on the machine
 * permanently. Age alone is deliberately not sufficient: a first ingest of a
 * long backlog legitimately runs for hours, and reclaiming the lock out from
 * under a live one is the worse failure of the two.
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
 * Whether the recorded holder is still running.
 *
 * Only answerable for a lock taken on this host — a pid from another machine
 * says nothing about a local process table — so a foreign lock reports `false`
 * and is reclaimable on age alone, which is the best available answer when the
 * ledger directory is shared.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid is
 * addressable. `EPERM` means the process exists but belongs to another user,
 * which still counts as alive.
 *
 * Pid reuse is the known imprecision: if the holder died and an unrelated
 * process inherited its pid, this reports alive and the lock is never
 * reclaimed, so acquisition fails with the timeout message naming that pid
 * instead. That is the safe direction to be wrong in — a stuck ingest the user
 * can diagnose beats two ingests that both believe they hold the lock.
 */
function holderIsAlive(holder: LockFileContents | undefined): boolean {
  if (holder === undefined || holder.pid <= 0) return false
  if (holder.host !== hostname()) return false

  try {
    process.kill(holder.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes a lock file that is both older than {@link STALE_AFTER_MS} and whose
 * holder is no longer running. Returns whether the caller should retry the
 * exclusive create immediately rather than sleeping out another interval.
 *
 * **This is not an atomic take-over, and does not claim to be.** Between the
 * `stat` that finds the lock stale and the `rm` that removes it, the original
 * holder could in principle release and a successor acquire, and this would
 * then delete the successor's fresh lock. Re-reading the token immediately
 * before removing narrows that window to the gap between the two calls, but
 * does not close it — closing it needs an OS advisory lock (`flock`/`fcntl`),
 * which Node does not expose without a native dependency.
 *
 * The residual race is tolerated because its cost here is bounded and visible.
 * Reaching it requires a lock left by a dead process, two ingests racing to
 * reclaim it within the same instant, and a third acquiring in between. The
 * outcome is not a corrupt ledger: `ingest()` takes this lock *before* opening
 * the database, so two processes that both believed they held it collide on the
 * driver's own exclusive lock on `ledger.db` and one dies with "File is locked
 * by another process" — a crash the user retries, which is also exactly what
 * every ingest did before this lock existed.
 */
async function reclaimIfStale(path: string): Promise<boolean> {
  let modifiedAt: number
  try {
    const stats = await stat(path)
    modifiedAt = stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      /** Released between the failed create and this check: retry immediately. */
      return true
    }
    /**
     * Anything else (`EACCES`, `EIO`, ...) is a real filesystem failure. It must
     * propagate rather than read as "the lock vanished": treating it as a
     * disappearance returns the caller to the top of its retry loop, where a
     * persistent error would spin without ever sleeping or reaching the
     * deadline.
     */
    throw error
  }

  if (Date.now() - modifiedAt < STALE_AFTER_MS) return false

  const holder = await readLockFile(path)
  if (holderIsAlive(holder)) return false

  /**
   * Re-read immediately before removing, so a lock replaced since the `stat`
   * above is left alone. Narrowing, not a guarantee — see the docblock.
   *
   * The comparison is unconditional on purpose. Guarding it on the first read
   * having parsed would skip the check exactly when the lock was malformed —
   * which is also what a half-written *successor* looks like — and delete it.
   * Comparing `token` on both sides covers every combination: two reads that
   * disagree, in either direction, mean the file changed underneath and it is
   * not ours to remove.
   */
  const stillTheSameHolder = await readLockFile(path)
  if (stillTheSameHolder?.token !== holder?.token) return false

  await rm(path, { force: true })
  return true
}

/**
 * Runs `fn` while holding the ledger's ingest lock.
 *
 * The lock is a file created with the exclusive `wx` flag, which is atomic on
 * every filesystem we care about, so two invocations racing to create it always
 * produce exactly one winner. It carries a random token identifying its holder;
 * release only removes the file when that token still matches, so a process
 * whose lock was reclaimed as stale does not delete its successor's on the way
 * out. (Read alongside {@link reclaimIfStale}, which is candid about the one
 * window neither mechanism closes.)
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
    let acquired = false
    try {
      const handle = await open(path, 'wx')
      acquired = true
      try {
        const contents: LockFileContents = {
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: Date.now(),
        }
        await handle.writeFile(JSON.stringify(contents))
        await handle.close()
      } catch (error) {
        /**
         * The exclusive create succeeded, so this process owns the file even
         * though it failed to describe itself in it. Leaving it behind would
         * block every later ingest until the staleness window expired, over a
         * failure that has nothing to do with contention.
         */
        try {
          await handle.close()
        } catch {
          /** Already failing; the close outcome cannot improve the diagnosis. */
        }
        try {
          await rm(path, { force: true })
        } catch {
          /**
           * Cleanup, not diagnosis. If the orphan can't be removed it will be
           * reclaimed as stale later, whereas letting this failure propagate
           * would replace the write/close error that actually explains what
           * went wrong — the one thing the surrounding block exists to keep.
           */
        }
        throw error
      }
      break
    } catch (error) {
      if (acquired) throw error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      /**
       * Checked before the reclaim attempt, so it bounds every path through
       * this loop. Checking it only on the contended branch let a lock that
       * kept appearing and disappearing spin without a ceiling.
       */
      if (Date.now() >= deadline) {
        const holder = await readLockFile(path)
        throw new Error(
          `test-ledger ingest lock at ${path} is held by pid ${holder?.pid ?? 'unknown'} on ${
            holder?.host ?? 'unknown'
          }; gave up after ${ACQUIRE_TIMEOUT_MS}ms`,
          { cause: error },
        )
      }

      if (!(await reclaimIfStale(path))) await sleep(RETRY_INTERVAL_MS)
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
