/**
 * 设置面板：配置反射、语言/主题/自动保存/图片策略的事件装配，
 * 以及「左侧分类导航 + 右侧连续滚动内容」的双栏导航联动。
 *
 * 图片策略的状态由本模块持有（粘贴上下文经 getCurrentImageStrategy 读取）。
 */
import { native } from './native'
import type { UpdateStatus } from './native'
import { applyDomTexts, menuLabels, getLocale, setLocale, t } from './i18n'
import { isDarkTheme } from './theme'
import { isAutosaveOn, setAutosaveOn } from './autosave'
import {
  getImageStrategy,
  setImageStrategy,
  getAutoCheckUpdate,
  setAutoCheckUpdate,
  getCustomCss,
  getThemePreset,
  getThemeFile,
  setThemeFile,
  getSourceLineNumbers,
  setSourceLineNumbers,
  getSpellcheckEnabled,
  setSpellcheckEnabled,
  getFocusMode,
  getTypewriterMode,
} from './store'
import {
  changeThemePreset,
  changeCustomCss,
  changeFileTheme,
  applyFileTheme,
  clearFileTheme,
  resolveThemeSelection,
  displayThemeName,
  FILE_THEME_PREFIX,
} from './theme-presets'
import { reflectTypography, wireTypography } from './typography'
import { setFocusMode, setTypewriterMode } from './writing-modes'
import { renderTabs, updateTitle } from './tabs'
import { reloadFolderTrees, showToast } from './files'
import { currentMarkdown, updateWordCount } from './editor-core'
import type { ImageStrategy } from './paste-image'
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUP_ORDER,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
  formatAccelerator,
  eventToAccelerator,
  isValidShortcut,
  isModifierOnly,
  findConflict,
} from './shortcuts'
import pkg from '../package.json'

/** 粘贴图片存储策略（设置面板配置） */
let imageStrategy: ImageStrategy = getImageStrategy()

/** PicGo 各图床的配置字段定义（label 为 i18n key，placeholder 为示例值） */
export const PICGO_FIELDS: Record<
  string,
  { key: string; label: string; placeholder?: string; type?: string }[]
> = {
  smms: [
    { key: 'token', label: 'Token', placeholder: 'S.EE Dashboard API Token', type: 'password' },
  ],
  github: [
    { key: 'repo', label: '仓库', placeholder: 'owner/repo' },
    { key: 'branch', label: '分支', placeholder: 'main' },
    { key: 'token', label: 'Token', placeholder: 'GitHub Personal Access Token', type: 'password' },
    { key: 'path', label: '路径', placeholder: 'img/' },
    {
      key: 'customUrl',
      label: '自定义域名',
      placeholder: 'https://cdn.jsdelivr.net/gh/owner/repo',
    },
  ],
  qiniu: [
    { key: 'accessKey', label: 'AccessKey', placeholder: '七牛云 AccessKey' },
    { key: 'secretKey', label: 'SecretKey', placeholder: '七牛云 SecretKey', type: 'password' },
    { key: 'bucket', label: 'Bucket', placeholder: '存储空间名称' },
    { key: 'url', label: '访问域名', placeholder: 'https://cdn.example.com' },
    { key: 'area', label: '区域', placeholder: 'z0' },
  ],
  upyun: [
    { key: 'bucket', label: 'Bucket', placeholder: '又拍云服务名' },
    { key: 'operator', label: '操作员', placeholder: '操作员账号' },
    { key: 'password', label: '密码', placeholder: '操作员密码', type: 'password' },
    { key: 'url', label: '访问域名', placeholder: 'https://cdn.example.com' },
  ],
  tcyun: [
    { key: 'secretId', label: 'SecretId', placeholder: '腾讯云 SecretId' },
    { key: 'secretKey', label: 'SecretKey', placeholder: '腾讯云 SecretKey', type: 'password' },
    { key: 'bucket', label: 'Bucket', placeholder: '存储桶名称' },
    { key: 'appId', label: 'AppId', placeholder: '腾讯云 AppId' },
    { key: 'area', label: '区域', placeholder: 'ap-shanghai' },
    { key: 'path', label: '路径', placeholder: 'img/' },
  ],
  aliyun: [
    { key: 'accessKeyId', label: 'AccessKeyId', placeholder: '阿里云 AccessKeyId' },
    {
      key: 'accessKeySecret',
      label: 'AccessKeySecret',
      placeholder: '阿里云 AccessKeySecret',
      type: 'password',
    },
    { key: 'bucket', label: 'Bucket', placeholder: '存储空间名称' },
    { key: 'area', label: '区域', placeholder: 'oss-cn-hangzhou' },
    { key: 'path', label: '路径', placeholder: 'img/' },
  ],
  imgur: [{ key: 'clientId', label: 'Client ID', placeholder: 'Imgur Client ID' }],
}

