/** Returns the trackable domain for a URL, or null for browser/internal pages. */
export function domainOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return null
    return hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** True if `domain` equals `rule` or is a subdomain of it (m.youtube.com matches youtube.com). */
export function matchesDomain(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`)
}
