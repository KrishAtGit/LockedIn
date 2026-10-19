import browser from 'webextension-polyfill'
import { api } from '../lib/api'
import { domainOf } from '../lib/domain'
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

const reason = document.querySelector<HTMLTextAreaElement>('#reason')!
const hint = document.querySelector('#hint')!
const verdict = document.querySelector<HTMLElement>('#verdict')!
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#negotiate button')]

let secondsLeft = 0
let asksToday = 0
let checking = false
let timer: ReturnType<typeof setInterval> | undefined

function updateButtons(): void {
  const longEnough = reason.value.trim().length >= MIN_REASON_LENGTH
  const ready = secondsLeft <= 0 && longEnough && !checking
  buttons.forEach((b) => (b.disabled = !ready))

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
  verdict.textContent = text
  verdict.dataset.allowed = String(allowed)
  verdict.hidden = false
}

function goBack(): void {
  // Only go back to real web pages, never to a URL someone slipped into the query string.
  if (domainOf(returnUrl)) location.replace(returnUrl)
  else history.back()
}

async function init(): Promise<void> {
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
