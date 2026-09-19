/**
 * TMD - 轻量跨平台 Markdown 所见即所得编辑器
 *
 * 应用启动入口：纯装配——hooks/上下文注入、快捷键、菜单回调、侧边栏切换。
 * 各领域逻辑分居 editor-core / tabs / files / settings / autosave / theme /
 * store / findbar 等模块。
 *
 * 渲染层不含任何 Node/Electron API——系统能力统一经 src/native.ts 的
 * 受控接口访问，保证同一份代码可同时运行在 Electron 与浏览器中。
 *
 * @author chiangyang
 */
import '@milkdown/kit/prose/view/style/prosemirror.css'
import 'katex/dist/katex.min.css'
import './style.css'

import { setMermaidTheme } from './mermaid'
import { insertToc } from './toc'
import { openFindBar, wireFindBar } from './findbar'
import { collectOutline, renderOutline } from './outline'
import { native } from './native'
import { t, applyDomTexts, menuLabels, getLocale } from './i18n'
import { setImagePasteContext } from './paste-image'
import { applyTheme } from './theme'
import { restoreThemeStyles, restoreFileTheme } from './theme-presets'
import {
  activeTab,
  getActiveTabId,
  setActiveTabId,
  hasDirty,
  getActiveBaseDir,
  newTab,
  renderTabs,
  closeTab,
  nextUntitledName,
  createNewTab,
  updateTitle,
  markDirty,
} from './tabs'
import {
  openDocument,
  openFolder,
  openPath,
  saveDocument,
  renderFilesSidebar,
  clearRecentDocuments,
  clearFolderEntries,
  showToast,
} from './files'
import { wireDragDrop } from './dragdrop'
import { applyFormatAction, wireLinkBar, closeLinkBar } from './format'
import { wireContextMenu, closeContextMenu } from './context-menu'
import { wireTabMenu } from './tab-menu'
import { setLinkNavContext, wireLinkNav } from './link-nav'
import { openQuickSwitch, closeQuickSwitch, wireQuickSwitch } from './quick-switch'
import { openSearch, closeSearch, wireSearch } from './search'
import { wireSplit } from './split'
import { openHistory, wireHistory } from './history'
import { wireTableToolbar } from './table-toolbar'
import { normalizeEmptyTableCells } from './table-markdown'
import {
  mountEditor,
  currentMarkdown,
  replaceEditor,
  setSourceMode,
  setViewMode,
  getViewMode,
  updateWordCount,
  getPmView,
  isSourceMode,
  setEditorHooks,
  flushMarkdownSync,
} from './editor-core'
import { initAutosave, setAutosaveOn, stopAutosave } from './autosave'
import {
  openSettings,
  closeSettings,
  wireSettings,
  getCurrentImageStrategy,
  applySourceLineNumbers,
  applySpellcheck,
} from './settings'
import { applyTypography } from './typography'
import { applyWritingModes, wireTypewriter } from './writing-modes'
import {
  saveDoc,
  loadDoc,
  clearDoc,
  getTheme,
  recentList,
  getSidebarWidth,
  setSidebarWidth,
} from './store'
import { loadShortcuts, eventToAccelerator, isSameAccelerator } from './shortcuts'
import { installErrorReport } from './error-report'
import { installStaticPartials } from './templates'

// ---------------------------------------------------------------------------
// 应用常量
// ---------------------------------------------------------------------------

/** 首次启动（无本地文档）时展示的初始内容（空文档，由用户自行输入） */
const DEMO_DOC = ''

// ---------------------------------------------------------------------------
// 导出懒加载
// ---------------------------------------------------------------------------

/**
 * 导出动作入口：动态加载导出模块后再执行。
 *
 * 导出管线（export.ts → export-doc.ts）带 markdown-it / KaTeX 等约 1.5MB 的
 * 重型依赖，而导出是低频动作——静态引用会让主窗口启动即解析整段代码（打包
 * 产物对 export 分包 modulepreload）。改为点击导出菜单时才拉起，主窗口启动
 * 不加载；单测仍可静态 import './export'，不受影响。
 */
function runExport(run: (m: typeof import('./export')) => unknown) {
  void import('./export').then(run)
}

// ---------------------------------------------------------------------------
// 侧边栏
// ---------------------------------------------------------------------------

/** 关闭 ⋯ 溢出菜单 */
function closeMoreMenu() {
  const menu = document.getElementById('more-menu')
  if (menu) menu.hidden = true
}

