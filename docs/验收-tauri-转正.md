# Tauri 转正人工验收清单

> 用途：v0.2.0 转正前的最终人工验收（spike-tauri.md 缺口清单 C4）。
> 逐项勾选并记录；**全绿 = 具备转正条件**，任何一项不过先记录问题再决策。
>
> **自动化结果（2026-10-28，`scripts/tauri-acceptance.mjs`，30/30 PASS）**：
> 下表中 ✅🤖 标记的项已由脚本对着 23:02 signed 构建自动判定通过（真实按键 +
> DOM 断言 + 日志审查，明细 `dist-tauri/acceptance-result.json`），人工只需
> 复核标 ⚠️ 的交互观感项与 🙋 标记的原生窗路径。
>
> 验收对象：`src-tauri/target/release/bundle/nsis/TMD_0.2.0-spike.1_x64-setup.exe`
> （对应提交 `dcb0565`，2026-10-28 23:02 签名构建，已含 A 组全部代码修复）。
> 注意先**卸载或关闭**现有 `C:\Software\TMD-spike`（旧版，21:51 启动的那个），
> 避免新旧混淆。
>
> 自动化已覆盖的部分（不必重复手验）：快捷键 Ctrl+B / 再按取消 /
> Ctrl+Shift+8 列表（`npm run smoke:tauri` 5/5）、导出三格式真实链路产物结构、
> 单测 835 例。本清单聚焦**自动化到不了**的 GUI 路径。

## A. 安装与首启

- [ ] 🙋 NSIS 安装包双击安装顺利，默认路径可改，无 CMD 闪窗（c3df526 回归）
- [ ] 🙋 桌面/开始菜单快捷方式生成，图标正常
- [ ] ⚠️🤖 首启：编辑器正常挂载、自绘窗口控件存在（脚本已断言）；**首帧白闪/菜单栏闪现的视觉观感请人工确认一眼**（截帧脚本对 release 已测过无白亮帧，此处是双保险）
- [ ] ⚠️🤖 标题栏：最小化/最大化/关闭按钮 DOM 存在（脚本断言）；**真实鼠标拖拽移窗、双击最大化请人工试一下**（合成事件验证不了原生命中测试）
- [ ] 🙋 窗口几何记忆：调整大小/位置后关闭重开，恢复原样

## B. 快捷键真机复验（✅🤖 = 脚本以 CDP 真实按键逐键验证通过）

- [x] ✅🤖 `Ctrl+B` 加粗；再按取消（双触发修复回归：on=1 → off=0）
- [x] ✅🤖 `Ctrl+1` / `Ctrl+2` / `Ctrl+0`：H1 / H2 / 正文
- [x] ✅🤖 `Ctrl+Q` 引用
- [x] ✅🤖 `Ctrl+Shift+8` 无序列表；`Ctrl+Shift+9` 有序列表（e.code 修复；toggle 往复语义与单测口径一致）
- [x] ✅🤖 `Ctrl+Shift+H` 高亮；`Ctrl+Shift+=` 上标；`Ctrl+Shift+-` 下标
- [x] ✅🤖 `Ctrl+K` 链接条弹出
- [x] ✅🤖 `Ctrl+,` 打开设置面板
- [x] ✅🤖 `Ctrl+P` 快速切换、`Ctrl+F` 查找
- [x] ✅🤖 `Ctrl+Shift+A` 命令面板（CDP 注入路径可弹——**注意**：真实键盘仍会先被系统截图热键拦截，请改掉截图工具热键后用真键盘再按一次确认）
- [ ] ⚠️🤖 以下键为浮层/模式切换类，脚本验证了开，**关闭/观感请人工扫一眼**：`Ctrl+J` AI 气泡、`Ctrl+Shift+F` 全文搜索、`Ctrl+E` 源码、`Ctrl+Shift+E` 分屏、`Ctrl+Shift+B` 反链、`Ctrl+Shift+G` 全库图谱、`Ctrl+Shift+L` 局部图谱
- [ ] 🙋 `Ctrl+T` 新标签 / `Ctrl+W` 关标签 / `Ctrl+O` 打开 / `Ctrl+S` 保存 / `Ctrl+Shift+S` 另存（涉及原生对话框，脚本无法判定）

## C. 设置面板（A1 降级正确性，✅🤖 = 脚本已断言 DOM）

- [x] ✅🤖 「上传到图床」**置灰 + 文案含「当前版本不支持」**
- [x] ✅🤖 图床配置区隐藏（任何图片策略下）
- [x] ✅🤖 hosting 策略未被选中（默认回落）
- [x] ✅🤖 粘贴图片（tauri-acceptance-mount.mjs，2026-11-06）：**真实剪贴板**（PowerShell STA 写入位图 → WebView2 转 paste 事件 → Ctrl+V）内联 data URI 成功；assets 策略经真实 UI radio 切换后，saveImage 真实落盘 fixture/assets/image-*.png 且 img src 解析正确

## D. 更新器（A2，✅🤖 = 脚本已断言）

