/**
 * 应用菜单模板构建：纯数据工厂（零 Electron 依赖，可独立单测）。
 *
 * 职责：把「菜单文案 / 用户自定义快捷键 / 最近文件列表 / 自动保存状态」
 * 组装为 Electron MenuItemConstructorOptions 模板；所有副作用（动作分发、
 * 最近文件打开、自动保存开关回写）经 deps 回调反转给调用方——main.cjs
 * 注入 sendToRenderer 与状态持久化，本模块不感知 IPC 通道与窗口实例。
 *
 * 可变状态（menuLabels / customShortcuts / recentDocs / autosaveEnabled）
 * 的权威在 main.cjs：语言切换、快捷键同步、最近列表变化后由它重新调用
 * buildMenuTemplate 重建菜单。本模块只做「状态快照 → 模板」的纯转换。
 *
 * @author chiangyang
 */

/**
 * 菜单文案默认值（中文兜底）：渲染层启动后经 IPC 下发当前语言的完整文案，
 * main.cjs 以 DEFAULT_MENU_LABELS 为初始值、按语言包覆盖。
 * @type {Record<string, string>}
 */
const DEFAULT_MENU_LABELS = {
  file: '文件',
  open: '打开',
  openFolder: '打开文件夹',
  openRecent: '打开最近文件',
  recentEmpty: '（无最近文件）',
  clearRecent: '清空最近文件',
  save: '保存',
  saveAs: '另存为',
  newTab: '新标签页',
  closeTab: '关闭标签页',
  autosave: '自动保存到文件',
  export: '导出',
  exportHtml: '导出 HTML',
  exportPdf: '打印 / 导出 PDF',
  exportWord: '导出 Word',
  exportLongimage: '导出长图',
  exportLatex: '导出 LaTeX',
  format: '格式',
  bold: '加粗',
  italic: '斜体',
  strike: '删除线',
  inlineCode: '行内代码',
  highlight: '高亮',
  superscript: '上标',
  subscript: '下标',
  link: '链接…',
  h1: '一级标题',
  h2: '二级标题',
  h3: '三级标题',
  h4: '四级标题',
  h5: '五级标题',
  h6: '六级标题',
  paragraph: '正文',
  quote: '引用',
  codeBlock: '代码块',
  bulletList: '无序列表',
  orderedList: '有序列表',
  history: '历史版本',
  settings: '设置…',
}

/**
 * 菜单项 accelerator 解析：优先用户自定义，否则用默认值。
 * @param {Record<string, string>} shortcuts - action → accelerator（渲染层 shortcuts.ts 同步）
 * @param {string} action - 动作标识（与渲染层 SHORTCUT_DEFS 对齐）
 * @param {string} fallback - 默认 accelerator
 * @returns {string}
 */
function accOf(shortcuts, action, fallback) {
  return shortcuts[action] ?? fallback
}

/**
 * 菜单构建的依赖注入契约（buildMenuTemplate 的 @param deps 形状）。
 * @typedef {Object} MenuDeps
 * @property {Record<string, string>} labels - 菜单文案（渲染层语言包镜像，已合并中文兜底）
 * @property {Record<string, string>} shortcuts - 用户自定义 accelerator（action → accelerator）
 * @property {{ path: string, name: string }[]} recents - 最近文件（最新在前）
 * @property {boolean} autosaveEnabled - 自动保存开关当前状态（checkbox 回显）
 * @property {boolean} isMac - 平台标记（appMenu/close 角色、引用快捷键避让）
 * @property {(action: string) => void} onAction - 统一菜单动作分发（main.cjs 转 IPC）
 * @property {(path: string) => void} onRecentOpen - 打开最近文件
 * @property {(enabled: boolean) => void} onAutosaveToggle - 自动保存开关切换
 */