/**
 * 分屏开关：在「左右分屏」与「所见即所得」之间切换。
 * 与源码模式是同一份视图状态（editor-core 的三态），故互斥——分屏中再按一次
 * 源码模式键会切到纯源码，而不是叠加。
 */
function toggleSplitView() {
  setViewMode(getViewMode() === 'split' ? 'wysiwyg' : 'split')
}

/** 切换侧边栏面板（大纲 / 文件二选一，互斥展开收起） */
function toggleSidebar(which: 'outline' | 'files') {
  const sidebar = document.getElementById('sidebar')
  const outlinePanel = document.getElementById('outline-panel')
  const filesPanel = document.getElementById('files-panel')
  if (!sidebar || !outlinePanel || !filesPanel) return

  const showOutline = which === 'outline'
  const targetPanel = showOutline ? outlinePanel : filesPanel
  const otherPanel = showOutline ? filesPanel : outlinePanel
  otherPanel.hidden = true
  targetPanel.hidden = !targetPanel.hidden
  sidebar.hidden = targetPanel.hidden && otherPanel.hidden
}

// ---------------------------------------------------------------------------
// 侧边栏分隔条：拖拽调整侧边栏与编辑区的宽度分配
// ---------------------------------------------------------------------------

/** 侧边栏宽度上下限：再窄内容挤成一列、再宽编辑区没剩几列 */
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480
/** 窗口变窄时的兜底：编辑区至少保留的宽度 */
const EDITOR_MIN_WIDTH = 320

function clampSidebarWidth(width: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - EDITOR_MIN_WIDTH)
  return Math.min(SIDEBAR_MAX_WIDTH, max, Math.max(SIDEBAR_MIN_WIDTH, width))
}

/** 把宽度写到侧边栏（CSS 里的 250px 仅为未装配时的兜底） */
function applySidebarWidth(width: number) {
  document.getElementById('sidebar')?.style.setProperty('width', `${width}px`)
}

/**
 * 分隔条拖拽调宽，双击恢复默认 250px，宽度持久化。
 * 鼠标事件挂在 document 上（拖出 5px 热区不丢），与 split.ts 同一套模式。
 */
function wireSidebarResize() {
  const sidebar = document.getElementById('sidebar')
  const resizer = document.getElementById('sidebar-resizer')
  if (!sidebar || !resizer) return
  applySidebarWidth(clampSidebarWidth(getSidebarWidth()))

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault()
    resizer.classList.add('dragging')
    const left = sidebar.getBoundingClientRect().left
    const onMove = (ev: MouseEvent) => {
      applySidebarWidth(clampSidebarWidth(ev.clientX - left))
    }
    const onUp = () => {
      resizer.classList.remove('dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const width = Number.parseFloat(sidebar.style.width)
      if (Number.isFinite(width)) setSidebarWidth(width)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })

  // 双击复位：回到默认宽度（同样走持久化，下次启动仍是默认值）
  resizer.addEventListener('dblclick', () => {
    applySidebarWidth(250)
    setSidebarWidth(250)
  })

  // 窗口收窄时重新钳制，避免侧边栏把编辑区挤没
  window.addEventListener('resize', () => {
    applySidebarWidth(
      clampSidebarWidth(Number.parseFloat(sidebar.style.width) || getSidebarWidth()),
    )
  })
}

// ---------------------------------------------------------------------------
// 启动与全局装配
// ---------------------------------------------------------------------------

