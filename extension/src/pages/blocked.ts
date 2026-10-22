import browser from 'webextension-polyfill'
import { api } from '../lib/api'
import { domainOf } from '../lib/domain'
import { LOCK_KEYS, getActiveLock, lockFractionLeft, type ActiveLock } from '../lib/focus'
import { ringSvg, setClock } from '../lib/ring'
import { baseLimitMs, getExcuses, getSettings, getTodayUsage, usedMs } from '../lib/storage'
import { MINUTE, formatDuration, timeOfDay, today } from '../lib/time'

const MIN_REASON_LENGTH = 15
/** Each extra request today makes you wait longer before you can ask again. */
const BASE_WAIT_SECONDS = 20
/** How long an approval message stays on screen before going back to the page. */
const APPROVED_PAUSE_MS = 1500

const params = new URLSearchParams(location.search)
const key = params.get('key') ?? ''
const returnUrl = params.get('url') ?? ''
/** 'lock' when blocked by a focus session or quiet hours rather than by the daily limit ('focus' from older versions). */
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

/**
 * Blocked by a focus session or quiet hours: count it down, then go back to the page once it's over, whether it
 * ran out, was ended early from the popup, or quiet hours were skipped.
 */
function showLock(first: ActiveLock): void {
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!
  let lock = first
  $('#hero').className = 'hero lock'
  $('#negotiate').hidden = true
  $('#focus-note').hidden = false

  const describe = () => {
    const focus = lock.kind === 'focus'
    document.title = `${focus ? 'Locked in' : 'Quiet hours'} · LockedIn`
    $('#kicker').textContent = focus ? 'Focus session' : 'Quiet hours'
    $('#title').textContent = focus ? 'You’re locked in' : 'It’s quiet hours'
    $('#summary').textContent = `${key} is blocked until ${timeOfDay(lock.endsAt)}. Close it and get back to it.`
    $('#readout-sub').textContent = focus ? 'locked in' : 'quiet hours'
    $('#focus-note-text').textContent = focus
      ? 'This page opens again by itself when the session ends. To stop early, click LockedIn in the toolbar and choose End session early.'
      : 'This page opens again by itself when quiet hours end. To skip them today, click LockedIn in the toolbar and choose Skip the rest of quiet hours.'
  }
  /** Back to the page if nothing is blocking it any more, or keep counting down whatever is. */
  const recheck = async () => {
    const next = await getActiveLock()
    if (!next) {
      goBack()
      return
    }
    lock = next
    describe()
  }
  const draw = () => {
    const left = lock.endsAt - Date.now()
    if (left <= 0) {
      void recheck()
      return
    }
    setClock($('#readout'), left)
    $('#ring').innerHTML = ringSvg(lockFractionLeft(lock), { size: 176, stroke: 6 })
  }
  describe()
  draw()
  setInterval(draw, 1000)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && LOCK_KEYS.some((k) => changes[k])) void recheck()
  })
}

async function init(): Promise<void> {
  if (mode === 'lock' || mode === 'focus') {
    const lock = await getActiveLock()
    if (lock) showLock(lock)
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
