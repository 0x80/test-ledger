import type { Ledger } from '../store/open.ts'

export type FlakyRow = {
  file: string
  fullName: string
  runs: number
  failures: number
  failureRate: number
  retries: number
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
 *
 * A test surfaces if it either failed outright, or passed only after a retry:
 * Vitest's own retry mechanism means a test that failed then passed on retry
 * records `state = 'passed'` with `retry_count > 0`, so `failures > 0` alone
 * would miss it even though it is exactly the kind of instability this report
 * exists to surface. `retries` counts the runs in which this test needed at
 * least one retry, alongside the run/failure counts.
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
              SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retries,
              GROUP_CONCAT(DISTINCT failure_class) AS classes
         FROM tests
        WHERE state IN ('passed', 'failed')
        GROUP BY file, full_name
       HAVING (failures > 0 OR retries > 0) AND runs >= ?
        ORDER BY (CAST(failures AS REAL) / runs) DESC, failures DESC`,
    )
    .all([minRuns])

  return rows.map((row) => {
    const record = row as {
      file: string
      fullName: string
      runs: number
      failures: number
      retries: number
      classes: string | null
    }
    return {
      file: record.file,
      fullName: record.fullName,
      runs: record.runs,
      failures: record.failures,
      failureRate: record.failures / record.runs,
      retries: record.retries,
      classes: record.classes ?? '',
    }
  })
}