/** 启动装配：i18n、平台类、主题恢复、编辑器挂载、工具栏/标签栏/快捷键/菜单事件绑定 */
async function boot() {
  try {
    // 全局错误捕获最先安装：启动期任意阶段抛错都能经主进程落到本机日志
    installErrorReport()
    // 静态模板注入最先于一切 DOM 扫描：i18n 的 data-i18n 扫描与各 wire* 的
    // getElementById 都依赖完整 DOM（浮层/面板 HTML 在 src/templates/*.html）
    installStaticPartials()
    applyDomTexts()
    // Mac 隐藏标题栏：工具栏让出红绿灯按钮的空间
    if (navigator.userAgent.includes('Macintosh')) {
      document.documentElement.classList.add('mac')
    }
    // 菜单栏文案与语言码跟随当前语言（主进程据此重建菜单、切换文件树排序规则）
    native?.setLocaleInfo({ labels: menuLabels(), locale: getLocale() })
    const dark = getTheme() === 'dark'
    // 幂等再同步：<head> 内联脚本已在首帧前挂好 html.dark，这里兜底保持一致
    document.documentElement.classList.toggle('dark', dark)
    setMermaidTheme(dark ? 'dark' : 'default')
    // 主题预设与自定义 CSS：恢复持久化的变量覆盖层
    restoreThemeStyles()
    // 文件式主题：异步经 IPC 读取注入（赶在编辑器挂载前，避免先闪内置配色；
    // 主题文件已被删除时回落内置变量并提示）
    await restoreFileTheme((name) => showToast(t('settings.themeFileMissing', { name })))
    // 源码模式行号开关：恢复持久化状态（body class，CSS 层控制）
    applySourceLineNumbers()
    // 拼写检查开关：恢复持久化状态（#panes 容器 spellcheck 属性，可编辑根经继承获得）
    applySpellcheck()
    // 排版设置：恢复持久化配置（CSS 变量层，不触碰编辑器实例）
    applyTypography()
    // 专注/打字机模式：恢复专注 body class，挂打字机选区监听
    applyWritingModes()
    wireTypewriter()

    // 文档变更钩子：置脏同步每键必做；恢复副本 / 字数走低优合并回调；结构变化刷新大纲
    setEditorHooks({
      // 置脏同步（O(1)，每键必做）：驱动标签圆点、窗口标题与关闭保护
      onDocDirty: () => markDirty(),
      // 低优合并回调（O(n)，至多约 4 次/秒）：恢复副本 + 字数统计。
      // 恢复副本走原始序列化串：与 currentMarkdown 同做空单元格规范化，
      // 避免 <br /> 占位（及其连带的转义伪影）经恢复副本污染文档
      onMarkdownChange: (md) => {
        const clean = normalizeEmptyTableCells(md)
        saveDoc(clean)
        updateWordCount(clean)
      },
      onDocUpdate: (doc) => {
        const list = document.getElementById('outline-list')
        const view = getPmView()
        if (list && view) renderOutline(list, collectOutline(doc), view)
      },
    })

    const restored = loadDoc()
    const tab = newTab(nextUntitledName(), restored ?? DEMO_DOC)
    if (restored != null) tab.recovered = true // 恢复副本：不可被"打开文件"原地替换
    setActiveTabId(tab.id)
    await mountEditor(tab.markdown)
    updateWordCount(tab.markdown)
    updateTitle()
    renderTabs()
    // 首屏大纲（listener.updated 只在文档变化时触发）
    const outlineList = document.getElementById('outline-list')
    const view = getPmView()
    if (outlineList && view) renderOutline(outlineList, collectOutline(view.state.doc), view)

    // 工具栏
    document.getElementById('import-btn')?.addEventListener('click', () => void openDocument())
    document.getElementById('export-btn')?.addEventListener('click', () => void saveDocument())
    document
      .getElementById('source-mode-btn')
      ?.addEventListener('click', () => setSourceMode(!isSourceMode()))
    document
      .getElementById('sidebar-outline-btn')
      ?.addEventListener('click', () => toggleSidebar('outline'))

    // ⋯ 溢出菜单
    document.getElementById('menu-files-btn')?.addEventListener('click', () => {
      toggleSidebar('files')
      closeMoreMenu()
    })
    document.getElementById('menu-find-btn')?.addEventListener('click', () => {
      openFindBar()
      closeMoreMenu()
    })
    document.getElementById('menu-export-html-btn')?.addEventListener('click', () => {
      runExport((m) => m.exportHtml(currentMarkdown(), activeTab()?.name ?? t('tab.untitled')))
      closeMoreMenu()
    })
    // Word / 长图：离屏渲染导出（仅 Electron 环境可用）
    document.getElementById('menu-export-word-btn')?.addEventListener('click', () => {
      runExport((m) =>
        m.exportWord(currentMarkdown(), activeTab()?.name ?? t('tab.untitled'), getActiveBaseDir()),
      )
      closeMoreMenu()
    })
    document.getElementById('menu-export-longimage-btn')?.addEventListener('click', () => {
      runExport((m) =>
        m.exportLongimage(
          currentMarkdown(),
          activeTab()?.name ?? t('tab.untitled'),
          getActiveBaseDir(),
        ),
      )
      closeMoreMenu()
    })
    document.getElementById('menu-export-latex-btn')?.addEventListener('click', () => {
      runExport((m) => m.exportLatex(currentMarkdown(), activeTab()?.name ?? t('tab.untitled')))
      closeMoreMenu()
    })
    // 浏览器环境没有离屏渲染能力，隐藏这两项（HTML / PDF 导出仍可用）
    if (!native) {
      for (const id of ['menu-export-word-btn', 'menu-export-longimage-btn']) {
        const btn = document.getElementById(id)
        if (btn) btn.hidden = true
      }
    }
    document.getElementById('menu-insert-toc-btn')?.addEventListener('click', () => {
      const view = getPmView()
      if (view && !isSourceMode()) insertToc(view)
      closeMoreMenu()
    })
    // 分屏：低频的视图切换，放悬浮菜单而非工具栏（工具栏只留高频按钮）
    document.getElementById('menu-split-view-btn')?.addEventListener('click', () => {
      toggleSplitView()
      closeMoreMenu()
    })
    document.getElementById('more-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const menu = document.getElementById('more-menu')
      if (menu) menu.hidden = !menu.hidden
    })
    // 点击菜单外任意位置收起
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('more-menu')
      if (!menu || menu.hidden) return
      const target = e.target as HTMLElement
      if (!target.closest('#more-menu') && !target.closest('#more-btn')) {
        menu.hidden = true
      }
    })

    document.getElementById('open-folder-btn')?.addEventListener('click', () => void openFolder())
    // 清空最近文件：二次确认后清空本地列表与系统最近文档
    document.getElementById('clear-recent-btn')?.addEventListener('click', () => {
      if (window.confirm(t('files.clearRecentConfirm'))) clearRecentDocuments()
    })
    // 清空已打开文件夹：二次确认后仅移除侧边栏引用（不删除磁盘文件）
    document.getElementById('clear-folder-btn')?.addEventListener('click', () => {
      if (window.confirm(t('files.clearFoldersConfirm'))) clearFolderEntries()
    })
    // 双击标签栏空白区新建标签（单击保留给未来的其他交互）
    document.getElementById('tab-bar')?.addEventListener('dblclick', (e) => {
      if (e.target === e.currentTarget) createNewTab()
    })

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      void applyTheme(!document.documentElement.classList.contains('dark'))
    })

    // 自绘标题栏窗口控制（html.win 时显示；双击工具栏拖拽区由系统处理）
    document.getElementById('win-min')?.addEventListener('click', () => native?.winMinimize())
    const winMaxBtn = document.getElementById('win-max')
    winMaxBtn?.addEventListener('click', () => native?.winMaximizeToggle())
    document.getElementById('win-close')?.addEventListener('click', () => native?.winClose())
    native?.onWindowMaximize((isMax) => winMaxBtn?.classList.toggle('maximized', isMax))

    // 设置面板
    document.getElementById('menu-settings-btn')?.addEventListener('click', () => {
      closeMoreMenu()
      openSettings()
    })
    wireSettings()

    // 粘贴图片上下文：策略来自设置，目录来自当前标签页路径
    setImagePasteContext({
      getStrategy: () => getCurrentImageStrategy(),
      getBaseDir: () => getActiveBaseDir(),
    })

    // 链接跳转上下文：相对路径按当前标签页所在目录解析；悬停 Mod 键显示 pointer
    setLinkNavContext({ getBaseDir: () => getActiveBaseDir() })
    wireLinkNav()

    // 快捷键（源码模式下 F 键交给 CodeMirror）
    // 快捷键配置从 localStorage 读取，与主进程菜单 accelerator 保持一致
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMoreMenu()
        closeSettings()
        closeLinkBar()
        closeContextMenu()
        closeQuickSwitch()
        closeSearch()
      }
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const shortcuts = loadShortcuts()
      const acc = eventToAccelerator(e)
      if (isSameAccelerator(acc, 'CmdOrCtrl+,')) {
        // 设置面板：平台惯例键位（macOS Cmd+, / Windows Ctrl+,）。
        // 浏览器模式无菜单栏，这里是唯一入口；Electron 下菜单 accelerator
        // 先消费按键，此分支不会重复触发
        e.preventDefault()
        openSettings()
      } else if (isSameAccelerator(acc, shortcuts['quick-switch'])) {
        e.preventDefault()
        openQuickSwitch()
      } else if (isSameAccelerator(acc, shortcuts['search-files'])) {
        e.preventDefault()
        openSearch()
      } else if (isSameAccelerator(acc, shortcuts['find']) && !isSourceMode()) {
        e.preventDefault()
        openFindBar()
      } else if (isSameAccelerator(acc, shortcuts['source-mode'])) {
        e.preventDefault()
        setSourceMode(!isSourceMode())
      } else if (isSameAccelerator(acc, shortcuts['split-view'])) {
        e.preventDefault()
        toggleSplitView()
      } else if (isSameAccelerator(acc, shortcuts['new-tab'])) {
        e.preventDefault()
        createNewTab()
      } else if (isSameAccelerator(acc, shortcuts['close-tab'])) {
        e.preventDefault()
        const id = getActiveTabId()
        if (id) void closeTab(id)
      }
    })

    // 菜单（Electron）
    native?.onMenu((action) => {
      // 格式化命令：统一走 format 命令层（源码模式无 ProseMirror 编辑器，忽略）
      if (action.startsWith('fmt-')) {
        const view = getPmView()
        if (view && !isSourceMode()) applyFormatAction(view, action)
        return
      }
      const handlers: Record<string, () => void> = {
        open: () => void openDocument(),
        'open-folder': () => void openFolder(),
        save: () => void saveDocument(),
        'save-as': () => void saveDocument(true),
        history: () => void openHistory(),
        'open-settings': () => openSettings(),
        'new-tab': () => createNewTab(),
        'close-tab': () => {
          const id = getActiveTabId()
          if (id) void closeTab(id)
        },
        'export-html': () =>
          runExport((m) => m.exportHtml(currentMarkdown(), activeTab()?.name ?? t('tab.untitled'))),
        'export-pdf': () => runExport((m) => m.exportPdf()),
        'export-word': () =>
          runExport((m) =>
            m.exportWord(
              currentMarkdown(),
              activeTab()?.name ?? t('tab.untitled'),
              getActiveBaseDir(),
            ),
          ),
        'export-longimage': () =>
          runExport((m) =>
            m.exportLongimage(
              currentMarkdown(),
              activeTab()?.name ?? t('tab.untitled'),
              getActiveBaseDir(),
            ),
          ),
        'export-latex': () =>
          runExport((m) => m.exportLatex(currentMarkdown(), activeTab()?.name ?? t('tab.untitled'))),
        'clear-recent': () => clearRecentDocuments(),
      }
      handlers[action]?.()
    })
    // 自动保存：渲染层为状态权威，启动对齐菜单并按需起定时器；菜单勾选走单入口
    initAutosave()
    native?.onAutosave((enabled) => setAutosaveOn(enabled))
    // 文件关联：Finder 双击 / 系统打开方式
    native?.onOpenPath((path) => void openPath(path))
    // 「打开最近文件」菜单：主进程菜单项点击 → 按路径打开
    native?.onRecentOpen((path) => void openPath(path))

    // 拖拽打开：拖 .md 进窗口新标签打开，拖图片按粘贴策略插入
    wireDragDrop()

    wireFindBar()
    wireLinkBar()
    wireContextMenu()
    // 标签栏右键菜单：关闭当前/其他/左侧/右侧/已保存/全部
    wireTabMenu()
    wireQuickSwitch()
    wireSearch()
    // 分屏交互：分隔条拖拽 / 点选可编辑侧 / 两侧滚动近似同步
    wireSplit()
    // 侧边栏分隔条：拖拽调宽 / 双击复位
    wireSidebarResize()
    // 历史版本面板：恢复只把快照载入编辑器并置脏，是否覆盖磁盘由用户后续保存决定
    wireHistory({
      onRestore: async (content) => {
        const tab = activeTab()
        if (!tab) return
        tab.markdown = content
        await replaceEditor(content)
        // 与文档变更钩子保持同一套副作用：恢复副本 / 字数 / 脏标记
        const clean = normalizeEmptyTableCells(content)
        saveDoc(clean)
        updateWordCount(clean)
        markDirty()
        renderTabs()
        updateTitle()
      },
    })
    // 表格工具栏按钮：源码模式下无 PM 视图，忽略
    wireTableToolbar(() => (isSourceMode() ? null : getPmView()))
    renderFilesSidebar()
    // 最近文件列表全量同步给主进程，构建原生菜单「打开最近文件」子菜单
    native?.recentSync(recentList())
    // 快捷键配置同步给主进程，更新菜单 accelerator
    native?.syncShortcuts(loadShortcuts())
    // 就绪信号：主进程补发排队中的待打开文件
    native?.ready()
    // 干净退出（无未保存内容）时清除恢复副本并停掉自动保存定时器；
    // 退出前先把挂起中的低优序列化落盘，保证恢复副本覆盖到最后一次输入
    window.addEventListener('beforeunload', () => {
      flushMarkdownSync()
      stopAutosave()
      if (!hasDirty()) clearDoc()
    })
  } catch (err) {
    // 启动失败时把错误显示出来，方便开发期排查
    const tip = document.createElement('pre')
    tip.style.cssText = 'color:#d1242f;padding:16px;white-space:pre-wrap'
    tip.textContent = t('boot.failed') + (err instanceof Error ? err.stack : String(err))
    document.body.appendChild(tip)
    throw err
  }
}

void boot()
