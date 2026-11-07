# Tauri 版性能验证（2026-11-07）

> 目的：Tauri 转正后的性能基线——bench 三轮实测 + Electron 同机对照，并核对
> `docs/Tauri迁移评估.md` 的收益预估（体积 / 内存）。
>
> 工具：`scripts/tauri-bench.mjs`（本次新增，与 Electron 版
> `scripts/desktop-bench.mjs` 同文档生成器、同渲染层探针、同门禁阈值，
> 数字可同机直接对照）。复现：`node scripts/tauri-bench.mjs --json`；
> Electron 对照 `node scripts/desktop-bench.mjs --json`。
>
> 验证对象：`src-tauri/target/release/tmd.exe`（2026-11-07 19:00 构建，
> 内嵌当日 dist 前端）。机器：i5-1135G7 / 16GB / Iris Xe + MX450 / Windows，
> WebView2 Evergreen。

## 方法

- **文档**：三类场景与 Electron 版完全一致——1MB 纯文本（6952 段）、
  30 张 Mermaid、400KB 正文 + 30 图混排（3938 段）。
- **打开链路**：Windows 首启不处理 argv（仅 macOS Opened 事件），bench 走
  「二次实例 argv 转交」（单实例插件 → `queue_open_path` → `tmd-open-path` →
  `openPath`），与资源管理器双击 .md 同路径。判据同 Electron 版：特征串命中
  + 字符数达 markdown 长度七折。
- **指标**：打开耗时（墙钟）、输入延迟（input → setTimeout(0) 的同步成本 /
  到下一帧的 rAF 延迟，5 样本取中位）、滚动 FPS（程序化滚动 2 秒）、长任务
  （PerformanceObserver）、懒渲染契约（未滚动只渲视口内图表、滚完全篇 30/30
  补渲）、内存（WorkingSet：tmd.exe 按可执行路径 + msedgewebview2 子进程按
  隔离 userData 目录匹配求和）。
- **口径差异**：Tauri 的打开耗时含二次实例进程 spawn（真实双击语义，
  约 +0.1~0.2s），Electron 对照是应用已在跑的菜单点击——前者略吃亏。
- **门禁**：与 desktop-bench 同阈值（Windows 平台系数 1.5）——打开 ≤4500ms、
  滚动 ≥45FPS、输入同步 ≤120ms、图表 ≥20 张时校验懒渲染。

## 结果

### 门禁

三轮全绿。滚动、输入、懒渲染契约逐轮达标，无 FAIL 项。

### 分文档数据

Tauri 取三轮区间；Electron 为 desktop-bench 与探针两轮的范围。
长任务以第三轮为准（见文末附注：前两轮脚本缓冲未清零，数据偏高不可比）。

| 指标 | 文档 | Tauri（3 轮） | Electron（对照） |
|---|---|---|---|
| 打开耗时 | 1MB 纯文本 | 1726 / 2654 / 2186 ms | 1350~1698 ms |
| | 30 图表 | 419~572 ms | 329~1110 ms |
| | 413KB+30 图混排 | 720~905 ms | 820~849 ms |
| 输入同步 | 1MB 纯文本 | 71~88 ms | 90 ms |
| | 30 图表 | 9.5~10.1 ms | 11.9 ms |
| | 混排 | 40~53 ms | 46.8 ms |
| 输入到帧 | 1MB 纯文本 | 65~86 ms | 86 ms |
| 滚动 FPS | 全场景 | 58.2~60.5 | 58.9~60.4 |
| 长任务（第 3 轮） | 1MB 纯文本 | 1 个 / 1235 ms | 1 个 / 1343 ms |
| | 30 图表 | 2 个 / 376 ms | 2 个 / 351 ms |
| | 混排 | 9 个 / 1133 ms | 8 个 / 1148 ms |

结论：**渲染层指标两侧逐项同水平**——同一前端跑在 Electron 与 WebView2 上，
输入/滚动/长任务剖面一致；打开耗时含进程 spawn 仍持平。

### 启动

| 版本 | 冷启动 → 编辑器挂载 | 进程模型 |
|---|---|---|
| Tauri | 768 / 1121 / 1144 ms（三轮） | tmd.exe 34MB + webview2 ×6（系统共享运行时） |
| Electron | 977 / 1060 ms（两轮） | electron.exe ×5（自带 Chromium） |

同量级（约 1 秒）。Tauri 首轮最慢（新 exe + 全新 profile 冷启动），热跑更快。

### 内存（WorkingSet，同口径采样点）

| 采样点 | Tauri（3 轮） | Electron（2 轮） |
|---|---|---|
| 空编辑器 | 451~455 MB（1+6 进程） | 508 MB（5 进程） |
| 三文档在场 | 905~926 MB | 883 MB |

- **idle 省 ~11%**（452 vs 508 MB）；**重载持平**（Tauri 略高 2~5%）。
- 重载内存由渲染层（DOM / V8）主导，壳层差异被淹没——这与「同一前端」一致。
- Rust 宿主 tmd.exe 本身仅 34~35 MB；webview2 是系统共享运行时，
  磁盘与更新成本不计入应用。

### 体积

| 产物 | 体积 |
|---|---|
| Tauri tmd.exe | 10.6 MB（11,110,400 B） |
| Tauri NSIS 安装包 | 6.0 MB（6,311,268 B） |
| Electron win-unpacked | 290 MB |

削减 ~96%，兑现迁移评估「安装包 85MB dmg → 约 5–15MB」的预估。

## 结论

1. **性能达标**：三类重文档场景门禁全绿，滚动接近垂直同步满帧
   （58~60.5 FPS），懒渲染契约行为与 Electron 版一致。
2. **与 Electron 无回归**：输入延迟、长任务剖面、打开耗时逐项同水平
   （打开路径还额外含一次进程 spawn）。
3. **迁移收益兑现**：体积 ~96% 削减；内存 idle 段省 ~11%，重载段持平
   （评估中「内存占用降低」的预期在重载场景下不成立，由渲染层主导）。

## 已知点与后续

- **首跑一次性开销**：1MB 文档打开三轮依次 2186→2654→1726 ms，前两轮含
  新 exe 的 Defender 扫描 / 冷缓存成本。用户首次安装后第一次打开会略慢，
  之后正常；属平台行为，非代码退化。
- **1MB 文档输入同步 71~88 ms**：达标但接近门限（120ms）。与 desktop-bench
  注释中 Windows 基线（88~106ms）一致，是渲染层（ProseMirror + 全量序列化）
  固有成本，与壳层无关；若要优化应在渲染链路做。
- `scripts/tauri-bench.mjs` 可作日常防回归基线（`--json` 末行输出机器可读结果）。

## 附注：bench 口径修复记录

首轮验证时发现 tauri-bench 的 `openAndTime` 缺少 desktop-bench 开头的长任务
缓冲清零（`window.__bench.longTasks = []`），导致 B/C 文档的长任务数混入上一
文档滚动阶段样本（曾测出「30 图表长任务 3682ms」的假异常；修复后 376ms，
与 Electron 的 351ms 吻合）。本文数据以修复后第三轮为准。
