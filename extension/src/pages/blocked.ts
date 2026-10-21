import browser from 'webextension-polyfill'
import { api } from '../lib/api'
import { domainOf } from '../lib/domain'
import { getFocus, type FocusSession } from '../lib/focus'
import { clock, ringSvg } from '../lib/ring'
import { baseLimitMs, getExcuses, getSettings, getTodayUsage, usedMs } from '../lib/storage'
import { MINUTE, formatDuration, today } from '../lib/time'

const MIN_REASON_LENGTH = 15
/** Each extra request today makes you wait longer before you can ask again. */
const BASE_WAIT_SECONDS = 20
/** How long an approval message stays on screen before going back to the page. */
const APPROVED_PAUSE_MS = 1500

const params = new URLSearchParams(location.search)
const key = params.get('key') ?? ''
const returnUrl = params.get('url') ?? ''
/** 'focus' when blocked by a focus session rather than by the daily limit. */
const mode = params.get('mode')

const reason = document.querySelector<HTMLTextAreaElement>('#reason')!
const hint = document.querySelector('#hint')!
const verdict = document.querySelector<HTMLElement>('#verdict')!
const count = document.querySelector<HTMLElement>('#count')!
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#negotiate button')]

let secondsLeft = 0
let asksToday = 0
let checking = false
let timer: ReturnType<typeof setInterval> | undefined

function updateButtons(): void {
  const longEnough = reason.value.trim().length >= MIN_REASON_LENGTH
  const ready = secondsLeft <= 0 && longEnough && !checking
  buttons.forEach((b) => (b.disabled = !ready))
  const length = reason.value.trim().length
  count.textContent = `${Math.min(length, MIN_REASON_LENGTH)} / ${MIN_REASON_LENGTH}`
  count.dataset.ready = String(longEnough)

  if (checking) hint.textContent = 'Checking your reason…'
  else if (secondsLeft > 0) hint.textContent = `Take a breath. You can ask in ${secondsLeft}s.`
  else if (!longEnough) hint.textContent = `Write at least ${MIN_REASON_LENGTH} characters.`
  else hint.textContent = ''
}

/** Friction grows with every request, so "just 5 more minutes" gets harder each time. */
function startCountdown(): void {
  clearInterval(timer)
  secondsLeft = BASE_WAIT_SECONDS * (asksToday + 1)
  updateButtons()
  timer = setInterval(() => {
    secondsLeft -= 1
    updateButtons()
    if (secondsLeft <= 0) clearInterval(timer)
  }, 1000)
}

function showVerdict(text: string, allowed: boolean): void {
  document.querySelector('#verdict-title')!.textContent = allowed ? 'Allowed · going back' : 'Not this time'
  document.querySelector('#verdict-text')!.textContent = text
  verdict.dataset.allowed = String(allowed)
  verdict.hidden = false
}

function goBack(): void {
  // Only go back to real web pages, never to a URL someone slipped into the query string.
  if (domainOf(returnUrl)) location.replace(returnUrl)
  else history.back()
}

/** Blocked by a focus session: count the session down, then go back to the page when it's over. */
function showFocus(focus: FocusSession): void {
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!
  document.title = 'Locked in · LockedIn'
  $('#hero').className = 'hero lock'
  $('#kicker').textContent = 'Focus session'
  $('#title').textContent = 'You’re locked in'
  const until = new Date(focus.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  $('#summary').textContent = `${key} is blocked until ${until}. Close it and get back to it.`
  $('#readout-sub').textContent = 'locked in'
  $('#negotiate').hidden = true
  $('#focus-note').hidden = false

  const draw = () => {
    const left = focus.endsAt - Date.now()
    if (left <= 0) {
      goBack()
      return
    }
    $('#readout').textContent = clock(left)
    $('#ring').innerHTML = ringSvg(left / (focus.minutes * MINUTE), { size: 176, stroke: 6 })
  }
  draw()
  setInterval(draw, 1000)
  // Ended early from the popup: go straight back.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.focus && !changes.focus.newValue) goBack()
  })
}

async function init(): Promise<void> {
  if (mode === 'focus') {
    const focus = await getFocus()
    if (focus) showFocus(focus)
    else goBack()
    return
  }
  document.querySelector('#ring')!.innerHTML = ringSvg(0, { size: 176, stroke: 6 })
  const settings = await getSettings()
  const used = usedMs(await getTodayUsage(), key)
  asksToday = (await getExcuses()).filter((e) => e.domain === key && today(e.ts) === today()).length

  document.querySelector('#title')!.textContent = `Time's up on ${key}`
  const limit = formatDuration(baseLimitMs(settings, key))
  const asked = asksToday > 0 ? `, and asked for more time ${asksToday}× already.` : '.'
  document.querySelector('#summary')!.textContent =
    `You've spent ${formatDuration(used)} here today (limit ${limit})${asked}`
  startCountdown()
}

reason.addEventListener('input', updateButtons)

document.querySelector('#negotiate')!.addEventListener('submit', async (e) => {
  e.preventDefault()
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement
  const minutes = Number(submitter.dataset.minutes)
  const text = reason.value.trim()
  const settings = await getSettings()

  // Without the backend, any long-enough reason is accepted, as before.
  if (!settings.backend.enabled) {
    await browser.runtime.sendMessage({ type: 'excuse', key, minutes, reason: text, verdict: 'allowed' })
    goBack()
    return
  }

  checking = true
  verdict.hidden = true
  updateButtons()
  try {
    const result = await api.judge(settings.backend.url, {
      domain: key,
      reason: text,
      minutes,
      asks_today: asksToday,
      used_minutes: Math.floor(usedMs(await getTodayUsage(), key) / MINUTE),
    })
    const outcome = result.allow ? 'allowed' : 'denied'
    await browser.runtime.sendMessage({ type: 'excuse', key, minutes, reason: text, verdict: outcome, reply: result.message })
    showVerdict(result.message, result.allow)

    if (result.allow) {
      setTimeout(goBack, APPROVED_PAUSE_MS)
      return
    }
    asksToday += 1
    startCountdown()
  } catch {
    // The backend is unreachable. Don't trap anyone behind a server outage: accept the reason.
    await browser.runtime.sendMessage({ type: 'excuse', key, minutes, reason: text, verdict: 'allowed' })
    showVerdict("Couldn't reach the AI to check your reason, so it's accepted this time.", true)
    setTimeout(goBack, APPROVED_PAUSE_MS)
  } finally {
    checking = false
    updateButtons()
  }
})

document.querySelector('#close')!.addEventListener('click', async () => {
  const tab = await browser.tabs.getCurrent()
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id)
})

void init()
