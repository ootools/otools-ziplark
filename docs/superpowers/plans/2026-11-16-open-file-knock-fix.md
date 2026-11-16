# 打开文件敲门投递修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「插件已开一个归档后，OS 再双击第二个归档无反应」，并消除多表面双开。

**Architecture:** 插件侧（Phase A）在 host-bridge.js 里用正确 target 注册敲门直连监听、consume 后本地投递（退役 push_open_file 广播链）；宿主侧（Phase B）修注入工厂的监听 target（B1）并给文件路由补 targetLabel 精确投递与 PANEL 分支（B2）。设计稿：`docs/open-file-knock-fix.md`（v2，含根因证据链）。

**Tech Stack:** 插件：原生 JS（classic script）+ node:test/vm；宿主：Tauri 2.10 (Rust) + Vue 3 + TS；Tauri 事件 target 语义见设计稿 §2.1。

**Spec:** `docs/open-file-knock-fix.md`（otools-ziplark 仓库）

## Global Constraints

- 上游 `upstream/ui/` 一行不改；dylib（`native/`）不改。
- 插件 `dist/` 由 `npm run build:web` 从 `shell/` + `upstream/ui` 原样拷贝生成，不手改 dist。
- 投递去重窗口 5s（设计稿 §3A-4）；只允许 time-window 去重，不做复杂会话。
- 敲门事件名固定为 `otools-open-file`；consume 命令 `otools_consume_open_files`（args 只传 `pluginUuid`，targetLabel 由 Rust 侧按调用 webview label 匹配）。
- 监听 target 一律 `{ kind: 'Webview', label }`，label 取不到时退回 `{ kind: 'Any' }`（不发明新 kind）。
- 宿主面板落点：面板 openMode 插件、面板 webview 活着、无标签 → 面板优先（已拍板）。
- 宿主仓库工作前先 `git -C <host-repo> status` 确认干净；不在别人的未提交改动上叠改。

## Review Focus

1. **同一文件 5 秒内二次投递**（用户刻意重开）：应被去重忽略，UI 保持当前显示——由 Task 2 的去重测试钉住。
2. **label 缺失的宿主**（老宿主 / 非标准 webview）：knock 监听必须退回 `{kind:'Any'}` 注册而不是抛错——Task 2 测试钉住。
3. **consume 返回空/抛错**（另一表面抢先、宿主忙）：必须静默返回且不影响既有监听，不 toast——Task 2 测试钉住。
4. **面板与标签并存**：恰一个表面打开文件——Task 3 E2E + Task 5 路由测试钉住。
5. **URL 参数与启动 consume 竞速**（宿主忙时 >3s）：不产生第二次打开——Task 2 去重测试 + Task 3 E2E 钉住。

---

## Phase A：插件侧（仓库 `xyito/otools/otools-ziplark`）

### Task 1: 桥内纯逻辑 + 测试钩子（TDD）

**Files:**
- Modify: `shell/host-bridge.js`（classic script，顶部 IIFE 内）
- Create: `scripts/host-bridge.test.mjs`

**Interfaces:**
- Produces（挂到 `window.__ZIPLARK_TEST__`，Task 2 复用）:
  - `normalizePluginUuidFromLabel(label: string): string` — 末段归一化：`tools-tab-plugin-market:otools-ziplark` → `otools-ziplark`；已知 source 前缀 `builtin|market|dev-debug|dev-workspace` 取末段，其余原样返回。
  - `resolvePluginUuid(): string` — 优先 `window.__OToolsEnv.pluginUuid`（trim 后非空），否则 `normalizePluginUuidFromLabel(webviewLabel())`；均无 → `''`。
  - `deliverOpenPath(path: string): void` — trim 空串直接返回；5s 滑动窗口去重（`recentDeliveries: Map<string, number>`，每次调用顺带清理过期项）后 `emitLocal('ziplark-open-file', path)`。
  - `recentDeliveries`（Map，测试直接操纵做时间推进）。
  - `consumeOpenFiles(): Promise<void>` — Task 2 实现后挂入。

