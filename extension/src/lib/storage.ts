import browser from 'webextension-polyfill'
import { matchesDomain } from './domain'
import type { QuietBlock } from './schedule'
import { DAY, MINUTE, today } from './time'

export interface Settings {
  defaultLimitMin: number
  /** Per-domain overrides of the default limit, in minutes. */
  limits: Record<string, number>
  /** Domains that are never limited (e.g. your LMS). */
  allowlist: string[]
  warnBeforeMin: number
  /** Show the floating timer on websites. */
  showTimer: boolean
  /** Weekly schedules that block distractions, like a focus session that starts by itself. */
  quietHours: QuietBlock[]
  backend: BackendSettings
}

export interface BackendSettings {
  /** Off by default: when on, page titles are sent to this server to be classified. */
  enabled: boolean
  url: string
}

export interface Excuse {
  ts: number
  domain: string
  reason: string
  minutes: number
  /** Missing on reasons logged before the AI judge existed, which were always allowed. */
  verdict?: 'allowed' | 'denied'
  /** What the judge said back. */
  reply?: string
}

/** date -> domain -> milliseconds */
export type DailyMap = Record<string, Record<string, number>>

export const DEFAULT_SETTINGS: Settings = {
  defaultLimitMin: 60,
  limits: {},
  allowlist: ['canvas.instructure.com', 'moodle.org', 'scholar.google.com'],
  warnBeforeMin: 5,
  showTimer: true,
  quietHours: [],
  backend: { enabled: false, url: 'http://localhost:8000' },
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings')
  const saved = (settings as Partial<Settings> | undefined) ?? {}
  return { ...DEFAULT_SETTINGS, ...saved, backend: { ...DEFAULT_SETTINGS.backend, ...saved.backend } }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings })
}

/** usage: time that counts toward limits. study: time on pages the AI marked as study, which doesn't. */
export async function getDaily(key: 'usage' | 'study' | 'grants'): Promise<DailyMap> {
  const result = await browser.storage.local.get(key)
  return (result[key] as DailyMap | undefined) ?? {}
}

/** How much daily history is kept. Enough for weekly reports and monthly trends, and no more. */
export const KEEP_DAYS = 90

/** Deletes per-day totals older than KEEP_DAYS. */
export async function pruneOldDays(now = Date.now()): Promise<void> {
  const cutoff = today(now - KEEP_DAYS * DAY)
  const keys = ['usage', 'study', 'grants'] as const
  const stored = await browser.storage.local.get([...keys])
  const update: Record<string, DailyMap> = {}
  for (const key of keys) {
    const days = (stored[key] as DailyMap | undefined) ?? {}
    const kept = Object.fromEntries(Object.entries(days).filter(([day]) => day >= cutoff))
    if (Object.keys(kept).length < Object.keys(days).length) update[key] = kept
  }
  if (Object.keys(update).length > 0) await browser.storage.local.set(update)
}

export async function getTodayUsage(): Promise<Record<string, number>> {
  return (await getDaily('usage'))[today()] ?? {}
}

export async function getExcuses(): Promise<Excuse[]> {
  const { excuses } = await browser.storage.local.get('excuses')
  return (excuses as Excuse[] | undefined) ?? []
}

export function isAllowlisted(settings: Settings, domain: string): boolean {
  return settings.allowlist.some((rule) => matchesDomain(domain, rule))
}

/**
 * The key a domain's limit is counted under: the matching per-domain rule if there is one
 * (so m.youtube.com and youtube.com share one budget), otherwise the domain itself.
 */
export function limitKey(settings: Settings, domain: string): string {
  return Object.keys(settings.limits).find((rule) => matchesDomain(domain, rule)) ?? domain
}

/** The base daily limit in ms for a limit key, ignoring any extra time granted today. */
export function baseLimitMs(settings: Settings, key: string): number {
  return (settings.limits[key] ?? settings.defaultLimitMin) * MINUTE
}

/** Total time today across every domain that falls under a limit key. */
export function usedMs(usageToday: Record<string, number>, key: string): number {
  return Object.entries(usageToday)
    .filter(([domain]) => matchesDomain(domain, key))
    .reduce((sum, [, ms]) => sum + ms, 0)
}
