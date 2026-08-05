/** tsdown.config.ts */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts', 'src/reporter.ts', 'src/index.ts'],
  format: 'esm',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  shims: false,
  /** Consumers import this package's types; `exports` points at `dist/*.d.mts`. */
  dts: true,
})
