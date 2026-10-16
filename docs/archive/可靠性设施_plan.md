# 可靠性设施（本地崩溃捕获 + 日志落盘 + 主链路 E2E）实施计划

> 对应路线图 v1.3「可靠性设施：配置 crashReporter（本地落盘，尊重开源无遥传原则）；Playwright E2E 覆盖打开/编辑/保存主链路」。
> 含两处落地校准（见下「范围与落地校准」），与导出功能的计划同体例。

## 一、仓库调研

### 现状：可靠性设施基本为零

- **主进程**（[main.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/main.cjs)）：未配置 `crashReporter`；无 `process.on('uncaughtException' / 'unhandledRejection')`；主窗口无 `render-process-gone` / `app.on('child-process-gone')` 监听（仅离屏导出窗口 [exporter.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/exporter.cjs#L197-L203) 处理自身崩溃以释放排队任务）。
- **渲染层**：无全局 `window.onerror` / `unhandledrejection` 监听。导出 E2E 脚本末尾读取的 `window.__tmdErrors` 在源码中不存在（纯防御性写法，恒为 `[]`）。boot 的 try/catch 只兜启动失败并把堆栈渲染到页面。
- **测试**：vitest 单测覆盖纯逻辑（327 例）；桌面真实链路仅有 [desktop-export-check.mjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/scripts/desktop-export-check.mjs)（导出专项，31 断言），打开/编辑/保存主链路无自动化防护。

### 既有约定（新代码必须遵循）

- **持久化目录二分法**：用户资产放 `~/.tmd/`（[themes.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/themes.cjs) 的 `~/.tmd/themes`，跨安装/升级保留）；易失配置放 `userData`（shell-state.json、picgo-config.json，随卸载清理）。
- **纯 Node 模块范式**：[search.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/search.cjs) / themes.cjs 不 require electron，主进程只做装配；纯逻辑经 `createRequire` 在 vitest 中直接测试（见 [themes.test.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/__tests__/themes.test.ts)）。
- **IPC 双锁契约**：通道名常量在 [ipc.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/ipc.cjs)，类型在 [native.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/native.ts) 的 `IpcChannels` / `NativeFileAPI`，靠 JSDoc checkJs 保证两侧漂移即编译报错；渲染层只经 `window.tmdAPI` 访问，浏览器环境自动降级隐藏入口。
- **E2E 基建可直接复用**：desktop-export-check.mjs 自带极简 CDP 客户端（`Cdp` 类）、`waitForTarget`、隔离 `--user-data-dir`、主进程侧 stub `dialog.showOpenDialog/showSaveDialog`、真实应用菜单 `click()` 触发、`detached:true` + 杀进程组 + `pkill` 清理。
- **主链路事实**：
  - 菜单 → `native.onMenu(action)` → [main.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/main.ts#L317-L352) 分发给 [files.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/files.ts) 的 `openDocument` / `saveDocument`。
  - 保存：已关联磁盘路径的标签走 `saveFile` IPC **直接写回、无对话框**（[files.ts L132-L133](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/files.ts#L131-L140)）；未关联才走 `saveFileAs`。
  - 编辑区：`#editor` 即 Milkdown 的 `.ProseMirror` contenteditable；脏标记在 `tab.dirty`，落盘后清除；恢复副本为 localStorage `tmd:doc:v1`（[store.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/store.ts#L10)），干净退出时 `beforeunload` 清除，被杀/崩溃则保留并在下次启动恢复。
- Electron `^44.2.0`；eslint 仅允许 `console.error/warn`。

## 二、范围与落地校准

1. **不引入 Playwright，与现有 CDP 脚本合流**（路线图原写 Playwright）。
   理由：①零新依赖、零浏览器下载，契合轻量离线原则；②现有脚本已证明 CDP 直连可覆盖「stub 原生对话框 + 真实菜单触发 + 产物断言」全模式；③TMD 只有 Electron 单端，Playwright 的跨浏览器/选择器引擎收益为零，引入后两套驱动并存反成负担。做法是抽出共享 harness，导出脚本改为复用（行为不变）。
2. **崩溃与日志目录放 `~/.tmd/`**（与主题同级，跨升级保留，便于用户取出反馈），并提供 `TMD_HOME_DIR` 环境变量重定位根目录——既是 E2E 的隔离测试缝（否则测试会污染用户真实 `~/.tmd`），也为未来便携版预留。
3. **零遥传**：`crashReporter.start({ upload: false })`，不设 `submitURL`，minidump 仅落盘；不做任何网络请求。不做「上次崩溃」弹窗（避免打扰，用户偏好显式触发），只在设置面板提供「打开日志文件夹」入口。
4. 不做崩溃后的自动重启/自动恢复 UI（现有 localStorage 崩溃恢复已覆盖内容层面）。

## 三、架构设计

```
原生崩溃(minidap)            主进程 JS 异常                 渲染层异常
crashpad 写盘         process uncaughtException      window error/unhandledrejection
~/.tmd/crash-dumps/   unhandledRejection            src/error-report.ts 归一化
        \                    |                              |
         \                   v                              v
          启动扫描 -----> electron/logger.cjs（纯 Node：JSONL 追加 + 轮转 + 截断 + 去重限流）
                              |
                     ~/.tmd/logs/app-YYYY-MM-DD.jsonl
                              |
              IPC log-open-dir + 设置面板「打开日志文件夹」
```

- **electron/logger.cjs（新建，纯 Node 可单测）**
  - `tmdHome(env)`：`process.env.TMD_HOME_DIR || home`；`logsDir(home)` = `~/.tmd/logs`；`crashDumpsDir(home)` = `~/.tmd/crash-dumps`。
  - `createLogger({ home, now })`：`log(level, source, message, extra?)` 序列化为单行 JSON（`ts/level/source/message/stack`），经 Promise 链串行 `appendFile` 到当天文件 `app-YYYY-MM-DD.jsonl`；写入前做轮转。
  - 纯函数（不接触磁盘，便于单测）：`logFileName(date)`、`pruneLogFiles(entries, now)`（保留 7 天且最多 10 个）、`truncateEntry(entry)`（单条 message/stack 各截断 4KB、整条上限 8KB）、`dedupeKey(entry)`（同 source+message 1 分钟内合并，附 `count`）、`listNewDumps(files, seen)`（对照 `.seen-dumps` 清单返回未见 dump）。
  - `scanNewDumps()`：启动时调用，把未见的 `.dmp`（文件名/大小/mtime）记一条 `warn` 级 `native-crash` 日志并更新 `.seen-dumps`（主进程自身崩溃时来不及写日志，只能靠下次启动补记线索）。
- **electron/main.cjs（装配）**
  - 模块加载早期（`app.whenReady` 与单实例锁之前）调用 `crashReporter.start({ upload: false, compress: true, crashesDirectory: crashDumpsDir(tmdHome()) })`。
  - `process.on('uncaughtException')` / `process.on('unhandledRejection')`：记录后**不退出**（保持 Electron 当前默认语义，仅加落盘）。
  - `app.on('child-process-gone')`：记录 `renderer/gpu/utility` 崩溃（type/reason/exitCode），覆盖主窗口；离屏窗口 exporter.cjs 自身的 reject/重建逻辑不动。
  - 新增两个 IPC：`logReport`（渲染层单向 `send`，主进程做类型/长度校验后落盘，拒绝任何非白名单字段）、`logOpenDir`（mkdir logs 目录后 `shell.openPath`，与「打开主题文件夹」同模式；不写任何示例文件）。
  - ready 后 `logger.scanNewDumps()`。
- **src/error-report.ts（新建）**
  - 纯函数 `normalizeErrorEvent(ev: ErrorEvent | PromiseRejectionEvent | unknown)`：提取 `message/stack/filename/lineno`，非 Error 值安全降级为 `String()`。
  - `installErrorReport()`：注册 `window.addEventListener('error' / 'unhandledrejection')`（捕获阶段、只注册一次），归一化后调 `native?.reportError(...)`；浏览器环境静默不装。
  - 在 [main.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/main.ts) boot 的最早处（i18n 之后、其余装配之前）安装，使启动期异常也能上报。
- **契约三处对齐**：[native.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/native.ts) 加 `reportError(entry)` 与 `openLogsDir()` 及两个通道键；[ipc.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/ipc.cjs) 加 `logReport: 'tmd:log-report'`、`logOpenDir: 'tmd:log-open-dir'`；[preload.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/preload.cjs) 暴露两方法。
- **设置面板**（[index.html](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/index.html)「更新」与「关于」之间新增「日志与诊断」小节）：一句说明（日志仅保存在本机、不会上传）+「打开日志文件夹」按钮，复用 `settings-btn/settings-hint` 现有样式；浏览器环境整个小节隐藏（与文件式主题区同手法）。三语文案各加 2 键。
- **E2E harness 抽取**：`scripts/lib/desktop-harness.mjs` 导出 `Cdp`、`waitForTarget`、`spawnApp({repo, work, profile, homeDir})`（含 9222/9229 端口、`TMD_HOME_DIR` env、detached）、`killTree(child)`；desktop-export-check.mjs 改为从 harness 引入，**断言与流程一字不动**，抽完立即复跑确认 31/31。
- **scripts/desktop-app-check.mjs（新建，主链路 E2E）**：场景与顺序见下。
- package.json：`"test:desktop": "node scripts/desktop-app-check.mjs && node scripts/desktop-export-check.mjs"`（快的在前；两脚本串行、共用端口，启动前各自 pkill 清理）。

### desktop-app-check.mjs 场景（隔离 profile + 隔离 TMD_HOME_DIR，两次启动）

1. **首启空白**：`.ProseMirror` 文本为空、恰好一个「未命名」标签——守住「干净启动空白文档」偏好。
2. **打开**：stub `showOpenDialog` 指向预置 sample.md，真实菜单「文件 → 打开」触发 → 编辑器含特征文本、标签标题为 sample.md。
3. **编辑**：聚焦 `.ProseMirror` 后 CDP `Input.insertText` 插入唯一标记行 → 标签出脏标记、`tmd:doc:v1` 恢复副本含标记（备选：`Input.dispatchKeyEvent` 逐键）。
4. **保存**：真实菜单「文件 → 保存」（直接写回无对话框）→ 磁盘文件含标记、脏标记清除、恢复副本清除。
5. **另存为**：stub `showSaveDialog` 返回新路径，菜单触发 → 新文件存在且内容一致。
6. **未保存关闭取消分支**：再次编辑制造脏态；stub `showMessageBox` 先返回「取消」→ `win.close()` 后窗口存活；下一轮调用再返回「放弃」（用于后续步骤）。
7. **渲染层异常落盘**：`window.dispatchEvent(new ErrorEvent('error', { error: new Error('tmd-e2e-marker') }))` → 轮询 `~/.tmd/logs/*.jsonl` 出现含 marker 的行且字段齐全。
8. **渲染进程崩溃**：主进程侧 `webContents.crash()` → 日志出现 `child-process-gone` 行。
9. **崩溃恢复**：`SIGKILL` 杀整个进程组（第 6 步已恢复为可关闭状态/或直接杀进程模拟非干净退出，保留第 3/6 步产生的恢复副本）→ 同 profile 第二实例启动 → 编辑器恢复出未保存标记文本；同时日志在启动扫描后记录第 8 步 renderer minidump（`.seen-dumps` 机制）。
10. **主进程原生崩溃（收尾）**：第二实例主进程 `process.crash()` → 断言进程非零退出、`~/.tmd/crash-dumps/` 出现新 `.dmp` 文件（大小>0、mtime 新）。脚本到此结束（seen 记录留给下次启动，单测已覆盖该逻辑）。

## 四、实施步骤（依赖序）

1. logger.cjs 纯模块 + `src/__tests__/logger.test.ts`（路径/日期文件名/JSONL/截断/轮转/去重/dump 清单）。
2. main.cjs 装配 crashReporter + 进程钩子 + child-process-gone + 两个 IPC；ipc.cjs / native.ts / preload.cjs 通道对齐。
3. error-report.ts + `src/__tests__/error-report.test.ts`；main.ts boot 安装。
4. index.html 小节 + 三语文案 + settings.ts 装配按钮。
5. 抽 scripts/lib/desktop-harness.mjs，改造导出脚本复用，复跑 `npm run build && npm run test:desktop`（此时 app 脚本尚不存在，先手工验证导出脚本 31/31 不回归）。
6. 新增 desktop-app-check.mjs 并跑通全部断言。
7. package.json 串联命令；文档同步（docs 四件 + README 双语）；路线图勾选并写落地校准。

## 五、依赖与注意事项

- 不新增 npm 依赖（crashReporter 是 Electron 内置；harness 只用 Node 内置能力）。
- `crashReporter.start` 必须在 app `ready` 之前调用；此时不能用 `app.getPath`，故目录取 `os.homedir()` / `TMD_HOME_DIR`，与 themes.cjs 同构。
- eslint：脚本与主进程代码不允许 `console.info`，调试输出只用 `console.warn/error`；脚本禁用三元副作用表达式（沿用既有教训）。
- 不删除任何既有注释/Javadoc；新增注释一律中文。
- E2E 启动 Electron 的既有坑：`.bin/electron` 是包装脚本，必须 `detached:true` + `process.kill(-pid)` + `pkill -f tmd/node_modules/electron`（harness 统一封装）。

## 六、验证

- `npx tsc` 0 错误（含 checkJs 下 ipc.cjs/native.ts 契约对齐）。
- `npx vitest run`：原 327 例 + 新增 logger / error-report 单测全过。
- `npx eslint .` 0 问题；新文件 prettier 合规（既有 7 个不合规文件不越界）。
- `npx vite build` 成功。
- `npm run build && npm run test:desktop`：app 脚本 ~15 项断言全过 + 导出脚本 31/31 不回归。
- `dist:dir` 打包后手工抽查：设置面板按钮可打开日志目录；制造渲染异常后 JSONL 内容可读。

## 七、风险与兜底

- **未打包环境 crashpad 不出 dump**：Electron 未打包时 `process.crash()` 通常仍写 dump，但以 E2E 实测为准；若第 10 步无 dump，降级断言「进程非零退出」并在文档/路线图注明 dump 验证以打包产物为准（日志链路其余部分不受影响）。
- **Input.insertText 与 ProseMirror 兼容**：若不触发事务，降级为 CDP `Input.dispatchKeyEvent` 逐键输入。
- **harness 抽取导致导出脚本回归**：先抽后用、立即复跑；任何断言不稳定则回退为两脚本各自持有驱动（仅复制不抽象）。
- **日志风暴/敏感信息**：入参白名单 + 单条截断 + 同消息 60 秒合并；不记录任何文档内容，只记 message/stack/代码位置。
- **端口占用**：两脚本共用 9222/9229，串行执行且各自启动前 pkill（沿用现状）。
