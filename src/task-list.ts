/**
 * 任务列表复选框点击切换
 *
 * GFM 任务项（- [ ] / - [x]）由 gfm preset 解析为带 checked 属性的 list_item 节点，
 * 复选框的视觉（方框/蓝底白勾/完成变灰）由 style.css 中
 * li[data-item-type='task'] 的 ::before/::after 样式绘制。
 * 本插件补齐交互：点击列表项左侧复选框热区即切换勾选状态。
 * 切换走 ProseMirror 事务，可 Cmd+Z 撤销，并正常触发内容监听/自动保存。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/** 复选框横向热区宽度（与 CSS 中任务项 padding-left: 26px 对应） */
const HIT_WIDTH = 26
/** 复选框纵向热区高度（仅首行方框附近可点，多行续行左侧不触发） */
const HIT_HEIGHT = 28

/** 复选框点击插件：任务项左侧热区点击切换勾选状态（走事务，可撤销） */
export const taskListClick = $prose(
  () =>
    new Plugin({
      props: {
        handleClick(view: EditorView, pos: number, event: MouseEvent) {
          if (!view.editable) return false
          const $pos = view.state.doc.resolve(pos)
          // 从点击位置由深向浅找任务列表项（checked 非 null 的 list_item）
          for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth)
            if (node.type.name !== 'list_item' || node.attrs.checked == null) continue

            const dom = view.nodeDOM($pos.before(depth))
            if (!(dom instanceof HTMLElement)) return false
            const rect = dom.getBoundingClientRect()
            // 嵌套子项有各自缩进，用各自 li 的边界判断，不会误触父项
            const dx = event.clientX - rect.left
            const dy = event.clientY - rect.top
            if (dx < 0 || dx >= HIT_WIDTH || dy < 0 || dy > HIT_HEIGHT) return false

            view.dispatch(
              view.state.tr.setNodeAttribute($pos.before(depth), 'checked', !node.attrs.checked),
            )
            return true
          }
          return false
        },
      },
    }),
)
