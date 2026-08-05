/** vitest.config.ts */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /** Several suites write real files under a temp directory. */
    testTimeout: 15_000,
  },
})
