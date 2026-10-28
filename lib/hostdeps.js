/**
 * Locate the Harness host's own packages from an installed bundle.
 *
 * A locally installed bundle is linked into the profile, so a static
 * `import '@deepseek-ai/...'` resolves from the bundle directory and fails.
 * The Harness ships those packages inside its own tree; this module finds that
 * tree and imports the exact module instances the host already uses, by
 * absolute file URL, so both halves share one copy.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Candidate `node_modules` directories, most likely first, without duplicates. */
function candidateRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (!roots.includes(value)) roots.push(value)
  }
  push(process.env.DSH_HOST_MODULES)
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
    push(join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  const executableDir = dirname(process.execPath)
  push(join(executableDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
  push(join(executableDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    for (const profile of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', profile, 'node_modules'))
    }
  } catch {
    /* no profiles directory; the other roots still apply */
  }
  return roots
}

/** Resolve a package's ESM entry through its own manifest. */
function entryFile(root, packageName) {
  try {
    const directory = join(root, ...packageName.split('/'))
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const dot = manifest.exports?.['.']
    const relative = typeof dot === 'string'
      ? dot
      : (dot?.import ?? dot?.default ?? manifest.module ?? manifest.main)
    if (relative === undefined || relative === null) return null
    const file = join(directory, String(relative).replace(/^\.\//, ''))
    return existsSync(file) ? file : null
  } catch {
    return null
  }
}

/** Import one host package from the first tree that can serve it. */
async function importHostPackage(packageName) {
  for (const root of candidateRoots()) {
    const file = entryFile(root, packageName)
    if (file === null) continue
    try {
      return await import(pathToFileURL(file).href)
    } catch {
      /* try the next candidate tree */
    }
  }
  return null
}

/**
 * Load the host-provided modules this bundle needs.
 * Missing entries degrade to `null`; the plugin still loads.
 */
export async function loadHostDeps() {
  const schemasteryModule = await importHostPackage('@deepseek-ai/schemastery')
  const zodModule = await importHostPackage('zod')
  const llmModule = await importHostPackage('@deepseek-ai/dsh-llm')
  return {
    schemastery: schemasteryModule?.default ?? null,
    zod: zodModule?.z ?? zodModule?.default ?? null,
    createUserMessage: typeof llmModule?.createUserMessage === 'function' ? llmModule.createUserMessage : null,
  }
}
