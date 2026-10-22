import browser from 'webextension-polyfill'
import { api } from '../lib/api'
import { domainOf } from '../lib/domain'
import { getQuietSkips } from '../lib/focus'
import { DAY_NAMES, activeQuietRun, quietLengthMinutes, type QuietBlock } from '../lib/schedule'
import { getExcuses, getSettings, saveSettings, type Settings } from '../lib/storage'
import { MINUTE, formatDuration, timeOfDay } from '../lib/time'

const defaultLimit = document.querySelector<HTMLInputElement>('#default-limit')!
const warnBefore = document.querySelector<HTMLInputElement>('#warn-before')!
const allowlist = document.querySelector<HTMLTextAreaElement>('#allowlist')!
const limitsBody = document.querySelector('#limits')!
const saved = document.querySelector<HTMLElement>('#saved')!
const showTimer = document.querySelector<HTMLInputElement>('#show-timer')!
const backendEnabled = document.querySelector<HTMLInputElement>('#backend-enabled')!
const backendUrl = document.querySelector<HTMLInputElement>('#backend-url')!
const backendStatus = document.querySelector<HTMLElement>('#backend-status')!

let settings: Settings

/** Accepts "youtube.com", "www.youtube.com" or a full URL and returns "youtube.com". */
function normalizeDomain(input: string): string | null {
  const value = input.trim().toLowerCase()
  if (!value) return null
  return domainOf(value.includes('://') ? value : `https://${value}`)
}

async function save(): Promise<void> {
  await saveSettings(settings)
  saved.dataset.show = 'true'
  setTimeout(() => (saved.dataset.show = 'false'), 1500)
}

function renderLimits(): void {
  limitsBody.replaceChildren(
    ...Object.entries(settings.limits)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, minutes]) => {
        const tr = document.createElement('tr')
        const name = document.createElement('td')
        name.textContent = domain
        const value = document.createElement('td')
        value.className = 'num'
        value.textContent = `${minutes} min/day`
        const actions = document.createElement('td')
        const remove = document.createElement('button')
        remove.className = 'ghost'
        remove.textContent = 'Remove'
        remove.setAttribute('aria-label', `Remove the limit for ${domain}`)
        remove.addEventListener('click', () => {
          delete settings.limits[domain]
          renderLimits()
          void save()
        })
        actions.append(remove)
        tr.append(name, value, actions)
        return tr
      }),
  )
}

/** Monday first, as most calendars here show the week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const quietList = document.querySelector('#quiet-list')!

/** Ids of the quiet hours running right now, which are locked until they end. */
async function runningQuiet(): Promise<Map<string, number>> {
  const skips = await getQuietSkips()
  const running = new Map<string, number>()
  for (const block of settings.quietHours) {
    const run = activeQuietRun([block], Date.now(), skips)
    if (run) running.set(block.id, run.end)
  }
  return running
}
let runningKey = ''

async function renderQuiet(): Promise<void> {
  const running = await runningQuiet()
  runningKey = [...running.keys()].join()
  quietList.replaceChildren(...settings.quietHours.map((block) => quietRow(block, running.get(block.id))))
}

