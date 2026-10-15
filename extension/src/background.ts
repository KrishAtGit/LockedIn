import browser from 'webextension-polyfill'
import { domainOf } from './lib/domain'
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
import { MINUTE, formatDuration, today } from './lib/time'

/** The tab currently being timed. Kept in session storage because the service worker can be killed at any time. */
interface Session {
  domain: string
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

/** Adds the time since the session started to today's usage and restarts the session clock. */
async function commit(now: number): Promise<void> {
  const session = await getSession()
  if (!session) return

  const elapsed = Math.min(now - session.start, MAX_COMMIT_GAP)
  if (elapsed > 0) {
    const usage = await getDaily('usage')
    const day = (usage[today(now)] ??= {})
    day[session.domain] = (day[session.domain] ?? 0) + elapsed
    await browser.storage.local.set({ usage })
  }
  await setSession({ ...session, start: now })
}

interface Target {
  domain: string
  tabId: number
  url: string
}

/**
 * The tab that should be counted right now: the active tab of the focused window while the user is active.
 * An audible tab (a lecture video, or Netflix) keeps counting even when the user isn't touching the keyboard.
 */
async function currentTarget(): Promise<Target | null> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
  const domain = domainOf(tab?.url)
  if (!tab?.id || !domain) return null

  const win = await browser.windows.getLastFocused()
  const idle = await browser.idle.queryState(IDLE_SECONDS)
  const engaged = win.focused && idle === 'active'
  return engaged || tab.audible ? { domain, tabId: tab.id, url: tab.url! } : null
}

/** Warns when a limit is close and sends the tab to the "negotiate" page once it's reached. */
async function enforce(target: Target): Promise<boolean> {
  const settings = await getSettings()
  if (isAllowlisted(settings, target.domain)) return false

  const day = today()
  const key = limitKey(settings, target.domain)
  const usage = await getDaily('usage')
  const grants = await getDaily('grants')
  const limit = baseLimitMs(settings, key) + (grants[day]?.[key] ?? 0)
  const remaining = limit - usedMs(usage[day] ?? {}, key)

  if (remaining <= 0) {
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
    await commit(now)

    const target = await currentTarget()
    if (target && (await enforce(target))) {
      await setSession(null)
      return
    }
    await setSession(target ? { domain: target.domain, tabId: target.tabId, start: now } : null)
  })
}

function grant(key: string, minutes: number, reason: string): Promise<void> {
  return serial(async () => {
    const day = today()
    const grants = await getDaily('grants')
    grants[day] = { ...grants[day], [key]: (grants[day]?.[key] ?? 0) + minutes * MINUTE }

    const excuse: Excuse = { ts: Date.now(), domain: key, reason, minutes }
    const excuses = [excuse, ...(await getExcuses())].slice(0, MAX_EXCUSES)
    await browser.storage.local.set({ grants, excuses })
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
  if (change.url || change.audible !== undefined) void tick()
})
browser.windows.onFocusChanged.addListener(() => void tick())
browser.idle.onStateChanged.addListener(() => void tick())

type Message = { type: 'grant'; key: string; minutes: number; reason: string }

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as Message
  if (msg.type === 'grant') return grant(msg.key, msg.minutes, msg.reason)
  return undefined
})
