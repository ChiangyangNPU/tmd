/**
 * 设置面板——AI 助手配置：表单回填、增量保存、连通性测试与 Key 管理。
 * Key 明文只存在于主进程（safeStorage），渲染层拿不到也不回显。
 */
import type { AiConfigPatch, AiConfigView } from '../native'
import { aiErrorMessage, fetchAiConfig, isAiAvailable, saveAiConfig, testAiConnection } from '../ai'
import { t } from '../i18n'

/** 最近一次加载的配置视图：保留服务商预设，供切换时回填默认地址与模型 */
let aiConfigView: AiConfigView | null = null

/**
 * AI 表单是否已被用户修改：loadAiConfig 是异步的，若用户在回填完成前
 * 就勾选/输入，applyAiConfigView 不得用旧值覆盖用户输入，否则会出现
 * 「勾选用后保存却变回未勾选」的竞态。
 */
let aiFormDirty = false

/** 用户修改任一 AI 控件后置脏（wire 装配时绑定） */
function markAiDirty() {
  aiFormDirty = true
}

/** 打开面板时重置脏标记：随后的异步回填视为可信（openSettings 调用） */
export function resetAiFormDirty() {
  aiFormDirty = false
}

/** 浏览器环境无壳层 API：整块 AI 区与左侧导航项一并隐藏 */
export function toggleAiSection() {
  if (isAiAvailable()) return
  document.getElementById('sec-ai')?.setAttribute('hidden', '')
  document.querySelector('.settings-nav-item[data-nav-target="sec-ai"]')?.setAttribute('hidden', '')
}

/** 重建服务商下拉（预设由主进程下发，避免渲染层重复维护一份表） */
function renderAiProviders(view: AiConfigView) {
  const select = document.getElementById('ai-provider') as HTMLSelectElement | null
  if (!select) return
  select.textContent = ''
  for (const preset of view.providers) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.label
    select.appendChild(option)
  }
}

/** 更新 Key 状态提示、占位点与「清除」按钮可用性（回填 / 保存 Key / 清除 Key 共用） */
function updateAiKeyHint(view: AiConfigView) {
  const keyHint = document.getElementById('ai-key-hint')
  if (keyHint) {
    keyHint.textContent = t(view.hasApiKey ? 'settings.aiKeyStored' : 'settings.aiKeyMissing')
  }
  // 输入框不回显明文（渲染层拿不到 Key），已保存时用等长占位点示意：
  // 点是 placeholder，值仍为空，留空 = 保持不变 的语义不受影响
  const keyInput = document.getElementById('ai-api-key') as HTMLInputElement | null
  if (keyInput) {
    keyInput.placeholder = view.hasApiKey ? '•'.repeat(view.apiKeyLength) : ''
  }
  const clearBtn = document.getElementById('ai-clear-key-btn') as HTMLButtonElement | null
  if (clearBtn) clearBtn.disabled = !view.hasApiKey
}

/**
 * 把配置视图回填到表单。
 * Key 输入框永远留空：主进程不返回明文，占位提示「已保存」即代表有 Key；
 * 用户输入新值才会覆盖，留空表示保持不变。
 * @param view - 配置视图
 * @param fromLoad - 是否来自加载回填（true 时若用户已修改表单则跳过，避免竞态覆盖）
 */
function applyAiConfigView(view: AiConfigView, fromLoad = false) {
  // 加载回填时用户已改过表单：保留用户输入，只用新视图更新 providers 列表与 Key 状态
  if (fromLoad && aiFormDirty) {
    aiConfigView = view
    renderAiProviders(view)
    updateAiKeyHint(view)
    return
  }
  aiConfigView = view
  renderAiProviders(view)
  const setValue = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) el.value = value
  }
  const setChecked = (id: string, value: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) el.checked = value
  }
  setChecked('set-ai-enabled', view.enabled)
  const provider = document.getElementById('ai-provider') as HTMLSelectElement | null
  if (provider) provider.value = view.provider
  setValue('ai-base-url', view.baseUrl)
  setValue('ai-model', view.model)
  setValue('ai-temperature', String(view.temperature))
  setValue('ai-embed-model', view.embedModel)
  setValue('ai-api-key', '')
  setChecked('ai-context-selection', view.context.selection)
  setChecked('ai-context-document', view.context.document)
  setChecked('ai-context-workspace', view.context.workspace)
  updateAiKeyHint(view)
}

/** 从表单收集配置增量（Key 为空表示不修改；温度非法则交给主进程兜底） */
function collectAiPatch(): AiConfigPatch {
  const value = (id: string) =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? ''
  const checked = (id: string) =>
    !!(document.getElementById(id) as HTMLInputElement | null)?.checked
  const temperature = Number(value('ai-temperature'))
  const patch: AiConfigPatch = {
    enabled: checked('set-ai-enabled'),
    provider: (document.getElementById('ai-provider') as HTMLSelectElement | null)?.value,
    baseUrl: value('ai-base-url'),
    model: value('ai-model'),
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    embedModel: value('ai-embed-model'),
    context: {
      selection: checked('ai-context-selection'),
      document: checked('ai-context-document'),
      workspace: checked('ai-context-workspace'),
    },
  }
  const apiKey = value('ai-api-key').trim()
  if (apiKey) patch.apiKey = apiKey
  return patch
}

/** 显示 AI 区状态文案（3 秒后清空，避免常驻） */
function showAiStatus(text: string) {
  const status = document.getElementById('ai-status')
  if (!status) return
  status.textContent = text
  if (text) {
    setTimeout(() => {
      if (status.textContent === text) status.textContent = ''
    }, 3000)
  }
}

