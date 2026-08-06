import { randomUUID } from 'node:crypto'

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
export { mintRunId as t }
