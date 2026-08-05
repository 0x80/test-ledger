import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Resolved per call rather than at module load, so tests can point $HOME at a
 * temp directory. Machine-global on purpose: every worktree writes here, which
 * is what makes cross-run contention analysis possible at all, and what lets
 * the data outlive the worktree that produced it.
 */
export const ledgerDir = (): string =>
  process.env['TEST_LEDGER_DIR'] ?? path.join(homedir(), '.local', 'share', 'test-ledger')

export const runsDir = (): string => path.join(ledgerDir(), 'runs')

export const runDir = (runId: string): string => path.join(runsDir(), runId)

/** Per-process, so concurrent writers never share a file handle or a lock. */
export const eventsPath = (runId: string, pid: number): string =>
  path.join(runDir(runId), `${pid}.ndjson`)

export const databasePath = (): string => path.join(ledgerDir(), 'ledger.db')

/** Held by `ingest` so concurrent runs cannot write the database at once. */
export const ingestLockPath = (): string => path.join(ledgerDir(), 'ingest.lock')