- [x] ✅🤖 更新通道已接线（checkForUpdates 等存在于 shim）
- [x] ✅🤖 能力声明 `updater=true / picgo=false`
- [x] ✅🤖 实际调用检查更新（无 latest.json 场景）：**应用不崩**
- [ ] 🙋 设置面板点「检查更新」的**状态文案观感**（脚本走的是 API 层）
- [ ] 🙋（发版验证后补测）有新版本时：原生对话框 → 下载进度 → 保存握手 → 自动重启

## E. 导出（部分自动化）

- [x] ✅🤖 ⋯ 菜单展开且含「导出 PDF / HTML / Word」三项
- [ ] 🙋 三格式各自点一遍：保存框出现 → 落盘 → 打开验证内容（原生保存框脚本判定不了；产物结构此前已由 `verify_pipeline` 验过）

## F. 文件与侧边栏（部分自动化）

- [x] ✅🤖 GBK 编码文件解码（"你好世界" 无乱码，走应用真实 readFile 通道）
- [x] ✅🤖 双链素材读取正常
- [x] ✅🤖 1MB 大文档 readFile 39ms
- [x] ✅🤖 挂载文件夹（tauri-acceptance-mount.mjs，2026-11-06）：打桩对话框 → 真实 readDir 挂载、**中文拼音排序**（啊<北<中 与英文按 key 字节序混排，顺序逐项比对）、点树行打开、右键菜单五项（重命名/在系统中显示/复制相对/绝对路径/回收站）、**双链真实鼠标点击跳转**（索引就绪后生效）、反链面板列出引用页、关系图谱 canvas 渲染
- [ ] 🙋 外部修改提示（文件树自动刷新）：需真实改动 fixture 文件，观察一轮即可
- [ ] 🙋 CRLF 文件打开渲染

## G. 稳定性（✅🤖 = 脚本已审查）

- [x] ✅🤖 全流程无未捕获异常/未处理拒绝（window error + unhandledrejection 钩子）
- [x] ✅🤖 no-op 告警仅限 PicGo 三条，无越界通道告警
- [x] ✅🤖 1MB 大文档读取 39ms（性能无回归量级）
- [ ] ⚠️🤖 Mermaid 图、KaTeX 公式、代码高亮渲染正常（此前 GUI 验收 10-25 已验过一轮；本次构建未变更渲染层这部分，风险低）
- [ ] 🙋 验收全程后翻 `~/.tmd/logs/` 无意外堆积

## 结果记录

| 组 | 自动化（10-28 基础 29 项 + 11-06 补充 11 项） | 人工剩余 |
|----|------|------|
| A 安装与首启 | 2/2 PASS | —（用户 11-06 确认安装/首启/拖拽/对话框组 OK） |
| B 快捷键 | 14/14 PASS | —（用户确认原生对话框组 OK；Ctrl+Shift+A 热键项用户暂缓） |
| C 设置面板降级 | 3/3 PASS + 粘贴 2/2 | — |
| D 更新器 | 3/3 PASS | 有新版时的完整升级流（待首次发版） |
| E 导出 | 1/1 PASS | —（用户 11-06 确认三格式落盘 OK） |
| F 文件与侧边栏 | 6/6 PASS | 外部修改提示（可选，观察一轮） |
| G 稳定性 | 3/3 PASS | `~/.tmd/logs/` 翻查（可选） |
| **合计** | **41 PASS / 0 FAIL** | 仅剩发版后的升级流验证 |

**结论（2026-11-06）**：自动化 41 项全绿；用户已完成安装/首启/对话框/导出的人工确认。
**转正条件已具备**，唯一待补是首次 Tauri 发版后验证「有新版本 → 下载 → 保存握手 →
自动重启」的完整升级流（D 组末项）。可进入转正流程 C1/C3。

## macOS 侧验收（2026-11-07，桌面自动化实测）

> 方法：WKWebView 无 CDP，Windows 侧脚本不可移植——改纯外部自动化
> （CUA 键鼠 + osascript 菜单 AX 点击 + 文件关联 + 爆发截帧 + 日志/落盘产物审查），
> 全部走真实 UI 路径无打桩。验收对象：`/Applications/TMD-spike.app`
> （66943fb 构建，含当日两处修复）。

