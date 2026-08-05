import { describe, expect, it } from 'vitest'

import { isLedgerEvent } from '../src/events.ts'

describe('the NDJSON event contract', () => {
  it('accepts a well-formed file event', () => {
    expect(
      isLedgerEvent({
        kind: 'file',
        runId: 'r1',
        pid: 42,
        lane: 'unit',
        packageName: '@repo/db',
        file: '/abs/path.test.ts',
        startedAt: 1_700_000_000_000,
        durationMs: 12,
        setupMs: 1,
        collectMs: 2,
        environmentSetupMs: 3,
        prepareMs: 4,
        passed: 3,
        failed: 0,
        skipped: 1,
      }),
    ).toBe(true)
  })

  it('rejects a payload with an unknown kind', () => {
    expect(isLedgerEvent({ kind: 'nonsense', runId: 'r1' })).toBe(false)
  })

  it('rejects a non-object', () => {
    expect(isLedgerEvent('file')).toBe(false)
    expect(isLedgerEvent(undefined)).toBe(false)
  })
})