function quietRow(block: QuietBlock, runningUntil: number | undefined): HTMLLIElement {
  const locked = runningUntil !== undefined
  const li = document.createElement('li')
  li.className = 'quiet-row'
  li.dataset.running = String(locked)

  const days = document.createElement('div')
  days.className = 'days'
  days.setAttribute('role', 'group')
  days.setAttribute('aria-label', 'Days')
  for (const day of WEEK) {
    const label = document.createElement('label')
    label.className = 'day'
    label.title = DAY_NAMES[day]
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = block.days.includes(day)
    box.disabled = locked
    box.setAttribute('aria-label', DAY_NAMES[day])
    box.addEventListener('change', () => {
      block.days = box.checked ? [...block.days, day] : block.days.filter((d) => d !== day)
      void save()
    })
    label.append(box, DAY_NAMES[day][0])
    days.append(label)
  }

  const length = document.createElement('span')
  length.className = 'muted small quiet-length'
  const describeLength = () => {
    const overnight = block.end <= block.start
    length.textContent = `${formatDuration(quietLengthMinutes(block) * MINUTE)}${overnight ? ' · ends next day' : ''}`
  }
  describeLength()

  const times = document.createElement('div')
  times.className = 'times'
  const time = (field: 'start' | 'end', name: string) => {
    const input = document.createElement('input')
    input.type = 'time'
    input.value = block[field]
    input.disabled = locked
    input.required = true
    input.setAttribute('aria-label', name)
    input.addEventListener('change', () => {
      if (!input.value) return
      block[field] = input.value
      describeLength()
      void save()
    })
    return input
  }
  const dash = document.createElement('span')
  dash.className = 'muted'
  dash.textContent = '–'
  times.append(time('start', 'Starts at'), dash, time('end', 'Ends at'))

  const toggle = document.createElement('label')
  toggle.className = 'switch'
  const on = document.createElement('input')
  on.type = 'checkbox'
  on.checked = block.enabled
  on.disabled = locked
  on.setAttribute('aria-label', 'Quiet hours on')
  on.addEventListener('change', () => {
    block.enabled = on.checked
    void save().then(renderQuiet)
  })
  toggle.append(on)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'ghost'
  remove.textContent = 'Remove'
  remove.disabled = locked
  remove.setAttribute('aria-label', 'Remove these quiet hours')
  remove.addEventListener('click', () => {
    settings.quietHours = settings.quietHours.filter((b) => b.id !== block.id)
    void save().then(renderQuiet)
  })

  const top = document.createElement('div')
  top.className = 'quiet-top'
  top.append(days, toggle, remove)
  const when = document.createElement('div')
  when.className = 'quiet-when'
  when.append(times, length)
  li.append(top, when)
  if (locked) {
    const note = document.createElement('span')
    note.className = 'small quiet-running'
    note.textContent = `Running now until ${timeOfDay(runningUntil)}. To stop early, use Skip in the LockedIn popup.`
    li.append(note)
  }
  return li
}

function setBackendStatus(text: string, ok?: boolean): void {
  backendStatus.textContent = text
  if (ok === undefined) delete backendStatus.dataset.ok
  else backendStatus.dataset.ok = String(ok)
}

/** The extension may only talk to servers you've allowed, so ask for this one's address. */
async function requestAccess(url: string): Promise<boolean> {
  return browser.permissions.request({ origins: [`${new URL(url).origin}/*`] })
}

async function testBackend(): Promise<void> {
  setBackendStatus('Checking…')
  try {
    const health = await api.health(settings.backend.url)
    if (!health.database) setBackendStatus('Connected, but the server has no database.', false)
    else if (health.ai === 'ready') setBackendStatus(`Connected. AI ready (${health.model}).`, true)
    else if (health.ai === 'disabled') setBackendStatus('Connected. AI is turned off on the server, so only built-in rules apply.', true)
    else setBackendStatus(`Connected, but the AI isn't ready. Is Ollama running with ${health.model} pulled?`, false)
  } catch {
    setBackendStatus(`Can't reach ${settings.backend.url}. Is the server running?`, false)
  }
}

/** The log starts collapsed to the latest few reasons. */
const COLLAPSED_EXCUSES = 2
let excusesExpanded = false

async function renderExcuses(): Promise<void> {
  const list = document.querySelector('#excuses')!
  const toggle = document.querySelector<HTMLButtonElement>('#excuses-toggle')!
  const excuses = (await getExcuses()).slice(0, 20)
  const hidden = excuses.length - COLLAPSED_EXCUSES
  toggle.hidden = hidden <= 0
  toggle.textContent = excusesExpanded ? 'Show less' : `Show ${hidden} more`
  toggle.setAttribute('aria-expanded', String(excusesExpanded))
  if (excuses.length === 0) {
    const li = document.createElement('li')
    li.className = 'muted small'
    li.textContent = 'None yet. Nice.'
    list.replaceChildren(li)
    return
  }
  const shown = excusesExpanded ? excuses : excuses.slice(0, COLLAPSED_EXCUSES)
  list.replaceChildren(
    ...shown.map((e) => {
      const li = document.createElement('li')
      li.className = e.verdict ?? 'allowed'
      const meta = document.createElement('div')
      meta.className = 'eyebrow'
      meta.textContent = `${new Date(e.ts).toLocaleString()} · ${e.domain} · +${e.minutes} min`
      const text = document.createElement('div')
      text.textContent = `"${e.reason}"`
      li.append(meta, text)
      if (e.verdict) {
        const reply = document.createElement('div')
        reply.className = 'small reply'
        reply.textContent = `${e.verdict === 'allowed' ? 'Allowed' : 'Denied'}${e.reply ? `: ${e.reply}` : ''}`
        li.append(reply)
      }
      return li
    }),
  )
}

