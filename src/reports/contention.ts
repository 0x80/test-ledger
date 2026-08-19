import type { Ledger } from '../store/open.ts'

export type ContentionRow = {
  runId: string
  branch: string
  startedAt: number
  durationMs: number
  meanLoad1: number
  peakLoad1: number
  peakLiveSlots: number
  concurrency: number
  queuedMs: number
  queueTimedOut: number
}

/**
 * Runs ranked by how loaded the host was while they ran.
 *
 * Joined from the sample timeline rather than from a start/end snapshot,
 * because the whole point is that a run's average conditions and its worst
 * conditions are different numbers and it is the worst ones that produce a
 * deadline failure.
 *
 * `COALESCE(r.ended_at - r.started_at, 0)` is NULL-propagating: a run killed
 * mid-run (no `run_end`, so `ended_at` is NULL) reports `durationMs` as `0`
 * rather than a negative or nonsense figure, confirmed against the installed
 * `@tursodatabase/database@0.3.2` driver. `LEFT JOIN` plus `GROUP BY` and the
 * aggregates below are likewise confirmed working on that driver, so a run
 * with no samples (an ad-hoc invocation outside the sampler) still gets a row
 * with all-zero load figures rather than being dropped.
 */
export async function contentionReport(
  database: Ledger,
  options: { limit?: number } = {},
): Promise<ContentionRow[]> {
  const rows = await database
    .prepare(
      `SELECT r.run_id AS runId,
              COALESCE(r.branch, '') AS branch,
              COALESCE(r.started_at, 0) AS startedAt,
              COALESCE(r.ended_at - r.started_at, 0) AS durationMs,
              COALESCE(r.concurrency, 0) AS concurrency,
              COALESCE(r.queued_ms, 0) AS queuedMs,
              COALESCE(r.queue_timed_out, 0) AS queueTimedOut,
              COALESCE(AVG(s.load1), 0) AS meanLoad1,
              COALESCE(MAX(s.load1), 0) AS peakLoad1,
              COALESCE(MAX(s.live_slots), 0) AS peakLiveSlots
         FROM runs r
         LEFT JOIN run_samples s ON s.run_id = r.run_id
        GROUP BY r.run_id
        ORDER BY peakLoad1 DESC
        LIMIT ?`,
    )
    .all([options.limit ?? 25])

  return rows as ContentionRow[]
}
