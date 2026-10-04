/**
 * 生成「液态玻璃 Pro」折射位移图（PNG data URI，stdout 输出）。
 *
 * 原理：SVG feDisplacementMap 用图的 R/G 通道编码采样点的 x/y 偏移
 * （128 = 不偏移），把该图经 feImage 拉伸铺满玻璃元素后，元素边缘的
 * 采样坐标被向外推——背景内容在边缘被"吸进来"压缩，形成苹果
 * Liquid Glass 的凸透镜边缘（lensing）。中心保持 128 即不折射。
 *
 * 位移通道布局（R=x，G=y）：
 *   左缘 R<128（采样点左移）  右缘 R>128
 *   上缘 G<128（采样点上移）  下缘 G>128
 *   角部两通道同时偏移（对角向外），由逐像素的双向坡度自然合成。
 *
 * 参数（feImage 以 preserveAspectRatio=none 拉伸到元素边界，
 * 所以 RIM 是"元素短边占比"而非像素）：
 *   SIZE — 输出分辨率；RIM — 折射带占比；EASE — 强度缓动指数（2 = 越贴边越强）；
 *   用法：node scripts/gen-lens-map.mjs > /tmp/lens-uri.txt
 */
import zlib from 'node:zlib'

const SIZE = 256
const RIM = 0.10 // 折射带占半边比例（0~1）：0.12 = 每侧 12% 区域参与折射
const EASE = 2

// ---- 逐像素位移图：RGB PNG（B 通道恒 128 未用，A 不需要）----
const raw = Buffer.alloc(SIZE * SIZE * 3)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 距四边的归一化距离（0 = 贴边，1 = 折射带外）
    const tx = Math.min(x, SIZE - 1 - x) / (SIZE * RIM)
    const ty = Math.min(y, SIZE - 1 - y) / (SIZE * RIM)
    const fx = tx < 1 ? Math.pow(1 - tx, EASE) : 0
    const fy = ty < 1 ? Math.pow(1 - ty, EASE) : 0
    // 方向：右/下缘取正（采样点外移），左/上缘取负；中心区 fx/fy = 0
    const r = Math.round(128 + (x >= SIZE / 2 ? fx : -fx) * 127)
    const g = Math.round(128 + (y >= SIZE / 2 ? fy : -fy) * 127)
    const i = (y * SIZE + x) * 3
    raw[i] = r
    raw[i + 1] = g
    raw[i + 2] = 128
  }
}

// ---- 最小 PNG 编码器（真彩色 8bit，无滤波行）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
const stride = SIZE * 3
const scanlines = Buffer.alloc((stride + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (stride + 1)] = 0 // filter type: none
  raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

process.stdout.write(`data:image/png;base64,${png.toString('base64')}\n`)
process.stderr.write(`SIZE=${SIZE} RIM=${RIM} EASE=${EASE} png=${png.length}B base64=${Math.ceil((png.length * 4) / 3)}B\n`)
