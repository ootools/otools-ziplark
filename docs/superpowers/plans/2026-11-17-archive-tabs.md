# 归档多标签（TABS）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在移植版 UI 上以 PATCH + 运行时包装实现多归档标签并存可切换（标签页与面板一致）。

**Architecture:** `build-web.mjs` 拷贝 upstream UI 时对 main.js 注入唯一锚点补丁（`window.__ztState` 三状态读写出口）；新增 `shell/tabs.js` 运行时包装 `openArchive/closeArchive/renderArchive`、注入标签条 DOM、按路径 upsert 管理标签注册表。上游快照不动，无 iframe。

**Tech Stack:** 原生 JS（classic script）+ node:test/vm；构建脚本 `scripts/build-web.mjs`。

**Spec:** `docs/tabs-design.md`（v2）

## Global Constraints

- `upstream/` 快照一字不动；dist 的 main.js 只允许"原文 + 恰好一处锚点插入"。
- 补丁锚点：`let createInputs = [];` 之后注入 `window.__ztState`（get/set `currentArchive`、`archiveStack`，get `tree`）。
- `shell/tabs.js` 在 main.js 之后加载（classic，非 module）。
- 标签条在无归档 tab 时整条隐藏；`[+ 打开归档]` 复用既有 `btn-open`。
- 嵌套钻取（`openArchive(path, true, pw)`）不建新 tab，归属当前 tab。
- busy 遮罩期间不切换 tab（遮罩天然拦截，不另加互斥）。
- 分支 `feat/archive-tabs` 基于 `fix/open-file-knock-delivery`（投递修复是前置）。

## Review Focus

1. **切 tab 状态串台**：expanded/selected/sort/query/scrollTop 必须随 tab 保存恢复——由快照/恢复单测钉住。
2. **嵌套钻取归属**：`keepStack=true` 的打开不得新建 tab、栈写入当前 tab——单测钉住。
3. **关闭激活 tab 后的落点**：关掉当前 tab 应激活相邻 tab 并恢复其视图；关最后一个回到拖放区——单测钉住。
4. **密码隔离**：每个 tab 的 password 独立保存/恢复，切换后对加密包操作仍用对密码——快照单测覆盖。
5. **构建补丁唯一性**：dist main.js 若被意外多改（升级上游后锚点漂移）必须构建即失败——build 测试钉住。

---

### Task 1: 构建补丁 + 状态出口（TDD）

**Files:**
- Modify: `scripts/build-web.mjs`（拷贝 main.js 后追加补丁步骤）
- Modify: `scripts/build-web.test.mjs`
- Modify: `README.md`（"上游一行没改"表述改为"快照只读 + 构建锚点补丁"）

**Interfaces:**
- Produces: dist `main.js` 含 `window.__ztState = { getCurrentArchive(), setCurrentArchive(v), getArchiveStack(), setArchiveStack(v), getTree() }`；锚点唯一。

- [ ] **Step 1: 写失败测试**（build-web.test.mjs）：断言 dist main.js = upstream 原文在锚点 `let createInputs = [];` 后恰好插入一段含 `__ztState` 的代码（前后拼接比对，其余零差异）；断言补丁幂等（重复构建不叠加）。
- [ ] **Step 2: 跑测试确认失败** — `npm test`，预期 FAIL（无 __ztState）。
- [ ] **Step 3: 实现** build-web.mjs：copyFile(main.js) 后读入 → 若已含 `__ztState` 则跳过（幂等）→ 在锚点行后插入补丁块（常量字符串 `MAIN_PATCH_SNIPPET`，注释标明设计稿出处）→ 写回 dist。
- [ ] **Step 4: 跑测试确认通过** — `npm test` 全绿；`npm run build:web` 后 `diff <(upstream 原文) dist/main.js` 仅一处插入。
- [ ] **Step 5: Commit** — `git commit -m "feat(build): main.js 状态出口锚点补丁"`；README 表述同步、并顺带修正 `shell/host-bridge.js` 中 push_open_file 旧注释（终审 P3）进同一提交。

### Task 2: 标签控制器纯逻辑（TDD）

**Files:**
- Create: `shell/tabs.js`（纯逻辑核心 + DOM 胶水；纯逻辑挂 `window.__ztTabsTest__`）
- Create: `scripts/tabs.test.mjs`（node:vm + 桩依赖，沿 host-bridge.test.mjs 模式）