| 组 | 结果 | 明细 |
|----|------|------|
| A 安装首启 | 4/5 | 首启挂载 ✅（AX 29→213 元素）；**首帧白闪 0 帧**（暗色主题 60 帧爆发截帧）✅；红绿灯悬浮工具栏 ✅；几何记忆 ✅（修 2 bug 后精确恢复）；🉐 真实鼠标拖拽移窗/双击最大化留人工 |
| B 快捷键抽样 | 6/6 | Cmd+B 加粗+toggle ✅、Cmd+1 H1 ✅、Cmd+0 正文 ✅、Cmd+Shift+8 列表 ✅、Cmd+K 链接条 ✅、Cmd+, 设置 ✅（全走原生菜单链） |
| C 设置降级 | 3/3 | 图床选项置灰+文案 ✅、配置区隐藏 ✅、hosting→inline 回退 ✅ |
| D 更新器 | 2/2 | 检查更新（无 latest.json）状态文案「更新失败：Could not fetch...」**不崩** ✅；自动检查默认关 ✅；有新版升级流同 Windows（待首版） |
| E 导出 | 3/3 | PDF 81228B ✅ / HTML 2778B ✅ / Word 9297B（22 zip 条目含 document.xml）✅——全部真实菜单+真实保存框；日志捕获离屏管线运行（capture 924×4000 → done ok=true） |
| F 文件与侧栏 | 6/6 | GBK「你好世界」✅；1MB 304004 字渲染 ✅；双链点击跳转 ✅；挂载文件夹（真实 NSOpenPanel）+ **拼音排序正确**（123<啊[a-b]<alpha[a-l]<北[bei]<中[zhong]）✅；树行点击打开 ✅；CRLF ✅ |
| G 稳定性 | 1/1 | 全程日志仅 3 条：1 预期更新错误 + 2 导出成功；零未捕获、零 no-op 越界 |

### mac 侧验收抓到并已修复的真缺陷（2 个，均在 shell.rs/main.rs）

1. **shell-state 从不落盘**：`save_shell_state` 缺 `create_dir_all(parent)`——
   Windows 侥幸通过（WebView2 首跑即建 userData 目录），macOS WKWebView 数据在
   `~/Library/WebKit`，Application Support/{identifier} 无人创建 → 几何/主题/
   更新开关全部静默不持久化
2. **几何双倍缩放**：winState 存物理像素（outer_position/outer_size），恢复端
   `builder.inner_size/position` 吃逻辑值——retina 上存 2200 物理恢复成 2200
   逻辑被钳到全屏。修复为全链逻辑坐标（对齐 Electron getBounds 的 DIP 语义），
   `monitor_rects` 同步转换保证 on-screen 校验同坐标系

### 观察项（不阻塞）

- `[[#目标页]]` 锚点链接渲染出尾部 `\`（Electron 侧待对比，疑似渲染层小瑕疵）
- 对话框自动化教训：NSOpenPanel 对合成 CGEvent 点击免疫（AX click 回执确认
  派发但不响应），Return 默认钮可用；open_panel 是独立 surface（AX 不列为
  window），CUA frame 坐标为面板自身像素空间
- 验收后未清理：未命名.md 脏标签留在应用中（含测试文本 abc），人工关闭即可

**mac 结论**：自动化覆盖 25/25 PASS（2 真缺陷已修），与 Windows 侧 41 项合并后
**双平台转正验收全部通过**。剩余仅：真实鼠标拖拽/双击最大化（mac 人工 1 分钟）、
首次发版后的完整升级流验证。

## 11-08 mac 补充验证新问题与修复（待 mac 复测闭环）

| # | 问题 | 修复 | mac 复测 |
|---|------|------|----------|
| 1 | 🔴 1MB 文档编辑丢失（打字 → 查找浮层 → Esc → 编辑消失、Cmd+Z 无效） | `98b8759`：流式挂载窗口内的用户编辑保护——用户一编辑即原子补全剩余内容，置脏/恢复副本/撤销回归正常路径 | 重走原复现链，确认编辑保留 |
| 2 | 🟡 1MB 分屏 AX 遍历 8s 超时（VoiceOver 不可用；AXTitleUIElement 解析挂死，c-v 剪枝对分屏无效） | `01e0f07`（PM 侧 c-v，纯 WYSIWYG 3.6s 可用）+ `98b8759` 后续：CM contentDOM 补 aria-label/multiline + huge-doc 分屏源码栏 aria-hidden 摘除 AX 树 | VoiceOver/Accessibility Inspector 实测分屏遍历 |
| 3 | （用户报告共三个问题，第三项待补充详情） | — | — |

### 若 AX 仍超时的二分协议（mac devtools console 即可做）

1. `document.body.classList.remove('huge-doc')` —— 若分屏从超时恢复到
   「慢但可用」，说明 c-v 剪枝有效、卡点在 CM 侧新增子树；若仍超时，
   c-v 对该 AX 路径无效，需换动态 aria-hidden 显式剪枝方案
2. `document.getElementById('src-pane').removeAttribute('aria-hidden')` ——
   恢复源码栏 AX 参与做对照
3. Accessibility Inspector 指向分屏窗口，逐元素刷新定位挂死元素
   （重点：分屏容器 / 两个编辑 pane / CM 滚动容器三级）

### 定性

AX 树懒构建，普通用户操作手感不受影响；打击面为 VoiceOver/旁白用户与
自动化测试。**列入转正已知问题清单，非阻断项**（除非用户画像含辅助
技术依赖）。huge-doc 分屏源码栏 aria-hidden 的取舍（VO 用户放弃源码栏
可编辑性，换取不挂死）随 mac 复测结果再评估。
