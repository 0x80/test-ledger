#!/usr/bin/env node
import {
  c as shapeReport,
  d as contentionReport,
  f as table,
  i as openLedger,
  l as runsReport,
  s as slowReport,
  t as ingest,
  u as flakyReport,
} from './ingest-mmhr2kIF.mjs'
import { a as runDir } from './paths-CmAFgNp9.mjs'
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
/**
 * `ingest` is dispatched before any ledger is opened, because it must take the
 * ingest lock *before* the database file is opened: the driver locks that file
 * exclusively at open, so a second concurrent invocation that opened first would
 * crash rather than queue. `ingest()` owns that ordering end to end, which is
 * why it takes no database argument.
 *
 * `no-console` is only a warning in this repo's lint config, and every branch
 * below is the CLI's actual stdout/stderr output, so each `console.*` call
 * carries a scoped disable rather than being rewritten around.
 */
if (command === 'ingest') {
  const result = await ingest()
  console.log(`ingested ${result.runs} run${result.runs === 1 ? '' : 's'}, ${result.rows} rows`)
} else {
  /**
   * Every remaining command reads or writes an open ledger, so open it once
   * here — inside the `else` rather than after an early `process.exit(0)` in the
   * branch above. Node's stdout is asynchronous whenever it is a pipe, so
   * exiting immediately after `console.log` can terminate the process before the
   * line is flushed, and this command's output is routinely piped or captured.
   * Letting the branch fall through to a natural exit is what guarantees the
   * result line is actually delivered.
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
