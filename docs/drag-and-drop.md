# 宿主是否支持插件实现拖拽功能

> **结论**：支持「从 OS 拖文件进插件」，但**不是**通过 HTML5 `DragEvent.dataTransfer.files`，
> 而是通过 Tauri 的 `tauri://drag-*` 事件（payload 里带**真实磁盘路径**）。页面内部的
> HTML5 拖拽（排序、拖到某个区域）可以正常使用。宿主不需要改动，但插件侧必须把事件
> target 注册成 **`Webview`**，SDK 默认的 `Any` target 收不到。

## 1. 外部拖入：OS 原生 drop 被 wry 拦截，但事件被 Tauri 重发

宿主没有设置 `fileDropEnabled` / `drag_and_drop` / `disable_drag_drop_handler`：

* `src-tauri/tauri.conf.json:13-33` 无相关字段；
* `src-tauri/src/platform/webview/custom.rs:538-566` 构造 `WebviewWindowBuilder` 时没有相关调用。

于是使用框架默认值 `drag_drop_handler_enabled: true`（`tauri-runtime 2.10.1/src/webview.rs:488`）。
在 vendored `src-tauri/vendor/tauri-runtime-wry/src/lib.rs:4857-4892`：

```rust
if webview_attributes.drag_drop_handler_enabled {
    webview_builder = webview_builder.with_drag_drop_handler(move |event| {
        ...
        let message = if kind == WebviewKind::WindowContent {
            WebviewMessage::SynthesizedWindowEvent(SynthesizedWindowEvent::DragDrop(event))
        } else {
            WebviewMessage::WebviewEvent(WebviewEvent::DragDrop(event))
        };
        ...
        true   // ← 无条件返回 true = 阻断 OS 默认行为
    });
}
```

wry `src/lib.rs:1148-1151` 明确：返回 `true` 会阻止 OS 默认 drop，webview 收不到原生 drop，
`<input type="file">` 也落不进去；macOS `src/wkwebview/drag_drop.rs:45-50, 90-95` 不调 `super`。
`tauri-2.10.3/src/webview/webview_window.rs:1027` 的注释也说明：要用 HTML5 drag&drop 必须
`disable_drag_drop_handler()`。

**但事件没有丢**：Tauri 把它转成 `tauri://drag-enter|drag-over|drag-drop|drag-leave`
（事件名常量在 `tauri-2.10.3/src/manager/window.rs:36-39`），payload 形如
`{ paths: string[], position: {x,y} }`，`paths` 是**真实宿主路径**。Tauri 2 没有
`tauri://file-drop` 这个事件名，全仓也没有 `onFileDropEvent` / `on_file_drop` 注册。

## 2. 关键细节：子 webview 的事件 target 必须是 `Webview`

插件页是 `add_child` 子 webview（`kind != WindowContent`），所以走
`WebviewEvent::DragDrop` 分支 → `tauri-2.10.3/src/manager/webview.rs:677-707`：

```rust
WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
    ...
    webview.emit_to_webview(DRAG_DROP_EVENT, &payload)?
}
```

而 `emit_to_webview`（同文件 `:657-670`）用 `emit_filter`，只放行
`EventTarget::Webview { label }` / `WebviewWindow { label }` 的监听器：

```rust
self.manager().emit_filter(event, payload, |target| match target {
    EventTarget::Webview { label } | EventTarget::WebviewWindow { label } => label == window_label,
    _ => false,
})
```

OTools SDK 的 `listenTauri` 默认 target 是 `{ kind: "Any" }`
（`vendor/otools-plugin-sdk/src/runtime.ts:19, 585`），**会被这个 filter 过滤掉**；
`tauri-window-shim.ts:86` 用的是 `{ kind: "Window", label }`，同样不匹配。
所以必须显式传：

```js
listenTauri('tauri://drag-drop', handler, {
  target: { kind: 'Webview', label: __TAURI_INTERNALS__.metadata.currentWebview.label }
});
```

宿主的 `on_window_event`（`custom.rs:584-602`、`core.rs:2674-2688`）只处理
Close/Destroy/Focus/Resize，**没有 DragDrop 分支**，也没有自定义转发；但框架默认 emit 已经够了。

## 3. 现成 API 与限制

| 能力 | 状态 |
| --- | --- |
| `tauri://drag-*` 带真实 `paths` | ✅ 框架默认提供，插件可直接监听 |
| SDK 导出 `onDragDropEvent` | ❌ 没有；只有 `TauriEvent.DRAG_*` 常量（`tauri-event-shim.ts`）和 `listen` / `listenTauri`（`runtime.ts`） |
| `otools_consume_open_files` | 只服务 OS 文件关联双击 / `otools-open-file` 敲门（`src-tauri/src/platform/file_open.rs:213`、`vendor/otools-plugin-sdk/src/otools-file-open.ts`），不是拖拽 |
| `tools_webview_*` 命令 | 浏览/读写/对话框，无 dragDrop 命令 |
| `dataTransfer.files` / 完整路径 | ❌ 拿不到；`File` 对象本来也只暴露 name |
| `convertFileSrc` / asset protocol | `assetProtocol.enable:true` 但 scope 只有 `$HOME/.otools/local/{tts,crop}` 和 `$HOME/.otools/plugins/**`，`~/Downloads` 之类拖入路径会被拒 |
| 页面内 HTML5 拖拽 | ✅ 可用；`preload.js:152-235, 1011-1043` 只注入 click/keydown 与 `<input type=file>` 模拟，没有对 `dragstart` / `dragover` / `drop` 做全局 `preventDefault` |

## 4. 如果要让 `dataTransfer.files` 也能用（需宿主改动）

两条路，二选一：

1. `custom.rs:538` 构造窗口时加 `.disable_drag_drop_handler()`，放开 HTML5 drop —— 代价是
   失去原生 `paths`，只能拿到文件名，不适合归档工具。
2. 宿主在 `on_window_event` 里接 `WindowEvent::DragDrop`，把 `paths` 投进
   `file_open.rs` 的按 `pluginUuid` 分桶队列，再用 `otools-open-file` 敲门；SDK 补一个
   `onDragDropEvent` 封装。**推荐**，插件侧能继续拿到真实路径。

参考：主仓 `plugins/otools-scrcpy/src/fileDrop.ts:226` 用真 Tauri API 的
`onDragDropEvent` 拿真实路径，但那是独立 app 插件，webview 插件走 shim 时没有这个能力。

## 5. 本插件的实现

`shell/host-bridge.js` 的 `startDragEvents()`：

* 从 `__TAURI_INTERNALS__.metadata` 取 `currentWebview.label` 与 `currentWindow.label`；
* 用 SDK 的 `listenTauri` 对 4 个 `tauri://drag-*` 事件分别注册 `Webview` target
  （另外补一个 `Window` target 兜底父窗口是 `WindowContent` 的情况）；
* 对 `tauri://drag-drop` 按 `event.id + paths` 做 500ms 去重，避免两个 target 重复触发；
* 把 payload 转成本地 `emitLocal(name, payload)`，上游 `ui/main.js:1684-1714` 的
  `listen("tauri://drag-drop", ...)` 原样就能工作，**上游 UI 一行没改**。

**降级路径**：万一宿主版本较老、事件没到，用户仍可点「Choose archive…」/「Add files…」
走 SDK 的页面内文件树——功能不丢，只是少了拖拽手感。