/** 粘贴图片上下文读取当前策略（main.ts 装配注入） */
export function getCurrentImageStrategy(): ImageStrategy {
  return imageStrategy
}

/**
 * 渲染指定图床的配置字段输入框
 * @param uploader 图床类型
 * @param values 已有配置值
 */
function renderPicGoFields(uploader: string, values: Record<string, string> = {}) {
  const container = document.getElementById('picgo-fields')
  if (!container) return
  const fields = PICGO_FIELDS[uploader] || []
  container.innerHTML = fields
    .map(
      (f) => `
    <div class="settings-row">
      <label class="settings-row-label" for="picgo-${f.key}">${f.label}</label>
      <input id="picgo-${f.key}" class="settings-input" type="${f.type || 'text'}"
        value="${values[f.key] || ''}" placeholder="${f.placeholder || ''}" />
    </div>`,
    )
    .join('')
}

/** 根据当前图片策略显示/隐藏图床配置区域 */
function togglePicGoSection() {
  const section = document.getElementById('picgo-config-section')
  if (!section) return
  section.style.display = imageStrategy === 'hosting' ? '' : 'none'
}

/** 加载 PicGo 配置并填充到表单 */
async function loadPicGoConfig() {
  if (!native) return
  const config = await native.getPicGoConfig()
  const uploader = (config.current as string) || 'smms'
  const select = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  if (select) select.value = uploader
  const values = (config[uploader] as Record<string, string>) || {}
  renderPicGoFields(uploader, values)
}

/** 保存 PicGo 配置 */
async function savePicGoConfig() {
  if (!native) return
  const select = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  const uploader = select?.value || 'smms'
  const fields = PICGO_FIELDS[uploader] || []
  const values: Record<string, string> = {}
  for (const f of fields) {
    const input = document.getElementById(`picgo-${f.key}`) as HTMLInputElement | null
    values[f.key] = input?.value || ''
  }
  const statusEl = document.getElementById('picgo-save-status')
  const ok = await native.savePicGoConfig({ current: uploader, [uploader]: values })
  if (statusEl) {
    statusEl.textContent = t(ok ? 'settings.picgoSaved' : 'settings.picgoSaveFailed')
    setTimeout(() => {
      if (statusEl) statusEl.textContent = ''
    }, 3000)
  }
}

/** 源码模式行号开关应用到 DOM（body.src-no-linenos 经 CSS 隐藏 gutter，不触碰编辑器实例） */
export function applySourceLineNumbers() {
  document.body.classList.toggle('src-no-linenos', !getSourceLineNumbers())
}

/**
 * 拼写检查开关应用到 DOM：写在编辑区容器 #panes 上，动态创建的
 * ProseMirror / CodeMirror 可编辑根经 spellcheck 属性继承获得，无需重建编辑器。
 * Chromium 对可编辑内容默认开启，因此必须显式写 true/false，不能移除属性。
 */
export function applySpellcheck() {
  document.getElementById('panes')?.setAttribute('spellcheck', String(getSpellcheckEnabled()))
}

// ---------------------------------------------------------------------------
// 快捷键自定义
// ---------------------------------------------------------------------------

