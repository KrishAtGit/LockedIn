import browser from 'webextension-polyfill'
import { matchesDomain } from './domain'
import type { PageInfo, PageVerdict } from './pages'
import { isAllowlisted, type Settings } from './storage'

/** A focus session: every distraction is blocked until `endsAt`, whatever time is left on its daily limit. */
export interface FocusSession {
  startedAt: number
  endsAt: number
  minutes: number
}

/** One finished session, kept for the weekly report. */
export interface FocusRecord {
  startedAt: number
  minutes: number
  /** How long it actually ran. Less than `minutes` when ended early. */
  focusedMs: number
  completed: boolean
  /** Why it was ended early, if it was. */
  reason?: string
}

export const FOCUS_LENGTHS = [25, 50, 90]
/** Ending a session early means writing a reason and then waiting this long. */
export const END_EARLY_WAIT_SECONDS = 30
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

export async function getFocusRecords(): Promise<FocusRecord[]> {
  const { focusLog } = await browser.storage.local.get('focusLog')
  return (focusLog as FocusRecord[] | undefined) ?? []
}

export async function addFocusRecord(record: FocusRecord): Promise<void> {
  await browser.storage.local.set({ focusLog: [record, ...(await getFocusRecords())].slice(0, MAX_RECORDS) })
}

/**
 * Whether a page is blocked during a focus session.
 * Study pages and study sites are always allowed. A page the AI calls a distraction is blocked. Otherwise the
 * site decides: well-known distraction sites, and any site you've given its own limit, are blocked.
 */
export function blockedDuringFocus(settings: Settings, page: PageInfo, verdict: PageVerdict | undefined): boolean {
  if (isAllowlisted(settings, page.domain) || verdict?.category === 'study') return false
  if (verdict?.category === 'distraction') return true
  const limited = Object.keys(settings.limits).some((rule) => matchesDomain(page.domain, rule))
  return limited || DISTRACTION_SITES.some((site) => matchesDomain(page.domain, site))
}
