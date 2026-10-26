import browser from 'webextension-polyfill'
import { api } from './lib/api'
import {
  addFocusRecord,
  blockedDuringFocus,
  getActiveLock,
  getFocus,
  getQuietSkips,
  type FocusSession,
} from './lib/focus'
import {
  aiState,
  getVerdict,
  pageInfo,
  saveVerdict,
  setBackendState,
  titleIsPlaceholder,
  type PageInfo,
} from './lib/pages'
import { activeQuietRun, nextQuietChange, type QuietRun } from './lib/schedule'
import {
  baseLimitMs,
  getDaily,
  getExcuses,
  getSettings,
  isAllowlisted,
  limitKey,
  pruneOldDays,
  usedMs,
  type Excuse,
} from './lib/storage'
import type { SiteStatus, TimerStatus } from './lib/status'
import { MINUTE, formatDuration, timeOfDay, today } from './lib/time'

/** The tab currently being timed. Kept in session storage because the service worker can be killed at any time. */
interface Session {
  domain: string
  /** Which page, so time can be filed as study or not once its verdict is known. */
  pageKey: string
  tabId: number
  start: number
}

const TICK_ALARM = 'tick'
const FOCUS_ALARM = 'focus-end'
/** Fires when quiet hours next start or end. */
const QUIET_ALARM = 'quiet-change'
const PRUNE_ALARM = 'prune'
const IDLE_SECONDS = 60
/** Gaps longer than this between commits mean the machine slept or the worker was suspended, so they're not counted. */
const MAX_COMMIT_GAP = 2 * MINUTE
const MAX_EXCUSES = 200

// Every storage read-modify-write goes through this queue so overlapping events can't lose updates.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch((err) => console.error('[LockedIn]', err))
  return run
}

async function getSession(): Promise<Session | null> {
  const { session } = await browser.storage.session.get('session')
  return (session as Session | undefined) ?? null
}

async function setSession(session: Session | null): Promise<void> {
  await browser.storage.session.set({ session })
}

async function isStudyPage(pageKey: string): Promise<boolean> {
  return (await getVerdict(pageKey))?.category === 'study'
}

/**
 * Adds the time since the session started to today's totals and restarts the session clock.
 * Time on study pages goes to a separate total that doesn't count toward limits.
 */
async function commit(now: number): Promise<void> {
  const session = await getSession()
  if (!session) return

  const elapsed = Math.min(now - session.start, MAX_COMMIT_GAP)
  if (elapsed > 0) {
    const bucket = (await isStudyPage(session.pageKey)) ? 'study' : 'usage'
    const totals = await getDaily(bucket)
    const day = (totals[today(now)] ??= {})
    day[session.domain] = (day[session.domain] ?? 0) + elapsed
    await browser.storage.local.set({ [bucket]: totals })
  }
  await setSession({ ...session, start: now })
}

interface Target {
  page: PageInfo
  tabId: number
  url: string
}

/**
 * The tab that should be counted right now: the active tab of the focused window while the user is active.
 * An audible tab (a lecture video, or Netflix) keeps counting even when the user isn't touching the keyboard.
 */
async function currentTarget(): Promise<Target | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  const page = pageInfo(tab?.url, tab?.title)
  if (!tab?.id || !page) return null

  const win = await browser.windows.getLastFocused()
  const idle = await browser.idle.queryState(IDLE_SECONDS)
  const engaged = win.focused && idle === 'active'
  return engaged || tab.audible ? { page, tabId: tab.id, url: tab.url! } : null
}

// Pages currently being classified, so a burst of tab events doesn't send the same request five times.
const classifying = new Set<string>()
// Pages titled with just the site name that were already sent once, so they aren't asked about on every tick.
const askedPlaceholders = new Set<string>()
// Pages a server without AI had no rule for. Asking again would get the same answer.
const unlabelled = new Set<string>()

/** Asks the backend about a page in the background, then re-checks limits once the answer is in. */
async function classify(page: PageInfo): Promise<void> {
  const settings = await getSettings()
  if (!settings.backend.enabled || classifying.has(page.key)) return
  if (askedPlaceholders.has(page.key) || unlabelled.has(page.key)) return
  if (await getVerdict(page.key)) return
  const placeholder = titleIsPlaceholder(page)

  classifying.add(page.key)
  try {
    const result = await api.classify(settings.backend.url, {
      domain: page.domain,
      path: page.path,
      title: page.title,
    })
    if (result.source === 'fallback') {
      // The server couldn't decide. If its AI is switched off, that's its final answer; if the AI is down, it
      // isn't, so the page is retried later.
      const noAi = (await api.health(settings.backend.url)).ai === 'disabled'
      await setBackendState(noAi ? 'no-ai' : 'down')
      if (noAi) unlabelled.add(page.key)
      return
    }
    await setBackendState('ok')
    // A title like "Instagram" (or "YouTube" while a video loads) says nothing about the page itself, so only
    // a verdict about the whole site is worth keeping. The real title gets its own verdict once it arrives.
    if (placeholder) askedPlaceholders.add(page.key)
    if (!placeholder || result.source === 'rules') {
      await serial(() => saveVerdict(page.key, { category: result.category, reason: result.reason }))
      void tick()
    }
  } catch (err) {
    await setBackendState('down')
    console.warn('[LockedIn] Could not classify page:', err)
  } finally {
    classifying.delete(page.key)
  }
}