/**
 * 「打开最近文件」子菜单：有条目则附分隔线与清空项，空列表为禁用占位项
 * @param {MenuDeps} deps
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function recentSubmenu(deps) {
  const { recents, labels, onAction, onRecentOpen } = deps
  if (!recents.length) {
    return [{ label: labels.recentEmpty, enabled: false }]
  }
  return [
    ...recents.map((entry) => ({
      label: entry.name,
      click: () => onRecentOpen(entry.path),
    })),
    { type: 'separator' },
    {
      label: labels.clearRecent,
      // 清空动作交给渲染层执行（localStorage 是唯一权威），走统一菜单消息通道
      click: () => onAction('clear-recent'),
    },
  ]
}

/**
 * 构建应用菜单模板（纯函数：同一 deps 恒得同一模板）。
 *
 * 菜单文案取自渲染层下发的语言包（labels，已由调用方合并中文兜底）；
 * 各菜单项的 accelerator 优先用户自定义（shortcuts），未自定义回落内置默认。
 *
 * @param {MenuDeps} deps
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function buildMenuTemplate(deps) {
  const { labels, shortcuts, autosaveEnabled, isMac, onAction, onAutosaveToggle } = deps
  /** @param {string} key @returns {string} */
  const L = (key) => labels[key] ?? key
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: /** @type {const} */ ('appMenu') }] : []),
    {
      label: L('file'),
      submenu: [
        {
          label: L('open'),
          accelerator: accOf(shortcuts, 'open', 'CmdOrCtrl+O'),
          click: () => onAction('open'),
        },
        {
          label: L('openFolder'),
          accelerator: accOf(shortcuts, 'open-folder', 'CmdOrCtrl+Shift+O'),
          click: () => onAction('open-folder'),
        },
        {
          label: L('openRecent'),
          submenu: recentSubmenu(deps),
        },
        {
          label: L('save'),
          accelerator: accOf(shortcuts, 'save', 'CmdOrCtrl+S'),
          click: () => onAction('save'),
        },
        {
          label: L('saveAs'),
          accelerator: accOf(shortcuts, 'save-as', 'CmdOrCtrl+Shift+S'),
          click: () => onAction('save-as'),
        },
        // 历史版本：低频查阅，不绑快捷键（避免与保存类操作抢键位）
        {
          label: L('history'),
          click: () => onAction('history'),
        },
        { type: 'separator' },
        {
          label: L('newTab'),
          accelerator: accOf(shortcuts, 'new-tab', 'CmdOrCtrl+T'),
          click: () => onAction('new-tab'),
        },
        {
          label: L('closeTab'),
          accelerator: accOf(shortcuts, 'close-tab', 'CmdOrCtrl+W'),
          click: () => onAction('close-tab'),
        },
        { type: 'separator' },
        {
          id: 'autosave',
          label: L('autosave'),
          type: 'checkbox',
          checked: autosaveEnabled,
          click: (item) => onAutosaveToggle(item.checked),
        },
        { type: 'separator' },
        // 设置面板：菜单文案与窗口装饰同源于渲染层；accelerator 走系统惯例
        // Cmd/Ctrl+，不进快捷键自定义表（平台惯例键位，自定义收益为零）
        {
          label: L('settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => onAction('open-settings'),
        },
        { type: 'separator' },
        isMac
          ? { role: /** @type {const} */ ('close') }
          : { role: /** @type {const} */ ('quit') },
      ],
    },
    {
      label: L('export'),
      submenu: [
        {
          label: L('exportHtml'),
          // Shift+H 让位给格式栏「高亮」（默认值与 src/shortcuts.ts 保持一致）
          accelerator: accOf(shortcuts, 'export-html', 'CmdOrCtrl+Shift+D'),
          click: () => onAction('export-html'),
        },
        {
          label: L('exportPdf'),
          // Ctrl/Cmd+P 已让位给快速切换面板（高频优先），PDF 改 Shift+Mod+P
          accelerator: accOf(shortcuts, 'export-pdf', 'CmdOrCtrl+Shift+P'),
          click: () => onAction('export-pdf'),
        },
        { type: 'separator' },
        // Word / 长图走离屏渲染，耗时明显长于 HTML/PDF，故不绑定快捷键
        // （避免误触触发重任务），仅从菜单与工具栏 ⋯ 菜单进入
        {
          label: L('exportWord'),
          click: () => onAction('export-word'),
        },
        {
          label: L('exportLongimage'),
          click: () => onAction('export-longimage'),
        },
        // LaTeX 为纯文本转换（无离屏渲染、无重任务），入口保持导出区一致
        {
          label: L('exportLatex'),
          click: () => onAction('export-latex'),
        },
      ],
    },
    {
      // 格式栏：与渲染层 ProseMirror keymap 同一套命令（fmt-* action）。
      // accelerator 由菜单消费，不会同时触发渲染层 keymap；
      // mac 上 Cmd+Q 是退出应用，引用改用 Ctrl+Q（keymap 亦绑 Ctrl+q 兜底）
      label: L('format'),
      submenu: [
        {
          label: L('bold'),
          accelerator: accOf(shortcuts, 'fmt-bold', 'CmdOrCtrl+B'),
          click: () => onAction('fmt-bold'),
        },
        {
          label: L('italic'),
          accelerator: accOf(shortcuts, 'fmt-italic', 'CmdOrCtrl+I'),
          click: () => onAction('fmt-italic'),
        },
        {
          label: L('strike'),
          click: () => onAction('fmt-strike'),
        },
        {
          label: L('inlineCode'),
          click: () => onAction('fmt-code'),
        },
        {
          label: L('highlight'),
          accelerator: accOf(shortcuts, 'fmt-mark', 'CmdOrCtrl+Shift+H'),
          click: () => onAction('fmt-mark'),
        },
        {
          label: L('superscript'),
          accelerator: accOf(shortcuts, 'fmt-sup', 'CmdOrCtrl+Shift+='),
          click: () => onAction('fmt-sup'),
        },
        {
          label: L('subscript'),
          accelerator: accOf(shortcuts, 'fmt-sub', 'CmdOrCtrl+Shift+-'),
          click: () => onAction('fmt-sub'),
        },
        {
          label: L('link'),
          accelerator: accOf(shortcuts, 'fmt-link', 'CmdOrCtrl+K'),
          click: () => onAction('fmt-link'),
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          label: L(`h${level}`),
          accelerator: accOf(shortcuts, `fmt-h${level}`, `CmdOrCtrl+${level}`),
          click: () => onAction(`fmt-h${level}`),
        })),
        {
          label: L('paragraph'),
          accelerator: accOf(shortcuts, 'fmt-paragraph', 'CmdOrCtrl+0'),
          click: () => onAction('fmt-paragraph'),
        },
        { type: 'separator' },
        {
          label: L('quote'),
          accelerator: accOf(shortcuts, 'fmt-quote', isMac ? 'Ctrl+Q' : 'CmdOrCtrl+Q'),
          click: () => onAction('fmt-quote'),
        },
        {
          label: L('codeBlock'),
          accelerator: accOf(shortcuts, 'fmt-codeblock', 'CmdOrCtrl+Shift+K'),
          click: () => onAction('fmt-codeblock'),
        },
        {
          label: L('bulletList'),
          accelerator: accOf(shortcuts, 'fmt-bullet', 'CmdOrCtrl+Shift+8'),
          click: () => onAction('fmt-bullet'),
        },
        {
          label: L('orderedList'),
          accelerator: accOf(shortcuts, 'fmt-ordered', 'CmdOrCtrl+Shift+9'),
          click: () => onAction('fmt-ordered'),
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ]
  return template
}

module.exports = { DEFAULT_MENU_LABELS, buildMenuTemplate }
