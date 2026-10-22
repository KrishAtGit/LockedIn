import browser from 'webextension-polyfill'
import {
  END_EARLY_WAIT_SECONDS,
  FOCUS_LENGTHS,
  LOCK_KEYS,
  MIN_END_REASON_LENGTH,
  getActiveLock,
  lockFractionLeft,
  type ActiveLock,
} from '../lib/focus'
import { aiLabel } from '../lib/labels'
import { fractionLeft, limitState, ringSvg, segmentsHtml, setClock } from '../lib/ring'
import type { SiteStatus } from '../lib/status'
import {
  baseLimitMs,
  getDaily,
  getSettings,
  getTodayUsage,
  isAllowlisted,
  limitKey,
  usedMs,
} from '../lib/storage'
import { MINUTE, formatDuration, timeOfDay, today } from '../lib/time'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

/** Today's totals and one row per site. */
async function renderToday(): Promise<void> {
  const settings = await getSettings()
  const usage = await getTodayUsage()
  const grants = (await getDaily('grants'))[today()] ?? {}
  const study = Object.values((await getDaily('study'))[today()] ?? {}).reduce((a, b) => a + b, 0)
  const warnMs = settings.warnBeforeMin * MINUTE

  // Group domains under their limit key so youtube.com and m.youtube.com show as one row.
  const keys = [...new Set(Object.keys(usage).map((d) => limitKey(settings, d)))]
  const rows = keys
    .map((key) => ({
      key,
      used: usedMs(usage, key),
      limit: baseLimitMs(settings, key) + (grants[key] ?? 0),
      allowed: isAllowlisted(settings, key),
    }))
    .sort((a, b) => b.used - a.used)

  $('#total-counted').textContent = formatDuration(rows.filter((r) => !r.allowed).reduce((s, r) => s + r.used, 0))
  $('#total-study').textContent = formatDuration(study + rows.filter((r) => r.allowed).reduce((s, r) => s + r.used, 0))
  $('#empty').hidden = rows.length > 0

  $('#list').replaceChildren(
    ...rows.map(({ key, used, limit, allowed }) => {
      const li = document.createElement('li')
      li.className = allowed ? 'study' : limitState(used, limit, warnMs)
      li.title = allowed ? `${key} is on your study list, so it's never limited` : `${key}: ${formatDuration(used)} of ${formatDuration(limit)}`

      const name = document.createElement('span')
      name.className = 'domain'
      name.textContent = key
      const bar = document.createElement('span')
      // Study sites have no limit, so their bar is shown full in the study colour.
      bar.innerHTML = segmentsHtml(allowed ? 1 : used / limit)
      const value = document.createElement('span')
      value.className = 'num'
      value.textContent = allowed ? formatDuration(used) : `${formatDuration(used)}/${formatDuration(limit)}`
      li.append(name, bar, value)
      return li
    }),
  )
}

/** The ring for the site in the current tab. */
function renderSite(status: SiteStatus): void {
  const section = $('#now')
  const free = status.allowlisted || status.exempt !== null
  const left = status.limitMs - status.usedMs
  const state = free ? 'study' : limitState(status.usedMs, status.limitMs, status.warnMs)
  const category = status.allowlisted ? 'study' : status.category
  section.className = category ? `${state} cat-${category}` : state
  section.hidden = false

  $('#now-ring').innerHTML = ringSvg(free ? 1 : fractionLeft(status.usedMs, status.limitMs), { size: 176, stroke: 6 })
  // Words ("Study", "Free") are set smaller than the countdown so they always fit inside the ring.
  $('#now-time').classList.toggle('word', free)
  $('#now-time').classList.remove('long')

  if (status.allowlisted) {
    $('#now-time').textContent = 'Free'
    $('#now-sub').textContent = 'study site'
    $('#now-detail').textContent = 'On your study list, so it’s never limited.'
  } else if (status.exempt) {
    $('#now-time').textContent = 'Study'
    $('#now-sub').textContent = 'not counting'
    $('#now-detail').textContent = `${formatDuration(status.usedMs)} of ${formatDuration(status.limitMs)} used today`
  } else {
    setClock($('#now-time'), left)
    $('#now-sub').textContent = left > 0 ? 'left' : 'time’s up'
    $('#now-detail').textContent = `${formatDuration(status.usedMs)} of ${formatDuration(status.limitMs)} used today`
  }
  renderSiteMeta(status)
}

