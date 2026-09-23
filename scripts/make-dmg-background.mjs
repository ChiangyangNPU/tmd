/**
 * 生成 dmg 安装窗口背景图 build/dmg-background.png（660×400，与安装窗口 1:1；
 * electron-builder 规则：背景图像素分辨率即窗口分辨率，不做 @2x）。
 *
 * 为什么：dmg.title 同时决定桌面卷名与安装窗口标题，二者无法分离——
 * 桌面图标要干净的 "TMD"（title 配置），版本号改为画进安装窗口背景：
 * 顶部 TMD + 当前版本号（读 package.json），两个图标位之间画拖拽箭头
 * （自定义背景会整体替换默认模板，箭头需自绘）。图标位由 dmg.contents
 * 对称定于窗口中线两侧 (190,220) / (470,220)（图标 80pt，默认坐标是按
 * 540 宽窗口设计的，660 窗口下会偏左），箭头对齐其中线、标题同轴居中。
 *
 * 渲染链路：node 手写 SVG → macOS 自带 qlmanage 栅格化为 PNG（零新增依赖）。
 * 每次 dist 前运行：版本号变化时背景自动跟上，无需手工维护图片。
 *
 * 仅 macOS 可运行（依赖 qlmanage/sips），非 darwin 直接返回——Windows 本地
 * dist 无需该背景图，不应因此中断打包。
 *
 * @author chiangyang
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const OUT = 'build/dmg-background.png'

/** 主流程：生成 SVG → qlmanage 栅格化 → sips 裁切为 660×400 PNG */
function main() {
  if (process.platform !== 'darwin') {
    console.log('非 macOS 环境，跳过 dmg 背景图生成')
    return
  }
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version

  // electron-builder 规则：背景图像素分辨率 1:1 决定安装窗口大小（660×400 窗口
  // ← 660×400 图，不做 @2x）。图标中心固定在 (130,220)/(410,220)（默认 contents，
  // 图标 80pt），标题与版本号画在窗口上部，箭头画在两图标之间。
  // qlmanage 缩略图强制方形画布，对非方形 SVG 排版不可控——故 SVG 做成 660×660
  // 方形，设计内容放在中间 400 行（y 偏移 +130），qlmanage 1:1 渲染后用 sips
  // 居中裁剪 400 行，必然得到设计带。
  const W = 660
  const H = 400
  const Y = 130 // 设计带在方形画布中的纵向偏移
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <rect width="${W}" height="${W}" fill="#f5f5f7"/>
  <text x="330" y="${105 + Y}" font-family="Helvetica Neue" font-size="46" font-weight="600" fill="#1d1d1f" text-anchor="middle">TMD</text>
  <text x="330" y="${152 + Y}" font-family="Helvetica Neue" font-size="22" fill="#86868b" text-anchor="middle">版本 ${version}</text>
  <line x1="245" y1="${220 + Y}" x2="398" y2="${220 + Y}" stroke="#b9bdc3" stroke-width="5" stroke-linecap="round"/>
  <path d="M 415 ${220 + Y} L 387 ${203 + Y} L 387 ${237 + Y} Z" fill="#b9bdc3"/>
</svg>`

  writeFileSync('build/dmg-background.svg', svg)
  rmSync(OUT, { force: true })
  // qlmanage 输出名 = <源文件名>.svg.png；缩略图强制方形（1320×1320，内容居中、
  // 上下各 260px 透明带），用 sips 居中裁剪回 1320×800
  execFileSync('qlmanage', ['-t', '-s', String(W), '-o', 'build', 'build/dmg-background.svg'], {
    stdio: 'pipe',
  })
  if (!existsSync('build/dmg-background.svg.png')) {
    throw new Error('qlmanage 未产出缩略图，检查 SVG 内容')
  }
  execFileSync('sips', ['-c', String(H), String(W), 'build/dmg-background.svg.png', '--out', OUT], {
    stdio: 'pipe',
  })
  rmSync('build/dmg-background.svg', { force: true })
  rmSync('build/dmg-background.svg.png', { force: true })
  console.log(`dmg 背景图已生成：${OUT}（TMD ${version}）`)
}

main()