async function init(): Promise<void> {
  settings = await getSettings()
  defaultLimit.value = String(settings.defaultLimitMin)
  warnBefore.value = String(settings.warnBeforeMin)
  allowlist.value = settings.allowlist.join('\n')
  showTimer.checked = settings.showTimer
  backendEnabled.checked = settings.backend.enabled
  backendUrl.value = settings.backend.url
  renderLimits()
  await renderQuiet()
  await renderExcuses()
  document.querySelector('#excuses-toggle')!.addEventListener('click', () => {
    excusesExpanded = !excusesExpanded
    void renderExcuses()
  })

  document.querySelector('#quiet-add')!.addEventListener('click', () => {
    settings.quietHours.push({ id: crypto.randomUUID(), days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', enabled: false })
    void save().then(renderQuiet)
  })
  // Lock or unlock rows as quiet hours start and end, without redrawing (and interrupting) rows being edited.
  const recheckRunning = async () => {
    if ([...(await runningQuiet()).keys()].join() !== runningKey) await renderQuiet()
  }
  setInterval(() => void recheckRunning(), 15_000)
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.quietSkips) void recheckRunning()
  })

  defaultLimit.addEventListener('change', () => {
    const value = Number(defaultLimit.value)
    if (value >= 1) {
      settings.defaultLimitMin = value
      void save()
    }
  })

  warnBefore.addEventListener('change', () => {
    const value = Number(warnBefore.value)
    if (value >= 0) {
      settings.warnBeforeMin = value
      void save()
    }
  })

  allowlist.addEventListener('change', () => {
    settings.allowlist = [
      ...new Set(allowlist.value.split('\n').map(normalizeDomain).filter((d) => d !== null)),
    ]
    allowlist.value = settings.allowlist.join('\n')
    void save()
  })

  showTimer.addEventListener('change', () => {
    settings.showTimer = showTimer.checked
    void save()
  })

  backendEnabled.addEventListener('change', async () => {
    if (backendEnabled.checked && !(await requestAccess(settings.backend.url))) {
      backendEnabled.checked = false
      setBackendStatus('LockedIn needs permission to talk to this server.', false)
      return
    }
    settings.backend.enabled = backendEnabled.checked
    await save()
    if (backendEnabled.checked) await testBackend()
    else setBackendStatus('')
  })

  backendUrl.addEventListener('change', async () => {
    let url: URL
    try {
      url = new URL(backendUrl.value.trim())
    } catch {
      setBackendStatus('Enter a full address, like http://localhost:8000', false)
      return
    }
    settings.backend.url = url.origin
    backendUrl.value = url.origin
    // A new server needs its own permission. If it's refused, switch the backend off rather than fail silently.
    if (settings.backend.enabled && !(await requestAccess(url.origin))) {
      settings.backend.enabled = false
      backendEnabled.checked = false
      setBackendStatus('LockedIn needs permission to talk to this server.', false)
    }
    await save()
  })

  document.querySelector('#backend-test')!.addEventListener('click', async () => {
    if (await requestAccess(settings.backend.url)) await testBackend()
    else setBackendStatus('LockedIn needs permission to talk to this server.', false)
  })

  document.querySelector('#add-limit')!.addEventListener('submit', (e) => {
    e.preventDefault()
    const domainInput = document.querySelector<HTMLInputElement>('#limit-domain')!
    const minutesInput = document.querySelector<HTMLInputElement>('#limit-minutes')!
    const domain = normalizeDomain(domainInput.value)
    const minutes = Number(minutesInput.value)
    if (!domain || minutes < 1) return
    settings.limits[domain] = minutes
    domainInput.value = ''
    minutesInput.value = ''
    renderLimits()
    void save()
  })
}

void init()
