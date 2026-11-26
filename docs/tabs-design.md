# Ziplark 多标签（TABS）设计 v2

日期：2026-11-17。目标：多个压缩包**并存可切换**（标签页与面板两个表现面一致），
打破上游"一 webview 一 `currentArchive`"的替换语义。

v1 的 iframe 外壳方案已否决（用户拍板：参照其他独立插件直接 PATCH 移植过来的
前端逻辑，不上 iframe/relay/双页结构）。

## 1. 方案

**单页 + 标签条 + 构建 Patch + 运行时包装。**

- `upstream/` 快照继续只读；`build-web.mjs` 在拷贝到 dist 时对 `main.js` 打**一个**
  声明过的补丁：在三条状态声明（`currentArchive` / `archiveStack` / `tree`，均为
  脚本作用域 `let/const`，外部不可达）之后注入 `window.__ztState` 读写出口。
  这是唯一动 main.js 的地方，由 build 测试逐字锁定。
- **新增 `shell/tabs.js`**（classic script，在 main.js 之后加载）：全部标签逻辑。
  - 运行时包装全局函数：`openArchive`（所有打开入口——按钮/拖拽/文件投递/嵌套——
    都经此，函数声明挂 window，内部调用同样命中包装版）、`closeArchive`、
    `renderArchive`（捕获 `info` 供标签快照）。
  - 标签注册表：每 tab 存 `{ path, password, archive, stack, info, ui }`，
    `ui = { expanded, sortBy, sortAsc, query, scrollTop }`。
  - 切换 tab：保存离开页 ui → `__ztState` 写入目标页 archive/stack →
    `renderArchive(info)` 重建 → 恢复 ui → 恢复滚动。
  - 投递 upsert：同 path 已有 tab → 激活并重列（等价刷新）；否则新建 tab。
    嵌套钻取（`keepStack`）不建 tab，归属当前 tab 的 stack。
  - 标签条 DOM 由 tabs.js 注入到 `.topbar` 之下；**无归档 tab 时整条隐藏**
    （界面与今天完全一致）。`[+ 打开归档]` 触发既有 `btn-open`。
  - busy 遮罩覆盖全屏，天然阻止长操作中切换 tab，无需互斥层（YAGNI）。
- `bridge.css`：标签条样式。
- **Create/打开视图**：不动（topbar 里的上游视图切换原样）；标签条只管归档。

## 2. 关键决策

1. 补丁锚点唯一：`let createInputs = [];` 之后注入；build 测试断言 dist main.js
   = upstream 原文 + 恰好这一处插入。
2. `renderArchive` 包装负责把 `list_archive` 结果（`info`）记到"当前正在打开的
   tab"；包装 `openArchive` 完成后快照 archive/stack/ui。
3. 密码随 tab 走（`currentArchive.password` 每 tab 独立保存/恢复）。
4. 事件流不变：桥的投递修复（敲门/consume/本地投递）照旧，`ziplark-open-file`
   事件由 tabs.js 包装的 `openArchive` 接住并 upsert。
5. 面板窗口：同一份页面，标签条同样生效；窗口尺寸由宿主 `resize_panel_window`
   适配（现行为）。
6. 顺带落实上一轮递延的 P3：修正 `host-bridge.js` 里 push_open_file 旧注释。

## 3. 非目标（v1）

跨包拖拽复制（引擎无此能力）、tab 拖拽重排、tab 状态持久化/重启恢复、
中键关闭、溢出折叠（横向滚动即可）、嵌套钻取同步 tab 标题。

## 4. 验证

- 单测（node:vm，沿 host-bridge.test.mjs 模式）：tabs 注册表纯逻辑
  （upsert/激活/关闭/快照恢复/嵌套归属）+ build 测试（main.js 补丁唯一性、
  tabs.js 装配顺序、strip 注入）。
- 端到端（装入宿主）：双开两包 → 两个归档 tab 并存可切、状态互不干扰；
  同路径重开 → 激活既有 tab；home 打开 → 新 tab；面板窗口同样生效；
  嵌套包返回上层后切走再切回，栈与视图保持。

### 验证记录（2026-11-17）

- 单测 23/23：build 装配顺序与补丁唯一性；控制器 upsert / 快照恢复 / 嵌套归属 /
  关闭回落 / 密码隔离；`node --input-type=module` 核验 dist main.js = 原文 + 恰好一处。
- 已装入宿主 0.9.8 并重启，场景清单交由用户按 §4 逐项自验（发布指令视为验收）。


### 0.2.1 热修（2026-11-17，发后审计）

发后审计（新上下文）发现 3 个 P1，根因同一：上游 `openArchive` 失败时同样 resolve
（toast + return）且事件驱动的打开不经 busy 遮罩——v0.2.0 的包装据此错误快照。
修复：openTab 返回 {tab, done}，done=true ⟺ 本次刷新产出渲染（renderToken 前进）；
失败时新建 tab 回收、既有 tab 恢复自身栈（上游刷新前会清 archiveStack）；所有打开
经 openQueue 串行化；激活/失败路径同步 renderStrip；暗色模式改用上游主题变量；
标签条文案接入 9 语言。单测 23/23（失败感知/回收/栈恢复/密码隔离/切换恢复全覆盖）。

### 0.2.2 热修（2026-11-26）

- 新归档刷新前先激活对应标签，避免归档信息写入离开的标签。
- 新标签打开失败时恢复原标签与归档栈，保持原有视图状态。
- 选中项随各标签独立保存与恢复，关闭按钮统一经过标签控制器。
- 发布前验证：overlay 回归测试 27/27，通过上游快照检查与前端构建。
