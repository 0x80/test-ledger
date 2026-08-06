import { homedir } from 'node:os'
import path from 'node:path'

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
 * Reserved for when ingest becomes automated (phase 2 wiring it into the
 * test-selection harness). Nothing acquires this lock today: concurrent
 * `ingest` invocations are currently unguarded, and the path exists so the
 * automated caller has somewhere to acquire it without a later schema/path
 * change.
 */
const ingestLockPath = () => path.join(ledgerDir(), 'ingest.lock')

//#endregion
export {
  runDir as a,
  ledgerDir as i,
  eventsPath as n,
  runsDir as o,
  ingestLockPath as r,
  databasePath as t,
}
