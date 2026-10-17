# 支持打开 .txt 文件 + 另存为默认扩展名修正

## 背景

当前 TMD 的文件打开链路（对话框、文件树、拖拽、浏览器降级、启动/单实例 argv）全部硬编码只认 `.md` / `.markdown`，用户无法打开 `.txt` 文件。本次改动在「打开」链路上全面放行 `.txt`；同时顺带修正「另存为」对话框硬编码默认名 `未命名.md` 的问题，使 txt 标签另存为时保留原扩展名。

用户已确认的范围：
- **不做**系统文件关联（不改 `package.json` 的 `fileAssociations`，双击 txt 不唤起 TMD）
- **做**另存为默认扩展名修正（`saveFileAs` IPC 增加可选 `defaultName` 参数）

## 改动点

### 1. `electron/main.cjs`（4 处过滤 + 1 处 IPC 签名）

| 位置 | 现状 | 改为 |
|---|---|---|
| `MD_FILTERS` 常量（~L961） | 仅 `md, markdown`，openFile / saveFileAs 共用 | 拆为 `OPEN_FILTERS`（`md, markdown, txt`，openFile 用）与 `MD_FILTERS`（保持原值，saveFileAs 用） |
| `readDir`（L1001） | `/\.(md\|markdown)$/i` | 加 `\|txt`（文件树显示 txt） |
| `second-instance`（L1556） | 同上 | 加 `\|txt` |
| `whenReady` argv（L1715） | 同上 | 加 `\|txt` |
| `saveFileAs` handler（L1129） | 只收 `content` | 增加可选第二参 `defaultName`，`defaultPath` 用它兜底 `'未命名.md'` |

`queueOpenPath`（L278）本身无过滤，macOS `open-file` 事件不过滤（系统按 Info.plist 派发），均无需改。

### 2. `electron/preload.cjs`

`saveFileAs` 桥接透传第二参：
```js
saveFileAs: (content, defaultName) => ipcRenderer.invoke(IPC.saveFileAs, content, defaultName),
```

### 3. `src/native.ts`

`NativeFileAPI.saveFileAs` 签名加可选参数：
```ts
saveFileAs(content: string, defaultName?: string): Promise<{ path: string; name: string } | null>
```

### 4. `src/files.ts`（2 处）

- `openDocument` 浏览器降级分支（L132）：`input.accept = '.md,.markdown,text/markdown'` → 加 `,.txt,text/plain`
- `doSaveDocument`（L219）：`native.saveFileAs(markdown)` → `native.saveFileAs(markdown, tab.name)`，让 txt 标签另存为时默认名保留扩展名

### 5. `src/dragdrop.ts`

- `MD_EXTS = ['.md', '.markdown']` → 加 `'.txt'`（常量名可改为 `OPEN_EXTS`，同步改注释）
- 文件头 JSDoc 与 `classifyDroppedFiles` 注释中「拖 .md / .markdown」表述同步补 txt

### 6. `src/__tests__/dragdrop.test.ts`

现有用例已覆盖 txt 被忽略，改动后需更新：
- 「其他文件忽略」中的 `a.txt` 移到 markdown 分组断言（或单独一条「txt 文件按扩展名识别」）
- 保留 `.pdf` / `.exe` 等仍被忽略的断言

### 7. 文档同步（发版前补进 `[未发布]`）

- `CHANGELOG.md`：开新 `## [未发布]` 节，新增一条「支持打开 .txt 文件」+ 一条「另存为默认名保留原扩展名」
- `docs/需求说明.md`：文件树 / 文件打开条目补 txt 字样
- `docs/详细设计.md`：§4.3 文件树 readDir 说明、§29 附近保存流程说明补一笔
- `docs/架构设计.md`：模块表 `files.ts` / `dragdrop.ts` 职责描述微调

## 不改动的部分（保持现状）

- `package.json` `fileAssociations`：不声明 txt 系统关联（用户决策）
- `electron/search.cjs`：全文搜索已包含 txt，无需动
- `electron/wikilinks.cjs`：双链 / 图谱索引只扫 `.md`，txt 不进入笔记网络，符合预期
- 新建文件 `createFile`：仍自动补 `.md`（新建的是笔记，不是纯文本）
- 编辑器内核：txt 按 markdown 解析渲染，纯文本不受影响，无需改

## 验证

1. `npm run build`（tsc 类型检查通过）
2. `npm test`（680 项单测全过，dragdrop 用例已按新行为更新）
3. 手动 / E2E 验证清单：
   - 打开对话框能选中并打开 `.txt`
   - 文件树中 `.txt` 文件可见、点击可打开
   - 拖 `.txt` 进窗口能打开
   - 打开 txt 后 `Cmd+S` 直接写回原 `.txt` 路径
   - txt 标签「另存为」对话框默认名保留 `.txt` 扩展名
   - 新建文件仍自动补 `.md`（回归）
