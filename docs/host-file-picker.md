# 为什么 PANEL 里打开 OS 原生文件选择器会「闪一下就没了」，之后再打不开

> 结论先行：**不是权限问题，也不是选择器单例缓存**。是 `blocking` picker 把 sheet 挂到
> 「非激活 NSPanel + Accessory 应用」上，而面板的「失焦自动隐藏」把 sheet 的父窗口关掉了；
> 一次失败还会把 AppKit 的进程级 modal / 激活状态打乱，于是后续每次调用都在同一个坏条件下秒退。
>
> 以下路径均相对宿主仓库 `ootools/OTools`（Tauri 2.10 / tauri-runtime-wry 2.10 / rfd 0.16 / tauri-plugin-dialog 2.x）。

## 1. 所有的宿主 picker 都是 blocking，且带 parent

| 位置 | 行为 |
| --- | --- |
| `crates/ot-platform-core/src/webview_fs/core.rs:376-395, 445-460, 490-499` | `app_handle.dialog().file().blocking_pick_files/pick_file/save_file/pick_folder()` |
| `src-tauri/src/builtin_plugin_handlers.rs:61-65` | 把上面这些注册成 `tools_webview_pick_folder` / `pick_files` / `pick_save_path` |
| `crates/ot-platform-core/src/webview_fs/transport.rs:9-41` | transport → service → core 的转发 |
| `src-tauri/src/platform/webview/preload.js:808, 956` | `dialogApi.open` 的回退链 |
| `src/platform/runtime/otools/index.ts:268-296, 325-331` | 先 `plugin:dialog\|open`，失败再回落宿主命令 |
| `src-tauri/src/lib.rs:928` | 注册 tauri-plugin-dialog |

`plugin:dialog|open` 本身（`tauri-plugin-dialog/src/commands.rs:123-131, 159-206`）同样用
`blocking_pick_*`，并且 **`set_parent(&window)`**。

这些命令是 `async fn`，跑在 tokio 工作线程；rfd 再通过 `dispatch2::run_on_main` 同步阻塞主线程
（`rfd/src/backend/macos/utils.rs:20-31`）。macOS 实现
（`rfd/src/backend/macos/file_dialog/panel_ffi.rs:66-76`）是：

```
beginSheetModalForWindow(parent)   // 把 picker 挂成父窗口的 sheet
runModal()                        // 又无条件开一次独立模态（双重模态）
```

## 2. PANEL 窗口恰好是最不适合当 sheet host 的那种窗口

| 位置 | 行为 |
| --- | --- |
| `src-tauri/src/platform/panel/core.rs:27, 284-325` | label `otools-panel`；`decorations(false)` / `always_on_top(true)` / `skip_taskbar(true)` / `focused(false)` / `visible(false)` |
| `src-tauri/src/platform/panel/core.rs:835-874` | 插件页是 `add_child` 子 webview（`panel-plugin-*`），创建即 `hide()` |
| `src-tauri/src/platform/panel/ns_panel.rs:66, 74-76` | 换类为 `OtoolsOverlayPanel`（NSPanel）并加 `NSWindowStyleMaskNonactivatingPanel` |
| `src-tauri/src/platform/panel/ns_panel.rs:126`、`core.rs:561-579` | 显示用 `makeKeyAndOrderFront`，注释明确「不激活宿主」 |
| `src-tauri/src/platform/panel/focus.rs:119-188` → `core.rs:590-606` | **失焦自动隐藏面板** |
| `src-tauri/src/lib.rs:1014-1017` | setup 把 activation policy 设为 `Accessory` |
| `src-tauri/src/lib.rs:presentation.rs:36-52, 85-93` | `otools-panel` / `panel-plugin-*` / `main` 被排除出「可见独立窗口」，所以只剩面板可见时应用保持 Accessory（无 Dock、非 active app） |

