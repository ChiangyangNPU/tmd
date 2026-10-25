# TMD Tauri Spike 技术验证

> 分支：`spike/tauri`　创建：2026-10-25　对应评估：[Tauri迁移评估.md](Tauri迁移评估.md)
> 本分支的使命是**回答 go/no-go**，不是功能迁移。全部代码可随分支废弃。

## 这个分支验证什么

| # | 验证项 | 对应评估里的风险 | 判定标准 |
|---|--------|------------------|----------|
| 1 | WKWebView 原样加载渲染层 | §5 IME 风险的前提：内核换了，应用还跑不跑 | 编辑器 / Mermaid / KaTeX 启动即渲染，控制台无致命错误 |
| 2 | **ProseMirror 中文 IME**（go/no-go 级） | §5 一等风险 | 中文输入法组合输入全程：光标不跳、不丢字、候选框位置正确；与 Electron 版对比无感差异 |
| 3 | `window.tmdAPI` 契约可由 Tauri 实现 | 评估 §3.2 全部自写命令的派发模式 | `native.ts` 零改动，三条真实通道（readFile / saveFile / readDir）功能与 Electron 版一致 |
| 4 | 编码读写 Rust 化原型 | §3.2「编码读写」（JS 做不到编码端） | UTF-8(BOM) / UTF-16LE/BE / GBK 打开后按原编码写回，CRLF 保持 |

