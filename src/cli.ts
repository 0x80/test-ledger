#!/usr/bin/env node
import meow from 'meow'

import { table } from './format.ts'
import { contentionReport } from './reports/contention.ts'
import { flakyReport } from './reports/flaky.ts'
import { runsReport } from './reports/runs.ts'
import { shapeReport } from './reports/shape.ts'
import { slowReport } from './reports/slow.ts'
import { ingest } from './store/ingest.ts'
import { openLedger } from './store/open.ts'
import { prune } from './store/prune.ts'

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
      minRuns: { type: 'number', default: 3 },
      limit: { type: 'number', default: 25 },
      days: { type: 'number', default: 90 },
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
  // oxlint-disable-next-line no-console -- this is the CLI's stdout output
  console.log(`ingested ${result.runs} run${result.runs === 1 ? '' : 's'}, ${result.rows} rows`)
} else if (command === 'prune') {
  await prune(cli.flags.days)
  // oxlint-disable-next-line no-console -- this is the CLI's stdout output
  console.log(`pruned runs older than ${cli.flags.days} days`)
} else {
  /**
   * Report commands share one open ledger. Node's stdout is asynchronous when it
   * is a pipe, so this branch falls through naturally instead of exiting after
   * printing and truncating captured output.
   */
  const database = await openLedger()

  if (command === 'flaky') {
    // oxlint-disable-next-line no-console -- this is the CLI's stdout output
    console.log(
      table(await flakyReport(database, { minRuns: cli.flags.minRuns }), 'no flaky tests recorded'),
    )
  } else if (command === 'slow') {
    // oxlint-disable-next-line no-console -- this is the CLI's stdout output
    console.log(table(await slowReport(database, { limit: cli.flags.limit }), 'no files recorded'))
  } else if (command === 'contention') {
    // oxlint-disable-next-line no-console -- this is the CLI's stdout output
    console.log(
      table(await contentionReport(database, { limit: cli.flags.limit }), 'no runs recorded'),
    )
  } else if (command === 'shape') {
    // oxlint-disable-next-line no-console -- this is the CLI's stdout output
    console.log(table(await shapeReport(database), 'no files recorded'))
  } else if (command === 'runs') {
    // oxlint-disable-next-line no-console -- this is the CLI's stdout output
    console.log(table(await runsReport(database, { limit: cli.flags.limit }), 'no runs recorded'))
  } else {
    // oxlint-disable-next-line no-console -- this is the CLI's stderr output
    console.error(`unknown command: ${command}`)
    /**
     * `exitCode` rather than `process.exit(2)`, for the same flushing reason as
     * the ingest branch: this sets the status and lets Node exit once stderr has
     * drained, instead of racing it.
     */
    process.exitCode = 2
  }
}
