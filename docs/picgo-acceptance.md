# 图床验收清单（PicGo 七家）

Rust 侧七条上传通道已实现，签名算法由 RFC 2202 向量与 Python `hashlib` 独立算出的
期望值锁定（`src-tauri/src/picgo.rs` 单测）。还剩最后一关：**用真实凭据逐家跑通**。
签名只错一位在线上统一表现为 403/401，只有真实请求能把这类问题暴露出来。

本文按「准备 → 通用流程 → 逐家要点 → 记录表」组织，逐家打勾即可。

---

## 0. 准备

| 项目 | 说明 |
| --- | --- |
| 应用 | 用 `npx tauri build --bundles app` 产出的 `.app`（macOS 裸二进制缺少 bundle 上下文，不能直接跑） |
| 测试图 | 一张 20KB 以内的 PNG；再备一张 JPG，用来验证 `Content-Type` 与扩展名归一 |
| 配置文件 | `~/Library/Application Support/com.chiangyang.tmd/picgo-config.json`（macOS；`TMD_DATA_DIR` 可重定位） |
| 日志 | `~/.tmd/logs/app-YYYY-MM-DD.jsonl`，应用内菜单可直达（`tmd_open_logs_dir`） |
| 失败取证 | 过滤 `"source":"picgo"`，失败会带 HTTP 状态与响应体前 200 字 |

配置文件结构沿用 Electron 版，老配置可直接复用：

```json
{
  "picBed": {
    "current": "tcyun",
    "tcyun": { "secretId": "...", "secretKey": "...", "bucket": "...", "appId": "...", "area": "ap-shanghai", "path": "img/" }
  }
}
```

---

## 1. 通用流程（每家都走一遍）

1. 设置面板 → 图床配置 → 选图床 → 填字段 → 保存（状态提示「已保存」）。
2. 编辑器里粘贴或拖入测试图。
3. 判定成功需同时满足三条：
   - 编辑器里插入的是 **URL 形式**的图片（不是本地路径、不是 base64）；
   - 该 URL 在浏览器无痕窗口能直接打开（排除「上传成功但桶是私有读」）；
   - 日志里没有新增 `source=picgo` 的 error。
4. 再传一次**同名内容**（同一张图），确认不会因为重名而失败（sm.ms 会返回 `image_repeated`）。
5. 故意改错一个字段（如 secret 末位去掉）再传，确认日志能给出可读原因而不是静默失败。

> 已知的链路特征：`uploadImage` 的返回契约是 `string | null`，失败不会弹窗，只写日志。
> 所以**验收必须看日志**，不能只看「没报错」。

---

## 2. 逐家要点

### 2.1 sm.ms（S.EE）— 优先测

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `token` | `xxxxxxxx` | S.EE Dashboard 的 API Token，直接放 `Authorization` 头 |

- 端点：`POST https://sm.ms/api/v2/upload`，multipart 字段 `smfile`。
- 成功取 `data.url`；同图重复上传取顶层 `images`（字符串）。
- **风险最高的一家**：sm.ms 已换品牌为 S.EE，v2 域名是否仍可用存疑。
  - 若返回 404 / HTML 页面 → 需要改端点（候选 `https://s.ee/api/v2/upload`），改完补一条断言。
  - 若返回 `code=unauthorized` → Token 类型不对（要 API Token，不是账号密码）。

### 2.2 GitHub

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `repo` | `owner/repo` | 仓库必须已存在 |
| `branch` | `main` | 留空按 `main`；分支不存在会 422 |
| `token` | `ghp_xxx` | PAT，需 Contents 读写权限 |
| `path` | `img/` | 拼成 `img/<时间戳>-<序号>.png` |
| `customUrl` | `https://cdn.jsdelivr.net/gh/owner/repo` | 留空则用接口返回的 `download_url` |

- 端点：`PUT https://api.github.com/repos/{repo}/contents/{key}`，`Authorization: token <PAT>`。
- **注意**：填了 `customUrl` 时返回 `{customUrl}/{key}`，不会带分支信息。jsDelivr 形式应为
  `https://cdn.jsdelivr.net/gh/owner/repo@main`，否则可能拿到旧缓存或 404。
- 常见失败：401 Token 失效/权限不足；404 仓库名错或无权限；422 分支不存在 / 同路径同内容无变更。

### 2.3 阿里云 OSS

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `accessKeyId` / `accessKeySecret` | — | RAM 子账号即可，需该 Bucket 的写权限 |
| `bucket` | `my-bucket` | 不带 `.oss-cn-...` 后缀 |
| `area` | `oss-cn-hangzhou` | 必须与 Bucket 实际地域一致 |
| `path` | `img/` | 可空 |

