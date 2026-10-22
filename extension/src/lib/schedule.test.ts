import { describe, expect, it } from 'vitest'
import { activeQuietRun, nextQuietChange, quietLengthMinutes, type QuietBlock } from './schedule'

// Tests run with TZ=Australia/Melbourne (see package.json), so these are local times there.
const at = (iso: string) => new Date(iso).getTime()
const WEEKDAYS = [1, 2, 3, 4, 5]

function block(overrides: Partial<QuietBlock> = {}): QuietBlock {
  return { id: 'work', days: WEEKDAYS, start: '09:00', end: '17:00', enabled: true, ...overrides }
}

describe('activeQuietRun', () => {
  // 2026-10-19 is a Monday.
  it('is active inside a weekday block', () => {
    const run = activeQuietRun([block()], at('2026-10-19T10:30'))
    expect(run).toEqual({ id: 'work', start: at('2026-10-19T09:00'), end: at('2026-10-19T17:00') })
  })

  it('is not active on a day the block skips', () => {
    expect(activeQuietRun([block()], at('2026-10-18T10:30'))).toBeNull() // Sunday
  })

  it('starts on the minute and ends on the minute', () => {
    expect(activeQuietRun([block()], at('2026-10-19T09:00'))).not.toBeNull()
    expect(activeQuietRun([block()], at('2026-10-19T08:59'))).toBeNull()
    expect(activeQuietRun([block()], at('2026-10-19T17:00'))).toBeNull()
  })

  it('ignores blocks that are switched off', () => {
    expect(activeQuietRun([block({ enabled: false })], at('2026-10-19T10:30'))).toBeNull()
  })

  it('carries an overnight block past midnight into the next day', () => {
    const night = block({ id: 'night', days: [0], start: '23:00', end: '07:00' }) // Sunday nights
    const run = activeQuietRun([night], at('2026-10-19T02:00')) // early Monday
    expect(run).toEqual({ id: 'night', start: at('2026-10-18T23:00'), end: at('2026-10-19T07:00') })
  })

  it('does not run an overnight block the morning after a day it skips', () => {
    const night = block({ id: 'night', days: [0], start: '23:00', end: '07:00' })
    expect(activeQuietRun([night], at('2026-10-20T02:00'))).toBeNull() // early Tuesday
  })

  it('treats the same start and end as a full day', () => {
    const allDay = block({ id: 'day', days: [1], start: '00:00', end: '00:00' })
    expect(activeQuietRun([allDay], at('2026-10-19T23:59'))?.end).toBe(at('2026-10-20T00:00'))
  })

  it('skips only the run that was skipped', () => {
    const skips = { work: at('2026-10-19T17:00') }
    expect(activeQuietRun([block()], at('2026-10-19T10:30'), skips)).toBeNull()
    expect(activeQuietRun([block()], at('2026-10-20T10:30'), skips)).not.toBeNull()
  })

  it('picks the overlapping block that ends last', () => {
    const blocks = [block(), block({ id: 'late', start: '16:00', end: '20:00' })]
    expect(activeQuietRun(blocks, at('2026-10-19T16:30'))?.id).toBe('late')
  })

  it('keeps wall-clock times across a daylight saving change', () => {
    // Melbourne clocks went forward at 2am on Sunday 2026-10-04, so 01:00–09:00 was only 7 hours long.
    const run = activeQuietRun([block({ days: [0], start: '01:00', end: '09:00' })], at('2026-10-04T05:00'))
    expect(run?.end).toBe(at('2026-10-04T09:00'))
    expect(run!.end - run!.start).toBe(7 * 60 * 60_000)
  })
})

describe('nextQuietChange', () => {
  it('is the start of the next block', () => {
    expect(nextQuietChange([block()], at('2026-10-19T07:00'))).toBe(at('2026-10-19T09:00'))
  })

  it('is the end of the block in progress', () => {
    expect(nextQuietChange([block()], at('2026-10-19T10:00'))).toBe(at('2026-10-19T17:00'))
  })

  it('jumps over the weekend', () => {
    expect(nextQuietChange([block()], at('2026-10-23T18:00'))).toBe(at('2026-10-26T09:00')) // Friday → Monday
  })

  it('is null with nothing scheduled', () => {
    expect(nextQuietChange([block({ enabled: false })], at('2026-10-19T10:00'))).toBeNull()
    expect(nextQuietChange([], at('2026-10-19T10:00'))).toBeNull()
  })
})

describe('quietLengthMinutes', () => {
  it('measures day and overnight blocks', () => {
    expect(quietLengthMinutes({ start: '09:00', end: '17:00' })).toBe(480)
    expect(quietLengthMinutes({ start: '23:00', end: '07:00' })).toBe(480)
    expect(quietLengthMinutes({ start: '09:00', end: '09:00' })).toBe(1440)
  })
})
