import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

//#region src/events.ts
const EVENT_KINDS = new Set(['run_start', 'run_end', 'sample', 'file', 'test', 'turbo_task'])
/**
 * Ingest reads files a crashed process may have truncated mid-line, so every
 * parsed line is validated rather than trusted. This checks the discriminant
 * and the two fields ingest needs to route a record at all; per-kind columns
 * are read defensively at insert time. A stricter schema here would reject
 * whole runs over one malformed line, which is the wrong trade for telemetry.
 */
function isLedgerEvent(value) {
  if (typeof value !== 'object' || value === null) return false
  const record = value
  return (
    typeof record['kind'] === 'string' &&
    EVENT_KINDS.has(record['kind']) &&
    typeof record['runId'] === 'string' &&
    record['runId'].length > 0
  )
}

//#endregion
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
/** Held by `ingest` so concurrent runs cannot write the database at once. */
const ingestLockPath = () => path.join(ledgerDir(), 'ingest.lock')

//#endregion
//#region src/run-id.ts
/**
 * A fresh 128-bit id per run.
 *
 * Unlike `review-ledger`, which derives its run id from ledger identity so a
 * republish is idempotent, a test run has no natural key: the same branch on
 * the same machine is run over and over, and each of those IS a distinct run.
 * Random is therefore correct here, not merely convenient.
 */
function mintRunId() {
  return randomUUID().replaceAll('-', '')
}

//#endregion
export {
  databasePath,
  eventsPath,
  ingestLockPath,
  isLedgerEvent,
  ledgerDir,
  mintRunId,
  runDir,
  runsDir,
}
