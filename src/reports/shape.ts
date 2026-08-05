import type { Ledger } from '../store/open.ts'

export type ShapeRow = {
  packageName: string
  lane: string
  files: number
  totalMs: number
  setupMs: number
  environmentSetupMs: number
}

/**
 * Where a run's time goes, split by package and lane, with the environment and
 * setup share broken out.
 *
 * The environment column is the one worth watching: it is what turns "jsdom
 * costs us something" from a number someone measured once by hand into a
 * standing figure.
 */
export async function shapeReport(database: Ledger): Promise<ShapeRow[]> {
  const rows = await database
    .prepare(
      `SELECT COALESCE(package_name, '') AS packageName,
              COALESCE(lane, '') AS lane,
              COUNT(*) AS files,
              COALESCE(SUM(duration_ms), 0) AS totalMs,
              COALESCE(SUM(setup_ms), 0) AS setupMs,
              COALESCE(SUM(environment_setup_ms), 0) AS environmentSetupMs
         FROM files
        GROUP BY package_name, lane
        ORDER BY totalMs DESC`,
    )
    .all()

  return rows as ShapeRow[]
}
