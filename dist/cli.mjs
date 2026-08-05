#!/usr/bin/env node
import {
  a as slowReport,
  c as flakyReport,
  l as contentionReport,
  n as ingestAll,
  o as shapeReport,
  s as runsReport,
  t as openLedger,
  u as table,
} from './open-W_R1LvBi.mjs'
import { a as runDir } from './paths-BtOSn20v.mjs'
import { rm } from 'node:fs/promises'
import meow from 'meow'

//#region src/cli.ts
/**
 * Removes one run's NDJSON directory.
 *
 * A missing directory is not an error: the run may have been ingested on one
 * machine and pruned on another, or a prior prune already removed it. Only
 * `ENOENT` is swallowed, mirroring the narrowing `ingest.ts`'s
 * `readRunEvents` applies to the same failure mode; any other error (a
 * permissions problem, a busy handle) is a real filesystem failure and must
 * propagate.
 */
async function removeRunDirectory(runId) {
  try {
    await rm(runDir(runId), { recursive: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}
/** The `test-ledger` bin entry point: ingest, the five reports, and prune. */
const cli = meow(
  `
  Usage
    $ test-ledger <command>

  Commands
    ingest       Fold every un-ingested run directory into the database
    flaky        Tests ranked by failure rate, with denominators
    slow         Files ranked by share of total wall-clock
    contention   Runs ranked by host load while they ran
    shape        Where time goes, by package and lane
    runs         Recent run history
    prune        Delete runs and their NDJSON older than --days

  Options
    --min-runs   Minimum appearances before a test can be called flaky (default 3)
    --limit      Row limit (default 25)
    --days       Retention window for prune (default 90)
`,
  {
    importMeta: import.meta,
    flags: {
      minRuns: {
        type: 'number',
        default: 3,
      },
      limit: {
        type: 'number',
        default: 25,
      },
      days: {
        type: 'number',
        default: 90,
      },
    },
  },
)
const [command = 'runs'] = cli.input
const database = await openLedger()
/**
 * `no-console` is only a warning in this repo's lint config, and every branch
 * below is the CLI's actual stdout/stderr output, so each `console.*` call
 * carries a scoped disable rather than being rewritten around.
 */
if (command === 'ingest') {
  const result = await ingestAll(database)
  console.log(`ingested ${result.runs} run${result.runs === 1 ? '' : 's'}, ${result.rows} rows`)
} else if (command === 'flaky')
  console.log(
    table(await flakyReport(database, { minRuns: cli.flags.minRuns }), 'no flaky tests recorded'),
  )
else if (command === 'slow')
  console.log(table(await slowReport(database, { limit: cli.flags.limit }), 'no files recorded'))
else if (command === 'contention')
  console.log(
    table(await contentionReport(database, { limit: cli.flags.limit }), 'no runs recorded'),
  )
else if (command === 'shape') console.log(table(await shapeReport(database), 'no files recorded'))
else if (command === 'runs')
  console.log(table(await runsReport(database, { limit: cli.flags.limit }), 'no runs recorded'))
else if (command === 'prune') {
  const cutoff = Date.now() - cli.flags.days * 24 * 60 * 60 * 1e3
  const staleRunIds = (
    await database.prepare('SELECT run_id FROM runs WHERE started_at < ?').all([cutoff])
  ).map((row) => row.run_id)
  if (staleRunIds.length > 0) {
    const placeholders = staleRunIds.map(() => '?').join(', ')
    for (const childTable of ['tests', 'files', 'run_samples', 'turbo_tasks'])
      await database
        .prepare(`DELETE FROM ${childTable} WHERE run_id IN (${placeholders})`)
        .run(staleRunIds)
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
  for (const runId of staleRunIds) await removeRunDirectory(runId)
  console.log(`pruned runs older than ${cli.flags.days} days`)
} else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}

//#endregion
export {}
