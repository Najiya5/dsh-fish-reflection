/**
 * Which popular videos this agent already "read", plus when it last tried.
 * Kept as a small JSON file beside the other runtime files so the sets survive
 * restarts without touching the durable state domain's schema.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BVIDS = 800

function directory() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'fish-reflection')
}

/** Path of the intake bookkeeping document. */
export function seenPath() {
  return join(directory(), 'intake.json')
}

/** Read the bookkeeping, defaulting to an empty history. */
export function readSeen() {
  try {
    const file = seenPath()
    if (!existsSync(file)) return { bvids: [], lastAttemptAt: null }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      bvids: Array.isArray(parsed?.bvids) ? parsed.bvids.filter((value) => typeof value === 'string') : [],
      lastAttemptAt: typeof parsed?.lastAttemptAt === 'number' ? parsed.lastAttemptAt : null,
    }
  } catch {
    return { bvids: [], lastAttemptAt: null }
  }
}

/** Persist the bookkeeping, keeping only the newest ids. */
export function writeSeen(state) {
  const next = {
    bvids: state.bvids.slice(-MAX_BVIDS),
    lastAttemptAt: typeof state.lastAttemptAt === 'number' ? state.lastAttemptAt : null,
  }
  mkdirSync(directory(), { recursive: true })
  writeFileSync(seenPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}
