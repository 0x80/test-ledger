/**
 * The package's public entry point (`import … from '@0x80/test-ledger'`).
 *
 * Re-exports the whole surface: the NDJSON event contract, the envelope and
 * sampler a wrapper process uses to open/close a run and record host load,
 * the Turbo summary parser, the run id minter, the table formatter, the
 * store, and every report.
 */

export * from './events.ts'
export * from './paths.ts'
export { classifyFailure } from './failure-class.ts'
export { appendEvents, writeRunEnd, writeRunStart } from './envelope.ts'
export { startSampler } from './sampler.ts'
export { parseTurboSummary } from './turbo-summary.ts'
export { mintRunId } from './run-id.ts'
export { table } from './format.ts'
export { openLedger, type Ledger } from './store/open.ts'
export { ingest, ingestAll, ingestRun, type IngestResult } from './store/ingest.ts'
export { withIngestLock } from './store/lock.ts'
export { flakyReport, type FlakyRow } from './reports/flaky.ts'
export { slowReport, type SlowRow } from './reports/slow.ts'
export { contentionReport, type ContentionRow } from './reports/contention.ts'
export { shapeReport, type ShapeRow } from './reports/shape.ts'
export { runsReport, type RunRow } from './reports/runs.ts'