- [ ] **Step 1: 写失败测试** `scripts/host-bridge.test.mjs`：node:test + `node:vm`，`runInNewContext(source, sandbox)` 加载 `shell/host-bridge.js`（sandbox 提供 `window`（自引用）、`console`；脚本顶层只写 `window.__TAURI__`/`__ZIPLARK_HOST__`/`__ZIPLARK_TEST__`，不需要 document）。断言：(a) 无 env、label=`tools-tab-plugin-market:otools-ziplark` 时 `resolvePluginUuid()==='otools-ziplark'`；(b) 有 `__OToolsEnv.pluginUuid` 时优先取 env；(c) `deliverOpenPath` 注册监听后首调触发一次 `ziplark-open-file`，5s 内二调不触发，删掉 `recentDeliveries` 键后再调触发第二次；(d) 空串不触发。
- [ ] **Step 2: 跑测试确认失败** — `node --test scripts/host-bridge.test.mjs`，预期 FAIL（`__ZIPLARK_TEST__` 不存在）。
- [ ] **Step 3: 实现** 三段纯逻辑 + 挂 `window.__ZIPLARK_TEST__`（现 IIFE 末尾，挨着 `window.__ZIPLARK_HOST__`）。`webviewLabel()` 已存在，复用。
- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令，预期 PASS；`npm test` 全绿。
- [ ] **Step 5: Commit** — `git add shell/host-bridge.js scripts/host-bridge.test.mjs && git commit -m "feat(bridge): 敲门投递纯逻辑 + vm 测试钩子"`（本 Task 尚未改行为，dist 不重建）。

### Task 2: 敲门直连监听 + 本地投递接线

