/**
 * The floating timer drawn on every tracked website. It asks the background script for the real numbers
 * every few seconds and counts down locally in between, so it stays smooth without constant messaging.
 */
import browser from 'webextension-polyfill'
import type { TimerStatus } from '../lib/status'
import type { AiState } from '../lib/pages'
import type { Category } from '../lib/api'
import { formatDuration } from '../lib/time'

const POLL_MS = 10_000
/** Ask more often while the AI is still labelling the page, so the label shows up soon after it's ready. */
const CHECKING_POLL_MS = 2_000
const EDGE_GAP = 16
const WARN_RATIO = 0.8

type Shown = Extract<TimerStatus, { show: true }>
interface Position {
  x: number
  y: number
}

const STYLES = `
  :host { all: initial; }
  .timer {
    position: fixed;
    z-index: 2147483647;
    min-width: 168px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(19, 19, 23, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    color: #ececf1;
    font: 13px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif;
    cursor: grab;
    user-select: none;
    touch-action: none;
    backdrop-filter: blur(8px);
  }
  .timer.dragging { cursor: grabbing; }
  .timer.collapsed { min-width: 0; padding: 6px 10px; }
  .timer.collapsed .site, .timer.collapsed .tag, .timer.collapsed .detail, .timer.collapsed .bar { display: none; }
  .top { display: flex; align-items: center; gap: 8px; }
  .site { color: #9a9aa6; font-size: 11px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag {
    font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
    padding: 1px 6px; border-radius: 999px;
    color: #9a9aa6; background: rgba(255, 255, 255, 0.08);
    white-space: nowrap;
  }
  .tag[hidden] { display: none; }
  .tag.study { color: #4ade80; background: rgba(34, 197, 94, 0.15); }
  .tag.distraction { color: #f87171; background: rgba(239, 68, 68, 0.15); }
  .tag.offline { color: #fbbf24; background: rgba(245, 158, 11, 0.15); }
  .top .toggle { margin-left: auto; }
  .time { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .timer.collapsed .time { font-size: 14px; }
  .detail { color: #9a9aa6; font-size: 11px; margin-top: 2px; }
  .bar { height: 4px; margin-top: 8px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
  .bar > span { display: block; height: 100%; background: #22c55e; }
  .timer.warn .bar > span { background: #f59e0b; }
  .timer.warn .time { color: #fbbf24; }
  .timer.over .bar > span { background: #ef4444; }
  .timer.over .time { color: #f87171; }
  .timer.exempt .time { color: #4ade80; font-size: 15px; }
  button {
    all: unset;
    cursor: pointer;
    width: 18px; height: 18px;
    display: grid; place-items: center;
    border-radius: 5px;
    color: #9a9aa6;
    font-size: 14px; line-height: 1;
  }
  button:hover { background: rgba(255, 255, 255, 0.1); color: #ececf1; }
  button:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
`

/** "12:34" under an hour, "1h 05m" above it. */
function clock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`
}

const TAGS: Record<Category, { text: string; title: string }> = {
  study: { text: 'Study', title: 'The AI says this page is study. It doesn’t count toward your limit.' },
  distraction: { text: 'Distraction', title: 'The AI says this page is a distraction. It counts toward your limit.' },
  neutral: { text: 'Neutral', title: 'The AI says this page is neither. It counts toward your limit as usual.' },
}

/** The small label next to the site name: the AI's verdict, or why there isn't one yet. */
function tagFor(ai: AiState, category: Category | null): { text: string; title: string; kind: string } | null {
  if (ai === 'labelled' && category) return { ...TAGS[category], kind: category }
  if (ai === 'checking') return { text: 'Checking…', title: 'The AI is labelling this page.', kind: 'checking' }
  if (ai === 'offline') {
    return { text: 'AI offline', title: 'Can’t reach the LockedIn backend or Ollama. Time counts as usual.', kind: 'offline' }
  }
  return null
}

function build() {
  const host = document.createElement('lockedin-timer')
  // Closed shadow DOM: the page's CSS can't restyle the timer, and the timer's CSS can't leak into the page.
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
    <style>${STYLES}</style>
    <div class="timer" part="timer">
      <div class="top">
        <span class="site"></span>
        <span class="tag" hidden></span>
        <button class="toggle" type="button" aria-label="Minimise timer">–</button>
      </div>
      <div class="row"><span class="time" role="timer"></span></div>
      <div class="detail"></div>
      <div class="bar"><span></span></div>
    </div>`
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!
  return {
    host,
    box: q<HTMLElement>('.timer'),
    site: q<HTMLElement>('.site'),
    tag: q<HTMLElement>('.tag'),
    time: q<HTMLElement>('.time'),
    detail: q<HTMLElement>('.detail'),
    fill: q<HTMLElement>('.bar > span'),
    toggle: q<HTMLButtonElement>('.toggle'),
  }
}

