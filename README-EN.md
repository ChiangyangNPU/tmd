[简体中文](./README.md) | English

# TMD

**Type Markdown, Done.**

A cross-platform (macOS / Windows) WYSIWYG Markdown editor. Its core feature is real-time rendering of Mermaid diagrams.

For the scope of requirements, see [docs/需求说明.md](docs/需求说明.md) (Chinese). For architecture and module responsibilities, see [docs/架构设计.md](docs/架构设计.md) (Chinese). For key implementation details, see [docs/详细设计.md](docs/详细设计.md) (Chinese). For the version plan, see [docs/路线图.md](docs/路线图.md) (Chinese). For packaging and release, see [docs/打包发布.md](docs/打包发布.md) (Chinese).

## Quick Start

```bash
npm install                # Install dependencies first
npm run dev                # Browser mode: http://localhost:5173
npm run tauri dev          # Desktop mode (Rust + Tauri shell)
npm run build              # Type check + production build
npm run smoke:mac          # Shell smoke test (9 page assertions against the release .app on macOS)
npm run dist:tauri         # Build installers (mac: dmg / win: nsis)
npm run dist:tauri:dir     # Build the macOS app bundle only (no dmg)
npm run dist:tauri:install # Build and install over /Applications/TMD.app
```

## Download & Install (end users)

