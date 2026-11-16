# PANEL 里打开 OS 文件选择器「闪一下就没了」的根因与宿主修复

> 结论先行：**不是权限问题，也不是选择器单例缓存**。根因是 `otools-panel` 的
> 「失焦自动隐藏」把 picker 这张 sheet 的父窗口关掉了。宿主侧的修复分两层：
>
> 1. **根本修复**：PANEL 在原生对话框会话期间 **hold 不隐藏**，会话结束后再恢复自动隐藏；
> 2. **消除双重模态**：把宿主的三个 `tools_webview_pick_*` 从 `blocking_pick_*`
>    改成非阻塞的 **async sheet**——只 `beginSheetModalForWindow`，不 `runModal()`，
>    不阻塞主线程；**parent 保留**，sheet 的原生观感不变。
>
> 「把 picker 改成无 parent 的独立窗口」只是绕过症状，且会改变交互形态，**没有采用**。
>
> 以下路径均相对宿主仓库 `ootools/OTools`（Tauri 2.9 / tauri-plugin-dialog 2.6.0 / rfd 0.16.0）。
> 行号会随版本漂移，以下按「文件 + 符号」定位。

## 1. 底层调用链（源码证据）

| 位置 | 行为 |
| --- | --- |
| `tauri-plugin-dialog/src/commands.rs::open/save` | 命令虽是 `async fn`，内部仍调 `blocking_pick_file(s)` / `blocking_save_file`，并在 macOS/Windows 上 `set_parent(&window)` |
| `tauri-plugin-dialog/src/lib.rs::FileDialogBuilder::blocking_pick_*` | 文档明确「blocking，不能在用主线程调用」 |
| `rfd/src/backend/macos/file_dialog/panel_ffi.rs::Panel::run_modal` | 有 parent 时先 `beginSheetModalForWindow_completionHandler`，**随后无条件 `runModal()`** —— sheet + 嵌套独立模态，双重模态 |
| `rfd/src/backend/macos/file_dialog/panel_ffi.rs::InnerModal for NSSavePanel` | `begin_modal` 只做 `beginSheetModalForWindow_completionHandler`；`run_modal` 才做 `runModal()` |
| `rfd/src/backend/macos/modal_future.rs::ModalFuture::new` | `app.isRunning() && win.is_some()` 时走 `inner.begin_modal(...)`，**不调 `run_modal`**；结果经 completion block 唤醒 future |
| `tauri-plugin-dialog/src/desktop.rs::pick_file/pick_files/pick_folder/save_file` | 公开的 callback API 把 `FileDialogBuilder` 转成 `rfd::AsyncFileDialog`（保留 `d.parent`），在 `run_on_main_thread` 里启动，另起线程 `block_on` |
| `crates/ot-platform-core/src/webview_fs/core.rs::tools_webview_pick_*` | 宿主三个 picker 命令（修复后走上面的 callback API） |
| `src-tauri/src/builtin_plugin_handlers.rs` | 把三个命令注册进 `generate_handler!` |
| `src-tauri/src/platform/panel/focus.rs` / `focus_state.rs` | 面板失焦自动隐藏状态机 |

也就是说：`plugin:dialog|open` 这条命令**不是** async sheet。要用真正的 async sheet，必须走
`FileDialogBuilder.pick_*` callback / `AsyncFileDialog`，而不是命令本身。

## 2. PANEL 为什么是最不适合当 sheet host 的窗口

| 位置 | 行为 |
| --- | --- |
| `src-tauri/src/platform/panel/core.rs` | label `otools-panel`，无边框 / 置顶 / 不抢焦点 |
| `src-tauri/src/platform/panel/ns_panel.rs` | 换类为 `NSPanel` 子类并加 `NSWindowStyleMaskNonactivatingPanel` |
| `src-tauri/src/platform/panel/core.rs` | 插件页是 `add_child` 子 webview（`panel-plugin-*`） |
| `src-tauri/src/platform/panel/focus.rs::check_blur_on_main` → `core.rs::hide_panel_window` | **失焦自动隐藏面板** |
| `src-tauri/src/lib.rs` setup | activation policy = `Accessory`（无 Dock、非 active app） |

> ⚠️ 一处需要更正的旧结论：之前把「之后再打不开」归因于 rfd
> `policy_manager.rs` 复位 activation policy 打乱 AppKit 模态状态，**这个说法不严谨**。
> `PolicyManager::new` 只在 `initial_policy == Prohibited` 时才临时升到 `Accessory`；
> 对本应用（已是 `Accessory`）没有任何提升，`Drop` 时 `setActivationPolicy(Accessory)`
> 相当于写回同一个值。`FocusManager::Drop` 只是把之前的 key window
> `makeKeyAndOrderFront`，也不是进程级模态开关。
> 真正让后续调用继续失败的是「blocking sheet + `runModal()` 双重模态」在父窗口被强行隐藏
> 后留下的不一致状态，以及每次调用都重新落进同一组条件；不是 activation policy 被复位。

## 3. 完整失败链（修复前）

1. 插件调 `dialog.open()` → blocking picker 以 sheet 挂到 `otools-panel`（NonactivatingPanel）。
2. picker 弹出让面板失焦 → 180ms debounce 后 `hide_panel_window`，**sheet 父窗口被隐藏**。
3. sheet 立即 dismiss；那个额外的 `runModal()` 秒返回非 OK，宿主按「用户取消」记录。
   ⇒ 视觉上「闪一下就没了」。
4. 双重模态会话在父窗口已隐藏的情况下收尾，嵌套 modal loop 与面板显隐状态不一致；
   后续每次调用仍落在「Accessory + 无 key window + 非激活 NSPanel + blocking sheet」的
   同一组条件里，于是继续秒退 ⇒ **「再也无法打开任何 OS 文件选择器」**。

