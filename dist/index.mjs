import {
  a as ledgerDir,
  i as ingestLockPath,
  n as databasePath,
  o as runDir,
  r as eventsPath,
  s as runsDir,
  t as mintRunId,
} from './run-id-BM4m0y2_.mjs'

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
