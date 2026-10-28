/** Local calendar and session helpers shared by the Host half. */

/** Local date key, `YYYY-MM-DD`, for the given instant. */
export function dateKey(value = new Date()) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local date key of the day before the given instant. */
export function previousDateKey(value = new Date()) {
  const copy = new Date(value.getTime())
  copy.setDate(copy.getDate() - 1)
  return dateKey(copy)
}

/** Local minutes since midnight. */
export function minutesOfDay(value = new Date()) {
  return value.getHours() * 60 + value.getMinutes()
}

/** Parse `HH:mm` into minutes since midnight, falling back when the text is malformed. */
export function parseClock(text, fallbackMinutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return fallbackMinutes
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return fallbackMinutes
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return fallbackMinutes
  return hours * 60 + minutes
}

/**
 * Whether this session is a main conversation rather than a delegated child.
 * Subagents, teammates, and workflow children all carry `origin: 'subagent'`
 * or a positive delegation depth, and never receive persona state.
 */
export function isMainSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return false
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
  return true
}

/** Session ids the owner enabled in Config; `*` enables every session. */
export function sessionEnabled(config, sessionId) {
  const list = Array.isArray(config?.enabledSessions) ? config.enabledSessions : []
  return list.includes('*') || list.includes(String(sessionId))
}
