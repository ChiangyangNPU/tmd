[简体中文](./README.md) | English

# TMD

**Type Markdown, Done.**

A cross-platform (macOS / Windows) WYSIWYG Markdown editor with Typora-like interactions. Its core feature is real-time rendering of Mermaid diagrams.

For the scope of requirements, see [docs/需求说明.md](docs/需求说明.md) (Chinese). For architecture and module responsibilities, see [docs/架构设计.md](docs/架构设计.md) (Chinese). For packaging and release, see [docs/打包发布.md](docs/打包发布.md) (Chinese).

## Quick Start

```bash
npm install   # Install dependencies first (see note below if the Electron binary download fails)
npm run dev            # Browser mode: http://localhost:5173
npm run dev:electron   # Desktop mode: starts vite and the Electron window together
npm run build          # Type check + production build
npm run test:desktop   # Desktop end-to-end check (run build first; real Electron + real menus; runs the main-flow and export-flow suites in sequence)
npm run bench          # Large-document performance benchmark (run build first; MB-scale text / dozens of Mermaid charts / mixed, with regression gates)
npm run dist:dir       # Package as a local directory app (no installer generated)
npm run dist           # Build installer (mac: dmg / win: nsis)
```

> If the Electron binary fails to download on first install (direct GitHub connection issues), use a mirror instead:
> `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`

## Features

