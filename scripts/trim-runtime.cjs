/**
 * afterPack 钩子：精简 Electron 运行时冗余文件，减小安装包体积
 *
 * 精简策略（跨平台）：
 * 1. locales：仅保留应用实际支持的语言包（en-US、zh-CN），删除其余语言包。
 *    - Windows：appOutDir/locales/*.pak（释放约 47 MB）
 *    - macOS：  appOutDir/.../Electron Framework.framework/Resources/*.lproj
 * 2. LICENSES.chromium.html：Chromium 开源许可证汇总文件（约 19 MB），
 *    不影响运行时功能。注意：若需严格遵守 Chromium 许可证展示义务，
 *    可在应用「关于」页面另行提供许可证链接。
 *
 * @param {import('electron-builder').AfterPackContext} context - electron-builder 上下文
 * @author chiangyang
 */
const fs = require('fs')
const path = require('path')

/** 需要保留的语言包（Windows 的 .pak 名称） */
const KEEP_LOCALES_WIN = new Set(['en-US', 'zh-CN'])
/** 需要保留的语言包（macOS 的 .lproj 名称） */
const KEEP_LOCALES_MAC = new Set(['en', 'zh_CN'])

/** 需要删除的运行时根目录文件 */
const REMOVE_ROOT_FILES = ['LICENSES.chromium.html']

/**
 * 删除指定文件，返回释放的字节数
 * @param {string} filePath - 文件绝对路径
 * @returns {number} 释放的字节数，失败返回 0
 */
function removeFile(filePath) {
  try {
    const stat = fs.statSync(filePath)
    fs.unlinkSync(filePath)
    return stat.size
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[trim-runtime] failed to remove', filePath, err.message)
    }
    return 0
  }
}

/**
 * 递归删除目录及其内容，返回释放的字节数
 * @param {string} dirPath - 目录绝对路径
 * @returns {number} 释放的字节数
 */
function removeDir(dirPath) {
  let freed = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        freed += removeDir(fullPath)
      } else {
        freed += removeFile(fullPath)
      }
    }
    fs.rmdirSync(dirPath)
  } catch (err) {
    console.warn('[trim-runtime] failed to remove dir', dirPath, err.message)
  }
  return freed
}

/**
 * 在指定目录下查找匹配的子目录名
 * @param {string} root - 起始目录
 * @param {string} targetName - 目标目录名
 * @returns {string|null} 找到的目录路径，未找到返回 null
 */
function findDir(root, targetName) {
  if (!fs.existsSync(root)) return null
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === targetName) return path.join(root, entry.name)
      // 只在 Frameworks 下深入搜索，避免遍历整个 .app
      if (entry.name === 'Contents' || entry.name === 'Frameworks' || entry.name === 'Versions') {
        const found = findDir(path.join(root, entry.name), targetName)
        if (found) return found
      }
    }
  }
  return null
}

/**
 * 获取指定目录的大小（字节）
 * @param {string} dirPath - 目录路径
 * @returns {number} 目录总大小
 */
function dirSize(dirPath) {
  let total = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += dirSize(fullPath)
      } else {
        try {
          total += fs.statSync(fullPath).size
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

exports.default = async function (context) {
  const appOutDir = context.appOutDir
  const platform = context.electronPlatformName
  let freedBytes = 0

  // 1. 精简 locales 语言包
  if (platform === 'win32') {
    // Windows: appOutDir/locales/*.pak
    const localesDir = path.join(appOutDir, 'locales')
    if (fs.existsSync(localesDir)) {
      let removed = 0
      for (const file of fs.readdirSync(localesDir)) {
        if (path.extname(file) !== '.pak') continue
        const name = path.basename(file, '.pak')
        if (KEEP_LOCALES_WIN.has(name)) continue
        freedBytes += removeFile(path.join(localesDir, file))
        removed++
      }
      console.log(`[trim-runtime] removed ${removed} locale packs`)
    }
  } else if (platform === 'darwin') {
    // macOS: .../Electron Framework.framework/Resources/*.lproj
    const efDir = findDir(appOutDir, 'Electron Framework.framework')
    if (efDir) {
      const resourcesDir = path.join(efDir, 'Resources')
      if (fs.existsSync(resourcesDir)) {
        let removed = 0
        for (const name of fs.readdirSync(resourcesDir)) {
          if (!name.endsWith('.lproj')) continue
          const localeName = name.slice(0, -'.lproj'.length)
          if (KEEP_LOCALES_MAC.has(localeName)) continue
          const lprojPath = path.join(resourcesDir, name)
          freedBytes += dirSize(lprojPath)
          removeDir(lprojPath)
          removed++
        }
        console.log(`[trim-runtime] removed ${removed} locale lproj dirs`)
      }
    }
  }

  // 2. 删除 LICENSES.chromium.html
  for (const fileName of REMOVE_ROOT_FILES) {
    // Windows: 根目录
    const winPath = path.join(appOutDir, fileName)
    let freed = removeFile(winPath)
    if (freed > 0) {
      console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
      freedBytes += freed
      continue
    }
    // macOS: Electron Framework.framework/Resources/
    if (platform === 'darwin') {
      const efDir = findDir(appOutDir, 'Electron Framework.framework')
      if (efDir) {
        const macPath = path.join(efDir, 'Resources', fileName)
        freed = removeFile(macPath)
        if (freed > 0) {
          console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
          freedBytes += freed
        }
      }
    }
  }

  const freedMB = (freedBytes / 1024 / 1024).toFixed(2)
  console.log(`[trim-runtime] total freed ${freedMB} MB`)
}
