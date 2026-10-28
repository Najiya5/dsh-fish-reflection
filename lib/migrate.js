/**
 * One-time migration from the plugin's earlier internal names.
 *
 * The package was renamed from `humanloops` to `fish-reflection`; the durable
 * domain must be renamed too, but the storage backend rejects a unit whose
 * header name differs from the declared one, so the stored document is rewritten
 * (header name only) before the new domain opens. Runtime files move with a
 * directory rename.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEGACY_DOMAIN = 'humanloops'
const DOMAIN = 'fish_reflection'
const LEGACY_DIR = 'humanloops'
const DIR = 'fish-reflection'

function home() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Rewrite the old domain document under its new name. Idempotent. */
function migrateDomain(logger) {
  const storageDir = join(home(), 'storages')
  const legacyFile = join(storageDir, `${LEGACY_DOMAIN}.json`)
  const targetFile = join(storageDir, `${DOMAIN}.json`)
  if (existsSync(targetFile) || !existsSync(legacyFile)) return
  try {
    const document = JSON.parse(readFileSync(legacyFile, 'utf8'))
    if (document?.unit?.name === LEGACY_DOMAIN) document.unit.name = DOMAIN
    writeFileSync(targetFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(legacyFile, `${legacyFile}.migrated.bak`)
    logger?.info?.('fish-reflection: storage domain migrated humanloops -> fish_reflection')
  } catch (error) {
    logger?.warn?.(`fish-reflection: storage domain migration failed: ${String(error)}`)
  }
}

/** Move the runtime directory (scope, options, intake, history). Idempotent. */
function migrateDirectory(logger) {
  const legacyDir = join(home(), LEGACY_DIR)
  const targetDir = join(home(), DIR)
  if (existsSync(targetDir) || !existsSync(legacyDir)) return
  try {
    renameSync(legacyDir, targetDir)
    logger?.info?.('fish-reflection: runtime directory migrated humanloops -> fish-reflection')
  } catch (error) {
    logger?.warn?.(`fish-reflection: runtime directory migration failed: ${String(error)}`)
  }
}

/** Run both migrations; safe to call on every start. */
export function migrateLegacyLayout(logger) {
  migrateDomain(logger)
  migrateDirectory(logger)
}
