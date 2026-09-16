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
- Multi-tab: same-path dedup, unsaved marker (`•`), per-tab scroll position memory
- Source mode (CodeMirror 6 full-document editing with built-in search panel)
- Find & replace (decorator-based highlighting in WYSIWYG mode, replace current / replace all)
- Outline panel (headings level 1-3, click to jump) and TOC block (GitHub-style anchors)
- Table editing: floating toolbar on cursor entry (row/column add-remove, per-column alignment), drag-to-resize columns
- Quick switch panel (Ctrl/Cmd+P): fuzzy-search open tabs, all expanded folders and recent files, Enter to open
- **Cross-file search** (Ctrl/Cmd+Shift+F): line-by-line search across the folders mounted in the sidebar; results are grouped by file with line numbers and context (keyword highlighting) — ↑↓ to select, Enter to open and jump to the match. Dependency folders are skipped and per-file/result limits are enforced, so large workspaces never freeze the UI
- File sidebar: mount multiple folders at once (independent expansion, restored on restart, lazy-loaded on expand) plus a recent files list; both support hover × per-item removal and one-click clear (confirmation dialog; clearing folders only unmounts them, never deletes files on disk)
- Drag & drop: drop a .md file onto the window to open it (new tab); drop images to insert them per the paste strategy
- Formatting shortcuts & Format menu: headings 1–6 (Ctrl/Cmd+1–6), bold/italic (Ctrl/Cmd+B/I), link (Ctrl/Cmd+K), blockquote, lists, code block — all undoable
- **Custom shortcuts**: the settings panel lists 29 shortcuts grouped into File / Export / Format / Editor; click a key box and press a new combination to rebind. Includes conflict detection with inline error hints and one-click reset to defaults (Windows shows `Ctrl+Shift+O`, macOS follows Apple conventions showing `⇧⌘O`)
- Syntax extensions: footnotes `[^1]`, highlight `==text==`, superscript/subscript (both `^x^`/`~x~` and `^{x}`/`_{x}` are recognized; saving normalizes to the Pandoc single-symbol style), YAML front matter (a leading `---` fence renders as a key-value property table, click to edit the YAML source, written back byte-for-byte on save, stripped automatically from HTML/PDF export). Shortcuts: highlight Ctrl/Cmd+Shift+H, superscript Ctrl/Cmd+Shift+=, subscript Ctrl/Cmd+Shift+-
- Right-click context menu in the editor: cut/copy/paste plus selection-aware format items (including remove link)
- Link following: Ctrl/Cmd+click opens external URLs in the browser; relative-path links resolve against the document directory and open with the system app (hold Mod while hovering for a pointer hint)
- Triple paste-image strategy: inline data URL / save to `assets/` next to the document / upload to an image host (built-in PicGo-Core supporting SM.MS, GitHub, Qiniu, Upyun, Tencent COS, Aliyun OSS and Imgur — 7 providers; falls back to inline on failure; images >5MB ignored)
- HTML paste conversion: rich text copied from web pages / Word is converted to Markdown automatically (whitelist sanitizing + protocol filtering; headings / lists / tables / code blocks preserved)
- Relative-path images resolved against the document directory for display (document data keeps relative paths)
- Export: HTML (standalone file, Mermaid/KaTeX via CDN) and PDF (via the system print dialog)
- Autosave (writes back every 5 seconds; one shared switch for the settings panel and the menu)
- Dark/light theme switching (diagrams re-rendered in place — the editor is never rebuilt, preserving undo history / focus / scroll position)
- Theme presets (Default / Dark / Sepia / Green), file-based themes (`~/.tmd/themes/*.css` — the file name is the theme name; open the folder / reload from the settings panel) and custom CSS injection (takes effect immediately)
- Multilingual UI (Simplified Chinese / Traditional Chinese / English, follows the system, switchable in the settings panel)
- Settings panel "About": app name, version (read from package.json), copyright, contact email, homepages (GitHub / Gitee), plus license declarations and direct links for the app itself and 10 third-party components
- Auto-update (dual Gitee / GitHub feeds; a dialog asks before downloading, never silent)
- **Electron desktop shell** (`electron/`):
  - Custom-drawn title bar: single-row toolbar with `─ □ ✕` window controls on Windows/Linux, immersive traffic lights on macOS; theme switches change frame synchronously
  - Native open / save / save-as dialogs; File menu shortcuts Cmd/Ctrl+O / S / Shift+S
  - File association (double-click a .md file to open) + single-instance lock (running instance receives the file)
  - Crash recovery (every content change is written to a localStorage recovery copy)
  - The renderer keeps pure web logic; Node capabilities are exposed in a controlled way via preload (contextIsolation)
  - Automatic degradation in browser mode: file picking uses `<input type=file>`, saving becomes a download
  - Slim installers: an afterPack hook trims Electron's non-Chinese/English locale packs and WebGL/Vulkan rendering components; the Windows installer is about 93MB

## Tech Stack

Electron + TypeScript + Vite + Milkdown (ProseMirror) + Mermaid + CodeMirror 6 + KaTeX + refractor + PicGo-Core.

## Directory Structure

```
index.html                Page entry
public/boot.js            First-frame bootstrap script (theme/platform classes, prevents white flash)
electron/main.cjs         Electron main process (window, menu, IPC file read/write, image hosting, auto-update)
electron/search.cjs       Full-text search scanning & matching (pure Node, independently verifiable)
electron/themes.cjs       File-based theme folder scanning & safety checks (pure Node, independently verifiable)
electron/ipc.cjs          IPC channel name constants (shared by main process and preload)
electron/preload.cjs      Controlled API exposure (contextBridge)
scripts/trim-runtime.cjs  Pack hook: trims redundant Electron runtime files (locales / WebGL DLLs)
src/main.ts               App startup & global wiring (boot / hooks injection / shortcuts / menu callbacks)
src/editor-core.ts        Editor hub (create / rebuild / source mode / content retrieval)
src/tabs.ts               Multi-tab state machine
src/mermaid.ts            Mermaid real-time rendering plugin (core)
src/theme-presets.ts      Theme presets, file-based themes & custom CSS injection
src/shortcuts.ts          Shortcut configuration (definitions / read-write / validation / display formatting)
src/search.ts             Cross-file search panel (debounce / grouped rendering / jump & locate)
src/fs-path.ts            Filesystem path utilities (normalize / dirname / identity check)
src/find.ts               Find & replace (decorator-based)
src/toc.ts                Table-of-contents (TOC) block
src/mark-ext.ts           Syntax extensions (highlight / super-subscript: parsing, serialization, input rules)
src/frontmatter.ts        YAML front matter (property table ⇄ source dual-mode editing)
src/paste-image.ts        Pasted-image plugin (inline / assets / image host — triple strategy)
src/style.css             All styles (CSS variables for dark/light themes + highlight colors)
docs/                     Requirements / architecture / detailed design / packaging docs (Chinese)
```

> For the full module list and responsibilities, see [docs/架构设计.md](docs/架构设计.md) (Chinese).