/** How long an over-limit page may stay open while waiting to hear whether it's a study page. */
const VERDICT_GRACE_MS = 15_000
const graceStarted = new Map<string, number>()

/**
 * True while a page that's over its limit is still waiting for its verdict, so a lecture isn't blocked in the
 * second before the AI says it's a lecture. If no verdict arrives in time (backend down), the page is blocked.
 */
function waitingForVerdict(pageKey: string): boolean {
  const now = Date.now()
  if (!graceStarted.has(pageKey)) {
    graceStarted.set(pageKey, now)
    // Re-check once the grace period ends, in case no verdict ever arrives.
    setTimeout(() => void tick(), VERDICT_GRACE_MS + 500)
  }
  return now - graceStarted.get(pageKey)! < VERDICT_GRACE_MS
}

/** Warns when a limit is close and sends the tab to the "negotiate" page once it's reached. */
async function enforce(target: Target): Promise<boolean> {
  const settings = await getSettings()
  const { domain } = target.page
  if (isAllowlisted(settings, domain) || (await isStudyPage(target.page.key))) return false

  // During a focus session or quiet hours distractions are blocked outright, whatever time is left on their limit.
  if (await getActiveLock()) {
    const verdict = await getVerdict(target.page.key)
    if (blockedDuringFocus(settings, target.page, verdict)) {
      // Give the AI a moment first, so a lecture on YouTube isn't blocked before it's recognised as study.
      if (settings.backend.enabled && !verdict && waitingForVerdict(target.page.key)) return false
      const params = new URLSearchParams({ mode: 'lock', key: limitKey(settings, domain), url: target.url })
      await browser.tabs.update(target.tabId, { url: browser.runtime.getURL(`pages/blocked.html?${params}`) })
      return true
    }
  }

  const day = today()
  const key = limitKey(settings, domain)
  const usage = await getDaily('usage')
  const grants = await getDaily('grants')
  const limit = baseLimitMs(settings, key) + (grants[day]?.[key] ?? 0)
  const remaining = limit - usedMs(usage[day] ?? {}, key)

  if (remaining <= 0) {
    if (settings.backend.enabled && !(await getVerdict(target.page.key)) && waitingForVerdict(target.page.key)) {
      return false
    }
    const params = new URLSearchParams({ key, url: target.url })
    await browser.tabs.update(target.tabId, {
      url: browser.runtime.getURL(`pages/blocked.html?${params}`),
    })
    return true
  }

  if (remaining <= settings.warnBeforeMin * MINUTE) {
    // Remember which limit we warned about, so extra granted time gets its own warning.
    const { warned = {} } = (await browser.storage.local.get('warned')) as {
      warned?: Record<string, Record<string, number>>
    }
    if (warned[day]?.[key] !== limit) {
      await browser.notifications.create(`warn-${key}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('icons/icon-128.png'),
        title: `${formatDuration(remaining)} left on ${key}`,
        message: 'Wrap up what you are doing. LockedIn will step in when time runs out.',
      })
      warned[day] = { ...warned[day], [key]: limit }
      await browser.storage.local.set({ warned: { [day]: warned[day] } })
    }
  }
  return false
}

/** Commits time to the previous tab, then starts timing whatever should be counted now. */
function tick(): Promise<void> {
  return serial(async () => {
    const now = Date.now()
    const before = await getSession()
    await commit(now)

    const target = await currentTarget()
    if (target) void classify(target.page)
    const blocked = target !== null && (await enforce(target))
    const after: Session | null =
      target && !blocked
        ? { domain: target.page.domain, pageKey: target.page.key, tabId: target.tabId, start: now }
        : null
    await setSession(after)
    if (before?.tabId !== after?.tabId || before?.pageKey !== after?.pageKey) {
      notifyTimers(before?.tabId, after?.tabId)
    }
  })
}

/**
 * Tells the floating timers in these tabs to fetch their status again, because timing just started or stopped
 * there. Without this, a timer that asked a moment too early would think it's paused until its next poll.
 */
function notifyTimers(...tabIds: (number | undefined)[]): void {
  for (const tabId of new Set(tabIds)) {
    if (tabId === undefined) continue
    // Tabs without the timer (browser pages, the blocked page) have nothing listening, which is fine.
    browser.tabs.sendMessage(tabId, { type: 'timer-refresh' }).catch(() => {})
  }
}

function logExcuse(excuse: Excuse, grantMinutes: number): Promise<void> {
  return serial(async () => {
    const update: Record<string, unknown> = {
      excuses: [excuse, ...(await getExcuses())].slice(0, MAX_EXCUSES),
    }
    if (grantMinutes > 0) {
      const day = today()
      const grants = await getDaily('grants')
      grants[day] = { ...grants[day], [excuse.domain]: (grants[day]?.[excuse.domain] ?? 0) + grantMinutes * MINUTE }
      update.grants = grants
    }
    await browser.storage.local.set(update)
  })
}

function startFocus(minutes: number): Promise<void> {
  return serial(async () => {
    const now = Date.now()
    const focus: FocusSession = { startedAt: now, endsAt: now + minutes * MINUTE, minutes }
    await browser.storage.local.set({ focus })
    await browser.alarms.create(FOCUS_ALARM, { when: focus.endsAt })
  }).then(tick)
}

/** Ends the current session early, keeping the reason for the weekly report. */
function endFocusEarly(reason: string): Promise<void> {
  return serial(async () => {
    const focus = await getFocus()
    if (!focus) return
    await addFocusRecord({
      startedAt: focus.startedAt,
      minutes: focus.minutes,
      focusedMs: Date.now() - focus.startedAt,
      kind: 'focus',
      completed: false,
      reason,
    })
    await browser.storage.local.set({ focus: null })
    await browser.alarms.clear(FOCUS_ALARM)
  })
}

/**
 * Records a session whose time is up. Also runs at startup, in case the browser was closed when the session
 * ended and the alarm never fired.
 */
function settleFinishedFocus(): Promise<void> {
  return serial(async () => {
    const { focus } = (await browser.storage.local.get('focus')) as { focus?: FocusSession | null }
    if (!focus || focus.endsAt > Date.now()) return
    await addFocusRecord({
      startedAt: focus.startedAt,
      minutes: focus.minutes,
      focusedMs: focus.endsAt - focus.startedAt,
      kind: 'focus',
      completed: true,
    })
    await browser.storage.local.set({ focus: null })
    await browser.notifications.create('focus-done', {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title: `Session complete: ${formatDuration(focus.minutes * MINUTE)} locked in`,
      message: 'Nice work. Distraction sites are unblocked again.',
    })
  })
}

const sameRun = (a: QuietRun | null, b: QuietRun | null) => a?.id === b?.id && a?.start === b?.start

/**
 * Notices quiet hours starting or ending: announces a new block, files a finished one for the weekly report,
 * and sets an alarm for the next change so blocking starts on the minute rather than at the next tick.
 * The blocking itself doesn't depend on this; enforce() works it out from the schedule every time.
 */
function syncQuietHours(): Promise<void> {
  return serial(async () => {
    const now = Date.now()
    const { quietHours } = await getSettings()
    const current = activeQuietRun(quietHours, now, await getQuietSkips())
    const { quietRun: previous = null } = (await browser.storage.local.get('quietRun')) as { quietRun?: QuietRun | null }

    if (!sameRun(previous, current)) {
      // A skipped run is filed when it's skipped, and a run you can't see the end of (its block was edited) isn't filed.
      if (previous && previous.end <= now) {
        await addFocusRecord({
          kind: 'quiet',
          startedAt: previous.start,
          minutes: Math.round((previous.end - previous.start) / MINUTE),
          focusedMs: previous.end - previous.start,
          completed: true,
        })
      }
      if (current) {
        await browser.notifications.create('quiet-start', {
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon-128.png'),
          title: `Quiet hours until ${timeOfDay(current.end)}`,
          message: 'Distraction sites are blocked. Study sites and everything else work as normal.',
        })
      }
      await browser.storage.local.set({ quietRun: current })
    }

    const next = nextQuietChange(quietHours, now)
    if (next === null) await browser.alarms.clear(QUIET_ALARM)
    // A moment after the change, so the schedule already reads the new state when the alarm fires.
    else await browser.alarms.create(QUIET_ALARM, { when: next + 500 })
  }).then(tick)
}

/** Skips the rest of the quiet-hours block running now. Only this run: the block comes back as scheduled. */
function skipQuietHours(reason: string): Promise<void> {
  return serial(async () => {
    const now = Date.now()
    const skips = await getQuietSkips()
    const run = activeQuietRun((await getSettings()).quietHours, now, skips)
    if (!run) return
    // Old skips are dropped along the way, since a skip only ever matters until its run would have ended.
    const kept = Object.fromEntries(Object.entries(skips).filter(([, end]) => end > now))
    await browser.storage.local.set({ quietSkips: { ...kept, [run.id]: run.end }, quietRun: null })
    await addFocusRecord({
      kind: 'quiet',
      startedAt: run.start,
      minutes: Math.round((run.end - run.start) / MINUTE),
      focusedMs: now - run.start,
      completed: false,
      reason,
    })
  }).then(syncQuietHours)
}

async function ensureAlarms(): Promise<void> {
  if (!(await browser.alarms.get(TICK_ALARM))) {
    await browser.alarms.create(TICK_ALARM, { periodInMinutes: 1 })
  }
  if (!(await browser.alarms.get(PRUNE_ALARM))) {
    await browser.alarms.create(PRUNE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 })
  }
}

browser.idle.setDetectionInterval(IDLE_SECONDS)
void ensureAlarms()
void settleFinishedFocus()
void syncQuietHours()

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void tick()
  if (alarm.name === FOCUS_ALARM) void settleFinishedFocus()
  if (alarm.name === QUIET_ALARM) void syncQuietHours()
  if (alarm.name === PRUNE_ALARM) void serial(() => pruneOldDays())
})
// A schedule edited in Settings can start or end quiet hours right away.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void syncQuietHours()
})
browser.tabs.onActivated.addListener(() => void tick())
browser.tabs.onUpdated.addListener((_id, change) => {
  // Title changes matter too: on YouTube the URL changes first and the real title arrives a moment later.
  if (change.url || change.title || change.audible !== undefined) void tick()
})
browser.windows.onFocusChanged.addListener(() => void tick())
browser.idle.onStateChanged.addListener(() => void tick())

/** Live time used and left on the site in `tab`, including the session not yet committed. Null for non-web pages. */
async function siteStatus(tab: browser.Tabs.Tab | undefined): Promise<SiteStatus | null> {
  const settings = await getSettings()
  const page = pageInfo(tab?.url, tab?.title)
  if (!page) return null

  const day = today()
  const key = limitKey(settings, page.domain)
  const verdict = await getVerdict(page.key)
  const study = verdict?.category === 'study'
  const session = await getSession()
  const counting = session?.tabId === tab?.id && session?.pageKey === page.key

  let usedMsToday = usedMs((await getDaily('usage'))[day] ?? {}, key)
  if (counting && !study) usedMsToday += Math.min(Date.now() - session!.start, MAX_COMMIT_GAP)

  return {
    site: key,
    usedMs: usedMsToday,
    limitMs: baseLimitMs(settings, key) + ((await getDaily('grants'))[day]?.[key] ?? 0),
    warnMs: settings.warnBeforeMin * MINUTE,
    counting,
    exempt: study ? 'study-page' : null,
    allowlisted: isAllowlisted(settings, page.domain),
    category: verdict?.category ?? null,
    ai: await aiState(settings.backend.enabled, page, verdict),
    lock: await getActiveLock(),
  }
}

/** The floating timer is hidden when it's switched off, and on study sites where nothing is counted. */
async function timerStatus(tab: browser.Tabs.Tab | undefined): Promise<TimerStatus> {
  const status = await siteStatus(tab)
  if (!status || !(await getSettings()).showTimer) return { show: false }
  // Study sites have nothing to count, so the timer only appears there to show a focus session or quiet hours.
  if (status.allowlisted && !status.lock) return { show: false }
  return { show: true, ...status }
}

type Message =
  /** Sent by the "need more time?" page. `verdict: 'denied'` logs the reason without granting time. */
  | { type: 'excuse'; key: string; minutes: number; reason: string; verdict: 'allowed' | 'denied'; reply?: string }
  /** Sent by the floating timer on a web page. */
  | { type: 'timer-status' }
  /** Sent by the popup, about the tab it was opened over. */
  | { type: 'site-status'; tabId: number }
  /** Sent by the popup. */
  | { type: 'focus-start'; minutes: number }
  | { type: 'focus-end-early'; reason: string }
  | { type: 'quiet-skip'; reason: string }

browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  const msg = message as Message
  if (msg.type === 'timer-status') return timerStatus(sender.tab)
  if (msg.type === 'site-status') return browser.tabs.get(msg.tabId).then(siteStatus)
  if (msg.type === 'focus-start') return startFocus(msg.minutes)
  if (msg.type === 'focus-end-early') return endFocusEarly(msg.reason)
  if (msg.type === 'quiet-skip') return skipQuietHours(msg.reason)
  if (msg.type !== 'excuse') return undefined
  const excuse: Excuse = {
    ts: Date.now(),
    domain: msg.key,
    reason: msg.reason,
    minutes: msg.minutes,
    verdict: msg.verdict,
    reply: msg.reply,
  }
  return logExcuse(excuse, msg.verdict === 'allowed' ? msg.minutes : 0)
})
