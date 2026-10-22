/**
 * The weekly report: the last 7 days of what LockedIn has recorded, worked out from stored data alone.
 * No browser APIs here, so it can be unit tested (and later gated as a Pro feature in one place).
 */
import type { FocusRecord } from './focus'
import type { DailyMap, Excuse } from './storage'
import { today } from './time'

export const REPORT_DAYS = 7
const TOP_SITES = 5
const RECENT_REASONS = 3

export interface ReportInput {
  usage: DailyMap
  study: DailyMap
  focusLog: FocusRecord[]
  excuses: Excuse[]
  /** The key a domain's limit is counted under, so m.youtube.com and youtube.com are one site. */
  keyOf: (domain: string) => string
  /** Study sites aren't limited, so their time counts as studying. */
  isStudySite: (domain: string) => boolean
}

export interface ReportDay {
  date: string
  countedMs: number
  studyMs: number
}

export interface LockSummary {
  count: number
  completed: number
  endedEarly: number
  lockedInMs: number
}

export interface WeeklyReport {
  /** Oldest first, ending today. */
  days: ReportDay[]
  countedMs: number
  studyMs: number
  /** The 7 days before, for comparison. */
  previousCountedMs: number
  previousStudyMs: number
  topSites: { site: string; ms: number }[]
  focus: LockSummary
  quiet: LockSummary
  /** Why sessions were ended or quiet hours skipped early, newest first. */
  earlyReasons: { ts: number; kind: 'focus' | 'quiet'; reason: string }[]
  excuses: { total: number; allowed: number; denied: number; recent: Excuse[] }
}

/** The local date `offset` days from `now`, by the calendar so it's right across DST changes. */
function dateKey(now: number, offset: number): string {
  const d = new Date(now)
  return today(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime())
}

function dayTotals(input: ReportInput, date: string): ReportDay {
  let countedMs = 0
  let studyMs = 0
  for (const [domain, ms] of Object.entries(input.usage[date] ?? {})) {
    if (input.isStudySite(domain)) studyMs += ms
    else countedMs += ms
  }
  for (const ms of Object.values(input.study[date] ?? {})) studyMs += ms
  return { date, countedMs, studyMs }
}

function summarise(records: FocusRecord[]): LockSummary {
  return {
    count: records.length,
    completed: records.filter((r) => r.completed).length,
    endedEarly: records.filter((r) => !r.completed).length,
    lockedInMs: records.reduce((sum, r) => sum + r.focusedMs, 0),
  }
}

export function buildReport(input: ReportInput, now = Date.now()): WeeklyReport {
  const dates = Array.from({ length: REPORT_DAYS }, (_, i) => dateKey(now, i - (REPORT_DAYS - 1)))
  const previousDates = Array.from({ length: REPORT_DAYS }, (_, i) => dateKey(now, i - (2 * REPORT_DAYS - 1)))
  const days = dates.map((date) => dayTotals(input, date))
  const previous = previousDates.map((date) => dayTotals(input, date))
  const sum = (list: ReportDay[], field: 'countedMs' | 'studyMs') => list.reduce((s, d) => s + d[field], 0)

  const sites = new Map<string, number>()
  for (const date of dates) {
    for (const [domain, ms] of Object.entries(input.usage[date] ?? {})) {
      if (input.isStudySite(domain)) continue
      const key = input.keyOf(domain)
      sites.set(key, (sites.get(key) ?? 0) + ms)
    }
  }

  // Records and reasons are kept by timestamp, so "this week" is everything since the first day's midnight.
  const inWeek = (ts: number) => dates.includes(today(ts))
  const records = input.focusLog.filter((r) => inWeek(r.startedAt))
  const kindOf = (r: FocusRecord) => r.kind ?? 'focus'
  const excuses = input.excuses.filter((e) => inWeek(e.ts))

  return {
    days,
    countedMs: sum(days, 'countedMs'),
    studyMs: sum(days, 'studyMs'),
    previousCountedMs: sum(previous, 'countedMs'),
    previousStudyMs: sum(previous, 'studyMs'),
    topSites: [...sites]
      .map(([site, ms]) => ({ site, ms }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_SITES),
    focus: summarise(records.filter((r) => kindOf(r) === 'focus')),
    quiet: summarise(records.filter((r) => kindOf(r) === 'quiet')),
    earlyReasons: records
      .filter((r) => !r.completed && r.reason)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ ts: r.startedAt, kind: kindOf(r), reason: r.reason! })),
    excuses: {
      total: excuses.length,
      allowed: excuses.filter((e) => (e.verdict ?? 'allowed') === 'allowed').length,
      denied: excuses.filter((e) => e.verdict === 'denied').length,
      recent: [...excuses].sort((a, b) => b.ts - a.ts).slice(0, RECENT_REASONS),
    },
  }
}

/** "+25%", "−10%", or null when there's nothing to compare against. */
export function change(current: number, previous: number): string | null {
  if (previous <= 0) return null
  const pct = Math.round(((current - previous) / previous) * 100)
  return pct === 0 ? 'same as last week' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}% vs last week`
}
