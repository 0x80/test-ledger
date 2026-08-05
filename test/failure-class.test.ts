import { describe, expect, it } from 'vitest'

import { classifyFailure } from '../src/failure-class.ts'

describe('failure classification', () => {
  it.each([
    ['Test timed out in 5000ms', 'timeout'],
    ['Hook timed out in 30000ms', 'hook_timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'db_timeout'],
    ['Connection terminated due to connection timeout', 'db_timeout'],
    ['SQLITE_BUSY: database is locked', 'db_timeout'],
    ['Connection timeout while connecting to Postgres', 'db_timeout'],
  ])('classifies %j as %s', (message, expected) => {
    expect(classifyFailure({ message })).toBe(expected)
  })

  it('classifies an assertion by its error name', () => {
    expect(classifyFailure({ name: 'AssertionError', message: 'expected 403 to be 200' })).toBe(
      'assertion',
    )
  })

  it('classifies an unhandled rejection', () => {
    expect(classifyFailure({ name: 'UnhandledRejection', message: 'boom' })).toBe(
      'unhandled_rejection',
    )
  })

  it('falls back to thrown for an ordinary error', () => {
    expect(classifyFailure({ name: 'TypeError', message: 'x is not a function' })).toBe('thrown')
  })

  it('falls back to unknown when there is nothing to read', () => {
    expect(classifyFailure({})).toBe('unknown')
  })

  /**
   * A hook timeout is also a timeout; the more specific class has to win or
   * the distinction the report depends on collapses.
   */
  it('prefers hook_timeout over timeout when both could match', () => {
    expect(classifyFailure({ message: 'Hook timed out in 30000ms' })).toBe('hook_timeout')
  })

  /**
   * The DB-timeout class exists to separate host-capacity artifacts from
   * genuine flakes. This input matches both the db_timeout rule
   * (UND_ERR_HEADERS_TIMEOUT) and the generic timeout rule (timed out in Xms),
   * so the assertion only passes when db_timeout is checked first.
   */
  it('prefers db_timeout over timeout when both patterns could match', () => {
    expect(
      classifyFailure({ message: 'UND_ERR_HEADERS_TIMEOUT: Headers timed out in 5000ms' }),
    ).toBe('db_timeout')
  })
})