/** 快捷键分组显示文案（文件/导出/格式复用菜单词条，编辑器组单独定义） */
const SHORTCUT_GROUP_LABELS: Record<string, string> = {
  file: 'menu.file',
  export: 'menu.export',
  format: 'menu.format',
  editor: 'settings.shortcutGroupEditor',
}

/** 当前处于按键捕获状态的 action（null 表示未捕获） */
let capturingAction: string | null = null

/** 渲染快捷键列表：按分组展示，每行为名称 + 就近错误提示 + 可点击的按键按钮 */
function renderShortcuts() {
  const container = document.getElementById('shortcuts-list')
  if (!container) return
  const shortcuts = loadShortcuts()
  container.innerHTML = SHORTCUT_GROUP_ORDER.map((group) => {
    const defs = SHORTCUT_DEFS.filter((d) => d.group === group)
    if (!defs.length) return ''
    const rows = defs
      .map(
        (d) =>
          '<div class="shortcut-row">' +
          `<span class="shortcut-label">${t(d.labelKey)}</span>` +
          '<span class="shortcut-error"></span>' +
          `<button type="button" class="shortcut-key" data-action="${d.action}">` +
          `${formatAccelerator(shortcuts[d.action])}</button>` +
          '</div>',
      )
      .join('')
    const title = t(SHORTCUT_GROUP_LABELS[group] ?? group)
    return `<div class="shortcut-group"><div class="shortcut-group-title">${title}</div>${rows}</div>`
  }).join('')
}

/** 退出按键捕获态（仅清理状态与监听，列表重建由调用方决定） */
function endCapture() {
  capturingAction = null
  document.removeEventListener('keydown', onCaptureKeydown, true)
}

/** 在状态栏提示一条信息，3 秒后自动清除 */
function showShortcutStatus(text: string) {
  const el = document.getElementById('shortcuts-status')
  if (!el) return
  el.textContent = text
  if (text)
    setTimeout(() => {
      if (el.textContent === text) el.textContent = ''
    }, 3000)
}

/** 在指定快捷键行内就近显示错误提示（避免提示被挤到面板底部看不见） */
function showRowError(action: string, text: string) {
  const btn = document.querySelector(`.shortcut-key[data-action="${action}"]`)
  const el = btn?.closest('.shortcut-row')?.querySelector('.shortcut-error')
  if (el) el.textContent = text
}

/** 捕获期间的 keydown 处理器（capture 阶段拦截，避免触发编辑器内快捷键） */
function onCaptureKeydown(e: KeyboardEvent) {
  if (!capturingAction) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    endCapture()
    renderShortcuts()
    return
  }
  const acc = eventToAccelerator(e)
  // 仅按下了修饰键（尚未按主键）时不提交，等待完整组合
  if (isModifierOnly(acc)) return
  const action = capturingAction
  if (!isValidShortcut(acc)) {
    showRowError(action, t('settings.shortcutInvalid'))
    return
  }
  const conflict = findConflict(acc, action, loadShortcuts())
  if (conflict) {
    const def = SHORTCUT_DEFS.find((d) => d.action === conflict)
    showRowError(action, t('settings.shortcutConflict', { name: def ? t(def.labelKey) : conflict }))
    return
  }
  saveShortcuts({ [action]: acc })
  endCapture()
  renderShortcuts()
  // 同步主进程菜单 accelerator，保持两处一致
  native?.syncShortcuts(loadShortcuts())
}

/** 进入按键捕获态：高亮目标按钮并监听下一次组合键 */
function startCapture(action: string) {
  endCapture()
  capturingAction = action
  renderShortcuts()
  document.addEventListener('keydown', onCaptureKeydown, true)
  const btn = document.querySelector(
    `.shortcut-key[data-action="${action}"]`,
  ) as HTMLButtonElement | null
  if (btn) {
    btn.classList.add('capturing')
    btn.textContent = t('settings.shortcutCapture')
  }
}

/** 同步主题 radio 高亮：内置预设 / 深色 / 文件主题三态统一映射 */
function syncPresetRadio(): void {
  const value = resolveThemeSelection(isDarkTheme(), getThemePreset(), getThemeFile())
  document.querySelectorAll<HTMLInputElement>('input[name="set-preset"]').forEach((input) => {
    if (input.value === value) input.checked = true
  })
}

