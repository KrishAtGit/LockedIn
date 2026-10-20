import browser from 'webextension-polyfill'
import { api } from '../lib/api'
import { domainOf } from '../lib/domain'
import { getExcuses, getSettings, saveSettings, type Settings } from '../lib/storage'

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

async function renderExcuses(): Promise<void> {
  const list = document.querySelector('#excuses')!
  const excuses = (await getExcuses()).slice(0, 20)
  if (excuses.length === 0) {
    const li = document.createElement('li')
    li.className = 'muted small'
    li.textContent = 'None yet. Nice.'
    list.replaceChildren(li)
    return
  }
  list.replaceChildren(
    ...excuses.map((e) => {
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
  await renderExcuses()

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
