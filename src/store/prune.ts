import { rm } from 'node:fs/promises'

import { runDir } from '../paths.ts'
import { withLedgerWriterLock } from './lock.ts'
import { openLedger } from './open.ts'

/**
 * Removes one run's NDJSON directory.
 *
 * A missing directory is not an error: the run may have been ingested on one
 * machine and pruned on another, or a prior prune already removed it. Only
 * `ENOENT` is swallowed; any other filesystem failure must propagate.
 */
async function removeRunDirectory(runId: string): Promise<void> {
  try {
    await rm(runDir(runId), { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Removes runs older than `days` under the ledger writer lock.
 *
 * The lock comes before `openLedger()` because the driver locks `ledger.db`
 * exclusively at open. Closing the connection before releasing the lock lets
 * the next writer proceed instead of colliding with an open file handle.
 */
export async function prune(days: number): Promise<void> {
  await withLedgerWriterLock(async () => {
    const database = await openLedger()

    try {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

      /**
       * A subquery in a `WHERE ... IN (...)` clause is rejected by the installed
       * `@tursodatabase/database@0.3.2` driver ("IN (...subquery) in WHERE clause
       * is not supported"), and a correlated `EXISTS` is rejected the same way
       * ("EXISTS in WHERE clause is not supported"), confirmed by hand against
       * the driver. The accepted equivalent is a two-step delete: read the stale
       * run ids first, then delete each child table by an `IN` list of bound
       * literal placeholders, which the driver does accept. Children first,
       * `runs` last: deleting `runs` first would leave nothing for this read to
       * find and strand the children permanently.
       */
      const staleRows = await database
        .prepare('SELECT run_id FROM runs WHERE started_at < ?')
        .all([cutoff])
      const staleRunIds = staleRows.map((row) => (row as { run_id: string }).run_id)

      if (staleRunIds.length > 0) {
        const placeholders = staleRunIds.map(() => '?').join(', ')
        for (const childTable of ['tests', 'files', 'run_samples', 'turbo_tasks']) {
          await database
            .prepare(`DELETE FROM ${childTable} WHERE run_id IN (${placeholders})`)
            .run(staleRunIds)
        }
      }

      await database.prepare('DELETE FROM runs WHERE started_at < ?').run([cutoff])

      /**
       * Age-based, not delete-after-ingest: the raw NDJSON stays available for
       * the whole retention window (phase 2 re-ingests into a fresh synced
       * database from exactly this retained NDJSON), and disk is still bounded
       * once a run ages past it. `ingested_runs` is left untouched here — it is
       * what stops a pruned run's directory from being silently re-ingested if
       * it ever reappears (a restored backup, a synced copy from another
       * machine), not a leftover this command forgot.
       */
      for (const runId of staleRunIds) {
        await removeRunDirectory(runId)
      }
    } finally {
      await database.close()
    }
  })
}
