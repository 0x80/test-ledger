import { randomUUID } from 'node:crypto'

//#region src/failure-class.ts
/**
 * Ordered most specific first. The order is the behavior: `hook_timeout` and
 * `db_timeout` both also match the generic timeout rule, and collapsing them
 * into it would destroy exactly the distinction these classes exist to draw.
 */
const MESSAGE_RULES = [
  [/hook timed out/i, 'hook_timeout'],
  [/UND_ERR_HEADERS_TIMEOUT|ECONNRESET|SQLITE_BUSY|database is locked/i, 'db_timeout'],
  [/connection (terminated|timeout)|connect ETIMEDOUT|timeout while connecting/i, 'db_timeout'],
  [/test timed out|timed out in \d+ms/i, 'timeout'],
]
const NAME_RULES = [
  [/^assertion/i, 'assertion'],
  [/unhandled\s*rejection/i, 'unhandled_rejection'],
]
/**
 * Classifies a failure so "genuine flake" and "load artifact" are separable by
 * query rather than by judgment. This encodes the heuristic `/run-tests` asks a
 * human to apply by hand on every red run.
 *
 * The raw message is stored alongside the class by the caller, deliberately: a
 * misclassification stays re-derivable, so these rules can change later without
 * a backfill being required for correctness.
 */
function classifyFailure(error) {
  const message = error.message ?? ''
  const name = error.name ?? ''
  for (const [pattern, failureClass] of MESSAGE_RULES)
    if (pattern.test(message)) return failureClass
  for (const [pattern, failureClass] of NAME_RULES) if (pattern.test(name)) return failureClass
  if (name !== '' || message !== '') return 'thrown'
  return 'unknown'
}

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
export { classifyFailure as n, mintRunId as t }