**Interfaces:**
- Consumes: `__ztState`（Task 1）、main.js 全局函数（运行时包装在 Task 3 接线；本任务只做纯逻辑 + 依赖注入桩）。
- Produces（`window.__ztTabsTest__`）:
  - `createController(deps)` → `{ openTab(path, {keepStack, initialPassword}), snapshotActive(), activateTab(id), closeTab(id), tabs, activeId }`
  - deps 注入：`state`（即 `__ztState` 形状）、`render(info)`、`refresh(path, keepStack, initialPassword)`（= 原 openArchive）、`closeCurrent()`（= 原 closeArchive）、`switchViewOpen()`
  - 语义：openTab 同 path（精确匹配）→ 激活既有 tab 并调 `refresh`；新 path 且 `!keepStack` → 新建 tab 置为激活再 `refresh`；`keepStack=true` → 不建 tab，直接 `refresh`（栈归当前 tab）；snapshotActive 在 refresh 完成后由接线层调用，单测直接驱动；closeTab 移除并激活相邻 tab（无相邻 → 调 `closeCurrent()` 回拖放区）。

- [ ] **Step 1: 写失败测试**：upsert 同 path 激活既有；新 path 建新 tab 置激活；keepStack 不建 tab；closeTab 激活相邻 / 最后一个回落 closeCurrent；snapshotActive 保存 state+ui、activateTab 恢复 state+ui 并调 render；密码随 tab。
- [ ] **Step 2: 跑测试确认失败** — `node --test scripts/tabs.test.mjs`，预期 FAIL。
- [ ] **Step 3: 实现** shell/tabs.js 纯逻辑核心（deps 注入，无 DOM）。
- [ ] **Step 4: 跑测试确认通过** — `node --test scripts/tabs.test.mjs` PASS；`npm test` 全绿。
- [ ] **Step 5: Commit** — `git commit -m "feat(tabs): 标签注册表纯逻辑"`。

### Task 3: DOM 标签条 + 运行时接线

**Files:**
- Modify: `shell/tabs.js`（接线：包装三个全局函数、注入 strip DOM、frame ready 后自启）
- Modify: `shell/bridge.css`（标签条样式）
- Modify: `scripts/build-web.mjs`（dist index.html 注入 `tabs.js` script 标签于 main.js 之后）
- Modify: `scripts/build-web.test.mjs`（断言 tabs.js 装配顺序）

**Interfaces:**
- Consumes: Task 1 `__ztState`、Task 2 controller、main.js 全局函数（openArchive/closeArchive/renderArchive/switchView/flatten/renderRows/updateSelectionUi/busy）。

- [ ] **Step 1: 写失败测试**（build-web.test.mjs）：dist index.html 的 script 顺序 host-bridge.js → main.js → tabs.js。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：build 注入 script 标签；tabs.js 接线——
  - `renderArchive` 包装：`__ztCapturedInfo = info` 后调原函数；
  - `openArchive` 包装：controller.openTab(path, opts) → 原 `refresh` → `snapshotActive()`；
  - `closeArchive` 包装：controller.closeTab(activeId)；
  - strip DOM：`.topbar` 之下插入 `<div id="zt-tabstrip">`（含 `[+ 打开归档]` 按钮 = click `btn-open`、归档 tab 按钮 = basename(path)、`×` 关闭）；无归档 tab 时 `hidden`；
  - 激活 tab：switchView('open') → state 写入 → render(info) → ui 恢复 → 滚动恢复；
  - 离开 tab：snapshot expanded（`[...tree.expanded]`）/ sortBy / sortAsc / query / `$("tree").scrollTop`。
- [ ] **Step 4: 跑测试确认通过** — `npm test` 全绿。
- [ ] **Step 5: Commit** — `git commit -m "feat(tabs): 标签条 UI 与运行时接线"`。

### Task 4: 端到端验证 + 收尾

- [ ] **Step 1: 构建 + 安装** — `npm run build:web`，覆盖 `~/.otools/plugins/otools-ziplark/dist/`（先备份）。
- [ ] **Step 2: 场景验证**（与用户协同，stderr/UI 对照）：
  1. `open -a OTools a.zip` → 打开后出现标签条与 [a.zip]；
  2. `open -a OTools b.zip` → 新增 [b.zip] 并激活，a.zip tab 仍在，切回 [a.zip] 视图/滚动/勾选保持；
  3. 同路径重开 b.zip → 激活既有 tab（不重复）；
  4. 关闭 b.zip tab → 激活 a.zip；关闭最后一个 → 回拖放区；
  5. 嵌套包：钻取后切走再切回，栈与「⬅ 返回上层」保持；
  6. 面板窗口重复 1-2（面板内同样并存）。
- [ ] **Step 3: 验证记录**回填设计稿 §4；`git commit -m "docs: TABS 端到端验证记录"`。

## Execution Notes

- 分支 `feat/archive-tabs` 基于 `fix/open-file-knock-delivery`；执行方式沿用会话既定 Native。
- Task 1 的补丁块必须带设计稿出处注释，防止后续维护者误删。
