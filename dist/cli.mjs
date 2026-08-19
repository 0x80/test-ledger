#!/usr/bin/env node
import {
  a as withLedgerWriterLock,
  c as shapeReport,
  d as contentionReport,
  f as table,
  i as openLedger,
  l as runsReport,
  s as slowReport,
  t as ingest,
  u as flakyReport,
} from './ingest-qOPSXg96.mjs'
import { a as runDir } from './paths-ZwcASZDt.mjs'
import meow from 'meow'
import { rm } from 'node:fs/promises'

//#region src/store/prune.ts
/**
 * Removes one run's NDJSON directory.
 *
 * A missing directory is not an error: the run may have been ingested on one
 * machine and pruned on another, or a prior prune already removed it. Only
 * `ENOENT` is swallowed; any other filesystem failure must propagate.
 */
async function removeRunDirectory(runId) {
  try {
    await rm(runDir(runId), { recursive: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
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
async function prune(days) {
  await withLedgerWriterLock(async () => {
    const database = await openLedger()
    try {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1e3
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
    } finally {
      await database.close()
    }
  })
}

//#endregion
//#region src/cli.ts
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
/**
 * Writer commands are dispatched before any ledger is opened, because they must
 * take the ledger writer lock first. The driver locks the database file
 * exclusively at open, so opening first would crash rather than queue.
 *
 * `no-console` is only a warning in this repo's lint config, and every branch
 * below is the CLI's actual stdout/stderr output, so each `console.*` call
 * carries a scoped disable rather than being rewritten around.
 */
if (command === 'ingest') {
  const result = await ingest()
  console.log(`ingested ${result.runs} run${result.runs === 1 ? '' : 's'}, ${result.rows} rows`)
} else if (command === 'prune') {
  await prune(cli.flags.days)
  console.log(`pruned runs older than ${cli.flags.days} days`)
} else {
  /**
   * Report commands share one open ledger. Node's stdout is asynchronous when it
   * is a pipe, so this branch falls through naturally instead of exiting after
   * printing and truncating captured output.
   */
  const database = await openLedger()
  if (command === 'flaky')
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
  else {
    console.error(`unknown command: ${command}`)
    /**
     * `exitCode` rather than `process.exit(2)`, for the same flushing reason as
     * the ingest branch: this sets the status and lets Node exit once stderr has
     * drained, instead of racing it.
     */
    process.exitCode = 2
  }
}

//#endregion
export {}
