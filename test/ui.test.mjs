import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const replacer = (key, value) => (typeof value === 'function' ? '[fn]' : value)

function loadClient(react) {
  let definition = null
  new Function('window', 'require', source)({ __ModuleLoader__: { load(value) { definition = value } } }, (name) => (name === 'react' ? react : undefined))
  const exportsObject = definition.factory((name) => (name === 'react' ? react : undefined))
  let registration = null
  exportsObject.apply({
    get: (key) => (key === 'slots'
      ? {
          inject(name, callback) { callback() },
          register(options, component) { registration = Object.assign({}, options, { component }); return () => {} },
        }
      : undefined),
  })
  return registration.component
}

const base = {
  scope: [],
  options: { autoReflection: true, minMaterial: 6, hasCookie: false },
  sessions: [],
  self: { revision: 1, worldview: [], spirit: { mood: '平静', energy: 3, stress: 2 }, health: { score: 60, trend: 0 } },
  reflection: { lastAt: null, lastDate: null, materialSinceLast: 0, minMaterial: 6 },
  history: { snapshots: [], reflections: [] },
  balance: { latest: null, mean: null, samples: 0 },
  serverTime: Date.now(),
}
const intake = {
  masterEnabled: true,
  enabled: true,
  intervalMinutes: 60,
  dailyLimit: 24,
  todayCount: 1,
  hasCookie: false,
  guestMode: true,
  feedSources: ['bilibili', 'douyin'],
  douyinCookieSet: false,
  douyinLinks: [],
  analyzerConfigured: false,
  analyzerBaseUrl: '',
  analyzerModel: '',
  analyzerKeySet: false,
  onlyPopular: true,
  category: 'life',
  maxDurationMinutes: 60,
  readComments: true,
  useAsr: true,
  asrAvailable: true,
  useVision: true,
  visionModel: 'qwen2.5vl:3b',
  visionFrames: 6,
  includeExternalInReflection: true,
  recent: [{ at: Date.now(), text: '[B站·生活] 一条笔记' }],
}

function render(intakeData) {
  let hookIndex = 0
  const react = {
    createElement(tag, props, ...children) { return { tag, props: props ?? {}, children } },
    useState(initial) {
      const value = hookIndex++ === 0 ? Object.assign({}, base, { intake: intakeData }) : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect() {},
    Fragment: 'Fragment',
  }
  const parts = []
  ;(function walk(node) {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { parts.push(node); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (typeof node.tag === 'function') { walk(node.tag(node.props)); return }
    parts.push(JSON.stringify(node.props, replacer))
    walk(node.children)
  })(loadClient(react)())
  return parts.join('\n')
}

const on = render(intake)
assert.ok(on.includes('pass by'), 'pass by folder rendered')
assert.ok(on.includes('启用刷视频'), 'master switch renamed')
assert.ok(on.includes('分析视频的模型 API'), 'analyzer section rendered')
assert.ok(on.includes('抖音 Cookie'), 'douyin cookie field rendered')
assert.ok(on.includes('两个都默认游客模式'), 'platform row rendered')
assert.ok(on.includes('需要同时支持多模态和 ASR 的 API'), 'analyzer requirement note rendered')

const off = render(Object.assign({}, intake, { masterEnabled: false }))
assert.ok(off.includes('已关闭'), 'disabled hint rendered')
assert.ok(!off.includes('抖音 Cookie'), 'advanced hidden when off')

console.log('INGEST / PASS-BY UI TESTS OK')
