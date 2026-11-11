/**
 * 设置面板入口：按配置域拆分的子模块转导出。
 * 外部（main.ts / 测试）仍从 './settings' 导入，导入面与拆分前一致。
 *
 * 子模块分工：
 * - panel.ts       面板框架（导航 / 拖拽 / 开合 / wireSettings 编排）
 * - image.ts       图片策略 + PicGo 图床配置
 * - ai.ts          AI 助手配置
 * - shortcuts.ts   快捷键自定义 UI
 * - theme-files.ts 主题选择与文件式主题
 * - update.ts      更新区
 */
export {
  openSettings,
  closeSettings,
  wireSettings,
  applySourceLineNumbers,
  applySpellcheck,
} from './panel'
export { getCurrentImageStrategy, PICGO_FIELDS } from './image'
