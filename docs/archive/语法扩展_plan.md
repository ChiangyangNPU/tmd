# 语法扩展（脚注 / ==高亮== / 上下标 / YAML front matter）实施计划

> 对应路线图 v1.2 最后一项「语法扩展」。本计划经交互决策确认后执行。

## 已确认的交互决策

1. **上下标语法**：两种都解析——Pandoc 风格 `^x^`、`~x~` 与花括号风格 `^{x}`、`_{x}`；**序列化统一输出 Pandoc 风格** `^x^`/`~x~`
2. **YAML front matter**：所见即所得中渲染为**键值属性表**；点击「编辑」/双击切换为等宽 YAML 文本编辑，失焦或 Ctrl+Enter 提交、Esc 取消；YAML 非法时提示并保留原文。保存到 .md 时**原样写回** `---` 围栏文本
3. **导出 HTML / 打印 PDF**：剥离文档开头的 front matter，不进入成稿正文（.md 源文件始终保留）
4. **菜单入口**：格式菜单与编辑器快捷键均加入「高亮 / 上标 / 下标」
5. **节奏**：四项一次完成，分步提交，最后统一更新文档

## Repository Research（现状结论）

- 编辑器为 Milkdown 7（`@milkdown/kit` 7.0），底层 unified 11 / remark-parse 11 / mdast-util-from-markdown 2（micromark 4 系）
- **脚注在编辑器侧仅被 gfm preset 半支持**：`.use(gfm)` 内含 `remark-gfm`（micromark/mdast 脚注解析）+ `footnote_definition`（块）/`footnote_reference`（atom 内联）两个 schema 及双向序列化，但**没有输入规则**——所见即所得中手打 `[^1]`/`[^1]: ` 不会转换（实施时已在 mark-ext.ts 补齐两条输入规则与 Enter 退出键位，详见文末「实施偏差与测试结论」）。其余缺的是 CSS 样式、导出 HTML 支持与测试
- 自研插件模式成熟可仿：[toc.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/toc.ts)（`$remark` mdast transform + `$nodeSchema` + `$view` + InputRule + 序列化往返）、[mermaid.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/mermaid.ts)（可编辑块节点）、image-attrs.ts（mark 扩展）
- 导出管线独立：[export.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/export.ts) 内自建 `new MarkdownIt({ html:false, linkify:true })`，`renderMarkdown` 为纯函数且已有单测；`EXPORT_CSS` 控制导出样式，`collectThemeVars()` 固定收集 8 个 CSS 变量注入导出页
- 格式入口三处联动：[main.cjs](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/electron/main.cjs#L288-L350) 应用菜单（内置中英文字典 `L()`）→ IPC `fmt-*` → [format.ts](file:///Users/juran/MyFiles/Study/workspace/gitee/tmd/src/format.ts) 的 `MENU_COMMANDS` / `formatKeymap`
- 测试为 vitest（node 环境，无浏览器 DOM 集成）：策略为**纯函数导出 + 单测**（与 toc.test.ts 同构）；编辑器内真实往返靠浏览器手测
- 生态选型：编辑器侧高亮/上下标**自研 mdast transform**（冷门 remark 包不可靠：remark-supersub 周下载 9.7w 但 5 年未更新、无 stringify 方向、不支持嵌套；micromark-extension-sub-sup 周下载仅 13）；front matter 用官方 `remark-frontmatter@5`；导出侧用 4 个成熟 markdown-it 插件

## Files and Modules

| 文件 | 改动 |
|---|---|
| `src/mark-ext.ts` | **新增**：高亮/上标/下标的 mdast transform（纯函数导出）、toMarkdown handlers、3 个 `$markSchema`（mark/sup/sub，含 parseDOM），导出 `markPlugins`；**另含脚注两条输入规则**（`footnoteRefInputRule` 行内 `[^label]` 原子化、`footnoteDefInputRule` 行首 `[^label]: ` 转定义块）与 `footnoteDefExit`（定义块段尾 Enter 退出），共用行内代码/公式未闭合围栏守卫 |
| `src/frontmatter.ts` | **新增**：`remark-frontmatter` 接入、frontmatter 块 schema（atom，attrs.value 原文）、NodeView（属性表展示态 ↔ YAML textarea 编辑态）、文档起始 `---` InputRule、轻量键值解析纯函数 |
| `src/editor-core.ts` | `.use(markPlugins)`、`.use(frontmatterPlugins)`，插件清单注释更新 |
| `src/export.ts` | mdIt 接入 footnote/mark/sub/sup 四插件；`renderMarkdown` 前剥离开头 front matter（纯函数 `stripFrontMatter` 导出）；`EXPORT_CSS` 补脚注/mark/上下标样式；导出页 mark 配色（加进 collectThemeVars 或固定色，实现时二选一并保证深浅色可读） |
| `src/format.ts` | `MENU_COMMANDS` 增 `fmt-mark`/`fmt-sup`/`fmt-sub`；keymap 增 `Mod-Shift-h`、`Mod-Shift-=`、`Mod-Shift--` |
| `electron/main.cjs` | 格式菜单「行内代码」后插入 高亮/上标/下标三项及 accelerator；内置中英字典补词条 |
| `src/locales/zh-CN.json`、`en.json` | 菜单词条；frontmatter 节点「编辑/完成/空提示/YAML 错误/复杂值占位」文案 |
| `src/style.css` | 脚注引用与定义块样式、`mark` 高亮（随主题变量，深浅两套）、sup/sub 字号；frontmatter 属性表（虚线容器、键列、编辑态 textarea） |
| `src/__tests__/mark-ext.test.ts` | **新增**：transform 配对规则、奇数分隔符不处理、`~~删除线~~` 不被切、两种上下标语法、code/math 节点内不误切、toMarkdown 统一输出 Pandoc 风格；另含 `FOOTNOTE_REF_RE`/`FOOTNOTE_DEF_RE` 正则用例（占位形态 `￼` 与字面 `[^1]` 双形态） |
| `src/__tests__/frontmatter.test.ts` | **新增**：`stripFrontMatter`（仅剥离文档开头、中间 `---` 保留）、键值解析（含复杂值占位） |
| `src/__tests__/export-html.test.ts` | 追加：脚注/mark/sub/sup HTML 断言、front matter 剥离断言 |
| `src/__tests__/format.test.ts` | 追加：三个新 mark 命令 toggle 行为 |
| 文档 | 路线图勾选+备注、需求说明 v1.x 清单、详细设计新增「4.4 扩展行内语法与 front matter」、架构设计模块表/目录树、README 中英特性与快捷键 |

## Implementation Steps（依赖序）

0. **Spike（先做，30 分钟内验证）**：最小 `$remark` 插件验证在 Milkdown 7 中经 `this.data()` 注入 `toMarkdownExtensions` handlers 能影响 getMarkdown 输出（这是自研 mark 序列化的前提）。失败则启用风险节中的退路
1. 安装 devDependencies：`remark-frontmatter@^5`、`markdown-it-footnote`、`markdown-it-mark`、`markdown-it-sub`、`markdown-it-sup`
2. `src/mark-ext.ts` 高亮：纯 transform 函数（成对 `==` 切分 text 节点）+ handler + mark schema（`<mark>` parseDOM，粘贴 HTML 自动转换）→ 单测
3. 同文件加上下标：`^x^`/`~x~` 与 `^{x}`/`_{x}` 成对切分（先花括号后单符号，避免误配）、统一 Pandoc 序列化、两个 mark schema（`<sup>`/`<sub>`）→ 单测
4. 脚注：CSS + export.ts 接入 `markdown-it-footnote` + 导出样式与单测；确认 gfm 脚注在编辑器中的实际渲染；**实施中追加**：mark-ext.ts 补行内引用 / 定义块两条输入规则（gfm preset 不含）与定义块 Enter 退出键位
5. export.ts 接入 mark/sub/sup 插件与样式、`stripFrontMatter` → 单测
6. 菜单三连：format.ts 命令与快捷键 → main.cjs 菜单与字典 → 两份 i18n → format 单测
7. `src/frontmatter.ts`：schema（parse/serialize 往返）→ NodeView 双态 → InputRule → 样式 → i18n → 纯函数单测
8. editor-core.ts 装配两个插件
9. 全量验证（见 Validation）+ 浏览器手测
10. 文档更新（5 处）

## Dependencies and Considerations

- transform 只切分 mdast **text 节点**：`~~删除线~~` 此时已是 delete 节点（内部 text 无波浪号）；行内代码是 inlineCode（value 而非 text 子节点）；数学公式在 math 节点；链接 URL 在 link 节点属性——均天然免疫误切
- 配对规则：奇数个分隔符不处理（保持原文）；不跨行（text 节点不跨行）；mark 内不再解析其他行内语法（与 Obsidian/Typora 行为一致，首版明确不支持嵌套）
- front matter 仅认**文档开头**的 `---` 围栏（remark-frontmatter 默认行为），正文中间的 `---` 仍是分隔线
- frontmatter 的 value 始终是**原文**，属性表解析只用于展示（平铺 `key: value`；列表/多行/嵌套值显示「复杂值，点击编辑查看」），绝不重新序列化 YAML——保证保存字节级原样往返
- 空文档首行输入第三个 `-`（正则 `^---$`，无需回车）即整段替换为空 frontmatter 节点（`EMPTY_FRONTMATTER = '---\n\n---'`，`fresh:true`）并自动进入编辑态；仅文档第一个顶层段落生效；该输入规则在 editor-core.ts 中**先于 commonmark 单独注册**，抢在水平线规则之前
- 编辑器内脚注定义为可编辑块（gfm 官方行为：`<dl><dt>1</dt><dd>内容</dd></dl>`），不做跳转联动（点击引用滚动到定义）——首版可接受，列为已知限制
- 导出为离线场景：markdown-it 插件本地打包，无新增 CDN
- 菜单快捷键冲突排查：`Mod-Shift-H`、`Mod-Shift-=`、`Mod-Shift--` 在 Chrome/Electron 均无内置占用；mac 菜单 accelerator 用 `CmdOrCtrl+Shift+...`
- CodeMirror 源码模式：`@codemirror/lang-markdown` 自带 YAML 围栏高亮，无需改动；`==`/`^`/`~` 无特殊高亮，接受

## Validation

- `npx vitest run` 全绿（**实际 16 个测试文件 / 172 个用例**）
- `npm run build`（tsc + vite）、`npm run lint`、`npx prettier --check .`
- 手测清单：
  - `==高亮==` 渲染/往返、与粗斜体混排、粘贴 `<mark>` HTML 转换
  - `x^2^`、`H~2~O`、`x^{2}`、`H_{2}O` 四种写法渲染；保存后统一变 `x^2^`/`H~2~O`
  - `~~删除线~~` 不受上下标影响；行内代码、`$a^{b}$` 公式内不误切
  - 脚注 `[^1]` + 文末定义的渲染、编辑、保存往返、定义块段尾 Enter 退出
  - 文档开头 `---` front matter：属性表展示、进入/退出编辑、非法 YAML 提示、保存原样、正文 `---` 不受影响
  - 格式菜单三命令与快捷键、浏览器模式快捷键
  - 导出 HTML：四类语法渲染正确、front matter 已剥离、脚注锚点可点
- 桌面端实测结论见文末（CDP 自动化 27 项断言全过）

## Risks

- **$remark 注入 toMarkdownExtensions 不生效**（Spike 验证项）：退路为在 transform 插件 stringify 阶段把 superscript/subscript/highlight 节点原地展开为「分隔符 text + 子节点 + 分隔符 text」（`^`/`~`/`=` 均非 remark-stringify 转义字符），parse 方向同插件只做 text→节点单方向转换，两个 pipeline run 独立不构成循环
- **Pandoc 单符号语法误伤**（如 `a ~ b ~ c` 口语化波浪号）：要求成对且非空才转换，与 remark-supersub 同策略；花括号语法为无歧义备选
- **mark 配色与主题**：`mark` 默认黄底在深色主题下需调背景/文字对比；CSS 变量接入既有主题体系，导出页同步注入或用固定语义色
- **frontmatter NodeView 与 ProseMirror 协作**：textarea 需 `stopEvent`/`ignoreMutation` 正确隔离（仿 TocView），编辑提交时用 `setNodeMarkup` 更新 attrs，避免节点整体重建丢焦点

---

## 实施偏差与测试结论（2026-09-14 更新，对应提交 3c503e6）

### 与原计划的偏差

1. **脚注并非「零 schema 代码」**：gfm preset 只提供 schema + remark 解析，**不含输入规则**。实际在 mark-ext.ts 补齐：
   - `footnoteRefInputRule`：行内输入 `[^label]` 的 `]` 瞬间把引用替换为 `footnote_reference` 原子节点（正则 `FOOTNOTE_REF_RE`）
   - `footnoteDefInputRule`：新行输入 `[^label]: `（尾随空格）把整段转为 `footnote_definition`（dl/dt/dd）。正则 `FOOTNOTE_DEF_RE = /^(\ufffc|\[\^([^\s\]]+)\]):\s$/` 须兼容两种形态——正常输入流里 `[^label]` 已成原子节点，InputRule 的 textBefore 以 `￼`（U+FFFC）占位，label 从节点 attrs 取；字面形态（如粘贴后补冒号）label 取正则分组
2. **脚注定义转换的空段落坑（桌面端测试发现并修复）**：初版 `replaceWith(start, $start.after(), …)` 从段落**内容起点**替换，ProseMirror 切开段落节点后左侧残留空壳，序列化为多余的 `<br />`。修复为整段替换 `$start.before()` → `$start.after()`，并显式把光标送进 dd 内空段落；另加 `$start.parentOffset !== 0` 守卫防止长段落中 `^` 锚失效时误转
3. **脚注定义 Enter 逃逸（桌面端测试发现的新缺陷）**：commonmark 的 Enter 键位只绑在 list_item 内，dl 内不命中，默认分段会把后续段落全部困在脚注体里（序列化被缩进 4 空格）。新增 `footnoteDefExit`（`$prose(keymap)`）：光标在定义块最后一个子块段尾时按 Enter，在 dl 之后插入正文段落并移光标（Typora 同款）；非段尾位置返回 false 走默认分段，保留脚注体多段落编辑。注意末位判断用语义化的「lastChild + parentOffset 段尾」，不能用 `after(d)-1`（那是 dl 自身闭合 token 位，差一个子块 token）
4. **frontmatter 触发时机**：输入第三个 `-` 即刻触发（`^---$`），无需原计划设想的回车；输入规则须在 editor-core.ts 中先于 commonmark 单独 `.use()`
5. Spikes 风险项（$remark 注入 toMarkdownExtensions）按首选方案落地，未启用退路

### 桌面端实测（CDP 连接运行中的 TMD.app，真实键鼠模拟，共 27 项断言全过）

- **输入路径 15 项**：`==`/`^`/`~`/`^{}`/`_{}` 五种输入规则、脚注引用与定义、Enter 逃逸后正文落在 dl 之外且 dd 不被污染、三个快捷键（Cmd+Shift+H/=/-）；序列化验证高亮原样、花括号写法统一 Pandoc 风格、脚注配对、全程无 `<br />`
- **解析往返 12 项**：写入含 front matter + 四类语法的文档后 reload，DOM 节点计数全部正确；脚注定义内追加文本正确；front matter 字节级原样往返；首段 `---` 创建空 front matter
- 单测 172 全过，`tsc + vite build`、eslint、prettier 全绿
- 测试中的两个假警报为 CDP 模拟自身陷阱（非应用缺陷）：选区存在时 CDP 的 Enter 携带 `\r` 会替换选中文本（真实键盘 Enter 无字符输入）；`Cmd+End` 在 PM 中定位不可靠，改用鼠标点击段落
- 未纳入自动化、仍靠既有单测/手测覆盖：粘贴富 HTML 转换、导出 HTML/PDF 的剥离与锚点（export-html.test.ts 覆盖）、Electron 应用菜单 accelerator 路径（与既有 fmt-* 命令同构）
