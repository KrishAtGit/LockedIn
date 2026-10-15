import browser from 'webextension-polyfill'
import { matchesDomain } from './domain'
import { MINUTE, today } from './time'

export interface Settings {
  defaultLimitMin: number
  /** Per-domain overrides of the default limit, in minutes. */
  limits: Record<string, number>
  /** Domains that are never limited (e.g. your LMS). */
  allowlist: string[]
  warnBeforeMin: number
}

export interface Excuse {
  ts: number
  domain: string
  reason: string
  minutes: number
}

/** date -> domain -> milliseconds */
export type DailyMap = Record<string, Record<string, number>>

export const DEFAULT_SETTINGS: Settings = {
  defaultLimitMin: 60,
  limits: {},
  allowlist: ['canvas.instructure.com', 'moodle.org', 'scholar.google.com'],
  warnBeforeMin: 5,
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ settings })
}

export async function getDaily(key: 'usage' | 'grants'): Promise<DailyMap> {
  const result = await browser.storage.local.get(key)
  return (result[key] as DailyMap | undefined) ?? {}
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
