import type { Category } from './api'
import type { AiState } from './pages'

export interface Label {
  /** Short text for the chip. */
  text: string
  /** Longer explanation, for tooltips and the popup. */
  detail: string
  /** CSS class: the category, or 'checking' / 'offline'. */
  kind: string
}

const VERDICTS: Record<Category, Omit<Label, 'kind'>> = {
  study: { text: 'Study', detail: 'Study page. Doesn’t count toward your limit.' },
  distraction: { text: 'Distraction', detail: 'Distraction. Counts toward your limit.' },
  neutral: { text: 'Neutral', detail: 'Neither study nor distraction. Counts toward your limit as usual.' },
}

/** The AI's verdict on a page, or why there isn't one. Null when the AI is off. */
export function aiLabel(ai: AiState, category: Category | null): Label | null {
  if (ai === 'labelled' && category) return { ...VERDICTS[category], kind: category }
  if (ai === 'checking') return { text: 'Checking', detail: 'The AI is labelling this page.', kind: 'checking' }
  if (ai === 'offline') {
    return {
      text: 'AI offline',
      detail: 'Can’t reach the backend or Ollama. Start them to label pages. Time counts as usual.',
      kind: 'offline',
    }
  }
  return null
}
