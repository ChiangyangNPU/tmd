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
import { exportHtml, exportPdf } from './export'
import { native } from './native'
import { t, applyDomTexts, menuLabels } from './i18n'
import { setImagePasteContext } from './paste-image'
import { applyTheme } from './theme'
import { restoreThemeStyles } from './theme-presets'
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
} from './files'
import { wireDragDrop } from './dragdrop'
import { applyFormatAction, wireLinkBar, closeLinkBar } from './format'
import { wireContextMenu, closeContextMenu } from './context-menu'
import { setLinkNavContext, wireLinkNav } from './link-nav'
import { openQuickSwitch, closeQuickSwitch, wireQuickSwitch } from './quick-switch'
import { wireTableToolbar } from './table-toolbar'
import { normalizeEmptyTableCells } from './table-markdown'
import {
  mountEditor,
  currentMarkdown,
  setSourceMode,
  updateWordCount,
  getPmView,
  isSourceMode,
  setEditorHooks,
} from './editor-core'
import { initAutosave, setAutosaveOn, stopAutosave } from './autosave'
import {
  openSettings,
  closeSettings,
  wireSettings,
  getCurrentImageStrategy,
  applySourceLineNumbers,
} from './settings'
import { applyTypography } from './typography'
import { applyWritingModes, wireTypewriter } from './writing-modes'
import { saveDoc, loadDoc, clearDoc, getTheme, recentList } from './store'

// ---------------------------------------------------------------------------
// 应用常量
// ---------------------------------------------------------------------------

/** 首次启动（无本地文档）时展示的初始内容（空文档，由用户自行输入） */
const DEMO_DOC = ''

// ---------------------------------------------------------------------------
// 侧边栏
// ---------------------------------------------------------------------------

/** 关闭 ⋯ 溢出菜单 */
function closeMoreMenu() {
  const menu = document.getElementById('more-menu')
  if (menu) menu.hidden = true
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
// 启动与全局装配
// ---------------------------------------------------------------------------

/** 启动装配：i18n、平台类、主题恢复、编辑器挂载、工具栏/标签栏/快捷键/菜单事件绑定 */
async function boot() {
  try {
    applyDomTexts()
    // Mac 隐藏标题栏：工具栏让出红绿灯按钮的空间
    if (navigator.userAgent.includes('Macintosh')) {
      document.documentElement.classList.add('mac')
    }
    // 菜单栏文案跟随当前语言（Electron 主进程据此重建菜单）
    native?.setLocaleInfo(menuLabels())
    const dark = getTheme() === 'dark'
    // 幂等再同步：<head> 内联脚本已在首帧前挂好 html.dark，这里兜底保持一致
    document.documentElement.classList.toggle('dark', dark)
    setMermaidTheme(dark ? 'dark' : 'default')
    // 主题预设与自定义 CSS：恢复持久化的变量覆盖层
    restoreThemeStyles()
    // 源码模式行号开关：恢复持久化状态（body class，CSS 层控制）
    applySourceLineNumbers()
    // 排版设置：恢复持久化配置（CSS 变量层，不触碰编辑器实例）
    applyTypography()
    // 专注/打字机模式：恢复专注 body class，挂打字机选区监听
    applyWritingModes()
    wireTypewriter()

    // 文档变更钩子：保存恢复副本 / 字数 / 脏标记；结构变化刷新大纲
    setEditorHooks({
      onMarkdownChange: (md) => {
        // 恢复副本走原始序列化串：与 currentMarkdown 同做空单元格规范化，
        // 避免 <br /> 占位（及其连带的转义伪影）经恢复副本污染文档
        const clean = normalizeEmptyTableCells(md)
        saveDoc(clean)
        updateWordCount(clean)
        markDirty()
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
      ?.addEventListener('click', () => void setSourceMode(!isSourceMode()))
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
      void exportHtml(currentMarkdown(), activeTab()?.name ?? t('tab.untitled'))
      closeMoreMenu()
    })
    document.getElementById('menu-insert-toc-btn')?.addEventListener('click', () => {
      const view = getPmView()
      if (view && !isSourceMode()) insertToc(view)
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
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMoreMenu()
        closeSettings()
        closeLinkBar()
        closeContextMenu()
        closeQuickSwitch()
      }
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'p') {
        e.preventDefault()
        openQuickSwitch()
      } else if (e.key === 'f' && !isSourceMode()) {
        e.preventDefault()
        openFindBar()
      } else if (e.key === 'e') {
        e.preventDefault()
        void setSourceMode(!isSourceMode())
      } else if (e.key === 't') {
        e.preventDefault()
        createNewTab()
      } else if (e.key === 'w') {
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
        'new-tab': () => createNewTab(),
        'close-tab': () => {
          const id = getActiveTabId()
          if (id) void closeTab(id)
        },
        'export-html': () =>
          void exportHtml(currentMarkdown(), activeTab()?.name ?? t('tab.untitled')),
        'export-pdf': () => void exportPdf(),
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
    wireQuickSwitch()
    // 表格工具栏按钮：源码模式下无 PM 视图，忽略
    wireTableToolbar(() => (isSourceMode() ? null : getPmView()))
    renderFilesSidebar()
    // 最近文件列表全量同步给主进程，构建原生菜单「打开最近文件」子菜单
    native?.recentSync(recentList())
    // 就绪信号：主进程补发排队中的待打开文件
    native?.ready()
    // 干净退出（无未保存内容）时清除恢复副本并停掉自动保存定时器
    window.addEventListener('beforeunload', () => {
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
