/**
 * The LockedIn dial: a timer bezel of minute marks (the logo's four cross marks are the long ones) around a
 * progress ring showing how much time is left. Returned as an SVG string so the popup, the blocked page and the
 * on-page timer all draw the same thing.
 *
 * Everything is laid out in real pixels (viewBox = size) with whole-pixel stroke widths and flat line ends,
 * so the ring is a true circle of even thickness at any size. Colours come from CSS: the arc uses
 * `currentColor`, the track `--ring-track` and the marks `--ring-tick`.
 */
export function ringSvg(left: number, { size = 160, stroke = 6, ticks = 60 } = {}): string {
  const fraction = Math.min(Math.max(left, 0), 1)
  const c = size / 2
  const outer = c - 1
  const major = ticks > 0 ? Math.max(4, Math.round(size * 0.075)) : 0
  const minor = Math.max(2, Math.round(major * 0.45))
  const gap = ticks > 0 ? Math.max(3, Math.round(size * 0.04)) : 0
  const r = outer - major - gap - stroke / 2

  const marks: string[] = []
  for (let i = 0; i < ticks; i++) {
    const isMajor = i % (ticks / 4) === 0
    const len = isMajor ? major : minor
    const deg = (360 / ticks) * i
    marks.push(
      `<line class="${isMajor ? 'tick-major' : 'tick'}" x1="${c}" y1="${c - outer}" x2="${c}" y2="${c - outer + len}" transform="rotate(${deg} ${c} ${c})" />`,
    )
  }

  const circumference = 2 * Math.PI * r
  const arc =
    fraction >= 1
      ? // A full ring is a plain circle, so there's no seam where the ends of an arc would meet.
        `<circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="currentColor" stroke-width="${stroke}" />`
      : fraction > 0
        ? `<circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="currentColor" stroke-width="${stroke}"
             stroke-dasharray="${circumference * fraction} ${circumference}" transform="rotate(-90 ${c} ${c})" />`
        : ''

  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="geometricPrecision" aria-hidden="true">
    <g stroke-width="${ticks >= 60 ? 1 : 1.5}" stroke-linecap="butt">${marks.join('')}</g>
    <circle class="ring-track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}" />
    ${arc}
  </svg>`
}

/** Fraction of the limit still left, 0 to 1. */
export function fractionLeft(usedMs: number, limitMs: number): number {
  return limitMs > 0 ? Math.max(0, 1 - usedMs / limitMs) : 0
}

/** "12:34" under an hour, "1h 05m" above it. Used wherever a countdown is shown. */
export function clock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`
}

/** Which colour state a site is in: plenty left, close to the limit, or over it. */
export function limitState(usedMs: number, limitMs: number, warnMs: number): 'ok' | 'warn' | 'over' {
  const left = limitMs - usedMs
  if (left <= 0) return 'over'
  return left <= warnMs ? 'warn' : 'ok'
}

/** A bar made of separate segments, echoing the dial's minute marks. Segments light up as the limit is used. */
export function segmentsHtml(usedFraction: number, count = 12): string {
  const lit = Math.min(count, Math.ceil(Math.min(Math.max(usedFraction, 0), 1) * count - 1e-9))
  return `<span class="segments" aria-hidden="true">${Array.from(
    { length: count },
    (_, i) => `<i${i < lit ? ' class="on"' : ''}></i>`,
  ).join('')}</span>`
}
