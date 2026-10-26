import browser from 'webextension-polyfill'
import type { Category } from './api'
import { domainOf } from './domain'

export interface PageInfo {
  domain: string
  path: string
  title: string
  /** Identifies "the same page" across visits, mirroring the backend's cache key. */
  key: string
}

export interface PageVerdict {
  category: Category
  reason: string
}

const MAX_CACHED_PAGES = 500

/** Strips "(3) " notification counts so the same page keeps the same key. */
function cleanTitle(title: string): string {
  return title.replace(/^\(\d+\+?\)\s*/, '').trim()
}

export function pageInfo(url: string | undefined, title: string | undefined): PageInfo | null {
  const domain = domainOf(url)
  if (!domain) return null
  const path = new URL(url!).pathname
  const clean = cleanTitle(title ?? '')
  const segment = path.split('/')[1] ?? ''
  return { domain, path, title: clean, key: `${domain}|${segment}|${clean.toLowerCase()}` }
}

/**
 * True when the title says nothing about the page yet. YouTube shows just "YouTube" for a moment
 * after navigating, and classifying that would cache a useless verdict.
 */
export function titleIsPlaceholder(page: PageInfo): boolean {
  const site = page.domain.split('.').slice(-2, -1)[0] ?? ''
  return page.title === '' || page.title.toLowerCase() === site
}

// Verdicts live in session storage: cleared when the browser closes, and the backend has its own cache anyway.
async function getVerdicts(): Promise<Record<string, PageVerdict>> {
  const { verdicts } = await browser.storage.session.get('verdicts')
  return (verdicts as Record<string, PageVerdict> | undefined) ?? {}
}

export async function getVerdict(key: string): Promise<PageVerdict | undefined> {
  return (await getVerdicts())[key]
}

export async function saveVerdict(key: string, verdict: PageVerdict): Promise<void> {
  const verdicts = await getVerdicts()
  verdicts[key] = verdict
  // Keep only the most recent pages (object keys keep insertion order).
  const keys = Object.keys(verdicts)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_PAGES))) delete verdicts[old]
  await browser.storage.session.set({ verdicts })
}

/**
 * How the backend answered last: fine, unreachable (or its AI is), or running without AI on purpose, like the
 * hosted server. Only 'down' is worth an "AI offline" warning; a server without AI just labels what its rules know.
 */
export type BackendState = 'ok' | 'down' | 'no-ai'

export async function setBackendState(state: BackendState): Promise<void> {
  await browser.storage.session.set({ backendState: state })
}

/**
 * What the AI knows about a page: its label, still working on it, unreachable, or switched off in settings.
 */
export type AiState = 'labelled' | 'checking' | 'offline' | 'off'

export async function aiState(
  backendEnabled: boolean,
  page: PageInfo,
  verdict: PageVerdict | undefined,
): Promise<AiState> {
  if (verdict) return 'labelled'
  // Nothing to say about a page whose title is just the site name, unless the site rules already labelled it.
  if (!backendEnabled || titleIsPlaceholder(page)) return 'off'
  const { backendState } = await browser.storage.session.get('backendState')
  if (backendState === 'no-ai') return 'off'
  return backendState === 'down' ? 'offline' : 'checking'
}