/** 加载 AI 配置并回填设置面板 */
export async function loadAiConfig() {
  if (!isAiAvailable()) return
  const view = await fetchAiConfig()
  if (view) applyAiConfigView(view, true)
}

/** 保存 AI 配置（Key 输入框有值才更新） */
async function saveAiSettings() {
  const view = await saveAiConfig(collectAiPatch())
  if (!view) {
    showAiStatus(t('settings.aiSaveFailed'))
    return
  }
  aiFormDirty = false
  applyAiConfigView(view)
  // 通知选区气泡等模块刷新启用状态（避免每帧读配置）
  window.dispatchEvent(new Event('tmd:ai-config-changed'))
  showAiStatus(t('settings.aiSaved'))
}

/** 连通性测试：直接使用表单当前值，无需先保存 */
async function testAiSettings() {
  showAiStatus(t('settings.aiTesting'))
  const result = await testAiConnection(collectAiPatch())
  showAiStatus(
    result.ok
      ? t('settings.aiTestOk', { ms: result.latencyMs })
      : `${t('settings.aiTestFailed')}: ${aiErrorMessage(result.code, result.message)}`,
  )
}

/** 清除已保存的 Key（立即落盘并刷新状态） */
async function clearAiKey() {
  const view = await saveAiConfig({ clearApiKey: true })
  if (!view) {
    showAiStatus(t('settings.aiSaveFailed'))
    return
  }
  applyAiConfigView(view)
  window.dispatchEvent(new Event('tmd:ai-config-changed'))
  showAiStatus(t('settings.aiKeyCleared'))
}

/**
 * 仅保存 Key 输入框当前值（Key 行内的「保存」按钮）。
 *
 * 走单字段增量 patch，不触发整表单回填——用户可能还有地址 / 模型等
 * 未保存的输入，整表单刷新会把它们冲掉；这里只清空 Key 输入框并更新
 * 状态提示，其余表单内容原样保留。
 */
async function saveAiKey() {
  const input = document.getElementById('ai-api-key') as HTMLInputElement | null
  const apiKey = input?.value.trim() ?? ''
  if (!apiKey) {
    showAiStatus(t('settings.aiKeyFillFirst'))
    return
  }
  const view = await saveAiConfig({ apiKey })
  if (!view) {
    showAiStatus(t('settings.aiSaveFailed'))
    return
  }
  if (input) input.value = ''
  updateAiKeyHint(view)
  window.dispatchEvent(new Event('tmd:ai-config-changed'))
  showAiStatus(t('settings.aiSaved'))
}

/**
 * 「启用 AI 助手」总开关即拨即存。
 *
 * 开关是用户对「要不要用 AI」的即时决策，若混在整表单的显式保存里，
 * 拨完不点「保存 AI 配置」就退出面板，重进时会被磁盘值刷回关闭，
 * 看起来像「自动被关掉」。其余字段（地址 / 模型 / Key 等）仍走显式保存，
 * 便于整组修改后统一「测试连接」。单字段增量落盘，不覆盖表单里
 * 尚未保存的其他输入。
 */
async function onAiEnabledToggle() {
  if (!isAiAvailable()) return
  const box = document.getElementById('set-ai-enabled') as HTMLInputElement | null
  if (!box) return
  const view = await saveAiConfig({ enabled: box.checked })
  if (!view) {
    // 保存失败：把开关拨回磁盘状态，避免界面与实际配置背离
    box.checked = (await fetchAiConfig())?.enabled === true
    showAiStatus(t('settings.aiSaveFailed'))
    return
  }
  window.dispatchEvent(new Event('tmd:ai-config-changed'))
  showAiStatus(t('settings.aiSaved'))
}

/** 切换服务商：回填该预设的默认接口地址与模型名（自定义留空由用户填写） */
function onAiProviderChange() {
  if (!aiConfigView) return
  const select = document.getElementById('ai-provider') as HTMLSelectElement | null
  const preset = aiConfigView.providers.find((p) => p.id === select?.value)
  if (!preset) return
  const baseUrl = document.getElementById('ai-base-url') as HTMLInputElement | null
  const model = document.getElementById('ai-model') as HTMLInputElement | null
  if (baseUrl) baseUrl.value = preset.baseUrl
  if (model) model.value = preset.model
}

/** AI 区控件的事件装配（wireSettings 编排调用） */
export function wireAiSection() {
  // AI 助手：浏览器环境整块隐藏；保存 / 测试 / 清除 Key / 切换服务商
  toggleAiSection()
  // 任意 AI 控件被用户修改后置脏，阻止异步回填覆盖用户输入
  ;[
    'set-ai-enabled',
    'ai-provider',
    'ai-base-url',
    'ai-model',
    'ai-api-key',
    'ai-temperature',
    'ai-embed-model',
    'ai-context-selection',
    'ai-context-document',
    'ai-context-workspace',
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', markAiDirty)
    document.getElementById(id)?.addEventListener('input', markAiDirty)
  })
  // 总开关即拨即存（注册在 markAiDirty 之后：change 先置脏、再触发保存）
  document.getElementById('set-ai-enabled')?.addEventListener('change', () => {
    void onAiEnabledToggle()
  })
  document.getElementById('ai-save-btn')?.addEventListener('click', () => {
    void saveAiSettings()
  })
  document.getElementById('ai-test-btn')?.addEventListener('click', () => {
    void testAiSettings()
  })
  document.getElementById('ai-clear-key-btn')?.addEventListener('click', () => {
    void clearAiKey()
  })
  document.getElementById('ai-save-key-btn')?.addEventListener('click', () => {
    void saveAiKey()
  })
  document.getElementById('ai-provider')?.addEventListener('change', onAiProviderChange)
}
