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
 * 3. GPU 渲染相关 DLL（Windows）：纯文本编辑器不需要 WebGL/Vulkan 渲染，
 *    移除 dxcompiler.dll、vk_swiftshader.dll、dxil.dll
 *    （释放约 35 MB）。
 * 4. GPU 渲染相关库（macOS）：纯文本编辑器不需要 Vulkan 渲染，
 *    移除 Electron Framework.framework/Versions/A/Libraries/ 下的
 *    libvk_swiftshader.dylib、vk_swiftshader_icd.json
 *    （释放约 16 MB）。
 *    注意：libffmpeg.dylib 是 Electron Framework 的 dyld 强依赖，不能删除。
 * 5. Chromium 原生 UI 资源包（跨平台）：chrome_100_percent.pak、chrome_200_percent.pak，
 *    纯文本编辑器的 UI 由 HTML/CSS 渲染，不依赖这些原生资源
 *    （释放约 2 MB）。
 * 6. app.asar 瘦身（跨平台）：删除运行时不会加载的内容。
 *    - picgo CLI 依赖（commander、inquirer、rxjs、hono 等，约 10 MB 解包后）：
 *      TMD 只用图床上传 API，不用 CLI，将 picgo 入口的 CLI require 替换为 mock。
 *    - lodash 的 630 个单函数文件（约 0.66 MB）：均使用全量入口，单函数不会被加载。
 *    - ESM / browser 构建产物（dayjs、fflate、axios 等，约 1.4 MB）：
 *      主进程使用 CommonJS，这些构建不会被加载。
 *
 * @param {import('electron-builder').AfterPackContext} context - electron-builder 上下文
 * @author chiangyang
 */
const fs = require('fs')
const path = require('path')

/** 需要保留的语言包（Windows 的 .pak 名称）。
 *  与 src/i18n.ts 支持的语言一一对应：en-US、zh-CN、zh-TW。
 */
const KEEP_LOCALES_WIN = new Set(['en-US', 'zh-CN', 'zh-TW'])
/** 需要保留的语言包（macOS 的 .lproj 名称）。
 *  与 src/i18n.ts 支持的语言一一对应：en、zh-CN（zh_CN）、zh-Hant（zh_TW）。
 */
const KEEP_LOCALES_MAC = new Set(['en', 'zh_CN', 'zh_TW'])

/** 需要删除的运行时根目录文件 */
const REMOVE_ROOT_FILES = ['LICENSES.chromium.html']

/** Chromium 原生 UI 资源包（跨平台）。
 *  包含 Chromium 浏览器的原生 UI 字符串与图标（如权限弹窗、打印对话框等）。
 *  纯文本编辑器的 UI 完全由 HTML/CSS 渲染，不依赖这些原生资源，
 *  实测删除后编辑、保存对话框、分屏、导出等功能均正常。
 *  - chrome_100_percent.pak：1x 分辨率 UI 资源
 *  - chrome_200_percent.pak：2x 分辨率 UI 资源（Retina）
 */
const REMOVE_CHROME_PAK = ['chrome_100_percent.pak', 'chrome_200_percent.pak']

/** Windows 上可移除的 GPU 渲染相关 DLL（纯文本编辑器不需要 WebGL/Vulkan）。
 *  注意：保留 d3dcompiler_47.dll，Chromium GPU 进程启动时需要它做图层合成加速，
 *  否则会回退到纯 CPU 软件渲染导致滚动掉帧。
 */
const REMOVE_GPU_FILES_WIN = ['dxcompiler.dll', 'vk_swiftshader.dll', 'dxil.dll']

/** macOS 上可移除的 GPU 渲染相关库（纯文本编辑器不需要 Vulkan 渲染）。
 *  位于 Electron Framework.framework/Versions/A/Libraries/ 下。
 *  - libvk_swiftshader.dylib：Vulkan 软件渲染器，纯文本 UI 不需要。
 *  - vk_swiftshader_icd.json：Vulkan ICD 加载配置，配合上面的库使用。
 *  注意：libffmpeg.dylib 不能删，它是 Electron Framework 二进制的 dyld 强依赖，
 *  删除后应用启动即崩溃（与 Windows 上 ffmpeg.dll 延迟加载不同）。
 */
