# 前端代码评审清单

> 继承通用清单,以下是前端专项重点。

## 性能

- 列表渲染是否有 key(且 key 稳定)
- 是否有不必要的 re-render(state / props 设计)
- 大列表是否虚拟化
- 图片是否懒加载、是否选了合适尺寸

## 状态管理

- state 是否集中在合理的位置(避免 prop drilling)
- 副作用(effect)依赖是否完整
- 异步操作组件卸载后是否清理

## 可访问性(a11y)

- 交互元素是否有 aria-label
- 颜色对比度
- 键盘可达性(tab 顺序、enter / esc 行为)

## 样式

- 是否符合团队设计 token / 组件库
- 响应式断点
- 暗黑模式

## 安全

- v-html / dangerouslySetInnerHTML 是否真的需要(防 XSS)
- 用户输入是否做了清洗

## 兼容

- 是否使用了过新的 API(检查 baseline 浏览器)
- polyfill 是否到位