/** During a focus session or quiet hours the dial counts down the lock instead of the site's limit. */
function renderLockDial(lock: ActiveLock, status: SiteStatus | null): void {
  const section = $('#now')
  section.className = 'lock cat-lock'
  section.hidden = false
  $('#now-ring').innerHTML = ringSvg(lockFractionLeft(lock), { size: 176, stroke: 6 })
  $('#now-time').classList.remove('word')
  setClock($('#now-time'), lock.endsAt - Date.now())
  $('#now-sub').textContent = lock.kind === 'focus' ? 'locked in' : 'quiet hours'
  $('#now-detail').textContent = `Distractions blocked until ${timeOfDay(lock.endsAt)}`
  if (status) renderSiteMeta(status)
  else {
    $('#now-site').textContent = lock.kind === 'focus' ? 'Focus session' : 'Quiet hours'
    $('#now-chip').hidden = true
  }
}

function renderSiteMeta(status: SiteStatus): void {
  $('#now-site').textContent = status.site
  $('#now-site').title = status.site
  const label = status.allowlisted ? null : aiLabel(status.ai, status.category)
  const chip = $('#now-chip')
  chip.hidden = !label
  if (label) {
    chip.className = `chip ${label.kind}`
    chip.textContent = label.text
    chip.title = label.detail
  }
}

let status: SiteStatus | null = null
let lock: ActiveLock | null = null

async function refreshLock(): Promise<void> {
  lock = await getActiveLock()
  render()
}

function render(): void {
  if (lock && lock.endsAt <= Date.now()) {
    // Quiet hours can roll straight into another block, so ask rather than assume it's over.
    lock = null
    void refreshLock()
  }
  if (lock) renderLockDial(lock, status)
  else if (status) renderSite(status)
  else $('#now').hidden = true

  // Already locked in during quiet hours, so there's no session to start.
  $('#focus-start').hidden = lock !== null
  $('#focus-active').hidden = lock === null
  if (lock) {
    $('#end-early').textContent = lock.kind === 'focus' ? 'End session early' : 'Skip the rest of quiet hours'
    endButton.textContent = lock.kind === 'focus' ? 'End session' : 'Skip quiet hours'
  }
}

// ---- Ending a session early (or skipping quiet hours): write why, then wait. ----

const endForm = $<HTMLFormElement>('#end-form')
const endReason = $<HTMLTextAreaElement>('#end-reason')
const endButton = $<HTMLButtonElement>('#end-confirm')
let endWait = 0

function updateEndButton(): void {
  const length = endReason.value.trim().length
  endButton.disabled = endWait > 0 || length < MIN_END_REASON_LENGTH
  $('#end-hint').textContent =
    endWait > 0
      ? `You can end it in ${endWait}s.`
      : length < MIN_END_REASON_LENGTH
        ? `Write at least ${MIN_END_REASON_LENGTH} characters (${length}/${MIN_END_REASON_LENGTH}).`
        : ''
}

$('#end-early').addEventListener('click', () => {
  $('#end-early').hidden = true
  endForm.hidden = false
  endReason.focus()
  endWait = END_EARLY_WAIT_SECONDS
  updateEndButton()
  const timer = setInterval(() => {
    endWait -= 1
    updateEndButton()
    if (endWait <= 0) clearInterval(timer)
  }, 1000)
})

endReason.addEventListener('input', updateEndButton)

endForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!lock) return
  const type = lock.kind === 'focus' ? 'focus-end-early' : 'quiet-skip'
  await browser.runtime.sendMessage({ type, reason: endReason.value.trim() })
  window.close()
})

$('#focus-lengths').replaceChildren(
  ...FOCUS_LENGTHS.map((minutes) => {
    const button = document.createElement('button')
    button.innerHTML = `<span class="readout">${minutes}</span> min`
    button.setAttribute('aria-label', `Lock in for ${minutes} minutes`)
    button.addEventListener('click', async () => {
      await browser.runtime.sendMessage({ type: 'focus-start', minutes })
      window.close()
    })
    return button
  }),
)

// A session can end (or start in another window) while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LOCK_KEYS.some((key) => changes[key])) void refreshLock()
})

async function init(): Promise<void> {
  $('#date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  void renderToday()

  lock = await getActiveLock()
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (tab?.id !== undefined) {
    status = (await browser.runtime.sendMessage({ type: 'site-status', tabId: tab.id })) as SiteStatus | null
  }
  render()

  // Keep counting down while the popup is open.
  setInterval(() => {
    if (status?.counting && !status.exempt && !status.allowlisted) status.usedMs += 1000
    render()
  }, 1000)
}

$('#open-options').addEventListener('click', () => void browser.runtime.openOptionsPage())
$('#open-report').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('pages/report.html') })
  window.close()
})

void init()