/**
 * 扫描主题目录并把文件主题渲染为 radio 项（每次打开设置/刷新时整体重建）。
 * 浏览器环境无 IPC，整个文件主题区保持隐藏。
 * @returns 最新主题文件名列表（刷新时据此判断当前主题是否已被删除）
 */
async function renderFileThemes(): Promise<string[]> {
  const area = document.getElementById('set-file-theme-area')
  const container = document.getElementById('set-file-themes')
  if (!area || !container) return []
  if (!native) {
    area.hidden = true
    return []
  }
  area.hidden = false
  const { themes } = await native.listThemes()
  const current = getThemeFile()
  container.replaceChildren()
  for (const theme of themes) {
    const label = document.createElement('label')
    label.className = 'settings-option'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'set-preset'
    radio.value = FILE_THEME_PREFIX + theme.name
    radio.checked = theme.name === current
    radio.addEventListener('change', () => {
      void selectFileTheme(theme.name)
    })
    const span = document.createElement('span')
    // textContent 赋值，文件名不经过 HTML 解析
    span.textContent = displayThemeName(theme.name)
    label.append(radio, span)
    container.appendChild(label)
  }
  return themes.map((theme) => theme.name)
}

/** 选中某个文件式主题：读取 CSS 并注入；读取失败（竞态删除）则提示并重扫 */
async function selectFileTheme(fileName: string): Promise<void> {
  if (!native) return
  const css = await native.readTheme(fileName)
  if (css == null) {
    showToast(t('settings.themeFileMissing', { name: fileName }))
    await renderFileThemes()
    syncPresetRadio()
    return
  }
  changeFileTheme(fileName, css)
}

/**
 * 「刷新」按钮：重新扫描主题目录。
 * - 当前主题文件已被删除：撤出文件主题层（回落内置变量）并提示
 * - 当前主题仍在：重新读取内容并注入（承接外部编辑器的修改）
 */
async function refreshFileThemes(): Promise<void> {
  if (!native) return
  const names = await renderFileThemes()
  const current = getThemeFile()
  if (!current) return
  if (!names.includes(current)) {
    setThemeFile('')
    clearFileTheme()
    showToast(t('settings.themeFileMissing', { name: current }))
    syncPresetRadio()
    return
  }
  // 文件仍在：重载内容（承接外部编辑器的修改）；扫描与读取之间被删的竞态
  // 同样按缺失回落
  const css = await native.readTheme(current)
  if (css == null) {
    setThemeFile('')
    clearFileTheme()
    showToast(t('settings.themeFileMissing', { name: current }))
    syncPresetRadio()
    return
  }
  applyFileTheme(css)
}

// ---------------------------------------------------------------------------
// 设置面板分类导航
// ---------------------------------------------------------------------------

/** 导航分类 → 该类包含的区块 id（按 DOM 顺序排列；点击定位到首个区块） */
const NAV_SECTIONS: { target: string; sections: string[] }[] = [
  { target: 'sec-theme', sections: ['sec-theme', 'sec-css', 'sec-lang'] },
  { target: 'sec-typography', sections: ['sec-typography'] },
  { target: 'sec-linenos', sections: ['sec-linenos', 'sec-spellcheck', 'sec-writing'] },
  { target: 'sec-autosave', sections: ['sec-autosave', 'sec-image', 'picgo-config-section'] },
  { target: 'sec-shortcuts', sections: ['sec-shortcuts'] },
  { target: 'sec-update', sections: ['sec-update', 'logs-section'] },
  { target: 'sec-about', sections: ['sec-about'] },
]

/**
 * 装配分类导航：点击平滑定位，滚动时左侧高亮自动跟随。
 * 跟随判定取「顶部已越过内容窗顶部（32px 容差）」的最后一个区块；
 * display:none 的区块（图床配置按策略显隐、浏览器下日志区隐藏）不参与定位。
 * 滚到底部时末尾区块可能够不到顶部阈值（下方内容不足一屏），强制落末类。
 */
