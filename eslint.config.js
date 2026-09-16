import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * ESLint flat config（ESLint 9+ 格式）
 *
 * 规则定位：tsc strict 已管类型/未用变量，eslint 只补 tsc 抓不到的潜在 bug 与坏习惯；
 * 格式类规则全部交给 Prettier（eslint-config-prettier 关闭冲突项）。
 */
export default [
  // 构建产物与依赖不参与检查
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'build/**'] },

  // 社区推荐规则基线
  eslint.configs.recommended,
  // TS 专用规则基线
  ...tseslint.configs.recommended,

  // 关闭与 Prettier 冲突的格式类规则（必须放最后）
  prettier,

  // 渲染层主规则
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      // 渲染层是浏览器环境
      globals: globals.browser,
    },
    rules: {
      // 禁 console.log（调试残留），放行 error/warn（项目错误兜底是合理用法）
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // 强制 ===，但放行 == null / != null（null|undefined 双重判断惯用法，改成严格反而漏 undefined）
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // 禁 debugger（调试残留）
      'no-debugger': 'error',
      // tsc 已管未用变量，关闭避免双重报错
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // 测试文件放松
  {
    files: ['src/__tests__/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // electron 壳层：JSDoc 标注的 .cjs，CommonJS 环境
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      // 壳层有合理错误日志
      'no-console': 'off',
      // CommonJS require 是合法用法，关闭 TS 的禁止规则
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // scripts：Node ESM 脚本
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },

  // scripts：Node CommonJS 脚本（与 electron/**/*.cjs 同环境）
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // public：首帧引导脚本，浏览器环境（先于模块 JS 执行）
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
]
