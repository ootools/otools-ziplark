# 宿主文件关联（OS 双击归档 → 插件打开）

## 1. 插件侧声明：`plugin.json` 的 `fileAssociations`

宿主 schema 在 `src-tauri/src/platform/plugins/core.rs:51-58`：

```rust
pub struct ToolPluginFileAssociation { ext: String, desc: Option<String>, mime: Option<String> }
```

解析时会把 `ext` 去掉前导点、转小写并过滤空值（`core.rs:530-567`），每次插件升级都从清单**覆盖**，
所以清单是唯一数据源。本插件按 `native/ziplark-core/src/detect.rs:228-294` 的扩展名表注册了
47 个后缀（ZIP / RAR5 / 7z / tar 系 / ISO / DEB / RPM / CAB / PKG / XAR / CPIO / ar 及
jar、apk、epub、cbz/cbr/cbt/cb7 等容器变体）。

**故意不注册**：`docx`/`xlsx`/`pptx`/`odt`/`ods`/`odp`（办公文档，交给文档类插件）、
`a`/`lib`（静态库太通用）、`.001` 等分卷序号（宿主按最后一段取 ext，注册 `001` 会抢所有分卷文件）。
这些格式引擎依然能识别，用户从插件内选择或拖入即可打开。

## 2. 宿主侧绑定：设置页「文件关联」

声明**不等于**自动成为默认打开方式。宿主的路由表是 `otools_config` KV 里的 `fileBindings`
（`{ ext: pluginUuid }`），由设置页 `src/platform/ui/settings/FileAssociations.vue` 通过
`otools_set_file_bindings` 维护；`src/platform/ui/tools/fileOpenRouting.ts:103-127` 把所有声明过的
扩展名列出来供用户选择。安装插件后需要：

1. 宿主设置 → 文件关联 → 找到 `zip` / `7z` / `rar` 等 → 绑定 「Ziplark 压缩管理」；
2. 需要 OS 层「双击直接拉起 OTools」时，在同一页执行系统关联注册
   （宿主 `otools_query_file_association` / `otools_set_file_association` 负责 Windows ProgId、
   macOS LaunchServices、Linux xdg-mime，`mime` 字段正是为 Linux 预留）。

程序不改动用户已有的默认应用，也不改宿主注册表 —— 这是宿主的设计，插件无法也无需自行注册。

## 3. 投递链路（含冷启动兜底）

```
OS 双击 / 命令行带路径
  → 宿主 intake：dispatch_file_open（platform/file_open.rs:1-20）
  → 主窗口 Tools.vue 按 fileBindings 解析插件（Tools.vue:2369-2424）
  → otools_queue_file_delivery 入按 pluginUuid 分桶的队列
  → 对插件 webview emit_to("otools-open-file") 敲门（只是敲门，不带载荷）
  → 插件 SDK onOtoolsOpenFile（otools-file-open.ts）
      启动期 + 每次敲门都调 otools_consume_open_files 取真实路径
  → shell/host-bridge.js startOpenFileDelivery()
      invokeNative("push_open_file", {path})
  → 原生层 state::push_open_file：
      (a) 写 pending_file（给 take_pending_file 兜底）
      (b) 推入 poll_events 队列，topic = "ziplark-open-file"
  → 宿主每 200ms 轮询 poll_events，经 otools.listenNative 回到前端
  → bridge emitLocal("ziplark-open-file", path)
  → 上游 ui/main.js:1717 listen → openArchive(path)
```

**为什么不能直接 `emitLocal`**：上游 UI 启动时还会调一次 `invoke("take_pending_file")`
（`ui/main.js:1741`）来接「窗口还没监听时 OS 就递过来的文件」。如果 SDK 回调只发本地事件，
冷启动（listener 尚未注册）那份文件就丢了，而原生 `pending_file` 又是空的。

**为什么不会重复打开**：bridge 维护 `deliveredOpenPaths`。事件通道成功投递时会记账；
`invoke("take_pending_file")` 被桥拦截，若取回的路径已记账就返回 `null`，
避免事件通道和兜底通道各开一次。事件通道丢失时没有记账，兜底照常生效。

**限制**：原生 `pending_file` 是单个 `Option<String>`，批量投递只会兜底最后一个；
多个文件仍靠事件队列逐个送达（正常路径不受影响）。

## 4. 与拖拽的区别

从 Finder / 资源管理器拖文件进窗口**不经过文件关联**，走 `tauri://drag-drop` 事件，
见 `docs/drag-and-drop.md`。两条通道最终都落到 `openArchive()` / `addInputs()`。