const REMOVE_GPU_FILES_MAC = ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json']

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
      // 只在 .app / Contents / Frameworks / Versions 下深入搜索，避免遍历整个 .app
      if (
        entry.name.endsWith('.app') ||
        entry.name === 'Contents' ||
        entry.name === 'Frameworks' ||
        entry.name === 'Versions'
      ) {
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
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
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

  // 3. 移除 GPU 渲染相关 DLL（Windows）
  if (platform === 'win32') {
    for (const fileName of REMOVE_GPU_FILES_WIN) {
      const filePath = path.join(appOutDir, fileName)
      const freed = removeFile(filePath)
      if (freed > 0) {
        console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
        freedBytes += freed
      }
    }
  }

  // 4. 移除 GPU 渲染 / 媒体解码相关库（macOS）
  if (platform === 'darwin') {
    const efDir = findDir(appOutDir, 'Electron Framework.framework')
    if (efDir) {
      const libsDir = path.join(efDir, 'Versions', 'A', 'Libraries')
      for (const fileName of REMOVE_GPU_FILES_MAC) {
        const filePath = path.join(libsDir, fileName)
        const freed = removeFile(filePath)
        if (freed > 0) {
          console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
          freedBytes += freed
        }
      }
    }
  }

  // 5. 移除 Chromium 原生 UI 资源包（跨平台）
  for (const fileName of REMOVE_CHROME_PAK) {
    // Windows: appOutDir/*.pak
    const winPath = path.join(appOutDir, fileName)
    let freed = removeFile(winPath)
    if (freed > 0) {
      console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
      freedBytes += freed
      continue
    }
    // macOS: Electron Framework.framework/Versions/A/Resources/*.pak
    if (platform === 'darwin') {
      const efDir = findDir(appOutDir, 'Electron Framework.framework')
      if (efDir) {
        const macPath = path.join(efDir, 'Versions', 'A', 'Resources', fileName)
        freed = removeFile(macPath)
        if (freed > 0) {
          console.log(`[trim-runtime] removed ${fileName} (${(freed / 1024 / 1024).toFixed(2)} MB)`)
          freedBytes += freed
        }
      }
    }
  }

  // 6. 精简 app.asar（picgo CLI 依赖、lodash 单函数文件、ESM/browser 冗余构建）
  freedBytes += await trimAppAsar(appOutDir, platform)

  const freedMB = (freedBytes / 1024 / 1024).toFixed(2)
  console.log(`[trim-runtime] total freed ${freedMB} MB`)
}

/**
 * 精简 app.asar 内的冗余内容。
 *
 * 包含三类：
 * 1. picgo CLI 依赖：TMD 仅使用 picgo 的图床上传 API（upload / getConfig /
 *    saveConfig），不使用 CLI 功能。但 picgo 的打包入口在顶层 require 了
 *    commander、inquirer、hono、@hono/node-server 等 CLI/服务器依赖，导致这些包
 *    （含 inquirer 的间接依赖 rxjs，约 8.4 MB 解包后）全部被打入 app.asar。
 *    做法：将 picgo 入口中这些 require 替换为轻量 mock 对象，再删除对应包。
 *    ejs、giget 在 picgo 入口中未被引用，直接删除。
 * 2. lodash 单函数文件：TMD 及所有依赖均使用 require('lodash') 全量入口，
 *    630 个单独的函数文件（如 debounce.js、chunk.js）不会被加载。
 * 3. ESM / browser 构建产物：Electron 主进程使用 CommonJS，各包的 ESM / browser
 *    构建不会被加载（详见 REMOVE_UNUSED_BUILDS）。
 *
 * 策略：解包 app.asar → 修改 picgo 入口 → 删除冗余内容 → 重新打包 asar。
 *
 * @param {string} appOutDir - 打包输出目录
 * @param {string} platform - 平台名
 * @returns {Promise<number>} 释放的字节数
 */
