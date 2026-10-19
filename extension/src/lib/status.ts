import type { Category } from './api'
import type { AiState } from './pages'

/** What the on-page timer shows, as computed by the background script for the tab asking. */
export type TimerStatus =
  | { show: false }
  | {
      show: true
      site: string
      usedMs: number
      limitMs: number
      /** True while this tab's time is being counted right now, so the timer should keep ticking. */
      counting: boolean
      /** Study pages and allowlisted sites don't use up the limit. */
      exempt: 'study-page' | null
      /** How the AI labelled this page, if it has. */
      category: Category | null
      ai: AiState
    }