function wireSettingsNav() {
  const content = document.getElementById('settings-content')
  const items = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item'),
  )
  if (!content || !items.length) return
  const sectionEls = NAV_SECTIONS.flatMap((cat) => cat.sections)
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el)
  const categoryOf = new Map<string, string>()
  for (const cat of NAV_SECTIONS) for (const sid of cat.sections) categoryOf.set(sid, cat.target)
  const setActive = (target: string) =>
    items.forEach((it) => it.classList.toggle('active', it.dataset.navTarget === target))

  items.forEach((it) => {
    it.addEventListener('click', () => {
      const target = it.dataset.navTarget
      const el = target ? document.getElementById(target) : null
      if (!el || !target) return
      setActive(target)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  content.addEventListener('scroll', () => {
    let current = NAV_SECTIONS[0].target
    for (const s of sectionEls) {
      if (!s.offsetParent) continue
      if (s.offsetTop - content.scrollTop > 32) break
      current = categoryOf.get(s.id) ?? current
    }
    const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 4
    if (atBottom) {
      for (let i = sectionEls.length - 1; i >= 0; i--) {
        if (sectionEls[i].offsetParent) {
          current = categoryOf.get(sectionEls[i].id) ?? current
          break
        }
      }
    }
    setActive(current)
  })
}

/** 打开设置面板并反映当前配置值 */
export function openSettings() {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return

  const langRadio = overlay.querySelector(
    `input[name="set-lang"][value="${getLocale()}"]`,
  ) as HTMLInputElement | null
  if (langRadio) langRadio.checked = true
  // 主题列表高亮：内置预设 / 深色 / 文件主题三态统一由纯函数映射
  syncPresetRadio()
  // 文件式主题：Electron 环境下扫描主题目录渲染外部 radio 项
  void renderFileThemes()
  const autosaveBox = document.getElementById('set-autosave') as HTMLInputElement | null
  if (autosaveBox) {
    autosaveBox.checked = isAutosaveOn() && !!native
    autosaveBox.disabled = !native
  }
  const imgRadio = overlay.querySelector(
    `input[name="set-img"][value="${imageStrategy}"]`,
  ) as HTMLInputElement | null
  if (imgRadio) imgRadio.checked = true
  const cssBox = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
  if (cssBox) cssBox.value = getCustomCss()
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) autoCheckBox.checked = getAutoCheckUpdate()
  const linenoBox = document.getElementById('set-linenos') as HTMLInputElement | null
  if (linenoBox) linenoBox.checked = getSourceLineNumbers()
  const spellcheckBox = document.getElementById('set-spellcheck') as HTMLInputElement | null
  if (spellcheckBox) spellcheckBox.checked = getSpellcheckEnabled()
  const focusBox = document.getElementById('set-focus-mode') as HTMLInputElement | null
  if (focusBox) focusBox.checked = getFocusMode()
  const typewriterBox = document.getElementById('set-typewriter-mode') as HTMLInputElement | null
  if (typewriterBox) typewriterBox.checked = getTypewriterMode()
  // 排版设置反射（typography 模块自持）
  reflectTypography()

  // 关于面板：版本号从 package.json 读取，避免手动同步遗漏
  const versionEl = document.getElementById('about-version')
  if (versionEl) versionEl.textContent = pkg.version

  // 关于面板：版权年份为「首次发布年份 - 最近发布年份」，起始年固定，结束年随当前年份自动更新
  const copyrightEl = document.getElementById('about-copyright')
  if (copyrightEl) {
    const startYear = 2026
    const currentYear = new Date().getFullYear()
    copyrightEl.textContent = `© ${startYear}${
      currentYear > startYear ? `-${currentYear}` : ''
    } chiangyang`
  }

  // 图床配置：加载并根据图片策略显示/隐藏
  togglePicGoSection()
  void loadPicGoConfig()

  // 快捷键列表：按当前配置渲染
  renderShortcuts()

  // 打开时回到顶部并高亮第一类：保留上次滚动位置会显得面板「没刷新」
  const content = document.getElementById('settings-content')
  if (content) content.scrollTop = 0
  document.querySelectorAll('#settings-nav .settings-nav-item').forEach((it, idx) => {
    it.classList.toggle('active', idx === 0)
  })

  overlay.hidden = false
}

/** 关闭设置面板 */
export function closeSettings() {
  endCapture()
  document.getElementById('settings-overlay')?.setAttribute('hidden', '')
}

/** 设置面板全部控件事件装配（boot 时调用一次） */
export function wireSettings() {
  // 排版区控件由 typography 模块自装
  wireTypography()
  // 分类导航：点击定位 + 滚动高亮跟随
  wireSettingsNav()
  document.getElementById('settings-close')?.addEventListener('click', closeSettings)
  document.getElementById('settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings()
  })
  document.querySelectorAll('input[name="set-lang"]').forEach((input) => {
    input.addEventListener('change', () => {
      setLocale((input as HTMLInputElement).value)
      // 语言切换六联动：静态文案 / <html lang> / 标签栏 / 标题 / 字数 / 菜单与排序
      applyDomTexts()
      renderTabs()
      updateTitle()
      updateWordCount(currentMarkdown())
      native?.setLocaleInfo({ labels: menuLabels(), locale: getLocale() })
      // 文件名排序随界面语言变化，已加载的目录树需按新规则重读
      void reloadFolderTrees()
      // 文件主题列表同样按新语言区域排序，重扫一次
      void renderFileThemes()
    })
  })
  // 主题列表：持久化 + 即时应用（纯 CSS 变量层，不触碰编辑器）；
  // 深色项 = 切换到主界面深色模式。动态渲染的文件主题 radio 在
  // renderFileThemes() 中单独绑定（changeFileTheme），与此处内置项互斥。
  document.querySelectorAll('input[name="set-preset"]').forEach((input) => {
    input.addEventListener('change', () => {
      changeThemePreset((input as HTMLInputElement).value)
    })
  })
  // 文件式主题：打开主题文件夹（空目录时主进程创建并写入示例主题）
  document.getElementById('themes-open-dir-btn')?.addEventListener('click', () => {
    void native?.openThemesDir().then((ok) => {
      if (!ok) showToast(t('settings.themesOpenFailed'))
    })
  })
  // 刷新：重新扫描主题目录；当前主题被删则回落内置，仍在则重载文件内容
  // （外部编辑器改完 CSS 保存后点此按钮即生效，不做常驻文件监听）
  document.getElementById('themes-refresh-btn')?.addEventListener('click', () => {
    void refreshFileThemes()
  })
  // 日志与诊断：整个小节仅桌面环境存在（浏览器无本地目录 / IPC）
  if (!native) document.getElementById('logs-section')?.setAttribute('hidden', '')
  document.getElementById('logs-open-dir-btn')?.addEventListener('click', () => {
    void native?.openLogsDir().then((ok) => {
      if (!ok) showToast(t('settings.logsOpenFailed'))
    })
  })
  // 自定义 CSS：输入即应用（防抖交给 input 事件天然节流），「恢复默认」清空
  const cssBox = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
  if (cssBox) {
    cssBox.addEventListener('input', () => {
      changeCustomCss(cssBox.value)
    })
  }
  document.getElementById('css-reset-btn')?.addEventListener('click', () => {
    const box = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
    if (box) {
      box.value = ''
      changeCustomCss('')
    }
  })
  document.getElementById('set-autosave')?.addEventListener('change', (e) => {
    setAutosaveOn((e.target as HTMLInputElement).checked)
  })
  // 源码模式行号开关：持久化 + body class 即时生效（源码模式开着时切换立即变化）
  document.getElementById('set-linenos')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked
    setSourceLineNumbers(enabled)
    document.body.classList.toggle('src-no-linenos', !enabled)
  })
  // 拼写检查开关：持久化 + 容器 spellcheck 属性即时生效（可编辑根经继承获得，无需重建）
  document.getElementById('set-spellcheck')?.addEventListener('change', (e) => {
    setSpellcheckEnabled((e.target as HTMLInputElement).checked)
    applySpellcheck()
  })
  // 专注 / 打字机模式：writing-modes 模块自持持久化与即时生效
  document.getElementById('set-focus-mode')?.addEventListener('change', (e) => {
    setFocusMode((e.target as HTMLInputElement).checked)
  })
  document.getElementById('set-typewriter-mode')?.addEventListener('change', (e) => {
    setTypewriterMode((e.target as HTMLInputElement).checked)
  })
  document.querySelectorAll('input[name="set-img"]').forEach((input) => {
    input.addEventListener('change', () => {
      imageStrategy = (input as HTMLInputElement).value as ImageStrategy
      setImageStrategy(imageStrategy)
      togglePicGoSection()
    })
  })

  // 图床类型切换：重新渲染对应配置字段
  const picgoUploader = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  picgoUploader?.addEventListener('change', () => {
    renderPicGoFields(picgoUploader.value)
  })
  // 保存图床配置
  document.getElementById('picgo-save-btn')?.addEventListener('click', () => {
    void savePicGoConfig()
  })

  // 快捷键：点击按键框进入捕获态；点击列表空白处取消捕获
  const shortcutsList = document.getElementById('shortcuts-list')
  shortcutsList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.shortcut-key') as HTMLButtonElement | null
    if (btn?.dataset.action) {
      startCapture(btn.dataset.action)
    } else {
      endCapture()
      renderShortcuts()
    }
  })
  // 恢复默认快捷键：清空覆盖项并重新同步主进程菜单
  document.getElementById('shortcuts-reset-btn')?.addEventListener('click', () => {
    resetShortcuts()
    endCapture()
    renderShortcuts()
    native?.syncShortcuts(loadShortcuts())
    showShortcutStatus(t('settings.shortcutResetDone'))
  })

  // ---------- 更新 ----------
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) {
    autoCheckBox.addEventListener('change', () => {
      setAutoCheckUpdate(autoCheckBox.checked)
      native?.setAutoCheckUpdate(autoCheckBox.checked)
    })
  }

  const updateCheckBtn = document.getElementById('update-check-btn') as HTMLButtonElement | null
  const updateStatus = document.getElementById('update-status')
  const updateInstallBtn = document.getElementById('update-install-btn') as HTMLButtonElement | null
  updateCheckBtn?.addEventListener('click', () => {
    void native?.checkForUpdates()
  })
  updateInstallBtn?.addEventListener('click', () => {
    native?.installUpdate()
  })

  /** 根据更新状态刷新设置面板文案与按钮可用性 */
  const applyUpdateStatus = (status: UpdateStatus) => {
    if (!updateStatus || !updateCheckBtn || !updateInstallBtn) return
    switch (status.status) {
      case 'idle':
        updateStatus.textContent = ''
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'checking':
        updateStatus.textContent = t('settings.updateChecking')
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'available':
        updateStatus.textContent = t('settings.updateAvailable', { version: status.version })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'not-available':
        updateStatus.textContent = t('settings.updateNotAvailable')
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'downloading':
        updateStatus.textContent = t('settings.updateDownloading', {
          percent: Math.round(status.percent),
        })
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'downloaded':
        updateStatus.textContent = t('settings.updateDownloaded')
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = false
        break
      case 'error':
        updateStatus.textContent = t('settings.updateError', { message: status.message })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
    }
  }
  native?.onUpdateStatus(applyUpdateStatus)

  // 启动时把"启动时自动检查更新"开关同步给主进程
  // （主进程据此决定是否在 app 启动后 5 秒自动检查）
  native?.setAutoCheckUpdate(getAutoCheckUpdate())

  // 关于面板：外部链接交由主进程用系统默认浏览器打开（避免 file:// 内嵌跳转）
  document.querySelectorAll<HTMLAnchorElement>('a[data-external]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      void native?.openExternal(link.href)
    })
  })
}
