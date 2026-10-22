/** Draws a WeeklyReport into report.html. Kept apart from the data loading so it can be previewed with sample data. */
import { change, type WeeklyReport } from '../lib/report'
import { segmentsHtml } from '../lib/ring'
import { formatDuration, today } from '../lib/time'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

function dateOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const weekday = (key: string) => dateOf(key).toLocaleDateString(undefined, { weekday: 'short' })
const dayLabel = (key: string) => dateOf(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function li(className: string, meta: string, text: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = className
  const top = document.createElement('span')
  top.className = 'eyebrow'
  top.textContent = meta
  const body = document.createElement('span')
  body.textContent = text
  item.append(top, body)
  return item
}

function empty(text: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'empty'
  item.textContent = text
  return item
}

function renderStats(report: WeeklyReport): void {
  $('#stat-counted').textContent = formatDuration(report.countedMs)
  $('#stat-counted-change').textContent = change(report.countedMs, report.previousCountedMs) ?? 'No data from last week yet'
  $('#stat-study').textContent = formatDuration(report.studyMs)
  $('#stat-study-change').textContent = change(report.studyMs, report.previousStudyMs) ?? 'No data from last week yet'
  $('#stat-locked').textContent = formatDuration(report.focus.lockedInMs + report.quiet.lockedInMs)
  $('#stat-asks').textContent = String(report.excuses.total)
  $('#stat-asks-detail').textContent =
    report.excuses.total > 0 ? `${report.excuses.allowed} allowed · ${report.excuses.denied} denied` : 'None this week'
}

function renderChart(report: WeeklyReport): void {
  const chart = $('#chart')
  const total = (d: WeeklyReport['days'][number]) => d.countedMs + d.studyMs
  const max = Math.max(...report.days.map(total))
  $('#chart-max').textContent = max > 0 ? formatDuration(max) : 'Nothing tracked yet'

  const tooltip = document.createElement('div')
  tooltip.id = 'tooltip'
  tooltip.hidden = true

  const last = report.days.length - 1
  const columns = report.days.map((day, i) => {
    const col = document.createElement('button')
    col.type = 'button'
    col.className = 'col'
    col.setAttribute('aria-label', `${dayLabel(day.date)}: ${formatDuration(day.studyMs)} studying, ${formatDuration(day.countedMs)} counted`)
    const stack = document.createElement('div')
    stack.className = 'stack'
    // Heights are a share of the plot area (the column's full height), so the busiest day reaches the max line.
    for (const [cls, ms] of [['study', day.studyMs], ['counted', day.countedMs]] as const) {
      if (ms <= 0) continue
      const seg = document.createElement('i')
      seg.className = cls
      seg.style.height = `${(ms / max) * 162}px`
      stack.append(seg)
    }
    col.append(stack)

    const show = () => {
      tooltip.innerHTML = ''
      const title = document.createElement('b')
      title.textContent = i === last ? `Today, ${dayLabel(day.date)}` : dayLabel(day.date)
      tooltip.append(
        title,
        `Studying ${formatDuration(day.studyMs)}`,
        document.createElement('br'),
        `Counted ${formatDuration(day.countedMs)}`,
      )
      tooltip.hidden = false
      tooltip.style.left = `${col.offsetLeft + col.offsetWidth / 2}px`
      const barTop = col.offsetTop + col.offsetHeight - stack.offsetHeight
      tooltip.style.top = `${Math.max(barTop, 18)}px`
    }
    const hide = () => (tooltip.hidden = true)
    col.addEventListener('pointerenter', show)
    col.addEventListener('pointerleave', hide)
    col.addEventListener('focus', show)
    col.addEventListener('blur', hide)
    return col
  })
  chart.append(...columns, tooltip)

  $('#chart-days').replaceChildren(
    ...report.days.map((day, i) => {
      const cell = document.createElement('div')
      if (i === last) cell.className = 'today'
      cell.textContent = i === last ? 'Today' : weekday(day.date)
      const sub = document.createElement('small')
      sub.textContent = total(day) > 0 ? formatDuration(total(day)) : '–'
      cell.append(sub)
      return cell
    }),
  )

  $('#chart-table').replaceChildren(
    ...report.days.map((day) => {
      const row = document.createElement('tr')
      for (const text of [dayLabel(day.date), formatDuration(day.studyMs), formatDuration(day.countedMs), formatDuration(total(day))]) {
        const cell = document.createElement('td')
        cell.textContent = text
        row.append(cell)
      }
      return row
    }),
  )
}

function renderSites(report: WeeklyReport): void {
  const top = report.topSites[0]?.ms ?? 0
  $('#sites').replaceChildren(
    ...(report.topSites.length === 0
      ? [empty('No counted time this week.')]
      : report.topSites.map(({ site, ms }) => {
          const item = document.createElement('li')
          item.className = 'site'
          const name = document.createElement('span')
          name.className = 'domain'
          name.textContent = site
          const bar = document.createElement('span')
          bar.innerHTML = segmentsHtml(ms / top)
          const value = document.createElement('span')
          value.className = 'num'
          value.textContent = formatDuration(ms)
          item.append(name, bar, value)
          return item
        })),
  )
}

function renderLocks(report: WeeklyReport): void {
  $('#focus-done').textContent = String(report.focus.completed)
  $('#focus-early').textContent = String(report.focus.endedEarly)
  $('#quiet-done').textContent = String(report.quiet.completed)
  $('#quiet-skipped').textContent = String(report.quiet.endedEarly)
  $('#early-reasons').replaceChildren(
    ...report.earlyReasons
      .slice(0, 3)
      .map((r) => li('lock', `${dayLabel(today(r.ts))} · ${r.kind === 'focus' ? 'Ended a session early' : 'Skipped quiet hours'}`, `“${r.reason}”`)),
  )
}

function renderExcuses(report: WeeklyReport): void {
  $('#excuses').replaceChildren(
    ...(report.excuses.recent.length === 0
      ? [empty('You didn’t ask for more time this week.')]
      : report.excuses.recent.map((e) => {
          const verdict = e.verdict ?? 'allowed'
          return li(verdict, `${dayLabel(today(e.ts))} · ${e.domain} · +${e.minutes} min · ${verdict === 'allowed' ? 'Allowed' : 'Denied'}`, `“${e.reason}”`)
        })),
  )
}

export function renderReport(report: WeeklyReport): void {
  const first = report.days[0].date
  const last = report.days[report.days.length - 1].date
  const fmt = (key: string) => dateOf(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  $('#range').textContent = `${fmt(first)} – ${fmt(last)} · Everything here stays on this device.`
  renderStats(report)
  renderChart(report)
  renderSites(report)
  renderLocks(report)
  renderExcuses(report)
}
