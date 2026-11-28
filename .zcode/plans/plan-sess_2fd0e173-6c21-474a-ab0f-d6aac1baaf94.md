# TMD 官网（TMDWeb）实现计划

## Context

`tmd` 是跨平台（macOS/Windows）所见即所得 Markdown 编辑器（Tauri 2 + Milkdown，核心特性 Mermaid 实时渲染），当前版本 v0.2.4-Fix-1，MIT 协议，托管于 GitHub/Gitee。`TMDWeb` 是刚初始化的 Spring Boot 4.2 骨架，需要在其中构建产品官网。

已确认的方案：**Spring Boot 静态站点 + 单页落地页 + 液态玻璃深色风 + 中英双语切换**。品牌视觉从应用设计令牌提取（`tmd/src/styles/01-tokens.css`）：强调色 `#7aa2e8`（深色）/`#4a7cd4`（浅色）、深色底 `#1e2127`、玻璃拟态工具栏 `rgba(...,0.85)`、字体栈 `-apple-system…PingFang SC…`。口号 **"Type Markdown, Done."**（出自 tauri.conf.json）。

仓库无应用截图 → 界面展示用**纯 HTML/CSS 手绘编辑器窗口模拟图**（Markdown 源码侧 + 渲染结果侧 + SVG 流程图，配打字动画），不依赖任何截图素材。

## 文件清单（全部新增，不改 Spring Boot 代码）

```
TMDWeb/src/main/resources/static/
├─ index.html              单页落地页（所有文案带 data-i18n 属性）
├─ assets/css/style.css    唯一样式表（设计令牌 + 各区块 + 响应式）
├─ assets/js/i18n.js       zh/en 双语字典 + 应用逻辑（含 <title>/meta 切换）
├─ assets/js/main.js       导航滚动态、滚动渐入、hero 打字动画、版本号动态获取（GitHub API，失败回退静态值）
├─ assets/img/icon.png     拷贝自 tmd/src-tauri/icons/128x128@2x.png（logo + favicon）
```

`application.properties` 保持默认（8080 端口）。

## 页面区块

1. **导航**：sticky 玻璃条 —— logo+TMD、锚点（特性/展示/下载/日志）、语言切换（中/EN）、GitHub/Gitee 链接；移动端折叠。
2. **Hero**：图标 + "Type Markdown, Done." 大标题 + 中文副标（跨平台所见即所得 Markdown 编辑器，Mermaid 图表实时渲染）；版本徽章 v0.2.4-Fix-1 · macOS / Windows；下载按钮（Gitee 直链 exe/dmg，GitHub releases 备选）；右侧/下方编辑器窗口模拟图（CSS 绘制，含 mermaid 流程图 SVG + 打字动画）。
3. **功能特性**：玻璃卡片网格 ~12 项（文案取自 README）：Mermaid 实时渲染（置顶主打）、所见即所得（Milkdown/ProseMirror + GFM）、KaTeX 公式、源码模式与分屏、双链/反向链接/关系图谱、多标签页与快速切换（拼音首字母匹配）、全文搜索与命令面板、六格式导出（HTML/PDF/Word/长图/ePub/LaTeX）、图床上传 7 家、主题系统（液态玻璃 Pro）、本地历史版本、隐私与自动更新（minisign 签名校验、日志零遥传）。
4. **界面展示**：3 个 CSS 视觉卡 —— 液态玻璃 Pro 效果演示（毛玻璃折射质感）、双链图谱示意（SVG 力导向风格点线）、导出格式徽章行。
5. **下载**：macOS / Windows 双卡片（dmg / exe 直链 Gitee Release + GitHub/Gitee Releases 页链接）；macOS Gatekeeper 首开提示一段简述（应用内更新可免拦截）。
6. **更新日志**：静态 4 条 —— 0.2.4-Fix-1（macOS 文件关联修复）、0.2.4（-Fix-N 热修机制）、0.2.3（窗口 980×800 等）、0.2.0（Electron→Tauri：290MB→6MB 等里程碑数据，来自 CHANGELOG）。
7. **页脚**：MIT License © 2026 chiangyang、GitHub/Gitee/邮箱、"本网站与所列第三方无隶属"类说明不需要则省略。

## 双语机制

- HTML 元素带 `data-i18n="key"`；`i18n.js` 内置 `zh` / `en` 两套字典（约 80 键），中文文案源自 README，英文参考 README-EN.md 改写。
- 导航「中/EN」按钮切换 → 遍历替换文本、更新 `<html lang>`、`<title>`、meta description，`localStorage` 记忆，默认中文（首次访问按浏览器语言判断）。
- 纯静态实现，无构建步骤。

## 验证

1. `./gradlew bootRun` 启动，确认 http://localhost:8080 可访问。
2. 用 browser-use 技能打开页面截图：核对液态玻璃视觉、hero 模拟图、各区块布局。
3. 点击语言切换验证中英替换完整（含 title）；点击各锚点验证平滑滚动；缩窄视口验证响应式；验证下载链接指向正确的 Release 地址。