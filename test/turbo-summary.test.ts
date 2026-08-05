import { describe, expect, it } from 'vitest'

import { parseTurboSummary } from '../src/turbo-summary.ts'

describe('turbo summary parsing', () => {
  it('maps tasks to events', () => {
    const events = parseTurboSummary(
      JSON.stringify({
        tasks: [
          {
            taskId: '@repo/db#test',
            package: '@repo/db',
            task: 'test',
            execution: { startTime: 1000, endTime: 1500 },
            cache: { status: 'MISS' },
          },
          {
            taskId: '@repo/types#test',
            package: '@repo/types',
            task: 'test',
            execution: { startTime: 1000, endTime: 1100 },
            cache: { status: 'HIT', source: 'LOCAL' },
          },
        ],
      }),
      'r1',
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'turbo_task',
      runId: 'r1',
      packageName: '@repo/db',
      task: 'test',
      durationMs: 500,
      cacheStatus: 'MISS',
    })
    expect(events[1]?.cacheStatus).toBe('HIT')
  })

  /** A malformed or absent summary must not fail the wrapper. */
  it('returns nothing for unparseable input', () => {
    expect(parseTurboSummary('not json', 'r1')).toEqual([])
    expect(parseTurboSummary('{}', 'r1')).toEqual([])
  })
})
