/**
 * 设置面板——图片策略与 PicGo 图床配置。
 *
 * 图片策略状态由本模块持有（粘贴上下文经 getCurrentImageStrategy 读取）；
 * 图床配置字段渲染 / 加载 / 保存与「上传到图床」选项的能力降级也在此。
 */
import { native, hasNativeFeature } from '../native'
import { getImageStrategy, setImageStrategy } from '../store'
import { t } from '../i18n'
import type { ImageStrategy } from '../paste-image'

/** 粘贴图片存储策略（设置面板配置） */
let imageStrategy: ImageStrategy = getImageStrategy()

/** PicGo 各图床的配置字段定义（label 为 i18n key，placeholder 为示例值） */
export const PICGO_FIELDS: Record<
  string,
  { key: string; label: string; placeholder?: string; type?: string }[]
> = {
  smms: [
    { key: 'token', label: 'Token', placeholder: 'S.EE Dashboard API Token', type: 'password' },
  ],
  github: [
    { key: 'repo', label: '仓库', placeholder: 'owner/repo' },
    { key: 'branch', label: '分支', placeholder: 'main' },
    { key: 'token', label: 'Token', placeholder: 'GitHub Personal Access Token', type: 'password' },
    { key: 'path', label: '路径', placeholder: 'img/' },
    {
      key: 'customUrl',
      label: '自定义域名',
      placeholder: 'https://cdn.jsdelivr.net/gh/owner/repo',
    },
  ],
  qiniu: [
    { key: 'accessKey', label: 'AccessKey', placeholder: '七牛云 AccessKey' },
    { key: 'secretKey', label: 'SecretKey', placeholder: '七牛云 SecretKey', type: 'password' },
    { key: 'bucket', label: 'Bucket', placeholder: '存储空间名称' },
    { key: 'url', label: '访问域名', placeholder: 'https://cdn.example.com' },
    { key: 'area', label: '区域', placeholder: 'z0' },
  ],
  upyun: [
    { key: 'bucket', label: 'Bucket', placeholder: '又拍云服务名' },
    { key: 'operator', label: '操作员', placeholder: '操作员账号' },
    { key: 'password', label: '密码', placeholder: '操作员密码', type: 'password' },
    { key: 'url', label: '访问域名', placeholder: 'https://cdn.example.com' },
  ],
  tcyun: [
    { key: 'secretId', label: 'SecretId', placeholder: '腾讯云 SecretId' },
    { key: 'secretKey', label: 'SecretKey', placeholder: '腾讯云 SecretKey', type: 'password' },
    { key: 'bucket', label: 'Bucket', placeholder: '存储桶名称' },
    { key: 'appId', label: 'AppId', placeholder: '腾讯云 AppId' },
    { key: 'area', label: '区域', placeholder: 'ap-shanghai' },
    { key: 'path', label: '路径', placeholder: 'img/' },
  ],
  aliyun: [
    { key: 'accessKeyId', label: 'AccessKeyId', placeholder: '阿里云 AccessKeyId' },
    {
      key: 'accessKeySecret',
      label: 'AccessKeySecret',
      placeholder: '阿里云 AccessKeySecret',
      type: 'password',
    },
    { key: 'bucket', label: 'Bucket', placeholder: '存储空间名称' },
    { key: 'area', label: '区域', placeholder: 'oss-cn-hangzhou' },
    { key: 'path', label: '路径', placeholder: 'img/' },
  ],
  imgur: [{ key: 'clientId', label: 'Client ID', placeholder: 'Imgur Client ID' }],
}

/** 粘贴图片上下文读取当前策略（main.ts 装配注入） */
export function getCurrentImageStrategy(): ImageStrategy {
  return imageStrategy
}

/** HTML 属性值转义：配置值可能含引号，直接拼进 innerHTML 会破坏属性边界 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染指定图床的配置字段输入框
 * @param uploader 图床类型
 * @param values 已有配置值
 */
