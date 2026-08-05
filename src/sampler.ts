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
    const [load1 = 0, load5 = 0] = loadavg()
    const event: SampleEvent = {
      kind: 'sample',
      runId,
      at: Date.now(),
      load1,
      load5,
      freeMemoryBytes: freemem(),
      liveSlots: options.liveSlots(),
    }
    appendEvents(runId, process.pid, [event])
  }

  write()
  const timer = setInterval(write, intervalMs)
  timer.unref()

  return () => {
    clearInterval(timer)
    write()
  }
}