**Files:**
- Modify: `shell/host-bridge.js`（`startOpenFileDelivery`、`ensureSubscriptions`、新增 `startKnockListener`/`consumeOpenFiles`）
- Modify: `scripts/host-bridge.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `deliverOpenPath`/`resolvePluginUuid`/`recentDeliveries`。
- Produces: 行为变更——所有投递终点统一为 `emitLocal('ziplark-open-file', path)`；`push_open_file` 不再被调用。

- [ ] **Step 1: 写失败测试**：(a) `consumeOpenFiles` 在 `window.otools.invoke` 返回 `['/a.zip','/b.zip']` 时对每个 path 触发一次本地事件、返回空数组时零触发、invoke 抛错时零触发且不抛；(b) `deliverOpenPath` 不再调用 `invokeNative('push_open_file')`（sandbox 的 `otools.invokeNative` 计数为 0）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：
  - `consumeOpenFiles()`：`api.invoke('otools_consume_open_files', { pluginUuid: resolvePluginUuid() })`（wrapped invoke，native Unknown method 自动回落宿主——设计稿 §3A-2）；`Array.isArray(result)` 逐个 `deliverOpenPath`；catch 只 `log`。
  - `startKnockListener()`：`import('./sdk/runtime.js')` 取 `listenTauri`，对 `webviewLabel()` 非空注册 `{kind:'Webview', label}`（同拖拽兜底策略补 `Window`/`Any`，见 shell/host-bridge.js `startDragEvents` 现有写法），handler = `void consumeOpenFiles()`，事件名 `'otools-open-file'`（注释标注与 SDK `OTOOLS_FILE_DELIVER_EVENT` 对齐）。
  - `startOpenFileDelivery` 的 SDK 回调改为 `deliverOpenPath(file.path)`；`ensureSubscriptions` 追加 `startKnockListener()`。
  - `invoke('take_pending_file')` 拦截保持不动（防未来误用，`pending_file` 恒空后自然失效）。
- [ ] **Step 4: 跑测试确认通过** + `npm test` 全绿。
- [ ] **Step 5: Commit** — `git commit -am "fix(bridge): 敲门直连监听 + consume 本地投递，修第二次打开无反应"`。

### Task 3: 构建、本机安装、端到端验证

**Files:**
- Rebuild: `dist/`（`npm run build:web`）
- Install target: `~/.otools/plugins/otools-ziplark/dist/host-bridge.js`（平铺目录，宿主直接 serve）

- [ ] **Step 1: 构建** — `npm run build:web`；`diff shell/host-bridge.js dist/host-bridge.js` 为空。
- [ ] **Step 2: 安装** — `cp ~/.otools/plugins/otools-ziplark/dist/host-bridge.js /tmp/host-bridge.js.bak` 后覆盖为新构建产物（dylib/lib、plugin.json 不动）。
- [ ] **Step 3: 标签场景 E2E** — `osascript quit` 宿主 → 终端拉起 `/Applications/OTools.app/Contents/MacOS/OTools > /tmp/zk-stdout.log 2> /tmp/zk-stderr.log &` → `open /tmp/ziplark-repro/a.zip`（等 4s）→ `open /tmp/ziplark-repro/b.zip`（等 4s）。预期（stderr）：第二次打开出现 `otools_consume_open_files` + 新的 `list_archive`，且 `push_open_file` 不再出现（已退役）；UI 显示 b 归档。若第二次仍无 `list_archive`：按系统化调试回到取证阶段，禁止叠改。
- [ ] **Step 4: 双取向量 E2E** — 重启宿主 → `open a.zip` → 计数 `list_archive` 恰好 1 次（stderr + UI 单次打开）。
- [ ] **Step 5: 面板场景 E2E（仅 3A 范围）** — 关键字进 ziplark 面板（需要用户配合一次）→ `open b.zip` → 恰一个表面显示 b 归档。B2 未实现时允许「落点不确定」，只验证「不再静默、无重复」。
- [ ] **Step 6: 结果记录** — 把三条 E2E 的 stderr 关键行追加到设计稿 §5 下方作验证记录；`git commit -m "docs: 敲门修复 E2E 验证记录"`（仅文档变更）。

## Phase B：宿主侧（仓库 `xyito/otools/otools`，分支上做，发版由用户定）

### Task 4: B1 — 注入工厂监听 target 修复

**Files:**
- Modify: `src/platform/runtime/otools/index.ts`（`onOtoolsOpenFile` 接线，~line 441）
- Modify: `src/platform/runtime/otools/embedded-runtime.js`（脚本再生成，不手改）
- Test: `src/platform/runtime/otools/embedded-runtime.test.ts`（先读，跟随其既有断言模式）

**Interfaces:**
- Produces: `resolveWebviewEventTarget(): HostEventTarget` — 取 `window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label`，非空返回 `{kind:'Webview', label}`，否则 `{kind:'Any'}`；`onOtoolsOpenFile` 与（若 Task 5 判定需要）keyword 工厂共用。

- [ ] **Step 1: 读 `embedded-runtime.test.ts` 与 `api-parity.test.ts`**，确定断言写法（内容级 parity or 行为级）。
- [ ] **Step 2: 写失败测试**：断言 embedded-runtime 的 `onOtoolsOpenFile` 接线携带 Webview target 解析（含 label 缺省回退 Any 的分支）；行为级则用 vm 桩 `__TAURI_INTERNALS__.metadata` 后捕获 `plugin:event|listen` 的 target 参数。
- [ ] **Step 3: 实现** `index.ts`：新增 `resolveWebviewEventTarget()`；`onOtoolsOpenFile: createFileOpenListener({ invoke, listen: (event, handler) => hostListen(event, handler, { includeAncestors: true, target: resolveWebviewEventTarget() }) })`。工厂文件本身零改动（transport 闭包携带 target）。
- [ ] **Step 4: 再生成** — 找到并运行 `scripts/sync-service-injection.mjs`（若参数不同按其 README），`git diff` 审查 embedded-runtime.js 只含预期变更。
- [ ] **Step 5: 跑宿主运行时测试** — 按 `package.json` 的 test 脚本跑 otools 运行时相关测试，全绿。
- [ ] **Step 6: keyword 工厂排查** — 查宿主 keyword 敲门的 emit 方式（`emit` 全局 or `emit_to`）：全局则跳过；`emit_to` 则把同一 target helper 套到 `onOtoolsKeyword` 接线并补断言。
- [ ] **Step 7: Commit** — `git commit -m "fix(runtime): 文件投递敲门监听改用 Webview target"`。

### Task 5: B2 — 路由 targetLabel + PANEL 分支

**Files:**
- Modify: `src/platform/ui/tools/Tools.vue`（`dispatchFileOpenTo` ~line 2459、`dispatchFileOpenPaths`）
- Modify/Create: `src-tauri/src/platform/panel/`（查询面板 webview label 的命令，若 Step 1 发现无现成命令）
- Test: `src/platform/ui/tools/fileOpenRouting.test.ts`（先读，跟随既有模式）；Rust 侧测试跟随 `src-tauri/src/platform/file_open.rs` 测试模式

**Interfaces:**
- Consumes: `otools_queue_file_delivery` 已有 `target_label` 参数（Rust 侧已校验归属，无需改）。
- Produces: `dispatchFileOpenTo` 三个分支全部带确定落点——existingTab → 该标签 webview label；panel 活着 → 面板 webview label；新开标签 → 新标签 label（`onOpened` 或确定性 label 构造器）。

- [ ] **Step 1: 盘点**——读 `fileOpenRouting.ts`/test、`addPluginTab` 签名（有无 `onOpened(label)`）、tab→webview label 的构造函数、面板 label 的现成查询命令；把四项结论写进本 Task 的 PR 描述。
- [ ] **Step 2: 写失败测试**（fileOpenRouting.test.ts 模式）：(a) existingTab 分支 queueFileDelivery 收到 targetLabel；(b) 面板活着 + 面板模式 → 调 `request_panel_open_plugin` + 带 targetLabel 投递、不 addPluginTab；(c) 面板未开 → 维持新开标签；(d) 新开标签分支带 targetLabel。
- [ ] **Step 3: 实现前端**：按 Step 1 盘点结果改 `dispatchFileOpenTo`；面板「活着」的判定用 Step 1 确认的命令（无则先做 Rust 命令）。面板模式判定：effective open mode（复用深链路由的 mode 解析），不用 manifest 原始字段。
- [ ] **Step 4: （若无现成命令）实现 Rust 查询** `panel_plugin_webview_label(plugin_uuid) -> Option<String>`：查 `TOOLS_WEBVIEW_RUNTIME_BINDINGS` 中 `panel-plugin-` 前缀且 uuid 匹配的 label；跟随 file_open.rs 测试风格补单测。
- [ ] **Step 5: 跑测试** — 前端路由测试 + Rust 单测全绿。
- [ ] **Step 6: Commit** — `git commit -m "feat(tools): 文件打开按表面精确投递，panel 插件面板优先"`。

### Task 6: 宿主端到端回归（dev 运行）

- [ ] **Step 1: 按 `RUNNING.md` dev 启动宿主**（源码跑，插件指到本机安装版）。
- [ ] **Step 2: 复跑 Task 3 的三条 E2E**（标签 / 双开 / 面板优先），面板场景此时应「面板唤起 + 不新开标签」。
- [ ] **Step 3: 结果回填设计稿 §5**，commit 文档。

## Execution Notes

- Phase A 与 Phase B 相互独立、可分别交付；Phase A 完成即解决用户当前 0.9.8 上的静默 bug。
- 两个仓库分开提交；宿主仓库发版节奏由用户掌握。
- E2E 涉及用户桌面环境（开关宿主、进面板），执行时与用户协同确认 UI 观感。
