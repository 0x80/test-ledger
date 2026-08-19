import path from 'node:path'
import { homedir } from 'node:os'

//#region src/paths.ts
/**
 * Resolved per call rather than at module load, so tests can point $HOME at a
 * temp directory. Machine-global on purpose: every worktree writes here, which
 * is what makes cross-run contention analysis possible at all, and what lets
 * the data outlive the worktree that produced it.
 */
const ledgerDir = () =>
  process.env['TEST_LEDGER_DIR'] ?? path.join(homedir(), '.local', 'share', 'test-ledger')
const runsDir = () => path.join(ledgerDir(), 'runs')
const runDir = (runId) => path.join(runsDir(), runId)
/** Per-process, so concurrent writers never share a file handle or a lock. */
const eventsPath = (runId, pid) => path.join(runDir(runId), `${pid}.ndjson`)
const databasePath = () => path.join(ledgerDir(), 'ledger.db')
/**
 * The lock every command that writes `ledger.db` holds before opening it, so
 * concurrent ingest and prune invocations serialize instead of interleaving
 * writes or colliding on the driver's exclusive file lock.
 *
 * Machine-global like the rest of the ledger directory, which is what makes it
 * work across worktrees: the writers it has to exclude are separate processes
 * started from unrelated checkouts, not threads of one run.
 */
const ledgerWriterLockPath = () => path.join(ledgerDir(), 'ledger-writer.lock')

//#endregion
export {
  runDir as a,
  ledgerWriterLockPath as i,
  eventsPath as n,
  runsDir as o,
  ledgerDir as r,
  databasePath as t,
}
