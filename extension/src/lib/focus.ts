import browser from 'webextension-polyfill'
import { matchesDomain } from './domain'
import type { PageInfo, PageVerdict } from './pages'
import { activeQuietRun, type QuietSkips } from './schedule'
import { getSettings, isAllowlisted, type Settings } from './storage'

/** A focus session: every distraction is blocked until `endsAt`, whatever time is left on its daily limit. */
export interface FocusSession {
  startedAt: number
  endsAt: number
  minutes: number
}

/**
 * Whatever is blocking distractions right now: a focus session you started, or quiet hours from your schedule.
 * Everything that shows or enforces the lock works from this, so both kinds behave the same way.
 */
export interface ActiveLock {
  kind: 'focus' | 'quiet'
  startedAt: number
  endsAt: number
}

/** One finished session or quiet-hours block, kept for the weekly report. */
export interface FocusRecord {
  /** Missing on records from before quiet hours existed, which were all focus sessions. */
  kind?: 'focus' | 'quiet'
  startedAt: number
  minutes: number
  /** How long it actually ran. Less than `minutes` when ended early. */
  focusedMs: number
  completed: boolean
  /** Why it was ended (or quiet hours skipped) early, if it was. */
  reason?: string
}

export const FOCUS_LENGTHS = [25, 50, 90]
/** Ending a focus session or skipping quiet hours means writing a reason and then waiting this long. */
export const END_EARLY_WAIT_SECONDS = 15
export const MIN_END_REASON_LENGTH = 15
const MAX_RECORDS = 500

/**
 * Sites that are blocked during a session even before (or without) the AI labelling the page.
 * The same list the backend's rules treat as distractions.
 */
export const DISTRACTION_SITES = [
  'instagram.com', 'tiktok.com', 'facebook.com', 'x.com', 'twitter.com', 'threads.net', 'snapchat.com',
  'pinterest.com', '9gag.com', 'tumblr.com', 'reddit.com', 'youtube.com', 'netflix.com', 'primevideo.com',
  'disneyplus.com', 'hulu.com', 'stan.com.au', 'binge.com.au', 'twitch.tv', 'kick.com',
]

export async function getFocus(now = Date.now()): Promise<FocusSession | null> {
  const { focus } = await browser.storage.local.get('focus')
  const session = (focus as FocusSession | null | undefined) ?? null
  return session && session.endsAt > now ? session : null
}

export async function getQuietSkips(): Promise<QuietSkips> {
  const { quietSkips } = await browser.storage.local.get('quietSkips')
  return (quietSkips as QuietSkips | undefined) ?? {}
}

/** A focus session takes priority, since quiet hours hide the button to start one. */
export async function getActiveLock(now = Date.now()): Promise<ActiveLock | null> {
  const focus = await getFocus(now)
  if (focus) return { kind: 'focus', startedAt: focus.startedAt, endsAt: focus.endsAt }
  const run = activeQuietRun((await getSettings()).quietHours, now, await getQuietSkips())
  return run ? { kind: 'quiet', startedAt: run.start, endsAt: run.end } : null
}

/** How much of the lock is still to go, from 1 at the start to 0 at the end. */
export function lockFractionLeft(lock: ActiveLock, now = Date.now()): number {
  return Math.max(0, (lock.endsAt - now) / (lock.endsAt - lock.startedAt))
}

/** Storage keys that can start or end a lock when they change. */
export const LOCK_KEYS = ['focus', 'settings', 'quietSkips'] as const

export async function getFocusRecords(): Promise<FocusRecord[]> {
  const { focusLog } = await browser.storage.local.get('focusLog')
  return (focusLog as FocusRecord[] | undefined) ?? []
}

export async function addFocusRecord(record: FocusRecord): Promise<void> {
  await browser.storage.local.set({ focusLog: [record, ...(await getFocusRecords())].slice(0, MAX_RECORDS) })
}

/**
 * Whether a page is blocked during a focus session or quiet hours.
 * Study pages and study sites are always allowed. A page the AI calls a distraction is blocked. Otherwise the
 * site decides: well-known distraction sites, and any site you've given its own limit, are blocked.
 */
export function blockedDuringFocus(settings: Settings, page: PageInfo, verdict: PageVerdict | undefined): boolean {
  if (isAllowlisted(settings, page.domain) || verdict?.category === 'study') return false
  if (verdict?.category === 'distraction') return true
  const limited = Object.keys(settings.limits).some((rule) => matchesDomain(page.domain, rule))
  return limited || DISTRACTION_SITES.some((site) => matchesDomain(page.domain, site))
}
