import {
  a as RunEndEvent,
  c as TestEvent,
  i as LedgerEvent,
  l as TurboTaskEvent,
  n as FileEvent,
  o as RunStartEvent,
  r as Lane,
  s as SampleEvent,
  t as FailureClass,
  u as isLedgerEvent,
} from './events-AzpwiRJu.mjs'

//#region src/paths.d.ts

/**
 * Resolved per call rather than at module load, so tests can point $HOME at a
 * temp directory. Machine-global on purpose: every worktree writes here, which
 * is what makes cross-run contention analysis possible at all, and what lets
 * the data outlive the worktree that produced it.
 */
declare const ledgerDir: () => string
declare const runsDir: () => string
declare const runDir: (runId: string) => string
/** Per-process, so concurrent writers never share a file handle or a lock. */
declare const eventsPath: (runId: string, pid: number) => string
declare const databasePath: () => string
/** Held by `ingest` so concurrent runs cannot write the database at once. */
declare const ingestLockPath: () => string
//#endregion
//#region src/run-id.d.ts
/**
 * A fresh 128-bit id per run.
 *
 * Unlike `review-ledger`, which derives its run id from ledger identity so a
 * republish is idempotent, a test run has no natural key: the same branch on
 * the same machine is run over and over, and each of those IS a distinct run.
 * Random is therefore correct here, not merely convenient.
 */
declare function mintRunId(): string
//#endregion
export {
  FailureClass,
  FileEvent,
  Lane,
  LedgerEvent,
  RunEndEvent,
  RunStartEvent,
  SampleEvent,
  TestEvent,
  TurboTaskEvent,
  databasePath,
  eventsPath,
  ingestLockPath,
  isLedgerEvent,
  ledgerDir,
  mintRunId,
  runDir,
  runsDir,
}
