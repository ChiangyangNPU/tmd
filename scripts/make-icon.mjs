/**
 * 一键重建应用图标：build/icon.svg → build/icon.png / icon.icns / icon.ico
 *
 * 用法：npm run icon（或 node scripts/make-icon.mjs）
 * 依赖：macOS（sips、iconutil）、Google Chrome 或 Microsoft Edge（headless 渲染 SVG）
 * 流程：SVG --Chrome--> 1024 PNG --sips+iconutil--> icns；PNG --sips+拼装--> ico
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const svgPath = path.join(buildDir, 'icon.svg')
const pngPath = path.join(buildDir, 'icon.png')
const icnsPath = path.join(buildDir, 'icon.icns')
const icoPath = path.join(buildDir, 'icon.ico')
const tmpDir = path.join(buildDir, '.icon-tmp')

// 静默执行命令（sips/Chrome 输出噪声大），失败时抛错
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' })

function renderPng() {
  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  const chrome = chromeCandidates.find((p) => fs.existsSync(p))
  if (!chrome) {
    throw new Error('未找到 Chrome/Edge/Chromium，无法渲染 SVG。请安装其一后重试。')
  }
  sh(`"${chrome}" --headless --disable-gpu --screenshot="${pngPath}" \
--window-size=1024,1024 --default-background-color=00000000 --hide-scrollbars \
"file://${svgPath}"`)
  console.log('✓ icon.png（1024×1024）')
}

function renderIcns() {
  const iconset = path.join(tmpDir, 'icon.iconset')
  fs.mkdirSync(iconset, { recursive: true })
  // [边长, 文件名]；@2x 文件用双倍像素
  const entries = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
  ]
  for (const [size, name] of entries) {
    sh(`sips -z ${size} ${size} "${pngPath}" --out "${path.join(iconset, name)}"`)
  }
  // 1024 = 512@2x，直接用主图
  fs.copyFileSync(pngPath, path.join(iconset, 'icon_512x512@2x.png'))
  sh(`iconutil -c icns "${iconset}" -o "${icnsPath}"`)
  console.log('✓ icon.icns（macOS，16~1024 共 10 个尺寸）')
}

function renderIco() {
  // Windows .ico：内嵌多尺寸 PNG（Vista+ 支持）
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map((size) => {
    const p = path.join(tmpDir, `${size}.png`)
    sh(`sips -z ${size} ${size} "${pngPath}" --out "${p}"`)
    return { size, buf: fs.readFileSync(p) }
  })

  // ICONDIR：reserved(0) + type(1=icon) + count
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  // ICONDIRENTRY：每项 16 字节
  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length
  images.forEach(({ size, buf }, i) => {
    const o = i * 16
    entries.writeUInt8(size >= 256 ? 0 : size, o) // 宽（0 表示 256）
    entries.writeUInt8(size >= 256 ? 0 : size, o + 1) // 高（0 表示 256）
    entries.writeUInt8(0, o + 2) // 调色板数
    entries.writeUInt8(0, o + 3) // 保留
    entries.writeUInt16LE(1, o + 4) // 色彩平面
    entries.writeUInt16LE(32, o + 6) // 位深
    entries.writeUInt32LE(buf.length, o + 8) // 图像数据大小
    entries.writeUInt32LE(offset, o + 12) // 图像数据偏移
    offset += buf.length
  })

  fs.writeFileSync(icoPath, Buffer.concat([header, entries, ...images.map((i) => i.buf)]))
  console.log(`✓ icon.ico（Windows，${sizes.join('/')} 共 ${sizes.length} 个尺寸）`)
}

// 主流程
fs.rmSync(tmpDir, { recursive: true, force: true })
try {
  renderPng()
  renderIcns()
  renderIco()
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
console.log('图标重建完成。')
