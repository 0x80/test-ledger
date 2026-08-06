import { freemem, loadavg } from 'node:os'

import { appendEvents } from './envelope.ts'
import type { SampleEvent } from './events.ts'

type SamplerOptions = {
  intervalMs?: number
  liveSlots: () => number
}

/**
 * Samples host load for the life of the run, returning a stop function.
 *
 * The timeline is what makes a slow file attributable. Start and end
 * snapshots cannot distinguish a run that was calm throughout from one
 * crushed at minute three, and per-file absolute timestamps are only useful
 * if there is something to join them against.
 *
 * `unref()` so a hung stop call can never keep the wrapper process alive.
 */
export function startSampler(runId: string, options: SamplerOptions): () => void {
  const intervalMs = options.intervalMs ?? 5000

  const write = (): void => {
    /**
     * The whole body is guarded, not just `appendEvents` below: `liveSlots()`
     * runs before `appendEvents` is ever reached, so a throw inside it (the
     * monorepo's callback calls `readdirSync` on a slot directory that can
     * vanish mid-run) must not escape here either. A failing `liveSlots()`
     * degrades to an unknown count rather than losing the sample entirely —
     * `load1`/`load5`/free memory are still worth recording on their own.
     */
    try {
      let liveSlots = 0
      try {
        liveSlots = options.liveSlots()
      } catch {
        /** Degrade to an unknown slot count; the rest of the sample still lands. */
      }

      const [load1 = 0, load5 = 0] = loadavg()
      const event: SampleEvent = {
        kind: 'sample',
        runId,
        at: Date.now(),
        load1,
        load5,
        freeMemoryBytes: freemem(),
        liveSlots,
      }
      appendEvents(runId, process.pid, [event])
    } catch {
      /** Deliberately silent: telemetry must never fail the run it measures. */
    }
  }

  write()
  const timer = setInterval(write, intervalMs)
  timer.unref()

  return () => {
    clearInterval(timer)
    write()
  }
}
