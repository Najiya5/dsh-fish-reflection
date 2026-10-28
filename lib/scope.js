/**
 * Session scope persistence.
 *
 * The Settings page writes which sessions the plugin participates in. That
 * choice lives beside the Harness home directory rather than in the profile
 * patch, so changing it never remounts the plugin (and never loses the in-memory
 * state that the settlement loop is holding).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_SESSIONS = 500
const MAX_ID_LENGTH = 160

/** Directory owned by this plugin inside the Harness home. */
export function scopeDirectory() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'fish-reflection')
}

/** Path of the scope document. */
export function scopePath() {
  return join(scopeDirectory(), 'scope.json')
}

/** Normalize a user-supplied session id list. */
export function normalizeScope(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || id.length > MAX_ID_LENGTH) continue
    if (!out.includes(id)) out.push(id)
    if (out.length >= MAX_SESSIONS) break
  }
  return out
}

/** Read the stored scope, or `null` when the owner never saved one. */
export function readScopeFile() {
  try {
    const file = scopePath()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeScope(parsed?.enabledSessions)
  } catch {
    return null
  }
}

/** Persist one scope list; returns the normalized value that was written. */
export function writeScopeFile(value) {
  const normalized = normalizeScope(value)
  const directory = scopeDirectory()
  mkdirSync(directory, { recursive: true })
  writeFileSync(scopePath(), JSON.stringify({ enabledSessions: normalized, savedAt: Date.now() }, null, 2), 'utf8')
  return normalized
}
