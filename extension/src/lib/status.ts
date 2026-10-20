import type { Category } from './api'
import type { AiState } from './pages'

/** Everything the popup and the on-page timer show about one site, computed by the background script. */
export interface SiteStatus {
  site: string
  usedMs: number
  limitMs: number
  /** Turn amber once this little time is left (the "warn me before" setting). */
  warnMs: number
  /** True while this tab's time is being counted right now, so a countdown should keep ticking. */
  counting: boolean
  /** Study pages don't use up the limit. */
  exempt: 'study-page' | null
  /** On the study-sites list, so never limited at all. */
  allowlisted: boolean
  /** How the AI labelled this page, if it has. */
  category: Category | null
  ai: AiState
}

/** What the on-page timer shows. It's hidden when turned off and on study sites. */
export type TimerStatus = { show: false } | ({ show: true } & SiteStatus)
