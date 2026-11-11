/**
 * 设置面板——更新区：自动检查开关、手动检查 / 安装按钮与状态文案。
 * 更新事件流由主进程 onUpdateStatus 推送，此处只做展示映射。
 */
import { native } from '../native'
import type { UpdateStatus } from '../native'
import { getAutoCheckUpdate, setAutoCheckUpdate } from '../store'
import { t } from '../i18n'

/** 更新区的事件装配（wireSettings 编排调用） */
export function wireUpdateSection() {
  // ---------- 更新 ----------
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) {
    autoCheckBox.addEventListener('change', () => {
      setAutoCheckUpdate(autoCheckBox.checked)
      native?.setAutoCheckUpdate(autoCheckBox.checked)
    })
  }

  const updateCheckBtn = document.getElementById('update-check-btn') as HTMLButtonElement | null
  const updateStatus = document.getElementById('update-status')
  const updateInstallBtn = document.getElementById('update-install-btn') as HTMLButtonElement | null
  updateCheckBtn?.addEventListener('click', () => {
    void native?.checkForUpdates()
  })
  updateInstallBtn?.addEventListener('click', () => {
    native?.installUpdate()
  })

  /** 根据更新状态刷新设置面板文案与按钮可用性 */
  const applyUpdateStatus = (status: UpdateStatus) => {
    if (!updateStatus || !updateCheckBtn || !updateInstallBtn) return
    switch (status.status) {
      case 'idle':
        updateStatus.textContent = ''
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'checking':
        updateStatus.textContent = t('settings.updateChecking')
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'available':
        updateStatus.textContent = t('settings.updateAvailable', { version: status.version })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'not-available':
        updateStatus.textContent = t('settings.updateNotAvailable')
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'downloading':
        updateStatus.textContent = t('settings.updateDownloading', {
          percent: Math.round(status.percent ?? 0),
        })
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'downloaded':
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = false
        if (status.path) {
          // macOS 手动安装模式：提示落盘路径，按钮语义为「打开安装包」
          // （关闭应用并挂载 dmg，引导拖入「应用程序」）
          updateStatus.textContent = t('settings.updateDownloadedManual', {
            path: status.path,
          })
          updateInstallBtn.textContent = t('settings.updateOpenInstaller')
        } else {
          // Windows 自动安装模式：重启即装
          updateStatus.textContent = t('settings.updateDownloaded')
          updateInstallBtn.textContent = t('settings.updateInstall')
        }
        break
      case 'error':
        updateStatus.textContent = t('settings.updateError', { message: status.message })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
    }
  }
  native?.onUpdateStatus(applyUpdateStatus)

  // 启动时把"启动时自动检查更新"开关同步给主进程
  // （主进程据此决定是否在 app 启动后 5 秒自动检查）
  native?.setAutoCheckUpdate(getAutoCheckUpdate())
}
