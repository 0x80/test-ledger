import type { Ledger } from '../store/open.ts'

export type SlowRow = {
  file: string
  runs: number
  meanMs: number
  totalMs: number
  shareOfTotal: number
}

/**
 * Ranks files by total wall-clock, with each file's share of the whole.
 *
 * Share rather than raw duration is the ranking that answers "what would
 * cutting this actually buy": a 3s file run on every branch costs more than a
 * 40s file run once a week, and only the share makes that visible.
 */
export async function slowReport(
  database: Ledger,
  options: { limit?: number } = {},
): Promise<SlowRow[]> {
  const limit = options.limit ?? 25

  const totalRows = (await database
    .prepare('SELECT COALESCE(SUM(duration_ms), 0) AS total FROM files')
    .all()) as { total: number }[]
  const total = totalRows[0]?.total ?? 0

  const rows = await database
    .prepare(
      `SELECT file,
              COUNT(*) AS runs,
              SUM(duration_ms) AS totalMs,
              AVG(duration_ms) AS meanMs
         FROM files
        GROUP BY file
        ORDER BY totalMs DESC
        LIMIT ?`,
    )
    .all([limit])

  return rows.map((row) => {
    const record = row as { file: string; runs: number; totalMs: number; meanMs: number }
    return {
      file: record.file,
      runs: record.runs,
      meanMs: record.meanMs,
      totalMs: record.totalMs,
      shareOfTotal: total === 0 ? 0 : record.totalMs / total,
    }
  })
}
