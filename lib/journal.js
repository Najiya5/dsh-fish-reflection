/**
 * Conversation digests: one compact line per user/assistant message, kept only
 * as material for the nightly reflection. The raw transcript stays in the
 * session log; this table is a bounded, plugin-owned excerpt.
 */

const MAX_TEXT = 400

/** Extract plain text from one message's content blocks. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/**
 * Turn one durable session event into a digest item, skipping everything the
 * reflection does not need (tool traffic, our own injected snapshots).
 */
export function digestEvent(event) {
  if (event?.type === 'user/message') {
    const source = event.data?.source
    if (source?.kind !== 'user') return null
    const text = textOf(event.data)
    if (text === '') return null
    return { role: 'user', text: clip(text) }
  }
  if (event?.type === 'assistant/message') {
    const text = textOf(event.data?.message)
    if (text === '') return null
    return { role: 'assistant', text: clip(text) }
  }
  return null
}

function clip(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat
}

/** Append one digest item and trim the day to at most `maxPerDay` entries. */
export async function appendJournal(domain, item, maxPerDay) {
  const table = domain.table('journal')
  const key = `${item.date}:${String(item.at).padStart(15, '0')}`
  await table.put(key, item)
  const prefix = `${item.date}:`
  const keys = []
  for (const candidate of table.keys()) {
    if (candidate.startsWith(prefix)) keys.push(candidate)
  }
  if (keys.length <= maxPerDay) return
  keys.sort()
  for (const stale of keys.slice(0, keys.length - maxPerDay)) {
    await table.delete(stale)
  }
}

/** Every digest item recorded after the given timestamp (exclusive), oldest first. */
export function journalSince(domain, sinceAt = 0) {
  const table = domain.table('journal')
  const items = []
  const cutoff = typeof sinceAt === 'number' ? sinceAt : 0
  for (const value of table.entries()) {
    const [, item] = value
    if (item.at <= cutoff) continue
    items.push(item)
  }
  items.sort((left, right) => left.at - right.at)
  return items
}
