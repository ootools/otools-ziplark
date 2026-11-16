# 打开文件「敲门」投递失效修复设计

日期：2026-11-16。现象、根因、方案选型已在会话中确认（方案 C：双管齐下），本文是书面记录。
v2：补入 PANEL 场景验证结论（见 §2.2、§3B2）与投递语义修订（§3A 改为本地投递）。

## 1. 现象

- 插件已打开过一个压缩包（ziplark 标签/面板已存在）时，OS 再双击另一个压缩包**毫无反应**：
  无报错、无 busy、无 toast，宿主日志里连 `push_open_file` 都没有。
- 冷启动的**第一次**双击正常（走新开标签分支），但可能把同一个文件**打开两次/两处**
  （日志里连续多条 `list_archive`，面板与标签各开一份）。

## 2. 根因

### 2.1 敲门断点（主因）

投递链路（见 [file-associations.md](./file-associations.md) 第 3 节）的「敲门」环节断了：

```
宿主 otools_queue_file_delivery
  → app.emit_to(label, "otools-open-file", plugin_uuid)     // target 变成 AnyLabel{label}
  → 插件 webview 里宿主注入的 file-open 工厂监听器
      hostListen(...) 硬编码 target { kind: 'Any' }          // ← 断点
```

Tauri 2.10（`manager/mod.rs` `emit_to`/`filter_target`）对 `AnyLabel{label}` 目标只匹配
`Window/Webview/WebviewWindow/AnyLabel` 且 label 相同的监听器，其余走
`_ => target == candidate`——`{kind:'Any'}` 永远不等于 `AnyLabel{...}`，
所以**敲门永远无人接收**：consume 不触发、投递条目滞留队列、前端静默。

- 首开为何正常：`dispatchFileOpenTo` 的「新开标签」分支把文件塞进
  `?otoolsOpenFile=` URL 参数，加上 webview 启动期的一次 consume，两条兜底都不依赖敲门。
- 佐证：`docs/drag-and-drop.md` 早已记录同一语义（「SDK 默认 Any target 不匹配
  emit_to」，拖拽当时就是改用 `{kind:'Webview', label}` 修的）；受控复现
  （暖状态 `open` 第二个 zip → 全程零调用；重启宿主后面板启动期 consume 把滞留条目
  排出）与该解释完全一致。

### 2.2 PANEL / 多表面拓扑（验证结论）

同一插件可同时活在多个 webview：主窗标签（`tools-tab-*`）与面板窗口
（`panel-plugin-*`，panel/core.rs:778 同样注册进 `TOOLS_WEBVIEW_RUNTIME_BINDINGS`）。
由此确认三个事实：

1. **敲门目标包含面板**：`labels_for_plugin_runtime_binding` 返回该插件全部活动
   webview label，面板与标签都会被 emit_to。修复监听 target 后两者都能收到敲门、
   都会 consume（先到先得，后者拿空列表），**插件侧修复天然覆盖 PANEL**。
2. **事件是全局广播**：`listen.rs` 每插件只有一个 poller（引用计数），drain 一次
   dylib 队列后 `app.emit` 全局广播——**面板和标签会同时收到同一份**
   `ziplark-open-file`/progress 事件。open-file 事件被广播到几个 webview，就在几个
   表面各开一次。
3. **宿主路由没有 PANEL 分支**：`dispatchFileOpenTo` 只认 `pluginTabs`
   （面板 webview 不在其中），面板开着时 OS 双击会**冗余新开一个标签**，
   然后投递在面板/标签间靠 consume 竞速决定落点。

### 2.3 双开的三个向量

- **向量 1**：poll 事件全局广播（§2.2-2），一个文件在所有活着的表面各开一次；
- **向量 2**：`take_pending_file` 启动兜底——新开的 webview 启动时取走
  `pending_file`（单槽），把已在别处打开过的文件再开一次（复现 run2 的第 3 条
  `list_archive` 即此）；
- **向量 3**：URL 参数与启动期 consume 各投一次，SDK 3 秒去重窗口在宿主忙时失效。

## 3. 方案（C：双管齐下）

### 3A. 插件侧自救（本仓库，发插件更新即生效，覆盖宿主 0.9.8）

`shell/host-bridge.js`。核心语义修订：**consume 的胜者本地投递、直接打开，
不再经 push_open_file → poll 广播**。这一个改动同时消灭 §2.3 的三个双开向量
（无 push → 无广播、无 pending_file 残留、桥内去重收敛 URL/consume 重复）。

1. **knock 直连监听**：用 SDK `listenTauri('otools-open-file', onKnock,
   { target: { kind: 'Webview', label: webviewLabel() } })` 注册正确 target 的敲门监听
   （与拖拽修法同款；label 取 `__TAURI_INTERNALS__.metadata.currentWebview.label`，
   取不到时按拖拽的兜底策略补 Window/Any）。事件名常量从 `./sdk/index.js` 导入
   （`OTOOLS_FILE_DELIVER_EVENT`）。
2. **onKnock → consume**：`window.otools.invoke('otools_consume_open_files',
   { pluginUuid })`。wrapped invoke 会先试 native dylib（报 Unknown method）再按
   `unknown method` 标记回落宿主命令——已实测这条回落路可用。pluginUuid 取
   `__OToolsEnv.pluginUuid`，缺省时从 webview label 末段归一化（同宿主
   `normalizeRuntimePluginUuid` 规则）。
