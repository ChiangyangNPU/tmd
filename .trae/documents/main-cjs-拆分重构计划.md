# main.cjs 按域拆分重构计划

## Context

[main.cjs](file:///e:/develop/Code/gitee/tmd/electron/main.cjs) 已 71KB / 1748 行，IPC 注册（49 个 handler）、自动更新、壳层状态持久化、窗口生命周期、最近文件、图床上传全部堆在一个文件。项目已有成熟的模块模式可遵循：[exporter.cjs](file:///e:/develop/Code/gitee/tmd/electron/exporter.cjs)（工厂 + 依赖注入，Electron 能力由 main 传入）、menu.cjs（纯数据工厂）、filewatcher.cjs 等，全部可脱离 Electron 单测（见 src/__tests__/exporter.test.ts 等 8 个测试直接 require .cjs 模块）。

目标：纯搬移重构，零行为变更。main.cjs 降到约 450 行，只留生命周期与装配。

## 拆分方案

### 新增 7 个模块（均遵循现有工厂 + DI 模式，零顶层 `require('electron')`）

| 模块 | 来源（main.cjs 行段） | 内容 |
|---|---|---|
| `electron/app-state.cjs` | L178-247 散布的状态变量 | 共享可变状态 store：mainWindow / rendererDirty / autosaveEnabled / menuLabels / customShortcuts / sortLocale / shellThemeSource 的 getter/setter。纯 JS 零依赖，可单测 |
| `electron/updater.cjs` | L70-86, L206-220, L553-957, L1496-1546 | 自动更新全部：双源常量、更新状态、setUpdateSource、setupAutoUpdater、installDownloadedUpdate、macOS dmg 下载链（verifySha512/clearQuarantine/downloadToFile/downloadMacInstaller/openDownloadedInstallerAndQuit）、4 条更新 IPC、启动 5s 自动检查定时器 |
| `electron/shell-state.cjs` | L1575-1696 | shellStateFile、readShellState、saveShellState、restoreWinState、wireWinStatePersistence |
| `electron/recent.cjs` | L178-204, L1454-1494 | recentDocs 状态内聚、normalizeRecent、recentSync/Add/Clear/Remove 四条 IPC、系统最近文档镜像 |
| `electron/ipc-files.cjs` | L958-1224 | 文件/目录/搜索/双链/主题/日志/历史/打印/导出 IPC（21 个 handler），snapshotBeforeWrite 一并内聚（仅此处使用） |
| `electron/ipc-app.cjs` | L1256-1341, L1432-1490 | setDirty/setAutosaveEnabled/setThemeSource/窗口控制×3/saveImage/openExternal/openLocalFile/syncShortcuts/ready/setLocaleInfo；isSafeExternalUrl 从此导出（createWindow 的 setWindowOpenHandler 复用） |
| `electron/picgo.cjs` | L1343-1430 | PicGo 实例懒加载 + uploadImage/getPicGoConfig/savePicGoConfig 三条 IPC |

### main.cjs 保留（约 450 行）

imports（精简）、logger/fileWatcher 初始化、sendToRenderer、对话框辅助三件套、clearRendererRecoveryCopy、queueOpenPath/flushPendingOpenPaths、buildMenu、ensureMainCsp、createWindow（含关闭确认）、exporter 装配、生命周期（单实例锁/second-instance/open-file/whenReady/window-all-closed/will-quit）、各模块装配调用。

### 关键设计

1. **共享状态用 app-state store**：7 个可变状态被 4+ 个模块读写，纯 DI 要为每个工厂传 7 个 getter/setter，过于繁琐。app-state.cjs 是纯 JS 对象持有可变字段（与渲染层 src/store.ts 概念同构），各模块直接 `require` 经 getter/setter 访问，避免解构快照造成陈旧引用。

2. **循环依赖用回调注入**：recent.cjs / ipc-app.cjs 需要触发 buildMenu，updater 需要 sendToRenderer/showMessageBoxSafe/clearRendererRecoveryCopy——全部经工厂参数注入，模块不反向 require main.cjs（与 exporter 的 `getParentWindow: () => mainWindow` 同构）。

3. **buildMenu 留在 main.cjs**：它消费 menuLabels/customShortcuts/recentDocs/autosaveEnabled 四个状态 + sendToRenderer，是装配点而非领域逻辑；autosaveMenuItem 引用随之留在 main。

4. **whenReady 装配顺序**：readShellState（shell-state）→ buildMenu → createWindow → exporter.register() → registerFileIpc / registerAppIpc / recent.register / picgo.register / updater.register+setup → scanNewDumps。

## 执行步骤

1. `app-state.cjs`（纯新增；main.cjs 改为经 state 读写，先验证模式跑通）
2. `shell-state.cjs`（最独立，无对外回调）
3. `recent.cjs`
4. `picgo.cjs`
5. `updater.cjs`（最大的一块）
6. `ipc-files.cjs`
7. `ipc-app.cjs`（收尾，main.cjs 定稿）

每步完成后跑 `npx tsc` 验证，保持随时可提交。

## 验证

- `npx tsc` — tsconfig 对 electron/*.cjs 开 checkJs，类型/导入错位会立即暴露
- `npm test` — 现有测试不 require main.cjs，应全绿；可选为 app-state 补小测试
- `npm run lint`
- 手动冒烟 `npm run dev:electron`：打开/保存文件、切主题、自绘窗口按钮、最近文件菜单、菜单检查更新、历史版本面板、图床设置面板
- `npm run dist:dir` 确认打包不受影响（build.files 已含 `electron/**`，新模块自动打进包）

## 风险

- **行为漂移**：纯搬移不逐行 diff 难以发现。对策：按域整块搬移 + tsc/checkJs + 冒烟清单逐项过。
- **状态陈旧引用**：禁止 `const { menuLabels } = state` 这类解构快照，一律 `state.getMenuLabels()` 调用时取值。
