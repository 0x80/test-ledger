import { describe, expect, it } from 'vitest'

import { mintRunId } from '../src/run-id.ts'

describe('run id', () => {
  it('is a 32-character hex string', () => {
    expect(mintRunId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs between calls, so two runs never collide', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRunId()))
    expect(ids.size).toBe(200)
  })
})
