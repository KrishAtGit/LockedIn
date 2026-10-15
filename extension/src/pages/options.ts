import { domainOf } from '../lib/domain'
import { getExcuses, getSettings, saveSettings, type Settings } from '../lib/storage'

const defaultLimit = document.querySelector<HTMLInputElement>('#default-limit')!
const warnBefore = document.querySelector<HTMLInputElement>('#warn-before')!
const allowlist = document.querySelector<HTMLTextAreaElement>('#allowlist')!
const limitsBody = document.querySelector('#limits')!
const saved = document.querySelector('#saved')!

let settings: Settings

/** Accepts "youtube.com", "www.youtube.com" or a full URL and returns "youtube.com". */
function normalizeDomain(input: string): string | null {
  const value = input.trim().toLowerCase()
  if (!value) return null
  return domainOf(value.includes('://') ? value : `https://${value}`)
}

async function save(): Promise<void> {
  await saveSettings(settings)
  saved.textContent = 'Saved'
  setTimeout(() => (saved.textContent = ''), 1500)
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
        value.className = 'muted'
        value.textContent = `${minutes} min/day`
        const actions = document.createElement('td')
        const remove = document.createElement('button')
        remove.textContent = 'Remove'
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
      const meta = document.createElement('div')
      meta.className = 'muted small'
      meta.textContent = `${new Date(e.ts).toLocaleString()} · ${e.domain} · +${e.minutes} min`
      const text = document.createElement('div')
      text.textContent = `"${e.reason}"`
      li.append(meta, text)
      return li
    }),
  )
}

async function init(): Promise<void> {
  settings = await getSettings()
  defaultLimit.value = String(settings.defaultLimitMin)
  warnBefore.value = String(settings.warnBeforeMin)
  allowlist.value = settings.allowlist.join('\n')
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