3. **统一投递出口 `deliverOpenPath(path)`**：5 秒滑动窗口去重后
   `emitLocal('ziplark-open-file', path)`（桥内本地事件，只打开**本** webview）。
   三个来源全部汇入它：SDK 工厂回调（URL 参数 + 启动期 consume）、knock 处理器。
   上游 UI 的 `listen('ziplark-open-file')` 处理器零改动。
4. **push_open_file / take_pending_file 退役**：投递路径不再调用 push_open_file
   （dylib 方法保留但闲置），`take_pending_file` 恒为空 → 上游启动钩子自然失效，
   向量 2 消失。progress 事件仍走原 poll 链路不受影响。
5. **多表面行为**：面板与标签都收到敲门、都会 consume，先到先得——恰好一个表面打开。
   落点确定性由 §3B2 的 targetLabel 路由保证；无 targetLabel 的旧宿主上偶发
   「开在面板而非标签」，可接受（比今天「哪儿都不开」严格更好）。

### 3B. 宿主侧根治（宿主仓库，随下版发布，惠及所有插件）

**B1. 监听 target 修复**：`src/platform/runtime/otools/index.ts` 的
`onOtoolsOpenFile` 接线处给 listen 传
`target: { kind: 'Webview', label: 当前 webview label }`（取
`__TAURI_INTERNALS__.metadata.currentWebview.label`，取不到时维持 `Any`）。
只动这一处接线；`file-open-factory.ts` 的 transport 增加可选 `target` 透传。
`scripts/sync-service-injection.mjs` 重新生成 `embedded-runtime.js`。
排查 keyword 工厂是否同样问题（若其敲门走全局 `emit` 则不受影响，不动）。
测试：`embedded-runtime.test.ts` / `api-parity.test.ts` 补 target 断言。

**B2. 面板感知路由**（PANEL 场景的确定性落点）：

- `dispatchFileOpenTo` 的 existingTab 分支把激活的标签 label 作为 `targetLabel`
  传给 `otools_queue_file_delivery`（当前投递不带 target、广播给所有 webview）；
  敲门只发给目标 webview，配合 3A 的先到先得，落点确定。
- 新增 PANEL 分支：插件 openMode 为 `panel` 且其面板 webview 活着时，
  **唤起面板并投递到面板 webview**（targetLabel = 面板 webview label），
  不再冗余新开标签；面板未开时维持现状（新开标签）。
  待确认的产品点见 §7。

## 4. 不做的

- 不改上游 `ui/`（保持「一行没改」原则）。
- 不改 dylib / ziplark-core（引擎按 path 无状态调用，问题不在引擎）。
- 不改宿主投递协议本体（`emit_to` 保留，修复在监听侧 target 与路由参数）。
- `tools_webview_join_path` 的 Unknown method 噪音是同类白名单问题的无害表现
  （有本地回退），顺手修属于另一件事，不混入本次。
- progress 事件的多表面广播维持现状（busyActive 门控已保证只有正在操作的
  表面显示进度；彻底的单表面进度路由留给 TABS 设计）。

## 5. 验证

1. 标签场景：`open a.zip`（首开）→ `open b.zip`（暖开，之前静默）→
   stderr 应出现第二次 consume/push 痕迹与 `list_archive`，UI 显示 b 归档。
2. 面板场景：关键字进面板（面板 webview 活着、无标签）→ `open b.zip` →
   （B2 后）面板唤起并显示 b 归档，**不**新开标签；
   （仅 3A 时）面板或标签之一打开，无重复。
3. 双开向量：重启宿主 + `open a.zip` → 全程恰好一次 `list_archive`；
   面板与标签并存时打开文件 → 恰好一个表面切换。
4. 宿主侧修复合入后回归 1–3，并跑宿主相关单测。

## 6. 留给实现者

- bridge 内去重窗口时长与清刷节奏（初值 5s / 每次投递顺带清理）。
- B2 中「面板 webview 活着」的判定与 label 获取方式
  （`panel-plugin-*` 前缀 or panel 模块的注册表查询）。
- 宿主侧测试落点与 embedded-runtime 再生产物的 diff 审查。
- 面板/标签并存时 poll_events 单队列竞争消费的既有行为
  （本次不处理，TABS 设计时一并考虑）。

## 7. 已确认的产品点

面板 openMode 插件、面板已开、无标签时，OS 双击的落点：**面板优先**（已拍板，
2026-11-16）——唤起面板并把文件投递到面板 webview，不新开标签。理由：尊重插件
声明的 openMode，与启动器类交互一致。面板未开时维持现状（新开标签）。

## 8. 后续：TABS（独立大工程，另出设计）

修复落地后，「再开一个压缩包」恢复为替换式打开。多标签并行查看是独立功能：
移植层加标签栏，每个归档一个独立上游 UI 实例（iframe 隔离 currentArchive/
tree/选择/密码等全局状态），上游保持一行不改。TABS 在插件 UI 层实现，
**面板与标签两个表面天然通用**；涉及 poll_events 共享队列、打开投递路由到
新标签、busy/cancel 全局标志等设计点，另出设计文档评审。
