import type { TurboTaskEvent } from './events.ts'

/**
 * Parses Turbo's `--summarize` output into per-task events.
 *
 * This is free data: Turbo already records per-package timing and cache
 * status, so the only cost is passing the flag and reading the file. Cache
 * status is what makes the `--force` question answerable: it is the
 * difference between "this run executed 69 tasks" and "this run executed 69
 * tasks that a warm cache would have served".
 *
 * Returns nothing rather than throwing for unusable input: an absent or
 * malformed summary is a missing dimension, never a failed run.
 */
export function parseTurboSummary(contents: string, runId: string): TurboTaskEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return []
  }

  if (typeof parsed !== 'object' || parsed === null) return []
  const tasks = (parsed as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return []

  const events: TurboTaskEvent[] = []

  for (const entry of tasks) {
    if (typeof entry !== 'object' || entry === null) continue
    const task = entry as {
      package?: unknown
      task?: unknown
      execution?: { startTime?: unknown; endTime?: unknown }
      cache?: { status?: unknown }
    }

    if (typeof task.package !== 'string' || typeof task.task !== 'string') continue

    const startTime = typeof task.execution?.startTime === 'number' ? task.execution.startTime : 0
    const endTime = typeof task.execution?.endTime === 'number' ? task.execution.endTime : 0

    events.push({
      kind: 'turbo_task',
      runId,
      packageName: task.package,
      task: task.task,
      durationMs: Math.max(0, endTime - startTime),
      cacheStatus: typeof task.cache?.status === 'string' ? task.cache.status : 'UNKNOWN',
    })
  }

  return events
}