- WYSIWYG editing (Milkdown / ProseMirror core + GFM: tables, task lists, strikethrough)
- **Real-time Mermaid rendering** (`src/mermaid.ts`, custom plugin):
  - Type ` ```mermaid ` and press Enter to create a diagram block
  - Cursor outside the block: renders SVG; click the diagram: enters source editing; cursor leaves: re-renders
  - 400ms input debounce; on syntax errors the stale diagram is cleared and an error hint is shown (consistent with Typora/Obsidian)
  - Stale render requests are discarded (sequence guard), so fast continuous typing never flashes old diagrams
- Math formulas (KaTeX: `$...$` inline / `$$...$$` block, rendered in real time)
- Code block syntax highlighting (`@milkdown/plugin-prism` + refractor; entering the block edits the source code, consistent with Typora)
- Multi-tab: same-path dedup, unsaved marker (`•`), per-tab scroll position memory; tab context menu to close current/other/left/right/saved/all tabs (one batch confirmation when unsaved tabs are involved)
- Source mode (CodeMirror 6 full-document editing with built-in search panel)
- Find & replace (decorator-based highlighting in WYSIWYG mode, replace current / replace all)
- Outline panel (headings level 1-3, click to jump) and TOC block (GitHub-style anchors)
- Table editing: floating toolbar on cursor entry (row/column add-remove, per-column alignment), drag-to-resize columns
- Quick switch panel (Ctrl/Cmd+P): fuzzy-search open tabs, all expanded folders and recent files, Enter to open
- **Cross-file search** (Ctrl/Cmd+Shift+F): line-by-line search across the folders mounted in the sidebar; results are grouped by file with line numbers and context (keyword highlighting) — ↑↓ to select, Enter to open and jump to the match. Dependency folders are skipped and per-file/result limits are enforced, so large workspaces never freeze the UI
- File sidebar: mount multiple folders at once (independent expansion, restored on restart, lazy-loaded on expand) plus a recent files list; both support hover × per-item removal and one-click clear (confirmation dialog; clearing folders only unmounts them, never deletes files on disk)
- Resizable sidebar: drag the divider between the sidebar and the editor to adjust the width (hover highlight, width remembered, double-click to reset; clamped automatically when the window narrows)
- Drag & drop: drop a .md file onto the window to open it (new tab); drop images to insert them per the paste strategy
- Formatting shortcuts & Format menu: headings 1–6 (Ctrl/Cmd+1–6), bold/italic (Ctrl/Cmd+B/I), link (Ctrl/Cmd+K), blockquote, lists, code block — all undoable
- **Custom shortcuts**: the settings panel lists 31 shortcuts grouped into File / Export / Format / Editor; click a key box and press a new combination to rebind. Includes conflict detection with inline error hints and one-click reset to defaults (Windows shows `Ctrl+Shift+O`, macOS follows Apple conventions showing `⇧⌘O`)
- Syntax extensions: footnotes `[^1]`, highlight `==text==`, superscript/subscript (both `^x^`/`~x~` and `^{x}`/`_{x}` are recognized; saving normalizes to the Pandoc single-symbol style), YAML front matter (a leading `---` fence renders as a key-value property table, click to edit the YAML source, written back byte-for-byte on save, stripped automatically from HTML/PDF export). Shortcuts: highlight Ctrl/Cmd+Shift+H, superscript Ctrl/Cmd+Shift+=, subscript Ctrl/Cmd+Shift+-
- Right-click context menu in the editor: cut/copy/paste plus selection-aware format items (including remove link)
- Link following: Ctrl/Cmd+click opens external URLs in the browser; relative-path links resolve against the document directory and open with the system app (hold Mod while hovering for a pointer hint)
- Triple paste-image strategy: inline data URL / save to `assets/` next to the document / upload to an image host (built-in PicGo-Core supporting SM.MS, GitHub, Qiniu, Upyun, Tencent COS, Aliyun OSS and Imgur — 7 providers; falls back to inline on failure; images >5MB ignored)
- HTML paste conversion: rich text copied from web pages / Word is converted to Markdown automatically (whitelist sanitizing + protocol filtering; headings / lists / tables / code blocks preserved)
- Relative-path images resolved against the document directory for display (document data keeps relative paths)
- Export to five formats: HTML (standalone file, Mermaid/KaTeX via CDN), PDF (via the system print dialog), **Word** (native editable .docx: headings, lists, tables, inline formatting and hyperlinks all become native Word elements; display formulas and Mermaid diagrams are embedded as 2x bitmaps), **long image** (a single PNG at no less than 2x physical resolution; long documents are captured and stitched in segments automatically) and **LaTeX** (standalone compilable .tex source: math passes through losslessly, CJK documents use the ctexart class, image paths resolve relative to the file; Mermaid diagrams are kept as comments)
- Autosave (writes back every 5 seconds; one shared switch for the settings panel and the menu)
- Spellcheck toggle (settings panel, Editor category, off by default: Chromium enables it on editable content with an English-only dictionary, so turning it off removes the red squiggly underlines; Chinese text is never checked)
- Dark/light theme switching (diagrams re-rendered in place — the editor is never rebuilt, preserving undo history / focus / scroll position)
- Theme presets (Default / Dark / Sepia / Green), file-based themes (`~/.tmd/themes/*.css` — the file name is the theme name; open the folder / reload from the settings panel) and custom CSS injection (takes effect immediately)
- Multilingual UI (Simplified Chinese / Traditional Chinese / English, follows the system, switchable in the settings panel)
- Settings panel with category navigation: widened to a two-pane layout (Appearance / Typography / Editor / Files & Images / Shortcuts / System / About on the left, content on the right); click to jump with scroll-synced highlighting, color-swatch theme previews; open via File → "Settings…" or `Cmd/Ctrl+,`
- Settings panel "About": app name, version (read from package.json), copyright, contact email, homepages (GitHub / Gitee), plus license declarations and direct links for the app itself and 13 third-party components (collapsed by default, expand to view)
- Auto-update (dual Gitee / GitHub feeds; a dialog asks before downloading, never silent)
- **Local crash capture & logs (zero telemetry)**: crashReporter writes minidumps only to `~/.tmd/crash-dumps` (no upload, no server, no crash dialog); JS errors from main/renderer and renderer crashes go to local JSONL logs under `~/.tmd/logs` (auto-rotated: 7 days / 10 files), and the previous crash is logged on the next launch; a settings-panel button opens the log folder (relocatable via `TMD_HOME_DIR`)
- **Local version history**: the on-disk content is archived to `~/.tmd/history` before every save (identical content is not duplicated; auto-pruned at 50 versions per file plus a 200 MB global cap); "File → Version History…" lists, previews and restores a version into the editor — restoring only changes the editor and marks it dirty, so overwriting the file stays your explicit decision
- **Split view**: source and WYSIWYG side by side (the ⋯ menu → "Split" / `Ctrl/Cmd+Shift+E`) — one pane is editable, the other follows along read-only; click a pane to make it the editable one (two-way live sync is intentionally not offered: Markdown round-tripping would rewrite your hand-written source). Scrolling is approximately synced, the divider is draggable and its width is remembered
- **Main-flow end-to-end tests**: driven against the real built app over the Chrome DevTools Protocol (no extra test framework), covering open / edit / dirty flag / save / save-as / version history / split-view two-way follow / unsaved-close interception / error persistence / renderer & main process crash recovery — 25 assertions in total
- **Electron desktop shell** (`electron/`):
  - Custom-drawn title bar: single-row toolbar with `─ □ ✕` window controls on Windows/Linux, immersive traffic lights on macOS; theme switches change frame synchronously
  - Native open / save / save-as dialogs; File menu shortcuts Cmd/Ctrl+O / S / Shift+S
  - File association (double-click a .md file to open) + single-instance lock (running instance receives the file)
  - Crash recovery (every content change is written to a localStorage recovery copy; native minidumps and logs land in `~/.tmd/`, fully local with zero telemetry)
  - The renderer keeps pure web logic; Node capabilities are exposed in a controlled way via preload (contextIsolation)
  - Automatic degradation in browser mode: file picking uses `<input type=file>`, saving becomes a download
  - Slim installers: an afterPack hook trims Electron's non-Chinese/English locale packs and WebGL/Vulkan rendering components; the Windows installer is about 93MB

## Tech Stack

Electron + TypeScript + Vite + Milkdown (ProseMirror) + Mermaid + CodeMirror 6 + KaTeX + refractor + PicGo-Core + dom-docx.

## Directory Structure

```
├─ index.html                    Main page entry (WYSIWYG + source mode)
├─ export-renderer.html          Offscreen export page (Word / long image, loaded by a hidden window)
├─ public/
│  └─ boot.js                    First-frame bootstrap script (theme / platform classes, prevents white flash)
│
├─ electron/                     Electron desktop shell (main process + preload)
│  ├─ main.cjs                   Main process entry (window creation, menu, IPC, image hosting, auto-update)
│  ├─ exporter.cjs               Offscreen export service (hidden window, serial task queue, capture & read-image primitives)
│  ├─ preload.cjs                Controlled API exposure (contextBridge)
│  ├─ ipc.cjs                    IPC channel name constants (shared by main and preload)
│  └─ Submodules (pure Node, independently verifiable):
│      ├─ history.cjs            Local version history (pre-write snapshots, hash dedup, two-tier pruning)
│      ├─ logger.cjs              Local JSONL logging & minidump scanning
│      ├─ search.cjs              Full-text search scanning & matching
│      └─ themes.cjs              File-based theme folder scanning & safety checks
│
├─ scripts/                      Build / test / pack scripts
│  ├─ trim-runtime.cjs           Pack hook: trims redundant Electron runtime files (locales, WebGL DLLs)
│  ├─ desktop-app-check.mjs      Main-flow, reliability, history & split-view desktop E2E (25 assertions)
│  ├─ desktop-export-check.mjs   Word / long-image export desktop E2E
│  ├─ desktop-bench.mjs          Large-document performance benchmark (open / input / scroll / long tasks, with regression gates)
│  └─ lib/
│     └─ desktop-harness.mjs     Shared desktop E2E driver (CDP client / isolated launch / process-group cleanup)
│
├─ src/                          Renderer layer (Vite build output)
│  ├─ main.ts                    App startup & global wiring (boot, hooks injection, shortcuts, menu callbacks)
│  ├─ editor-core.ts             Editor hub (create / rebuild / source mode / content retrieval)
│  ├─ mermaid.ts                 Mermaid real-time rendering plugin (core feature)
│  ├─ tabs.ts                    Multi-tab state machine
│  ├─ theme-presets.ts           Theme presets, file-based themes & custom CSS injection
│  ├─ shortcuts.ts               Shortcut configuration (definitions / read-write / validation / display formatting)
│  ├─ Search:
│  │  ├─ search.ts               Cross-file search panel (debounce / grouped rendering / jump & locate)
│  │  └─ find.ts                 Find & replace (decorator-based)
│  ├─ Export:
│  │  ├─ export-doc.ts           Export core (render pipeline / styles / image-ref classification, shared by all four formats)
│  │  ├─ export-word.ts          Word export (region capture rasterization + OOXML conversion)
│  │  ├─ export-image.ts         Long-image export (segment planning + canvas stitching)
│  │  └─ export-renderer.ts      Offscreen export page bootstrap (render pipeline + task dispatch)
│  ├─ Editor features:
│  │  ├─ mark-ext.ts             Syntax extensions (highlight / super-subscript: parsing, serialization, input rules)
│  │  ├─ frontmatter.ts          YAML front matter (property table ⇄ source dual-mode editing)
│  │  ├─ paste-image.ts          Pasted-image plugin (inline / assets / image host — triple strategy)
│  │  ├─ toc.ts                  Table-of-contents (TOC) block
│  │  ├─ split.ts                Split-view interaction (divider drag / click to pick the editable pane / approximate scroll sync)
│  │  ├─ history.ts              Version-history panel (snapshot list / preview / restore into the editor)
│  │  └─ style.css               All styles (CSS variables for dark/light themes + highlight colors)
│  └─ Utilities & infrastructure:
│     ├─ fs-path.ts              Filesystem path utilities (normalize / dirname / identity check)
│     └─ error-report.ts         Renderer uncaught-error / Promise-rejection capture & IPC reporting
│
└─ docs/                         Project documentation (Chinese)
   ├─ 需求说明.md                Feature list & roadmap
   ├─ 架构设计.md                Module responsibilities & data flow
   ├─ 详细设计.md                Key module implementation details
   ├─ 打包发布.md                Local packaging & CI release workflow
   └─ git-multi-remote.md        Dual-remote (Gitee + GitHub) sync guide
```

> For the full module responsibilities, see [docs/架构设计.md](docs/架构设计.md) (Chinese).

## License

This software is released under the [MIT License](LICENSE), Copyright (c) 2026 chiangyang.

License declarations and links for third-party components (Electron, Chromium, Node.js, Milkdown, CodeMirror, Markdown-It, Mermaid, KaTeX, Refractor, remark-frontmatter, PicGo-Core, electron-updater, dom-docx) are available in the app's Settings → About panel.
