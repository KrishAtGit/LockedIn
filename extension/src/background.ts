import browser from 'webextension-polyfill'
import { api } from './lib/api'
import {
  aiState,
  getVerdict,
  pageInfo,
  saveVerdict,
  setBackendDown,
  titleIsPlaceholder,
  type PageInfo,
} from './lib/pages'
import {
  baseLimitMs,
  getDaily,
  getExcuses,
  getSettings,
  isAllowlisted,
  limitKey,
  usedMs,
  type Excuse,
} from './lib/storage'
import type { SiteStatus, TimerStatus } from './lib/status'
import { MINUTE, formatDuration, today } from './lib/time'

/** The tab currently being timed. Kept in session storage because the service worker can be killed at any time. */
interface Session {
  domain: string
  /** Which page, so time can be filed as study or not once its verdict is known. */
  pageKey: string
  tabId: number
  start: number
}

const TICK_ALARM = 'tick'
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

/** Asks the backend about a page in the background, then re-checks limits once the answer is in. */
async function classify(page: PageInfo): Promise<void> {
  const settings = await getSettings()
  if (!settings.backend.enabled || classifying.has(page.key) || askedPlaceholders.has(page.key)) return
  if (await getVerdict(page.key)) return
  const placeholder = titleIsPlaceholder(page)

  classifying.add(page.key)
  try {
    const result = await api.classify(settings.backend.url, {
      domain: page.domain,
      path: page.path,
      title: page.title,
    })
    await setBackendDown(result.source === 'fallback')
    // A fallback means the server couldn't decide (its AI is down). Don't remember that, so it's retried later.
    if (result.source === 'fallback') return
    // A title like "Instagram" (or "YouTube" while a video loads) says nothing about the page itself, so only
    // a verdict about the whole site is worth keeping. The real title gets its own verdict once it arrives.
    if (placeholder) askedPlaceholders.add(page.key)
    if (!placeholder || result.source === 'rules') {
      await serial(() => saveVerdict(page.key, { category: result.category, reason: result.reason }))
      void tick()
    }
  } catch (err) {
    await setBackendDown(true)
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

async function ensureAlarm(): Promise<void> {
  if (!(await browser.alarms.get(TICK_ALARM))) {
    await browser.alarms.create(TICK_ALARM, { periodInMinutes: 1 })
  }
}

browser.idle.setDetectionInterval(IDLE_SECONDS)
void ensureAlarm()

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void tick()
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
  }
}

/** The floating timer is hidden when it's switched off, and on study sites where nothing is counted. */
async function timerStatus(tab: browser.Tabs.Tab | undefined): Promise<TimerStatus> {
  const status = await siteStatus(tab)
  if (!status || status.allowlisted || !(await getSettings()).showTimer) return { show: false }
  return { show: true, ...status }
}

type Message =
  /** Sent by the "need more time?" page. `verdict: 'denied'` logs the reason without granting time. */
  | { type: 'excuse'; key: string; minutes: number; reason: string; verdict: 'allowed' | 'denied'; reply?: string }
  /** Sent by the floating timer on a web page. */
  | { type: 'timer-status' }
  /** Sent by the popup, about the tab it was opened over. */
  | { type: 'site-status'; tabId: number }

browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  const msg = message as Message
  if (msg.type === 'timer-status') return timerStatus(sender.tab)
  if (msg.type === 'site-status') return browser.tabs.get(msg.tabId).then(siteStatus)
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
