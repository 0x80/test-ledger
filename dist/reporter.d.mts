import { r as Lane } from './events-B4CI0IVw.mjs'

//#region src/reporter.d.ts
type ReporterOptions = {
  lane: Lane
  packageName: string
}
/**
 * Structural stand-ins for the Vitest 4 shapes this reporter reads. Declared
 * here rather than imported so the package does not take a hard dependency on
 * `vitest`'s type exports, which move between majors; the reporter reads only
 * these few members and the host's real objects satisfy them.
 */
type ReporterTestCase = {
  fullName: string
  result: () => {
    state: string
    errors?: readonly {
      name?: string
      message?: string
    }[]
  }
  diagnostic: () =>
    | {
        duration: number
        startTime: number
        retryCount: number
      }
    | undefined
}
type ReporterTestModule = {
  moduleId: string
  diagnostic: () => {
    environmentSetupDuration: number
    prepareDuration: number
    collectDuration: number
    setupDuration: number
    duration: number
  }
  children: {
    allTests: () => Iterable<ReporterTestCase>
  }
}
/**
 * Appends per-file and per-test records as NDJSON, one file per process.
 *
 * This is the only part of the ledger that runs inside the test path, so it
 * does the least possible: no database driver, no network, no lock, no fsync.
 * An append to a pid-scoped file needs no coordination with the ~24 sibling
 * Vitest processes a `pnpm test` fans out to, which is the whole reason the
 * ingest step exists separately.
 */
declare class TestLedgerReporter {
  #private
  /**
   * `options` is optional and each field defaults defensively: everything
   * after construction is wrapped in the same "never fail the run" guarantee,
   * and a hand-written Vitest config that forgets to pass reporter options (or
   * passes an empty object) must not throw at Vitest startup either.
   */
  constructor(options?: Partial<ReporterOptions>)
  onTestModuleEnd(testModule: ReporterTestModule): Promise<void>
}
//#endregion
export { TestLedgerReporter as default }