评估文档的另外两个验证项（PDF / 截图原型、PicGo 方案）依赖平台 shim 调研，列入后续，见 [§4](#4-后续验证项未开工)。

## 怎么跑

```bash
npm run tauri dev     # 自动起 vite(5173) + cargo 构建 + 打开 WKWebView 窗口
```

- 首次运行 cargo 拉全量依赖（rsproxy 不可用时官方 crates.io 实测直连畅通），之后增量构建秒级。
- 窗口加载的是 vite 开发服务器（`build.devUrl`）；`npm run tauri build` 则加载 `dist/` 生产产物。
- identifier 用 `com.chiangyang.tmd.spike`：userData 与已安装的 Electron 版**完全隔离**，随便折腾。
- 系统标题栏保留（spike 不做自绘标题栏适配，那是迁移期的确定性工程）。

## 已实现（spike 范围）

> spike 四项验证已全部通过（2026-10-25），已合入 master 转入正式迁移；本节与
> 下节保留作为验证记录与后续验证清单。

- `src-tauri/src/main.rs`：窗口创建 + `initialization_script` 注入 `window.tmdAPI` Proxy 门面
- 已实现通道（43 条 invoke + 7 条事件订阅，与 `native.ts` 契约逐字段对齐，含 `isNative: true`）：
  `readFile` / `saveFile` / `readDir` / `openFile` / `openFolder` / `saveFileAs` /
  `exportAs`（对话框四件套走 tauri-plugin-dialog 的 Rust 侧 API，无需 capabilities 放行）、
  `searchFiles` / `wikiScan`、`watchFiles` / `watchDirs`、`listHistory` / `readHistory`、
  `setLocaleInfo`（重建菜单）/ `syncShortcuts` / `setAutosaveEnabled` / `setDirty` /
  `setThemeSource` / `winMinimize` / `winMaximizeToggle` / `winClose` /
  `recentSync` / `recentAdd` / `recentClear` / `recentRemove`、`ready` +
  订阅 `onFileChanged` / `onDirsChanged`（Tauri 事件 `tmd-file-changed` / `tmd-dirs-changed`）、
  `onMenu` / `onRecentOpen` / `onAutosave` / `onWindowMaximize`、
  `getAiConfig` / `saveAiConfig` / `testAiConnection` / `chatAi` / `abortAi` / `embedAiTexts`
  + 订阅 `onAiStream`（事件 `tmd-ai-stream`，requestId 关联 delta/reasoning/done/error）、
  `saveImage`（裸文件名白名单 + assets/ 落盘）/ `openExternal`（协议白名单）/ `openLocalFile` /
  `revealInFolder`（opener reveal）/ `deletePath`（trash 回收站）/ `createFile`（补 .md +
  wx 不覆盖）/ `createDir` / `renamePath`（fsops 名称清洗 + basename 二次防线）
- 纯逻辑模块化（与 electron/ 模块边界一一对应，JS 版保留服务 Electron 壳，改动需两处同步）：
  - `text_file.rs` ← `electron/text-file.cjs`（encoding_rs：BOM/UTF-16/GBK + CRLF）
  - `search.rs` ← `electron/search.cjs`（BFS 收集 / 跳过目录 / 扩展名白名单 /
    2MB·5000 文件·500 命中三重上限 / occurrence 定位协议；匹配在字符空间，
    中文行的 column 与 JS 的 UTF-16 口径一致）
  - `wikilinks.rs` ← `electron/wikilinks.cjs`（围栏跳过 / 三档解析 / ambiguous）
  - `watcher.rs` ← `electron/filewatcher.cjs + dirwatcher.cjs`（notify + 200ms 固定窗口
    防抖 + sha1 内容指纹过滤自身写入回声 + change 投递后重建 watcher 防 inode 失效 +
    CRLF 归一比对；emit 注入化，状态机脱壳单测）
  - `history.rs` ← `electron/history.cjs`（写前快照 / sha1 内容去重 / 单文件 50 条 +
    全局 200MB 双层剪枝 / 损坏 index 留档 7 天 / index 原子替换；**保存事务
    snapshot → write → note_write 三步在同一 Rust 命令内完成**，评估 §3.2 的要求落地）
  - `menu.rs` ← `electron/menu.cjs`（渲染层语言包驱动重建 / accelerator 用户自定义
    优先 / 最近文件子菜单含空占位 / 自动保存 checkbox；accelerator 解析失败降级无快捷键）
  - `ai_config.rs` ← `electron/ai-config.cjs`（服务商预设全走 OpenAI 兼容协议 / 字段
    白名单归一化 / 增量合并（context 嵌套单独合并、切服务商回落预设）/ **Key 存系统
    钥匙串（keyring）替代 safeStorage**，文件只落标记，降级路径同 JS；单测构建不触碰
    钥匙串，运行时首次访问可能弹一次授权）
  - `ai_client.rs` ← `electron/ai-client.cjs`（增量 SSE 解析容忍任意 chunk 边界 /
    HTTP 状态码错误码归一化 / 60s 空闲超时 / per-requestId CancellationToken /
    流内 error 结构归一化 / 嵌入 index 逐条校验）
  - `ai.rs` ← `electron/ipc-ai.cjs`（角色白名单 + 单条/总量双层体积上限 / invoke 立即
    返回 + 事件流推送 / 中止命中回执）
  - `fsops.rs` ← `electron/fsops.cjs`（名称清洗：隐藏文件/路径分隔/穿越/控制字符拒绝；
    Windows 保留字符与保留设备名平台差异按 JS 决策逐项保留——mac 半角冒号放行）
  - `themes.rs` ← `electron/themes.cjs`（单层扫描/防穿越读取/1MB 上限/空目录写示例
    主题/旧目录迁移：只增不覆盖 + 标记防复活）
  - `export_assets.rs` ← `electron/export-assets.cjs`（KaTeX woff2 内联 data URI、
    woff/ttf 回退剔除、闭合标签转义大小写不敏感、OnceLock 缓存）
  - `shell.rs` ← `electron/app-state.cjs + recent.cjs + menu 装配`（菜单/快捷键/最近
    列表/脏标记/排序区域的权威状态；**脏文档关闭确认走原生对话框**，与 Electron
    同口径：拦截 CloseRequested → 放弃/取消，破坏性按钮不做默认）
- 未实现通道：no-op + console.warn（不阻塞启动；渲染层的 `!native` 降级判断不受影响）
- spike 已知缺口：macOS appMenu 与编辑/视图 role 子菜单、系统最近文档注册
  （Jump List / Dock）、CJK 文件名按 UI 语言排序（ICU collation）、shell-state 持久化
- Rust 单测 56 例（文件核心 23 + 菜单 4 + AI 14 + fsops 4 + 主题 8（含迁移
  幂等与不覆盖语义）+ 导出资源 3（转义/字体内联/缺失回退））
- 窗口由 Rust 侧 `WebviewWindowBuilder` 创建（而非 tauri.conf.json）——因为 initialization_script
  只能走 builder，这也是正式迁移的必经形态。

## 后续验证项（未开工）

1. **PDF 导出**：WebView2 `PrintToPdfAsync`（Windows）原型；macOS WKWebView 无 API，验证「系统打印对话框存储为 PDF」降级路径的体验
2. **长图/Word/ePub 截图原语**：WKWebView `takeSnapshotWithConfiguration` / WebView2 `CapturePreview`
   隐藏窗口原型，跑通 `src/export-bridge.ts` 的 CaptureRequest 协议；重点验证隐藏窗口渲染节流
3. **PicGo 方案**：Rust 重写范围圈定（7 家图床取舍）或 sidecar 或产品降级
4. **E2E 驱动**：CDP 不可用后的回归方案（tauri-driver / 单测下沉 / 人工清单）

## 判定与去向

- 验证 1–4 通过 → 按评估 §6 顺序在 master 双壳共存迁移（不拉长分支，理由见评估与迁移讨论）
- 验证 2（IME）失败且无 workaround → 停止迁移，Tauri 评估结论作废，Electron 路线继续
- 验证 1/3/4 有缺口但验证 2 通过 → 评估工作量重估后再决策