function renderPicGoFields(uploader: string, values: Record<string, string> = {}) {
  const container = document.getElementById('picgo-fields')
  if (!container) return
  const fields = PICGO_FIELDS[uploader] || []
  container.innerHTML = fields
    .map(
      (f) => `
    <div class="settings-row">
      <label class="settings-row-label" for="picgo-${f.key}">${f.label}</label>
      <input id="picgo-${f.key}" class="settings-input" type="${f.type || 'text'}"
        value="${escapeAttr(values[f.key] || '')}" placeholder="${escapeAttr(f.placeholder || '')}" />
    </div>`,
    )
    .join('')
}

/** 根据当前图片策略显示/隐藏图床配置区域 */
export function togglePicGoSection() {
  const section = document.getElementById('picgo-config-section')
  if (!section) return
  // 壳层无图床能力时整块隐藏：配置保存不落地，显示出来只会误导
  const supported = hasNativeFeature('picgo')
  section.style.display = supported && imageStrategy === 'hosting' ? '' : 'none'
}

/**
 * 无图床能力时降级「上传到图床」选项：
 * 单选项置灰 + 文案追加「当前版本不支持」，并把已保存的 hosting 策略回落为
 * 内联（否则每次粘贴都会走一次注定失败的 no-op 上传）。
 */
export function degradePicGoOption() {
  if (hasNativeFeature('picgo')) return
  const radio = document.querySelector(
    'input[name="set-img"][value="hosting"]',
  ) as HTMLInputElement | null
  const label = radio?.closest('.settings-option') as HTMLElement | null
  const text = label?.querySelector('span')
  if (radio) {
    radio.disabled = true
    radio.checked = false
  }
  if (text) text.textContent = t('settings.imageHostingUnsupported')
  if (imageStrategy === 'hosting') {
    imageStrategy = 'inline'
    setImageStrategy(imageStrategy)
  }
  togglePicGoSection()
}

/** 加载 PicGo 配置并填充到表单 */
export async function loadPicGoConfig() {
  if (!native || !hasNativeFeature('picgo')) return
  const config = await native.getPicGoConfig()
  // 兜底：能力声明缺省时若壳层仍返回 undefined（旧壳/异常），不能在这里抛错
  if (!config || typeof config !== 'object') return
  const uploader = (config.current as string) || 'smms'
  const select = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  if (select) select.value = uploader
  const values = (config[uploader] as Record<string, string>) || {}
  renderPicGoFields(uploader, values)
}

/** 保存 PicGo 配置 */
async function savePicGoConfig() {
  if (!native || !hasNativeFeature('picgo')) return
  const select = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  const uploader = select?.value || 'smms'
  const fields = PICGO_FIELDS[uploader] || []
  const values: Record<string, string> = {}
  for (const f of fields) {
    const input = document.getElementById(`picgo-${f.key}`) as HTMLInputElement | null
    values[f.key] = input?.value || ''
  }
  const statusEl = document.getElementById('picgo-save-status')
  const ok = await native.savePicGoConfig({ current: uploader, [uploader]: values })
  if (statusEl) {
    statusEl.textContent = t(ok ? 'settings.picgoSaved' : 'settings.picgoSaveFailed')
    setTimeout(() => {
      if (statusEl) statusEl.textContent = ''
    }, 3000)
  }
}

/** 图片策略单选 + 图床配置区的事件装配（wireSettings 编排调用） */
export function wireImageSection() {
  document.querySelectorAll('input[name="set-img"]').forEach((input) => {
    input.addEventListener('change', () => {
      imageStrategy = (input as HTMLInputElement).value as ImageStrategy
      setImageStrategy(imageStrategy)
      togglePicGoSection()
    })
  })

  // 图床类型切换：重新渲染对应配置字段
  const picgoUploader = document.getElementById('picgo-uploader') as HTMLSelectElement | null
  picgoUploader?.addEventListener('change', () => {
    renderPicGoFields(picgoUploader.value)
  })
  // 保存图床配置
  document.getElementById('picgo-save-btn')?.addEventListener('click', () => {
    void savePicGoConfig()
  })
}