补充排除项：宿主每次都新建 builder、rfd 每次都新建 `NSOpenPanel`，**没有单例缓存**；
`capabilities/default.json` 已含 `dialog:default` 且 window 覆盖 `otools-panel` / `panel-plugin-*`，
**权限也排除**。

## 4. 宿主侧最终修复（OTools 主仓）

保留 sheet，保留 parent，只修「面板被关掉」和「双重模态」这两件事。

### 4.1 PANEL hold（根本修复）

* `crates/ot-platform-core/src/webview_fs/dialog_guard.rs`
  * `ACTIVE_DIALOGS` 全局计数 + `NativeDialogGuard` RAII；
  * `NativeDialogSession<T>` 把 guard 和 `oneshot::Sender<T>` 绑在一起：`begin_dialog()`
    在**发起 sheet 之前**就置位，`finish()` 由 sheet 的 completion callback 调用，
    投递结果后才释放 guard。护栏覆盖整个会话，而不是一次同步函数调用。
* `src-tauri/src/platform/panel/focus_state.rs::check_with_hold`
  * 会话期间失焦决策返回 `Wait` 而不是 `Hide`；长会话也不会隐藏面板。
* `src-tauri/src/platform/panel/focus.rs::check_blur_on_main`
  * hold 期间每次检查都 `protect()` 刷新保护窗口，dialog 关闭后留 600ms 缓冲；
  * macOS 额外查 `NSApplication.modalWindow`，用于覆盖**第三方直接调
    `plugin:dialog|open`** 的 blocking 会话。注意 sheet 不是进程模态，
    `modalWindow` 对宿主自己的 async sheet 是 nil，所以宿主会话必须靠
    `native_dialog_active()` 计数。

### 4.2 async sheet（消除双重模态）

* `crates/ot-platform-core/src/webview_fs/core.rs::tools_webview_pick_files /
  pick_save_path / pick_folder`
  * 三个 `blocking_pick_*` 全部换成 `dialog.pick_files/pick_file/save_file/pick_folder`
    的 callback API + `await_dialog(receiver)`；
  * 命令多接一个 `window: Window`，`with_dialog_parent()` 在 macOS/Windows 上
    `set_parent(&window)` —— **sheet 挂回调用窗口**（子 webview 场景就是 `otools-panel`）；
  * rfd 走 `ModalFuture` → 只 `begin_modal`（`beginSheetModalForWindow`），
    不 `runModal()`；主线程事件循环不被阻塞，也不会出现 sheet 与嵌套 modal 叠在一起。
* `src/platform/runtime/otools/index.ts` 与 `embedded-runtime.js`
  * `window.otools.dialog.open/save` 优先宿主命令（现在就是 async sheet），
    只在命令真正抛错时回落 `plugin:dialog|open`；用户取消（`null`）不回落，避免二次弹框。
    注入运行时仍保留 `window.__otoolsHostTree` 的远程 Web 模式兜底。
  * 旧版本里「宿主命令无 parent、用来绕开 sheet」的说明已作废。

### 4.3 单元测试覆盖

* `dialog_guard.rs`：会话计数、guard 从 begin 持有到 callback、`callback` 被丢弃时
  hold 释放且命令报错；
* `panel::focus_state`：hold 期间不隐藏、释放后恢复自动隐藏；
* `embedded-runtime.test.ts`（9 例）：宿主 picker 优先、抛错才回落、取消不二次弹框、save 同理。

> 单测只覆盖状态机与调用顺序，**不覆盖 AppKit 真实行为**。仍需 macOS 真机验证：
> 打开 / 取消 / 再打开、PANEL 失焦与恢复、第三方直接调 `plugin:dialog|open`、
> 多个 picker 连续调用。

## 5. 为什么没有采用「去掉 parent」

按代价从低到高，曾经评估过的方向：

| 方向 | 结论 |
| --- | --- |
| 插件侧不弹 OS picker，用 SDK 页面内文件树 | ✅ 本插件采用（见第 6 节） |
| 弹框期间暂停面板失焦隐藏（PANEL hold） | ✅ **根本修复**，已实施 |
| 去掉 `set_parent` / 独立 `NSOpenPanel runModal` | ❌ 只是绕过症状，且把 sheet 变成独立窗口，交互形态变了；已撤回 |
| 弹框前临时 `setActivationPolicy(Regular)` + `activate` | ❌ 无必要，基于已更正的错误归因 |
| 改非阻塞 `pick_file_async` | ✅ 已实施（4.2） |

## 6. 本插件的做法

`shell/dialogs.js` 只调用 `otools-plugin-sdk` 的 `pickFromHostTree`（页面内 DOM 树，
数据来自 `tools_webview_browse_dialog`）：

* `dialog.open({multiple,directory,title,filters})` → SDK 树，返回 string / string[] / null；
* `dialog.save({title,defaultPath})` → SDK 树选目录 + 一个只问**文件名**的小输入框 +
  宿主 `tools_webview_join_path`；**不自己实现文件树**；
* `shell/sdk-shims/plugin-dialog.js` 把 SDK 内部可能触达的 `@tauri-apps/plugin-dialog`
  也导回宿主桥，保证任何路径都不会落到 OS picker。

这样不依赖宿主版本、远程 Web 模式也能用。与 `otools-zitext` 0.1.2 的结论一致：
选择器改纯页面内 DOM 树、直接复用 SDK，别自己写树。

> 附注：主仓 `vendor/tauri-remote-service/src/host.rs` 里的 Web 模式 dialog handler
> 仍是 `blocking_pick_*`（无 parent）。那是服务端进程、远程浏览器本来就看不到服务器上的
> 原生框，且不涉及 PANEL，属于另一条链路，不在本次修复范围内。
