/**
 * Client half: one Settings section page that chooses which sessions the
 * human-loops plugin participates in. Everything else (state, settlement,
 * reflection, injection) stays on the Host; this page only reads the plugin's
 * same-origin JSON API and saves the session scope.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fish-reflection',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var BASE = '/fish-reflection/api'

    var S = {
      page: { padding: '2px 0 24px', fontSize: 13, lineHeight: 1.6 },
      title: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      dim: { color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
        borderRadius: 8,
        padding: '12px 14px',
        marginTop: 12,
      },
      group: { marginTop: 14 },
      groupHead: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 4px 22px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
      button: {
        padding: '5px 14px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 13,
      },
      footer: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 },
      tag: {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-l2, rgba(128,128,128,0.12))',
        color: 'var(--dsw-alias-label-tertiary, #6b7280)',
      },
      error: { color: 'var(--dsw-alias-label-danger, #d14343)', marginTop: 8 },
      principle: { padding: '1px 0', display: 'flex', gap: 4 },
      warn: { color: 'var(--dsw-alias-label-warning, #b07000)' },
      input: {
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        width: 200,
      },
      field: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
      note: { marginTop: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    }

    function basename(path) {
      if (typeof path !== 'string' || path === '') return '（无工作区）'
      var parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    function mix() {
      var out = {}
      for (var i = 0; i < arguments.length; i += 1) {
        var style = arguments[i]
        if (style === null || style === undefined) continue
        for (var key in style) {
          if (Object.prototype.hasOwnProperty.call(style, key)) out[key] = style[key]
        }
      }
      return out
    }

    function readJson(response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status)
        return body
      })
    }

    function loadOverview() {
      return fetch(BASE + '/overview', { cache: 'no-store' }).then(readJson)
    }

    function saveScope(ids) {
      return fetch(BASE + '/scope', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabledSessions: ids }),
      }).then(readJson)
    }

    function money(balance) {
      if (!balance || balance.latest == null) return '余额未知'
      var value = balance.latest.balance
      var text = (balance.latest.currency === 'CNY' ? '¥' : '') + Number(value).toFixed(2)
      if (balance.mean != null && balance.samples >= 2) {
        text += '（近' + balance.samples + '天日均 ' + Number(balance.mean).toFixed(2) + '）'
      } else {
        text += '（日均样本不足）'
      }
      return text
    }

    function postJson(path, body) {
      return fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function fmtTime(ms) {
      if (ms == null) return '还没有'
      var date = new Date(ms)
      var pad = function (n) { return String(n).padStart(2, '0') }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    var REFLECT_REASONS = {
      'insufficient-material': '素材不足',
      'no-material': '没有新的对话摘要',
      'llm-unavailable': '模型服务不可用',
      'model-unavailable': '没有可用的默认模型',
      'call-failed': '模型调用失败（已保留原三观）',
      unparsable: '模型输出无法解析（已保留原三观）',
      'empty-worldview': '模型没有给出有效原则（已保留原三观）',
    }

    var KIND_LABELS = { value: '价值观', preference: '偏好', habit: '习惯' }
    var KIND_ORDER = ['value', 'preference', 'habit']

    function Summary(props) {
      var data = props.data
      var self = data.self || {}
      var spirit = self.spirit || {}
      var health = self.health || {}
      var worldview = self.worldview || []
      var groups = { value: [], preference: [], habit: [] }
      for (var index = 0; index < worldview.length; index += 1) {
        var item = worldview[index]
        var kind = KIND_ORDER.indexOf(item.kind) >= 0 ? item.kind : 'habit'
        groups[kind].push(item)
      }
      return h('div', { style: S.card },
        h('div', { style: S.title }, '当前状态'),
        h('div', null, '内循环：人格 v' + (self.revision || 0) + '，' + worldview.length + ' 条'),
        worldview.length === 0
          ? h('div', { style: S.dim }, '·（尚未形成，反省后生成）')
          : h('div', { style: { margin: '4px 0 2px' } }, KIND_ORDER.map(function (kind) {
              if (groups[kind].length === 0) return null
              return h('div', { key: kind, style: { marginTop: 4 } },
                h('div', { style: S.dim }, KIND_LABELS[kind]),
                groups[kind].map(function (entry) {
                  return h('div', { key: entry.id, style: S.principle },
                    h('span', { style: mix(S.dim, S.mono) }, '[' + Number(entry.weight).toFixed(1) + '] '),
                    entry.text,
                  )
                }),
              )
            })),
        h('div', null, '外循环：精神 ' + (spirit.mood || '—') + '（能量 ' + (spirit.energy == null ? '—' : spirit.energy) + '/5，压力 ' + (spirit.stress == null ? '—' : spirit.stress) + '/5）；健康 ' + (health.score == null ? '—' : Math.round(health.score)) + '/100'),
        h('div', null, '财务：' + money(data.balance)),
        h('div', { style: { marginTop: 6 } }, h('span', { style: S.dim }, '状态文件：~/.dsh/storages/fish_reflection.json　作用域：~/.dsh/fish-reflection/scope.json　选项：~/.dsh/fish-reflection/options.json')),
      )
    }

    function ReflectionCard(props) {
      var data = props.data
      var reflection = data.reflection || {}
      var options = data.options || {}
      var material = reflection.materialSinceLast == null ? 0 : reflection.materialSinceLast
      var minimum = reflection.minMaterial == null ? 6 : reflection.minMaterial
      return h('div', { style: S.card },
        h('div', { style: S.title }, '三观反省'),
        h('div', null, '上次反省：' + fmtTime(reflection.lastAt)),
        h('div', { style: S.dim }, '自上次以来 ' + material + ' 条摘要（至少 ' + minimum + ' 条才会改写三观）'),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
          h('input', {
            type: 'checkbox',
            checked: options.autoReflection !== false,
            disabled: props.busy,
            onChange: function () { props.onToggleAuto(options.autoReflection === false) },
          }),
          h('span', null, '每天自动反省一次（23:30 后或次日启动时补做）'),
        ),
        h('div', { style: S.footer },
          h('button', { style: S.button, onClick: props.onReflect, disabled: props.busy }, props.reflecting ? '反省中…' : '立即反思'),
          props.result ? h('span', { style: props.result.ok ? S.dim : S.warn }, props.result.text) : null,
        ),
        props.result && props.result.note ? h('div', { style: mix(S.dim, { marginTop: 4 }) }, '本次变化：' + props.result.note) : null,
      )
    }

    function GrowthCard(props) {
      var history = (props.data && props.data.history) || {}
      var snapshots = history.snapshots || []
      var reflections = history.reflections || []
      return h('div', { style: S.card },
        h('div', { style: S.title }, '成长档案'),
        h('div', { style: S.dim }, '每天结算与每次反省各留一条记录：~/.dsh/fish-reflection/history.jsonl'),
        snapshots.length === 0
          ? h('div', { style: { marginTop: 8 } }, h('span', { style: S.dim }, '还没有快照；下一次结算时生成。'))
          : h('div', { style: { marginTop: 8 } },
              h('div', { style: S.dim }, '每日快照（最近 14 条）：'),
              snapshots.slice(-14).map(function (item) {
                return h('div', { key: item.at, style: S.note },
                  item.date + '　v' + item.revision + '　' + item.principles + ' 条原则　健康 ' + item.health +
                    '　余额 ' + (item.balance == null ? '—' : Number(item.balance).toFixed(2)),
                )
              }),
            ),
        reflections.length === 0
          ? null
          : h('div', { style: { marginTop: 10 } },
              h('div', { style: S.dim }, '三观版本：'),
              reflections.slice(-5).map(function (item) {
                return h('div', { key: item.at, style: S.note },
                  'v' + item.revision + '　' + item.count + ' 条原则' + (item.note ? '　' + item.note : ''),
                )
              }),
            ),
      )
    }

    function IntakeCard(props) {
      var data = props.data
      var intake = data.intake || {}
      var master = intake.masterEnabled !== false
      var advanced = []
      if (master) {
        advanced.push(h('div', { style: S.field },
          h('span', { style: S.dim }, '平台'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: (intake.feedSources || []).indexOf('bilibili') >= 0,
              onChange: function () { props.onToggleSource('bilibili') },
            }),
            h('span', null, 'B站'),
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: (intake.feedSources || []).indexOf('douyin') >= 0,
              onChange: function () { props.onToggleSource('douyin') },
            }),
            h('span', null, '抖音'),
          ),
          h('span', { style: S.dim }, '两个都默认游客模式'),
        ))
        advanced.push(h('div', { style: S.field },
          h('span', { style: S.dim }, 'B站 Cookie'),
          h('input', {
            style: mix(S.input, { width: 320 }),
            type: 'password',
            value: props.cookie,
            placeholder: intake.hasCookie ? '已配置（留空则保持不变）' : '粘贴整条 Cookie，留空=游客模式',
            onChange: function (event) { props.onCookie(event.target.value) },
          }),
          h('button', { style: S.button, onClick: props.onClearCookie, disabled: props.busy }, '清除'),
        ))
        advanced.push(h('div', { style: { marginTop: 4 } }, h('span', { style: S.dim },
          intake.hasCookie
            ? 'B站已登录：可读取字幕；Cookie 只保存在本机 options.json。'
            : 'B站游客模式：可读视频信息、音频、评论区与画面，拿不到字幕。')))
        advanced.push(h('div', { style: S.field },
          h('span', { style: S.dim }, '抖音 Cookie'),
          h('input', {
            style: mix(S.input, { width: 320 }),
            type: 'password',
            value: props.douyinCookie,
            placeholder: intake.douyinCookieSet ? '已配置（留空则保持不变）' : '留空=游客模式（分享链接解析）',
            onChange: function (event) { props.onDouyinCookie(event.target.value) },
          }),
          h('button', { style: S.button, onClick: props.onClearDouyinCookie, disabled: props.busy }, '清除'),
        ))
        advanced.push(h('div', { style: { marginTop: 4 } }, h('span', { style: S.dim },
          '抖音游客模式：解析分享链接、听音频、看画面都可用；热评和推荐流需要登录态，暂不读取。')))
        advanced.push(h('div', { style: S.field },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.onlyPopular !== false,
              onChange: function () { props.onToggleOnlyPopular(intake.onlyPopular === false) },
            }),
            h('span', null, '只看热门'),
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.category === 'life',
              onChange: function () { props.onToggleLife(intake.category !== 'life') },
            }),
            h('span', null, '生活类内容'),
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.readComments !== false,
              onChange: function () { props.onToggleReadComments(intake.readComments === false) },
            }),
            h('span', null, '查阅评论区'),
          ),
          h('span', { style: S.dim }, '时长上限（分钟，0=不限）'),
          h('input', {
            style: mix(S.input, { width: 64 }),
            type: 'number',
            value: intake.maxDurationMinutes == null ? 60 : intake.maxDurationMinutes,
            onChange: function (event) { props.onMaxDuration(event.target.value) },
          }),
        ))
        advanced.push(intake.category === 'life'
          ? h('div', { style: S.dim }, '生活类模式：从 B 站生活区排行挑视频，人格更容易长出价值观与偏好。')
          : null)
        advanced.push(h('div', { style: S.field },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.useAsr !== false,
              onChange: function () { props.onToggleUseAsr(intake.useAsr === false) },
            }),
            h('span', null, '没字幕时听音频（本地 ASR）'),
          ),
          h('span', { style: S.dim }, intake.asrAvailable === false ? '语音识别未就绪' : '首次会下载约 239 MB 模型'),
        ))
        advanced.push(h('div', { style: S.field },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.useVision !== false,
              onChange: function () { props.onToggleUseVision(intake.useVision === false) },
            }),
            h('span', null, '看画面（本地视觉）'),
          ),
          h('span', { style: S.dim }, '抽 ' + (intake.visionFrames == null ? 6 : intake.visionFrames) + ' 帧 → ' + (intake.visionModel || 'qwen2.5vl:3b') + ' 描述'),
        ))
        advanced.push(h('div', { style: S.field },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.enabled === true,
              onChange: function () { props.onToggleAuto(intake.enabled !== true) },
            }),
            h('span', null, '自动抓取'),
          ),
          h('span', { style: S.dim }, '间隔（分钟）'),
          h('input', {
            style: mix(S.input, { width: 64 }),
            type: 'number',
            value: intake.intervalMinutes == null ? 60 : intake.intervalMinutes,
            onChange: function (event) { props.onInterval(event.target.value) },
          }),
          h('span', { style: S.dim }, '每日上限'),
          h('input', {
            style: mix(S.input, { width: 64 }),
            type: 'number',
            value: intake.dailyLimit == null ? 12 : intake.dailyLimit,
            onChange: function (event) { props.onLimit(event.target.value) },
          }),
          h('span', { style: S.dim }, '今天已读 ' + (intake.todayCount == null ? 0 : intake.todayCount) + ' 个'),
        ))
        advanced.push(h('div', { style: S.field },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: intake.includeExternalInReflection !== false,
              onChange: function () { props.onToggleExternalReflect(intake.includeExternalInReflection === false) },
            }),
            h('span', null, '视频笔记参与反省'),
          ),
          h('span', { style: S.dim }, intake.includeExternalInReflection === false
            ? '关闭后只按对话反省；笔记仍会记录，只是不参与'
            : '参与时对话与笔记按 7:3 分配'),
        ))
        advanced.push(h('div', { style: S.field },
          h('span', { style: S.dim }, '抖音链接队列（每行一条分享链接，读取后自动移除）'),
          h('textarea', {
            style: mix(S.input, { width: '100%', minHeight: 64 }),
            value: props.douyinLinks,
            placeholder: 'https://v.douyin.com/xxxxx/',
            onChange: function (event) { props.onDouyinLinks(event.target.value) },
          }),
          h('span', { style: S.dim }, '当前队列 ' + (intake.douyinLinks ? intake.douyinLinks.length : 0) + ' 条；保存输入设置后生效'),
        ))
        advanced.push(h('div', { style: S.field },
          h('span', { style: { fontWeight: 600 } }, '分析视频的模型 API'),
          h('span', { style: S.dim }, '（需要同时支持多模态和 ASR 的 API；填了就优先用它写笔记，本地 ASR/抽帧仍会补料）'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
            h('input', {
              style: mix(S.input, { width: 240 }),
              value: props.analyzerBaseUrl,
              placeholder: 'https://api.example.com/v1',
              onChange: function (event) { props.onAnalyzerBaseUrl(event.target.value) },
            }),
            h('input', {
              style: mix(S.input, { width: 220 }),
              type: 'password',
              value: props.analyzerApiKey,
              placeholder: intake.analyzerKeySet ? 'API Key 已配置（留空保持不变）' : 'API Key',
              onChange: function (event) { props.onAnalyzerApiKey(event.target.value) },
            }),
            h('input', {
              style: mix(S.input, { width: 200 }),
              value: props.analyzerModel,
              placeholder: '模型名，如 qwen-vl-max',
              onChange: function (event) { props.onAnalyzerModel(event.target.value) },
            }),
            h('button', { style: S.button, onClick: props.onSaveAnalyzer, disabled: props.busy }, '保存 API'),
            h('button', { style: S.button, onClick: props.onTestAnalyzer, disabled: props.busy }, '测试 API'),
          ),
          h('span', { style: S.dim }, intake.analyzerConfigured ? '已启用外部分析：' + (intake.analyzerModel || '') : '未配置时使用本地视觉 + 本地 ASR'),
          props.analyzerTestResult ? h('div', { style: S.note }, props.analyzerTestResult) : null,
        ))
        advanced.push(h('div', { style: S.footer },
          h('button', { style: S.button, onClick: props.onSave, disabled: props.busy }, '保存输入设置'),
          h('button', { style: S.button, onClick: props.onReadNow, disabled: props.busy }, props.reading ? '读取中…' : '现在刷一个'),
          h('button', { style: S.button, onClick: props.onTest, disabled: props.busy }, props.testing ? '测试中…' : '测试连接'),
          props.result ? h('span', { style: props.result.ok ? S.dim : S.warn }, props.result.text) : null,
        ))
        advanced.push(props.testResult ? h('div', { style: S.note }, h('span', { style: S.dim }, props.testResult)) : null)
      }
      return h('div', { style: S.card },
        h('div', { style: S.title }, '刷视频'),
        h('div', { style: S.dim }, '总开关关掉后，自动和手动读取都不会运行；打开后每小时刷一个视频（B站热门 / 抖音队列），优先字幕，没有字幕就听音频、看画面。'),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
          h('input', {
            type: 'checkbox',
            checked: master,
            onChange: function () { props.onToggleMaster(master === false) },
          }),
          h('span', null, '启用刷视频'),
        ),
        master
          ? h('div', { style: { marginTop: 10 } }, advanced)
          : h('div', { style: { marginTop: 8 } }, h('span', { style: S.dim }, '已关闭：不会再读取视频，已有笔记仍保留在反省素材里。')),
      )
    }

    function SessionRow(props) {
      var session = props.session
      var checked = props.checked
      return h('label', { style: S.row, key: session.id },
        h('input', {
          type: 'checkbox',
          checked: checked,
          onChange: function () { props.onToggle(session.id, !checked) },
        }),
        h('span', null, session.title || '未命名会话'),
        h('span', { style: S.tag }, session.live ? '进行中' : '已存档'),
        h('span', { style: mix(S.dim, S.mono) }, session.id.slice(-8)),
      )
    }

    function WorkspaceGroup(props) {
      var sessions = props.sessions
      var selected = props.selected
      var checkedCount = sessions.filter(function (s) { return selected[s.id] }).length
      var allChecked = checkedCount === sessions.length
      return h('div', { style: S.group },
        h('label', { style: S.groupHead },
          h('input', {
            type: 'checkbox',
            checked: allChecked,
            onChange: function () { props.onToggleAll(sessions, !allChecked) },
          }),
          h('span', null, basename(props.cwd)),
          h('span', { style: mix(S.dim, S.mono) }, props.cwd || ''),
          h('span', { style: S.dim }, checkedCount + '/' + sessions.length),
        ),
        sessions.map(function (session) {
          return h(SessionRow, {
            key: session.id,
            session: session,
            checked: selected[session.id] === true,
            onToggle: props.onToggle,
          })
        }),
      )
    }

    function Page() {
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var selectedState = React.useState({})
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var reflectingState = React.useState(false)
      var reflecting = reflectingState[0]
      var setReflecting = reflectingState[1]
      var reflectResultState = React.useState(null)
      var reflectResult = reflectResultState[0]
      var setReflectResult = reflectResultState[1]
      var cookieState = React.useState('')
      var cookie = cookieState[0]
      var setCookie = cookieState[1]
      var intakeBusyState = React.useState(false)
      var intakeBusy = intakeBusyState[0]
      var setIntakeBusy = intakeBusyState[1]
      var intakeResultState = React.useState(null)
      var intakeResult = intakeResultState[0]
      var setIntakeResult = intakeResultState[1]
      var biliTestState = React.useState('')
      var biliTest = biliTestState[0]
      var setBiliTest = biliTestState[1]
      var douyinCookieState = React.useState('')
      var douyinCookie = douyinCookieState[0]
      var setDouyinCookie = douyinCookieState[1]
      var douyinLinksState = React.useState('')
      var douyinLinksDraft = douyinLinksState[0]
      var setDouyinLinksDraft = douyinLinksState[1]
      var analyzerBaseUrlState = React.useState('')
      var analyzerBaseUrl = analyzerBaseUrlState[0]
      var setAnalyzerBaseUrl = analyzerBaseUrlState[1]
      var analyzerApiKeyState = React.useState('')
      var analyzerApiKey = analyzerApiKeyState[0]
      var setAnalyzerApiKey = analyzerApiKeyState[1]
      var analyzerModelState = React.useState('')
      var analyzerModel = analyzerModelState[0]
      var setAnalyzerModel = analyzerModelState[1]
      var analyzerTestState = React.useState('')
      var analyzerTestResult = analyzerTestState[0]
      var setAnalyzerTestResult = analyzerTestState[1]
      var passByOpenState = React.useState(false)
      var passByOpen = passByOpenState[0]
      var setPassByOpen = passByOpenState[1]
      var exportBusyState = React.useState(false)
      var exportBusy = exportBusyState[0]
      var setExportBusy = exportBusyState[1]
      var exportResultState = React.useState('')
      var exportResult = exportResultState[0]
      var setExportResult = exportResultState[1]
      var intervalState = React.useState(null)
      var intervalDraft = intervalState[0]
      var setIntervalDraft = intervalState[1]
      var limitState = React.useState(null)
      var limitDraft = limitState[0]
      var setLimitDraft = limitState[1]
      var durationState = React.useState(null)
      var durationDraft = durationState[0]
      var setDurationDraft = durationState[1]

      React.useEffect(function () {
        var cancelled = false
        loadOverview().then(function (payload) {
          if (cancelled) return
          setData(payload)
          var map = {}
          for (var i = 0; i < payload.sessions.length; i += 1) {
            map[payload.sessions[i].id] = false
          }
          var scope = payload.scope || []
          for (var j = 0; j < scope.length; j += 1) map[scope[j]] = true
          setSelected(map)
        }).catch(function (failure) {
          if (!cancelled) setError(String(failure && failure.message ? failure.message : failure))
        })
        return function () { cancelled = true }
      }, [])

      function toggle(id, value) {
        setNotice('')
        setSelected(function (current) {
          var next = Object.assign({}, current)
          next[id] = value
          return next
        })
      }

      function toggleAll(sessions, value) {
        setNotice('')
        setSelected(function (current) {
          var next = Object.assign({}, current)
          for (var i = 0; i < sessions.length; i += 1) next[sessions[i].id] = value
          return next
        })
      }

      function save() {
        setSaving(true)
        setError('')
        setNotice('')
        var ids = Object.keys(selected).filter(function (id) { return selected[id] === true })
        saveScope(ids).then(function (result) {
          setSaving(false)
          setNotice('已保存：' + result.scope.length + ' 个会话启用')
        }).catch(function (failure) {
          setSaving(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function resetState() {
        if (!window.confirm('确定清空内循环三观、精神/健康状态和已记录的对话摘要吗？余额记录会保留。')) return
        setSaving(true)
        setError('')
        setNotice('')
        fetch(BASE + '/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then(readJson).then(function () {
          setSaving(false)
          setNotice('已重置')
          return loadOverview().then(function (payload) {
            setData(payload)
          })
        }).catch(function (failure) {
          setSaving(false)
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function refresh() {
        return loadOverview().then(function (payload) {
          setData(payload)
          return payload
        })
      }

      function reflectNow() {
        setReflecting(true)
        setReflectResult(null)
        postJson('/reflect').then(function (result) {
          setReflecting(false)
          if (result.ok) {
            var review = result.review || null
            var reviewText = ''
            if (review) {
              if (review.dropped && review.dropped.length > 0) reviewText = '；审稿退回 ' + review.dropped.length + ' 条'
              else if (review.note) reviewText = '；' + review.note
            }
            setReflectResult({
              ok: true,
              text: '完成：人格 v' + result.revision + '，' + result.count + ' 条原则（基于 ' + result.materialCount + ' 条摘要）' + reviewText,
              note: result.note || '',
            })
          } else {
            setReflectResult({
              ok: false,
              text: (REFLECT_REASONS[result.reason] || ('反省失败：' + result.reason)) +
                (result.reason === 'insufficient-material' ? '（当前 ' + result.materialCount + '/' + result.required + ' 条）' : ''),
              note: '',
            })
          }
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setReflecting(false)
          setReflectResult({ ok: false, text: '请求失败：' + String(failure && failure.message ? failure.message : failure), note: '' })
        })
      }

      function toggleAuto(nextValue) {
        setError('')
        var previous = data && data.options ? data.options.autoReflection : true
        if (data) {
          setData(Object.assign({}, data, {
            options: Object.assign({}, data.options, { autoReflection: nextValue }),
          }))
        }
        postJson('/options', { autoReflection: nextValue }).catch(function (failure) {
          if (data) {
            setData(Object.assign({}, data, {
              options: Object.assign({}, data.options, { autoReflection: previous }),
            }))
          }
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function intakePatch() {
        var intake = (data && data.intake) || {}
        var patch = {
          intakeEnabled: intake.masterEnabled !== false,
          autoIntake: intake.enabled === true,
          intakeIntervalMinutes: Number(intervalDraft == null ? intake.intervalMinutes : intervalDraft) || 60,
          intakeDailyLimit: Number(limitDraft == null ? intake.dailyLimit : limitDraft) || 12,
          intakeOnlyPopular: intake.onlyPopular !== false,
          intakeCategory: intake.category === 'life' ? 'life' : 'all',
          intakeReadComments: intake.readComments !== false,
          intakeUseAsr: intake.useAsr !== false,
          intakeUseVision: intake.useVision !== false,
          includeExternalInReflection: intake.includeExternalInReflection !== false,
          intakeMaxDurationMinutes: Number(durationDraft == null ? intake.maxDurationMinutes : durationDraft) || 0,
        }
        if (cookie !== '') {
          patch.bilibiliCookie = cookie
        }
        if (douyinCookie !== '') {
          patch.douyinCookie = douyinCookie
        }
        if (douyinLinksDraft.trim() !== '') {
          patch.douyinLinks = douyinLinksDraft.split(/\r?\n/).map(function (item) { return item.trim() }).filter(function (item) { return item !== '' })
        }
        if (analyzerBaseUrl.trim() !== '' || analyzerModel.trim() !== '') {
          patch.analyzerBaseUrl = analyzerBaseUrl.trim()
          patch.analyzerModel = analyzerModel.trim()
          if (analyzerApiKey.trim() !== '') patch.analyzerApiKey = analyzerApiKey.trim()
        } else if (analyzerApiKey.trim() !== '') {
          patch.analyzerApiKey = analyzerApiKey.trim()
        }
        return patch
      }

      function toggleSource(source) {
        if (!data) return
        var current = (data.intake && data.intake.feedSources) || []
        var next = current.indexOf(source) >= 0
          ? current.filter(function (item) { return item !== source })
          : current.concat([source])
        setData(Object.assign({}, data, {
          intake: Object.assign({}, data.intake, { feedSources: next }),
        }))
        postJson('/options', { feedSources: next }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function clearDouyinCookie() {
        if (!window.confirm('清除已保存的抖音 Cookie？之后回到游客模式。')) return
        setIntakeBusy(true)
        postJson('/options', { douyinCookie: '' }).then(function () {
          setIntakeBusy(false)
          setIntakeResult({ ok: true, text: '抖音 Cookie 已清除' })
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setIntakeBusy(false)
          setIntakeResult({ ok: false, text: '清除失败：' + String(failure && failure.message ? failure.message : failure) })
        })
      }

      function saveAnalyzer() {
        setIntakeBusy(true)
        var patch = {
          analyzerBaseUrl: analyzerBaseUrl.trim(),
          analyzerModel: analyzerModel.trim(),
        }
        if (analyzerApiKey.trim() !== '') patch.analyzerApiKey = analyzerApiKey.trim()
        postJson('/options', patch).then(function () {
          setIntakeBusy(false)
          setAnalyzerTestResult('API 配置已保存')
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setIntakeBusy(false)
          setAnalyzerTestResult('保存失败：' + String(failure && failure.message ? failure.message : failure))
        })
      }

      function testAnalyzer() {
        setIntakeBusy(true)
        setAnalyzerTestResult('测试中…')
        fetch(BASE + '/analyzer-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(readJson).then(function (result) {
            setIntakeBusy(false)
            if (!result.configured) { setAnalyzerTestResult('未配置：先填 API 地址和模型名'); return }
            setAnalyzerTestResult(result.ok ? 'API 可用（HTTP ' + result.httpStatus + '）' : 'API 失败：' + (result.error || result.httpStatus))
          }).catch(function (failure) {
            setIntakeBusy(false)
            setAnalyzerTestResult('测试失败：' + String(failure && failure.message ? failure.message : failure))
          })
      }

      function exportPassBy() {
        setExportBusy(true)
        setExportResult('')
        fetch(BASE + '/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(readJson).then(function (result) {
            setExportBusy(false)
            setExportResult(result.ok ? '已导出到 ' + result.dir : '导出失败：' + (result.error || '未知错误'))
          }).catch(function (failure) {
            setExportBusy(false)
            setExportResult('导出失败：' + String(failure && failure.message ? failure.message : failure))
          })
      }

      function toggleIntakeMaster(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { masterEnabled: nextValue }),
          }))
        }
        postJson('/options', { intakeEnabled: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function clearCookie() {
        if (!window.confirm('清除已保存的 B 站 Cookie？之后会回到游客模式。')) return
        setIntakeBusy(true)
        postJson('/options', { bilibiliCookie: '' }).then(function () {
          setIntakeBusy(false)
          setIntakeResult({ ok: true, text: 'Cookie 已清除，回到游客模式' })
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setIntakeBusy(false)
          setIntakeResult({ ok: false, text: '清除失败：' + String(failure && failure.message ? failure.message : failure) })
        })
      }

      function toggleUseVision(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { useVision: nextValue }),
          }))
        }
        postJson('/options', { intakeUseVision: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleOnlyPopular(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { onlyPopular: nextValue }),
          }))
        }
        postJson('/options', { intakeOnlyPopular: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleUseAsr(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { useAsr: nextValue }),
          }))
        }
        postJson('/options', { intakeUseAsr: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleLife(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { category: nextValue ? 'life' : 'all' }),
          }))
        }
        postJson('/options', { intakeCategory: nextValue ? 'life' : 'all' }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleReadComments(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { readComments: nextValue }),
          }))
        }
        postJson('/options', { intakeReadComments: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleExternalReflect(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { includeExternalInReflection: nextValue }),
          }))
        }
        postJson('/options', { includeExternalInReflection: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function toggleIntakeAuto(nextValue) {
        if (data) {
          setData(Object.assign({}, data, {
            intake: Object.assign({}, data.intake, { enabled: nextValue }),
          }))
        }
        postJson('/options', { autoIntake: nextValue }).catch(function (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        })
      }

      function saveIntake() {
        setIntakeBusy(true)
        setBiliTest('')
        postJson('/options', intakePatch()).then(function (result) {
          setIntakeBusy(false)
          setCookie('')
          setDouyinCookie('')
          setDouyinLinksDraft('')
          setAnalyzerApiKey('')
          setIntakeResult({ ok: true, text: '输入设置已保存' })
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setIntakeBusy(false)
          setIntakeResult({ ok: false, text: '保存失败：' + String(failure && failure.message ? failure.message : failure) })
        })
      }

      function readOneNow() {
        setIntakeBusy(true)
        setIntakeResult(null)
        postJson('/intake', { force: true }).then(function (result) {
          setIntakeBusy(false)
          if (result.ok) {
            setIntakeResult({ ok: true, text: '读了《' + result.title + '》（' + (result.source === 'subtitle' ? '字幕' : '简介+热评') + '）' })
          } else {
            setIntakeResult({ ok: false, text: describeIntakeFailure(result) })
          }
          return refresh().catch(function () {})
        }).catch(function (failure) {
          setIntakeBusy(false)
          setIntakeResult({ ok: false, text: '请求失败：' + String(failure && failure.message ? failure.message : failure) })
        })
      }

      function testBilibili() {
        setIntakeBusy(true)
        setBiliTest('')
        fetch(BASE + '/bili-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(readJson).then(function (result) {
            setIntakeBusy(false)
            var lines = []
            lines.push('登录 Cookie：' + (result.authenticated ? '已配置' : '未配置'))
            if (result.popular) lines.push('热门列表：' + (result.popular.ok ? '可用（样本 ' + result.popular.count + '）' : '失败 ' + result.popular.error))
            if (result.view) lines.push('视频信息：' + (result.view.ok ? '可用（' + result.view.title + '）' : '失败 ' + result.view.error))
            setBiliTest(lines.join('\n'))
          }).catch(function (failure) {
            setIntakeBusy(false)
            setBiliTest('测试失败：' + String(failure && failure.message ? failure.message : failure))
          })
      }

      function describeIntakeFailure(result) {
        var reason = result.reason
        if (reason === 'popular-failed') return '热门列表获取失败：' + (result.detail || '')
        if (reason === 'video-failed') return '视频信息获取失败：' + (result.detail || '')
        if (reason === 'daily-limit') return '已达每日上限（' + result.todayCount + '/' + result.limit + '）'
        if (reason === 'no-unseen-video') return '热门列表里没有没看过的视频'
        if (reason === 'empty-content') return '这个视频没有字幕、也没有可用简介/评论'
        if (reason === 'summarize-failed') return '总结失败（模型调用出错）'
        if (reason === 'busy') return '正在读取中'
        if (reason === 'disabled') return '自动抓取未开启'
        if (reason === 'feature-disabled') return '刷视频总开关已关闭'
        if (reason === 'no-source') return '没有可用平台：请至少勾选 B站或抖音'
        if (reason === 'douyin-failed') return '抖音解析失败：' + (result.detail || '')
        if (reason === 'timeout') return '读取超时（卡在 ' + (result.stage || '未知') + ' 阶段）'
        return '读取失败：' + (result.detail || reason)
      }

      var groups = []
      if (data) {
        var byCwd = {}
        for (var i = 0; i < data.sessions.length; i += 1) {
          var session = data.sessions[i]
          var key = session.cwd || ''
          if (byCwd[key] === undefined) byCwd[key] = []
          byCwd[key].push(session)
        }
        for (var cwd in byCwd) {
          if (Object.prototype.hasOwnProperty.call(byCwd, cwd)) groups.push({ cwd: cwd, sessions: byCwd[cwd] })
        }
      }

      return h('div', { style: S.page },
        h('div', { style: S.title }, '鱼的反思'),
        h('div', { style: S.dim }, '为启用的会话维护内循环三观与外循环精神、健康、账户余额；默认全关，只对主会话生效，子代理不会参与。'),
        error ? h('div', { style: S.error }, error) : null,
        data === null
          ? h('div', { style: { marginTop: 12 } }, h('span', { style: S.dim }, '正在读取…'))
          : h('div', { style: S.card },
              h('div', { style: S.title }, 'pass by'),
              h('div', { style: S.dim }, '当前状态、成长档案、刷视频心得都收在这里；主设置页只留开关。'),
              h('div', { style: S.footer },
                h('button', { style: S.button, onClick: function () { setPassByOpen(!passByOpen) } }, passByOpen ? '收起' : '打开'),
                h('button', { style: S.button, onClick: exportPassBy, disabled: exportBusy }, exportBusy ? '导出中…' : '导出到 pass by 文件夹'),
                exportResult ? h('span', { style: S.dim }, exportResult) : null,
              ),
              passByOpen
                ? h('div', { style: { marginTop: 10 } },
                    h(Summary, { data: data }),
                    h(GrowthCard, { data: data }),
                    h('div', { style: S.card },
                      h('div', { style: S.title }, '刷视频心得'),
                      (data.intake && data.intake.recent && data.intake.recent.length > 0)
                        ? data.intake.recent.map(function (item) {
                            return h('div', { key: item.at, style: S.note }, '· ' + item.text)
                          })
                        : h('span', { style: S.dim }, '还没有读到任何视频。'),
                    ),
                  )
                : null,
            ),
        data === null
          ? null
          : h(ReflectionCard, {
              data: data,
              busy: reflecting,
              reflecting: reflecting,
              result: reflectResult,
              onReflect: reflectNow,
              onToggleAuto: toggleAuto,
            }),
        data === null
          ? null
          : h(IntakeCard, {
              data: data,
              busy: intakeBusy,
              reading: intakeBusy,
              testing: intakeBusy,
              result: intakeResult,
              testResult: biliTest,
              cookie: cookie,
              onCookie: setCookie,
              onClearCookie: clearCookie,
              douyinCookie: douyinCookie,
              onDouyinCookie: setDouyinCookie,
              onClearDouyinCookie: clearDouyinCookie,
              douyinLinks: douyinLinksDraft,
              onDouyinLinks: setDouyinLinksDraft,
              analyzerBaseUrl: analyzerBaseUrl,
              onAnalyzerBaseUrl: setAnalyzerBaseUrl,
              analyzerApiKey: analyzerApiKey,
              onAnalyzerApiKey: setAnalyzerApiKey,
              analyzerModel: analyzerModel,
              onAnalyzerModel: setAnalyzerModel,
              onSaveAnalyzer: saveAnalyzer,
              onTestAnalyzer: testAnalyzer,
              analyzerTestResult: analyzerTestResult,
              onToggleSource: toggleSource,
              onToggleMaster: toggleIntakeMaster,
              onToggleAuto: toggleIntakeAuto,
              onToggleOnlyPopular: toggleOnlyPopular,
              onToggleLife: toggleLife,
              onToggleUseAsr: toggleUseAsr,
              onToggleUseVision: toggleUseVision,
              onToggleReadComments: toggleReadComments,
              onToggleExternalReflect: toggleExternalReflect,
              onInterval: setIntervalDraft,
              onLimit: setLimitDraft,
              onMaxDuration: setDurationDraft,
              onSave: saveIntake,
              onReadNow: readOneNow,
              onTest: testBilibili,
            }),
        h('div', { style: S.card },
          h('div', { style: S.title }, '启用的会话'),
          h('div', { style: S.dim }, '勾选后，该会话的每一轮会附带一次状态快照，并按输入判断精神与健康。'),
          groups.length === 0
            ? h('div', { style: { marginTop: 10 } }, h('span', { style: S.dim }, '还没有可选的会话。'))
            : groups.map(function (group) {
                return h(WorkspaceGroup, {
                  key: group.cwd,
                  cwd: group.cwd,
                  sessions: group.sessions,
                  selected: selected,
                  onToggle: toggle,
                  onToggleAll: toggleAll,
                })
              }),
          h('div', { style: S.footer },
            h('button', { style: S.button, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
            h('button', { style: S.button, onClick: resetState, disabled: saving }, '重置状态'),
            notice ? h('span', { style: S.dim }, notice) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        var slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', function () {
          return slots.register({
            name: 'settings.section',
            id: 'fish-reflection',
            order: 62,
            label: function () { return '鱼的反思' },
          }, Page)
        })
      },
    }
  },
})