rfd 的 `policy_manager.rs:15-18` **只在 `Prohibited` 时**临时把策略升到 `Accessory`；
对已经是 `Accessory` 的应用不做任何提升（`MACOS_USE_PROHIBITED_ACTIVATION=false`，
见 `src-tauri/src/lib.rs:38`，故 `Prohibited` 分支 `:1203` 未启用）。

## 3. 完整的失败链

1. 插件调用 `dialog.open()` → blocking picker 以 sheet 挂到 `otools-panel` 这个
   **NonactivatingPanel** 上。
2. picker 弹出本身让面板失焦；`focus.rs:180-186` 的 debounce 触发 `hide_panel_window`，
   **sheet 的父窗口被隐藏**。
3. `beginSheetModalForWindow` 的 host 消失 → sheet 立即 dismiss；紧接着那个无条件的
   `runModal()` 秒返回非 OK，宿主按「用户取消」记录（`core.rs:389, 499` 的 `canceled`）。
   ⇒ **视觉上就是「闪一下就没了」**。
4. 收尾时 `PolicyManager::drop`（rfd `policy_manager.rs:27-31`）复位 Accessory，
   `FocusManager::drop`（rfd `focus_manager.rs:18-23`）对已经隐藏的窗口再
   `makeKeyAndOrderFront`。这两步把 AppKit 的**进程级** modal/激活状态拧乱。
5. 之后每次调用都仍然处在「Accessory + 无 key window + 非激活 NSPanel」的同一组条件下，
   于是同样秒退 ⇒ **「再也无法打开任何 OS 文件选择器」**。

补充：`core.rs:376/445/490` 每次都新建 builder，rfd `file_dialog.rs:22,36,102,180`
每次都新建 `NSOpenPanel`，**没有单例缓存**；`PANEL_SHOW_STATE`(`core.rs:531`) 和
`FOCUS_STATE`(`focus.rs:18`) 只是显隐状态机。`src-tauri/capabilities/default.json:16-24, 52`
已含 `dialog:default` 且 windows 覆盖 `otools-panel` / `panel-plugin-*`，**权限也排除**。

## 4. 修复 / 规避方向

按代价从低到高：

1. **插件侧彻底不弹 OS picker**（本插件采用）：用宿主 SDK 的
   `pickFromHostTree`（`vendor/otools-plugin-sdk/src/host-file-tree.ts:111`）——页面内 DOM 树，
   数据来自 `tools_webview_browse_dialog`（`crates/ot-platform-core/src/webview_fs/core.rs:781-803`）。
   宿主 `dialog.open` 的回退链最后也会落到 `window.__otoolsHostTree`。
2. 弹框期间暂停面板失焦隐藏（给 `focus.rs` 加一个「picker 进行中」保护 / `set_pinned(true)`）。
3. 去掉 `set_parent` / 传 `parent = nil`，只保留独立 `NSOpenPanel runModal`。
4. 弹框前临时 `setActivationPolicy(Regular)` + `activate`（rfd 只兜了 Prohibited，没兜 Accessory）。
5. 改非 blocking 的 `pick_file_async` 并显式 `run_on_main_thread`，避免双重模态与阻塞主线程。

## 5. 本插件的做法

`shell/dialogs.js` 只调用 `otools-plugin-sdk` 的 `pickFromHostTree`：

* `dialog.open({multiple,directory,title,filters})` → SDK 树，返回 string / string[] / null；
* `dialog.save({title,defaultPath})` → SDK 树选目录 + 一个只问**文件名**的小输入框 +
  宿主 `tools_webview_join_path`；**不自己实现文件树**；
* `shell/sdk-shims/plugin-dialog.js` 把 SDK 内部可能触达的 `@tauri-apps/plugin-dialog`
  也导回宿主桥，保证任何路径都不会落到 OS picker。

这与 `otools-zitext` 0.1.2 的结论一致（选择器改纯页面内 DOM 树、并直接复用 SDK，别自己写树）。