async function trimAppAsar(appOutDir, platform) {
  const asar = require('@electron/asar')
  const os = require('os')

  // 定位 app.asar
  let asarPath
  if (platform === 'darwin') {
    asarPath = path.join(appOutDir, 'TMD.app', 'Contents', 'Resources', 'app.asar')
  } else {
    asarPath = path.join(appOutDir, 'resources', 'app.asar')
  }
  if (!fs.existsSync(asarPath)) return 0

  // picgo 入口中需要 mock 的 CLI 依赖及其替换表达式
  const PICGO_MOCK_REPLACEMENTS = [
    {
      find: 'require("commander")',
      replace:
        '({Command:function(){var chain={version:function(){return chain},option:function(){return chain},command:function(){return chain},action:function(){return chain},parse:function(){return chain},parseAsync:function(){return chain},helpOption:function(){return chain},addCommand:function(){return chain},description:function(){return chain},argument:function(){return chain}};return chain}})',
    },
    { find: 'require("inquirer")', replace: '({prompt:async()=>({})})' },
    {
      find: 'require("hono")',
      replace:
        '({Hono:function(){return{use(){},get(){},post(){},all(){},on(){},route(){},basePath:function(){return this},notFound(){},onError(){}}}})',
    },
    { find: 'require("hono/logger")', replace: '({logger:()=>({})})' },
    { find: 'require("hono/cors")', replace: '({cors:()=>({})})' },
    { find: 'require("@hono/node-server")', replace: '({serve:()=>{}})' },
    { find: 'require("@hono/node-server/serve-static")', replace: '({serveStatic:()=>({})})' },
  ]

  // 需要从 node_modules 中删除的包
  const REMOVE_PICGO_DEPS = ['commander', 'inquirer', 'rxjs', 'hono', '@hono', 'ejs', 'giget']

  // CJS 运行时不会加载的冗余构建产物。
  // Electron 主进程使用 CommonJS（require），各包的 ESM / browser 构建不会被加载，
  // 且已确认无任何代码引用这些子路径。dayjs 的 locale 也无需保留：主进程不调用
  // dayjs.locale() 切换语言（界面文案由 src/i18n.ts 自行管理）。
  const REMOVE_UNUSED_BUILDS = [
    'dayjs/esm',
    'dayjs/locale',
    'fflate/esm',
    'axios/dist/esm',
    'axios/dist/browser',
  ]

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmd-asar-'))
  let freedBytes = 0

  try {
    // 1. 解包 asar
    asar.extractAll(asarPath, tmpDir)

    // 2. 修改 picgo 入口，替换 CLI 依赖的 require
    const picgoEntry = path.join(tmpDir, 'node_modules', 'picgo', 'dist', 'index.cjs.js')
    if (fs.existsSync(picgoEntry)) {
      let code = fs.readFileSync(picgoEntry, 'utf8')
      let replaced = 0
      for (const { find, replace } of PICGO_MOCK_REPLACEMENTS) {
        if (code.includes(find)) {
          code = code.split(find).join(replace)
          replaced++
        }
      }
      fs.writeFileSync(picgoEntry, code)
      console.log(`[trim-runtime] picgo: mocked ${replaced} CLI deps`)
    }

    // 3. 删除不再需要的 node_modules 包
    const nmDir = path.join(tmpDir, 'node_modules')
    for (const pkg of REMOVE_PICGO_DEPS) {
      const pkgPath = path.join(nmDir, pkg)
      if (fs.existsSync(pkgPath)) {
        const size = dirSize(pkgPath)
        removeDir(pkgPath)
        freedBytes += size
        console.log(`[trim-runtime] picgo: removed ${pkg} (${(size / 1024 / 1024).toFixed(2)} MB)`)
      }
    }

    // 3.1 清理 lodash 的单独函数文件：TMD 及所有依赖均使用 require('lodash')
    // 全量入口，630 个单独的函数文件（如 debounce.js、chunk.js）不会被加载，直接删除。
    const lodashDir = path.join(nmDir, 'lodash')
    if (fs.existsSync(lodashDir)) {
      let lodashFreed = 0
      for (const file of fs.readdirSync(lodashDir)) {
        if (!file.endsWith('.js')) continue
        if (file === 'lodash.js') continue // 保留主入口
        const filePath = path.join(lodashDir, file)
        lodashFreed += removeFile(filePath)
      }
      if (lodashFreed > 0) {
        freedBytes += lodashFreed
        console.log(
          `[trim-runtime] lodash: removed per-function files (${(lodashFreed / 1024 / 1024).toFixed(2)} MB)`,
        )
      }
    }

    // 3.2 删除 CJS 运行时不会加载的 ESM / browser 构建产物
    let buildsFreed = 0
    let buildsRemoved = 0
    for (const relPath of REMOVE_UNUSED_BUILDS) {
      const target = path.join(nmDir, relPath)
      if (!fs.existsSync(target)) continue
      const size = dirSize(target)
      removeDir(target)
      buildsFreed += size
      buildsRemoved++
    }
    if (buildsRemoved > 0) {
      freedBytes += buildsFreed
      console.log(
        `[trim-runtime] removed ${buildsRemoved} unused builds (esm/locale/browser, ${(buildsFreed / 1024 / 1024).toFixed(2)} MB)`,
      )
    }

    // 4. 重新打包 asar
    const backupPath = asarPath + '.bak'
    fs.renameSync(asarPath, backupPath)
    try {
      await asar.createPackage(tmpDir, asarPath)
      fs.unlinkSync(backupPath)
    } catch (err) {
      // 打包失败，恢复原文件
      fs.renameSync(backupPath, asarPath)
      throw err
    }
  } finally {
    removeDir(tmpDir)
  }

  return freedBytes
}
