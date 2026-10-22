/**
 * Quiet hours: weekly schedules during which distractions are blocked as if a focus session were running.
 * Everything here is plain date maths with no browser APIs, so it can be unit tested.
 */

export interface QuietBlock {
  id: string
  /** Days the block starts on, 0 = Sunday … 6 = Saturday (as in Date.getDay). */
  days: number[]
  /** Local times, "HH:MM". An end at or before the start means the block runs past midnight. */
  start: string
  end: string
  enabled: boolean
}

/** One run of a block, e.g. this Monday 09:00–17:00. */
export interface QuietRun {
  id: string
  start: number
  end: number
}

/** Block id -> end of the run that was skipped, so only that one run is skipped. */
export type QuietSkips = Record<string, number>

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** A local time on the day `offset` days from `now`. Built from calendar fields, so it's right across DST changes. */
function localTime(now: number, offset: number, minutes: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 0, minutes).getTime()
}

/** The runs of every enabled block that start between `fromDay` and `toDay` days from `now`. */
function runs(blocks: QuietBlock[], now: number, fromDay: number, toDay: number): QuietRun[] {
  const result: QuietRun[] = []
  for (let offset = fromDay; offset <= toDay; offset++) {
    const weekday = new Date(localTime(now, offset, 0)).getDay()
    for (const block of blocks) {
      if (!block.enabled || !block.days.includes(weekday)) continue
      const start = minutesOf(block.start)
      const end = minutesOf(block.end)
      // An end at or before the start is the next morning (and the same time means a full 24 hours).
      result.push({
        id: block.id,
        start: localTime(now, offset, start),
        end: localTime(now, end > start ? offset : offset + 1, end),
      })
    }
  }
  return result
}

/**
 * The run in progress at `now`, if any. A run you skipped doesn't count. When two overlap, the one that
 * lasts longer wins, so the lock never ends while another block is still running.
 */
export function activeQuietRun(blocks: QuietBlock[], now: number, skips: QuietSkips = {}): QuietRun | null {
  // A run that started yesterday (overnight) can still be going today.
  return (
    runs(blocks, now, -1, 0)
      .filter((run) => run.start <= now && now < run.end && skips[run.id] !== run.end)
      .sort((a, b) => b.end - a.end)[0] ?? null
  )
}

/** The next time any block starts or ends, so the background can act right on the minute. */
export function nextQuietChange(blocks: QuietBlock[], now: number): number | null {
  const times = runs(blocks, now, -1, 7)
    .flatMap((run) => [run.start, run.end])
    .filter((t) => t > now)
  return times.length > 0 ? Math.min(...times) : null
}

/** Minutes a block lasts, e.g. 480 for 09:00–17:00 or 23:00–07:00. */
export function quietLengthMinutes(block: Pick<QuietBlock, 'start' | 'end'>): number {
  const length = minutesOf(block.end) - minutesOf(block.start)
  return length > 0 ? length : length + 24 * 60
}
