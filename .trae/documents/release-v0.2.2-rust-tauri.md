# TMD v0.2.2 Rust + Tauri 正式发布计划

## Context

Electron 源码与依赖已在当前 `cfb1ba0` 提交中全面移除，Rust + Tauri 成为唯一桌面壳。当前工作区干净，本地 `master`、`github/main`、`gitee/master` 一致，现有版本与最新标签均为 `0.2.1` / `v0.2.1`。用户已确认本次发布版本为 **v0.2.2**，目标是完成版本收口、双平台构建以及 GitHub/Gitee 正式发布。

发布前有两处必须修复的链路风险：
- `release.yml` 在手动触发时会把分支名（如 `main`）当成 Release tag，且缺少 tag 与包版本一致性校验。
- 本地 Gitee 补发脚本仍按 Electron `latest*.yml` 流程改写文件，可能破坏已冻结的 0.1.x 迁移链；应改为只同步当前 Tauri JSON 元数据，冻结 YML 保持不变。

## 实施步骤

### 1. 收口发布链

- 修改 `.github/workflows/release.yml`：统一从 `package.json` 得到 `v<version>`；tag 触发时校验 `github.ref_name` 与该值完全一致，手动触发也使用同一版本 tag；发布前明确校验 macOS/Windows 安装包、updater 包及签名文件齐全。
- 修改 `scripts/prepare-gitee-release.mjs`：本地补发只同步并校验当前版本 `latest.json` / `migration.json`，不再改写冻结的 `releases/latest.yml`、`latest-mac.yml`；上传清单与 CI 的 Tauri 产物口径一致。
- 更新 `src/__tests__/prepare-gitee-release.test.ts`，覆盖当前 JSON 元数据处理和冻结 YML 不被改写的约束。

### 2. 更新版本与发布说明

将以下版本号统一为 `0.2.2`，不手工改写锁文件格式：
- `package.json`、`package-lock.json`
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

修改 `CHANGELOG.md`：保留新的空 `[Unreleased]`，将现有未发布内容转正为 `[0.2.2] - 2026-11-16`。保留 0.1.x 冻结迁移说明，不删除历史版本记录。

### 3. 清理本次发布直接相关的失效文档

- `README.md`、`README-EN.md`：删除不存在的 Electron 命令、依赖、目录和维护线描述；Tauri 改为唯一桌面壳；安装包名改为实际 Tauri 命名（下划线、aarch64/x64）。只改与下线和发布直接相关的内容，不展开全库文档重构。
- `docs/需求说明.md`：当前技术栈改为单一 Rust + Tauri 壳，补 v0.2.2 完成记录；历史 Electron 条目保留为历史。
- `docs/打包发布.md`：修正当前打包、tag 发布、Secret、CI job、Gitee 本地补发及 updater 说明，明确冻结迁移元数据的边界；历史段落不重写。

### 4. 本地验证与提交

依次执行：
- `npm ci`
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- `node scripts/extract-release-notes.mjs --strict`
- `cargo fmt --check`、`cargo test`（`src-tauri/`）
- `npm run dist:tauri:dir`，随后用真实 release `.app` 执行 `npm run smoke:mac`
- 检查 `git diff`，确认版本号一致、无 Electron 源码/依赖复活、无密钥进入仓库。

验证通过后创建发布准备提交，先将 `master` 推到 Gitee 和 GitHub，并核对日常 CI（前端检查、macOS Rust、Windows Rust）通过。

### 5. 打标签并发布

- 在已通过 CI 的发布提交上创建 `v0.2.2`，分别显式推送该 tag 到 Gitee 与 GitHub；不用 `workflow_dispatch` 代替正式 tag。
- 跟踪 Release 工作流的 `build-tauri` 双平台与 `publish` job。若 `TAURI_SIGNING_PRIVATE_KEY` 或 `GITEE_TOKEN` 缺失/失效，停止发布操作并请用户修复 Secret，不绕过签名或发布校验。
- CI 推入 Gitee 元数据提交后，用 fetch + merge 合回本地，再同步 GitHub，避免重写已发布历史。

## 发布验收

- GitHub Release `v0.2.2` 为非草稿，核对 9 项附件：dmg、exe、exe.sig、app.tar.gz、app.tar.gz.sig、latest.json、migration.json、两个冻结 YML。
- Gitee Release 核对 6 项 Tauri 附件：dmg、exe、两个 sig、app.tar.gz、latest.json。
- 两个 updater 端点均返回 `0.2.2`，含 `windows-x86_64` 与 `darwin-aarch64` 条目、非空签名及正确下载 URL；冻结 YML 仍保持 0.1.8 且指向 `v0.2.1` 迁移锚点。
- 用可用的 0.2.1 macOS 客户端验证能发现 0.2.2，并尽可能走完下载、保存握手和重启；Windows 以 CI 构建、签名及元数据校验为准，不宣称完成本机 Windows 实测。
- 最终确认双远端代码、tag、Release 与更新元数据一致。

## 失败处理

构建或校验失败时不发布；GitHub 已发布而 Gitee 失败时，使用修复后的本地补发通道或重跑发布 job，**不删除、不重打正式 tag**。若发现坏版，先恢复 0.2.1 更新元数据并将坏 Release 转为草稿，再以新补丁版本修复。
