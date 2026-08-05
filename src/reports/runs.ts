import type { Ledger } from '../store/open.ts'

export type RunRow = {
  runId: string
  branch: string
  worktree: string
  startedAt: number
  durationMs: number
  exitCode: number
  concurrency: number
  turboForce: number
  hasEnvelope: number
}

/** Recent run history: the index into everything else. */
export async function runsReport(
  database: Ledger,
  options: { limit?: number } = {},
): Promise<RunRow[]> {
  const rows = await database
    .prepare(
      `SELECT run_id AS runId,
              COALESCE(branch, '') AS branch,
              COALESCE(worktree, '') AS worktree,
              COALESCE(started_at, 0) AS startedAt,
              COALESCE(ended_at - started_at, 0) AS durationMs,
              COALESCE(exit_code, -1) AS exitCode,
              COALESCE(concurrency, 0) AS concurrency,
              COALESCE(turbo_force, 0) AS turboForce,
              has_envelope AS hasEnvelope
         FROM runs
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all([options.limit ?? 25])

  return rows as RunRow[]
}