- 端点：`PUT https://{bucket}.{area}.aliyuncs.com/{key}`，OSS V1 签名（HMAC-SHA1 → base64）。
- 签名串为 `PUT\n\n{Content-Type}\n{Date}\n/{bucket}/{key}`，日期必须是 GMT 格式。
- 常见失败：403 `SignatureDoesNotMatch`（Secret 错/系统时间偏差过大）；403 `AccessDenied`（RAM 无写权限）。
- 返回的 URL 要能匿名打开，Bucket 读权限需为「公共读」。

### 2.4 腾讯云 COS

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `secretId` / `secretKey` | — | 建议子账号 + 该桶写权限 |
| `bucket` | `my-bucket` | **不要带 appId**（代码会拼成 `{bucket}-{appId}`） |
| `appId` | `1250000000` | 账号 APPID |
| `area` | `ap-shanghai` | 与桶地域一致 |
| `path` | `img/` | 可空 |

- 端点：`PUT https://{bucket}-{appId}.cos.{area}.myqcloud.com/{key}`，COS v5 签名（两级 HMAC-SHA1 → hex）。
- 常见失败：403 `SignatureDoesNotMatch`（SecretKey 错）；403 `AccessDenied`（子账号策略没给 `cos:PutObject`）；
  404 `NoSuchBucket`（bucket/appId/area 三者有一项不对）。
- 返回的 URL 需桶为「公有读」，否则对象存在但外部打不开。

### 2.5 七牛云

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `accessKey` / `secretKey` | — | 密钥管理里的 AK/SK |
| `bucket` | `my-bucket` | 存储空间名 |
| `url` | `https://cdn.example.com` | 绑定的访问域名，**必填**，否则上传成功也拿不到 URL |
| `area` | `z0` | `z0/z1/z2/na0/as0`，未知值回落 `z0` |

- 端点：`POST https://upload[-{area}].qiniup.com/`，multipart 字段 `token`、`key`、`file`。
- Token：`ak:urlsafe_b64(HMAC-SHA1(sk, policy)):urlsafe_b64(policy)`，`policy = {"scope":"bucket:key","deadline":ts}`。
- **注意**：七牛没有 `path` 配置，对象键就是随机文件名（桶根目录）。
- 常见失败：401 `bad token`（SK 错）；403 `bucket doesn't match with scope`（bucket 名不一致）；
  579/631（空间未绑定域名或区域选错）。

### 2.6 又拍云

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `bucket` | `my-service` | 又拍云的「服务名」 |
| `operator` | `operator-name` | 操作员账号 |
| `password` | `******` | 操作员密码（不是账号登录密码） |
| `url` | `https://cdn.example.com` | 绑定的访问域名，**必填** |

- 端点：`PUT https://v0.api.upyun.com/{bucket}/{key}`，Basic Auth。
- **注意**：同样没有 `path` 配置，对象键为桶根目录下的随机文件名。
- 常见失败：401（操作员密码错或该操作员无对应服务权限）；403（服务未开启 API 访问）。

### 2.7 Imgur

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| `clientId` | `xxxxxxxx` | Imgur 应用的 Client ID（匿名上传即可） |

- 端点：`POST https://api.imgur.com/3/image`，form 提交 `image`(base64) / `type=base64` / `name`。
- 成功取 `data.link`。
- 常见失败：403 `Invalid client_id`；429 触发限流（换 IP 或稍后重试）。

---

## 3. 验收记录

| 图床 | 配置保存 | 上传成功 | URL 可直接打开 | 重复上传不失败 | 错误字段有可读日志 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| sm.ms / S.EE | ☐ | ☐ | ☐ | ☐ | ☐ | 端点存疑，优先 |
| GitHub | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 阿里云 OSS | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 腾讯云 COS | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 七牛云 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 又拍云 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| Imgur | ☐ | ☐ | ☐ | ☐ | ☐ | |

---

## 4. 已知风险与后续动作

1. **sm.ms 端点**：品牌与域名迁移后 v2 接口可能已变，是七家里唯一可能需要改代码的。
2. **访问域名类配置**（七牛 / 又拍云）：`url` 填错时上传会成功但返回的链接打不开，
   看起来像「上传失败」，验收时务必单独确认这一步。
3. **私有桶**（OSS / COS）：对象上传成功但链接 403，需要把桶读权限调成公共读，或用 CDN 域名。
4. 七家全部通过后，可把本清单的结论回填到 `docs/spike-tauri.md` 的 A1 行，并把「凭据实测」标记为完成。