async function main(): Promise<void> {
  // Only the top page gets a timer, not every embedded iframe.
  if (window.top !== window) return

  const ui = build()
  let status: Shown | null = null
  let lastUrl = location.href
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const stored = await browser.storage.local.get(['timerPosition', 'timerCollapsed'])
  let position = stored.timerPosition as Position | undefined
  let collapsed = Boolean(stored.timerCollapsed)

  function clamp(pos: Position): Position {
    const { width, height } = ui.box.getBoundingClientRect()
    return {
      x: Math.min(Math.max(pos.x, 0), Math.max(0, window.innerWidth - width)),
      y: Math.min(Math.max(pos.y, 0), Math.max(0, window.innerHeight - height)),
    }
  }

  function place(): void {
    const { width } = ui.box.getBoundingClientRect()
    const pos = clamp(position ?? { x: window.innerWidth - width - EDGE_GAP, y: EDGE_GAP })
    ui.box.style.left = `${pos.x}px`
    ui.box.style.top = `${pos.y}px`
  }

  function render(): void {
    if (!status) {
      ui.host.remove()
      return
    }
    if (!ui.host.isConnected) {
      document.documentElement.append(ui.host)
      place()
    }

    const { usedMs, limitMs, exempt, site } = status
    const ratio = limitMs > 0 ? usedMs / limitMs : 1
    ui.box.classList.toggle('collapsed', collapsed)
    ui.box.classList.toggle('exempt', exempt !== null)
    ui.box.classList.toggle('warn', !exempt && ratio >= WARN_RATIO && ratio < 1)
    ui.box.classList.toggle('over', !exempt && ratio >= 1)
    ui.toggle.textContent = collapsed ? '+' : '–'
    ui.toggle.setAttribute('aria-label', collapsed ? 'Expand timer' : 'Minimise timer')
    ui.site.textContent = site

    const tag = tagFor(status.ai, status.category)
    ui.tag.hidden = !tag
    ui.tag.className = `tag ${tag?.kind ?? ''}`
    ui.tag.textContent = tag?.text ?? ''
    ui.tag.title = tag?.title ?? ''

    if (exempt) {
      ui.time.textContent = collapsed ? 'Study' : 'Study page'
      ui.detail.textContent = 'Not counting toward your limit'
      ui.fill.style.width = '0%'
    } else {
      ui.time.textContent = collapsed ? clock(limitMs - usedMs) : `${clock(limitMs - usedMs)} left`
      ui.detail.textContent = `${formatDuration(usedMs)} of ${formatDuration(limitMs)} used today`
      ui.fill.style.width = `${Math.min(ratio, 1) * 100}%`
    }
  }

  async function refresh(): Promise<void> {
    clearTimeout(pollTimer)
    try {
      const next = (await browser.runtime.sendMessage({ type: 'timer-status' })) as TimerStatus
      status = next.show ? next : null
      render()
    } catch {
      // The extension was reloaded or removed, which leaves this script orphaned. Clean up and stop.
      ui.host.remove()
      clearInterval(ticker)
      return
    }
    pollTimer = setTimeout(() => void refresh(), status?.ai === 'checking' ? CHECKING_POLL_MS : POLL_MS)
  }

  // Count down locally between polls while this tab is being timed.
  const ticker = setInterval(() => {
    if (location.href !== lastUrl) {
      // Single-page sites (YouTube, Reddit) change pages without reloading, so ask again for the new page.
      lastUrl = location.href
      void refresh()
      return
    }
    if (status?.counting && !status.exempt && document.visibilityState === 'visible') {
      status.usedMs += 1000
      render()
    }
  }, 1000)

  // Dragging: move with the pointer, then remember where it was dropped.
  let drag: { dx: number; dy: number } | null = null
  ui.box.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button') || e.button !== 0) return
    const rect = ui.box.getBoundingClientRect()
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    ui.box.setPointerCapture(e.pointerId)
    ui.box.classList.add('dragging')
  })
  ui.box.addEventListener('pointermove', (e) => {
    if (!drag) return
    position = clamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy })
    ui.box.style.left = `${position.x}px`
    ui.box.style.top = `${position.y}px`
  })
  const endDrag = () => {
    if (!drag) return
    drag = null
    ui.box.classList.remove('dragging')
    void browser.storage.local.set({ timerPosition: position })
  }
  ui.box.addEventListener('pointerup', endDrag)
  ui.box.addEventListener('pointercancel', endDrag)

  ui.toggle.addEventListener('click', () => {
    collapsed = !collapsed
    void browser.storage.local.set({ timerCollapsed: collapsed })
    render()
    place()
  })

  window.addEventListener('resize', () => ui.host.isConnected && place())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refresh())
  window.addEventListener('focus', () => void refresh())

  // Keep the timer in the same place (and in the same state) across every tab when it's moved or toggled.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes.timerPosition && !drag) {
      position = changes.timerPosition.newValue as Position
      if (ui.host.isConnected) place()
    }
    if (changes.timerCollapsed) {
      collapsed = Boolean(changes.timerCollapsed.newValue)
      render()
    }
    if (changes.settings || changes.grants) void refresh()
  })

  await refresh()
}

void main()
