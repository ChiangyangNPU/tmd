/**
 * 中文名称的拼音首字母索引（快速切换面板的匹配扩展）。
 *
 * - pinyin-pro 字典体积大，动态 import 拆为独立 chunk：面板首次打开才加载，
 *   纯英文名场景永不产生开销；加载失败静默降级（仅原始名称匹配）
 * - initialsOf 在拼音未就绪时返回 null——rankEntries 是同步纯函数，
 *   就绪前后的差异只体现为"首字母匹配暂缺"，不影响原有排序
 *
 * @author chiangyang
 */

/** 拼音转换函数：undefined = 尚未加载，null = 加载失败（降级为仅原始名称匹配） */
let transact: ((text: string) => string) | null | undefined

/** 名称是否含汉字（拉丁名称无需拼音索引） */
export function hasCJK(text: string): boolean {
  return /\p{Script=Han}/u.test(text)
}

/** 面板打开时调用一次：加载拼音字典（幂等；失败静默降级） */
export async function ensurePinyin(): Promise<void> {
  if (transact !== undefined) return
  try {
    const { pinyin } = await import('pinyin-pro')
    // pattern 'first' 取每个汉字拼音首字母；非汉字字符原样保留，
    // 便于「xmsm」「wjsm」式子序列匹配（type array + join 消除分隔符）
    transact = (text) =>
      pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
  } catch {
    transact = null
  }
}

/** 拼音字典是否已就绪（测试观察口） */
export function pinyinReady(): boolean {
  return !!transact
}

/**
 * 名称的拼音首字母串（含非汉字原文），如「项目说明.md」→「xmsm.md」。
 * 未就绪 / 加载失败 / 不含汉字时返回 null（调用方跳过首字母匹配）。
 */
export function initialsOf(name: string): string | null {
  if (!transact || !hasCJK(name)) return null
  return transact(name).toLowerCase()
}
