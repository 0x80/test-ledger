import { a as runDir, n as eventsPath } from './paths-s98kclyI.mjs'
import { t as classifyFailure } from './failure-class-CcnPcZ9E.mjs'
import { t as mintRunId } from './run-id-CEax1HmG.mjs'
import { appendFile, mkdir } from 'node:fs/promises'

//#region src/reporter.ts
/**
 * Appends per-file and per-test records as NDJSON, one file per process.
 *
 * This is the only part of the ledger that runs inside the test path, so it
 * does the least possible: no database driver, no network, no lock, no fsync.
 * An append to a pid-scoped file needs no coordination with the ~24 sibling
 * Vitest processes a `pnpm test` fans out to, which is the whole reason the
 * ingest step exists separately.
 */
var TestLedgerReporter = class {
  #lane
  #packageName
  #runId
  #pid
  /**
   * Set on the first failure and never cleared. One broken write almost always
   * means every subsequent write is broken too (a read-only directory, a full
   * disk), so retrying per module would turn one problem into thousands of
   * syscalls inside the suite being measured.
   */
  #disabled = false
  #directoryReady = false
  /**
   * `options` is optional and each field defaults defensively: everything
   * after construction is wrapped in the same "never fail the run" guarantee,
   * and a hand-written Vitest config that forgets to pass reporter options (or
   * passes an empty object) must not throw at Vitest startup either.
   */
  constructor(options) {
    /**
     * An escape hatch that must exist before anyone needs it: if the ledger
     * ever perturbs a run, a developer has to be able to take it out of the
     * path without editing a shared config every worktree depends on.
     */
    if (process.env['TEST_LEDGER_DISABLED'] === '1') this.#disabled = true
    this.#lane = options?.lane ?? 'unknown'
    this.#packageName = options?.packageName ?? 'unknown'
    /**
     * An ad-hoc `pnpm --filter x test` runs outside the budget wrapper and so
     * has no envelope. Minting an id here means that run is still recorded
     * rather than silently lost; ingest marks it as envelope-less.
     */
    this.#runId = process.env['TEST_LEDGER_RUN_ID'] ?? mintRunId()
    this.#pid = process.pid
  }
  async onTestModuleEnd(testModule) {
    if (this.#disabled) return
    try {
      const events = this.#buildEvents(testModule)
      await this.#append(events)
    } catch {
      /**
       * Deliberately swallowed, including the classification and traversal
       * above: nothing this reporter does is worth failing a test run over.
       */
      this.#disabled = true
    }
  }
  #buildEvents(testModule) {
    const diagnostic = testModule.diagnostic()
    const events = []
    let passed = 0
    let failed = 0
    let skipped = 0
    let earliestStart = Number.POSITIVE_INFINITY
    for (const testCase of testModule.children.allTests()) {
      const result = testCase.result()
      const testDiagnostic = testCase.diagnostic()
      if (result.state === 'passed') passed += 1
      else if (result.state === 'failed') failed += 1
      else if (result.state === 'skipped') skipped += 1
      const startedAt = testDiagnostic?.startTime ?? 0
      if (startedAt > 0 && startedAt < earliestStart) earliestStart = startedAt
      const firstError = result.errors?.[0]
      const testEvent = {
        kind: 'test',
        runId: this.#runId,
        pid: this.#pid,
        file: testModule.moduleId,
        fullName: testCase.fullName,
        state: normalizeState(result.state),
        durationMs: testDiagnostic?.duration ?? 0,
        startedAt,
        retryCount: testDiagnostic?.retryCount ?? 0,
        ...(result.state === 'failed'
          ? {
              failureClass: classifyFailure(firstError ?? {}),
              failureMessage: (firstError?.message ?? '').slice(0, 2e3),
            }
          : {}),
      }
      events.push(testEvent)
    }
    const fileEvent = {
      kind: 'file',
      runId: this.#runId,
      pid: this.#pid,
      lane: this.#lane,
      packageName: this.#packageName,
      file: testModule.moduleId,
      startedAt: Number.isFinite(earliestStart) ? earliestStart : 0,
      durationMs: diagnostic.duration,
      setupMs: diagnostic.setupDuration,
      collectMs: diagnostic.collectDuration,
      environmentSetupMs: diagnostic.environmentSetupDuration,
      prepareMs: diagnostic.prepareDuration,
      passed,
      failed,
      skipped,
    }
    events.push(fileEvent)
    return events
  }
  async #append(events) {
    if (events.length === 0) return
    if (!this.#directoryReady) {
      await mkdir(runDir(this.#runId), { recursive: true })
      this.#directoryReady = true
    }
    const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    await appendFile(eventsPath(this.#runId, this.#pid), payload)
  }
}
function normalizeState(state) {
  if (state === 'passed' || state === 'failed' || state === 'skipped') return state
  return 'pending'
}

//#endregion
export { TestLedgerReporter as default }
