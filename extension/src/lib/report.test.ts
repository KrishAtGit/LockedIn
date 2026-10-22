import { describe, expect, it } from 'vitest'
import type { FocusRecord } from './focus'
import { buildReport, change, type ReportInput } from './report'
import { MINUTE } from './time'

// Tests run with TZ=Australia/Melbourne (see package.json). "Now" is Thursday 22 October 2026, mid-afternoon.
const NOW = new Date('2026-10-22T15:00').getTime()
const at = (iso: string) => new Date(iso).getTime()

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    usage: {},
    study: {},
    focusLog: [],
    excuses: [],
    keyOf: (domain) => domain.replace(/^m\./, ''),
    isStudySite: (domain) => domain === 'canvas.instructure.com',
    ...overrides,
  }
}

describe('buildReport', () => {
  it('covers the last 7 days, oldest first, ending today', () => {
    const report = buildReport(input(), NOW)
    expect(report.days.map((d) => d.date)).toEqual([
      '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22',
    ])
  })

  it('splits counted time from study time, including study sites', () => {
    const report = buildReport(
      input({
        usage: { '2026-10-22': { 'youtube.com': 30 * MINUTE, 'canvas.instructure.com': 20 * MINUTE } },
        study: { '2026-10-22': { 'youtube.com': 45 * MINUTE } },
      }),
      NOW,
    )
    expect(report.days.at(-1)).toEqual({ date: '2026-10-22', countedMs: 30 * MINUTE, studyMs: 65 * MINUTE })
    expect(report.countedMs).toBe(30 * MINUTE)
    expect(report.studyMs).toBe(65 * MINUTE)
  })

  it('compares with the 7 days before and ignores older data', () => {
    const report = buildReport(
      input({
        usage: {
          '2026-10-15': { 'reddit.com': 60 * MINUTE }, // previous week
          '2026-10-09': { 'reddit.com': 60 * MINUTE }, // previous week, first day
          '2026-10-08': { 'reddit.com': 999 * MINUTE }, // too old
        },
      }),
      NOW,
    )
    expect(report.countedMs).toBe(0)
    expect(report.previousCountedMs).toBe(120 * MINUTE)
  })

  it('ranks top sites by counted time, merging subdomains and leaving out study sites', () => {
    const report = buildReport(
      input({
        usage: {
          '2026-10-20': { 'youtube.com': 10 * MINUTE, 'reddit.com': 25 * MINUTE },
          '2026-10-21': { 'm.youtube.com': 20 * MINUTE, 'canvas.instructure.com': 90 * MINUTE },
        },
      }),
      NOW,
    )
    expect(report.topSites).toEqual([
      { site: 'youtube.com', ms: 30 * MINUTE },
      { site: 'reddit.com', ms: 25 * MINUTE },
    ])
  })

  it('summarises focus sessions and quiet hours separately, with early reasons newest first', () => {
    const focusLog: FocusRecord[] = [
      { startedAt: at('2026-10-21T10:00'), minutes: 50, focusedMs: 50 * MINUTE, completed: true },
      { kind: 'focus', startedAt: at('2026-10-22T09:00'), minutes: 25, focusedMs: 10 * MINUTE, completed: false, reason: 'Group call started early' },
      { kind: 'quiet', startedAt: at('2026-10-20T09:00'), minutes: 480, focusedMs: 120 * MINUTE, completed: false, reason: 'Needed YouTube for a tutorial' },
      { kind: 'quiet', startedAt: at('2026-10-19T09:00'), minutes: 480, focusedMs: 480 * MINUTE, completed: true },
      { kind: 'focus', startedAt: at('2026-10-10T09:00'), minutes: 25, focusedMs: 25 * MINUTE, completed: true }, // too old
    ]
    const report = buildReport(input({ focusLog }), NOW)
    expect(report.focus).toEqual({ count: 2, completed: 1, endedEarly: 1, lockedInMs: 60 * MINUTE })
    expect(report.quiet).toEqual({ count: 2, completed: 1, endedEarly: 1, lockedInMs: 600 * MINUTE })
    expect(report.earlyReasons.map((r) => r.kind)).toEqual(['focus', 'quiet'])
  })

  it('counts reasons for more time, treating old ones without a verdict as allowed', () => {
    const excuses = [
      { ts: at('2026-10-22T11:00'), domain: 'youtube.com', reason: 'Finishing the lecture', minutes: 15, verdict: 'allowed' as const },
      { ts: at('2026-10-21T11:00'), domain: 'reddit.com', reason: 'just a bit more pls', minutes: 5, verdict: 'denied' as const },
      { ts: at('2026-10-17T11:00'), domain: 'reddit.com', reason: 'Checking the course subreddit', minutes: 5 },
      { ts: at('2026-10-01T11:00'), domain: 'reddit.com', reason: 'Too old to count', minutes: 5 },
    ]
    const report = buildReport(input({ excuses }), NOW)
    expect(report.excuses.total).toBe(3)
    expect(report.excuses.allowed).toBe(2)
    expect(report.excuses.denied).toBe(1)
    expect(report.excuses.recent[0].domain).toBe('youtube.com')
  })
})

describe('change', () => {
  it('describes the change from last week', () => {
    expect(change(150, 100)).toBe('+50% vs last week')
    expect(change(50, 100)).toBe('−50% vs last week')
    expect(change(100, 100)).toBe('same as last week')
    expect(change(100, 0)).toBeNull()
  })
})
