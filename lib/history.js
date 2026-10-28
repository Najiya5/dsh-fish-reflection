/**
 * Growth archive: one append-only JSONL file beside the other runtime files.
 *
 * Two record kinds:
 * - `snapshot`: one per day — revision, principle count, health, spirit, balance.
 * - `reflection`: one per successful reflection — revision, count, note, the
 *   principles that version produced.
 *
 * Kept out of the durable state domain on purpose: it is a growing time series,
 * so a line-per-record file stays cheap to append and to read back in slices.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_RECORDS = 4000
const KEEP_RECORDS = 3000

function directory() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'fish-reflection')
}

/** Path of the growth archive. */
export function historyPath() {
  return join(directory(), 'history.jsonl')
}

/** Append one record, trimming the file when it grows past the cap. */
export function appendRecord(record) {
  const file = historyPath()
  mkdirSync(directory(), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    if (lines.length > MAX_RECORDS) {
      writeFileSync(file, `${lines.slice(-KEEP_RECORDS).join('\n')}\n`, 'utf8')
    }
  } catch {
    /* trimming is housekeeping; a failed trim must not lose the new record */
  }
  return record
}

/** Read every parsed record, skipping damaged lines. */
export function readAll() {
  const file = historyPath()
  if (!existsSync(file)) return []
  const records = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (record !== null && typeof record === 'object') records.push(record)
    } catch {
      /* skip one damaged line */
    }
  }
  return records
}

/** Read records from the last `days` calendar days (all records when `days` <= 0). */
export function readHistory(days = 30) {
  const all = readAll()
  if (!Number.isFinite(days) || days <= 0) {
    return { snapshots: all.filter((record) => record.type === 'snapshot'), reflections: all.filter((record) => record.type === 'reflection') }
  }
  const cutoff = Date.now() - days * 86_400_000
  const inRange = all.filter((record) => typeof record.at === 'number' && record.at >= cutoff)
  return {
    snapshots: inRange.filter((record) => record.type === 'snapshot'),
    reflections: inRange.filter((record) => record.type === 'reflection'),
  }
}

/** The most recent snapshot, when one exists. */
export function lastSnapshot() {
  const snapshots = readAll().filter((record) => record.type === 'snapshot')
  return snapshots.length === 0 ? null : snapshots[snapshots.length - 1]
}
