# tmd 多远程仓库同步指南

> 版本：1.3　作者：chiangyang　更新：2026-09-17
> 相关文档：[打包发布](打包发布.md)（CI 发布流程依赖双远程配置）

## 1. 概述

tmd 代码同时托管在 **Gitee** 和 **GitHub** 两个远程仓库，本地 `master` 分支分别推送为两个平台的分支名：

| 远程名 | 地址 | 协议 | 推送目标分支 |
|--------|------|------|--------------|
| `gitee` | `https://gitee.com/chiangyangNPU/tmd.git` | HTTPS | `master` |
| `github` | `git@github.com:ChiangyangNPU/tmd.git` | SSH | `main` |

> 本地分支统一为 `master`，不需要改名。推送时通过 refspec 完成映射：
> Gitee 推 `master`，GitHub 推 `master:main`（本地 `master` → 远程 `main`）。

## 2. 远程配置

### 2.1 全新克隆后的初始化（重装/换机必看）

`git clone` 后默认只有 `origin` 一个远程，需要对齐为 `gitee` / `github` 两个：

```bash
# 1. 先看克隆自哪个平台（决定 origin 的去留）
git remote -v
#    克隆自 Gitee：origin 指向 gitee 地址 → 直接改名
#    克隆自 GitHub：origin 指向 github 地址 → 保留 origin 当 github，另加 gitee

# 2. 处理 origin
#    若克隆自 Gitee：
git remote rename origin gitee
#    若克隆自 GitHub（origin 已是 github 地址，按需改名）：
# git remote rename origin github

# 3. 添加另一个远程（克隆自 Gitee 时只需这步）
git remote add github git@github.com:ChiangyangNPU/tmd.git
# git remote add gitee  https://gitee.com/chiangyangNPU/tmd.git   # 克隆自 GitHub 时

# 4. 核对最终结果，应有两行
git remote -v
```

> 若误配重复远程，用 `git remote remove <名字>` 删除后重来。
> 重新克隆后 git 别名（alias）不会带过来，需重新配置 `pushall`（见 §3）。

### 2.2 参考：从零添加（无需改动时的配置基准）

```bash
# 添加远程（已配置，仅作参考）
git remote add gitee  https://gitee.com/chiangyangNPU/tmd.git
git remote add github git@github.com:ChiangyangNPU/tmd.git

# 查看当前配置
git remote -v
```

### 认证方式

| 远程 | 认证方式 | 说明 |
|------|----------|------|
| `gitee` | HTTPS + Windows 凭据管理器 | Gitee 凭据已存于系统凭据库，无需重复输入 |
| `github` | SSH（`id_ed25519`） | 公钥已注册在 GitHub 账户；SSH 可避免 HTTPS 凭据弹窗问题 |

## 3. 日常用法

| 命令 | 作用 |
|------|------|
| `git push gitee master` | 只推 Gitee（`master`） |
| `git push github master:main` | 只推 GitHub（本地 `master` → 远程 `main`） |
| `git pushall` | **一键同时推两个仓库** |
| `git push gitee master --force-with-lease && git push github main --force-with-lease` | **一键强制同时推两个仓库** |

> 注意：Git 默认 `push.default=simple`，要求本地/远程分支同名才允许裸 `git push github`。
> 因 GitHub 侧分支名为 `main`（与本地 `master` 不同），单推 GitHub 必须带 `master:main` 映射。

### 分支映射原理（refspec）

`pushall` 别名 = 两条 push 串联：

```bash
git push gitee master && git push github master:main
```

| 写法 | refspec 含义 | 实际推送 |
|------|-------------|---------|
| `master` | `master:master` 的简写 | 本地 `master` → Gitee `master` |
| `master:main` | 冒号前是本地分支，冒号后是远程分支 | 本地 `master` → GitHub `main` |

> 记忆口诀：**冒号前是本地，冒号后是远程**。
> 两边分支同名时可简写；不同名时（GitHub 侧叫 `main`）必须写全 `master:main`。
> 本项目 Gitee 侧叫 `master`、GitHub 侧叫 `main`，所以只有 GitHub 那条带映射。

### pushall 别名

```bash
# 已配置：git config alias.pushall '!git push gitee master && git push github master:main'
git pushall
```

- `git push gitee master` 成功后才继续推 GitHub（`&&` 串联）。
- 两处均为 "Everything up-to-date" 即表示两边已同步。

## 4. 首次推送（已完成，参考）

```bash
# 1. 初始提交
git add -A
git commit -m "Initial commit: tmd"

# 2. 推 Gitee（master）
git push -u gitee master

# 3. 推 GitHub（本地 master → 远程 main）
git push -u github master:main
```

## 5. 常见问题排查

### 5.1 GitHub 认证失败

症状：`fatal: Authentication failed for 'https://github.com/...'`

原因：Git Credential Manager（GCM）的交互式认证流程可能被输入法 DLL 的调试日志污染
（日志形如 `warning: invalid credential line: ... tsf_oime.cpp ...`）。

解决：改用 **SSH** 认证（本机 `id_ed25519` 已注册 GitHub）：

```bash
git remote set-url github git@github.com:ChiangyangNPU/tmd.git
ssh -T git@github.com   # 输出 "Hi ChiangyangNPU!" 即认证成功
```

### 5.2 大文件超出 GitHub 100MB 上限

症状：`remote: error: File ... is 375.57 MB; this exceeds GitHub's file size limit of 100.00 MB`

原因：`third_party/onnxruntime/lib/onnxruntime.pdb`（375MB，onnxruntime 调试符号）超 GitHub 硬上限。
Gitee 仅警告（>50MB）但不拦截，GitHub 则硬性拒绝。

处理（已执行）：从仓库移除 PDB 并重写提交：

```bash
# 1. 修改 .gitignore，删除 "!third_party/onnxruntime/lib/*.pdb" 放行规则
# 2. 移出版本控制（磁盘文件保留，构建时重新生成）
git rm --cached third_party/onnxruntime/lib/*.pdb
git add .gitignore
git commit --amend        # 重写初始提交（无 PDB）
# 3. 重推两个仓库
git push -f gitee master
git push -u github master:main
```

> 注意：GitHub 会扫描**全部历史**，仅删除文件再提交无法通过，必须重写包含该文件的历史。
> PDB 为构建产物，移除后不影响编译、运行与自研代码调试。

### 5.3 国内网络无法访问 GitHub

症状：`Failed to connect to github.com port 443`

解决：开启代理/VPN 后，为 git 配置代理（以本地 Clash 端口为例）：

```bash
git config --global http.proxy http://127.0.0.1:7890
# 无需代理时移除：
# git config --global --unset http.proxy
```

SSH 通道（`git@github.com`）同样受网络影响，必要时可走 SSH-over-443：
在 `~/.ssh/config` 中添加：

```
Host github.com
  HostName ssh.github.com
  Port 443
```

---

> **版本历史**
>
> - 2026-09-17　头部元数据标准化（补版本号、作者、更新日期），新增版本历史
> - 2026-09-10　文档更新
> - 2026-09-08　随新增英文 README 同步
> - 2026-09-06　初版（随项目初始提交入库）
