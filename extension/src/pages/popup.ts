import browser from 'webextension-polyfill'
import {
  baseLimitMs,
  getDaily,
  getSettings,
  getTodayUsage,
  isAllowlisted,
  limitKey,
  usedMs,
} from '../lib/storage'
import { formatDuration, today } from '../lib/time'

async function render(): Promise<void> {
  const settings = await getSettings()
  const usage = await getTodayUsage()
  const grants = (await getDaily('grants'))[today()] ?? {}

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

  const total = rows.reduce((sum, r) => sum + r.used, 0)
  document.querySelector('#total')!.textContent = `${formatDuration(total)} in the browser`
  document.querySelector<HTMLElement>('#empty')!.hidden = rows.length > 0

  const list = document.querySelector('#list')!
  list.replaceChildren(
    ...rows.map(({ key, used, limit, allowed }) => {
      const li = document.createElement('li')
      const ratio = allowed ? 0 : Math.min(used / limit, 1)
      const state = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : ''

      const row = document.createElement('div')
      row.className = 'row'
      const name = document.createElement('span')
      name.className = 'domain'
      name.textContent = key
      const value = document.createElement('span')
      value.className = 'muted small'
      value.textContent = allowed
        ? formatDuration(used)
        : `${formatDuration(used)} / ${formatDuration(limit)}`
      row.append(name, value)
      li.append(row)

      if (allowed) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = 'Study, no limit'
        li.append(tag)
      } else {
        const bar = document.createElement('div')
        bar.className = `bar ${state}`
        const fill = document.createElement('span')
        fill.style.width = `${ratio * 100}%`
        bar.append(fill)
        li.append(bar)
      }
      return li
    }),
  )
}

document.querySelector('#open-options')!.addEventListener('click', (e) => {
  e.preventDefault()
  void browser.runtime.openOptionsPage()
})

void render()
