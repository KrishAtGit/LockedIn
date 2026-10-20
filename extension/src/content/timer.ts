/**
 * The floating timer drawn on every tracked website. It asks the background script for the real numbers
 * every few seconds and counts down locally in between, so it stays smooth without constant messaging.
 */
import browser from 'webextension-polyfill'
import { aiLabel } from '../lib/labels'
import { clock, fractionLeft, limitState, ringSvg } from '../lib/ring'
import type { TimerStatus } from '../lib/status'
import { formatDuration } from '../lib/time'

const POLL_MS = 10_000
/** Ask more often while the AI is still labelling the page, so the label shows up soon after it's ready. */
const CHECKING_POLL_MS = 2_000
const EDGE_GAP = 16

type Shown = Extract<TimerStatus, { show: true }>
interface Position {
  x: number
  y: number
}

const STYLES = `
  :host { all: initial; }
  .timer {
    --text: #e8e6e1; --muted: #8c8f96; --line: rgba(255, 255, 255, 0.1); --ring-track: rgba(255, 255, 255, 0.12);
    --ring-tick: rgba(255, 255, 255, 0.22); --ring-tick-major: #8c8f96;
    --study: #4fd1bb; --warn: #f0a63a; --over: #f0645a;
    --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    --state: var(--text);
    position: fixed;
    z-index: 2147483647;
    /* Never squeeze to fit the space left near the edge of the screen; the drag code keeps it on screen. */
    width: max-content;
    max-width: 320px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    column-gap: 10px;
    padding: 10px 8px 10px 10px;
    border-radius: 14px;
    background: rgba(14, 15, 17, 0.9);
    border: 1px solid var(--line);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    color: var(--text);
    font: 12px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    cursor: grab;
    user-select: none;
    touch-action: none;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .timer.dragging { cursor: grabbing; }
  .timer.study { --state: var(--study); }
  .timer.warn { --state: var(--warn); }
  .timer.over { --state: var(--over); }

  /* The ring shows what kind of page this is (the AI's label); the numbers show how much time is left. */
  .cat-study { --ring-color: var(--study); }
  .cat-distraction { --ring-color: var(--over); }
  .cat-neutral { --ring-color: var(--muted); }
  .ring { display: block; color: var(--ring-color, var(--state)); overflow: visible; }
  .ring-track { stroke: var(--ring-track); }
  .ring .tick { stroke: var(--ring-tick); }
  .ring .tick-major { stroke: var(--ring-tick-major); }
  .ring-arc { transition: stroke-dashoffset 0.6s ease; }
  @media (prefers-reduced-motion: reduce) { .ring-arc { transition: none; } }

  .body { display: grid; gap: 3px; min-width: 0; }
  .time {
    font: 300 22px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    color: var(--state);
    white-space: nowrap;
  }
  .time.word { font-size: 18px; font-weight: 400; letter-spacing: -0.01em; }
  .time small { font-size: 11px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 6px; }
  .meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .site { color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    font: 600 10px/1 system-ui, -apple-system, 'Segoe UI', sans-serif;
    padding: 3px 6px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted); white-space: nowrap;
  }
  .chip::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .chip[hidden] { display: none; }
  .chip.study { color: var(--study); }
  .chip.distraction { color: var(--over); }
  .chip.offline { color: var(--warn); }

  .timer.collapsed { padding: 6px 6px 6px 7px; column-gap: 7px; border-radius: 999px; }
  .timer.collapsed .meta, .timer.collapsed .detail, .timer.collapsed .time small { display: none; }
  .timer.collapsed .time { font-size: 14px; font-weight: 500; }

  button {
    all: unset;
    align-self: start;
    cursor: pointer;
    width: 20px; height: 20px;
    display: grid; place-items: center;
    border-radius: 6px;
    color: var(--muted);
    font: 14px/1 system-ui, sans-serif;
  }
  .timer.collapsed button { align-self: center; }
  button:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
  button:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
`

const RING_SIZE = 46
const RING_SIZE_COLLAPSED = 22

function build() {
  const host = document.createElement('lockedin-timer')
  // Closed shadow DOM: the page's CSS can't restyle the timer, and the timer's CSS can't leak into the page.
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
    <style>${STYLES}</style>
    <div class="timer">
      <div class="ring-slot"></div>
      <div class="body">
        <span class="time" role="timer"></span>
        <div class="meta"><span class="site"></span><span class="chip" hidden></span></div>
        <span class="detail"></span>
      </div>
      <button class="toggle" type="button" aria-label="Minimise timer">–</button>
    </div>`
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!
  return {
    host,
    box: q<HTMLElement>('.timer'),
    ring: q<HTMLElement>('.ring-slot'),
    site: q<HTMLElement>('.site'),
    chip: q<HTMLElement>('.chip'),
    time: q<HTMLElement>('.time'),
    detail: q<HTMLElement>('.detail'),
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
  let drag: { dx: number; dy: number } | null = null

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

    const { usedMs, limitMs, warnMs, exempt, site } = status
    const left = limitMs - usedMs
    const state = exempt ? 'study' : limitState(usedMs, limitMs, warnMs)
    const category = status.category ? ` cat-${status.category}` : ''
    ui.box.className = `timer ${state}${category}${collapsed ? ' collapsed' : ''}${drag ? ' dragging' : ''}`
    ui.ring.innerHTML = ringSvg(exempt ? 1 : fractionLeft(usedMs, limitMs), {
      size: collapsed ? RING_SIZE_COLLAPSED : RING_SIZE,
      stroke: 3,
      ticks: collapsed ? 0 : 12,
    })
    ui.toggle.textContent = collapsed ? '+' : '–'
    ui.toggle.setAttribute('aria-label', collapsed ? 'Expand timer' : 'Minimise timer')
    ui.site.textContent = site

    const label = aiLabel(status.ai, status.category)
    ui.chip.hidden = !label
    ui.chip.className = `chip ${label?.kind ?? ''}`
    ui.chip.textContent = label?.text ?? ''
    ui.chip.title = label?.detail ?? ''

    ui.time.classList.toggle('word', exempt !== null)
    if (exempt) {
      ui.time.innerHTML = 'Study<small>not counting</small>'
      ui.detail.textContent = `${formatDuration(usedMs)} of ${formatDuration(limitMs)} used today`
    } else {
      ui.time.textContent = clock(left)
      const small = document.createElement('small')
      small.textContent = left > 0 ? 'left' : 'time’s up'
      ui.time.append(small)
      ui.detail.textContent = `${formatDuration(usedMs)} of ${formatDuration(limitMs)} used`
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

  // The background script says when timing starts or stops in this tab, so the countdown resumes right away.
  browser.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string }).type === 'timer-refresh') void refresh()
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