Grab an installer from [GitHub Releases](https://github.com/ChiangyangNPU/tmd/releases/latest) or [Gitee Releases](https://gitee.com/chiangyangNPU/tmd/releases/latest):

- **macOS**: download `TMD_<version>_aarch64.dmg`, open it and drag TMD into Applications
- **Windows**: download `TMD_<version>_x64-setup.exe` and run the installer

> **Blocked on first launch on macOS?** Installers downloaded from the web trigger Gatekeeper on first open ("Apple cannot verify "TMD"…"). This is expected — follow [docs/mac安装后启动报错解决方案.md](docs/mac安装后启动报错解决方案.md) (in Chinese) to allow it once. Updates installed through the in-app updater clear the quarantine flag automatically and skip this entirely.

## Features

- WYSIWYG editing (Milkdown / ProseMirror core + GFM: tables, task lists, strikethrough)
- **Real-time Mermaid rendering** (`src/mermaid.ts`, custom plugin):
  - Type ` ```mermaid ` and press Enter to create a diagram block
  - Cursor outside the block: renders SVG; click the diagram: enters source editing; cursor leaves: re-renders
  - 400ms input debounce; on syntax errors the stale diagram is cleared and an error hint is shown
  - Stale render requests are discarded (sequence guard), so fast continuous typing never flashes old diagrams
- Math formulas (KaTeX: `$...$` inline / `$$...$$` block, rendered in real time)
- Code block syntax highlighting (`@milkdown/plugin-prism` + refractor; entering the block edits the source code)
- Multi-tab: same-path dedup, unsaved marker (`•`), per-tab scroll position memory; tab context menu to close current/other/left/right/saved/all tabs (one batch confirmation when unsaved tabs are involved)
- Source mode (CodeMirror 6 full-document editing with built-in search panel)
- Find & replace (decorator-based highlighting in WYSIWYG mode, replace current / replace all)
- Outline panel (headings level 1-3, click to jump) and TOC block (GitHub-style anchors)
- Table editing: floating toolbar on cursor entry (row/column add-remove, per-column alignment), drag-to-resize columns
- Quick switch panel (Ctrl/Cmd+P): fuzzy-search open tabs, all expanded folders and recent files, Enter to open; Chinese-named files support **pinyin-initial matching** (e.g. `xmsm` → 项目说明.md; the dictionary lazy-loads on first panel open, zero overhead for pure-Latin workspaces)
- **Command palette** (Ctrl/Cmd+Shift+A, remappable): fuzzy-search and run every menu action (file / export / version history / settings), formatting commands and view toggles (source / split / autosave) — commands share the exact same handlers as the menus, searchable by Chinese and English keywords
- **Cross-file search** (Ctrl/Cmd+Shift+F): line-by-line search across the folders mounted in the sidebar; results are grouped by file with line numbers and context (keyword highlighting) — ↑↓ to select, Enter to open and jump to the match. Dependency folders are skipped and per-file/result limits are enforced, so large workspaces never freeze the UI
- **Wiki-link ecosystem**: `[[target]]` / `[[target|alias]]` / `[[target#heading]]` triple (rendered in both WYSIWYG and source mode; unresolved targets are dimmed with a hint and stay clickable); a **backlinks panel** (Cmd/Ctrl+Shift+B) lists every workspace reference to the current note; a **relation graph** (canvas + d3-force force layout, hover to highlight neighbours, click to open) and a **local graph** (sidebar mini-map of the current note's neighbourhood, 1/2 hops); renaming a note rewrites references across the whole workspace automatically; all shortcuts are remappable in the settings
- File sidebar: mount multiple folders at once (independent expansion, restored on restart, lazy-loaded on expand) plus a recent files list; both support hover × per-item removal and one-click clear (confirmation dialog; clearing folders only unmounts them, never deletes files on disk). The **currently open file** is highlighted in the tree and the recent list with the same accent colour as folders, moving as you switch tabs; files and folders created, deleted or renamed externally (e.g. in the OS file manager) are reflected in expanded trees automatically, without re-mounting
- **Sidebar file management** (desktop): folder root rows show hover buttons "＋file / ＋folder" for inline creation (auto .md extension, duplicate names rejected, new files open immediately); right-click any row for "New / Rename / Reveal in Finder / Copy relative (absolute) path / Move to Trash" (grouped by category, with the destructive action in its own group at the end) — renaming syncs the associated path of open tabs, so later saves write to the new path; "Move to Trash" asks for confirmation and uses the system trash (recoverable, never a permanent delete; folders include all contents). Mounted root rows additionally offer "Remove folder from list (files on disk are kept)", and recent-list rows offer "Remove from Recent Files" — both "remove" actions only drop the reference and never touch the disk
- **Copy file paths** (desktop): the right-click menus of file tree / recent-list rows and editor tabs offer "Copy relative path" and "Copy absolute path" — the relative path is computed against its mounted root (longest-prefix match among multiple roots); clicking copies it to the clipboard with toast feedback; disabled for tabs not yet saved to disk
- Resizable sidebar: drag the divider between the sidebar and the editor to adjust the width (hover highlight, width remembered, double-click to reset; clamped automatically when the window narrows)
- Drag & drop: drop a .md file onto the window to open it (new tab); drop images to insert them per the paste strategy
- Formatting shortcuts & Format menu: headings 1–6 (Ctrl/Cmd+1–6), bold/italic (Ctrl/Cmd+B/I), link (Ctrl/Cmd+K), blockquote, lists, code block — all undoable
- **Custom shortcuts**: the settings panel lists 34 shortcuts grouped into File / Export / Format / Editor; click a key box and press a new combination to rebind. Includes conflict detection with inline error hints and one-click reset to defaults (Windows shows `Ctrl+Shift+O`, macOS follows Apple conventions showing `⇧⌘O`)
- Syntax extensions: footnotes `[^1]`, highlight `==text==`, superscript/subscript (both `^x^`/`~x~` and `^{x}`/`_{x}` are recognized; saving normalizes to the Pandoc single-symbol style), YAML front matter (a leading `---` fence renders as a key-value property table, click to edit the YAML source, written back byte-for-byte on save, stripped automatically from HTML/PDF export). Shortcuts: highlight Ctrl/Cmd+Shift+H, superscript Ctrl/Cmd+Shift+=, subscript Ctrl/Cmd+Shift+-
- **Safe block-level raw HTML**: standalone HTML blocks such as `<details>` / `<div>` / `<table>` render through a whitelist sanitizer — script/iframe/svg, event handlers, style/class/id are removed and links/images use protocol allowlists. Source Markdown is preserved and editable in source mode. Inline HTML tag pairs remain source text; HTML/Word/long-image/ePub exports sanitize and render the same way
- Right-click context menu in the editor: cut/copy/paste plus selection-aware format items (including remove link)
- Link following: Ctrl/Cmd+click opens external URLs in the browser; relative-path links resolve against the document directory and open with the system app (hold Mod while hovering for a pointer hint)
- Triple paste-image strategy: inline data URL / save to `assets/` next to the document / upload to an image host (native Rust implementation, no PicGo-Core dependency, supporting SM.MS, GitHub, Qiniu, Upyun, Tencent COS, Aliyun OSS and Imgur — 7 providers; falls back to inline on failure; images >5MB ignored)
- HTML paste conversion: rich text copied from web pages / Word is converted to Markdown automatically (whitelist sanitizing + protocol filtering; headings / lists / tables / code blocks preserved)
- **TSV paste to table**: plain text copied from Excel/spreadsheet apps (tab-separated, ≥2 rows × 2 columns, aligned columns) pastes as a real table (first row becomes the header, an empty paragraph follows the table for the cursor); rich-text clipboard still goes through the HTML conversion pipeline first, and a single tab inside a sentence never triggers it
- Relative-path images resolved against the document directory for display (document data keeps relative paths)
- Export to five formats: HTML (standalone file, Mermaid/KaTeX via CDN), PDF (generated programmatically via printToPDF; page margins via `@page`), **Word** (native editable .docx: headings, lists, tables, inline formatting and hyperlinks all become native Word elements; display formulas and Mermaid diagrams are embedded as 2x bitmaps), **long image** (a single PNG at no less than 2x physical resolution; long documents are captured and stitched in segments automatically) and **LaTeX** (standalone compilable .tex source: math passes through losslessly, CJK documents use the ctexart class, image paths resolve relative to the file; Mermaid diagrams are kept as comments)
- Autosave (writes back every 5 seconds; one shared switch for the settings panel and the menu)
- **Selection word count**: selecting text flips the toolbar counter to "N of M chars" in real time (ProseMirror view plugin with 150 ms merged refresh, no flicker during drag-select), restoring the full count on clear; source mode keeps the full count
- Spellcheck toggle (settings panel, Editor category, off by default: Chromium enables it on editable content with an English-only dictionary, so turning it off removes the red squiggly underlines; Chinese text is never checked)
- Dark/light theme switching (diagrams re-rendered in place — the editor is never rebuilt, preserving undo history / focus / scroll position)
- Theme presets (Default / Dark / Sepia / Green / Liquid Glass / **Liquid Glass Pro** — SVG displacement refraction lens bends the backdrop at panel edges, Apple Liquid-Glass style), file-based themes (`~/.tmd/themes/*.css` — the file name is the theme name; open the folder / reload from the settings panel) and custom CSS injection (takes effect immediately); preset looks apply from the very first frame (build-time static injection + boot.js attribute restore, no startup flash)
- Multilingual UI (Simplified Chinese / Traditional Chinese / English, follows the system, switchable in the settings panel)
- Settings panel with category navigation: widened to a two-pane layout (Appearance / Typography / Editor / Files & Images / Shortcuts / System / About on the left, content on the right); click to jump with scroll-synced highlighting, color-swatch theme previews; open via File → "Settings…" or `Cmd/Ctrl+,`
- **Ctrl/Cmd+wheel font zoom**: ±1px steps inside the editor (clamped 12–28), trackpad pinch works the same; a bottom HUD shows the size in place, persisted via typography settings and applied to both WYSIWYG and source mode
- **Typography settings**: 12 font presets (Default / Song / Hei / Kai / Mono / FangSong / LXGW WenKai / Source Han Serif / Times / Charter / Segoe YaHei / Helvetica, with cross-platform fallback stacks); after choosing a category you can **pick a primary font** from within its stack; font size / line height / editor width / word wrap all apply instantly and persist
- **Window memory**: window size / position / maximized state persist and restore on restart (falls back to a default placement when monitors are plugged or unplugged)
- Settings panel "About": app name, version (read from package.json), copyright, contact email, homepages (GitHub / Gitee), plus license declarations and direct links for the app itself and 15 third-party components (collapsed by default, expand to view)
- Auto-update (dual Gitee / GitHub feeds; a dialog asks before downloading, never silent)
- **Local crash capture & logs (zero telemetry)**: JS errors from main/renderer and renderer crashes go to local JSONL logs under `~/.tmd/logs` (auto-rotated: 7 days / 10 files), and the previous crash is logged on the next launch; the shell does not produce minidumps and only keeps crash-clue scanning; a settings-panel button opens the log folder (relocatable via `TMD_HOME_DIR`)
- **Local version history**: the on-disk content is archived to `~/.tmd/history` before every save (identical content is not duplicated; auto-pruned at 50 versions per file plus a 200 MB global cap); "File → Version History…" lists, previews and restores a version into the editor — restoring only changes the editor and marks it dirty, so overwriting the file stays your explicit decision
- **External change detection & reload**: files opened in the editor are watched on disk (content fingerprinting, own writes filtered out) — clean tabs reload silently; dirty tabs are never overwritten silently and get a prompt bar to choose "Reload" (take disk content, clear dirty) or "Keep mine" (prompts again on further changes); externally deleted files show a notice and keep the editor content
- **Split view**: source and WYSIWYG side by side (the ⋯ menu → "Split" / `Ctrl/Cmd+Shift+E`) — one pane is editable, the other follows along read-only; click a pane to make it the editable one (two-way live sync is intentionally not offered: Markdown round-tripping would rewrite your hand-written source). Scrolling is approximately synced, the divider is draggable and its width is remembered
- **Shell smoke test**: asserts the editor mounts, shell capabilities are injected, the file channel works and common formatting shortcuts fire against the real release `.app` — 9 assertions (`npm run smoke:mac`)
- **Tauri desktop shell** (`src-tauri/`, the primary shell since 0.2.x):
  - ~6MB installer (Windows NSIS) / macOS dmg, faster startup and lower idle memory
  - Native menus: full macOS menu bar (App / File / Edit / View / Export / Format); on Windows everything is reachable via the in-window "⋯" menu, context menus and shortcuts
  - Native open / save / save-as dialogs; File menu shortcuts Cmd/Ctrl+O / S / Shift+S
  - File association (double-click a .md file to open) + single-instance lock
  - System "recent documents": macOS Dock menu / recent items, Windows Jump List and File Explorer recents
  - Image hosting, export (PDF / Word / long image / ePub / LaTeX), version history and full-text search are implemented in Rust; the renderer reaches system capabilities through a controlled shim (no Node privileges)
  - Auto-update via tauri-plugin-updater (Gitee primary / GitHub fallback) with minisign signature verification
  - Automatic degradation in browser mode: file picking uses `<input type=file>`, saving becomes a download

## Tech Stack

Rust (Tauri 2) + TypeScript + Vite + Milkdown (ProseMirror) + Mermaid + CodeMirror 6 + KaTeX + refractor + markdown-it (with footnote / mark / sub / sup plugins) + dom-docx + mathml2omml + d3-force + remark-frontmatter + pinyin-pro + fflate + sanitize-html + iconv-lite.

## Directory Structure

```
├─ index.html                    Main page entry (WYSIWYG + source mode)
├─ export-renderer.html          Offscreen export page (Word / long image, loaded by a hidden window)
├─ public/
│  └─ boot.js                    First-frame bootstrap script (theme / platform classes, prevents white flash)
│
├─ src-tauri/                    Rust + Tauri desktop shell (primary since 0.2.x)
│  ├─ src/main.rs                Entry: windows / single instance / file association / commands / menu events
│  ├─ src/menu.rs                Native menu assembly (App / File / Edit / View / Export / Format)
│  ├─ src/shell.rs               Shell state (recent list mirror, window geometry, autosave flag)
│  ├─ src/recent.rs              System recent documents (NSDocumentController / SHAddToRecentDocs)
│  ├─ src/picgo.rs               Image hosting (7 providers, hand-written signing, zero extra deps)
│  ├─ src/exporter.rs            Export orchestration + export_native*.rs platform primitives
│  ├─ src/updater.rs             Auto-update (tauri-plugin-updater + minisign verification)
│  └─ src/tmd-api-shim.js        Injected controlled API (window.tmdAPI, replaces preload)
│
├─ scripts/                      Build / test / pack scripts
│  ├─ copy-export-assets.mjs     Copies Mermaid / KaTeX runtimes and fonts into dist/export-assets (offline export inlining)
│  ├─ gen-lens-map.mjs           Generates the Liquid Glass Pro refraction displacement map (PNG data URI; tweak params, rerun, paste the constant)
│  ├─ tauri-build-signed.mjs     Signed Tauri build wrapper (reads the updater private key)
│  ├─ tauri-mac-check.mjs        macOS shell smoke test (real release .app, 9 page assertions)
│  ├─ tauri-gui-check.mjs        Windows shell smoke test (WebView2 CDP, minimal assertion set)
│  ├─ tauri-bench.mjs            Large-document performance benchmark (open / input / scroll / long tasks, with regression gates)
│  ├─ tauri-acceptance.mjs       Acceptance automation (the machine-checkable subset of the checklist)
│  ├─ make-tauri-latest.mjs      Generates the Tauri updater manifest latest.json
│  ├─ make-migration-json.mjs    Generates migration metadata from 0.1.x to the current Rust build
│  ├─ extract-release-notes.mjs  Extracts the current version's notes from CHANGELOG into .release-notes.md
│  ├─ prepare-gitee-release.mjs  Validates and syncs Gitee update metadata, lists assets to upload
│  ├─ cleanup-old-app.sh         Cleans up old local app builds
│  └─ *-probe.mjs / ime-*.mjs    One-off real-machine diagnostic probes (IME / wiki-links / graph alignment / mindmap / dirty marker / input profiling)
│
├─ src/                          Renderer layer (Vite build output)
│  ├─ main.ts                    App startup & global wiring (boot, hooks injection, shortcuts, menu callbacks)
│  ├─ editor-core.ts             Editor hub (create / rebuild / source mode / content retrieval)
│  ├─ tabs.ts                    Multi-tab state machine (incl. per-tab scroll position)
│  ├─ files.ts                   File operations (open / save, multi-folder workspace, recent list)
│  ├─ filetree.ts                File tree / recent files / mounted folders rendering (lazy per-level expand)
│  ├─ store.ts                   Unified localStorage key & read/write entry
│  ├─ native.ts                  Shell contract interface (NativeFileAPI, auto-degrades in browser mode)
│  ├─ autosave.ts                Autosave (5-second write-back timer)
│  ├─ settings.ts                Settings panel wiring (language / theme / CSS / image host / shortcuts / update / about)
│  ├─ shortcuts.ts               Shortcut configuration (definitions / read-write / validation / display formatting, single source)
│  ├─ i18n.ts                    i18n runtime (locale loading / t() / batch DOM replacement)
│  ├─ theme.ts                   Light/dark switching (in-place diagram re-render, no editor rebuild)
│  ├─ theme-presets.ts           Theme presets, file-based themes & custom CSS injection
│  ├─ theme-preset-css.ts        Single source of preset CSS (built-in presets + Liquid Glass Pro filter, shared by runtime & first-paint injection)
│  ├─ mermaid.ts                 Mermaid real-time rendering plugin (core feature)
│  ├─ sourcemode.ts              CodeMirror 6 source mode
│  ├─ split.ts                   Split-view interaction (divider drag / click to pick the editable pane / approximate scroll sync)
│  ├─ writing-modes.ts           Focus mode / typewriter mode
│  ├─ typography.ts              Typography settings (font / size / line-height / width / word-wrap → CSS variables)
│  ├─ font-zoom.ts               Ctrl/Cmd+wheel font zoom
│  ├─ outline.ts                 Outline panel (H1-H3 jump)
│  ├─ command-palette.ts         Command palette (Ctrl/Cmd+Shift+A, fuzzy search & run menu actions)
│  ├─ quick-switch.ts            Quick switch panel (Ctrl+P fuzzy search)
│  ├─ pinyin-index.ts            Pinyin-initial index (Chinese filename matching, lazy-loaded)
│  ├─ Search:
│  │  ├─ search.ts               Cross-file search panel (debounce / grouped rendering / jump & locate)
│  │  ├─ find.ts                 Find & replace (decorator-based)
│  │  └─ findbar.ts              Find bar DOM wiring (source mode defers to CodeMirror's own panel)
│  ├─ Wiki-links & graph:
│  │  ├─ wikilink.ts             Wiki-link syntax core ([[target]] / alias / heading anchor + unresolved decoration)
│  │  ├─ wikilink-index.ts       Renderer-side wiki-link index cache (on-demand scan / invalidation scheduling / three-tier resolution)
│  │  ├─ backlinks.ts            Backlinks panel (grouped by source, click to locate)
│  │  ├─ link-rewrite.ts         Auto-rewrite workspace references on rename
│  │  ├─ graph.ts                Relation graph (canvas + d3-force, settings popover)
│  │  └─ local-graph.ts          Local graph sidebar panel (current note neighborhood, 1/2 hops)
│  ├─ Export:
│  │  ├─ export.ts               Export action layer (HTML / PDF / Word / long image / LaTeX)
│  │  ├─ export-doc.ts           Carrier-agnostic export doc core (render pipeline / styles / image-ref classification, shared by all five carriers)
│  │  ├─ export-latex.ts         LaTeX adapter (token stream → compilable .tex)
│  │  ├─ export-word.ts          Word export (region capture rasterization + OOXML conversion)
│  │  ├─ export-omml.ts          Editable Word formulas (LaTeX → MathML → OMML post-processing)
│  │  ├─ export-image.ts         Long-image export (segment planning + canvas stitching)
│  │  ├─ export-renderer.ts      Offscreen export page bootstrap (render pipeline + task dispatch)
│  │  └─ export-bridge.ts        Bridge contract between offscreen page and main-process exporter
│  ├─ Editor features:
│  │  ├─ mark-ext.ts             Syntax extensions (highlight / super-subscript / footnote: parsing, serialization, input rules)
│  │  ├─ frontmatter.ts          YAML front matter (property table ⇄ source dual-mode editing)
│  │  ├─ paste-image.ts          Pasted-image plugin (inline / assets / image host — triple strategy)
│  │  ├─ paste-html.ts           HTML paste conversion (whitelist sanitize → schema parsing)
│  │  ├─ paste-tsv.ts            TSV paste → table
│  │  ├─ table-input.ts          quick table input (pipe row + Enter builds the table)
│  │  ├─ table-toolbar.ts        Floating table toolbar (row/col add-remove / alignment / delete table)
│  │  ├─ table-markdown.ts       Table Markdown normalization (empty placeholder cell cleanup)
│  │  ├─ text-escaping.ts        Text-escaping patch (restores punctuation escaping inside table cells)
│  │  ├─ image-attrs.ts          Image resize / alignment (drag handle + alignment overlay)
│  │  ├─ image-resolver.ts       Resolves relative image paths against the document folder
│  │  ├─ task-list.ts            Task-list checkbox click toggle
│  │  ├─ toc.ts                  Table-of-contents (TOC) block
│  │  ├─ context-menu.ts         Editor right-click context menu
│  │  ├─ tab-menu.ts             Tab-bar right-click menu (close current/others/left/right/saved/all)
│  │  ├─ link-nav.ts             Link following (Mod+click, external / local dispatch)
│  │  ├─ format.ts               Formatting command layer (config-driven, undoable standard transactions)
│  │  └─ dragdrop.ts             Drag-and-drop open (.md/.txt) and image insert
│  ├─ Panels & infrastructure:
│  │  ├─ history.ts              Version-history panel (snapshot list / preview / restore into the editor)
│  │  ├─ external-change.ts      External-change detection & reload banner
│  │  ├─ error-report.ts         Renderer uncaught-error / Promise-rejection capture & IPC reporting
│  │  └─ fs-path.ts              Filesystem path utilities (normalize / dirname / identity check)
│  ├─ *.d.ts                     Type declarations (katex-auto-render / markdown-it-plugins / vite-env)
│  ├─ locales/                   Locale packs (zh-CN / zh-Hant / en)
│  ├─ templates/                 index.html overlay/panel HTML partials (?raw inlined)
│  ├─ styles/                    Style chunks (01 design tokens → 15 print; number order = cascade order)
│  ├─ style.css                  Style entry: only @import styles/*.css in original cascade order
│  └─ __tests__/                 vitest pure-function unit tests (51 files / 654 cases)
│
├─ docs/                         Project documentation (Chinese)
│  ├─ 需求说明.md                Feature list & roadmap
│  ├─ 架构设计.md                Module responsibilities & data flow
│  ├─ 详细设计.md                Key module implementation details
│  ├─ 路线图.md                  Version plan & capability-gap analysis
│  ├─ 打包发布.md                Local packaging & CI release workflow
│  ├─ mac安装后启动报错解决方案.md  Gatekeeper allow-through guide
│  └─ git-multi-remote.md        Dual-remote (Gitee + GitHub) sync guide
│
├─ build/                        Packaging assets (dmg installer background)
├─ .github/workflows/            CI (checks / Rust build gate / release workflow)
├─ dist/                         Renderer build output (vite build; generated locally, git-ignored, safe to delete)
├─ release/                      Staging area for release assets (read by the local re-publish channel; git-ignored)
└─ releases/                     Update metadata (git-tracked): latest.json / migration.json are refreshed per release,
                                 while latest.yml / latest-mac.yml are frozen copies for the 0.1.x migration chain — never hand-edit or delete
```

> For the full module responsibilities, see [docs/架构设计.md](docs/架构设计.md) (Chinese).

## License

This software is released under the [MIT License](LICENSE), Copyright (c) 2026 chiangyang.

License declarations and links for third-party components (Milkdown, Mermaid, KaTeX, etc.) are available in the app's Settings → About panel.
