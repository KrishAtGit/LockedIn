import browser from 'webextension-polyfill'
import { domainOf } from '../lib/domain'
import { baseLimitMs, getExcuses, getSettings, getTodayUsage, usedMs } from '../lib/storage'
import { formatDuration, today } from '../lib/time'

const MIN_REASON_LENGTH = 15
/** Each extra request today makes you wait longer before you can ask again. */
const BASE_WAIT_SECONDS = 20

const params = new URLSearchParams(location.search)
const key = params.get('key') ?? ''
const returnUrl = params.get('url') ?? ''

const reason = document.querySelector<HTMLTextAreaElement>('#reason')!
const hint = document.querySelector('#hint')!
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#negotiate button')]

let secondsLeft = 0

function updateButtons(): void {
  const longEnough = reason.value.trim().length >= MIN_REASON_LENGTH
  const ready = secondsLeft <= 0 && longEnough
  buttons.forEach((b) => (b.disabled = !ready))

  if (secondsLeft > 0) hint.textContent = `Take a breath. You can ask in ${secondsLeft}s.`
  else if (!longEnough) hint.textContent = `Write at least ${MIN_REASON_LENGTH} characters.`
  else hint.textContent = ''
}

async function init(): Promise<void> {
  const settings = await getSettings()
  const used = usedMs(await getTodayUsage(), key)
  const asksToday = (await getExcuses()).filter(
    (e) => e.domain === key && today(e.ts) === today(),
  ).length

  document.querySelector('#title')!.textContent = `Time's up on ${key}`
  const limit = formatDuration(baseLimitMs(settings, key))
  const asked = asksToday > 0 ? `, and asked for more time ${asksToday}× already.` : '.'
  document.querySelector('#summary')!.textContent =
    `You've spent ${formatDuration(used)} here today (limit ${limit})${asked}`

  // Friction grows with every request so "just 5 more minutes" gets harder each time.
  secondsLeft = BASE_WAIT_SECONDS * (asksToday + 1)
  updateButtons()
  const timer = setInterval(() => {
    secondsLeft -= 1
    updateButtons()
    if (secondsLeft <= 0) clearInterval(timer)
  }, 1000)
}

reason.addEventListener('input', updateButtons)

document.querySelector('#negotiate')!.addEventListener('submit', async (e) => {
  e.preventDefault()
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement
  const minutes = Number(submitter.dataset.minutes)
  await browser.runtime.sendMessage({ type: 'grant', key, minutes, reason: reason.value.trim() })

  // Only go back to real web pages, never to a URL someone slipped into the query string.
  if (domainOf(returnUrl)) location.replace(returnUrl)
  else history.back()
})

document.querySelector('#close')!.addEventListener('click', async () => {
  const tab = await browser.tabs.getCurrent()
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id)
})

void init()
