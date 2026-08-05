import type { Ledger } from '../store/open.ts'

export type ShapeRow = {
  packageName: string
  lane: string
  files: number
  totalMs: number
  setupMs: number
  environmentSetupMs: number
  turboTasks: number
  turboCacheHits: number
  turboCacheMisses: number
}

/**
 * Where a run's time goes, split by package and lane, with the environment and
 * setup share broken out.
 *
 * The environment column is the one worth watching: it is what turns "jsdom
 * costs us something" from a number someone measured once by hand into a
 * standing figure.
 *
 * `turboTasks` / `turboCacheHits` / `turboCacheMisses` come from `turbo_tasks`,
 * joined in by package only: Turbo's cache is a per-package/per-task concept
 * with no lane of its own, so every lane row for a package repeats the same
 * three figures rather than splitting them. A cache miss is any status other
 * than `HIT` (`MISS`, `UNKNOWN`, ...), read as "this task actually ran" rather
 * than "this task was served from cache."
 */
export async function shapeReport(database: Ledger): Promise<ShapeRow[]> {
  const rows = await database
    .prepare(
      `SELECT COALESCE(f.package_name, '') AS packageName,
              COALESCE(f.lane, '') AS lane,
              COUNT(*) AS files,
              COALESCE(SUM(f.duration_ms), 0) AS totalMs,
              COALESCE(SUM(f.setup_ms), 0) AS setupMs,
              COALESCE(SUM(f.environment_setup_ms), 0) AS environmentSetupMs,
              COALESCE(t.turboTasks, 0) AS turboTasks,
              COALESCE(t.turboCacheHits, 0) AS turboCacheHits,
              COALESCE(t.turboCacheMisses, 0) AS turboCacheMisses
         FROM files f
         LEFT JOIN (
           SELECT package_name,
                  COUNT(*) AS turboTasks,
                  SUM(CASE WHEN cache_status = 'HIT' THEN 1 ELSE 0 END) AS turboCacheHits,
                  SUM(CASE WHEN cache_status != 'HIT' THEN 1 ELSE 0 END) AS turboCacheMisses
             FROM turbo_tasks
            GROUP BY package_name
         ) t ON t.package_name = f.package_name
        GROUP BY f.package_name, f.lane
        ORDER BY totalMs DESC`,
    )
    .all()

  return rows as ShapeRow[]
}
