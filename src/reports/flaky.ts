import type { Ledger } from '../store/open.ts'

export type FlakyRow = {
  file: string
  fullName: string
  runs: number
  failures: number
  failureRate: number
  classes: string
}

/**
 * Ranks tests by how often they failed, with the denominator alongside.
 *
 * The denominator is the number of runs in which this test appeared at all, not
 * the number of runs overall — a test added last week must not read as stable
 * because it was absent for a hundred earlier runs. Failure classes are
 * aggregated into the row because the class is what separates a genuine flake
 * from a host-capacity artifact: a test failing only as `timeout` under load is
 * a different problem from one failing as `assertion`.
 */
export async function flakyReport(
  database: Ledger,
  options: { minRuns?: number } = {},
): Promise<FlakyRow[]> {
  const minRuns = options.minRuns ?? 3

  const rows = await database
    .prepare(
      `SELECT file,
              full_name AS fullName,
              COUNT(*) AS runs,
              SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failures,
              GROUP_CONCAT(DISTINCT failure_class) AS classes
         FROM tests
        WHERE state IN ('passed', 'failed')
        GROUP BY file, full_name
       HAVING failures > 0 AND runs >= ?
        ORDER BY (CAST(failures AS REAL) / runs) DESC, failures DESC`,
    )
    .all([minRuns])

  return rows.map((row) => {
    const record = row as {
      file: string
      fullName: string
      runs: number
      failures: number
      classes: string | null
    }
    return {
      file: record.file,
      fullName: record.fullName,
      runs: record.runs,
      failures: record.failures,
      failureRate: record.failures / record.runs,
      classes: record.classes ?? '',
    }
  })
}
